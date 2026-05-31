// checker/rules/check-render-fns.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

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
    if (params.length < 3 || params.length > 4) return false;
    if (!ts.isObjectBindingPattern(params[0].name)) return false;
    if (!ts.isObjectBindingPattern(params[1].name)) return false;
    if (!ts.isIdentifier(params[2].name)) return false;
    if (params.length === 4 && !ts.isIdentifier(params[3].name)) return false;
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

function getFunctionBody(node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): ts.Block | ts.Expression | undefined {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        return node.body;
    }
    return (node as ts.FunctionDeclaration).body;
}

function getJSXRootClassName(jsx: ts.JsxElement | ts.JsxSelfClosingElement): string | undefined {
    const opening = ts.isJsxElement(jsx) ? jsx.openingElement : jsx;
    const classNameAttr = opening.attributes.properties.find(
        prop => ts.isJsxAttribute(prop) && prop.name.text === "className"
    ) as ts.JsxAttribute | undefined;
    if (classNameAttr?.initializer && ts.isStringLiteral(classNameAttr.initializer)) {
        return classNameAttr.initializer.text;
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

function collectMemberAccesses(root: ts.Node, objName: string): Set<string> {
    const accesses = new Set<string>();
    function visit(n: ts.Node) {
        if (ts.isPropertyAccessExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === objName &&
            ts.isIdentifier(n.name)) {
            accesses.add(n.name.text);
        }
        ts.forEachChild(n, visit);
    }
    visit(root);
    return accesses;
}

function collectBoundEvents(root: ts.Node, eventsParamName: string): Set<string> {
    const bound = new Set<string>();
    function visit(n: ts.Node) {
        if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && /^on[A-Z]/.test(n.name.text)) {
            const init = n.initializer;
            if (init && ts.isJsxExpression(init) && init.expression) {
                const expr = init.expression;
                if (ts.isPropertyAccessExpression(expr) &&
                    ts.isIdentifier(expr.expression) &&
                    expr.expression.text === eventsParamName &&
                    ts.isIdentifier(expr.name)) {
                    bound.add(expr.name.text);
                }
            }
        }
        ts.forEachChild(n, visit);
    }
    visit(root);
    return bound;
}

function hasChildRenderCall(body: ts.Node): boolean {
    let found = false;
    function visit(n: ts.Node) {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text.startsWith("render")) {
            found = true;
            return;
        }
        ts.forEachChild(n, visit);
    }
    visit(body);
    return found;
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

export function checkRenderFns(ctx: RuleContext): void {
    const checkClassNames = getCheckFns(ctx.sourceFile);
    if (checkClassNames.length === 0) return;

    interface RenderFnInfo {
        name: string;
        node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
        stateParams: string[];
        propsParams: string[];
        eventsParamName: string;
        extParamName?: string;
        rootClassName?: string;
    }

    const renderFns: RenderFnInfo[] = [];

    function collect(node: ts.Node) {
        if (isRenderFn(node)) {
            const name = getRenderFnName(node);
            const stateParams = getBindingNames(node.parameters[0].name as ts.ObjectBindingPattern);
            const propsParams = getBindingNames(node.parameters[1].name as ts.ObjectBindingPattern);
            const eventsParam = node.parameters[2].name as ts.Identifier;
            const extParamName = node.parameters.length === 4 && ts.isIdentifier(node.parameters[3].name)
                ? (node.parameters[3].name as ts.Identifier).text
                : undefined;

            const body = getFunctionBody(node);
            let rootClassName: string | undefined;
            if (!body) {
                console.log('❌ body 为空');
            } else {
                console.log('body 类型:', ts.SyntaxKind[body.kind]);

                let jsx: ts.JsxElement | ts.JsxSelfClosingElement | undefined;
                if (ts.isBlock(body)) {
                    console.log('  Block 语句数量:', body.statements.length);
                    body.statements.forEach((stmt, i) => {
                        console.log(`  语句${i}: ${ts.SyntaxKind[stmt.kind]}`);
                    });
                    const returnStmt = body.statements.find(ts.isReturnStatement);
                    console.log('  找到 return 语句:', !!returnStmt);
                    if (returnStmt) {
                        console.log('  return.expression 类型:', returnStmt.expression ? ts.SyntaxKind[returnStmt.expression.kind] : '无');

                        if (returnStmt?.expression) {
                            const unwrapped = unwrapParenthesized(returnStmt.expression);
                            if (ts.isJsxElement(unwrapped) || ts.isJsxSelfClosingElement(unwrapped)) {
                                jsx = unwrapped;
                            }
                            console.log('  ✅ 拿到 JSX');
                        } else {
                            console.log('  ❌ return 的不是 JSX');
                        }

                        if (returnStmt?.expression && (ts.isJsxElement(returnStmt.expression) || ts.isJsxSelfClosingElement(returnStmt.expression))) {
                            jsx = returnStmt.expression;
                        }
                    }
                } else if (ts.isJsxElement(body) || ts.isJsxSelfClosingElement(body)) {
                    jsx = body;
                    console.log('  ✅ body 本身是 JSX');
                } else if (ts.isParenthesizedExpression(body)) {
                    const unwrapped = unwrapParenthesized(body);
                    if (ts.isJsxElement(unwrapped) || ts.isJsxSelfClosingElement(unwrapped)) {
                        jsx = unwrapped;
                    }
                }

                if (jsx) {
                    const tagName = ts.isJsxElement(jsx) ? jsx.openingElement.tagName.getText() : jsx.tagName.getText();
                    console.log('  JSX 标签:', tagName);
                    rootClassName = getJSXRootClassName(jsx);
                    console.log('  提取的 className:', rootClassName);
                }
            }

            // 调试日志：安全打印
            console.log(`✅ 识别为 renderFn: ${name}, 最外层 className: ${rootClassName || '无'}`);

            renderFns.push({
                name,
                node,
                stateParams,
                propsParams,
                eventsParamName: eventsParam.text,
                extParamName,
                rootClassName,
            });
        }
        ts.forEachChild(node, collect);
    }

    collect(ctx.sourceFile);

    // 调试：列出所有收集到的 renderFn
    console.log('\n📋 收集到的 renderFn 列表:');
    renderFns.forEach(rf => console.log(`  - ${rf.name}: className="${rf.rootClassName}"`));
    console.log(`🔍 需要检查的 className: ${checkClassNames.join(', ')}\n`);

    // 针对每个配置的 className 检查
    for (const cn of checkClassNames) {
        const matched = renderFns.filter(rf => rf.rootClassName === cn);

        if (matched.length === 0) {
            ctx.addViolation(
                "renderFn 检查",
                `className "${cn}" 未出现在任何 renderFn 的最外层元素上。`,
                ctx.sourceFile
            );
            continue;
        }

        if (matched.length > 1) {
            ctx.addViolation(
                "renderFn 检查",
                `className "${cn}" 出现在多个 renderFn 的最外层：${matched.map(r => r.name).join(", ")}。`,
                matched[0].node
            );
            continue;
        }

        const renderFn = matched[0];
        const body = getFunctionBody(renderFn.node);
        if (!body) continue;

        // 检查 onXxx 绑定必须是 events.xxx
        function checkEventBindingStyle(node: ts.Node) {
            ts.forEachChild(node, (n) => {
                if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && /^on[A-Z]/.test(n.name.text)) {
                    const init = n.initializer;
                    if (init && ts.isJsxExpression(init) && init.expression) {
                        if (!ts.isPropertyAccessExpression(init.expression) ||
                            !ts.isIdentifier(init.expression.expression) ||
                            init.expression.expression.text !== renderFn.eventsParamName) {
                            ctx.addViolation(
                                "事件绑定规范",
                                `on${n.name.text.substring(2)} 必须绑定为 events.xxx 形式`,
                                n
                            );
                        }
                    }
                }
                checkEventBindingStyle(n);
            });
        }
        checkEventBindingStyle(body);

        const eventsParam = renderFn.eventsParamName;
        const boundEvents = collectBoundEvents(body, eventsParam);
        const usedEvents = collectMemberAccesses(body, eventsParam);
        const hasChild = hasChildRenderCall(body);

        if (!hasChild) {
            const onlyUsed = [...usedEvents].filter(e => !boundEvents.has(e));
            const onlyBound = [...boundEvents].filter(e => !usedEvents.has(e));
            if (onlyUsed.length > 0 || onlyBound.length > 0) {
                ctx.addViolation(
                    "renderFn 事件一致性",
                    `renderFn "${renderFn.name}" 事件不一致：` +
                    (onlyUsed.length ? `events 中多余: ${onlyUsed.join(", ")}；` : "") +
                    (onlyBound.length ? `绑定了事件但 events 未声明: ${onlyBound.join(", ")}` : ""),
                    renderFn.node
                );
            }
        } else {
            const missing = [...boundEvents].filter(e => !usedEvents.has(e));
            if (missing.length > 0) {
                ctx.addViolation(
                    "renderFn 事件缺失",
                    `renderFn "${renderFn.name}" 绑定了事件 ${missing.join(", ")}，但 events 参数中未包含这些属性。`,
                    renderFn.node
                );
            }
        }

        const unusedState = renderFn.stateParams.filter(v => !isIdentifierUsed(body, v));
        const unusedProps = renderFn.propsParams.filter(v => !isIdentifierUsed(body, v));

        if (unusedState.length > 0) {
            ctx.addViolation(
                "renderFn 未使用 state",
                `renderFn "${renderFn.name}" 中 state 变量未使用: ${unusedState.join(", ")}`,
                renderFn.node
            );
        }
        if (unusedProps.length > 0) {
            ctx.addViolation(
                "renderFn 未使用 props",
                `renderFn "${renderFn.name}" 中 props 变量未使用: ${unusedProps.join(", ")}`,
                renderFn.node
            );
        }
    }
}

// 新增辅助函数：解开 ParenthesizedExpression
