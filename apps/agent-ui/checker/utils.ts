// checker/utils.ts
import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import {RuleContext} from "./types";

/**
 * Check whether node is inside the subtree of ancestor
 */
export function isNodeInside(node: ts.Node, ancestor: ts.Node): boolean {
    let current: ts.Node | undefined = node;
    while (current) {
        if (current === ancestor) return true;
        current = current.parent;
    }
    return false;
}

/**
 * Check whether node is inside a useEffect/useLayoutEffect callback
 */
export function isInsideEffect(node: ts.Node): boolean {
    let current = node.parent;
    while (current) {
        if (ts.isCallExpression(current)) {
            const callee = current.expression;
            if (
                ts.isIdentifier(callee) &&
                (callee.text === "useEffect" || callee.text === "useLayoutEffect")
            ) {
                const callbackArg = current.arguments[0];
                if (callbackArg && isNodeInside(node, callbackArg)) {
                    return true;
                }
            }
        }
        current = current.parent;
    }
    return false;
}

/**
 * Check whether node is inside an event handler (onXxx props such as onClick)
 */
export function isInsideEventHandler(node: ts.Node): boolean {
    let current = node.parent;
    while (current) {
        if (ts.isJsxAttribute(current)) {
            const attrName = current.name.text;
            if (attrName.startsWith("on")) {
                return true;
            }
        }
        current = current.parent;
    }
    return false;
}
/**
 * Collect state variable names declared via useState
 */
export function collectStateVars(sourceFile: ts.SourceFile): Set<string> {
    const stateVars = new Set<string>();

    function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isIdentifier(callee) && callee.text === "useState" && node.parent) {
                const decl = node.parent;
                if (ts.isVariableDeclaration(decl) && ts.isArrayBindingPattern(decl.name)) {
                    const stateName = decl.name.elements[0];
                    if (stateName && ts.isIdentifier(stateName.name)) {
                        stateVars.add(stateName.name.text);
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return stateVars;
}
/**
 * Collect variable names from the component's Props interface
 * Rules:
 * 1. Only one export function XxxxView is allowed
 * 2. No params → propVars is empty
 * 3. Has params → must have a corresponding interface XxxxProps
 * Returns { propVars, viewFn }, where viewFn is the component function node, used later to collect state
 */
export function collectPropVars(sourceFile: ts.SourceFile, ctx: RuleContext): {
    propVars: Set<string>;
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null;
} {
    const propVars = new Set<string>();
    let viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null = null;
    let exportFnCount = 0;
    let propsInterfaceCount = 0;
    const propsInterfaces = new Map<string, ts.InterfaceDeclaration>();

    // Pass 1: find export function and interface XxxxProps
    function collect(node: ts.Node) {
        // Collect export function XxxxView
        if (ts.isFunctionDeclaration(node) && isExportNode(node) && node.name) {
            exportFnCount++;
            if (/View$/.test(node.name.text)) {
                viewFn = node;
            }
        }

        // Collect export const XxxxView = () => {}
        if (ts.isVariableStatement(node) && isExportNode(node)) {
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && /View$/.test(decl.name.text)) {
                    if (decl.initializer && ts.isArrowFunction(decl.initializer)) {
                        exportFnCount++;
                        viewFn = decl.initializer;
                    }
                }
            }
        }

        // Collect all interface XxxxProps
        if (ts.isInterfaceDeclaration(node) && /Props$/.test(node.name.text)) {
            propsInterfaceCount++;
            propsInterfaces.set(node.name.text, node);
        }

        ts.forEachChild(node, collect);
    }
    collect(sourceFile);

    // Check export function count
    if (exportFnCount === 0) {
        ctx.addViolation("Props 定义规范", "文件必须有一个 export function XxxxView 组件。");
    }
    if (exportFnCount > 1) {
        ctx.addViolation("Props 定义规范", "文件只能有一个 export function 组件，发现 ${exportFnCount} 个。");
    }
    if (!viewFn) {
        ctx.addViolation("Props 定义规范", "export function 必须以 View 结尾，如 SessionListView。");
    }

    if (ctx.violations.length > 0) {
        return { propVars, viewFn }
    }

    // Check parameters
    const params = viewFn.parameters;
    if (!params || params.length === 0) {
        // No params: propVars is empty
        return { propVars, viewFn };
    }

    // Has params: must have a corresponding Props interface
    if (propsInterfaceCount === 0) {
        ctx.addViolation("Props 定义规范", "组件有参数但未定义 interface XxxxProps。")
        return { propVars, viewFn };
    }
    if (propsInterfaceCount > 1) {
        ctx.addViolation("Props 定义规范", `只能有一个 Props 接口，发现 ${propsInterfaceCount} 个: [${[...propsInterfaces.keys()].join(", ")}]。`)
        return { propVars, viewFn };
    }

    // Collect properties from the Props interface
    const propsInterface = propsInterfaces.values().next().value;
    for (const member of propsInterface.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
            propVars.add(member.name.text);
        }
    }

    return { propVars, viewFn };
}

function isExportNode(node: ts.Node): boolean {
    if (!node.modifiers) return false;
    return node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * Get the code text of the specified line
 */
export function getCodeLine(sourceCode: string, line: number): string {
    const lines = sourceCode.split(/\r?\n/);
    if (line >= 1 && line <= lines.length) {
        return lines[line - 1].trim();
    }
    return "";
}

/**
 * Check whether node is a dep() call expression
 */
export function isDepCall(node: ts.Node): boolean {
    return ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "dep";
}

/**
 * Resolve import declarations, confirming the imported component is indeed a viewFn from another file
 * Only resolve relative paths (./ ../), skip node_modules
 */
export function resolveImportedViewFns(sourceFile: ts.SourceFile, fsPath: string): Set<string> {
    const viewFnNames = new Set<string>();
    const dir = path.dirname(fsPath);

    function checkFile(targetFile: string, name: string): boolean {
        if (!fs.existsSync(targetFile)) return false;
        try {
            const sourceCode = fs.readFileSync(targetFile, "utf-8");
            const sf = ts.createSourceFile(targetFile, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
            const dummyCtx = { violations: [], addViolation: () => {} } as unknown as RuleContext;
            const result = collectPropVars(sf, dummyCtx);
            if (!result.viewFn) return false;

            let fnName: string | undefined;
            if (ts.isFunctionDeclaration(result.viewFn) && result.viewFn.name) {
                fnName = result.viewFn.name.text;
            } else if (
                result.viewFn.parent &&
                ts.isVariableDeclaration(result.viewFn.parent) &&
                ts.isIdentifier(result.viewFn.parent.name)
            ) {
                fnName = result.viewFn.parent.name.text;
            }

            return fnName === name;
        } catch {
            return false;
        }
    }

    function resolvePath(modulePath: string, names: string[]) {
        const base = path.resolve(dir, modulePath);

        // Try direct file: .tsx / .ts
        for (const ext of [".tsx", ".ts"]) {
            const target = base + ext;
            for (const name of names) {
                if (checkFile(target, name)) {
                    viewFnNames.add(name);
                }
            }
            if ([...viewFnNames].some(n => names.includes(n))) return; // Stop if found
        }

        // Try index file: dir/index.tsx / dir/index.ts
        for (const ext of [".tsx", ".ts"]) {
            const target = path.join(base, "index" + ext);
            for (const name of names) {
                if (checkFile(target, name)) {
                    viewFnNames.add(name);
                }
            }
            if ([...viewFnNames].some(n => names.includes(n))) return;
        }
    }

    for (const stmt of sourceFile.statements) {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;

        const modulePath = stmt.moduleSpecifier.text;
        // Only resolve relative paths
        if (!modulePath.startsWith(".")) continue;

        const names: string[] = [];
        if (stmt.importClause) {
            // import XxxView from "..."
            if (stmt.importClause.name) {
                names.push(stmt.importClause.name.text);
            }
            // import { XxxView } from "..."
            if (stmt.importClause.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
                for (const spec of stmt.importClause.namedBindings.elements) {
                    names.push(spec.name.text);
                }
            }
        }

        if (names.length > 0) {
            resolvePath(modulePath, names);
        }
    }

    return viewFnNames;
}

/**
 * Resolve the target file of the imported viewFn, return its Props interface field names
 */
export function getViewFnPropNames(
    viewFnName: string,
    sourceFile: ts.SourceFile,
    fsPath: string,
): Set<string> | null {
    const dir = path.dirname(fsPath);

    function tryFile(targetFile: string): Set<string> | null {
        if (!fs.existsSync(targetFile)) return null;
        try {
            const code = fs.readFileSync(targetFile, "utf-8");
            const sf = ts.createSourceFile(targetFile, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
            const dummyCtx = { violations: [], addViolation: () => {} } as unknown as RuleContext;
            const result = collectPropVars(sf, dummyCtx);
            return result.propVars.size > 0 ? new Set(result.propVars) : null;
        } catch {
            return null;
        }
    }

    for (const stmt of sourceFile.statements) {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        if (!stmt.importClause) continue;

        // Check whether this import contains the target viewFn name
        let hasName = false;
        if (stmt.importClause.name && stmt.importClause.name.text === viewFnName) hasName = true;
        if (!hasName && stmt.importClause.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
            hasName = stmt.importClause.namedBindings.elements.some(spec => spec.name.text === viewFnName);
        }
        if (!hasName) continue;

        const modulePath = stmt.moduleSpecifier.text;
        if (!modulePath.startsWith(".")) return null;

        const base = path.resolve(dir, modulePath);

        for (const ext of [".tsx", ".ts"]) {
            const result = tryFile(base + ext);
            if (result) return result;
        }
        for (const ext of [".tsx", ".ts"]) {
            const result = tryFile(path.join(base, "index" + ext));
            if (result) return result;
        }
        break;
    }
    return null;
}