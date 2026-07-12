# executor — 已删除（2026-07-11）

> **状态**：本 Rust 执行器（`src-tauri/src/executor.rs`，含 `execute_python_node` 及其
> venv/pip 辅助）已于 2026-07-11 **整文件删除**。它是生产 `engine_executor/worker.py`
> 之外的第二份节点执行实现，违反「单一执行引擎」一致性原则，现节点执行统一由 Python
> `engine_executor/` 承担。集成测试改为走 `run_dag` + 启动 `worker.py`（见 `executor_e2e.rs`）。

Module（已删除）: `src-tauri/src/executor.rs`
Related: [docs/components.md](components.md), [docs/scheduler.md](scheduler.md), [docs/engine-executor.md](engine-executor.md)

## 关键行为

- `execute_python_node(component, execution_id, ...)`：运行 `component.entry_point`。
- **venv 创建**：首次执行时在 `component_root/.venv` 用 `python3 -m venv` 建虚拟环境
  （`ensure_component_venv`）。`component_root` 由 `entry_point` 父目录推导。
- 依赖安装依赖 `requirements.txt`（位于 `component_root`）。
- 日志落盘目录：`execution_dir(execution_id)` =
  `<ui_config_dir>/dag-executions/<execution_id>/`。
- 节点输出写入 `dag_executions.outputs`（JSON）。

## 约定

- 执行器**只认磁盘上的真实文件**：`entry_point`、`requirements.txt` 必须存在于
  `component_root`。
- venv 随组件目录走，不在全局位置，便于多组件隔离。
- **不支持 `component_id` 为空的通用组件节点**（`get_component("")` 会失败）；通用组件
  请走 `engine_executor`。
