// checker/rules/className-binding.ts
import * as ts from "typescript";
import { RuleContext } from "../types";
import { isDepCall } from "../utils";
/**
 * 样式状态化隔离：
 * className 的值必须是单一变量引用，禁止任何表达式
 */
export function checkClassNameBinding(ctx: RuleContext) {
    function visit(node: ts.Node) {
        if (ts.isJsxAttribute(node)) {
            const attrName = node.name.text;

            if (attrName === "className" && node.initializer) {
                // 静态字符串允许
                if (ts.isStringLiteral(node.initializer)) {
                    return;
                }

                // JSX 表达式 {...}
                if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
                    const expr = node.initializer.expression;

                    // 只允许单一标识符引用
                    if (!ts.isIdentifier(expr) && !isDepCall(expr)) {
                        ctx.addViolation(
                            "样式状态化隔离",
                            "className 必须绑定单一变量引用，或使用 dep(state, props, fn)。",
                            node
                        );
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(ctx.sourceFile);
}