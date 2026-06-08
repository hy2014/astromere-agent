// checker/rules/check-props-flow.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

/**
 * 检查 props 槽中的数据透传浪费：
 *
 * 场景：当前 View 的 props 参数中的某个变量 X，
 * 直接被传递给了 renderFn 的 props 槽，
 * 但 X 在 renderFn 中仅用于 events 回调的参数（不作为渲染/下游传递），
 * 说明 X 不应该走 props 透传，应该由上游 View 用 useCallback 捕获后走 events 槽。
 *
 * 豁免情况：
 *   1. X 在 renderFn 的 JSX 中被用于渲染 → 合法透传
 *   2. X 通过 renderView() 传递给下游 → 合法透传
 */
export function checkPropsFlow(
    ctx: RuleContext,
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
): void {
    if (!viewFn) return;

    const body = ts.isArrowFunction(viewFn)
        ? (viewFn.body as ts.Block | undefined)
        : (viewFn as ts.FunctionDeclaration).body;
    if (!body || !ts.isBlock(body)) return;

    // 在 View body 中递归查找所有 render() 调用
    function findRenderCalls(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isIdentifier(callee) && callee.text === "render") {
                processRenderCall(ctx, node);
            }
        }
        ts.forEachChild(node, findRenderCalls);
    }
    findRenderCalls(body);
}

function processRenderCall(ctx: RuleContext, renderCall: ts.CallExpression): void {
    const arg0 = renderCall.arguments[0];
    if (!arg0 || !ts.isObjectLiteralExpression(arg0)) return;

    // 找到 props 槽
    const propsProp = arg0.properties.find(
        p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "props",
    ) as ts.PropertyAssignment | undefined;
    if (!propsProp) return;

    const propsObj = propsProp.initializer;
    if (!propsObj || !ts.isObjectLiteralExpression(propsObj)) return;

    // 收集所有传递给 renderFn 的 props key
    const passedProps: { key: string; node: ts.Node }[] = [];
    for (const prop of propsObj.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
            passedProps.push({ key: prop.name.text, node: prop });
        } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            passedProps.push({ key: prop.name.text, node: prop });
        }
    }

    if (passedProps.length === 0) return;

    // 找到 fn 参数 → 确定目标 renderFn 名
    const fnProp = arg0.properties.find(
        p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "fn",
    ) as ts.PropertyAssignment | undefined;
    if (!fnProp) return;

    const fnValue = fnProp.initializer;
    let renderFnName: string | undefined;
    if (ts.isIdentifier(fnValue)) {
        renderFnName = fnValue.text;
    }
    if (!renderFnName) return;

    // 找到 renderFn 节点
    const renderFnNode = findRenderFnNode(ctx.sourceFile, renderFnName);
    if (!renderFnNode) return;

    const renderFnBody = getFnBody(renderFnNode);
    if (!renderFnBody) return;

    // 逐 key 检查
    for (const { key, node } of passedProps) {
        // 条件 1: key 必须是 View 的 props 参数（上游透传）
        if (!ctx.propVars.has(key)) continue;

        const usage = analyzeUsageInRenderFn(renderFnBody, key);

        // 条件 2: 如果在 JSX 渲染或 renderView 中使用 → 跳过
        if (usage.usedInJSX || usage.usedInRenderView) continue;

        // 条件 3: 如果只在 events 回调参数中出现 → 报错
        if (usage.onlyInEventsArgs) {
            ctx.addViolation(
                "props 透传优化",
                `"${key}" 是上游透传数据，在 renderFn "${renderFnName}" 中仅用于 events 回调，` +
                `未用于 JSX 渲染或下游传递。建议上游 View 用 useCallback 捕获 "${key}"，` +
                `通过 events 槽传递，无需在 props 中透传。`,
                node,
            );
        }
    }
}

function getFnBody(node: ts.FunctionDeclaration | ts.ArrowFunction): ts.Block | undefined {
    if (ts.isArrowFunction(node) && node.body) {
        return ts.isBlock(node.body) ? node.body : undefined;
    }
    if (ts.isFunctionDeclaration(node)) {
        return node.body;
    }
    return undefined;
}

function findRenderFnNode(
    sourceFile: ts.SourceFile,
    name: string,
): ts.FunctionDeclaration | ts.ArrowFunction | undefined {
    for (const stmt of sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.name.text === name && stmt.body) {
            return stmt;
        }
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
                    if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                        return decl.initializer as ts.ArrowFunction;
                    }
                }
            }
        }
    }
    return undefined;
}

interface UsageAnalysis {
    usedInJSX: boolean;
    usedInRenderView: boolean;
    onlyInEventsArgs: boolean;
}

function analyzeUsageInRenderFn(body: ts.Block, varName: string): UsageAnalysis {
    const occurrences: Array<"render" | "event-arg" | "renderView"> = [];
    let hasOther = false;

    function walk(node: ts.Node) {
        // 不跳过嵌入式函数：需要检查事件回调中的引用
        // （内层同名参数导致的误报概率极低）

        if (ts.isIdentifier(node) && node.text === varName) {
            const ctx = classifyIdentifierUsage(node);
            if (ctx) {
                occurrences.push(ctx);
            } else {
                hasOther = true;
            }
            return;
        }

        ts.forEachChild(node, walk);
    }

    walk(body);

    return {
        usedInJSX: occurrences.some(o => o === "render"),
        usedInRenderView: occurrences.some(o => o === "renderView"),
        onlyInEventsArgs: !hasOther && occurrences.every(o => o === "event-arg") && occurrences.length > 0,
    };
}

/**
 * 检查 identifier 在 renderFn 中的使用上下文：
 *   - "render" → 在 JSX 中用于渲染（非 onXxx 属性值 / JSX 文本表达式）
 *   - "event-arg" → 在 JSX onXxx 事件回调的参数中
 *   - "renderView" → 作为参数传给 renderView()
 *   - null → 其他（不在 JSX 中，也不算 renderView）
 */
function classifyIdentifierUsage(node: ts.Identifier): "render" | "event-arg" | "renderView" | null {
    let current: ts.Node | undefined = node.parent;

    while (current) {
        // 作为 renderView() 的参数
        if (ts.isCallExpression(current)) {
            const callee = current.expression;
            if (ts.isIdentifier(callee) && callee.text === "renderView") {
                return "renderView";
            }
        }

        // 在 JSX 属性中
        if (ts.isJsxAttribute(current) && ts.isIdentifier(current.name)) {
            if (/^on[A-Z]/.test(current.name.text)) {
                return "event-arg";
            }
            return "render";
        }

        // 在 JSX 表达式中（如 <div>{items}</div> 或 attr={items}）
        if (ts.isJsxExpression(current)) {
            const parent = current.parent;
            if (parent) {
                if (ts.isJsxAttribute(parent) && ts.isIdentifier(parent.name)) {
                    if (/^on[A-Z]/.test(parent.name.text)) {
                        return "event-arg";
                    }
                    return "render";
                }
                if (ts.isJsxElement(parent)) {
                    return "render";
                }
            }
        }

        // 直接作为 JSX 属性值
        if (ts.isJsxAttribute(current)) {
            if (ts.isIdentifier(current.name) && /^on[A-Z]/.test(current.name.text)) {
                return "event-arg";
            }
            return "render";
        }

        current = current.parent;
    }

    return null;
}
