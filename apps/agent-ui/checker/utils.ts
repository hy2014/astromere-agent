// checker/utils.ts
import * as ts from "typescript";
import {RuleContext} from "./types";

/**
 * 判断 node 是否在 ancestor 的子树内
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
 * 判断节点是否在 useEffect/useLayoutEffect 回调内部
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
 * 判断节点是否在事件处理器（onClick 等 onXxx 属性）内部
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

// utils.ts
export function isInsideDep(node: ts.Node): boolean {
    let current = node.parent;
    while (current) {
        if (ts.isCallExpression(current)) {
            const callee = current.expression;
            if (ts.isIdentifier(callee) && callee.text === "dep") {
                // 确认 node 在第三个参数内，而不是前两个
                const thirdArg = current.arguments[2];
                return isNodeInside(node, thirdArg);
            }
        }
        current = current.parent;
    }
    return false;
}

/**
 * 收集 useState 声明的 state 变量名
 */
export function collectStateVars(sourceFile: ts.SourceFile): Set<string> {
    const stateVars = new Set<string>();

    function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isIdentifier(callee) && callee.text === "useState" && node.parent) {
                const decl = node.parent.parent;
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
 * 收集组件 Props 接口的变量名
 * 规则：
 * 1. 只允许一个 export function XxxxView
 * 2. 无参数 → propVars 为空
 * 3. 有参数 → 必须有对应的 interface XxxxProps
 * 返回 { propVars, viewFn }，viewFn 是组件函数节点，用于后续收集 state
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

    // 第一遍：找 export function 和 interface XxxxProps
    function collect(node: ts.Node) {
        // 收集 export function XxxxView
        if (ts.isFunctionDeclaration(node) && isExportNode(node) && node.name) {
            exportFnCount++;
            if (/View$/.test(node.name.text)) {
                viewFn = node;
            }
        }

        // 收集 export const XxxxView = () => {}
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

        // 收集所有 interface XxxxProps
        if (ts.isInterfaceDeclaration(node) && /Props$/.test(node.name.text)) {
            propsInterfaceCount++;
            propsInterfaces.set(node.name.text, node);
        }

        ts.forEachChild(node, collect);
    }
    collect(sourceFile);

    // 检查 export function 数量
    if (exportFnCount === 0) {
        ctx.addViolation("Props 定义规范", "文件必须有一个 export function XxxxView 组件。");
    }
    if (exportFnCount > 1) {
        ctx.addViolation("Props 定义规范", "文件只能有一个 export function 组件，发现 ${exportFnCount} 个。");
    }
    if (!viewFn) {
        ctx.addViolation("Props 定义规范", "export function 必须以 View 结尾，如 SessionListView。");
    }

    // 检查参数
    const params = viewFn.parameters;
    if (!params || params.length === 0) {
        // 无参数，propVars 为空
        return { propVars, viewFn };
    }

    // 有参数，必须有对应的 Props 接口
    if (propsInterfaceCount === 0) {
        ctx.addViolation("Props 定义规范", "组件有参数但未定义 interface XxxxProps。")
    }
    if (propsInterfaceCount > 1) {
        ctx.addViolation("Props 定义规范", `只能有一个 Props 接口，发现 ${propsInterfaceCount} 个: [${[...propsInterfaces.keys()].join(", ")}]。`)

    }

    // 从 Props 接口收集属性
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
 * 获取指定行的代码文本
 */
export function getCodeLine(sourceCode: string, line: number): string {
    const lines = sourceCode.split(/\r?\n/);
    if (line >= 1 && line <= lines.length) {
        return lines[line - 1].trim();
    }
    return "";
}

/**
 * 判断节点是否是 dep() 调用表达式
 */
export function isDepCall(node: ts.Node): boolean {
    return ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "dep";
}