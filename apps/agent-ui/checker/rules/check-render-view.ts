// checker/rules/check-render-view.ts
import * as ts from "typescript";
import { RuleContext } from "../types";
import { isRenderFn } from "./check-render-fns";
import { getViewFnPropNames } from "../utils";

function unwrapExpression(expr: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)) {
        if (ts.isParenthesizedExpression(expr)) expr = expr.expression;
        else if (ts.isAsExpression(expr)) expr = expr.expression;
        else if (ts.isNonNullExpression(expr)) expr = expr.expression;
        else if (ts.isSatisfiesExpression(expr)) expr = expr.expression;
    }
    return expr;
}

export function checkRenderView(
    ctx: RuleContext,
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
    fsPath?: string,
): void {
    // ════════════════════════════════════════════════════════
    // Rule 1: forbid locally declaring renderView; it must be imported from core/dep
    // ════════════════════════════════════════════════════════
    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.name.text === "renderView") {
            ctx.addViolation("renderView 规范", "禁止本地声明 renderView 函数，renderView 必须从核心模块导入", stmt);
        }
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.name.text === "renderView") {
                    ctx.addViolation("renderView 规范", "禁止本地声明 renderView 变量，renderView 必须从核心模块导入", decl);
                }
            }
        }
    }

    // ════════════════════════════════════════════════════════
    // Rule 2: renderView may only be called inside a renderFn function
    // ════════════════════════════════════════════════════════
    function checkRenderViewContext(node: ts.Node) {
        if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "renderView") {

            let current = node.parent;
            let inRenderFn = false;
            while (current) {
                if (isRenderFn(current)) {
                    inRenderFn = true;
                    break;
                }
                current = current.parent;
            }

            if (!inRenderFn) {
                ctx.addViolation(
                    "renderView 规范",
                    "renderView 只能在 renderFn 函数内部调用，不能在 View 层或业务函数中调用",
                    node,
                );
            }
        }
        ts.forEachChild(node, checkRenderViewContext);
    }
    checkRenderViewContext(ctx.sourceFile);

    // ════════════════════════════════════════════════════════
    // Rule 3: forbid using createElement to render elements/components
    // Must use JSX or renderView instead
    // ════════════════════════════════════════════════════════
    function checkCreateElement(node: ts.Node) {
        if (ts.isCallExpression(node) && node.arguments.length > 0) {
            const callee = node.expression;
            const isCreateElement =
                (ts.isIdentifier(callee) && callee.text === "createElement") ||
                (ts.isPropertyAccessExpression(callee) &&
                    ts.isIdentifier(callee.name) &&
                    callee.name.text === "createElement");

            if (isCreateElement) {
                // Check whether we are inside a View function (the JSX compilation output of a View is out of scope, since the source does not contain createElement)
                let inView = false;
                let cur = node.parent;
                while (cur) {
                    if (ts.isFunctionDeclaration(cur) && cur.name && /View$/.test(cur.name.text)) {
                        inView = true;
                        break;
                    }
                    cur = cur.parent;
                }

                if (!inView) {
                    const firstArg = node.arguments[0];
                    const name = firstArg && (ts.isStringLiteral(firstArg) ? firstArg.text :
                        ts.isIdentifier(firstArg) ? firstArg.text : "?");

                    ctx.addViolation(
                        "renderView 规范",
                        `禁止直接调用 createElement，请使用 JSX 或 renderView() 代替${name !== "?" ? `（渲染目标: ${name}）` : ""}`,
                        node,
                    );
                }
            }
        }
        ts.forEachChild(node, checkCreateElement);
    }
    checkCreateElement(ctx.sourceFile);

    // ════════════════════════════════════════════════════════
    // Rule 4: renderView's fn must be a directly imported View, not a local declaration or inline
    // ════════════════════════════════════════════════════════
    // Collect all imported names
    const importedNames = new Set<string>();
    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isImportDeclaration(stmt) && stmt.importClause) {
            // import { XxxView } from "..."
            if (stmt.importClause.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
                for (const spec of stmt.importClause.namedBindings.elements) {
                    importedNames.add(spec.name.text);
                }
            }
            // import XxxView from "..."
            if (stmt.importClause.name && ts.isIdentifier(stmt.importClause.name)) {
                importedNames.add(stmt.importClause.name.text);
            }
        }
    }

    function checkRenderViewFn(node: ts.Node) {
        if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "renderView") {

            const arg0 = node.arguments[0];
            if (!arg0 || !ts.isObjectLiteralExpression(arg0)) { ts.forEachChild(node, checkRenderViewFn); return; }

            const fnProp = arg0.properties.find(
                p => ts.isPropertyAssignment(p) &&
                    ts.isIdentifier(p.name) &&
                    p.name.text === "fn",
            ) as ts.PropertyAssignment | undefined;
            if (!fnProp) { ts.forEachChild(node, checkRenderViewFn); return; }

            const fnValue = fnProp.initializer;

            // inline arrow function / function expression → violation
            if (ts.isArrowFunction(fnValue) || ts.isFunctionExpression(fnValue)) {
                ctx.addViolation("renderView 规范", "renderView 的 fn 不能是内联函数，必须使用 import 的 View 组件", fnProp);
                return;
            }

            // non-identifier (e.g. CallExpression: getView()) → violation
            if (!ts.isIdentifier(fnValue)) {
                ctx.addViolation("renderView 规范", "renderView 的 fn 必须直接引用 import 的 View 组件，不能使用表达式", fnProp);
                return;
            }

            // is an identifier but not imported → locally declared, violation
            if (!importedNames.has(fnValue.text)) {
                ctx.addViolation(
                    "renderView 规范",
                    `renderView 的 fn "${fnValue.text}" 不是 import 的 View 组件，必须是直接从其他文件 import 的 View`,
                    fnProp,
                );
            }
        }
        ts.forEachChild(node, checkRenderViewFn);
    }
    checkRenderViewFn(ctx.sourceFile);

    // ════════════════════════════════════════════════════════
    // Rule 5: an already-confirmed viewFn (imported from another file) must not appear in a function parameter list
    // Forbidden as a parameter name, parameter default value, or parameter type reference
    // ════════════════════════════════════════════════════════
    function checkViewInParams(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            for (const param of node.parameters) {
                function findViewRef(n: ts.Node) {
                    if (ts.isIdentifier(n) && ctx.importedViewFns.has(n.text)) {
                        ctx.addViolation(
                            "renderView 规范",
                            `View 组件 "${n.text}" 不能出现在函数参数中，必须直接通过 renderView({ fn: ${n.text} }) 引用`,
                            n,
                        );
                    }
                    ts.forEachChild(n, findViewRef);
                }
                findViewRef(param);
            }
            return; // Do not enter the function body, only check the parameter list
        }
        ts.forEachChild(node, checkViewInParams);
    }
    checkViewInParams(ctx.sourceFile);

    // ════════════════════════════════════════════════════════
    // Rule 6: renderView's props must be a subset of the caller's state ∪ events
    // ════════════════════════════════════════════════════════
    function checkRenderViewProps(node: ts.Node) {
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "renderView") {
            ts.forEachChild(node, checkRenderViewProps);
            return;
        }

        // Find the caller
        let callingFn: ts.Node | null = null;
        let cur: ts.Node | undefined = node.parent;
        while (cur) {
            if (ts.isFunctionDeclaration(cur) || ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
                callingFn = cur;
                break;
            }
            cur = cur.parent;
        }

        // Get the caller's state ∪ events keys
        let allowedKeys: Set<string>;
        if (callingFn && isRenderFn(callingFn)) {
            const params = (callingFn as ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression).parameters;
            allowedKeys = new Set();
            // state: first parameter
            if (params.length >= 1 && ts.isObjectBindingPattern(params[0].name)) {
                for (const elem of params[0].name.elements) {
                    if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name)) {
                        allowedKeys.add(elem.name.text);
                    }
                }
            }
            // props: second parameter
            if (params.length >= 2 && ts.isObjectBindingPattern(params[1].name)) {
                for (const elem of params[1].name.elements) {
                    if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name)) {
                        allowedKeys.add(elem.name.text);
                    }
                }
            }
            // events: third parameter
            if (params.length >= 3 && ts.isObjectBindingPattern(params[2].name)) {
                for (const elem of params[2].name.elements) {
                    if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name)) {
                        allowedKeys.add(elem.name.text);
                    }
                }
            }
        } else {
            // View layer: state ∪ props (events come from props)
            allowedKeys = new Set([...ctx.stateVars, ...ctx.propVars]);
        }

        const arg0 = node.arguments[0];
        if (!arg0 || !ts.isObjectLiteralExpression(arg0)) { ts.forEachChild(node, checkRenderViewProps); return; }

        const propsProp = arg0.properties.find(
            p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "props"
        ) as ts.PropertyAssignment | undefined;
        if (!propsProp) { ts.forEachChild(node, checkRenderViewProps); return; }

        const propsObj = unwrapExpression(propsProp.initializer);
        if (!ts.isObjectLiteralExpression(propsObj)) { ts.forEachChild(node, checkRenderViewProps); return; }

        for (const prop of propsObj.properties) {
            let key: string | undefined;
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                key = prop.name.text;
            } else if (ts.isShorthandPropertyAssignment(prop)) {
                key = prop.name.text;
            } else if (ts.isSpreadAssignment(prop)) {
                ctx.addViolation(
                    "renderView 规范",
                    `renderView 的 props 中不允许使用 spread（...），破坏 slot 键级追踪`,
                    prop
                );
                continue;
            }
            if (key && !allowedKeys.has(key)) {
                ctx.addViolation(
                    "renderView 规范",
                    `renderView 的 props 中 "${key}" 未在调用方的 state 或 events 中声明`,
                    prop
                );
            }
        }

        ts.forEachChild(node, checkRenderViewProps);
    }
    checkRenderViewProps(ctx.sourceFile);

    // ════════════════════════════════════════════════════════
    // Rule 7: renderView's props must match the target viewFn's Props interface
    // ════════════════════════════════════════════════════════
    function checkRenderViewPropMatch(node: ts.Node) {
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "renderView") {
            ts.forEachChild(node, checkRenderViewPropMatch);
            return;
        }

        if (!fsPath) { ts.forEachChild(node, checkRenderViewPropMatch); return; }

        const arg0 = node.arguments[0];
        if (!arg0 || !ts.isObjectLiteralExpression(arg0)) { ts.forEachChild(node, checkRenderViewPropMatch); return; }

        // Get fn
        const fnProp = arg0.properties.find(
            p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "fn"
        ) as ts.PropertyAssignment | undefined;
        if (!fnProp) { ts.forEachChild(node, checkRenderViewPropMatch); return; }

        const fnValue = fnProp.initializer;
        if (!ts.isIdentifier(fnValue)) { ts.forEachChild(node, checkRenderViewPropMatch); return; }

        // Get props
        const propsProp = arg0.properties.find(
            p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "props"
        ) as ts.PropertyAssignment | undefined;
        if (!propsProp) { ts.forEachChild(node, checkRenderViewPropMatch); return; }

        const propsObj = unwrapExpression(propsProp.initializer);
        if (!ts.isObjectLiteralExpression(propsObj)) { ts.forEachChild(node, checkRenderViewPropMatch); return; }

        // Resolve the target viewFn's Props
        const targetProps = getViewFnPropNames(fnValue.text, ctx.sourceFile, fsPath);
        if (!targetProps) { ts.forEachChild(node, checkRenderViewPropMatch); return; }

        for (const prop of propsObj.properties) {
            let key: string | undefined;
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                key = prop.name.text;
            } else if (ts.isShorthandPropertyAssignment(prop)) {
                key = prop.name.text;
            }
            if (key && !targetProps.has(key)) {
                ctx.addViolation(
                    "renderView 规范",
                    `renderView 的 props 中 "${key}" 未在 "${fnValue.text}" 的 Props 接口中声明`,
                    prop
                );
            }
        }

        ts.forEachChild(node, checkRenderViewPropMatch);
    }
    checkRenderViewPropMatch(ctx.sourceFile);
}
