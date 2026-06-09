// checker/rules/check-write-state.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

/**
 * 收集 View 函数体内 useState 的 setter 名
 * 用于 WriteState 注册检查、useEffect 检查、events/exts 检查
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
 * 检查 useEffect 回调是否足够简单
 * 只允许：() => { void fn(); } 或 () => { fn(); } 或 () => fn()
 */
function isUseEffectCallbackSimple(
    callback: ts.ArrowFunction | ts.FunctionExpression,
    setterNames: Set<string>,
    stateVars: Set<string>,
): { ok: boolean; reason?: string } {
    const body = callback.body;

    // (没有 body) — 不合法
    if (!body) return { ok: false, reason: "useEffect 回调不能为空" };

    // () => expr — 只有一个表达式
    if (!ts.isBlock(body)) {
        // 必须是函数调用
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

    // () => { void fn(); } 或 () => { fn(); }
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
 * 检查 CallExpression 是否引用了 state/setter
 */
function checkCallExpression(
    call: ts.CallExpression,
    setterNames: Set<string>,
    stateVars: Set<string>,
): { ok: boolean; reason?: string } {
    const callee = call.expression;

    // 必须是 Identifier，不能是 WriteState.setXxx
    if (!ts.isIdentifier(callee)) {
        return { ok: false, reason: "useEffect 只能调用文件级函数，不能调用 WriteState 方法或复杂表达式" };
    }

    // 函数名不能是 setter
    if (setterNames.has(callee.text)) {
        return { ok: false, reason: `useEffect 不能直接调用 setter "${callee.text}"` };
    }

    // 检查参数中是否引用了 state
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
    // 规则 1: useState → WriteState.setXxx 注册完整性
    // 每个 useState 的 setter 都必须在 WriteState 中注册
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

            // 规则 1b: WriteState 的值必须是 useState 的 setter 引用
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
    // 规则 2a: View 内禁止定义函数
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

        // const foo = () => {} 或 const foo = function() {}
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;

                // const [x, setX] = useState() — 解构赋值放行
                if (!ts.isIdentifier(decl.name)) continue;
                if (!decl.initializer) continue;

                // 规则 2a: 箭头函数/函数表达式 → 禁止
                if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                    ctx.addViolation(
                        "WriteState 规范",
                        `View 函数内禁止定义函数 "${decl.name.text}"，请移到文件级别`,
                        decl,
                    );
                    continue;
                }

                // 规则 2c: View 内 const 必须是 useMemo / useCallback / useState 之一
                // 其他 hook（useRef、useEffect、useContext 等）同样禁止
                const hookName = ts.isCallExpression(decl.initializer) &&
                    ts.isIdentifier(decl.initializer.expression)
                    ? decl.initializer.expression.text
                    : null;
                if (hookName && (hookName === "useMemo" || hookName === "useCallback")) {
                    continue; // ✅ 允许
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
    // 规则 2b: useEffect 回调必须简单（只调用一个文件级函数）
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
    // 规则 3(全局): WriteState.setXxx 只能调用或赋值，不能作为值传递
    // 允许：
    //   WriteState.setRows(...)          — 直接调用
    //   WriteState.setRows = setRows     — 赋值目标
    // 禁止：
    //   doSomething(WriteState.setRows)  — 传参
    //   const x = WriteState.setRows     — 赋值给变量
    //   { a: WriteState.setRows }        — 放进对象
    // ════════════════════════════════════════════════════════
    function checkWriteStateUsage(node: ts.Node) {
        if (ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "WriteState") {
            const parent = node.parent;

            // 允许：WriteState.setRows(...) — 作为调用目标
            if (parent && ts.isCallExpression(parent) && parent.expression === node) {
                ts.forEachChild(node, checkWriteStateUsage);
                return;
            }

            // 允许：WriteState.setRows = setRows — 作为赋值目标
            if (parent && ts.isBinaryExpression(parent) &&
                parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                parent.left === node) {
                ts.forEachChild(node, checkWriteStateUsage);
                return;
            }

            // 其他所有用法都是违规
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
    // 规则 3b: render() 的 events/exts 禁止原始 setter 引用
    // （WriteState.setXxx 已被规则 3 全局覆盖，这里只检原始 setter）
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
                    // 简写: { setRows }
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

                    // 显式: { key: setRows }
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
    // 规则 5: 文件级函数体禁止引用外部变量
    // 允许：参数、局部变量、WriteState、函数调用(callee)、JSX 标签
    // ════════════════════════════════════════════════════════

    // 递归收集 binding pattern 中的变量名（处理解构）
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

    // 收集当前函数的参数名（包括解构） + 局部变量名
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

    // 收集模块级函数名（允许被引用）
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

    // 收集模块级非函数变量（let / var / const 非函数），这些不能作为调用目标
    const moduleNonFnVars = new Set<string>();
    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) {
                    const init = decl.initializer;
                    // 跳过函数表达式 const fn = () => {} (已被 check-render-fns 禁止)
                    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
                    // 跳过 useCallback/useMemo 包装
                    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) &&
                        (init.expression.text === "useCallback" || init.expression.text === "useMemo")) continue;
                    moduleNonFnVars.add(decl.name.text);
                }
            }
        }
    }

    // 扫描文件级函数（不包括 View）
    for (const stmt of ctx.sourceFile.statements) {
        let fn: ts.FunctionDeclaration | ts.ArrowFunction | undefined;
        let fnName: string | undefined;

        // function foo() {}
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
            fnName = stmt.name.text;
            if (fnName === viewFnName) continue; // 跳过 View
            fn = stmt;
        }

        // const foo = () => {} / function() {}
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (!decl.initializer) continue;
                if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                    // 跳过 View 箭头函数
                    if (ts.isArrowFunction(viewFn) && viewFn === decl.initializer) continue;
                    fn = decl.initializer as ts.ArrowFunction;
                    if (ts.isIdentifier(decl.name)) fnName = decl.name.text;
                }
            }
        }

        if (!fn || !fn.body || !ts.isBlock(fn.body)) continue;

        const localNames = collectLocalNames(fn);

        function checkExternalRef(node: ts.Node, scope: Set<string> = localNames) {
            // 穿透到内层函数：合并父级作用域，保留链式参数引用
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

                // 放行：WriteState
                if (name === "WriteState") return;

                // 放行：模块级函数名（白名单：fn() 调用、foo(fn) 传参、{ key: fn } 值、onClick={fn}、obj.method）
                if (moduleFnNames.has(name)) {
                    const parent = node.parent;
                    const isCall = parent && ts.isCallExpression(parent);
                    const isPropValue = parent && (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent));
                    const isJsxValue = parent && ts.isJsxExpression(parent);
                    const isPropName = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
                    if (isCall || isPropValue || isJsxValue || isPropName) {
                        return; // 白名单内，放行
                    }
                    // 不在白名单内
                    ctx.addViolation(
                        "WriteState 规范",
                        `函数 "${name}" 不能当作对象使用`,
                        node,
                    );
                    return;
                }

                // 放行：当前作用域的参数 / 局部变量
                if (scope.has(name)) return;

                // 放行：属性访问的 property 名（.map, .trim, .name 等）
                if (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;

                // 放行：函数调用目标 foo(...)（仅限不可变函数）
                if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
                    // 如果调用的目标是模块级 mutable 变量（let/var），仍然报违规
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

                // 放行：JSX 标签 <div>, <span>, </div>
                if (node.parent && (ts.isJsxOpeningElement(node.parent) || ts.isJsxSelfClosingElement(node.parent) || ts.isJsxClosingElement(node.parent))) return;

                // 放行：JSX 属性名
                if (node.parent && ts.isJsxAttribute(node.parent) && node.parent.name === node) return;

                // 放行：类型引用
                if (node.parent && (ts.isTypeReferenceNode(node.parent) || ts.isTypeQueryNode(node.parent) || ts.isExpressionWithTypeArguments(node.parent))) return;

                // 放行：对象字面量属性名 { key: value }
                if (node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;

                // 放行：简写属性名 { key }（name 部分）
                if (node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) return;

                // 放行：JS 全局内置对象
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

                // 放行：外部 viewFn（经过跨文件解析确认）
                if (ctx.importedViewFns.has(name)) return;

                // 违规：引用了外部变量
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

    // 收集任意函数的参数 + 局部变量作为作用域
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
    // 规则 4: WriteState 禁止 export
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
    // 规则 6: View 层禁止 onXxx 事件绑定，必须通过 renderFn
    // ════════════════════════════════════════════════════════
    if (bodyNode) {
        function checkViewEvents(node: ts.Node) {
            // JSX 元素：检查 onXxx 属性
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

            // JSX 表达式 { ... }: 跳过 render() 调用，继续检查其他
            if (ts.isJsxExpression(node)) {
                const expr = node.expression;
                if (expr && ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "render") {
                    return; // render() 内部的 JSX 由 renderFn 自己管理
                }
            }

            ts.forEachChild(node, checkViewEvents);
        }

        // 从 return 语句的表达式开始遍历
        for (const stmt of bodyNode.statements) {
            if (ts.isReturnStatement(stmt) && stmt.expression) {
                checkViewEvents(stmt.expression);
            }
        }
    }

    // ════════════════════════════════════════════════════════
    // 规则 7: 禁止本地声明 render 函数，必须从 core/dep 导入
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
