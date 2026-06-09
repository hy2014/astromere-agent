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
    // 规则: 禁止 const 箭头函数/函数表达式，必须用 function 声明
    // ════════════════════════════════════════════════════════
    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer) {
                    const init = decl.initializer;
                    let isFn = false;
                    // 直接是箭头/函数表达式
                    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
                        isFn = true;
                    }
                    // useMemo 返回函数
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
    // 规则: 返回 JSX 的函数必须符合 renderFn 规范
    // 纯 AST 静态分析，不依赖 TypeChecker，不被 `: any` 绕过
    // ════════════════════════════════════════════════════════

    // ── Helper: 判断表达式是否包含 JSX ──
    function expressionContainsJSX(expr: ts.Expression): boolean {
        expr = unwrapParenthesized(expr);
        if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) {
            return true;
        }
        // 三元表达式：递归检查两个分支
        if (ts.isConditionalExpression(expr)) {
            return expressionContainsJSX(expr.whenTrue) || expressionContainsJSX(expr.whenFalse);
        }
        return false;
    }

    // ── Helper: 判断函数体是否返回 JSX（不穿透内层函数） ──
    function functionReturnsJSX(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): boolean {
        const body = fn.body;
        if (!body) return false;

        // 箭头函数表达式体: () => <div/>
        if (!ts.isBlock(body)) {
            return expressionContainsJSX(body);
        }

        // 块体：搜索所有 return 语句
        let found = false;
        function walk(node: ts.Node) {
            if (found) return;
            // 不穿透内层函数（它们有自己的 return）
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
        // 跳过 View 组件（React 组件，不需要 renderFn 签名）
        if (viewFn) {
            if (ts.isFunctionDeclaration(node) && node === viewFn) return;
            if (ts.isVariableDeclaration(node) && node.initializer === viewFn) return;
        }

        // 跳过已识别的 renderFn
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

    // ── 调用位置检查（无需 renderFn 被识别也执行） ──

    const renderFnNames = new Set(renderFns.map(rf => rf.name));

    // 收集文件中所有函数名（用于校验 events 引用）
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

    // renderFn 直接调用检查
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

    // render() fn 引用校验
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

    // render() events 配置检查
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
    // 规则: render() 的 state/props/events/memo 必须是调用者的子集
    // 层层检查：renderFn1 调 renderFn2 时，传的值必须在 renderFn1 的对应参数中存在
    // ════════════════════════════════════════════════════════
    function checkRenderSlotSubsets(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const isRender = (ts.isIdentifier(callee) && callee.text === "render") ||
                (ts.isPropertyAccessExpression(callee) && callee.name.text === "render");
            if (!isRender || node.arguments.length < 1) { ts.forEachChild(node, checkRenderSlotSubsets); return; }

            const arg0 = node.arguments[0];
            if (!arg0 || !ts.isObjectLiteralExpression(arg0)) { ts.forEachChild(node, checkRenderSlotSubsets); return; }

            // 找调用者（向上找最近的函数声明）
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

            // 获取调用者的各槽位可用 key
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
                // View 层：不限制 events 来源，只校验 state/props/memo
                callerStateKeys = ctx.stateVars;
                callerPropsKeys = ctx.propVars;
                callerEventsKeys = new Set<string>(); // 空集合 = 不校验 events
                callerMemoKeys = ctx.memoVars;
            }

            const slotMap: Record<string, Set<string>> = {
                state: callerStateKeys,
                props: callerPropsKeys,
                events: callerEventsKeys,
                memo: callerMemoKeys,
            };

            for (const [slotName, callerKeys] of Object.entries(slotMap)) {
                if (callerKeys.size === 0 && slotName === "events") continue; // View 层 events 不校验
                const slotProp = arg0.properties.find(
                    p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === slotName
                ) as ts.PropertyAssignment | undefined;
                if (!slotProp) continue;

                const slotObj = unwrapParenthesized(slotProp.initializer);
                if (!slotObj) continue;

                // 所有 slot 值必须是 { key } 或 { key: value } 解构格式
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

    // ── 以下为 renderFn 特异检查 ──
    // 调试
    console.log('\n📋 收集到的 renderFn 列表:');
    renderFns.forEach(rf => console.log(`  - ${rf.name}: className="${rf.rootClassName || '无'}"`));
    if (checkClassNames.length > 0) {
        console.log(`🔍 需要检查的 className: ${checkClassNames.join(', ')}\n`);
    } else if (renderFns.length > 0) {
        // 有 renderFn 但缺少 @checkFns 注解
        ctx.addViolation(
            "renderFn 注解检查",
            `文件缺少 /* @checkFns ... */ 注解。\n` +
            `请先思考这个 View 需要哪些子 renderFn 组件，然后将它们根元素的 className 列到文件头部的 @checkFns 中。\n` +
            `例如：/* @checkFns mcp-clean-env-row, mcp-clean-table, mcp-clean-edit-card */`,
            ctx.sourceFile,
        );
    }

    // ── @checkFns className 匹配 ──
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

    // ── 以下为 renderFn 特异检查 ──

    // renderFn 内部禁止 hooks
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

    // ── 子规则 ──
    checkSlots(ctx, renderFns);
    checkEvents(ctx, renderFns);
}
