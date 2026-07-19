// checker/rules/check-use-callback.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

const USAGE_HINT = "useCallback 仅用于事件绑定，通过 events 槽或子组件 props 透传";

/**
 * Checks useCallback usage inside the View function body
 *
 * Allowed pattern (only):
 *   const onEventXxx = useCallback((param1, param2?) => {
 *       handleXxx(param1, param2, state1, state2)
 *   }, [state1, state2])
 *
 * Rules:
 *   1. Only inside the View function body (the caller guarantees the correct viewFn is passed)
 *   2. Variable name must start with onEvent
 *   3. callback body may contain only a single { handleXxx(...) } statement
 *   4. handleXxx must be a file-level function
 *   5. callback params must be passed verbatim to handleXxx (same order/count)
 *   6. deps must be state/memo variables
 *   7. variables in deps unused by handleXxx are reported as errors (redundant)
 *   8. handleXxx must not return a non-void value
 *   9. handleXxx must not contain render() / JSX
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

    // Rule 2: variable name must start with onEvent
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

    // Rule 3: the first argument must be an arrow function or function expression
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
        // () => handleXxx(...) expression body
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

    // Rule 4: handleXxx must be a file-level function
    if (!isFileLevelFunction(ctx, handleName)) {
        ctx.addViolation(
            "useCallback 规范",
            `"${handleName}" 必须是文件级函数（function 声明或 const 箭头函数）。${USAGE_HINT}`,
            handleCall.expression,
        );
    }

    // Rule 5: callback params → handleXxx args must match
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

    // deps must be an array literal
    if (!ts.isArrayLiteralExpression(deps)) {
        ctx.addViolation(
            "useCallback 规范",
            `useCallback 的第二个参数必须是数组字面量 [deps]。${USAGE_HINT}`,
            deps,
        );
        return;
    }

    // ── Whitelist: check each extra arg one by one ──
    // All args must be traceable by the checker; unrecognized arg patterns are reported directly
    const extraArgNames = new Set<string>();
    for (let i = cbParams.length; i < handleArgs.length; i++) {
        const arg = handleArgs[i];
        if (ts.isIdentifier(arg)) {
            extraArgNames.add(arg.text);
        } else if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression)) {
            extraArgNames.add(arg.expression.text);
        } else {
            ctx.addViolation(
                "useCallback 规范",
                `"${handleName}" 第 ${i + 1} 个参数 "${arg.getText()}" 无法追踪来源，` +
                `handleXxx 的传参必须使用 Identifier（变量名）。${USAGE_HINT}`,
                arg,
            );
        }
    }

    // ── Whitelist: check each dep one by one ──
    // Each element of the deps array must be a destructured Identifier
    const depNamesSet = new Set<string>();
    for (const dep of deps.elements) {
        if (ts.isIdentifier(dep)) {
            depNamesSet.add(dep.text);
        } else {
            ctx.addViolation(
                "useCallback 规范",
                `deps 中的 "${dep.getText()}" 不是有效的变量名，state/props 必须先解构再使用。${USAGE_HINT}`,
                dep,
            );
        }
    }

    // ── Bidirectional check: extra args ⇄ deps ──

    // Direction A: for every variable in deps, handleXxx must use it
    for (const dep of deps.elements) {
        if (!ts.isIdentifier(dep)) continue;
        if (!extraArgNames.has(dep.text)) {
            ctx.addViolation(
                "useCallback 规范",
                `deps 中的 "${dep.text}" 未被 "${handleName}" 使用，请移除多余的 deps。${USAGE_HINT}`,
                dep,
            );
        }
        // Variables in deps must be state/props
        if (!ctx.stateVars.has(dep.text) && !ctx.propVars.has(dep.text)) {
            ctx.addViolation(
                "useCallback 规范",
                `deps 中的 "${dep.text}" 不是 state/props 变量。${USAGE_HINT}`,
                dep,
            );
        }
    }

    // Direction B: every extra arg of handleXxx must appear in deps
    extraArgNames.forEach(name => {
        if (depNamesSet.has(name)) return;

        ctx.addViolation(
            "useCallback 规范",
            `"${handleName}" 使用了 "${name}" 但未出现在 deps 中。` +
            `useCallback 的 deps 必须与 handleXxx 的参数一一对应。${USAGE_HINT}`,
            call,
        );
    });

    // Rule 8 & 9: check the handleXxx function body
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
        // Rule 8: return <value> — handle should not return a value
        if (ts.isReturnStatement(node) && node.expression) {
            ctx.addViolation(
                "useCallback 规范",
                `"${handleName}" 是 handle 函数，不应有返回值（return <值>）。handle 函数应只执行业务逻辑，不返回数据。${USAGE_HINT}`,
                node,
            );
            return;
        }

        // Rule 9: should not call render()
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

        // Rule 9: should not contain JSX
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
                            : undefined; // Arrow function with expression body has no block, skip
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
 * Walks the node subtree without descending into nested functions (inner functions have their own scope)
 */
function walkBodyNoNesting(node: ts.Node, visit: (n: ts.Node) => void): void {
    // Do not descend into inner functions
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))) {
        // The outermost function itself must be checked, but skip its inner nested functions
        // But we re-enter it during internal recursion, so it must be skipped within the recursion
    }
    visit(node);
    ts.forEachChild(node, (child) => {
        if (ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isFunctionDeclaration(child)) {
            // Skip inner function
            return;
        }
        walkBodyNoNesting(child, visit);
    });
}
