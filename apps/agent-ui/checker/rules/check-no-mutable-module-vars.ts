// checker/rules/check-no-mutable-module-vars.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

/**
 * 检查文件级变量声明 + 文件函数体外部引用
 *
 * 规则 1（声明检查）:
 *   1. 禁止 let / var 声明（可变绑定）
 *   2. const 声明仅允许两种豁免：
 *      a. WriteState 对象
 *      b. 常量（右值为字面量）
 *
 * 规则 2（函数体引用检查）:
 *   所有文件级函数体内的变量引用，只能来自函数自身作用域
 *   （参数 + 局部变量），禁止一切外部引用。
 *   豁免：WriteState、模块级 const 常量
 */
export function checkNoMutableModuleVars(
    ctx: RuleContext,
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
): void {
    // ════════════════════════════════════════════════
    // 规则 1: 模块级变量声明检查
    // ════════════════════════════════════════════════
    for (const stmt of ctx.sourceFile.statements) {
        if (!ts.isVariableStatement(stmt)) continue;

        const flags = stmt.declarationList.flags;
        const isLet = (flags & ts.NodeFlags.Let) !== 0;
        const isConst = (flags & ts.NodeFlags.Const) !== 0;
        const isVar = !isLet && !isConst;

        for (const decl of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name)) continue;
            const varName = decl.name.text;

            // 规则 1a: let / var 一律禁止
            if (isLet || isVar) {
                ctx.addViolation(
                    "模块级变量规范",
                    `禁止使用 ${isLet ? "let" : "var"} 声明模块级变量 "${varName}"` +
                    `，请使用 const（常量）或移到 View 内作为 state`,
                    decl,
                );
                continue;
            }

            // 以下是 const 声明

            // 豁免 1: WriteState 对象（架构上的状态写入注册器）
            if (varName === "WriteState") continue;

            // 豁免 2: 常量字面量（const xxx = 79、const name = "hello" 等）
            if (isConstantLiteral(decl.initializer)) continue;

            // 违规
            ctx.addViolation(
                "模块级变量规范",
                `模块级 const 变量 "${varName}" 不是常量（右值不是字面量），` +
                `请将其移到 View 内作为 state 或局部变量`,
                decl,
            );
        }
    }

    // ════════════════════════════════════════════════
    // 规则 2: 文件函数体外部引用检查
    // ════════════════════════════════════════════════
    checkFileFnExternalRefs(ctx, viewFn);
}

// ────────────────────────────────────────────────────
// 规则 2 实现
// ────────────────────────────────────────────────────

/**
 * 检查所有文件级函数体：禁止引用外部变量
 *
 * 遍历每个文件级函数：
 *   1. 收集该函数的作用域（参数 + 局部变量）
 *   2. 遍历函数体，每个标识符引用必须在作用域内
 *   3. 豁免：WriteState、模块级 const 常量、JS 内建对象、文件级函数、imported 组件
 */
function checkFileFnExternalRefs(
    ctx: RuleContext,
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
): void {
    // Step 1: 收集模块级 const 常量名（允许在函数体内引用）
    const allowedRefs = collectConstLiteralNames(ctx);
    allowedRefs.add("WriteState");

    // Step 2: 收集 JS 全局内建对象
    for (const g of JS_GLOBALS) allowedRefs.add(g);

    // Step 3: 收集文件级函数名（允许互相调用 / 作为值传递）
    const moduleFnNames = collectModuleFnNames(ctx, viewFn);
    for (const n of moduleFnNames) allowedRefs.add(n);

    // Step 4: 收集 imported viewFn 名（跨文件组件引用）
    for (const n of ctx.importedViewFns) allowedRefs.add(n);

    // Step 5: 确定 View 函数名（跳过其函数体）
    const viewFnName = getViewFnName(viewFn);

    // Step 6: 遍历所有文件级函数
    for (const stmt of ctx.sourceFile.statements) {
        let fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
        let fnName: string | undefined;

        // function foo() {}
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
            fnName = stmt.name.text;
            if (fnName === viewFnName) continue; // 跳过 View
            fn = stmt;
        }

        // const foo = () => {} / function() {}
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
                if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                    // 跳过 View 箭头函数
                    if (ts.isArrowFunction(viewFn) && viewFn === decl.initializer) continue;
                    fn = decl.initializer;
                    fnName = decl.name.text;
                }
            }
        }

        if (!fn || !fn.body) continue;
        if (!ts.isBlock(fn.body)) continue; // 箭头表达式体没 block，不便于 scope 检查，跳过

        // 收集当前函数的作用域（参数 + 局部变量）
        const scope = collectFunctionScope(fn);

        // 遍历函数体，检查标识符引用
        checkBodyRefs(ctx, fn.body, scope, allowedRefs, fnName!);
    }
}

/** JS 全局内建对象白名单 */
const JS_GLOBALS = new Set([
    "undefined", "null", "true", "false", "NaN", "Infinity", "this",
    "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
    "Date", "Math", "JSON", "RegExp", "Map", "Set", "WeakMap", "WeakSet",
    "Promise", "Error", "TypeError", "SyntaxError", "ReferenceError",
    "console", "parseInt", "parseFloat", "isNaN", "isFinite", "decodeURI", "encodeURI",
    // Web API
    "TextEncoder", "TextDecoder",
    "fetch", "URL", "URLSearchParams",
    "Blob", "File", "FileReader", "FormData",
    "Headers", "Request", "Response",
    "AbortController", "AbortSignal",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "requestAnimationFrame", "cancelAnimationFrame",
    "IntersectionObserver", "MutationObserver", "ResizeObserver",
    "performance", "crypto", "Intl",
    "structuredClone", "Proxy", "Reflect",
    "localStorage", "sessionStorage",
    "location", "navigator", "history",
]);

/**
 * 收集文件级函数名（function 声明 + const 箭头函数）
 */
function collectModuleFnNames(
    ctx: RuleContext,
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
): Set<string> {
    const names = new Set<string>();
    const viewFnName = getViewFnName(viewFn);

    for (const stmt of ctx.sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.name.text !== viewFnName) {
            names.add(stmt.name.text);
        }
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer &&
                    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
                    // 跳过 View 箭头函数
                    if (ts.isArrowFunction(viewFn) && viewFn === decl.initializer) continue;
                    names.add(decl.name.text);
                }
            }
        }
    }
    return names;
}

/**
 * 遍历函数体，检查每个标识符引用是否在作用域内
 */
function checkBodyRefs(
    ctx: RuleContext,
    body: ts.Block,
    scope: Set<string>,
    allowedRefs: Set<string>,
    fnName: string,
): void {
    function walk(node: ts.Node, currentScope: Set<string>) {
        // 进入内层嵌套函数：合并父作用域 + 内层函数作用域
        if (node !== body &&
            (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))
        ) {
            if (node.body && ts.isBlock(node.body)) {
                const nestedScope = collectFunctionScope(node);
                const merged = new Set([...currentScope, ...nestedScope]);
                ts.forEachChild(node.body, (child) => walk(child, merged));
            }
            return;
        }

        if (ts.isIdentifier(node)) {
            const name = node.text;

            // ── 放行：属性访问的 property 名（foo.bar → bar 不是变量引用） ──
            if (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;

            // ── 放行：JSX 元素名和属性名 ──
            if (node.parent && (ts.isJsxOpeningElement(node.parent) || ts.isJsxSelfClosingElement(node.parent) || ts.isJsxClosingElement(node.parent))) return;
            if (node.parent && ts.isJsxAttribute(node.parent) && node.parent.name === node) return;

            // ── 放行：类型引用 ──
            if (node.parent && (ts.isTypeReferenceNode(node.parent) || ts.isTypeQueryNode(node.parent) || ts.isExpressionWithTypeArguments(node.parent))) return;

            // ── 放行：对象字面量属性名 { key: value } ──
            if (node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
            if (node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) return;

            // ── 放行：函数调用目标（foo() 中 foo 放行） ──
            // 调用另一个函数是合法的
            if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) return;

            // ── 放行：作用域内变量 ──
            if (currentScope.has(name)) return;

            // ── 放行：WriteState / 模块级 const 常量 ──
            if (allowedRefs.has(name)) return;

            // ── 违规 ──
            ctx.addViolation(
                "模块级变量规范",
                `文件级函数 "${fnName}" 引用了外部变量 "${name}"，` +
                `所有数据必须通过参数传递`,
                node,
            );
            return;
        }

        ts.forEachChild(node, (child) => walk(child, currentScope));
    }

    walk(body, scope);
}

/**
 * 收集函数的参数 + 局部变量名作为作用域
 */
function collectFunctionScope(
    fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
): Set<string> {
    const names = new Set<string>();

    // 收集参数名（包括解构）
    for (const param of fn.parameters) {
        collectBindingNames(param.name, names);
    }

    // 收集函数体内的局部变量声明
    if (fn.body && ts.isBlock(fn.body)) {
        function collectDecls(node: ts.Node) {
            if (ts.isVariableDeclaration(node)) {
                collectBindingNames(node.name, names);
            }
            ts.forEachChild(node, collectDecls);
        }
        collectDecls(fn.body);
    }

    return names;
}

/**
 * 递归收集 Binding 模式中的变量名
 * 处理：{ a, b }、[x, y]、{ a: { b, c } } 等
 */
function collectBindingNames(
    name: ts.BindingName,
    names: Set<string>,
): void {
    if (ts.isIdentifier(name)) {
        names.add(name.text);
    } else if (ts.isObjectBindingPattern(name)) {
        for (const elem of name.elements) {
            collectBindingNames(elem.name, names);
        }
    } else if (ts.isArrayBindingPattern(name)) {
        for (const elem of name.elements) {
            collectBindingNames(elem.name, names);
        }
    }
}

/**
 * 获取 View 函数的名称
 */
function getViewFnName(
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
): string | undefined {
    if (!viewFn) return undefined;
    if (ts.isFunctionDeclaration(viewFn) && viewFn.name) {
        return viewFn.name.text;
    }
    if (viewFn.parent && ts.isVariableDeclaration(viewFn.parent) && ts.isIdentifier(viewFn.parent.name)) {
        return viewFn.parent.name.text;
    }
    return undefined;
}

/**
 * 收集模块级 const 常量名（右值为字面量的 const 变量）
 */
function collectConstLiteralNames(ctx: RuleContext): Set<string> {
    const names = new Set<string>();
    for (const stmt of ctx.sourceFile.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
        for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.initializer && isConstantLiteral(decl.initializer)) {
                names.add(decl.name.text);
            }
        }
    }
    return names;
}

/**
 * 判断初始化值是否为常量字面量
 *
 * 通过的类型：
 *   - 数字字面量: 79, 3.14
 *   - 字符串字面量: "hello", 'world'
 *   - 布尔字面量: true, false
 *   - null / undefined
 *   - 无插值模板字面量: `hello`
 *   - 负数字面量: -1
 *   - 简单数组/[字面量]: [1, 2, 3]、["a"]
 *   - 简单对象/{字面量}: { a: 1 }
 */
function isConstantLiteral(node: ts.Node | undefined): boolean {
    if (!node) return false;

    // 基本字面量
    if (ts.isNumericLiteral(node)) return true;
    if (ts.isStringLiteral(node)) return true;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isNoSubstitutionTemplateLiteral(node)) return true;

    // undefined 标识符
    if (ts.isIdentifier(node) && node.text === "undefined") return true;

    // 负数字面量: -1, -3.14
    if (ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.operand)) return true;

    // 简单数组字面量 [1, 2, 3]、["a"] — 所有元素都是常量
    if (ts.isArrayLiteralExpression(node)) {
        return node.elements.length > 0 && node.elements.every(e => isConstantLiteral(e));
    }

    // 简单对象字面量 { a: 1, b: "hello" } — 所有属性值都是常量
    if (ts.isObjectLiteralExpression(node)) {
        if (node.properties.length === 0) return false; // {} 空对象不认为是常量
        return node.properties.every(p => {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
                return isConstantLiteral(p.initializer);
            }
            if (ts.isShorthandPropertyAssignment(p)) return true; // { a } — 来自其他常量
            return false;
        });
    }

    return false;
}
