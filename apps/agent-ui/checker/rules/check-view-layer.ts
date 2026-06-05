// checker/rules/check-view-layer.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

/**
 * 检查 View 层（导出函数）是否包含禁止的条件表达式：
 * 1. 禁止 && 表达式
 * 2. 禁止三元表达式
 * 3. 禁止 if 语句（除了 if (xxx) return null; 这种在 renderFn 内允许，View 层不允许）
 *
 * View 层只允许直接调用 render(...)
 */
export function checkViewLayer(ctx: RuleContext, viewFn: ts.Node | null): void {
    if (!viewFn) return;

    // 只检查 View 函数本身，不深入 renderFn
    const body = ts.isArrowFunction(viewFn)
        ? viewFn.body
        : (viewFn as ts.FunctionDeclaration).body;

    if (!body) return;

    // ========== 收集 View 层所有 state/派生变量 ==========
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

    // 2. 禁止 if 语句（View 层不应该有任何条件分支）
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

    // 2a. 禁止 && 和三元表达式
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

    // 3. 检查 View 层 JSX 中是否有直接引用 state/派生变量的非 renderFn 元素
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

    // 4. 禁止文件内所有函数直接引用子组件（必须通过 render() API）
    // 全量扫描 sourceFile，覆盖 View 函数和所有 renderFn 的内部
    function checkComponentUsage(node: ts.Node) {
        // 4a. 禁止 <Xxxx /> JSX 标签
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

        // 4b. 禁止直接函数调用 {ComponentName(...)}（在 JSX 表达式内部）
        if (ts.isJsxExpression(node)) {
            const expr = node.expression;
            if (expr && ts.isCallExpression(expr)) {
                checkUppercaseCall(expr, node);
            }
        }

        // 4c. 禁止直接函数调用 ComponentName(...)（在 JSX 表达式之外，如 return ComponentName(...)）
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