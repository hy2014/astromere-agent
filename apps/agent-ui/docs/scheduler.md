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
- **生产 / cron 执行**：Rust `run_dag`（人触发）与 cron 调度器（定时触发）都只写 `submit`，
  由独立 Python 进程 `engine_executor/worker.py` 读同一 SQLite DB、原子领取并执行，状态机与
  日志见 [docs/engine-executor.md](engine-executor.md)。二者产出的任务完全一致，仅
  `trigger_kind` 不同（`manual` / `cron`）。

## cron 调度器（已实现）

**定位**：cron 是 `dag_executions` 的第二个 producer（第一个是手动 `run_dag`）。它只负责
「到点了就 `submit_dag_run(dag_id, "cron")`」，之后完全复用 worker 消费链路，不碰节点执行。

**巡检式，而非 next-fire 计算**：常驻线程每 30s 巡检一次，对每个 `published` 且 `cron` 非空
的 DAG，判断「**当前本地墙钟时刻是否匹配这条 5 段 cron**」，匹配即提交。相比维护「下次触发
时间」状态，巡检式无需持久化 next-fire、进程重启后自然恢复，更健壮。

**cron 匹配（手写，零新依赖）**：复用 `dag.rs::is_valid_cron` 同一套 5 段语义
（`* / n / a-b / base/step`，逗号列表），发布时已校验合法，故匹配阶段假设格式合法。
- 字段：`minute hour day-of-month month day-of-week`，范围
  `(0-59)(0-23)(1-31)(1-12)(0-7)`；dow 的 `0` 与 `7` 均为周日。
- **day-of-month / day-of-week 采用 Vixie cron OR 语义**：两者都受限（非 `*`）时，命中任一
  即触发；只有一个受限则只看那个；都为 `*` 则不约束。
- 时区：**本地时区**（`chrono::Local`）。例：`0 9 * * *` = 每天本地 9:00。

**防重触发**：`dags.last_cron_run_ms` 记录上次 cron 触发的「当前分钟起点毫秒」。ticker 每 30s
跑一次、同一分钟会巡检约 2 次，靠 `last_cron_run_ms >= 本分钟起点` 去重，保证一分钟至多提交一次。

**挂载点**：`server.rs::run_server` 的 `if run_worker { … }` 块内、`start_worker_supervisor()`
之后调用 `scheduler::start_cron_scheduler()`。cron 生产者与 worker 消费者**同机同生命周期**；
桌面纯 client（`run_worker=false`）不跑 cron —— 因为它本机也不跑 worker，提交了没人执行。

**关键函数**（`scheduler.rs`）：

| 函数 | 说明 |
|---|---|
| `start_cron_scheduler()` | 起常驻线程，每 30s 调 `tick_cron()` |
| `tick_cron()` | 取本地时刻 → 查 `published`+`cron` DAG → 匹配 + 去重 → `submit_dag_run(id,"cron")` + 写 `last_cron_run_ms` |
| `cron_matches_at(expr, minute, hour, dom, month, dow)` | 5 段匹配（含 Vixie OR / dow 0-7 归一化），有单元测试 |
| `cron_field_matches` / `cron_item_matches` | 单字段 / 单项匹配 helper |

## 已知缺口（Known gap）

- 通用组件（第三层 runtime instance）的 **DAG 级输入/输出衔接**（上游 output 作为下游
  input）在 `engine_executor` 中已支持合并上游输出，但复杂端口映射（parquet/csv 文件
  传递）仍为 v1 简化版。
