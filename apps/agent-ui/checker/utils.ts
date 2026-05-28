// checker/utils.ts
import * as ts from "typescript";

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
}export function collectPropVars(sourceFile: ts.SourceFile): { propVars: Set<string>; propsInterfaceCount: number } {
    const propVars = new Set<string>();
    let propsInterfaceCount = 0;

    function visit(node: ts.Node) {
        if (ts.isInterfaceDeclaration(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
            if (/Props$/.test(node.name.text)) {
                propsInterfaceCount++;
                for (const member of node.members) {
                    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
                        propVars.add(member.name.text);
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);

    return { propVars, propsInterfaceCount };
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