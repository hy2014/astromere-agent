// checker/index.ts
import * as ts from "typescript";
import { RuleContext, Violation } from "./types";
import { checkDepCalls } from "./rules/dep-call";
import { getCodeLine } from "./utils";
import {checkClassNameBinding} from "./rules/className-bindings";
// checker/index.ts
import { checkConditionalRender } from "./rules/conditional-render";
import { checkAtomicBinding } from "./rules/atomic-binding";


// ...
export function check(sourceCode: string, fileName: string = "component.tsx"): Violation[] {
    const violations: Violation[] = [];
    const sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const ctx: RuleContext = {
        sourceFile,
        sourceCode,
        violations,
        addViolation(rule: string, message: string, node?: ts.Node) {
            const line = node
                ? sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
                : undefined;
            violations.push({
                rule,
                message,
                node,
                line,
                codeLine: line ? getCodeLine(sourceCode, line) : undefined,
            });
        },
    };

    // ...
    checkDepCalls(ctx);
    checkClassNameBinding(ctx);
    checkConditionalRender(ctx);
    checkAtomicBinding(ctx);


    return violations;
}