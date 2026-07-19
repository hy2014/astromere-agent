// checker/rules/check-render-fns.ts
import * as ts from "typescript";
import { RuleContext } from "../types";
import { checkEvents, type RenderFnInfo, getFunctionBody } from "./check-events";
import { checkSlots } from "./check-slots";

function getCheckFns(sourceFile: ts.SourceFile): string[] {
    const text = sourceFile.getFullText();
    const match = text.match(/\/\*\s*@checkFns\s+(.*?)\s*\*\//);
    if (!match) return [];
    return match[1].split(",").map(s => s.trim()).filter(Boolean);
}

function unwrapParenthesized(expr: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)) {
        if (ts.isParenthesizedExpression(expr)) expr = expr.expression;
        else if (ts.isAsExpression(expr)) expr = expr.expression;
        else if (ts.isNonNullExpression(expr)) expr = expr.expression;
        else if (ts.isSatisfiesExpression(expr)) expr = expr.expression;
    }
    return expr;
}

export function isRenderFn(node: ts.Node): node is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression {
    if (!ts.isFunctionDeclaration(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
        return false;
    }
    const params = node.parameters;
    if (params.length < 3 || params.length > 5) return false;
    if (!ts.isObjectBindingPattern(params[0].name)) return false;  // state
    if (!ts.isObjectBindingPattern(params[1].name)) return false;  // props
    if (!ts.isObjectBindingPattern(params[2].name) && !ts.isArrayBindingPattern(params[2].name)) return false;  // events
    if (params.length >= 4 && !ts.isIdentifier(params[3].name) && !ts.isObjectBindingPattern(params[3].name)) return false;  // memo or empty
    if (params.length >= 5 && !ts.isObjectBindingPattern(params[4].name)) return false;  // memo (second slot, 5‑param overload)
    return true;
}

function getBindingNames(pattern: ts.ObjectBindingPattern): string[] {
    const names: string[] = [];
    for (const element of pattern.elements) {
        if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            names.push(element.name.text);
        }
    }
    return names;
}

function getArrayBindingNames(pattern: ts.ArrayBindingPattern): string[] {
    const names: string[] = [];
    for (const element of pattern.elements) {
        if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            names.push(element.name.text);
        }
    }
    return names;
}

function getJSXRootClassName(jsx: ts.JsxElement | ts.JsxSelfClosingElement): string | undefined {
    const opening = ts.isJsxElement(jsx) ? jsx.openingElement : jsx;
    const classNameAttr = opening.attributes.properties.find(
        prop => ts.isJsxAttribute(prop) && prop.name.text === "className"
    ) as ts.JsxAttribute | undefined;

    if (!classNameAttr?.initializer) return undefined;

    if (ts.isStringLiteral(classNameAttr.initializer)) {
        return classNameAttr.initializer.text;
    }

    if (ts.isJsxExpression(classNameAttr.initializer)) {
        const expr = classNameAttr.initializer.expression;
        if (expr && ts.isTemplateExpression(expr)) {
            const head = expr.head.text.trim();
            return head || undefined;
        }
    }

    return undefined;
}

function getRenderFnName(node: ts.Node): string {
    if (ts.isFunctionDeclaration(node) && node.name) {
        return node.name.text;
    }
    if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        return node.parent.name.text;
    }
    if (node.parent && ts.isExportAssignment(node.parent)) {
        return "default";
    }
    return "anonymous";
}

export function checkRenderFns(ctx: RuleContext, viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null): void {
    const checkClassNames = getCheckFns(ctx.sourceFile);

    const renderFns: RenderFnInfo[] = [];

    function collect(node: ts.Node) {
        if (isRenderFn(node)) {
            const name = getRenderFnName(node);

            if (!name.startsWith("render")) {
                ctx.addViolation(
                    "renderFn 命名规范",
                    `renderFn 名称必须以 'render' 开头，当前: "${name}"`,
                    node
                );
            }

            const stateParams = getBindingNames(node.parameters[0].name as ts.ObjectBindingPattern);
            const propsParams = getBindingNames(node.parameters[1].name as ts.ObjectBindingPattern);
            const eventsName = node.parameters[2].name;
            const eventsParams = ts.isObjectBindingPattern(eventsName)
                ? getBindingNames(eventsName)
                : getArrayBindingNames(eventsName as ts.ArrayBindingPattern);
            const memoParams = node.parameters.length >= 4 && ts.isObjectBindingPattern(node.parameters[3].name)
                ? getBindingNames(node.parameters[3].name)
                : node.parameters.length >= 4 && ts.isIdentifier(node.parameters[3].name) && node.parameters[3].name.text === "memo" && node.parameters[3].type && ts.isTypeLiteralNode(node.parameters[3].type)
                ? node.parameters[3].type.members
                    .filter((m): m is ts.PropertySignature & { name: ts.Identifier } => ts.isPropertySignature(m) && ts.isIdentifier(m.name))
                    .map(m => m.name.text)
                : [];

            const body = getFunctionBody(node);
            let rootClassName: string | undefined;
            if (!body) return;

            let jsx: ts.JsxElement | ts.JsxSelfClosingElement | undefined;
            if (ts.isBlock(body)) {
                const returnStmt = body.statements.find(ts.isReturnStatement);
                if (returnStmt?.expression) {
                    const unwrapped = unwrapParenthesized(returnStmt.expression);
                    if (ts.isJsxElement(unwrapped) || ts.isJsxSelfClosingElement(unwrapped)) {
                        jsx = unwrapped;
                    }
                }
            } else if (ts.isJsxElement(body) || ts.isJsxSelfClosingElement(body)) {
                jsx = body;
            } else if (ts.isParenthesizedExpression(body)) {
                const unwrapped = unwrapParenthesized(body);
                if (ts.isJsxElement(unwrapped) || ts.isJsxSelfClosingElement(unwrapped)) {
                    jsx = unwrapped;
                }
            }

            if (jsx) {
                rootClassName = getJSXRootClassName(jsx);
            }

            console.log(`✅ 识别为 renderFn: ${name}, 最外层 className: ${rootClassName || '无'}`);

            renderFns.push({
                name,
                node,
                stateParams,
                propsParams,
                eventsParams,
                memoParams,
                rootClassName,
            });
        }
        ts.forEachChild(node, collect);
    }

    collect(ctx.sourceFile);

    // ════════════════════════════════════════════════════════
    // Rule: forbid const arrow functions / function expressions; must use a function declaration
    // ════════════════════════════════════════════════════════
    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer) {
                    const init = decl.initializer;
                    let isFn = false;
                    // Directly an arrow / function expression
                    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
                        isFn = true;
                    }
                    // useMemo returns a function
                    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "useMemo" && init.arguments.length > 0) {
                        const callback = init.arguments[0];
                        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
                            const body = callback.body;
                            const returnValue = ts.isBlock(body)
                                ? body.statements.filter(ts.isReturnStatement).find(s => s.expression)?.expression
                                : body;
                            if (returnValue && (ts.isArrowFunction(returnValue) || ts.isFunctionExpression(returnValue))) {
                                isFn = true;
                            }
                        }
                    }
                    if (isFn) {
                        ctx.addViolation(
                            "函数声明规范",
                            `"${decl.name.text}" 是函数，应使用 function 声明而不是 const 赋值`,
                            decl,
                        );
                    }
                }
            }
        }
    }

    // ════════════════════════════════════════════════════════
    // Rule: functions returning JSX must conform to the renderFn convention
    // Pure AST static analysis, does not depend on TypeChecker, cannot be bypassed with `: any`
    // ════════════════════════════════════════════════════════

    // ── Helper: determine whether an expression contains JSX ──
    function expressionContainsJSX(expr: ts.Expression): boolean {
        expr = unwrapParenthesized(expr);
        if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) {
            return true;
        }
        // Ternary expression: recursively check both branches
        if (ts.isConditionalExpression(expr)) {
            return expressionContainsJSX(expr.whenTrue) || expressionContainsJSX(expr.whenFalse);
        }
        return false;
    }

    // ── Helper: determine whether the function body returns JSX (without descending into inner functions) ──
    function functionReturnsJSX(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): boolean {
        const body = fn.body;
        if (!body) return false;

        // Arrow function expression body: () => <div/>
        if (!ts.isBlock(body)) {
            return expressionContainsJSX(body);
        }

        // Block body: search all return statements
        let found = false;
        function walk(node: ts.Node) {
            if (found) return;
            // Do not descend into inner functions (they have their own return)
            if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node !== fn) {
                return;
            }
            if (ts.isReturnStatement(node) && node.expression && expressionContainsJSX(node.expression)) {
                found = true;
                return;
            }
            ts.forEachChild(node, walk);
        }
        walk(body);
        return found;
    }

    const renderFnNamesSet = new Set(renderFns.map(rf => rf.name));

    function checkReturnType(node: ts.Node, name?: string) {
        // Skip View components (React components, no renderFn signature needed)
        if (viewFn) {
            if (ts.isFunctionDeclaration(node) && node === viewFn) return;
            if (ts.isVariableDeclaration(node) && node.initializer === viewFn) return;
        }

        // Skip already-recognized renderFn
        if (name && renderFnNamesSet.has(name)) return;

        let fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
        if (ts.isFunctionDeclaration(node)) fn = node;
        else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) fn = node;
        else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
            fn = node.initializer;
            name = name || node.name.text;
        }

        if (!fn || !name) return;

        if (functionReturnsJSX(fn)) {
            ctx.addViolation(
                "renderFn 规范",
                `"${name}" 返回 JSX，应改为符合 renderFn 规范的函数（参数: state, props, events, memo）并通过 render() 调用`,
                fn,
            );
        }
    }

    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt)) {
            checkReturnType(stmt, stmt.name?.text);
        }
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) checkReturnType(decl, decl.name.text);
            }
        }
    }

    // ── Call-site check (executes even if the renderFn is not recognized) ──

    const renderFnNames = new Set(renderFns.map(rf => rf.name));

    // Collect all function names in the file (used to validate events references)
    const knownFnNames = new Set(renderFnNames);
    function collectFnNames(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) && node.name) {
            knownFnNames.add(node.name.text);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const init = node.initializer;
            if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                knownFnNames.add(node.name.text);
            }
        }
        ts.forEachChild(node, collectFnNames);
    }
    collectFnNames(ctx.sourceFile);

    // renderFn direct-call check
    function checkDirectRenderFnCall(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isIdentifier(callee) && renderFnNames.has(callee.text)) {
                ctx.addViolation(
                    "renderFn 调用规范",
                    `renderFn "${callee.text}" 应通过 render() 调用，而不是直接函数调用`,
                    node
                );
            }
        }
        ts.forEachChild(node, checkDirectRenderFnCall);
    }
    checkDirectRenderFnCall(ctx.sourceFile);

    // render() fn reference validation
    function checkRenderFnRef(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const renderRef = (ts.isIdentifier(callee) && callee.text === "render") ||
                (ts.isPropertyAccessExpression(callee) && callee.name.text === "render");
            if (renderRef && node.arguments.length >= 1) {
                const firstArg = node.arguments[0];
                if (ts.isObjectLiteralExpression(firstArg)) {
                    for (const prop of firstArg.properties) {
                        if (ts.isPropertyAssignment(prop) &&
                            ts.isIdentifier(prop.name) && prop.name.text === "fn") {
                            const fnValue = prop.initializer;
                            if (fnValue && ts.isIdentifier(fnValue) && !renderFnNames.has(fnValue.text)) {
                                ctx.addViolation(
                                    "renderFn 调用规范",
                                    `render() 的 fn 参数引用了未定义的 renderFn "${fnValue.text}"`,
                                    prop
                                );
                            }
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, checkRenderFnRef);
    }
    checkRenderFnRef(ctx.sourceFile);

    // render() events config check
    function checkEventsConfig(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const renderRef = (ts.isIdentifier(callee) && callee.text === "render") ||
                (ts.isPropertyAccessExpression(callee) && callee.name.text === "render");
            if (renderRef && node.arguments.length >= 1) {
                const firstArg = node.arguments[0];
                if (ts.isObjectLiteralExpression(firstArg)) {
                    for (const prop of firstArg.properties) {
                        if (ts.isPropertyAssignment(prop) &&
                            ts.isIdentifier(prop.name) && prop.name.text === "events") {
                            const eventsValue = prop.initializer;
                            if (eventsValue && ts.isObjectLiteralExpression(eventsValue)) {
                                for (const eventProp of eventsValue.properties) {
                                    if (ts.isPropertyAssignment(eventProp) && ts.isIdentifier(eventProp.name)) {
                                        const eventHandler = eventProp.initializer;
                                        if (!eventHandler) continue;
                                        if (ts.isArrowFunction(eventHandler) || ts.isFunctionExpression(eventHandler)) {
                                            ctx.addViolation(
                                                "renderFn 调用规范",
                                                `render() 的 events.${eventProp.name.text} 不能是内联函数，应引用已定义的具名函数`,
                                                eventProp
                                            );
                                        } else if (ts.isIdentifier(eventHandler) && !knownFnNames.has(eventHandler.text)) {
                                            ctx.addViolation(
                                                "renderFn 调用规范",
                                                `render() 的 events.${eventProp.name.text} 引用了未定义的函数 "${eventHandler.text}"`,
                                                eventProp
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, checkEventsConfig);
    }
    checkEventsConfig(ctx.sourceFile);

    // ════════════════════════════════════════════════════════
    // Rule: render()'s state/props/events/memo must be a subset of the caller's
    // Layered check: when renderFn1 calls renderFn2, passed values must exist in renderFn1's corresponding parameters
    // ════════════════════════════════════════════════════════
    function checkRenderSlotSubsets(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const isRender = (ts.isIdentifier(callee) && callee.text === "render") ||
                (ts.isPropertyAccessExpression(callee) && callee.name.text === "render");
            if (!isRender || node.arguments.length < 1) { ts.forEachChild(node, checkRenderSlotSubsets); return; }

            const arg0 = node.arguments[0];
            if (!arg0 || !ts.isObjectLiteralExpression(arg0)) { ts.forEachChild(node, checkRenderSlotSubsets); return; }

            // Find the caller (walk up to the nearest function declaration)
            let callingFn: ts.Node | null = null;
            let cur: ts.Node | undefined = node.parent;
            while (cur) {
                if (ts.isFunctionDeclaration(cur) || ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
                    callingFn = cur;
                    break;
                }
                cur = cur.parent;
            }

            const inRenderFn = callingFn ? isRenderFn(callingFn) : false;

            // Get the available keys for each slot of the caller
            let callerStateKeys: Set<string>;
            let callerPropsKeys: Set<string>;
            let callerEventsKeys: Set<string>;
            let callerMemoKeys: Set<string>;

            if (inRenderFn && callingFn) {
                const params = (callingFn as ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression).parameters;
                callerStateKeys = new Set(
                    params.length >= 1 && ts.isObjectBindingPattern(params[0].name)
                        ? getBindingNames(params[0].name) : []
                );
                callerPropsKeys = new Set(
                    params.length >= 2 && ts.isObjectBindingPattern(params[1].name)
                        ? getBindingNames(params[1].name) : []
                );
                callerEventsKeys = new Set(
                    params.length >= 3 && ts.isObjectBindingPattern(params[2].name)
                        ? getBindingNames(params[2].name)
                        : params.length >= 3 && ts.isArrayBindingPattern(params[2].name)
                            ? getArrayBindingNames(params[2].name as ts.ArrayBindingPattern) : []
                );
                callerMemoKeys = new Set(
                    params.length >= 4 && ts.isObjectBindingPattern(params[3].name)
                        ? getBindingNames(params[3].name) : []
                );
            } else {
                // View layer: do not restrict events source, only validate state/props/memo
                callerStateKeys = ctx.stateVars;
                callerPropsKeys = ctx.propVars;
                callerEventsKeys = new Set<string>(); // Empty set = do not validate events
                callerMemoKeys = ctx.memoVars;
            }

            const slotMap: Record<string, Set<string>> = {
                state: callerStateKeys,
                props: callerPropsKeys,
                events: callerEventsKeys,
                memo: callerMemoKeys,
            };

            for (const [slotName, callerKeys] of Object.entries(slotMap)) {
                if (callerKeys.size === 0 && slotName === "events") continue; // View layer: events not validated
                const slotProp = arg0.properties.find(
                    p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === slotName
                ) as ts.PropertyAssignment | undefined;
                if (!slotProp) continue;

                const slotObj = unwrapParenthesized(slotProp.initializer);
                if (!slotObj) continue;

                // All slot values must be in the destructured format { key } or { key: value }
                if (!ts.isObjectLiteralExpression(slotObj)) {
                    ctx.addViolation(
                        "render 子集检查",
                        `render() 的 ${slotName} 必须是对象字面量 { ... }，收到了 "${slotObj.getText()}"`,
                        slotProp
                    );
                    continue;
                }

                for (const prop of slotObj.properties) {
                    let key: string | undefined;
                    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                        key = prop.name.text;
                    } else if (ts.isShorthandPropertyAssignment(prop)) {
                        key = prop.name.text;
                    } else if (ts.isSpreadAssignment(prop)) {
                        ctx.addViolation(
                            "render 子集检查",
                            `render() 的 ${slotName} 中不允许使用 spread（...），破坏 slot 键级追踪`,
                            prop
                        );
                        continue;
                    }
                    if (key && !callerKeys.has(key)) {
                        ctx.addViolation(
                            "render 子集检查",
                            `render() 的 ${slotName} 中 "${key}" 未在调用方的 ${slotName} 参数中声明`,
                            prop
                        );
                    }
                }
            }
        }
        ts.forEachChild(node, checkRenderSlotSubsets);
    }
    checkRenderSlotSubsets(ctx.sourceFile);

    if (renderFns.length === 0) return;

    // ── The following are renderFn-specific checks ──
    // Debug
    console.log('\n📋 收集到的 renderFn 列表:');
    renderFns.forEach(rf => console.log(`  - ${rf.name}: className="${rf.rootClassName || '无'}"`));
    if (checkClassNames.length > 0) {
        console.log(`🔍 需要检查的 className: ${checkClassNames.join(', ')}\n`);
    } else if (renderFns.length > 0) {
        // Has renderFn but missing @checkFns annotation
        ctx.addViolation(
            "renderFn 注解检查",
            `文件缺少 /* @checkFns ... */ 注解。\n` +
            `请先思考这个 View 需要哪些子 renderFn 组件，然后将它们根元素的 className 列到文件头部的 @checkFns 中。\n` +
            `例如：/* @checkFns mcp-clean-env-row, mcp-clean-table, mcp-clean-edit-card */`,
            ctx.sourceFile,
        );
    }

    // ── @checkFns className matching ──
    if (checkClassNames.length > 0) {
        for (const cn of checkClassNames) {
            const matched = renderFns.filter(rf =>
                rf.rootClassName?.split(/\s+/).includes(cn)
            );
            if (matched.length === 0) {
                ctx.addViolation(
                    "renderFn 检查",
                    `className "${cn}" 未出现在任何 renderFn 的最外层元素上。`,
                    ctx.sourceFile
                );
            } else if (matched.length > 1) {
                ctx.addViolation(
                    "renderFn 检查",
                    `className "${cn}" 出现在多个 renderFn 的最外层：${matched.map(r => r.name).join(", ")}。`,
                    matched[0].node
                );
            }
        }

    }

    // ── The following are renderFn-specific checks ──

    // Hooks are forbidden inside renderFn
    const FORBIDDEN_HOOKS = ["useState", "useEffect", "useLayoutEffect", "useRef", "useContext",
        "useImperativeHandle", "useInsertionEffect", "useDebugValue", "useDeferredValue",
        "useTransition", "useSyncExternalStore", "useOptimistic", "useActionState"];
    for (const rf of renderFns) {
        function checkHooks(node: ts.Node) {
            if (ts.isCallExpression(node)) {
                const callee = node.expression;
                if (ts.isIdentifier(callee) && FORBIDDEN_HOOKS.includes(callee.text)) {
                    ctx.addViolation(
                        "renderFn 规范",
                        `renderFn "${rf.name}" 内部禁止使用 ${callee.text}()，renderFn 不是 React 组件`,
                        node
                    );
                }
            }
            ts.forEachChild(node, checkHooks);
        }
        checkHooks(rf.node);
    }

    // ── Sub-rules ──
    checkSlots(ctx, renderFns);
    checkEvents(ctx, renderFns);
}
