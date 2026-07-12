# dag — DAG publish & topology

Module: `src-tauri/src/dag.rs`
Related: [docs/components.md](components.md), [docs/scheduler.md](scheduler.md)

## 概念

DAG 是**顶层命名的组件集合**。画布上的节点（`dag_nodes`）引用一个 Component，
边（`dag_edges`）表达节点间的依赖（执行顺序）。一个 Component 可被多个 DAG 引用。

## 节点配置（node.config = 组件在某 DAG 的实例配置）

`dag_nodes.config` 是**节点级**配置（每行节点自己的 JSON 列），即"这个组件实例在这个 DAG 里的配置"。
注意它与 `dags` 表（DAG 级，只含 name/cron/status/execution_order）不同 —— **不存在"DAG 的 config blob"**。

- 同一组件在一个 DAG 里摆两次（两个节点）→ 各有独立的 `config`。
- 内容（活 node.config）：**仅实例参数 `params`**（按 `components.config_schema` 填的值）。
  组件定义级字段（git 来源 / IO 端口 / 名称）在 `components` 表，不冗余存于 node.config。
- `build_snapshot` 在 `run_dag` 提交时把 `components` 的 git/entryPoint/`configSchema`/`name`
  **注入**冻结进 `dag_executions.snapshot`（而非读取活 node.config 的冗余字段），
  运行中途改 DAG 不影响本次运行（见 [docs/components.md](components.md) 三层模型）。

## 边与 IO 映射（dag_edges = 端口级）

`dag_edges` 用 `source_handle → target_handle` 做**端口级**连线，表达"上游某输出端口喂给下游某输入端口"。

- 运行产物按**输出端口 key** 索引（如 `outputs: {"data": "/path/a.csv", "metrics": "/path/m.json"}`），
  `engine_executor/worker.py` 的 `build_input` 据边把上游输出地址作为下游 input 地址，组装 `input.json` 执行下游 `run.py`。
- 多输出 → 多下游时，各下游按自己的边取对应的那份输出地址。

### handle 命名约定（2026-07-11 修复）

连线在 UI 与引擎之间有两套命名，需一层对接：

- **UI 侧（连接层）**：端口 `Handle` 的 `id` 带方向前缀——输出 `out:${端口名}`、输入 `in:${端口名}`。
  连线后这两个 id 原样存入 `dag_edges.source_handle` / `target_handle`（如 `out:outputFile` / `in:Input`）。
- **数据层**：组件 `run.py` 写出的输出字典 key 是**裸端口名**（如 `{"outputFile": {...}}`）。

**引擎在按 handle 取值前必须先 `strip_prefix("out:")` / `strip_prefix("in:")`**，
才能用裸名命中输出字典。该兼容**仅在 Python `engine_executor/worker.py` 的 `build_input` 一处实现**——
Rust 同步执行路径（`build_node_inputs`）已于 2026-07-11 删除，不再有第二份边路由逻辑，避免重复实现漂移。

哨兵 `"output"` / `"input"`（单端口组件专用，特判为"取/合并整个输出"）不以 `out:`/`in:` 开头，
strip 后不变，单端口逻辑完全保留。

## 命令（Tauri commands）

| 命令 | 说明 |
|---|---|
| `list_dags()` | 列出所有 DAG |
| `get_dag(dag_id)` | 取 DAG 详情（含 nodes / edges） |
| `create_dag(name)` | 新建 DAG（无 `project_id`） |
| `update_dag(dag, nodes, edges)` | 保存画布节点/边 |
| `delete_dag(dag_id)` | **物理删除**：事务内显式 `DELETE` 子表 `dag_nodes`/`dag_edges`/`dag_executions`/`execution_logs` 后再删 `dags` 行，不写软删标记（与 `component_sessions` 的逻辑删除不同） |
| `delete_dag_node(dag_id, node_id)` | **物理删除单个节点**：删节点行 + 触及它的边；若其 `component_id` 不被任何其它节点引用，则级联删 `components` 行（其 `component_sessions` 因 `ON DELETE CASCADE` 一并清掉）。仍被引用则保留组件 |
| `publish_dag(dag_id)` | 拓扑排序 + 校验 + 写入 `execution_order` |

## 发布 `publish_dag`

流程：

1. 加载 DAG 的 nodes / edges。
2. **校验**：对每个节点调用 `verify_component()`，任一缺失必需文件则失败。
3. **拓扑排序**：`topological_sort()` 计算节点执行顺序；若有环则报
   "cycle detected"（见单元测试 `test_publish_rejects_cycle`）。
4. 把顺序写入 `dags.execution_order`（JSON 数组的节点 id），并把 `status` 置为 `published`。

拓扑/环检测逻辑在模块内 `#[cfg(test)]` 单测覆盖
（`cargo test --no-default-features --lib dag::tests::`）。

## 执行顺序来源

- 优先用 `dag.execution_order`（发布时固化）。
- 未发布或为空时，`worker.py` 执行时会调用 `compute_order` 现场计算（见 [docs/engine-executor.md](engine-executor.md)）。

## 运行快照（snapshot）

- `run_dag`（手动/定时）在**提交那一刻**（`submit_dag_run`）抓取当前 `get_dag` 的
  `nodes(含 config) + edges + execution_order`，序列化为 JSON 存进
  `dag_executions.snapshot` 列（新增迁移列，`NULL` 表示运行前旧数据）。
- Python 引擎 `worker.py` 执行时**只读这个 snapshot** 作为 plan（无则回退 `get_dag_plan`
  读实时 DAG）。因此运行中途改了 DAG，不影响本次运行；历史回看也展示当时的配置。
- snapshot 的 JSON 形状刻意与 `engine_executor/db.py::get_dag_plan` 一致
  （`{execution_order, nodes:[{id,component_id,config}], edges:[...]}`），worker 可直接复用
  `compute_order` / `build_input` / `resolve_node`。
- 前端「执行历史」点某次运行 → 展示整体 DAG 状态 + 每个节点的 `node_executions` 状态 +
  `dag_executions.snapshot` 解析出的「运行时配置快照」（只读，当时的 git/分支/入口/参数）。
