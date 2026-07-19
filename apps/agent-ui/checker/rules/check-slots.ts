// checker/rules/check-slots.ts
import * as ts from "typescript";
import { RuleContext } from "../types";
import type { RenderFnInfo } from "./check-events";

function isIdentifierUsed(scope: ts.Node, name: string): boolean {
    let used = false;
    function visit(n: ts.Node) {
        if (ts.isIdentifier(n) && n.text === name) {
            if (!(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
                used = true;
                return;
            }
        }
        ts.forEachChild(n, visit);
    }
    visit(scope);
    return used;
}

import { getFunctionBody } from "./check-events";

export function checkSlots(ctx: RuleContext, renderFns: RenderFnInfo[]): void {
    for (const rf of renderFns) {
        const body = getFunctionBody(rf.node);
        if (!body) continue;

        // ── state check ──
        const unusedState = rf.stateParams.filter(v => !isIdentifierUsed(body, v));
        if (unusedState.length > 0) {
            ctx.addViolation(
                "renderFn 未使用 state",
                `renderFn "${rf.name}" 中 state 变量未使用: ${unusedState.join(", ")}`,
                rf.node
            );
        }

        const unknownStates = rf.stateParams.filter(v => !ctx.stateVars.has(v));
        if (unknownStates.length > 0) {
            ctx.addViolation(
                "renderFn state 检查",
                `renderFn "${rf.name}" 解构了未声明的 state: ${unknownStates.join(", ")}，View 层 states: [${[...ctx.stateVars].join(", ")}]`,
                rf.node
            );
        }

        // ── props check ──
        const unusedProps = rf.propsParams.filter(v => !isIdentifierUsed(body, v));
        if (unusedProps.length > 0) {
            ctx.addViolation(
                "renderFn 未使用 props",
                `renderFn "${rf.name}" 中 props 变量未使用: ${unusedProps.join(", ")}`,
                rf.node
            );
        }

        if (ctx.propVars) {
            const unknownProps = rf.propsParams.filter(v => !ctx.propVars!.has(v));
            if (unknownProps.length > 0) {
                ctx.addViolation(
                    "renderFn props 检查",
                    `renderFn "${rf.name}" 解构了未声明的 props: ${unknownProps.join(", ")}`,
                    rf.node
                );
            }
        }

        // ── memo check ──
        if (rf.memoParams.length > 0) {
            const unknownMemos = rf.memoParams.filter(v => !ctx.memoVars.has(v));
            if (unknownMemos.length > 0) {
                ctx.addViolation(
                    "renderFn memo 检查",
                    `renderFn "${rf.name}" 解构了未声明的 memo: ${unknownMemos.join(", ")}，View 层 memos: [${[...ctx.memoVars].join(", ")}]`,
                    rf.node
                );
            }
        }

        // ── ext slot misuse check ──
        if (rf.extParamName) {
            const params = rf.node.parameters;
            if (params.length >= 4) {
                const extType = params[3].type;
                if (extType && ts.isTypeLiteralNode(extType)) {
                    for (const member of extType.members) {
                        if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name)) continue;
                        const propName = member.name.text;

                        if (ctx.stateVars.has(propName)) {
                            ctx.addViolation(
                                "renderFn 参数规范",
                                `renderFn "${rf.name}" 的 ext 参数包含 state 变量 "${propName}"，应放在 state 槽位`,
                                member
                            );
                        }
                        if (ctx.propVars && ctx.propVars.has(propName)) {
                            ctx.addViolation(
                                "renderFn 参数规范",
                                `renderFn "${rf.name}" 的 ext 参数包含 props 变量 "${propName}"，应放在 props 槽位`,
                                member
                            );
                        }
                        if (ctx.memoVars && ctx.memoVars.has(propName)) {
                            ctx.addViolation(
                                "renderFn 参数规范",
                                `renderFn "${rf.name}" 的 ext 参数包含 memo 变量 "${propName}"，应放在 memo 槽位`,
                                member
                            );
                        }
                    }
                }
            }
        }
    }
}
