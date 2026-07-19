// checker/rules/check-props-flow.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

/**
 * Check for wasteful data tunneling through the props slot:
 *
 * Scenario: a variable X from the current View's props parameters
 * is passed directly into renderFn's props slot,
 * but X is only used as an argument to events callbacks inside renderFn
 * (it is not used for rendering or downstream passing).
 * This means X should not flow through props; the upstream View should
 * capture it with useCallback and pass it through the events slot.
 *
 * Exemptions:
 *   1. X is used for rendering in renderFn's JSX → valid pass-through
 *   2. X is passed downstream via renderView() → valid pass-through
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

    // Recursively find all render() calls within the View body
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

    // Locate the props slot
    const propsProp = arg0.properties.find(
        p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "props",
    ) as ts.PropertyAssignment | undefined;
    if (!propsProp) return;

    const propsObj = propsProp.initializer;
    if (!propsObj || !ts.isObjectLiteralExpression(propsObj)) return;

    // Collect all props keys passed to renderFn
    const passedProps: { key: string; node: ts.Node }[] = [];
    for (const prop of propsObj.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
            passedProps.push({ key: prop.name.text, node: prop });
        } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            passedProps.push({ key: prop.name.text, node: prop });
        }
    }

    if (passedProps.length === 0) return;

    // Locate the fn param → determine the target renderFn name
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

    // Locate the renderFn node
    const renderFnNode = findRenderFnNode(ctx.sourceFile, renderFnName);
    if (!renderFnNode) return;

    const renderFnBody = getFnBody(renderFnNode);
    if (!renderFnBody) return;

    // Check key by key
    for (const { key, node } of passedProps) {
        // Condition 1: key must be a View props parameter (upstream pass-through)
        if (!ctx.propVars.has(key)) continue;

        const usage = analyzeUsageInRenderFn(renderFnBody, key);

        // Condition 2: if used in JSX rendering or renderView → skip
        if (usage.usedInJSX || usage.usedInRenderView) continue;

        // Condition 3: if it only appears in events callback args → report violation
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
        // Do not skip nested functions: need to inspect references inside event callbacks
        // (risk of false positives from same-named inner params is extremely low)

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
 * Inspect the usage context of an identifier within renderFn:
 *   - "render" → used for rendering in JSX (not an onXxx prop value / JSX text expression)
 *   - "event-arg" → used as an argument in a JSX onXxx event callback
 *   - "renderView" → passed as an argument to renderView()
 *   - null → other (not in JSX, and not counted as renderView)
 */
function classifyIdentifierUsage(node: ts.Identifier): "render" | "event-arg" | "renderView" | null {
    let current: ts.Node | undefined = node.parent;

    while (current) {
        // As an argument to renderView()
        if (ts.isCallExpression(current)) {
            const callee = current.expression;
            if (ts.isIdentifier(callee) && callee.text === "renderView") {
                return "renderView";
            }
        }

        // In a JSX attribute
        if (ts.isJsxAttribute(current) && ts.isIdentifier(current.name)) {
            if (/^on[A-Z]/.test(current.name.text)) {
                return "event-arg";
            }
            return "render";
        }

        // In a JSX expression (e.g. <div>{items}</div> or attr={items})
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

        // Directly as a JSX attribute value
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
