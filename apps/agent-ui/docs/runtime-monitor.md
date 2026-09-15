# 运行时监控：全局"正在运行的 DAG-组件"列表

> 独立新功能文档，与《并行执行与组件检出 redesign》（`docs/parallel-execution.md`）**正交**。
> 后者讲"怎么并行跑"，本文件讲"跑起来后怎么能看见"。两者无依赖、各自实现、各自提交。
>
> 约束：遵循项目"先文档后代码"铁律，本文档批准后才改代码。

---

## 1. 用户需求（原文）

> 增加一些监控功能，比如增加当前正在运行的 dag-component 列表，就是 component 列表，
> 但是要表明具体的 node、dag 的名称。

一句话：**一个跨所有 DAG 的全局实时视图，列出此刻正在跑（preparing / running）的每一个节点，
并标注它属于哪个 DAG、哪个节点、用的是什么组件。**

---

## 2. 现状与缺口

数据链路现状：
- `node_executions.status` **实时落库**。worker 在节点进入 `preparing`（worker.py:249）和
  `running`（worker.py:260）时立即 `upsert_node_execution` 写库，进入终态（success/failed/skipped/cancelled）也写库。
- 但**只存在两个查询接口**：
  1. `get_node_executions(execution_id)` —— 按某次 execution 查它的节点（局部视角）；
  2. `list_executions(dag_id)` —— 按某个 DAG 查它的 execution 列表。
- **缺一个"跨所有 DAG、只看正在跑的节点"的全局查询**。这正是本功能要补的缺口。

结论：后端加一个全局查询即可，节点状态**无需新增字段、无需改 worker 写库逻辑**（实时性已由现有代码保证）。

---

## 3. 数据模型与 JOIN 关系

| 表 | 关键列 | 用途 |
|---|---|---|
| `node_executions` | `execution_id, node_id, status, started_at_ms` | 主表，过滤 `status IN ('preparing','running')` |
| `dag_executions` | `id, dag_id, trigger_kind, started_at_ms` | 提供 `trigger_kind`（manual/cron/api）+ 关联 dag |
| `dags` | `id, name` | DAG 名称 |
| `dag_nodes` | `id(=node_id), dag_id, component_id, label` | 节点显示名 `label` |
| `components` | `id, name` | 组件名称 |

查询（核心 SQL，落在 `db.py`）：

```sql
SELECT
    ne.execution_id,
    ne.node_id,
    ne.status,
    ne.started_at_ms,
    de.dag_id,
    de.trigger_kind,
    d.name          AS dag_name,
    dn.label        AS node_label,
    c.name          AS component_name
FROM node_executions ne
JOIN dag_executions de ON ne.execution_id = de.id
JOIN dags d          ON de.dag_id = d.id
LEFT JOIN dag_nodes dn ON dn.id = ne.node_id
LEFT JOIN components c  ON c.id = dn.component_id
WHERE ne.status IN ('preparing', 'running')
ORDER BY ne.started_at_ms ASC;
```

说明：
- `LEFT JOIN` 而非 `INNER`：防止某节点因 schema 漂移（如 `dag_nodes` 缺失该 node_id）被整行丢掉的鲁棒性。
- `node_label` 可能为空（极端情况）→ 前端回退显示 `node_id`；`component_name` 同理回退 `component_id`。
- 状态全集（代码实际会写）：`preparing | running | success | failed | skipped | cancelled`。本视图只取前两个。

---

## 4. 后端改动

### 4.1 `engine_executor/db.py` —— 新增查询函数

```python
def list_running_nodes():
    """返回所有正在运行(preparing/running)的节点，附 DAG/节点/组件名称。"""
    conn = connect()
    try:
        rows = conn.execute(_RUNNING_NODES_SQL).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
```

- 不新增任何表、不加任何索引（现有 `idx_node_executions_execution` 够用；如数据量大可后续加
  `idx_node_executions_status`，但当前规模不必）。
- 纯读，无副作用，可安全被 Rust 与 HTTP 两层复用。

### 4.2 Rust 侧接入（双通道，与现有 `list_executions` 对齐）

复用 `src-tauri/src/scheduler.rs` 里 `list_executions` 的两种接线模式：

1. **Tauri command**（桌面/GUI 模式）：
   新增 `#[tauri::command] fn list_running_nodes() -> Result<Vec<RunningNodeRow>, String>`，
   内部调用 `db::list_running_nodes()`（经 `engine_executor` FFI 或直接复用同一 SQLite 连接）。
2. **HTTP route**（remote / 无头模式）：
   在 `dag_api.rs` 新增 `GET /api/executions/running-nodes`，调用同一函数返回 JSON。

返回结构（建议 Rust struct `RunningNodeRow`）：
```rust
struct RunningNodeRow {
    execution_id: String,
    node_id: String,
    status: String,          // "preparing" | "running"
    started_at_ms: Option<i64>,
    dag_id: String,
    dag_name: String,
    node_label: Option<String>,
    component_name: Option<String>,
    trigger_kind: String,    // "manual" | "cron" | "api"
}
```

### 4.3 前端 `src/app/component-mode/api.ts`

新增封装（对齐现有 `getNodeExecutions` 写法）：
```ts
export async function listRunningNodes(): Promise<RunningNode[]> {
  return invoke("list_running_nodes");
}
// 或 HTTP: fetch(`${BASE}/api/executions/running-nodes`)
```

类型 `RunningNode` 同步加入 `src/types.ts`。

---

## 5. 前端呈现

### 5.1 入口与位置

- 新增独立路由 / 面板：**运行监控（Runtime Monitor）**，放在左侧导航（与"组件库 / DAG / 执行记录"并列），
  **不塞进**并行执行 redesign 的任何页面，保持功能边界清晰。
- 普通用户视角：一个标题"正在运行的组件"，下面一张表，零术语。

### 5.2 表格列（普通用户口语化）

| 列 | 来源 | 说明 |
|---|---|---|
| DAG 名称 | `dag_name` | 哪个流程 |
| 节点 | `node_label`(回退 `node_id`) | 画布上那个节点 |
| 组件 | `component_name`(回退 `component_id`) | 跑的是哪个组件 |
| 状态 | `status` | 准备中 / 运行中（中文映射） |
| 触发 | `trigger_kind` | 手动 / 定时 / 接口 |
| 开始时间 | `started_at_ms` | 相对时间"x 分钟前" |
| 操作 | — | "查看详情"→ 跳该 `execution_id` 的执行详情页 |

- 状态中文：`preparing`→准备中，`running`→运行中。
- 空状态：直接亮一句"当前没有正在运行的组件"，并给一个"刷新"动作按钮（符合普通用户偏好：缺失即给动作）。

### 5.3 刷新策略

- 初版用 **轮询**：进入页面后 `setInterval` 每 **3 秒**拉一次 `listRunningNodes()`，离开页面 `clearInterval`。
- 不引入 WebSocket（避免过度设计），但文档记录后续可升级为 worker 心跳推送（见 §7）。

---

## 6. 状态语义与"卡死"处理

- 正常路径：节点终态由 worker 写入，`running` 行会自然消失出列表。
- **已知风险（stale）**：若 worker 进程崩溃/被 kill，它正在 `running` 的节点不会写终态，会**永久卡在列表里**。
- 初版处理（软提示，不自动改写）：
  - 前端对 `started_at_ms` 超 **10 分钟**仍 `running` 的行，状态旁标一个 ⚠"可能已卡住"，
    提示用户该节点所属 execution 可能需手动取消。
  - **不**自动把状态改掉（避免与真实 worker 写库竞态、误判）。
- 根治（后续，不在本功能范围）：给 worker 加心跳/lease，超时由 supervisor 回收节点状态。

---

## 7. 默认值表

| 项 | 默认值 | 说明 |
|---|---|---|
| 列表过滤状态 | `preparing, running` | 只看进行中 |
| 前端轮询间隔 | 3 秒 | 初版够用 |
| stale 软提示阈值 | 10 分钟 | 仅展示提示，不改库 |
| 排序 | `started_at_ms` 升序 | 先开始的在上 |

---

## 8. 实施步骤（待批准）

1. `engine_executor/db.py`：新增 `list_running_nodes()` + SQL 常量。补单测（构造 2 DAG、各 1 运行中节点，验证返回正确 JOIN 字段）。
2. Rust：新增 `list_running_nodes` command + HTTP route，struct `RunningNodeRow`。
3. `src/types.ts`：加 `RunningNode` 类型；`api.ts`：加 `listRunningNodes()`。
4. 前端：新增运行监控页面（路由 + 导航项 + 表格 + 3s 轮询 + 空状态 + 中文状态映射 + 详情跳转）。
5. `cargo check` + 前端 `tsc` + 联调：手动触发一个长耗时 DAG，确认列表实时出现该节点并显示正确 DAG/节点/组件名。

> 本功能**不**改动 `worker.py` 写库逻辑、`node_executions` 表结构，也不依赖并行执行 redesign 是否落地。

---

## 9. 风险与后续

- **worker 崩溃卡死**：§6 已述，初版软提示，根治需 worker 心跳（独立任务）。
- **并发写入正确性**：`list_running_nodes` 是纯 SELECT，与并行架构（多 worker）天然兼容，无锁需求。
- **WebSocket 升级**：轮询够用；若监控要扩展到"实时日志流"，再引入 worker→前端推送。
- **与并行执行 redesign 的关系**：本功能在"多 worker 并行"场景下价值更大（能看到同时跑的多个组件），
  但实现互不阻塞——先上本监控，并行 redesign 按 `parallel-execution.md` 另行推进。
