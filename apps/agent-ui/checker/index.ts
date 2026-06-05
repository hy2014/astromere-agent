// checker/index.ts
import * as path from "path";
// checker/index.ts 顶部已有的 import 基础上，确保有这两个
import * as fs from "fs";

import * as ts from "typescript";
import { checkRenderFns } from "./rules/check-render-fns";

import { Violation, RuleContext } from "./types";
import { getCodeLine, collectStateVars, collectPropVars } from "./utils";
import {checkViewLayer} from "./rules/check-view-layer";
import {checkWriteState} from "./rules/check-write-state";

// ...
export function check(sourceCode: string, fileName: string = "component.tsx"): Violation[] {
    const sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const stateVars = collectStateVars(sourceFile);

    const violations: Violation[] = [];
    const propVars = new Set<string>();
    const memoVars = new Set<string>();

    const ctx: RuleContext = {
        sourceFile,
        sourceCode,
        violations,
        stateVars,
        propVars,
        memoVars,
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

    const result = collectPropVars(sourceFile, ctx);
    result.propVars.forEach(v => ctx.propVars.add(v));

    // 从 View 函数体收集 memo 变量（从 state 派生的 const 变量）
    if (result.viewFn) {
        const viewBody = ts.isArrowFunction(result.viewFn)
            ? result.viewFn.body
            : (result.viewFn as ts.FunctionDeclaration).body;
        if (viewBody && ts.isBlock(viewBody)) {
            function collectMemoVars(node: ts.Node) {
                // 不进入嵌套的函数体
                if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
                    node !== viewBody) {
                    return;
                }
                if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
                    const varName = node.name.text;
                    if (stateVars.has(varName)) return;
                    const init = node.initializer;
                    if (!init) return;
                    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return;
                    let dependsOnState = false;
                    if (ts.isCallExpression(init)) {
                        const callee = init.expression;
                        if (ts.isIdentifier(callee) && (callee.text === "useMemo" || callee.text === "useCallback")) {
                            dependsOnState = true;
                        }
                    }
                    if (!dependsOnState) {
                        function checkRef(n: ts.Node) {
                            if (ts.isIdentifier(n) && (stateVars.has(n.text) || memoVars.has(n.text))) dependsOnState = true;
                            ts.forEachChild(n, checkRef);
                        }
                        checkRef(init);
                    }
                    if (dependsOnState) memoVars.add(varName);
                }
                ts.forEachChild(node, collectMemoVars);
            }
            viewBody.statements.forEach(collectMemoVars);
        }
    }

    // 调试打印
    console.log(`\n📌 搜集结果:`);
    console.log(`   View layer states: [${[...ctx.stateVars].join(", ")}]`);
    console.log(`   View layer props:  [${[...ctx.propVars].join(", ")}]`);
    console.log(`   View layer memos:  [${[...ctx.memoVars].join(", ")}]\n`);
    if (ctx.memoVars.size > 0) {
        console.log(`⚠️  提示: 检测到 ${ctx.memoVars.size} 个 memo 派生变量。memo 仅应在计算逻辑较重（遍历/过滤/排序大量数据等）时使用。`);
        console.log(`   轻量计算（简单取值、拼接、比较等）建议直接写在 renderFn 内部，不需要 memo 槽位。\n`);
    }

    checkRenderFns(ctx);
    checkViewLayer(ctx, result.viewFn)
    checkWriteState(ctx, result.viewFn);
    violations.sort((a, b) => (a.line || 0) - (b.line || 0));
    return violations.slice(0, 100);
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