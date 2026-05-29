// checker/rules/check-all-fns.ts
import * as ts from "typescript";
import { RuleContext } from "../types";

function hasJSX(node: ts.Node): boolean {
    let found = false;
    function find(n: ts.Node) {
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
            found = true;
            return;
        }
        ts.forEachChild(n, find);
    }
    find(node);
    return found;
}

export function checkAllFunctions(ctx: RuleContext) {
    function visit(node: ts.Node) {
        // 找到所有函数定义
        if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            checkFnBody(node, ctx);
        }
        ts.forEachChild(node, visit);
    }
    visit(ctx.sourceFile);
}

function checkFnBody(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression, ctx: RuleContext) {

    const body = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? fn.body : fn.body;
    if (!body) return;
    if (!hasJSX(body)) return;

    function visitBody(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isPropertyAccessExpression(callee) &&
                (callee.name.text === "map" || callee.name.text === "filter" || callee.name.text === "reduce")) {
                const callback = node.arguments[0];
                if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
                    checkCallback(callback, ctx);
                }
            }
        }
        ts.forEachChild(node, visitBody);
    }
    visitBody(body);
}

function checkCallback(callback: ts.ArrowFunction | ts.FunctionExpression, ctx: RuleContext) {
    const body = callback.body;
    if (!body) return;

    let jsxNode: ts.Node | undefined;

    if (ts.isJsxElement(body) || ts.isJsxSelfClosingElement(body) || ts.isJsxFragment(body)) {
        jsxNode = body;
    } else if (ts.isBlock(body)) {
        const returnStmt = body.statements.find(ts.isReturnStatement);
        if (returnStmt && returnStmt.expression) {
            const ret = returnStmt.expression;
            if (ts.isJsxElement(ret) || ts.isJsxSelfClosingElement(ret) || ts.isJsxFragment(ret)) {
                jsxNode = ret;
            }
        }
    }

    // 不返回 JSX 的回调（如数据转换操作）是合法的，跳过检查
    if (!jsxNode) return;

    // Fragment 允许
    if (ts.isJsxFragment(jsxNode)) return;

    // 检查标签名
    let tagName: string;
    if (ts.isJsxElement(jsxNode)) {
        tagName = jsxNode.openingElement.tagName.getText();
    } else if (ts.isJsxSelfClosingElement(jsxNode)) {
        tagName = jsxNode.tagName.getText();
    } else {
        return;
    }

    // 小写开头 = 原生标签，不允许
    if (/^[a-z]/.test(tagName)) {
        ctx.addViolation(
            "map 回调规范",
            `map 回调中不能返回原生 HTML 标签 "<${tagName}>"，请抽取为子组件（大写开头）。`,
            jsxNode
        );
    }
}