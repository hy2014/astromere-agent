// checker/rules/check-write-state.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

/**
 * Collect the useState setter names inside the View function body
 * Used for WriteState registration checks, useEffect checks, and events/exts checks
 */
function collectStateSetters(viewBody: ts.Block): Set<string> {
    const setters = new Set<string>();
    for (const stmt of viewBody.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
            if (!ts.isVariableDeclaration(decl) ||
                !ts.isArrayBindingPattern(decl.name) ||
                !decl.initializer ||
                !ts.isCallExpression(decl.initializer)) continue;
            const callee = decl.initializer.expression;
            if (!ts.isIdentifier(callee) || callee.text !== "useState") continue;
            if (decl.name.elements.length < 2) continue;
            const setterElem = decl.name.elements[1];
            if (ts.isBindingElement(setterElem) && ts.isIdentifier(setterElem.name)) {
                setters.add(setterElem.name.text);
            }
        }
    }
    return setters;
}

/**
 * Check whether the useEffect callback is simple enough
 * Only allowed: () => { void fn(); }, () => { fn(); }, or () => fn()
 */
function isUseEffectCallbackSimple(
    callback: ts.ArrowFunction | ts.FunctionExpression,
    setterNames: Set<string>,
    stateVars: Set<string>,
): { ok: boolean; reason?: string } {
    const body = callback.body;

    // (no body) — invalid
    if (!body) return { ok: false, reason: "useEffect 回调不能为空" };

    // () => expr — only a single expression
    if (!ts.isBlock(body)) {
        // Must be a function call
        if (ts.isCallExpression(body)) {
            return checkCallExpression(body, setterNames, stateVars);
        }
        if (ts.isVoidExpression(body) && ts.isCallExpression(body.expression)) {
            return checkCallExpression(body.expression, setterNames, stateVars);
        }
        return { ok: false, reason: "useEffect 回调必须是单个函数调用" };
    }

    // () => { ... } — block body
    const stmts = body.statements;
    if (stmts.length === 0) {
        return { ok: false, reason: "useEffect 回调体不能为空" };
    }
    if (stmts.length > 1) {
        return { ok: false, reason: "useEffect 回调体只能包含一条语句" };
    }

    const stmt = stmts[0];

    // () => { void fn(); } or () => { fn(); }
    if (ts.isExpressionStatement(stmt)) {
        const expr = stmt.expression;
        if (ts.isVoidExpression(expr) && ts.isCallExpression(expr.expression)) {
            return checkCallExpression(expr.expression, setterNames, stateVars);
        }
        if (ts.isCallExpression(expr)) {
            return checkCallExpression(expr, setterNames, stateVars);
        }
        return { ok: false, reason: "useEffect 回调体必须是单个函数调用" };
    }

    return { ok: false, reason: "useEffect 回调体必须是单个函数调用" };
}

/**
 * Check whether the CallExpression references state/setter
 */
function checkCallExpression(
    call: ts.CallExpression,
    setterNames: Set<string>,
    stateVars: Set<string>,
): { ok: boolean; reason?: string } {
    const callee = call.expression;

    // Must be an Identifier, not WriteState.setXxx
    if (!ts.isIdentifier(callee)) {
        return { ok: false, reason: "useEffect 只能调用文件级函数，不能调用 WriteState 方法或复杂表达式" };
    }

    // The function name must not be a setter
    if (setterNames.has(callee.text)) {
        return { ok: false, reason: `useEffect 不能直接调用 setter "${callee.text}"` };
    }

    // Check whether the arguments reference state
    for (const arg of call.arguments) {
        let hasStateRef = false;
        function checkArg(n: ts.Node) {
            if (ts.isIdentifier(n) && (setterNames.has(n.text) || stateVars.has(n.text))) {
                hasStateRef = true;
            }
            ts.forEachChild(n, checkArg);
        }
        checkArg(arg);
        if (hasStateRef) {
            return { ok: false, reason: "useEffect 的参数不能引用 state 变量或 setter" };
        }
    }

    return { ok: true };
}

export function checkWriteState(
    ctx: RuleContext,
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
): void {
    if (!viewFn) return;

    const bodyNode = ts.isArrowFunction(viewFn)
        ? (viewFn.body as ts.Block | undefined)
        : (viewFn as ts.FunctionDeclaration).body;
    if (!bodyNode || !ts.isBlock(bodyNode)) return;

    const bodyStmts = bodyNode.statements;
    const stateSetters = collectStateSetters(bodyNode);
    const writeStateKeys = new Set<string>();

    // ════════════════════════════════════════════════════════
    // Rule 1: useState → WriteState.setXxx registration completeness
    // Every useState setter must be registered in WriteState
    // ════════════════════════════════════════════════════════
    for (const stmt of bodyStmts) {
        if (!ts.isExpressionStatement(stmt)) continue;
        const expr = stmt.expression;
        if (!ts.isBinaryExpression(expr) ||
            expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
        const left = expr.left;
        if (ts.isPropertyAccessExpression(left) &&
            ts.isIdentifier(left.expression) &&
            left.expression.text === "WriteState") {
            const key = left.name.text;
            writeStateKeys.add(key);

            // Rule 1b: WriteState value must be a useState setter reference
            const right = expr.right;
            if (!ts.isIdentifier(right) || right.text !== key) {
                ctx.addViolation(
                    "WriteState 规范",
                    `WriteState.${key} 只能赋值为 useState 的 setter 函数 "${key}"，不能赋值其他值`,
                    stmt,
                );
            } else if (!stateSetters.has(right.text)) {
                ctx.addViolation(
                    "WriteState 规范",
                    `WriteState.${key} 只能赋值为 useState 的 setter，` +
                    `"${right.text}" 不是一个 useState 的 setter 函数（并非通过 const [, setX] = useState() 声明）`,
                    stmt,
                );
            }
        }
    }

    for (const setterName of stateSetters) {
        if (!writeStateKeys.has(setterName)) {
            ctx.addViolation(
                "WriteState 规范",
                `useState 的 setter "${setterName}" 未注册到 WriteState，缺少 WriteState.${setterName} = ${setterName}`,
                viewFn,
            );
        }
    }

    // ════════════════════════════════════════════════════════
    // Rule 2a: Forbid defining functions inside the View
    // ════════════════════════════════════════════════════════
    for (const stmt of bodyStmts) {
        // function foo() {} — FunctionDeclaration
        if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            ctx.addViolation(
                "WriteState 规范",
                `View 函数内禁止定义函数 "${stmt.name.text}"，请移到文件级别`,
                stmt,
            );
            continue;
        }

        // const foo = () => {} or const foo = function() {}
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;

                // const [x, setX] = useState() — destructuring assignment allowed
                if (!ts.isIdentifier(decl.name)) continue;
                if (!decl.initializer) continue;

                // Rule 2a: arrow function / function expression → forbidden
                if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                    ctx.addViolation(
                        "WriteState 规范",
                        `View 函数内禁止定义函数 "${decl.name.text}"，请移到文件级别`,
                        decl,
                    );
                    continue;
                }

                // Rule 2c: View-internal const must be one of useMemo / useCallback / useState
                // Other hooks (useRef, useEffect, useContext, etc.) are likewise forbidden
                const hookName = ts.isCallExpression(decl.initializer) &&
                    ts.isIdentifier(decl.initializer.expression)
                    ? decl.initializer.expression.text
                    : null;
                if (hookName && (hookName === "useMemo" || hookName === "useCallback")) {
                    continue; // ✅ allowed
                }

                ctx.addViolation(
                    "WriteState 规范",
                    hookName
                        ? `View 内 const "${decl.name.text}" 来自 ${hookName}()，` +
                          `View 内只允许 useMemo / useCallback`
                        : `View 内 const "${decl.name.text}" 的值来源不明，` +
                          `View 内 const 只能来自 useMemo 或 useCallback`,
                    decl,
                );
            }
        }
    }

    // ════════════════════════════════════════════════════════
    // Rule 2b: useEffect callback must be simple (only calls one file-level function)
    // ════════════════════════════════════════════════════════
    function checkEffectCalls(node: ts.Node) {
        if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            (node.expression.text === "useEffect" || node.expression.text === "useLayoutEffect")) {
            const callback = node.arguments[0];
            if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return;

            const result = isUseEffectCallbackSimple(callback, stateSetters, ctx.stateVars);
            if (!result.ok) {
                ctx.addViolation("WriteState 规范", result.reason!, node);
            }
        }
        ts.forEachChild(node, checkEffectCalls);
    }
    checkEffectCalls(bodyNode);

    // ════════════════════════════════════════════════════════
    // Rule 3 (global): WriteState.setXxx may only be called or assigned, not passed as a value
    // Allowed:
    //   WriteState.setRows(...)          — direct call
    //   WriteState.setRows = setRows     — assignment target
    // Forbidden:
    //   doSomething(WriteState.setRows)  — passed as argument
    //   const x = WriteState.setRows     — assigned to a variable
    //   { a: WriteState.setRows }        — placed in an object
    // ════════════════════════════════════════════════════════
    function checkWriteStateUsage(node: ts.Node) {
        if (ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "WriteState") {
            const parent = node.parent;

            // Allowed: WriteState.setRows(...) — as the call target
            if (parent && ts.isCallExpression(parent) && parent.expression === node) {
                ts.forEachChild(node, checkWriteStateUsage);
                return;
            }

            // Allowed: WriteState.setRows = setRows — as the assignment target
            if (parent && ts.isBinaryExpression(parent) &&
                parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                parent.left === node) {
                ts.forEachChild(node, checkWriteStateUsage);
                return;
            }

            // All other usages are violations
            ctx.addViolation(
                "WriteState 规范",
                `WriteState.${node.name.text} 只能作为调用 (WriteState.${node.name.text}()) 或赋值目标 (WriteState.${node.name.text} = ...)，不能作为值传递`,
                node,
            );
        }
        ts.forEachChild(node, checkWriteStateUsage);
    }
    checkWriteStateUsage(ctx.sourceFile);

    // ════════════════════════════════════════════════════════
    // Rule 3b: render()'s events/exts forbid raw setter references
    // (WriteState.setXxx is already covered globally by Rule 3; here we only check raw setters)
    // ════════════════════════════════════════════════════════
    function checkRawSetterInRender(node: ts.Node) {
        if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "render") {

            const arg0 = node.arguments[0];
            if (!arg0 || !ts.isObjectLiteralExpression(arg0)) { ts.forEachChild(node, checkRawSetterInRender); return; }

            for (const slotName of ["events", "exts"]) {
                const slotProp = arg0.properties.find(
                    p => ts.isPropertyAssignment(p) &&
                        ts.isIdentifier(p.name) &&
                        p.name.text === slotName,
                ) as ts.PropertyAssignment | undefined;
                if (!slotProp) continue;

                const slotObj = slotProp.initializer;
                if (!slotObj || !ts.isObjectLiteralExpression(slotObj)) continue;

                for (const prop of slotObj.properties) {
                    // shorthand: { setRows }
                    if (ts.isShorthandPropertyAssignment(prop)) {
                        if (stateSetters.has(prop.name.text)) {
                            ctx.addViolation(
                                "WriteState 规范",
                                `render() 的 ${slotName} 不能包含 setter "${prop.name.text}"，请通过业务函数传递`,
                                prop,
                            );
                        }
                        continue;
                    }

                    // explicit: { key: setRows }
                    if (ts.isPropertyAssignment(prop)) {
                        const val = prop.initializer;
                        if (ts.isIdentifier(val) && stateSetters.has(val.text)) {
                            ctx.addViolation(
                                "WriteState 规范",
                                `render() 的 ${slotName} 不能包含 setter "${val.text}"，请通过业务函数传递`,
                                prop,
                            );
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, checkRawSetterInRender);
    }
    checkRawSetterInRender(bodyNode);

    // ════════════════════════════════════════════════════════
    // Rule 5: File-level function bodies forbid referencing external variables
    // Allowed: parameters, local variables, WriteState, function calls (callee), JSX tags
    // ════════════════════════════════════════════════════════

    // Recursively collect variable names in binding patterns (handles destructuring)
    function collectBindingNames(name: ts.BindingName, names: Set<string>) {
        if (ts.isIdentifier(name)) {
            names.add(name.text);
        } else if (ts.isObjectBindingPattern(name)) {
            for (const elem of name.elements) {
                collectBindingNames(elem.name, names);
            }
        } else if (ts.isArrayBindingPattern(name)) {
            for (const elem of name.elements) {
                collectBindingNames(elem.name, names);
            }
        }
    }

    // Collect the current function's parameter names (including destructuring) + local variable names
    function collectLocalNames(fn: ts.FunctionDeclaration | ts.ArrowFunction): Set<string> {
        const names = new Set<string>();
        for (const p of fn.parameters) {
            collectBindingNames(p.name, names);
        }
        if (fn.body && ts.isBlock(fn.body)) {
            function collectFromBlock(node: ts.Node) {
                if (ts.isVariableDeclaration(node)) {
                    collectBindingNames(node.name, names);
                }
                ts.forEachChild(node, collectFromBlock);
            }
            collectFromBlock(fn.body);
        }
        return names;
    }

    const viewFnName = viewFn && (ts.isFunctionDeclaration(viewFn) ? viewFn.name?.text : undefined);

    // Collect module-level function names (allowed to be referenced)
    const moduleFnNames = new Set<string>();
    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            moduleFnNames.add(stmt.name.text);
        }
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer &&
                    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
                    moduleFnNames.add(decl.name.text);
                }
            }
        }
    }

    // Collect module-level non-function variables (let / var / const non-functions); these cannot be call targets
    const moduleNonFnVars = new Set<string>();
    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) {
                    const init = decl.initializer;
                    // Skip function expressions const fn = () => {} (forbidden by check-render-fns)
                    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
                    // Skip useCallback/useMemo wrappers
                    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) &&
                        (init.expression.text === "useCallback" || init.expression.text === "useMemo")) continue;
                    moduleNonFnVars.add(decl.name.text);
                }
            }
        }
    }

    // Scan file-level functions (excluding the View)
    for (const stmt of ctx.sourceFile.statements) {
        let fn: ts.FunctionDeclaration | ts.ArrowFunction | undefined;
        let fnName: string | undefined;

        // function foo() {}
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
            fnName = stmt.name.text;
            if (fnName === viewFnName) continue; // Skip View
            fn = stmt;
        }

        // const foo = () => {} / function() {}
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (!decl.initializer) continue;
                if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                    // Skip View arrow function
                    if (ts.isArrowFunction(viewFn) && viewFn === decl.initializer) continue;
                    fn = decl.initializer as ts.ArrowFunction;
                    if (ts.isIdentifier(decl.name)) fnName = decl.name.text;
                }
            }
        }

        if (!fn || !fn.body || !ts.isBlock(fn.body)) continue;

        const localNames = collectLocalNames(fn);

        function checkExternalRef(node: ts.Node, scope: Set<string> = localNames) {
            // Descend into inner functions: merge parent scope, preserve chained parameter references
            if (node !== fn && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
                const nestedScope = collectScope(node);
                const combined = new Set([...scope, ...nestedScope]);
                if (node.body && ts.isBlock(node.body)) {
                    ts.forEachChild(node.body, (child) => checkExternalRef(child, combined));
                } else if (node.body) {
                    checkExternalRef(node.body, combined);
                }
                return;
            }

            if (ts.isIdentifier(node)) {
                const name = node.text;

                // Allow: WriteState
                if (name === "WriteState") return;

                // Allow: module-level function names (whitelist: fn() calls, foo(fn) args, { key: fn } values, onClick={fn}, obj.method)
                if (moduleFnNames.has(name)) {
                    const parent = node.parent;
                    const isCall = parent && ts.isCallExpression(parent);
                    const isPropValue = parent && (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent));
                    const isJsxValue = parent && ts.isJsxExpression(parent);
                    const isPropName = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
                    if (isCall || isPropValue || isJsxValue || isPropName) {
                        return; // Within whitelist, allow
                    }
                    // Not within whitelist
                    ctx.addViolation(
                        "WriteState 规范",
                        `函数 "${name}" 不能当作对象使用`,
                        node,
                    );
                    return;
                }

                // Allow: current-scope parameters / local variables
                if (scope.has(name)) return;

                // Allow: property-access property names (.map, .trim, .name, etc.)
                if (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;

                // Allow: function call target foo(...) (immutable functions only)
                if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
                    // If the call target is a module-level mutable variable (let/var), still report a violation
                    if (moduleNonFnVars.has(name)) {
                        ctx.addViolation(
                            "WriteState 规范",
                            `文件级函数调用了模块级变量 "${name}"，const/let 变量不能作为函数调用`,
                            node,
                        );
                        return;
                    }
                    return;
                }

                // Allow: JSX tags <div>, <span>, </div>
                if (node.parent && (ts.isJsxOpeningElement(node.parent) || ts.isJsxSelfClosingElement(node.parent) || ts.isJsxClosingElement(node.parent))) return;

                // Allow: JSX attribute names
                if (node.parent && ts.isJsxAttribute(node.parent) && node.parent.name === node) return;

                // Allow: type references
                if (node.parent && (ts.isTypeReferenceNode(node.parent) || ts.isTypeQueryNode(node.parent) || ts.isExpressionWithTypeArguments(node.parent))) return;

                // Allow: object literal property names { key: value }
                if (node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;

                // Allow: shorthand property names { key } (the name part)
                if (node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) return;

                // Allow: JS global built-in objects
                const GLOBALS = new Set([
                    "undefined", "null", "true", "false", "NaN", "Infinity", "this",
                    "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
                    "Date", "Math", "JSON", "RegExp", "Map", "Set", "WeakMap", "WeakSet",
                    "Promise", "Error", "TypeError", "SyntaxError", "ReferenceError",
                    "console", "parseInt", "parseFloat", "isNaN", "isFinite", "decodeURI", "encodeURI",
                    // Web API
                    "TextEncoder", "TextDecoder",
                    "fetch", "URL", "URLSearchParams",
                    "Blob", "File", "FileReader", "FormData",
                    "Headers", "Request", "Response",
                    "AbortController", "AbortSignal",
                    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
                    "requestAnimationFrame", "cancelAnimationFrame",
                    "IntersectionObserver", "MutationObserver", "ResizeObserver",
                    "performance", "crypto", "Intl",
                    "structuredClone", "Proxy", "Reflect",
                    "localStorage", "sessionStorage",
                    "location", "navigator", "history",
                ]);
                if (GLOBALS.has(name)) return;

                // Allow: external viewFns (confirmed via cross-file resolution)
                if (ctx.importedViewFns.has(name)) return;

                // Violation: referenced an external variable
                ctx.addViolation(
                    "WriteState 规范",
                    `文件级函数引用了外部变量 "${name}"，所有数据必须通过参数传递`,
                    node,
                );
            }
            ts.forEachChild(node, (child) => checkExternalRef(child, scope));
        }
        checkExternalRef(fn.body);
    }

    // Collect any function's parameters + local variables as its scope
    function collectScope(node: ts.ArrowFunction | ts.FunctionExpression): Set<string> {
        const names = new Set<string>();
        for (const p of node.parameters) {
            collectBindingNames(p.name, names);
        }
        if (node.body && ts.isBlock(node.body)) {
            function collectFromBlock(n: ts.Node) {
                if (ts.isVariableDeclaration(n)) {
                    collectBindingNames(n.name, names);
                }
                ts.forEachChild(n, collectFromBlock);
            }
            collectFromBlock(node.body);
        }
        return names;
    }

    // ════════════════════════════════════════════════════════
    // Rule 4: WriteState must not be exported
    // ════════════════════════════════════════════════════════
    function checkWriteStateExport(node: ts.Node) {
        // export const WriteState = ...
        if (ts.isVariableStatement(node) &&
            node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
            const firstName = node.declarationList.declarations[0]?.name;
            if (firstName && ts.isIdentifier(firstName) && firstName.text === "WriteState") {
                ctx.addViolation(
                    "WriteState 规范",
                    "WriteState 禁止 export，每个文件应有自己独立的作用域",
                    node,
                );
            }
        }

        // export { WriteState }
        if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const spec of node.exportClause.elements) {
                if (spec.name.text === "WriteState") {
                    ctx.addViolation(
                        "WriteState 规范",
                        "WriteState 禁止 export，每个文件应有自己独立的作用域",
                        spec,
                    );
                }
            }
        }

        ts.forEachChild(node, checkWriteStateExport);
    }
    checkWriteStateExport(ctx.sourceFile);

    // ════════════════════════════════════════════════════════
    // Rule 6: View layer forbids onXxx event bindings; must go through renderFn
    // ════════════════════════════════════════════════════════
    if (bodyNode) {
        function checkViewEvents(node: ts.Node) {
            // JSX element: check onXxx attributes
            if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
                const opening = ts.isJsxElement(node) ? node.openingElement : node;
                for (const attr of opening.attributes.properties) {
                    if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && /^on[A-Z]/.test(attr.name.text)) {
                        ctx.addViolation(
                            "WriteState 规范",
                            `View 层不能有 onXxx 事件绑定（这里是 on${attr.name.text.substring(2)}），应通过 renderFn 实现`,
                            attr,
                        );
                    }
                }
                if (ts.isJsxElement(node)) {
                    for (const child of node.children) {
                        checkViewEvents(child);
                    }
                }
                return;
            }

            // JSX expression { ... }: skip render() calls, continue checking the rest
            if (ts.isJsxExpression(node)) {
                const expr = node.expression;
                if (expr && ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "render") {
                    return; // The JSX inside render() is managed by renderFn itself
                }
            }

            ts.forEachChild(node, checkViewEvents);
        }

        // Start walking from the return statement's expression
        for (const stmt of bodyNode.statements) {
            if (ts.isReturnStatement(stmt) && stmt.expression) {
                checkViewEvents(stmt.expression);
            }
        }
    }

    // ════════════════════════════════════════════════════════
    // Rule 7: Forbid declaring a local render function; it must be imported from core/dep
    // ════════════════════════════════════════════════════════
    for (const stmt of ctx.sourceFile.statements) {
        // function render(...) {}
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.name.text === "render") {
            ctx.addViolation(
                "WriteState 规范",
                "禁止本地声明 render 函数，render 必须从核心模块导入",
                stmt,
            );
        }
        // const render = ... / var render = ...
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.name.text === "render") {
                    ctx.addViolation(
                        "WriteState 规范",
                        "禁止本地声明 render 变量，render 必须从核心模块导入",
                        decl,
                    );
                }
            }
        }
    }
}
