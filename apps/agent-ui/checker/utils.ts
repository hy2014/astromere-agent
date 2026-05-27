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