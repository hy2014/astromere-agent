// checker/rules/jsx-expression.ts
import * as ts from "typescript";
import { RuleContext } from "../types";
import { isDepCall, isInsideEventHandler, isInsideDep } from "../utils";

/**
 * JSX 表达式统一检查：
 * {...} 只允许 state/props 变量、取反、dep() 调用
 */
export function checkJsxExpression(ctx: RuleContext) {
    // 收集 dep 引用的函数名，用于豁免函数体
    const depFnNames = new Set<string>();
    function collectDepFns(node: ts.Node) {
        if (isDepCall(node) && node.arguments.length === 3) {
            const thirdArg = (node as ts.CallExpression).arguments[2];
            if (ts.isIdentifier(thirdArg)) {
                depFnNames.add(thirdArg.text);
            }
        }
        ts.forEachChild(node, collectDepFns);
    }
    collectDepFns(ctx.sourceFile);

    function visit(node: ts.Node) {
        // 跳过 dep 注册的函数定义
        if (ts.isFunctionDeclaration(node) && node.name && depFnNames.has(node.name.text)) return;
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && depFnNames.has(node.name.text)) return;

        // 检查 JSX 表达式
        if (ts.isJsxExpression(node) && node.expression) {
            // dep 内部豁免
            if (isInsideDep(node)) return;

            const expr = node.expression;

            // 事件处理器跳过
            if (isInsideEventHandler(node)) return;

            // dep() 调用
            if (isDepCall(expr)) return;

            // 单一变量
            if (ts.isIdentifier(expr)) {
                const name = expr.text;
                if (ctx.stateVars.has(name)) return;
                if (ctx.propVars.has(name)) return;
                if (name.startsWith("set")) return;
            }

            // 取反 !var
            if (ts.isPrefixUnaryExpression(expr) &&
                expr.operator === ts.SyntaxKind.ExclamationToken &&
                ts.isIdentifier(expr.operand)) {
                const name = expr.operand.text;
                if (ctx.stateVars.has(name)) return;
                if (ctx.propVars.has(name)) return;
            }

            // 其他一律禁止
            ctx.addViolation(
                "JSX 表达式规范",
                "JSX 中 `{...}` 只允许 state/props 变量、取反或 dep() 调用。请将逻辑封装进 dep(state, props, fn)。",
                node
            );
        }

        ts.forEachChild(node, visit);
    }

    visit(ctx.sourceFile);
}