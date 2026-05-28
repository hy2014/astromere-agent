// checker/index.ts
import * as path from "path";
// checker/index.ts 顶部已有的 import 基础上，确保有这两个
import * as fs from "fs";

import * as ts from "typescript";
// import { RuleContext, Violation } from "./types";
// import { checkDepCalls } from "./rules/dep-call";
// import { getCodeLine } from "./utils";
// import {checkClassNameBinding} from "./rules/className-bindings";
// // checker/index.ts
// import { checkConditionalRender } from "./rules/conditional-render";
// import { checkAtomicBinding } from "./rules/atomic-binding";



import { Violation, RuleContext } from "./types";
import { getCodeLine, collectStateVars, collectPropVars } from "./utils";
import { checkDepCalls } from "./rules/dep-call";
import { checkClassNameBinding } from "./rules/className-bindings";
import { checkConditionalRender } from "./rules/conditional-render";
import { checkAtomicBinding } from "./rules/atomic-binding";
import {checkDerivedValues} from "./rules/derived-value";

// ...
export function check(sourceCode: string, fileName: string = "component.tsx"): Violation[] {
    const violations: Violation[] = [];
    const sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const stateVars = collectStateVars(sourceFile);
    const propVars = collectPropVars(sourceFile);

    const ctx: RuleContext = {
        sourceFile,
        sourceCode,
        violations,
        stateVars,
        propVars,
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

    // 按优先级检查，发现违规立即退出
    checkDerivedValues(ctx);
    if (violations.length > 0) return violations;

    checkDepCalls(ctx);
    if (violations.length > 0) return violations;

    checkClassNameBinding(ctx);
    if (violations.length > 0) return violations;

    checkAtomicBinding(ctx);
    if (violations.length > 0) return violations;
    // ...
    // checkDepCalls(ctx);
    // checkClassNameBinding(ctx);
    // // checkConditionalRender(ctx);
    // checkAtomicBinding(ctx);
    // checkDerivedValues(ctx)

    return violations;
}

// checker/index.ts 末尾加上
function main() {
    const args = process.argv.slice(2);

    if (args.includes("--help") || args.includes("-h")) {
        console.log("Usage: npx tsx checker/index.ts --file <path>");
        process.exit(0);
    }

    const fileIndex = args.indexOf("--file");
    const fIndex = args.indexOf("-f");
    let filePath = "";

    if (fileIndex !== -1 && args.length > fileIndex + 1) {
        filePath = args[fileIndex + 1];
    } else if (fIndex !== -1 && args.length > fIndex + 1) {
        filePath = args[fIndex + 1];
    }

    if (!filePath) {
        console.error("错误：请指定文件路径。使用 --file <path>");
        process.exit(1);
    }
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
        console.error(`错误：文件不存在 - ${absolutePath}`);
        process.exit(1);
    }

    const sourceCode = fs.readFileSync(absolutePath, "utf-8");
    const fileName = path.basename(absolutePath);
    const violations = check(sourceCode, fileName);

    if (violations.length > 0) {
        console.log(`\n❌ 发现 ${violations.length} 条违规：\n`);
        violations.forEach((v, idx) => {
            console.log(`  ${idx + 1}. [${v.rule}] ${v.message}`);
            if (v.line) console.log(`     行 ${v.line}: ${v.codeLine}`);
            console.log();
        });
        process.exit(1);
    } else {
        console.log("✅ 检查通过");
        process.exit(0);
    }
}

// 直接运行时执行
if (import.meta.url && process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
    main();
}