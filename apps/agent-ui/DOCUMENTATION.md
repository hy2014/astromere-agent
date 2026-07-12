# Documentation Index

本仓库文档采用**模块索引 + 子模块文档**组织：根索引只做模块/子模块的导航；
`docs/` 为平铺的子模块文档。

## Backend (Rust / Tauri)

| 子模块 | 简介 | 文档 |
|---|---|---|
| sqlite | SQLite schema 与迁移（禁止无条件 DROP） | [docs/sqlite.md](docs/sqlite.md) |
| components | Component 模型与 CRUD（workspace_root + entry_point） | [docs/components.md](docs/components.md) |
| dag | DAG 发布与拓扑排序 | [docs/dag.md](docs/dag.md) |
| executor | 单节点 Python 执行与 venv（**本地调试**路径，见 engine-executor） | [docs/executor.md](docs/executor.md) |
| engine-executor | Python 执行引擎（producer-consumer，消费 submit 任务） | [docs/engine-executor.md](docs/engine-executor.md) |
| scheduler | DAG 调度与执行（run_dag 仅提交，执行交 Python） | [docs/scheduler.md](docs/scheduler.md) |
| component-session | Component ↔ Code 模式 session 关联 | [docs/component-session.md](docs/component-session.md) |
| backend-types | types.rs 共享类型（Rust） | [docs/backend-types.md](docs/backend-types.md) |
| backend-utils | utils.rs 共享 helper | [docs/backend-utils.md](docs/backend-utils.md) |

## Frontend (React / TypeScript)

| 子模块 | 简介 | 文档 |
|---|---|---|
| mode-toggle | 左上角 Code / DAG 分段开关 | [docs/mode-toggle.md](docs/mode-toggle.md) |
| code-mode | Agent REPL 对话主界面 | [docs/code-mode.md](docs/code-mode.md) |
| app-shell | 应用外壳、导航与会话状态 | [docs/app-shell.md](docs/app-shell.md) |
| runtime | 本地 / 远程运行时抽象 | [docs/runtime.md](docs/runtime.md) |
| streaming | REPL 流式事件管线 | [docs/streaming.md](docs/streaming.md) |
| preview | 右侧预览标签页 | [docs/preview.md](docs/preview.md) |
| settings | 设置 / 模型 / 远程 / Skills / MCP / 用量 | [docs/settings.md](docs/settings.md) |
| terminal | OS 终端（xterm） | [docs/terminal.md](docs/terminal.md) |
| component-mode | DAG 画布与组件面板（DAG 模式 UI） | [docs/component-mode.md](docs/component-mode.md) |
| dag-interaction-map | DAG 模式全部交互的端到端链路 + 落库表 | [docs/dag-interaction-map.md](docs/dag-interaction-map.md) |
| error-boundary | 渲染崩溃兜底（ErrorBoundary 类组件） | [docs/error-boundary.md](docs/error-boundary.md) |

## Tooling (dev-time, non-runtime)

| 子模块 | 简介 | 文档 |
|---|---|---|
| tooling | checker / parser 静态分析脚本 | [docs/tooling.md](docs/tooling.md) |
