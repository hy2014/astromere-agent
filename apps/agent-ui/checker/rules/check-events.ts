// checker/rules/check-events.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

export interface RenderFnInfo {
    name: string;
    node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
    stateParams: string[];
    propsParams: string[];
    eventsParams: string[];
    extParamName?: string;
    memoParams: string[];
    rootClassName?: string;
}

export function getFunctionBody(node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): ts.Block | ts.Expression | undefined {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        return node.body;
    }
    return (node as ts.FunctionDeclaration).body;
}

function isIdentifierUsed(scope: ts.Node, name: string): boolean {
    let used = false;
    function visit(n: ts.Node) {
        if (ts.isIdentifier(n) && n.text === name) {
            if (!(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
                used = true;
                return;
            }
        }
        ts.forEachChild(n, visit);
    }
    visit(scope);
    return used;
}

function hasChildRenderCall(body: ts.Node): boolean {
    let found = false;
    function visit(n: ts.Node) {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "render") {
            for (const arg of n.arguments) {
                if (ts.isObjectLiteralExpression(arg)) {
                    for (const prop of arg.properties) {
                        if (ts.isPropertyAssignment(prop) &&
                            ts.isIdentifier(prop.name) &&
                            prop.name.text === "fn") {
                            found = true;
                            return;
                        }
                    }
                }
            }
        }
        ts.forEachChild(n, visit);
    }
    visit(body);
    return found;
}

export function checkEvents(ctx: RuleContext, renderFns: RenderFnInfo[]): void {
    for (const rf of renderFns) {
        const body = getFunctionBody(rf.node);
        if (!body) continue;

        const eventNames = new Set(rf.eventsParams);

        // ── 规则 1：onXxx 绑定必须是 events 中解构的标识符 ──
        // 允许：
        //   onClick={handleClick}           — 直接引用
        //   onClick={(e) => handleClick(a)} — 单行参数适配
        function checkEventBindingStyle(node: ts.Node) {
            ts.forEachChild(node, (n) => {
                if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && /^on[A-Z]/.test(n.name.text)) {
                    const init = n.initializer;
                    if (init && ts.isJsxExpression(init) && init.expression) {
                        const expr = init.expression;

                        // 直接引用：onClick={handleClick}
                        if (ts.isIdentifier(expr) && eventNames.has(expr.text)) {
                            return;
                        }

                        // 箭头适配：onClick={(e) => handleClick(a, b)}
                        if (ts.isArrowFunction(expr)) {
                            const arrowBody = expr.body;
                            if (ts.isCallExpression(arrowBody)) {
                                const callee = arrowBody.expression;
                                if (ts.isIdentifier(callee) && eventNames.has(callee.text)) {
                                    return;
                                }
                            }
                            ctx.addViolation(
                                "事件绑定规范",
                                `on${n.name.text.substring(2)} 箭头函数体内必须只调用一个 events 中解构的函数`,
                                n
                            );
                            return;
                        }

                        if (ts.isIdentifier(expr)) {
                            ctx.addViolation(
                                "事件绑定规范",
                                `on${n.name.text.substring(2)} 绑定了 "${expr.text}"，但该变量不在 events 解构中 (events: [${rf.eventsParams.join(", ")}])`,
                                n
                            );
                        } else if (!ts.isArrowFunction(expr)) {
                            ctx.addViolation(
                                "事件绑定规范",
                                `on${n.name.text.substring(2)} 必须是 events 中解构的标识符或 (e) => handler(...) 形式`,
                                n
                            );
                        }
                    }
                }
                checkEventBindingStyle(n);
            });
        }
        checkEventBindingStyle(body);

        // ── 规则 2：events 一致性 ──
        const usedEvents = new Set<string>();
        function collectUsed(node: ts.Node) {
            if (ts.isIdentifier(node) && eventNames.has(node.text)) {
                // 排除属性访问 obj.xxx 中的标识符
                if (!(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
                    usedEvents.add(node.text);
                }
            }
            ts.forEachChild(node, collectUsed);
        }
        collectUsed(body);

        const hasChild = hasChildRenderCall(body);

        if (!hasChild) {
            // 收集绑定了的事件（直接引用或箭头适配）
            const boundEvents = new Set<string>();
            function collectBound(node: ts.Node) {
                if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && /^on[A-Z]/.test(node.name.text)) {
                    const init = node.initializer;
                    if (init && ts.isJsxExpression(init) && init.expression) {
                        const expr = init.expression;
                        if (ts.isIdentifier(expr) && eventNames.has(expr.text)) {
                            boundEvents.add(expr.text);
                        }
                        if (ts.isArrowFunction(expr)) {
                            const arrowBody = expr.body;
                            if (ts.isCallExpression(arrowBody)) {
                                const callee = arrowBody.expression;
                                if (ts.isIdentifier(callee) && eventNames.has(callee.text)) {
                                    boundEvents.add(callee.text);
                                }
                            }
                        }
                    }
                }
                ts.forEachChild(node, collectBound);
            }
            collectBound(body);

            const onlyUsed = [...usedEvents].filter(e => !boundEvents.has(e));
            const onlyBound = [...boundEvents].filter(e => !usedEvents.has(e));
            if (onlyUsed.length > 0 || onlyBound.length > 0) {
                ctx.addViolation(
                    "renderFn 事件一致性",
                    `renderFn "${rf.name}" 事件不一致：` +
                    (onlyUsed.length ? `events 中多余: ${onlyUsed.join(", ")}；` : "") +
                    (onlyBound.length ? `绑定了事件但 events 未声明: ${onlyBound.join(", ")}` : ""),
                    rf.node
                );
            }
        } else {
            const boundEvents2 = new Set<string>();
            function collectBound2(node: ts.Node) {
                if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && /^on[A-Z]/.test(node.name.text)) {
                    const init = node.initializer;
                    if (init && ts.isJsxExpression(init) && init.expression) {
                        const expr = init.expression;
                        if (ts.isIdentifier(expr) && eventNames.has(expr.text)) {
                            boundEvents2.add(expr.text);
                        }
                        if (ts.isArrowFunction(expr)) {
                            const arrowBody = expr.body;
                            if (ts.isCallExpression(arrowBody)) {
                                const callee = arrowBody.expression;
                                if (ts.isIdentifier(callee) && eventNames.has(callee.text)) {
                                    boundEvents2.add(callee.text);
                                }
                            }
                        }
                    }
                }
                ts.forEachChild(node, collectBound2);
            }
            collectBound2(body);

            const missing = [...boundEvents2].filter(e => !usedEvents.has(e));
            if (missing.length > 0) {
                ctx.addViolation(
                    "renderFn 事件缺失",
                    `renderFn "${rf.name}" 绑定了事件 ${missing.join(", ")}，但 events 参数中未包含这些属性。`,
                    rf.node
                );
            }
        }

        // ── 规则 3：未使用的 events ──
        const unusedEvents = rf.eventsParams.filter(e => !isIdentifierUsed(body, e));
        if (unusedEvents.length > 0) {
            ctx.addViolation(
                "renderFn 未使用 events",
                `renderFn "${rf.name}" 中 events 变量未使用: ${unusedEvents.join(", ")}`,
                rf.node
            );
        }

        // ── 规则 4：子 render() 调用的 events 必须是当前 events 的子集 ──
        function checkChildRenderEvents(node: ts.Node) {
            if (ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "render") {

                const arg0 = node.arguments[0];
                if (!arg0 || !ts.isObjectLiteralExpression(arg0)) return;

                const eventsProp = arg0.properties.find(
                    p => ts.isPropertyAssignment(p) &&
                        ts.isIdentifier(p.name) &&
                        p.name.text === "events"
                ) as ts.PropertyAssignment | undefined;
                if (!eventsProp) return;

                const eventsObj = eventsProp.initializer;
                if (!eventsObj || !ts.isObjectLiteralExpression(eventsObj)) return;

                for (const prop of eventsObj.properties) {
                    // 规则 4：子集检查 — 每个 events 变量必须在当前 renderFn 的 events 参数中
                    // 只检查简写属性 { a, b }，非简写 { a: xxx } 由规则 5 负责
                    if (!ts.isShorthandPropertyAssignment(prop)) continue;
                    const varName = prop.name.text;
                    if (!eventNames.has(varName)) {
                        ctx.addViolation(
                            "renderFn 事件传递",
                            `renderFn "${rf.name}" 传给子 render() 的 events 中引用了 "${varName}"，但该变量不在当前 renderFn 的 events 参数中 (events: [${rf.eventsParams.join(", ")}])`,
                            prop
                        );
                    }
            }
            ts.forEachChild(node, checkChildRenderEvents);
        }
        checkChildRenderEvents(body);
    }  // end checkChildRenderEvents
    }  // end for (const rf of renderFns)

    // ── 规则 5：所有 render() 调用的 events 属性必须使用简写形式 ──
    // 允许：events: { a, b, c }      简写
    // 禁止：events: { a: xxx }       显式映射
    function checkEventsShorthand(node: ts.Node) {
        if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "render") {

            const arg0 = node.arguments[0];
            if (!arg0 || !ts.isObjectLiteralExpression(arg0)) { return; }

            const eventsProp = arg0.properties.find(
                p => ts.isPropertyAssignment(p) &&
                    ts.isIdentifier(p.name) &&
                    p.name.text === "events"
            ) as ts.PropertyAssignment | undefined;
            if (!eventsProp) return;

            const eventsObj = eventsProp.initializer;
            if (!eventsObj || !ts.isObjectLiteralExpression(eventsObj)) return;

            for (const prop of eventsObj.properties) {
                if (ts.isShorthandPropertyAssignment(prop)) continue;
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                    ctx.addViolation(
                        "事件绑定规范",
                        `render() 的 events 属性 "${prop.name.text}" 使用了显式映射，只允许简写形式 events: { ${prop.name.text}, ... }。`,
                        prop
                    );
                }
            }
        }

        ts.forEachChild(node, checkEventsShorthand);
    }
    checkEventsShorthand(ctx.sourceFile);
}
