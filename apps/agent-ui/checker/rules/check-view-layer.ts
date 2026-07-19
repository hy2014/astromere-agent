// checker/rules/check-view-layer.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

/**
 * Check whether the View layer (exported function) contains forbidden conditional expressions:
 * 1. Forbid && expressions
 * 2. Forbid ternary expressions
 * 3. Forbid if statements (except `if (xxx) return null;`, which is allowed inside renderFn but not in the View layer)
 *
 * The View layer may only directly call render(...)
 */
export function checkViewLayer(ctx: RuleContext, viewFn: ts.Node | null): void {
    if (!viewFn) return;

    // Only check the View function itself; do not descend into renderFn
    const body = ts.isArrowFunction(viewFn)
        ? viewFn.body
        : (viewFn as ts.FunctionDeclaration).body;

    if (!body) return;

    // ========== Collect all View-layer state/derived variables ==========
    const allStateVars = new Set(ctx.stateVars);
    ctx.memoVars.forEach(v => allStateVars.add(v));

    function collectDerivedVars(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const varName = node.name.text;
            if (allStateVars.has(varName)) return;
            const init = node.initializer;
            if (!init) return;
            let dependsOnState = false;
            if (ts.isCallExpression(init)) {
                const callee = init.expression;
                if (ts.isIdentifier(callee) &&
                    (callee.text === "useMemo" || callee.text === "useCallback")) {
                    dependsOnState = true;
                }
            }
            if (!dependsOnState) {
                function checkRef(n: ts.Node) {
                    if (ts.isIdentifier(n) && allStateVars.has(n.text)) dependsOnState = true;
                    ts.forEachChild(n, checkRef);
                }
                checkRef(init);
            }
            if (dependsOnState) allStateVars.add(varName);
        }
        ts.forEachChild(node, collectDerivedVars);
    }

    if (ts.isBlock(body)) {
        body.statements.forEach(collectDerivedVars);
    }

    // 2. Forbid if statements (the View layer should not have any conditional branches)
    function checkStatement(node: ts.Node) {
        if (ts.isIfStatement(node)) {
            ctx.addViolation(
                "View 层规范",
                "View 层禁止使用 if 语句，请将条件逻辑下沉到 renderFn 内部。",
                node
            );
        }
        ts.forEachChild(node, checkStatement);
    }

    // 2a. Forbid && and ternary expressions
    function checkExpression(node: ts.Node) {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            ctx.addViolation(
                "View 层规范",
                "View 层禁止使用 && 条件表达式，请将条件逻辑下沉到 renderFn 内部。",
                node
            );
        }

        if (ts.isConditionalExpression(node)) {
            ctx.addViolation(
                "View 层规范",
                "View 层禁止使用三元表达式，请将条件逻辑下沉到 renderFn 内部。",
                node
            );
        }

        ts.forEachChild(node, checkExpression);
    }

    if (ts.isBlock(body)) {
        body.statements.forEach(checkStatement);
    }
    checkExpression(body);

    // 3. Check whether the View-layer JSX directly references state/derived variables in non-renderFn elements
    function checkJsxStateUsage(node: ts.Node) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tagName = node.tagName.getText();
            if (tagName === "render" || tagName.endsWith(".render")) return;

            const stateRefs: string[] = [];
            for (const attr of node.attributes.properties) {
                if (!ts.isJsxAttribute(attr)) continue;
                const init = attr.initializer;
                if (!init || !ts.isJsxExpression(init)) continue;
                const expr = init.expression;
                if (!expr) continue;

                let varLabel = "";
                if (ts.isIdentifier(expr)) {
                    if (ctx.stateVars.has(expr.text)) varLabel = "(state)";
                    else if (ctx.memoVars.has(expr.text)) varLabel = "(memo)";
                    else if (allStateVars.has(expr.text)) varLabel = "(派生)";
                    if (varLabel) stateRefs.push(`${attr.name.text}={${expr.text}} ${varLabel}`);
                }
                else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
                    const base = expr.expression.text;
                    if (ctx.stateVars.has(base)) varLabel = "(state)";
                    else if (ctx.memoVars.has(base)) varLabel = "(memo)";
                    else if (allStateVars.has(base)) varLabel = "(派生)";
                    if (varLabel) stateRefs.push(`${attr.name.text}={${base}.${expr.name.text}} ${varLabel}`);
                }
            }

            if (stateRefs.length > 0) {
                const detail = stateRefs.join(", ");
                ctx.addViolation(
                    "View 层规范",
                    `组件 <${tagName}> 引用了 state/派生变量 (${detail})。该数据流不会被 Code Graph 追踪。如需追踪，可通过 render() 调用经 ext 传入`,
                    node
                );
            }
        }
        ts.forEachChild(node, checkJsxStateUsage);
    }
    checkJsxStateUsage(body);

    // 4. Forbid all file functions from directly referencing sub-components (must go through the render() API)
    // Scan the entire sourceFile, covering the View function and the internals of all renderFns
    function checkComponentUsage(node: ts.Node) {
        // 4a. Forbid <Xxxx /> JSX tags
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tagName = node.tagName.getText();
            if (tagName === "render" || tagName.endsWith(".render")) return;
            if (tagName === "React.Fragment" || tagName === "Fragment") return;
            if (/^[A-Z]/.test(tagName)) {
                ctx.addViolation(
                    "View 层规范",
                    `禁止使用 JSX 标签 <${tagName}> 引用子组件，该数据流不会被 Code Graph 追踪。请改为 renderFn 模式：定义 renderFn 接收 (state, props, events, ext?, memo?) 参数，并通过 render() API 调用。`,
                    node
                );
            }
        }

        // 4b. Forbid direct function calls {ComponentName(...)} (inside JSX expressions)
        if (ts.isJsxExpression(node)) {
            const expr = node.expression;
            if (expr && ts.isCallExpression(expr)) {
                checkUppercaseCall(expr, node);
            }
        }

        // 4c. Forbid direct function calls ComponentName(...) (outside JSX expressions, e.g. return ComponentName(...))
        if (ts.isCallExpression(node) && !ts.isJsxExpression(node.parent)) {
            checkUppercaseCall(node, node);
        }

        ts.forEachChild(node, checkComponentUsage);
    }

    const builtins = new Set([
        "Array", "Object", "String", "Number", "Boolean",
        "Math", "Date", "JSON", "RegExp", "Promise",
        "Map", "Set", "WeakMap", "WeakSet",
        "URL", "URLSearchParams", "Intl", "BigInt",
        "Symbol", "Error", "TypeError", "RangeError",
        "Reflect", "Proxy", "console", "performance",
    ]);

    function checkUppercaseCall(call: ts.CallExpression, reportOn: ts.Node) {
        const callee = call.expression;
        if (ts.isIdentifier(callee) && /^[A-Z]/.test(callee.text)) {
            if (builtins.has(callee.text)) return;
            ctx.addViolation(
                "View 层规范",
                `禁止直接调用子组件函数 ${callee.text}()，该数据流不会被 Code Graph 追踪。请改为 renderFn 模式：定义 renderFn 接收 (state, props, events, ext?, memo?) 参数，并通过 render() API 调用。`,
                reportOn
            );
        }
    }

    checkComponentUsage(ctx.sourceFile);
}