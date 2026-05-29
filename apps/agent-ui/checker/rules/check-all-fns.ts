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

// export function checkAllFunctions(ctx: RuleContext) {
//     function visit(node: ts.Node) {
//         // 找到所有函数定义
//         if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
//             checkFnBody(node, ctx);
//         }
//         ts.forEachChild(node, visit);
//     }
//     visit(ctx.sourceFile);
// }
//
// function checkFnBody(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression, ctx: RuleContext) {
//
//     const body = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? fn.body : fn.body;
//     //
//     // const fnName = (fn as any).name?.text || (fn as any).name || 'anonymous';
//     // console.log('checking:', fnName, 'hasJSX:', hasJSX(body));
//
//     if (!body) return;
//     if (!hasJSX(body)) return;
//
//     function visitBody(node: ts.Node) {
//         if (ts.isCallExpression(node)) {
//             const callee = node.expression;
//             if (ts.isPropertyAccessExpression(callee) &&
//                 (callee.name.text === "map" || callee.name.text === "filter" || callee.name.text === "reduce")) {
//
//                 const callback = node.arguments[0];
//                 if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
//                     checkCallback(callback, ctx);
//                 }
//             }
//         }
//         ts.forEachChild(node, visitBody);
//     }
//     visitBody(body);
// }

export function checkAllFunctions(ctx: RuleContext, viewFn: ts.Node | null) {
    if (!viewFn) return;

    // console.log('viewFn:', viewFn)

    const body = ts.isArrowFunction(viewFn) ? viewFn.body : (viewFn as ts.FunctionDeclaration).body;
    if (!body) return;

    if (!hasJSX(body)) return; // View 本身无 JSX → 跳过

    // console.log('hasJSX:', hasJSX(body))

    function visitBody(node: ts.Node) {
        // 嵌套函数：如果是纯数据函数（无 JSX），整个子树跳过
        if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            if (!hasJSX(node)) return; // 不递归进入该函数体
            // 否则继续递归（例如内部又定义了有 JSX 的渲染函数）
        }

        if (ts.isCallExpression(node)) {
            const callee = node.expression;

            // console.log('call:', node.getText().substring(0, 80));

            if (ts.isPropertyAccessExpression(callee) &&
                (callee.name.text === "map" || callee.name.text === "filter" || callee.name.text === "reduce")) {
                ctx.addViolation(
                    "map 规范",
                    "有 JSX 的函数内不能使用 map/filter/reduce，请抽取为独立渲染函数。",
                    node
                );
            }
        }

        ts.forEachChild(node, visitBody);
    }

    visitBody(body);
}

function checkCallback(callback: ts.ArrowFunction | ts.FunctionExpression, ctx: RuleContext) {
    const body = callback.body;
    if (!body) return;

    console.log('callback body kind:', ts.SyntaxKind[body.kind]);

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