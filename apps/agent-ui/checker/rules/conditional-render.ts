// checker/rules/conditional-render.ts
import * as ts from "typescript";
import { RuleContext } from "../types";
import {isInsideDep} from "../utils";

/**
 * 条件渲染白名单：
 * - && 左侧必须是单一 boolean 变量（可带 ! 取反），必须用括号包裹
 * - && 右侧必须是 JSX 元素，必须用括号包裹
 * - 三元表达式仅允许字符串分支
 */
export function checkConditionalRender(ctx: RuleContext) {
    function visit(node: ts.Node) {
        if (ts.isJsxExpression(node) && node.expression) {
            const expr = node.expression;
            if (isInsideDep(node)) return;

            // 检查 && 表达式
            if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                checkAndExpression(expr, ctx);
            }

            // 检查三元表达式
            if (ts.isConditionalExpression(expr)) {
                checkTernaryExpression(expr, ctx);
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(ctx.sourceFile);
}

function checkAndExpression(expr: ts.BinaryExpression, ctx: RuleContext) {
    const left = expr.left;
    const right = expr.right;

    // 左侧必须用括号包裹
    if (!ts.isParenthesizedExpression(left)) {
        ctx.addViolation(
            "条件渲染白名单",
            "&& 左侧条件必须用括号包裹，如 (isOpen) && (<Comp />)。",
            left
        );
    } else {
        // 括号内必须是单一 boolean 变量或取反
        const inner = left.expression;
        if (!isSimpleBoolean(inner)) {
            ctx.addViolation(
                "条件渲染白名单",
                "&& 左侧必须是单一 boolean 变量，可以是 !boolVar，禁止表达式或多条件组合。",
                inner
            );
        }
    }

    // 右侧必须用括号包裹
    if (!ts.isParenthesizedExpression(right)) {
        ctx.addViolation(
            "条件渲染白名单",
            "&& 右侧 JSX 必须用括号包裹，如 (isOpen) && (<Comp />)。",
            right
        );
    } else {
        const inner = right.expression;
        if (
            !ts.isJsxElement(inner) &&
            !ts.isJsxSelfClosingElement(inner) &&
            !ts.isJsxFragment(inner)
        ) {
            ctx.addViolation(
                "条件渲染白名单",
                "&& 右侧必须是 JSX 元素。",
                inner
            );
        }
    }
}

function isSimpleBoolean(node: ts.Node): boolean {
    // !boolVar
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
        return ts.isIdentifier(node.operand);
    }
    // boolVar
    return ts.isIdentifier(node);
}

function checkTernaryExpression(expr: ts.ConditionalExpression, ctx: RuleContext) {
    if (!ts.isStringLiteral(expr.whenTrue) || !ts.isStringLiteral(expr.whenFalse)) {
        ctx.addViolation(
            "条件渲染白名单",
            "三元表达式只能用于字符串条件渲染，分支必须为字符串字面量。JSX 渲染请使用 (bool) && (<Comp />)。",
            expr
        );
    }
}