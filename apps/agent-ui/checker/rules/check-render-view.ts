// checker/rules/check-render-view.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

export function checkRenderView(
    ctx: RuleContext,
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
): void {
    // ════════════════════════════════════════════════════════
    // 规则 1: 禁止本地声明 renderView 函数，必须从 core/dep 导入
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
    // 规则 2: renderView 只能在 renderFn 函数内调用
    // ════════════════════════════════════════════════════════
    function checkRenderViewContext(node: ts.Node) {
        if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "renderView") {

            let current = node.parent;
            let inRenderFn = false;
            while (current) {
                if (ts.isFunctionDeclaration(current) && current.name) {
                    inRenderFn = current.name.text.startsWith("render");
                    break;
                }
                if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.name.text.startsWith("render")) {
                    inRenderFn = true;
                    break;
                }
                current = current.parent;
            }

            if (!inRenderFn) {
                ctx.addViolation(
                    "renderView 规范",
                    "renderView 只能在 renderXxx 函数内部调用，不能在 View 层或业务函数中调用",
                    node,
                );
            }
        }
        ts.forEachChild(node, checkRenderViewContext);
    }
    checkRenderViewContext(ctx.sourceFile);

    // ════════════════════════════════════════════════════════
    // 规则 3: 禁止使用 createElement 渲染元素/组件
    // 必须用 JSX 或 renderView 代替
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
                // 检查是否在 View 函数内（View 的 JSX 编译产物不在此检查范围，因源码不包含 createElement）
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
    // 规则 4: renderView 的 fn 必须是直接 import 的 View，不能是本地声明或内联
    // ════════════════════════════════════════════════════════
    // 收集所有 import 进来的名称
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

            // 内联箭头函数/函数表达式 → 违规
            if (ts.isArrowFunction(fnValue) || ts.isFunctionExpression(fnValue)) {
                ctx.addViolation("renderView 规范", "renderView 的 fn 不能是内联函数，必须使用 import 的 View 组件", fnProp);
                return;
            }

            // 非标识符（如 CallExpression：getView()）→ 违规
            if (!ts.isIdentifier(fnValue)) {
                ctx.addViolation("renderView 规范", "renderView 的 fn 必须直接引用 import 的 View 组件，不能使用表达式", fnProp);
                return;
            }

            // 是标识符但非 import 的 → 本地声明的，违规
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
}
