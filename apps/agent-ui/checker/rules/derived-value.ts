// checker/rules/derived-value.ts
import * as ts from "typescript";
import { RuleContext } from "../types";
import { isDepCall } from "../utils";  // ← 加这行

/**
 * JSX 中引用的派生值必须通过 dep() 计算
 */
export function checkDerivedValues(ctx: RuleContext) {
    // 先收集所有通过 dep() 赋值的变量
    const depDerivedVars = new Set<string>();

    function collectDepVars(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.initializer) {
            if (ts.isCallExpression(node.initializer)) {
                const callee = node.initializer.expression;
                if (ts.isIdentifier(callee) && callee.text === "dep" && ts.isIdentifier(node.name)) {
                    depDerivedVars.add(node.name.text);
                }
            }
        }
        ts.forEachChild(node, collectDepVars);
    }
    collectDepVars(ctx.sourceFile);

    const stateVars = ctx.stateVars;
    const propVars = ctx.propVars;

    // 检查 JSX 中的变量引用
    function checkJsxVars(node: ts.Node) {
        if (ts.isJsxExpression(node) && node.expression) {
            const expr = node.expression;

            // dep() 调用直接允许
            if (isDepCall(expr)) return;

            if (ts.isIdentifier(expr)) {
                const varName = expr.text;

                // 跳过 state 直接引用
                if (stateVars.has(varName)) return;
                // 跳过 props 直接引用
                if (propVars.has(varName)) return;
                // 跳过 setter
                if (varName.startsWith("set")) return;
                // 跳过已经通过 dep() 派生的
                if (depDerivedVars.has(varName)) return;

                if (isInEventHandler(node)) return;

                // 只有依赖了 state/props 的派生值才报错
                if (isDerivedFromStateOrProps(varName, stateVars, propVars, ctx.sourceFile)) {
                    ctx.addViolation(
                        "派生值来源",
                        `JSX 中使用的派生变量 "${varName}" 依赖 state/props，必须通过 dep(state, props, fn) 计算。`,
                        node
                    );
                }
            } else {
                ctx.addViolation(
                    "派生值来源",
                    "JSX 中 `{...}` 必须是单一变量引用或 dep() 调用，禁止表达式、逻辑运算。",
                    node
                );
            }
        }
        ts.forEachChild(node, checkJsxVars);
    }
    checkJsxVars(ctx.sourceFile);
}

function isInEventHandler(node: ts.Node): boolean {
    let current = node.parent;
    while (current) {
        if (ts.isJsxAttribute(current)) {
            const attrName = current.name.text;
            if (attrName.startsWith("on")) return true;
        }
        current = current.parent;
    }
    return false;
}

/**
 * 检查变量是否从 state/props 派生（即是否在初始化时引用了 state 或 props）
 */
function isDerivedFromStateOrProps(
    varName: string,
    stateVars: Set<string>,
    propVars: Set<string>,
    sourceFile: ts.SourceFile
): boolean {
    let result = false;

    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === varName) {
            const initializer = node.initializer;
            if (initializer) {
                // 检查初始化表达式是否引用了 state 或 props
                result = referencesStateOrProps(initializer, stateVars, propVars);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);

    return result;
}

function referencesStateOrProps(
    node: ts.Node,
    stateVars: Set<string>,
    propVars: Set<string>
): boolean {
    if (ts.isIdentifier(node) && (stateVars.has(node.text) || propVars.has(node.text))) {
        return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
        if (referencesStateOrProps(child, stateVars, propVars)) found = true;
    });
    return found;
}