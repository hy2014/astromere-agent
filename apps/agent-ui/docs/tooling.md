# tooling — dev-time static analysis (checker / parser)

Module: `checker/`, `parser/`, `extract-calls.ts`（仓库根，**不在 `src/`**）
Related: 无运行时依赖

## 职责

给开发者做静态架构检查的 CLI 脚本，运行于 Node（`tsx`），**不参与前端打包**。它们用于
校验本项目的“三层渲染模型”（View / renderFn / renderView）与生成代码依赖图，辅助理解
与文档生成。

## checker/

- 架构规则检查器：CLI `npx tsx checker/index.ts --file <path>`。
- 基于 `typescript` 编译器解析三层渲染模型，依次运行 `checker/rules/` 下 8 条规则
  （render-fns、view-layer、write-state、render-view、use-callback、props-flow、
  no-mutable-module-vars 等），输出违规。
- `checker/vibe/`：AST 分析辅助（assign / loop / try / fn / state / write-state 提取器）。
- `checker/types.ts` / `utils.ts`：`Violation` / `RuleContext` 等。

## parser/

- 代码图生成器：CLI `npx tsx parser/index.ts --dir src --output code-graph.json`。
- `parser/parser.ts`：用 `ts-morph` 解析全部 `.tsx` / `.ts`，产出 `code-graph.json`
  （views + fns 及其 writes / ipcs / views 依赖）。
- `parser/types.ts`：`CodeGraph` / `ViewNode` / `FnDetail` / `StateInfo` / `PropInfo` /
  `ClassifiedCall`。

## extract-calls.ts

一次性提取脚本（`parser/` 的前身 / 简化版）：用 `ts-morph` 从指定文件（默认
`WorktreePanel.tsx`）提取 states / props / IPC 方法 / useEffect / JSX 事件 / render 绑定 /
文件级函数调用，用于辅助理解 / 生成文档。
