// checker/rules/jsx-expression.ts
import * as ts from "typescript";
import { RuleContext } from "../types";
import { isInsideEventHandler} from "../utils";

export function checkJsxExpression(ctx: RuleContext, viewFn: ts.Node | null) {
    if (!viewFn) return;

    function visit(node: ts.Node) {
        if (ts.isJsxExpression(node) && node.expression) {
            const expr = node.expression;

            if (isInsideEventHandler(node)) return;

            // render_when / render_case
            if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
                const name = expr.expression.text;
                if (name === "render_when" || name === "render_case") return;
            }

            // 属性访问 xxx.yyy
            if (ts.isPropertyAccessExpression(expr)) return;

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

            ctx.addViolation(
                "JSX 表达式规范",
                "JSX 中 `{...}` 只允许 state/props 变量、取反、属性访问、render_when() 或 render_case() 调用。",
                node
            );
        }

        ts.forEachChild(node, visit);
    }

    visit(viewFn);
}