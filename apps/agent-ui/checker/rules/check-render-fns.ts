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
    while (ts.isParenthesizedExpression(expr)) {
        expr = expr.expression;
    }
    return expr;
}

function isRenderFn(node: ts.Node): node is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression {
    if (!ts.isFunctionDeclaration(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
        return false;
    }
    const params = node.parameters;
    if (params.length < 3 || params.length > 5) return false;
    if (!ts.isObjectBindingPattern(params[0].name)) return false;  // state
    if (!ts.isObjectBindingPattern(params[1].name)) return false;  // props
    if (!ts.isObjectBindingPattern(params[2].name) && !ts.isArrayBindingPattern(params[2].name)) return false;  // events
    if (params.length >= 4 && !ts.isIdentifier(params[3].name)) return false;  // ext
    if (params.length === 5 && !ts.isObjectBindingPattern(params[4].name)) return false;  // memo
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

export function checkRenderFns(ctx: RuleContext): void {
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
            const extParamName = node.parameters.length >= 4 && ts.isIdentifier(node.parameters[3].name)
                ? (node.parameters[3].name as ts.Identifier).text
                : undefined;
            const memoParams = node.parameters.length === 5
                ? getBindingNames(node.parameters[4].name as ts.ObjectBindingPattern)
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
                extParamName,
                memoParams,
                rootClassName,
            });
        }
        ts.forEachChild(node, collect);
    }

    collect(ctx.sourceFile);

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

    if (renderFns.length === 0) return;

    // ── 以下为 renderFn 特异检查 ──
    // 调试
    console.log('\n📋 收集到的 renderFn 列表:');
    renderFns.forEach(rf => console.log(`  - ${rf.name}: className="${rf.rootClassName || '无'}"`));
    if (checkClassNames.length > 0) {
        console.log(`🔍 需要检查的 className: ${checkClassNames.join(', ')}\n`);
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
