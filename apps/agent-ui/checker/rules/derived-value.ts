// checker/rules/derived-value.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

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

    // 收集 state 变量名
    const stateVars = new Set<string>();

    function collectStateVars(node: ts.Node) {
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
        ts.forEachChild(node, collectStateVars);
    }
    collectStateVars(ctx.sourceFile);

    // 收集 props 变量名
    const propVars = new Set<string>();

    function collectPropVars(node: ts.Node) {
        // 找函数组件
        if (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) {
            // 检查是否有参数解构
            const body = ts.isFunctionDeclaration(node) ? node : undefined;
            const arrowFn = ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer) ? node.initializer : undefined;
            const params = body?.parameters || arrowFn?.parameters;
            if (params && params.length > 0) {
                const firstParam = params[0];
                if (ts.isObjectBindingPattern(firstParam.name)) {
                    for (const el of firstParam.name.elements) {
                        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                            propVars.add(el.name.text);
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, collectPropVars);
    }
    collectPropVars(ctx.sourceFile);

    // 检查 JSX 中的变量引用
    function checkJsxVars(node: ts.Node) {
        if (ts.isJsxExpression(node) && node.expression) {
            const expr = node.expression;
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

                // 只有依赖了 state/props 的派生值才报错
                if (isDerivedFromStateOrProps(varName, stateVars, propVars, ctx.sourceFile)) {
                    ctx.addViolation(
                        "派生值来源",
                        `JSX 中使用的派生变量 "${varName}" 依赖 state/props，必须通过 dep(state, props, fn) 计算。`,
                        node
                    );
                }
            }
        }
        ts.forEachChild(node, checkJsxVars);
    }
    checkJsxVars(ctx.sourceFile);
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