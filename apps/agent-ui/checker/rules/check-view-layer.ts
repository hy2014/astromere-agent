// checker/rules/check-view-layer.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

/**
 * 检查 View 层（导出函数）是否包含禁止的条件表达式：
 * 1. 禁止 && 表达式
 * 2. 禁止三元表达式
 * 3. 禁止 if 语句（除了 if (xxx) return null; 这种在 renderFn 内允许，View 层不允许）
 *
 * View 层只允许直接调用 render(...)
 */
export function checkViewLayer(ctx: RuleContext, viewFn: ts.Node | null): void {
    if (!viewFn) return;

    // 只检查 View 函数本身，不深入 renderFn
    const body = ts.isArrowFunction(viewFn)
        ? viewFn.body
        : (viewFn as ts.FunctionDeclaration).body;

    if (!body) return;

    // 1. 禁止 && 和三元表达式
    function checkExpression(node: ts.Node) {
        // 禁止二元表达式中的 &&
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            ctx.addViolation(
                "View 层规范",
                "View 层禁止使用 && 条件表达式，请将条件逻辑下沉到 renderFn 内部。",
                node
            );
        }

        // 禁止三元表达式
        if (ts.isConditionalExpression(node)) {
            ctx.addViolation(
                "View 层规范",
                "View 层禁止使用三元表达式，请将条件逻辑下沉到 renderFn 内部。",
                node
            );
        }

        ts.forEachChild(node, checkExpression);
    }

    // 2. 禁止 if 语句（View 层不应该有任何条件分支）
    function checkStatement(node: ts.Node) {
        if (ts.isIfStatement(node)) {
            ctx.addViolation(
                "View 层规范",
                "View 层禁止使用 if 语句，请将条件逻辑下沉到 renderFn 内部。",
                node
            );
        }
        ts.forEachChild(node, checkStatement);
    }

    if (ts.isBlock(body)) {
        body.statements.forEach(checkStatement);
    }
    checkExpression(body);
}