# scheduler — DAG scheduling & execution

Module: `src-tauri/src/scheduler.rs`
Related: [docs/dag.md](dag.md), [docs/executor.md](executor.md)

## 职责

驱动一个 DAG 的端到端执行，并暴露执行状态的查询/日志/取消命令。

## 命令（Tauri commands）

| 命令 | 说明 |
|---|---|
| `run_dag(dag_id)` | 触发执行（**producer**）：仅向 `dag_executions` 插入 `status='submit'` 并立即返回 `DagExecution`；真正执行由 `engine_executor` Python 进程消费（见 [docs/engine-executor.md](engine-executor.md)） |
| `submit_dag_run(dag_id, trigger_kind)` | `run_dag` 底层的提交函数，可被 cron 调度器复用（trigger_kind: manual/cron/api） |
| `get_execution(execution_id)` | 取单次执行状态 |
| `list_executions(dag_id)` | 列出某 DAG 的执行历史 |
| `get_execution_logs(execution_id)` | 取执行日志（worker 实时写入，UI 轮询） |
| `get_node_executions(execution_id)` | 取本次执行下各节点的 `node_executions` 行（`NodeExecution`），用于 UI 画布节点实时标色（方案 B） |
| `cancel_execution(execution_id)` | 请求取消：置 `status='cancel_requested'`（仅未完成态生效），由 Python 引擎检测并终止子进程 |

## `run_dag_sync`（已删除，2026-07-11）

> 该 Rust 同步执行路径（`run_dag_sync` + `executor.rs::execute_python_node` + 私有 helper
> `add_execution_log` / `create_execution` / `build_node_inputs` / `compute_order` /
> `update_execution_status`）已于 2026-07-11 删除。原因：它是生产 `worker.py` 之外的**第二份**
> 节点执行实现，违反「单一执行引擎」一致性原则（handle 前缀 bug 两边各犯一次即为教训）。

节点执行、跨节点边路由、组件源码拉取**现仅由 Python `engine_executor/worker.py` 实现**。

## 本地 vs 生产调度器

- **本地调试**：集成测试通过 `run_dag`（入队）+ 启动 `worker.py` 走与生产完全一致的路径（见 `executor_e2e.rs` / `integration.rs`）。Rust 不再内置节点执行器。
- **生产 / cron 执行**：Rust `run_dag` 只写 `submit`，由独立 Python 进程
  `engine_executor/worker.py` 读同一 SQLite DB、原子领取并执行，状态机与日志见
  [docs/engine-executor.md](engine-executor.md)。Tauri 仍是控制面与 UI，cron 触发由独立
  scheduler 写入 `submit`。

## 已知缺口（Known gap）

- 通用组件（第三层 runtime instance）的 **DAG 级输入/输出衔接**（上游 output 作为下游
  input）在 `engine_executor` 中已支持合并上游输出，但复杂端口映射（parquet/csv 文件
  传递）仍为 v1 简化版。
- cron 调度器（写 `submit` 的那一侧）尚未实现，待后续独立模块。
