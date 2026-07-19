// parser/parser.ts
//
// Changelog (vs. the original version):
// 1. WriteState.setXxx pattern detection (global setter object)
// 2. Precise event binding parsing - the names in the events param are file-level function names; no more guessing handleXxx
// 3. Exts tracking (4th render param)
// 4. Memo tracking (5th render param)
// 5. render() call -> child RenderFnNode state/props/ext/memo propagation analysis
// 6. Removed internal duplicate type definitions; unified into types.ts
// 7. Support Fn call-chain tracing (fn calls fn, passing WriteState callbacks, etc.)

import { Project, Node, SyntaxKind, type ArrowFunction, type FunctionExpression, type FunctionDeclaration } from "ts-morph";
import type {
    EventBinding,
    FnDetail,
    RenderFnNode,
    ViewNode,
    CodeGraph,
    StateInfo,
    PropInfo,
    ClassifiedCall,
    PropSource,
} from "./types";

const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
});

// ========== IPC extraction ==========

/**
 * Extract IPC method names from runtime imports
 */
export function extractIPCMethods(sourceFile: ReturnType<typeof project.getSourceFile>): string[] {
    const methods: string[] = [];
    if (!sourceFile) return methods;
    sourceFile.getImportDeclarations().forEach(importDecl => {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        if (moduleSpecifier.includes("runtime")) {
            importDecl.getNamedImports().forEach(namedImport => {
                methods.push(namedImport.getName());
            });
        }
    });
    return methods;
}

// ========== State / Props collection ==========

/**
 * Collect all useState state and Props type definitions in a file
 */
export function collectStateAndProps(sourceFile: ReturnType<typeof project.getSourceFile>) {
    const states: StateInfo[] = [];
    const props: PropInfo[] = [];
    if (!sourceFile) return { states, props };

    // --- Props type ---
    sourceFile.forEachDescendant((node) => {
        if (Node.isTypeAliasDeclaration(node) && node.getName() === "Props") {
            const typeLiteral = node.getTypeNode();
            if (Node.isTypeLiteral(typeLiteral)) {
                typeLiteral.getMembers().forEach((member) => {
                    if (Node.isPropertySignature(member)) {
                        props.push({ name: member.getName(), type: member.getTypeNode()?.getText() ?? "unknown" });
                    }
                });
            }
        }
    });

    // Fallback: if no Props type is found, collect from the View function parameters
    if (props.length === 0) {
        sourceFile.forEachDescendant((node) => {
            if (Node.isFunctionDeclaration(node) && node.isExported()) {
                for (const param of node.getParameters()) {
                    if (Node.isObjectBindingPattern(param.getNameNode())) {
                        for (const el of param.getNameNode().getElements()) {
                            props.push({ name: el.getName(), type: "unknown" });
                        }
                    }
                }
            }
        });
    }

    // --- useState ---
    sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (node.getExpression().getText() !== "useState") return;
        const parent = node.getParent();
        if (Node.isVariableDeclaration(parent)) {
            const nameNode = parent.getNameNode();
            if (Node.isArrayBindingPattern(nameNode)) {
                const elements = nameNode.getElements();
                if (elements.length >= 2) {
                    states.push({
                        name: elements[0].getText(),
                        setter: elements[1].getText(),
                        initialValue: node.getArguments()[0]?.getText() ?? "undefined",
                    });
                }
            }
        }
    });

    return { states, props };
}

// ========== WriteState detection ==========

/**
 * Scan the WriteState type declaration and extract every setter → state field mapping
 * e.g. WriteState.setRows → "rows"
 */
export function detectWriteStateFields(sourceFile: ReturnType<typeof project.getSourceFile>): Map<string, string> {
    const map = new Map<string, string>();

    sourceFile.forEachDescendant((node) => {
        // const WriteState: { setRows: ...; setConfigPath: ... } = {} as any;
        if (!Node.isVariableDeclaration(node)) return;
        if (node.getName() !== "WriteState") return;

        const typeNode = node.getTypeNode();
        if (!typeNode || !Node.isTypeLiteral(typeNode)) return;

        for (const member of typeNode.getMembers()) {
            if (Node.isPropertySignature(member)) {
                const name = member.getName();
                if (name.startsWith("set")) {
                    // "setRows" → "rows"
                    const stateField = name[3].toLowerCase() + name.slice(4);
                    map.set(name, stateField);
                }
            }
        }
    });

    return map;
}

// ========== Caller analysis ==========

function isSetter(name: string, states: StateInfo[]): boolean {
    return states.some(s => s.setter === name);
}

function getPureFuncName(text: string): string {
    const parts = text.split("(")[0].split(".");
    return parts[parts.length - 1];
}

function isIgnoreCall(text: string): boolean {
    const ignores = [
        "log", "stringify", "parse", "entries", "keys", "values", "isArray",
        "String", "Number", "Boolean", "Error", "all", "resolve", "reject",
        "randomUUID", "stopPropagation", "encodeURIComponent", "decodeURIComponent",
        "trim", "filter", "map", "flatMap", "find", "some", "every", "includes",
        "replace", "toLowerCase", "toUpperCase", "startsWith", "endsWith",
        "slice", "splice", "push", "pop", "shift", "unshift", "concat", "join",
        "indexOf", "lastIndexOf", "reduce", "sort", "reverse", "toFixed", "toString",
        "toExponential", "toPrecision", "toLocaleString", "toSource",
    ];
    const pureName = getPureFuncName(text);
    // also ignore chained calls like "xxx.split", "xxx.map", "xxx.filter" - check per segment
    const parts = text.split(".");
    // if the last method name in the chain is in ignores, skip
    for (const part of parts) {
        const pn = part.trim();
        if (pn.includes("(") && ignores.includes(pn.split("(")[0].trim())) {
            return true;
        }
    }
    return ignores.includes(pureName);
}

/**
 * Classify a single CallExpression in a function body.
 * New: WriteState.setXxx(...) detection
 */
function classifyCall(
    node: Node,
    states: StateInfo[],
    ipcMethods: string[],
    writeStateMap: Map<string, string>,
): ClassifiedCall | null {
    const callText = node.getExpression().getText();

    if (isIgnoreCall(node.getText())) return null;
    if (callText === "useState" || callText === "useEffect" || callText === "import" ||
        callText === "render" || callText.endsWith(".render") ||
        callText === "renderView" ||
        callText === "useMemo" || callText === "useCallback") return null;

    // IPC call
    if (callText === "invoke" || callText === "remoteJson" || ipcMethods.includes(callText)) {
        return { type: "ipc", text: callText };
    }

    // WriteState.setXxx(...)
    if (callText.startsWith("WriteState.")) {
        const methodName = callText.slice("WriteState.".length);
        if (writeStateMap.has(methodName)) {
            const stateField = writeStateMap.get(methodName)!;
            return { type: "write", text: methodName, target: stateField };
        }
    }

    // plain useState setter: setXxx(...)
    if (isSetter(callText, states)) {
        const stateName = states.find(s => s.setter === callText)?.name ?? callText;
        return { type: "write", text: stateName, target: stateName };
    }

    return { type: "call", text: callText };
}

export function getBodyNode(node: ArrowFunction | FunctionExpression): Node | undefined {
    return node.getBody() ?? undefined;
}

/**
 * Extract all classified calls from a function body. Only top-level CallExpressions are analyzed (no recursion into nested functions/methods)
 */
export function extractCallsFromNode(
    node: Node,
    states: StateInfo[],
    ipcMethods: string[],
    writeStateMap: Map<string, string>,
): ClassifiedCall[] {
    const results: ClassifiedCall[] = [];

    if (Node.isCallExpression(node)) {
        const classified = classifyCall(node, states, ipcMethods, writeStateMap);
        if (classified) results.push(classified);

        // recursively analyze callback args (arrow functions / function expressions / callbacks in direct calls)
        node.getArguments().forEach(arg => {
            if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
                const body = getBodyNode(arg);
                if (body) results.push(...extractCallsFromNode(body, states, ipcMethods, writeStateMap));
            }
        });
        return results;
    }

    node.forEachDescendant((descendant, traversal) => {
        // skip nested function declarations (avoid analyzing unrelated inner functions)
        if (Node.isFunctionDeclaration(descendant) || Node.isMethodDeclaration(descendant)) { traversal.skip(); return; }
        if (Node.isVariableDeclaration(descendant)) {
            const init = descendant.getInitializer();
            if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) { traversal.skip(); return; }
        }

        if (Node.isCallExpression(descendant)) {
            const classified = classifyCall(descendant, states, ipcMethods, writeStateMap);
            if (classified) results.push(classified);
        }
    });

    return results;
}

// ========== renderFn identification & parsing ==========

/**
 * Determine whether a node is a renderFn:
 * - name starts with "render"
 * - has 3-5 parameters
 * - param[0] (state): ObjectBindingPattern
 * - param[1] (props): ObjectBindingPattern
 * - param[2] (events): ObjectBindingPattern
 * - param[3] (exts): Identifier (optional)
 * - param[4] (memo): ObjectBindingPattern (optional)
 */
function isRenderFn(node: Node): boolean {
    let fnNode: Node | undefined;
    let name: string | undefined;

    if (Node.isFunctionDeclaration(node)) {
        fnNode = node;
        name = node.getName();
    } else if (Node.isVariableDeclaration(node)) {
        name = node.getName();
        const init = node.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
            fnNode = init;
        }
    }

    if (!fnNode || !name) return false;
    if (!name.startsWith("render")) return false;

    const params = (fnNode as any).getParameters?.() ?? [];
    if (params.length < 3 || params.length > 5) return false;

    // state param = ObjectBindingPattern
    if (!Node.isObjectBindingPattern(params[0].getNameNode())) return false;
    // props param = ObjectBindingPattern
    if (!Node.isObjectBindingPattern(params[1].getNameNode())) return false;
    // events param = ObjectBindingPattern
    if (!Node.isObjectBindingPattern(params[2].getNameNode())) return false;
    // ext param = Identifier (e.g. "ext" or "_ext")
    if (params.length >= 4 && !Node.isIdentifier(params[3].getNameNode())) return false;
    // memo param = ObjectBindingPattern
    if (params.length === 5 && !Node.isObjectBindingPattern(params[4].getNameNode())) return false;

    return true;
}

function getRenderFnName(node: Node): string {
    if (Node.isFunctionDeclaration(node)) return node.getName() ?? "anonymous";
    if (Node.isVariableDeclaration(node)) return node.getName();
    return "anonymous";
}

/**
 * Extract field names from the ext param's type annotation
 * e.g. ext: { envRows: McpEnvDraftRow[]; rowId: string } → ["envRows", "rowId"]
 * or from destructuring in the function body: const { envRows, rowId } = ext;
 */
function extractExtFields(fnNode: Node, extParamName: string): string[] {
    const extFields: string[] = [];

    // method 1: extract from type annotation
    const params = (fnNode as any).getParameters();
    if (params.length >= 4) {
        const typeNode = params[3].getTypeNode();
        if (typeNode && Node.isTypeLiteral(typeNode)) {
            for (const member of typeNode.getMembers()) {
                if (Node.isPropertySignature(member)) {
                    extFields.push(member.getName());
                }
            }
        }
    }

    // method 2: if the type annotation is missing (or has no fields), extract from function-body destructuring
    if (extFields.length === 0) {
        const body = fnNode.getKind() === SyntaxKind.ArrowFunction
            ? (fnNode as ArrowFunction).getBody()
            : (fnNode as FunctionDeclaration).getBody() ?? (fnNode as FunctionExpression).getBody();

        if (body) {
            body.forEachDescendant((descendant) => {
                if (!Node.isVariableDeclaration(descendant)) return;
                const nameNode = descendant.getNameNode();
                if (!Node.isObjectBindingPattern(nameNode)) return;
                const init = descendant.getInitializer();
                if (init && init.getText() === extParamName) {
                    for (const el of nameNode.getElements()) {
                        extFields.push(el.getName());
                    }
                }
            });
        }
    }

    return extFields;
}

// ========== Build EventBinding for renderFn ==========

/**
 * Extract EventBinding from a renderFn node's JSX.
 * In the mcp-test.tsx pattern, the events param name matches the file-level function name.
 * e.g. events: { reloadMcpSettings } → onClick={reloadMcpSettings} in JSX
 * This means reloadMcpSettings is a file-level function.
 */
function extractEventBindings(
    fnNode: Node,
    param2EventNames: Set<string>,
    filePath: string,
    fnName: string,
): EventBinding[] {
    const bindings: EventBinding[] = [];

    fnNode.forEachDescendant((descendant) => {
        if (!Node.isJsxAttribute(descendant)) return;
        const attrName = descendant.getNameNode().getText();
        if (!/^on[A-Z]/.test(attrName)) return;

        const init = descendant.getInitializer();
        if (!init) return;

        let expr = init;
        if (Node.isJsxExpression(init)) expr = init.getExpression() ?? init;

        // case 1: direct reference onClick={handlerName}
        if (Node.isIdentifier(expr) && param2EventNames.has(expr.getText())) {
            bindings.push({
                id: `${filePath}:${fnName}#${expr.getText()}`,
                bindTo: attrName,
                handleFnId: `${filePath}:${expr.getText()}`,
            });
        }
        // case 2: arrow adapter onClick={(e) => handlerName(...)}
        else if (Node.isArrowFunction(expr)) {
            const arrowBody = expr.getBody();
            const callExpr = Node.isBlock(arrowBody)
                ? arrowBody.getStatements().find(s =>
                    Node.isReturnStatement(s)
                        ? (s as any).getExpression()?.getKind() === SyntaxKind.CallExpression
                        : Node.isExpressionStatement(s) && Node.isCallExpression((s as any).getExpression())
                            ? (s as any).getExpression()
                            : false
                )
                : Node.isCallExpression(arrowBody) ? arrowBody : null;

            if (callExpr) {
                const actualExpr = Node.isReturnStatement(callExpr)
                    ? (callExpr as any).getExpression()
                    : callExpr;
                if (actualExpr && Node.isCallExpression(actualExpr)) {
                    const callee = actualExpr.getExpression();
                    if (Node.isIdentifier(callee) && param2EventNames.has(callee.getText())) {
                        bindings.push({
                            id: `${filePath}:${fnName}#${callee.getText()}`,
                            bindTo: attrName,
                            handleFnId: `${filePath}:${callee.getText()}`,
                        });
                    }
                }
            }
        }
        // case 3: direct call onClick={handlerName()}
        else if (Node.isCallExpression(expr)) {
            const callee = expr.getExpression();
            if (Node.isIdentifier(callee) && param2EventNames.has(callee.getText())) {
                bindings.push({
                    id: `${filePath}:${fnName}#${callee.getText()}`,
                    bindTo: attrName,
                    handleFnId: `${filePath}:${callee.getText()}`,
                });
            }
        }
        // case 4: other non-anonymous function references
        else if (!Node.isArrowFunction(expr) && !Node.isFunctionExpression(expr)) {
            const handlerText = expr.getText();
            const matchesFnName = param2EventNames.has(handlerText);
            bindings.push({
                id: `${filePath}:${fnName}#${attrName}`,
                bindTo: attrName,
                handleFnId: matchesFnName ? `${filePath}:${handlerText}` : "",
            });
        }
    });

    return bindings;
}

// ========== render() call analysis ==========

interface RenderCallSite {
    fnName: string;           // name of the invoked renderFn
    stateFields: string[];    // fields passed in state: { xxx, yyy }
    memoFields: string[];     // fields passed in memo: { ... }
    extFields: string[];      // fields passed in exts: { ... }
    eventNames: string[];     // function names passed in events: { ... }
}

/**
 * Parse all render({...}) call sites from a renderFn function body
 * e.g.:
 *   render({state: { configPath }, props: {}, fn: renderMcpServersViewHero, events: {}})
 *   → RenderCallSite { fnName: "renderMcpServersViewHero", stateFields: ["configPath"], ... }
 */
function extractRenderCalls(fnNode: Node): RenderCallSite[] {
    const sites: RenderCallSite[] = [];

    fnNode.forEachDescendant((descendant) => {
        if (!Node.isCallExpression(descendant)) return;
        const callee = descendant.getExpression();
        const calleeText = callee.getText();

        // match render({...}) or xxx.render({...})
        const isRenderCall = (Node.isIdentifier(callee) && calleeText === "render")
            || (Node.isPropertyAccessExpression(callee) && callee.getName() === "render");

        if (!isRenderCall) return;

        const firstArg = descendant.getArguments()[0];
        if (!firstArg || !Node.isObjectLiteralExpression(firstArg)) return;

        let fnName = "";
        const stateFields: string[] = [];
        const memoFields: string[] = [];
        const extFields: string[] = [];
        const eventNames: string[] = [];

        for (const prop of firstArg.getProperties()) {
            if (!Node.isPropertyAssignment(prop)) continue;
            const propName = prop.getName();
            const init = prop.getInitializer();

            if (propName === "fn" && init && Node.isIdentifier(init)) {
                fnName = init.getText();
            }

            if (propName === "state" && init && Node.isObjectLiteralExpression(init)) {
                for (const sp of init.getProperties()) {
                    if (Node.isShorthandPropertyAssignment(sp) || Node.isPropertyAssignment(sp)) {
                        stateFields.push(sp.getName());
                    }
                }
            }

            if (propName === "memo" && init && Node.isObjectLiteralExpression(init)) {
                for (const sp of init.getProperties()) {
                    if (Node.isShorthandPropertyAssignment(sp) || Node.isPropertyAssignment(sp)) {
                        memoFields.push(sp.getName());
                    }
                }
            }

            if (propName === "exts" && init && Node.isObjectLiteralExpression(init)) {
                for (const sp of init.getProperties()) {
                    if (Node.isShorthandPropertyAssignment(sp) || Node.isPropertyAssignment(sp)) {
                        extFields.push(sp.getName());
                    }
                }
            }

            if (propName === "events" && init && Node.isObjectLiteralExpression(init)) {
                for (const ep of init.getProperties()) {
                    if (Node.isShorthandPropertyAssignment(ep)) {
                        eventNames.push(ep.getName());
                    } else if (Node.isPropertyAssignment(ep)) {
                        eventNames.push(ep.getName());
                    }
                }
            }
        }

        if (fnName) {
            sites.push({ fnName, stateFields, memoFields, extFields, eventNames });
        }
    });

    return sites;
}

// ========== renderView extraction ==========

/**
 * Find all renderView({view: Xxx, ...}) calls in a function/render function body,
 * extracting the target View's component name.
 */
export function extractRenderViewTargets(node: Node): string[] {
    const targets: string[] = [];

    // check whether node itself is a renderView call (handles arrow-expression bodies)
    if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        if (Node.isIdentifier(callee) && callee.getText() === "renderView") {
            const viewName = extractRenderViewViewName(node);
            if (viewName) targets.push(viewName);
        }
    }

    // check renderView calls in all child nodes
    node.forEachDescendant((descendant) => {
        if (!Node.isCallExpression(descendant)) return;
        const callee = descendant.getExpression();
        if (!Node.isIdentifier(callee)) return;
        if (callee.getText() !== "renderView") return;
        const viewName = extractRenderViewViewName(descendant);
        if (viewName) targets.push(viewName);
    });

    return [...new Set(targets)];
}

/** Extract the View component name from renderView({fn/view: Xxx, ...}) */
function extractRenderViewViewName(callExpr: Node): string | null {
    const firstArg = callExpr.getArguments()[0];
    if (!firstArg || !Node.isObjectLiteralExpression(firstArg)) return null;

    for (const prop of firstArg.getProperties()) {
        if (!Node.isPropertyAssignment(prop)) continue;
        const propName = prop.getName();
        if (propName !== "view" && propName !== "fn") continue;
        const init = prop.getInitializer();
        if (init && Node.isIdentifier(init)) {
            return init.getText();
        }
    }
    return null;
}

// ========== Find View component name ==========

function findViewName(sourceFile: ReturnType<typeof project.getSourceFile>): string {
    // try to find export function XxxView()
    const viewFn = sourceFile?.getFunctions().find(f =>
        f.isExported() && (f.getName()?.endsWith("View"))
    );
    if (viewFn?.getName()) return viewFn.getName();

    // try to find export const XxxView
    const viewVar = sourceFile?.getVariableDeclarations().find(v =>
        v.isExported() && v.getName().endsWith("View")
    );
    if (viewVar?.getName()) return viewVar.getName();

    return "default";
}

// ========== Build function details ==========

/**
 * Collect all non-renderFn functions in a file (EventHandlers and utility functions)
 */
function buildFnDetails(
    sourceFile: ReturnType<typeof project.getSourceFile>,
    states: StateInfo[],
    ipcMethods: string[],
    writeStateMap: Map<string, string>,
    viewName: string,
    renderFnSet: Set<string>,
    filePath: string,
): FnDetail[] {
    const fns: FnDetail[] = [];

    sourceFile?.forEachDescendant((node) => {
        let name: string | undefined;
        let body: Node | undefined;

        if (Node.isFunctionDeclaration(node)) {
            name = node.getName();
            body = node.getBody();
        } else if (Node.isVariableDeclaration(node)) {
            name = node.getName();
            const init = node.getInitializer();
            if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
                body = getBodyNode(init);
            }
        }

        if (!name || !body) return;
        if (name === viewName) return;  // skip the View component
        if (name === "WriteState" || name === "render" || name.startsWith("_latest")) return;
        // renderFn also produces a FnDetail (to trace its internal calls); don't skip

        const calls = extractCallsFromNode(body, states, ipcMethods, writeStateMap);
        // dedupe + sort
        const writes = [...new Set(calls.filter(c => c.type === "write").map(c => c.target!))].sort();
        const ipcs = [...new Set(calls.filter(c => c.type === "ipc").map(c => `ipc:${c.text}`))].sort();
        const funcCalls = [...new Set(calls.filter(c => c.type === "call").map(c => c.text))].sort();
        // renderView call → target View name → ViewNode ID
        const renderViewTargets = extractRenderViewTargets(body);
        const views = renderViewTargets.map(t => `${filePath}:${t}`);

        fns.push({
            id: `${filePath}:${name}`,
            writes,
            ipcs,
            fns: funcCalls,
            views,
        });
    });

    return fns;
}

// ========== Memo → State dependency resolution ==========

/**
 * Extract all memo/derived values from the View function body → dependency mapping to original state.
 *
 * Two patterns are handled:
 * 1. useMemo call: const X = useMemo(() => ..., [stateA, stateB])
 * 2. non-memo derived value: const X = stateA !== stateB or const X = fn(stateA)
 *
 * Results are recursively resolved to the original state, e.g.:
 *   draftSettings = useMemo(..., [rows])         → "draftSettings" → ["rows"]
 *   draftText = useMemo(..., [draftSettings])     → "draftText" → ["rows"]
 *   hasUnsavedChanges = draftText !== savedText   → "hasUnsavedChanges" → ["rows", "savedText"]
 */
function buildMemoDepMap(
    sourceFile: ReturnType<typeof project.getSourceFile>,
    stateNameSet: Set<string>,
): Map<string, string[]> {
    const rawMap = new Map<string, string[]>();     // memoName → immediate deps (may include other memos)
    const viewFn = sourceFile?.getFunctions().find(f =>
        f.isExported() && (f.getName()?.endsWith("View"))
    );
    if (!viewFn) return rawMap;

    const viewBody = viewFn.getBody();
    if (!viewBody) return rawMap;

    // 1. find useMemo calls
    viewBody.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (node.getExpression().getText() !== "useMemo") return;

        const parent = node.getParent();
        if (!Node.isVariableDeclaration(parent)) return;
        const memoName = parent.getName();

        // second argument is the dependency array
        const args = node.getArguments();
        if (args.length < 2) return;
        const depArray = args[1];
        if (!Node.isArrayLiteralExpression(depArray)) return;

        const deps: string[] = [];
        for (const el of depArray.getElements()) {
            if (Node.isIdentifier(el)) {
                deps.push(el.getText());
            }
        }
        rawMap.set(memoName, deps);
    });

    // 2. find non-useMemo derived values (const X = expr, where expr references state/memo)
    viewBody.forEachDescendant((node) => {
        if (!Node.isVariableDeclaration(node)) return;
        const name = node.getName();
        if (rawMap.has(name)) return; // already a useMemo

        const init = node.getInitializer();
        if (!init) return;

        // skip function/arrow/hook calls
        if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) return;
        if (Node.isCallExpression(init)) {
            const callee = init.getExpression().getText();
            if (callee.startsWith("use") || callee === "render") return;
        }

        // extract all Identifier references from the init expression
        const depSet = new Set<string>();
        init.forEachDescendant((sub) => {
            if (Node.isIdentifier(sub)) {
                const text = sub.getText();
                if (stateNameSet.has(text) || rawMap.has(text)) {
                    depSet.add(text);
                }
            }
        });

        if (depSet.size > 0) {
            rawMap.set(name, [...depSet]);
        }
    });

    // 3. recursive resolution: until all deps resolve to the original state
    function resolve(name: string, visited: Set<string>): string[] {
        if (stateNameSet.has(name)) return [name];
        const deps = rawMap.get(name);
        if (!deps || deps.length === 0) return [];

        const result = new Set<string>();
        for (const dep of deps) {
            if (visited.has(dep)) continue;
            visited.add(dep);
            const resolved = resolve(dep, visited);
            for (const r of resolved) result.add(r);
        }
        return [...result];
    }

    const resolvedMap = new Map<string, string[]>();
    for (const [name] of rawMap) {
        resolvedMap.set(name, resolve(name, new Set()));
    }

    return resolvedMap;
}

// ========== useEffect extraction ==========

/**
 * From the View function body's useEffect callback, extract the list of called handler function names.
 *
 * e.g. useEffect(() => { void reloadMcpSettings(); }, [])
 * → extract "reloadMcpSettings" → return ["reloadMcpSettings"]
 */
function extractUseEffectHandlers(viewBody: Node): string[] {
    const handlers: string[] = [];

    viewBody.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (node.getExpression().getText() !== "useEffect") return;

        const args = node.getArguments();
        if (args.length < 1) return;

        const callback = args[0];
        if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return;

        const body = getBodyNode(callback);
        if (!body) return;

        // traverse the callback body to find function calls (e.g. reloadMcpSettings())
        body.forEachDescendant((sub) => {
            if (!Node.isCallExpression(sub)) return;
            const callee = sub.getExpression();
            if (Node.isIdentifier(callee)) {
                handlers.push(callee.getText());
            }
        });
    });

    return [...new Set(handlers)];
}

// ========== Main function: buildCodeGraph ==========

export function buildCodeGraph(filePath: string): { view: ViewNode; fns: FnDetail[] } {
    const sourceFile = project.getSourceFile(filePath);
    if (!sourceFile) throw new Error(`File not found: ${filePath}`);

    const { states, props: propInfos } = collectStateAndProps(sourceFile);
    const ipcMethods = extractIPCMethods(sourceFile);
    const writeStateMap = detectWriteStateFields(sourceFile);

    const viewName = findViewName(sourceFile);
    const fileSource = filePath.replace(/^.*\/src\//, "src/");
    const stateNameSet = new Set(states.map(s => s.name));
    const memoDepMap = buildMemoDepMap(sourceFile, stateNameSet);

    // 1. collect all renderFns
    const renderFnMap = new Map<string, {
        node: Node;
        fnNode: Node;
        stateNames: string[];
        propNames: string[];
        eventsNames: string[];
        memoNames: string[];
        extFields: string[];
        bindings: EventBinding[];
        renderCalls: RenderCallSite[];
    }>();

    sourceFile.forEachDescendant((node) => {
        if (!isRenderFn(node)) return;
        const name = getRenderFnName(node);

        let fnNode: Node;
        if (Node.isVariableDeclaration(node)) {
            fnNode = node.getInitializer()!;
        } else {
            fnNode = node;
        }

        const params = (fnNode as any).getParameters();

        // param[0] = state destructuring
        const stateNames = Node.isObjectBindingPattern(params[0].getNameNode())
            ? params[0].getNameNode().getElements().map((e: any) => e.getName())
            : [];

        // param[1] = props destructuring
        const propNames = Node.isObjectBindingPattern(params[1].getNameNode())
            ? params[1].getNameNode().getElements().map((e: any) => e.getName())
            : [];

        // param[2] = events destructuring
        const eventsNames = Node.isObjectBindingPattern(params[2].getNameNode())
            ? params[2].getNameNode().getElements().map((e: any) => e.getName())
            : [];
        const eventNameSet = new Set(eventsNames);

        // param[3] = ext (Identifier, fields extracted via destructuring in the function body)
        const extParamName = params.length >= 3 && Node.isIdentifier(params[3]?.getNameNode())
            ? params[3].getNameNode().getText()
            : "";
        const extFields = extParamName ? extractExtFields(fnNode, extParamName) : [];

        // param[4] = memo destructuring
        const memoNames = params.length >= 5 && Node.isObjectBindingPattern(params[4].getNameNode())
            ? params[4].getNameNode().getElements().map((e: any) => e.getName())
            : [];

        // Event bindings
        const bindings = extractEventBindings(fnNode, eventNameSet, fileSource, name);

        // render() call analysis
        const renderCalls = extractRenderCalls(fnNode);

        renderFnMap.set(name, {
            node,
            fnNode,
            stateNames,
            propNames,
            eventsNames,
            memoNames,
            extFields,
            bindings,
            renderCalls,
        });
    });

    // 2. build the renderFn tree
    // collect the names referenced by other renderFns
    const allChildNames = new Set<string>();
    for (const [, info] of renderFnMap) {
        for (const rc of info.renderCalls) {
            if (renderFnMap.has(rc.fnName)) {
                allChildNames.add(rc.fnName);
            }
        }
    }

    /**
     * Recursively build the RenderFnNode tree.
     * Each node records:
     * - its own state/props/memos/exts dependencies
     * - event bindings (including handler function IDs)
     * - child nodes
     */
    function buildRenderFnNode(name: string): RenderFnNode {
        const info = renderFnMap.get(name)!;

        // resolve memo names to original state names and merge into states
        const resolvedStates = new Set(info.stateNames);
        for (const memoName of info.memoNames) {
            const stateDeps = memoDepMap.get(memoName);
            if (stateDeps) {
                for (const s of stateDeps) resolvedStates.add(s);
            }
        }

        const children: RenderFnNode[] = [];
        for (const rc of info.renderCalls) {
            if (renderFnMap.has(rc.fnName)) {
                children.push(buildRenderFnNode(rc.fnName));
            }
        }

        // extract the target View name from renderView calls
        const renderViewTargets = extractRenderViewTargets(info.fnNode);
        const renderViewViewIds = renderViewTargets.map(t => `${fileSource}:${t}`);

        return {
            id: `${fileSource}:${name}`,
            fnId: `${fileSource}:${name}`,
            states: [...resolvedStates].sort(),
            props: [...info.propNames],
            exts: [...info.extFields],
            events: info.bindings,
            children,
            renderViews: renderViewViewIds,
        };
    }

    // root nodes = renderFns not referenced as a child by anyone
    const roots: RenderFnNode[] = [];
    for (const [name] of renderFnMap) {
        if (!allChildNames.has(name)) {
            roots.push(buildRenderFnNode(name));
        }
    }

    // 3. extract handler names called in useEffect
    const viewFnNode = sourceFile.getFunctions().find(f => f.getName() === viewName);
    const useEffectHandlerNames = viewFnNode?.getBody()
        ? extractUseEffectHandlers(viewFnNode.getBody())
        : [];

    // 4. collect function details
    const renderFnSet = new Set(renderFnMap.keys());
    const fns = buildFnDetails(sourceFile, states, ipcMethods, writeStateMap, viewName, renderFnSet, fileSource);

    // 5. build the useEffect's FnDetail (describes what the effect callback itself does)
    let useEffect: FnDetail | null = null;
    if (useEffectHandlerNames.length > 0) {
        useEffect = {
            id: `${fileSource}:${viewName}#useEffect`,
            writes: [],
            ipcs: [],
            fns: useEffectHandlerNames,
        };
    }

    // 6. build ViewNode
    const viewId = `${fileSource}:${viewName}`;
    const view: ViewNode = {
        id: viewId,
        states: states.map(s => s.name),
        props: Object.fromEntries(
            propInfos.map(p => [p.name, { type: "state" as const, viewId, sourceName: p.name }])
        ),
        useEffect,
        children: roots,
    };

    return { view, fns };
}

// ========== CLI Entry ==========

const isMainModule = process.argv[1]?.endsWith("parser.ts") || process.argv[1]?.endsWith("parser/parser.ts");
if (isMainModule) {
    const args = process.argv.slice(2);
    const fileIndex = args.indexOf("--file");
    const fIndex = args.indexOf("-f");
    const cliFilePath = fileIndex !== -1 && args.length > fileIndex + 1
        ? args[fileIndex + 1]
        : fIndex !== -1 && args.length > fIndex + 1
            ? args[fIndex + 1]
            : null;

    if (!cliFilePath) {
        console.error("Usage: npx tsx parser/parser.ts --file <path>");
        process.exit(1);
    }

    const allViews: ViewNode[] = [];
    const allFns: FnDetail[] = [];

    for (const filePath of [cliFilePath]) {
        const { view, fns } = buildCodeGraph(filePath);
        allViews.push(view);
        allFns.push(...fns);
    }

    const graph: CodeGraph = {
        version: new Date().toISOString(),
        views: allViews,
        fns: allFns,
    };

    console.log(JSON.stringify(graph, null, 2));
}
