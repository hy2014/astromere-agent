// checker/rules/atomic-binding.ts
import * as ts from "typescript";
import { RuleContext } from "../types";
import { isDepCall } from "../utils";


/**
 * 原子属性绑定：
 * value、disabled、checked 的值只能是单一变量或取反，禁止表达式
 */
const ATOMIC_ATTRS = new Set(["value", "disabled", "checked"]);

export function checkAtomicBinding(ctx: RuleContext) {
    function visit(node: ts.Node) {
        if (ts.isJsxAttribute(node)) {
            const attrName = node.name.text;

            if (ATOMIC_ATTRS.has(attrName) && node.initializer) {
                // 静态值允许
                if (ts.isStringLiteral(node.initializer) || node.initializer.kind === ts.SyntaxKind.TrueKeyword || node.initializer.kind === ts.SyntaxKind.FalseKeyword) {
                    return;
                }

                // JSX 表达式 {...}
                if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
                    const expr = node.initializer.expression;

                    // 单一变量
                    if (ts.isIdentifier(expr)) return;

                    // 取反 !var
                    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken && ts.isIdentifier(expr.operand)) {
                        return;
                    }

                    // dep() 调用
                    if (isDepCall(expr)) return;  // ← 加这行

                    // 其他一律禁止
                    ctx.addViolation(
                        "原子属性绑定",
                        `属性 "${attrName}" 的值必须是单一状态变量或取反（!var），禁止表达式。`,
                        node
                    );
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(ctx.sourceFile);
}