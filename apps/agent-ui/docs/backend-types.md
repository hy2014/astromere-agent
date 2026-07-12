# backend-types — shared Rust types

Module: `src-tauri/src/types.rs`
Related: [docs/components.md](components.md), [docs/dag.md](dag.md), [docs/sqlite.md](sqlite.md)

## 职责

定义后端所有命令的入参 / 返回类型，与前端 `src/types.ts` 对应（camelCase 互转）。

## 领域分组

- **Component / DAG 平台类型**：`Component`、`ComponentSession`、`Dag`、`DagNode`、
  `DagEdge`、`DagDetail`、`DagExecution`、`ExecutionLog`。即前端 Code / DAG 模式对接的契约
  （详见各子模块文档）。
- **Agent / REPL 运行时类型**（镜像前端运行时）：`WorkspaceState` / `WorkspaceRegistry`、
  `AgentReplProcessState` / `AgentReplProcessStatus`、`AgentReplStreamEvent`、
  `RuntimeSessionSummary` / `RuntimeSessionDetail` / `RuntimeSessionMessage`、
  `AgentPermissionState` / `PermissionMode`、`ContextUsage*`、`SkillsReport` / `SkillSummary`、
  `SqliteDatabaseInfo`。
- **模型 / 用量**：`ModelSettings` / `ModelEndpointConfig`、`ModelCallUsage*`、
  `DeepSeekPricing*`、`McpSettings`、`LocalImagePreview` / `LocalImageMetadata`。

## 约定

- 所有类型 `#[derive(Serialize, Deserialize)]` + `#[serde(rename_all = "camelCase")]`。
- `lib.rs` 负责 `pub mod` 模块装配；`main.rs` 负责 `#[tauri::command]` 注册
  （命令面已分散记录在各子模块文档）。
