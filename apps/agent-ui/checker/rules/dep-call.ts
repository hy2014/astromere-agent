// checker/rules/dep-call.ts
import * as ts from "typescript";
import { RuleContext } from "../types";
import { isInsideEffect, isInsideEventHandler } from "../utils";

export function checkDepCalls(ctx: RuleContext) {
    function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isIdentifier(callee) && callee.text === "dep") {
                checkDepCall(node, ctx);
            }
        }
        ts.forEachChild(node, visit);
    }

    visit(ctx.sourceFile);
}

function isStateVar(node: ts.Node, stateVars: Set<string>): boolean {
    // 单一 state 变量: dep(state, props, fn)
    if (ts.isIdentifier(node)) return stateVars.has(node.text);
    // state 子集对象: dep({ count, name }, props, fn)
    if (ts.isObjectLiteralExpression(node)) {
        // return node.properties.every((prop) =>
        //     ts.isPropertyAssignment(prop) &&
        //     ts.isIdentifier(prop.initializer) &&
        //     stateVars.has(prop.initializer.text)
        // );

        return node.properties.every(
            (prop) => ts.isShorthandPropertyAssignment(prop) && stateVars.has(prop.name.text)
        );
    }
    return false;
}

function isPropVar(node: ts.Node, propVars: Set<string>): boolean {
    // 单一 props 变量: dep(state, props, fn)
    if (ts.isIdentifier(node)) return propVars.has(node.text);
    // props 子集对象: dep(state, { session, project }, fn)
    if (ts.isObjectLiteralExpression(node)) {
        // return node.properties.every((prop) =>
        //     ts.isPropertyAssignment(prop) &&
        //     ts.isIdentifier(prop.initializer) &&
        //     propVars.has(prop.initializer.text)
        // );
        return node.properties.every(
            (prop) => ts.isShorthandPropertyAssignment(prop) && propVars.has(prop.name.text)
        );
    }
    return false;
}

function checkDepCall(call: ts.CallExpression, ctx: RuleContext) {
    // 参数数量
    if (call.arguments.length !== 3) {
        ctx.addViolation(
            "dep 调用规范",
            `dep() 需要恰好 3 个参数，实际传入 ${call.arguments.length} 个。`,
            call
        );
        return;
    }

    // 第一个参数必须是 state 变量或 state 子集对象
    const firstArg = call.arguments[0];
    if (!isStateVar(firstArg, ctx.stateVars)) {
        ctx.addViolation(
            "dep 调用规范",
            "dep() 第一个参数必须是 state 变量或 state 子集对象 `{ count, name }`。",
            firstArg
        );
    }

    // 第二个参数必须是 props 变量或 props 子集对象
    const secondArg = call.arguments[1];
    if (!isPropVar(secondArg, ctx.propVars)) {
        ctx.addViolation(
            "dep 调用规范",
            "dep() 第二个参数必须是 props 变量或 props 子集对象 `{ session, project }`。",
            secondArg
        );
    }

    // 禁止内联函数
    const thirdArg = call.arguments[2];
    if (ts.isArrowFunction(thirdArg) || ts.isFunctionExpression(thirdArg)) {
        ctx.addViolation(
            "dep 调用规范",
            "dep() 第三个参数必须是命名函数引用，禁止内联函数。",
            thirdArg
        );
    }

    // 禁止在副作用中
    if (isInsideEffect(call)) {
        ctx.addViolation(
            "dep 调用规范",
            "dep() 不能在 useEffect/useLayoutEffect 中使用。",
            call
        );
    }

    // 禁止在事件处理器中
    if (isInsideEventHandler(call)) {
        ctx.addViolation(
            "dep 调用规范",
            "dep() 不能在事件处理函数中使用。",
            call
        );
    }
}

// ... isInsideEffect / isInsideEventHandler 等辅助函数