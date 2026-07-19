// checker/index.ts
import * as path from "path";
// On top of the existing imports in checker/index.ts, make sure these two are present
import * as fs from "fs";

import * as ts from "typescript";
import { checkRenderFns } from "./rules/check-render-fns";

import { Violation, RuleContext } from "./types";
import { getCodeLine, collectStateVars, collectPropVars, resolveImportedViewFns } from "./utils";
import {checkViewLayer} from "./rules/check-view-layer";
import {checkWriteState} from "./rules/check-write-state";
import {checkRenderView} from "./rules/check-render-view";
import {checkUseCallback} from "./rules/check-use-callback";
import {checkPropsFlow} from "./rules/check-props-flow";
import {checkNoMutableModuleVars} from "./rules/check-no-mutable-module-vars";

// ...
export function check(sourceCode: string, fileName: string = "component.tsx", fsPath?: string): Violation[] {
    let sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const stateVars = collectStateVars(sourceFile);

    const violations: Violation[] = [];
    const propVars = new Set<string>();
    const memoVars = new Set<string>();

    // Create TypeChecker (do not resolve node_modules; current file types suffice)
    let typeChecker: ts.TypeChecker | undefined;
    if (fsPath) {
        try {
            const projectRoot = path.dirname(fsPath);
            let configPath: string | undefined;
            let dir = projectRoot;
            while (dir.length > 1) {
                const candidate = path.join(dir, "tsconfig.json");
                if (fs.existsSync(candidate)) { configPath = candidate; break; }
                dir = path.dirname(dir);
            }
            let parsedConfig: ts.ParsedCommandLine;
            if (configPath) {
                const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
                parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
            } else {
                parsedConfig = ts.parseJsonConfigFileContent({ compilerOptions: { target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.ReactJSX } }, ts.sys, projectRoot);
            }
            parsedConfig.options.skipLibCheck = true;
            parsedConfig.options.skipDefaultLibCheck = true;
            parsedConfig.options.noUnusedLocals = false;
            parsedConfig.options.noUnusedParameters = false;
            const host = ts.createCompilerHost(parsedConfig.options);
            const program = ts.createProgram([fsPath], parsedConfig.options, host);
            typeChecker = program.getTypeChecker();
            const programSf = program.getSourceFile(fsPath);
            if (programSf) sourceFile = programSf;
        } catch {
            // Gracefully degrade when TypeChecker is unavailable
        }
    }

    const ctx: RuleContext = {
        sourceFile,
        sourceCode,
        violations,
        stateVars,
        propVars,
        memoVars,
        importedViewFns: new Set<string>(),
        typeChecker,
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

    // Resolve imported viewFn (cross-file verification)
    if (fsPath) {
        const importedViewFns = resolveImportedViewFns(sourceFile, fsPath);
        importedViewFns.forEach(v => ctx.importedViewFns.add(v));
    }

    const result = collectPropVars(sourceFile, ctx);
    result.propVars.forEach(v => ctx.propVars.add(v));

    const eventCallbackVars = new Set<string>();

    // Collect memo vars from the View function body (const vars derived from state)
    if (result.viewFn) {
        const viewBody = ts.isArrowFunction(result.viewFn)
            ? result.viewFn.body
            : (result.viewFn as ts.FunctionDeclaration).body;
        if (viewBody && ts.isBlock(viewBody)) {
            function collectMemoVars(node: ts.Node) {
                // Do not enter nested function bodies
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
                    // Skip pure aliases: const X = Y (Y already in state/memo); X is an alias, not a derived value
                    if (ts.isIdentifier(init) && (stateVars.has(init.text) || memoVars.has(init.text))) return;
                    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
                        const calleeText = init.expression.text;
                        if (calleeText === "useMemo") {
                            memoVars.add(varName);
                        }
                        if (calleeText === "useCallback") {
                            eventCallbackVars.add(varName);
                        }
                    }
                }
                ts.forEachChild(node, collectMemoVars);
            }
            viewBody.statements.forEach(collectMemoVars);
        }
    }

    // Debug print
    console.log(`\n📌 搜集结果:`);
    console.log(`   View layer states: [${[...ctx.stateVars].join(", ")}]`);
    console.log(`   View layer props:  [${[...ctx.propVars].join(", ")}]`);
    console.log(`   View layer memos:  [${[...ctx.memoVars].join(", ")}]`);
    if (eventCallbackVars.size > 0) {
        console.log(`   View layer event callbacks: [${[...eventCallbackVars].join(", ")}]\n`);
    } else {
        console.log(``);
    }
    if (ctx.memoVars.size > 0) {
        console.log(`⚠️  提示: 检测到 ${ctx.memoVars.size} 个 memo 派生变量。memo 仅应在计算逻辑较重（遍历/过滤/排序大量数据等）时使用。`);
        console.log(`   轻量计算（简单取值、拼接、比较等）建议直接写在 renderFn 内部，不需要 memo 槽位。\n`);
    }

    checkRenderFns(ctx, result.viewFn);
    checkViewLayer(ctx, result.viewFn)
    checkWriteState(ctx, result.viewFn);
    checkRenderView(ctx, result.viewFn, fsPath);
    checkUseCallback(ctx, result.viewFn);
    checkPropsFlow(ctx, result.viewFn);
    checkNoMutableModuleVars(ctx, result.viewFn);
    violations.sort((a, b) => (a.line || 0) - (b.line || 0));
    return violations.slice(0, 100);
}

// Add at the end of checker/index.ts
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
    const violations = check(sourceCode, fileName, absolutePath);

    if (violations.length > 0) {
        console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                      View 架构核心规则                              ║
╚══════════════════════════════════════════════════════════════════════╝

────────────────────────────────────────────────────────────────────
三层渲染模型
────────────────────────────────────────────────────────────────────
  View (React 组件)      → 根节点，声明 state/props/events/memo 四槽
  renderFn(state, props,  → 中间层，渲染逻辑从 View 提取
            events, memo)
  renderView({ fn, props }) → 叶子节点，调其他文件的 View 组件

────────────────────────────────────────────────────────────────────
数据流原则：层层传递，单向追溯
────────────────────────────────────────────────────────────────────
  1. View 定义四种槽的合法值
  2. render() 调用只能从父层同名槽取子集下传
  3. renderView 的 props 只能来自当前层的 state/props/events
  4. 不能跨槽传递，不能凭空计算，不能用 any 跳过检查
  5. checker 的作用：强制数据溯源。每条违规都意味着数据来源不可追踪

────────────────────────────────────────────────────────────────────
禁止做的操作
────────────────────────────────────────────────────────────────────
  • state: any / props: any / events: any / memo: any（断溯源）
  • 不经过 renderFn 直接调用 View 组件
  • 不在最外层定义的函数引用外部变量（包括默认参数绕过）
  • renderFn 内部禁止 hooks
  • View 组件不能出现在函数参数中

────────────────────────────────────────────────────────────────────
`);

        console.log(`❌ 发现 ${violations.length} 条违规：\n`);
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

// Execute when run directly
if (import.meta.url && process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
    main();
}