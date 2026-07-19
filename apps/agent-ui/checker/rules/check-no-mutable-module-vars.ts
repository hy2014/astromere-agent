// checker/rules/check-no-mutable-module-vars.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

/**
 * Check file-level variable declarations + references from outside file function bodies
 *
 * Rule 1 (declaration check):
 *   1. Forbid let / var declarations (mutable bindings)
 *   2. const declarations are only allowed under two exemptions:
 *      a. WriteState object
 *      b. Constant (right-hand side is a literal)
 *
 * Rule 2 (function-body reference check):
 *   All variable references inside file-level function bodies may only come from
 *   the function's own scope (parameters + local variables); all external
 *   references are forbidden.
 *   Exemptions: WriteState, module-level const constants
 */
export function checkNoMutableModuleVars(
    ctx: RuleContext,
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
): void {
    // ════════════════════════════════════════════════
    // Rule 1: Module-level variable declaration check
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

            // Rule 1a: let / var are always forbidden
            if (isLet || isVar) {
                ctx.addViolation(
                    "模块级变量规范",
                    `禁止使用 ${isLet ? "let" : "var"} 声明模块级变量 "${varName}"` +
                    `，请使用 const（常量）或移到 View 内作为 state`,
                    decl,
                );
                continue;
            }

            // The following are const declarations

            // Exemption 1: WriteState object (architectural state-write registrar)
            if (varName === "WriteState") continue;

            // Exemption 2: constant literals (const xxx = 79, const name = "hello", etc.)
            if (isConstantLiteral(decl.initializer)) continue;

            // Violation
            ctx.addViolation(
                "模块级变量规范",
                `模块级 const 变量 "${varName}" 不是常量（右值不是字面量），` +
                `请将其移到 View 内作为 state 或局部变量`,
                decl,
            );
        }
    }

    // ════════════════════════════════════════════════
    // Rule 2: File function-body external reference check
    // ════════════════════════════════════════════════
    checkFileFnExternalRefs(ctx, viewFn);
}

// ────────────────────────────────────────────────────
// Rule 2 implementation
// ────────────────────────────────────────────────────

/**
 * Check all file-level function bodies: forbid referencing external variables
 *
 * For each file-level function:
 *   1. Collect the function's scope (parameters + local variables)
 *   2. Walk the function body; every identifier reference must be in scope
 *   3. Exemptions: WriteState, module-level const constants, JS built-ins,
 *      file-level functions, imported components
 */
function checkFileFnExternalRefs(
    ctx: RuleContext,
    viewFn: ts.FunctionDeclaration | ts.ArrowFunction | null,
): void {
    // Step 1: Collect module-level const constant names (allowed to reference in function bodies)
    const allowedRefs = collectConstLiteralNames(ctx);
    allowedRefs.add("WriteState");

    // Step 2: Collect JS global built-in objects
    for (const g of JS_GLOBALS) allowedRefs.add(g);

    // Step 3: Collect file-level function names (allowed to call each other / pass as values)
    const moduleFnNames = collectModuleFnNames(ctx, viewFn);
    for (const n of moduleFnNames) allowedRefs.add(n);

    // Step 4: Collect imported viewFn names (cross-file component references)
    for (const n of ctx.importedViewFns) allowedRefs.add(n);

    // Step 5: Determine the View function name (skip its body)
    const viewFnName = getViewFnName(viewFn);

    // Step 6: Walk all file-level functions
    for (const stmt of ctx.sourceFile.statements) {
        let fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
        let fnName: string | undefined;

        // function foo() {}
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
            fnName = stmt.name.text;
            if (fnName === viewFnName) continue; // Skip View
            fn = stmt;
        }

        // const foo = () => {} / function() {}
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
                if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                    // Skip View arrow function
                    if (ts.isArrowFunction(viewFn) && viewFn === decl.initializer) continue;
                    fn = decl.initializer;
                    fnName = decl.name.text;
                }
            }
        }

        if (!fn || !fn.body) continue;
        if (!ts.isBlock(fn.body)) continue; // Arrow expression body has no block; scope check is awkward, skip

        // Collect the current function's scope (parameters + local variables)
        const scope = collectFunctionScope(fn);

        // Walk the function body and check identifier references
        checkBodyRefs(ctx, fn.body, scope, allowedRefs, fnName!);
    }
}

/** JS global built-in object whitelist */
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
 * Collect file-level function names (function declarations + const arrow functions)
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
                    // Skip View arrow function
                    if (ts.isArrowFunction(viewFn) && viewFn === decl.initializer) continue;
                    names.add(decl.name.text);
                }
            }
        }
    }
    return names;
}

/**
 * Walk the function body and check whether each identifier reference is in scope
 */
function checkBodyRefs(
    ctx: RuleContext,
    body: ts.Block,
    scope: Set<string>,
    allowedRefs: Set<string>,
    fnName: string,
): void {
    function walk(node: ts.Node, currentScope: Set<string>) {
        // Entering a nested inner function: merge parent scope + inner function scope
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

            // ── Allow: property name of a property access (foo.bar → bar is not a variable reference) ──
            if (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;

            // ── Allow: JSX element names and attribute names ──
            if (node.parent && (ts.isJsxOpeningElement(node.parent) || ts.isJsxSelfClosingElement(node.parent) || ts.isJsxClosingElement(node.parent))) return;
            if (node.parent && ts.isJsxAttribute(node.parent) && node.parent.name === node) return;

            // ── Allow: type references ──
            if (node.parent && (ts.isTypeReferenceNode(node.parent) || ts.isTypeQueryNode(node.parent) || ts.isExpressionWithTypeArguments(node.parent))) return;

            // ── Allow: object literal property names { key: value } ──
            if (node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
            if (node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) return;

            // ── Allow: function call target (foo in foo() is allowed) ──
            // Calling another function is legal
            if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) return;

            // ── Allow: in-scope variables ──
            if (currentScope.has(name)) return;

            // ── Allow: WriteState / module-level const constants ──
            if (allowedRefs.has(name)) return;

            // ── Violation ──
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
 * Collect the function's parameters + local variable names as its scope
 */
function collectFunctionScope(
    fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
): Set<string> {
    const names = new Set<string>();

    // Collect parameter names (including destructuring)
    for (const param of fn.parameters) {
        collectBindingNames(param.name, names);
    }

    // Collect local variable declarations inside the function body
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
 * Recursively collect variable names in binding patterns
 * Handles: { a, b }, [x, y], { a: { b, c } }, etc.
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
 * Get the name of the View function
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
 * Collect module-level const constant names (const variables whose right-hand side is a literal)
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
 * Determine whether an initializer is a constant literal
 *
 * Types that pass:
 *   - Numeric literal: 79, 3.14
 *   - String literal: "hello", 'world'
 *   - Boolean literal: true, false
 *   - null / undefined
 *   - Non-interpolated template literal: `hello`
 *   - Negative numeric literal: -1
 *   - Simple array literal: [1, 2, 3], ["a"]
 *   - Simple object literal: { a: 1 }
 */
export function isConstantLiteral(node: ts.Node | undefined): boolean {
    if (!node) return false;

    // Basic literals
    if (ts.isNumericLiteral(node)) return true;
    if (ts.isStringLiteral(node)) return true;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isNoSubstitutionTemplateLiteral(node)) return true;

    // undefined identifier
    if (ts.isIdentifier(node) && node.text === "undefined") return true;

    // Negative numeric literal: -1, -3.14
    if (ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.operand)) return true;

    // Simple array literal [1, 2, 3], ["a"] — all elements are constants
    if (ts.isArrayLiteralExpression(node)) {
        return node.elements.length > 0 && node.elements.every(e => isConstantLiteral(e));
    }

    // Simple object literal { a: 1, b: "hello" } — all property values are constants
    if (ts.isObjectLiteralExpression(node)) {
        if (node.properties.length === 0) return false; // {} empty object is not considered a constant
        return node.properties.every(p => {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
                return isConstantLiteral(p.initializer);
            }
            if (ts.isShorthandPropertyAssignment(p)) return true; // { a } — comes from other constants
            return false;
        });
    }

    return false;
}
