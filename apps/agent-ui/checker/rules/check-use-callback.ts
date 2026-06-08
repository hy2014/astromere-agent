// checker/rules/check-use-callback.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

const USAGE_HINT = "useCallback 仅用于事件绑定，通过 events 槽或子组件 props 透传";

/**
 * 检查 View 函数体内的 useCallback 用法
 *
 * 允许的唯一模式：
 *   const onEventXxx = useCallback((param1, param2?) => {
 *       handleXxx(param1, param2, state1, state2)
 *   }, [state1, state2])
 *
 * 规则：
 *   1. 只能在 View 函数体内（由调用方保证传入正确的 viewFn）
 *   2. 变量名必须以 onEvent 开头
 *   3. callback body 仅限单条 { handleXxx(...) } 语句
 *   4. handleXxx 必须是文件级函数
 *   5. callback 参数必须原封不动传给 handleXxx（顺序/个数一致）
 *   6. deps 必须是 state/memo 变量
 *   7. deps 中 handleXxx 未使用的变量报错（冗余）
 *   8. handleXxx 不得返回非 void 值
 *   9. handleXxx 不得包含 render() / JSX
 */
export function checkUseCallback(
    ctx: RuleContext,
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
): void {
    if (!viewFn) return;

    const body = ts.isArrowFunction(viewFn)
        ? (viewFn.body as ts.Block | undefined)
        : (viewFn as ts.FunctionDeclaration).body;
    if (!body || !ts.isBlock(body)) return;

    for (const stmt of body.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
            if (!ts.isCallExpression(decl.initializer)) continue;
            const callee = decl.initializer.expression;
            if (!ts.isIdentifier(callee) || callee.text !== "useCallback") continue;

            inspectUseCallback(ctx, decl.name.text, decl.initializer);
        }
    }
}

function inspectUseCallback(
    ctx: RuleContext,
    varName: string,
    call: ts.CallExpression,
): void {
    const args = call.arguments;

    // 规则 2: 变量名必须以 onEvent 开头
    if (!varName.startsWith("onEvent")) {
        ctx.addViolation(
            "useCallback 规范",
            `useCallback 变量名 "${varName}" 应以 "onEvent" 开头。${USAGE_HINT}`,
            call,
        );
    }

    if (args.length < 2) {
        ctx.addViolation(
            "useCallback 规范",
            `useCallback 至少需要 2 个参数（callback 和 deps 数组）。${USAGE_HINT}`,
            call,
        );
        return;
    }

    const callback = args[0];
    const deps = args[1];

    // 规则 3: 第一个参数必须是箭头函数或函数表达式
    if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
        ctx.addViolation(
            "useCallback 规范",
            `useCallback 的第一个参数必须是箭头函数或函数表达式。${USAGE_HINT}`,
            callback,
        );
        return;
    }

    const cbBody = callback.body;
    let handleCall: ts.CallExpression | null = null;
    let handleName: string | null = null;

    if (ts.isBlock(cbBody)) {
        const stmts = cbBody.statements;
        if (stmts.length !== 1) {
            ctx.addViolation(
                "useCallback 规范",
                `useCallback 回调体只能包含一条语句（调用 handleXxx）。${USAGE_HINT}`,
                cbBody,
            );
            return;
        }
        const stmt0 = stmts[0];
        if (ts.isExpressionStatement(stmt0) && ts.isCallExpression(stmt0.expression)) {
            handleCall = stmt0.expression;
        }
    } else if (ts.isCallExpression(cbBody)) {
        // () => handleXxx(...) 表达式体
        handleCall = cbBody;
    }

    if (!handleCall || !ts.isIdentifier(handleCall.expression)) {
        ctx.addViolation(
            "useCallback 规范",
            `useCallback 回调体必须是调用文件级函数 handleXxx(...)。${USAGE_HINT}`,
            callback,
        );
        return;
    }

    handleName = handleCall.expression.text;

    // 规则 4: handleXxx 必须是文件级函数
    if (!isFileLevelFunction(ctx, handleName)) {
        ctx.addViolation(
            "useCallback 规范",
            `"${handleName}" 必须是文件级函数（function 声明或 const 箭头函数）。${USAGE_HINT}`,
            handleCall.expression,
        );
    }

    // 规则 5: callback 参数 → handleXxx 传参必须一致
    const cbParams = callback.parameters;
    const handleArgs = handleCall.arguments;

    for (let i = 0; i < cbParams.length; i++) {
        if (i >= handleArgs.length) {
            ctx.addViolation(
                "useCallback 规范",
                `callback 参数 "${cbParams[i].name.getText()}" 未传给 "${handleName}"。${USAGE_HINT}`,
                callback,
            );
            break;
        }
        const arg = handleArgs[i];
        const paramText = cbParams[i].name.getText();
        if (!ts.isIdentifier(arg) || arg.text !== paramText) {
            ctx.addViolation(
                "useCallback 规范",
                `callback 参数 "${paramText}" 必须原封不动作为 "${handleName}" 的第 ${i + 1} 个参数。${USAGE_HINT}`,
                handleCall,
            );
        }
    }

    // deps 必须是数组字面量
    if (!ts.isArrayLiteralExpression(deps)) {
        ctx.addViolation(
            "useCallback 规范",
            `useCallback 的第二个参数必须是数组字面量 [deps]。${USAGE_HINT}`,
            deps,
        );
        return;
    }

    // 收集 handleXxx 使用了哪些 state/props 变量（callback 参数之后的所有传参）
    // 只支持解构后的 Identifier（props.xxx 不支持）
    const extraArgNames = new Set<string>();
    for (let i = cbParams.length; i < handleArgs.length; i++) {
        const arg = handleArgs[i];
        if (ts.isIdentifier(arg)) {
            extraArgNames.add(arg.text);
        }
    }

    // 收集 deps 中的变量名（只支持 Identifier，必须解构）
    const depNamesSet = new Set<string>();
    for (const dep of deps.elements) {
        if (ts.isIdentifier(dep)) {
            depNamesSet.add(dep.text);
        }
    }

    // 规则 6 & 7: deps 校验
    for (const dep of deps.elements) {
        if (!ts.isIdentifier(dep)) {
            ctx.addViolation(
                "useCallback 规范",
                `deps 中的 "${dep.getText()}" 不是有效的变量名，state/props 必须先解构再使用。${USAGE_HINT}`,
                dep,
            );
            continue;
        }

        // 规则 6: deps 必须是 state/props 变量
        if (!ctx.stateVars.has(dep.text) && !ctx.propVars.has(dep.text)) {
            ctx.addViolation(
                "useCallback 规范",
                `deps 中的 "${dep.text}" 不是 state/props 变量。${USAGE_HINT}`,
                dep,
            );
        }

        // 规则 7: deps 中 handleXxx 没用到要报错
        if (!extraArgNames.has(dep.text)) {
            ctx.addViolation(
                "useCallback 规范",
                `deps 中的 "${dep.text}" 未被 "${handleName}" 使用，请移除多余的 deps。${USAGE_HINT}`,
                dep,
            );
        }
    }

    // 规则 7b（反向）: handleXxx 用到的 state/props 变量必须都在 deps 中
    extraArgNames.forEach(name => {
        if (!ctx.stateVars.has(name) && !ctx.propVars.has(name)) return;
        if (!depNamesSet.has(name)) {
            ctx.addViolation(
                "useCallback 规范",
                `"${handleName}" 使用了 "${name}" 但未出现在 deps 中。useCallback 的 deps 必须与 handleXxx 的参数一一对应。${USAGE_HINT}`,
                call,
            );
        }
    });

    // 规则 8 & 9: 检查 handleXxx 函数体
    checkHandleBody(ctx, handleName, call);
}

function isFileLevelFunction(ctx: RuleContext, name: string): boolean {
    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.name.text === name) {
            return true;
        }
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
                    if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

function checkHandleBody(ctx: RuleContext, handleName: string, useCallbackNode: ts.Node): void {
    const fnBody = findHandleBody(ctx, handleName);
    if (!fnBody) return;

    walkBodyNoNesting(fnBody, (node) => {
        // 规则 8: return <value> — handle 不应返回值
        if (ts.isReturnStatement(node) && node.expression) {
            ctx.addViolation(
                "useCallback 规范",
                `"${handleName}" 是 handle 函数，不应有返回值（return <值>）。handle 函数应只执行业务逻辑，不返回数据。${USAGE_HINT}`,
                node,
            );
            return;
        }

        // 规则 9: 不应调用 render()
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isIdentifier(callee) && callee.text === "render") {
                ctx.addViolation(
                    "useCallback 规范",
                    `"${handleName}" 是 handle 函数，不应调用 render()。handle 函数只处理业务逻辑，不参与渲染。${USAGE_HINT}`,
                    node,
                );
                return;
            }
        }

        // 规则 9: 不应包含 JSX
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
            ctx.addViolation(
                "useCallback 规范",
                `"${handleName}" 是 handle 函数，不应包含 JSX。handle 函数只处理业务逻辑，不参与渲染。${USAGE_HINT}`,
                node,
            );
        }
    });
}

function findHandleBody(ctx: RuleContext, name: string): ts.Block | undefined {
    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.name.text === name && stmt.body) {
            return stmt.body;
        }
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
                    if (ts.isArrowFunction(decl.initializer) && decl.initializer.body) {
                        return ts.isBlock(decl.initializer.body)
                            ? decl.initializer.body
                            : undefined; // 表达式体箭头函数没有 block，跳过
                    }
                    if (ts.isFunctionExpression(decl.initializer) && decl.initializer.body) {
                        return decl.initializer.body;
                    }
                }
            }
        }
    }
    return undefined;
}

/**
 * 遍历 node 子树，不穿透嵌套函数（内层函数有自己的作用域）
 */
function walkBodyNoNesting(node: ts.Node, visit: (n: ts.Node) => void): void {
    // 不穿透内层函数
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))) {
        // 最外层函数本身需要检查，但跳过其内部嵌套的函数
        // 但我们内部递归时会再次进入，所以需要在递归中跳过
    }
    visit(node);
    ts.forEachChild(node, (child) => {
        if (ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isFunctionDeclaration(child)) {
            // 跳过内层函数
            return;
        }
        walkBodyNoNesting(child, visit);
    });
}
