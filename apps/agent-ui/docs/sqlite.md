# sqlite — SQLite schema & migration

Module: `src-tauri/src/sqlite.rs`
Persisted DB path: `~/.agent-ui/sqlite/agent-ui.db`（由 `ui_config_dir()` 决定）。

## 职责

所有 Component / DAG / 执行元数据的存储层。`open_sqlite_database()` 在每个命令里打开连接，
并调用 `ensure_component_tables()` 保证表存在。

## 表结构（当前）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `components` | `id, name, description, status, workspace_root, git_url, git_branch, git_ref, entry_point, input_schema, output_schema, tags, global, created_at_ms, updated_at_ms` | **组件定义表**：身份/生命周期 + 会话锚点 + 可运行定义。`status`: draft/exploring/generated/published/deprecated。`git_url`/`git_branch`/`git_ref` = git 来源（**配置真相源**）；`entry_point` = git 入口文件相对路径（如 `run.py`）；`input_schema`/`output_schema` = IO 端口定义。`global` (`INTEGER` 0/1，默认 0)：`1` = 已在「组件」注册表、可被多 DAG 复用的组件；`0` = 通用组件（拖拽即建、非共享、不进注册表列表）。`workspace_root` 为**遗留 deprecated 列**（保留以避免危险 DROP 重建，逻辑上不再使用；会话路径已由 `component_id` 承担）。注册/通用组件都写本表；拖拽组件到画布只写 `dag_nodes`(引用 `component_id`)，实现跨 DAG 复用。 |
| `component_sessions` | `id, component_id, session_id, session_path, title, created_at_ms, updated_at_ms` | 组件↔Code 模式会话关联，FK 级联删除 |
| `dags` | `id, name, description, status, execution_order, created_at_ms, updated_at_ms` | 顶层组件集合。`execution_order` = 发布时的拓扑序 JSON 数组；`status`: draft/published/archived |
| `dag_nodes` | `id, dag_id, component_id, label, pos_x, pos_y, config` | 画布节点（组件**实例**），FK 级联删除。`component_id` **正常流程恒非空**：拖拽「组件」分组的**已注册组件**即写一条引用该 `component_id` 的节点（不再拖拽时新建空白组件）。`config` 为 JSON 文本列，是组件配置的**运行时缓存**；`build_snapshot` 在提交时把 `components` 的 git 配置并入，故历史回看正确，最终可停用（见 Deferred）。 |
| `dag_edges` | `id, dag_id, source_node_id, target_node_id, source_handle, target_handle` | 画布边（依赖关系） |
| `dag_executions` | `id, dag_id, status, trigger_kind, started_at_ms, completed_at_ms, outputs, worker_id, claimed_at_ms` | 执行记录（producer-consumer 队列）。`trigger_kind`: manual/cron/api；`status`: submit/accepted/success/failed/cancelled（见 [docs/engine-executor.md](engine-executor.md)）；`worker_id`/`claimed_at_ms` 为 Python 引擎原子领取租约位 |
| `node_executions` | `id, execution_id, node_id, status, started_at_ms, completed_at_ms, output_path, error` | 单节点运行状态（方案 B，第三层 runtime instance）。`status`: preparing/running/success/failed/cancelled |
| `execution_logs` | `id, execution_id, node_id, level, message, timestamp_ms` | 执行日志（worker 实时写入，UI 轮询） |

索引：`idx_components_workspace`、`idx_component_sessions_component`、
`idx_dag_nodes_dag`、`idx_dag_edges_dag`、`idx_dag_executions_dag`。

### dag_nodes.config 形状

`config` 是 `dag_nodes` 上的 TEXT(JSON) 列，承载**节点实例配置**。按 2026-07-10-clean-node-config.md，
**活的 node.config 只含实例参数 `params`**；组件定义级字段（git 来源 / IO 端口 / 名称）的真相源是
`components` 表，不冗余存于 node.config：

| 字段 | 类型 | 说明 |
|---|---|---|
| `params` | `Record<string, unknown>` | 实例参数 key/value（节点级，唯一活在 node.config 的字段） |

- git 来源（`git_url`/`git_branch`/`git_ref`/`entry_point`）、`name`、IO 端口 → 全在 `components` 表；
  画布渲染端口读 `component`，画布标题 = `dag_nodes.label || component.name`（节点显示名兜底组件名）。
- `dag_nodes.label`（TEXT，可空）= **节点实例级显示名**，仅属该画布节点、不影响 `components` 表与其它 DAG。
  前端入口：节点「配置」tab 顶部「节点名称」字段（`NodeNameField`）→ `update_dag` 全量写回；留空则显示组件名。
  （历史遗留：早前无入口、恒为 `""`，2026-07-11 已补入口。）
- `build_snapshot`（提交运行时）把 `components` 的 git/entryPoint/`configSchema`/`name` **注入冻结快照**
  （`dag_executions.snapshot`），使历史运行自洽；Python `worker.resolve_node` 优先读 `components`，
  回退读快照里的 `cfg`。活 node.config 不参与 git 解析。
- 迁移：`migrate_node_config_to_params_only`（每次开库幂等、best-effort）把**有可解析组件**的节点
  config 收敛为 `{"params": ...}`，剥掉冗余 git/IO/name；**无组件节点**（git 来源只存于 node.config）原样保留，避免失去运行源。
> `run_dag` 把 `nodes(含 config)` 冻结进 `dag_executions.snapshot`（见 [docs/dag.md](dag.md) 运行快照），
> 历史回看能重现当时配置。

## 迁移规则（关键约定）

`ensure_component_tables()` **严禁无条件 DROP**。当前逻辑：

1. `legacy_component_schema_present()` 检测 `components` 表是否仍带旧 `project_id` 列。
2. 仅当检测到**旧 schema** 时，一次性 DROP 旧表并重建（迁移恰好一次）。
3. 否则一律 `CREATE TABLE IF NOT EXISTS`，保留数据。
4. 仍会清理更早期遗留的 `component_explorations` 表。

> 未来任何 schema 变更都必须走“迁移或 `IF NOT EXISTS`”路径，不得加回无条件 DROP（不丢数据约定）。

### 可空 `component_id` 迁移（2026-07-08）

通用组件实例（`component_id` 为空）此前因 `dag_nodes.component_id` 带
`NOT NULL REFERENCES components(id)` 而无法持久化。修复方式：`ensure_component_tables()`
调用 `relax_dag_nodes_component_id()` —— 当该列当前为 `NOT NULL` 时，临时 `PRAGMA
foreign_keys=OFF` 后重建表（`CREATE TABLE dag_nodes_new` → `INSERT ... SELECT` →
`DROP` → `RENAME` → 重建 `idx_dag_nodes_dag` → 恢复 `foreign_keys=ON`），把列改为可空、
保留 FK（仅非空值被校验）。幂等：已为可空的库直接跳过。仍遵守"不丢数据"约定。

### 删除遗留 `shared` 列（2026-07-09）

`components` 表曾有一列 `shared`（注册标志的原名），后改名为 `global`（`add_column_if_missing`
加 `global`），`shared` 因 no-drop 约定被保留成死列——没有任何 Rust/TS/Python 代码读写它。
清理方式：`ensure_component_tables()` 调用 `drop_components_shared_column()` —— 当 `shared`
列存在时，临时 `PRAGMA foreign_keys=OFF` 后从 `pragma_table_info` 重建 DDL（排除 `shared`、
保留其余列与全部行）→ `INSERT ... SELECT` → `DROP` 旧表 → `RENAME` 新表 → 恢复
`foreign_keys=ON`，并仅在 `workspace_root` 列存在时重建 `idx_components_workspace`。幂等：
列已不存在时直接跳过。仍遵守"不丢数据"约定。

## 测试

集成测试用临时 `$HOME` 指向临时库，避免污染真实 DB。
