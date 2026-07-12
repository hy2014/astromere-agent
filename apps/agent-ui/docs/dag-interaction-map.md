# DAG 模式交互链路地图

> 枚举 DAG 模式下每个用户操作的完整链路：**用户操作 → 前端事件/组件 → invoke 命令 → 后端落库表 → 桌面如何渲染/读取**。
> 表中 `⚠️` 表示当前存在的链路缺陷（多为 Tauri WebView 不支持 `window.*` 对话框导致静默）。

## 总览

| # | 交互 | 前端入口 | 命令 | 落库表 | 渲染结果 |
|---|------|----------|------|--------|----------|
| 1 | 切进 DAG 模式 | `App.tsx` mode=dag | — | — | 渲染三栏布局 |
| 2 | 新建 DAG | `DagListPanel` +New | `create_dag` | `dags` | 列表出现 + 画布打开 |
| 3 | 选中/切换 DAG | `DagListPanel` item | `get_dag` | `dags`+`dag_nodes`+`dag_edges` | 画布渲染节点/边 |
| 4 | 编辑画布（拖入/连线/移动） | `ComponentCanvas` onDrop（通用组件或已注册组件） | `update_dag` / `create_component`+`update_dag` | `dags`+`dag_nodes`+`dag_edges`(+`components`) | 画布实时更新 |
| 5 | 发布 DAG | 点击 DAG → 中栏头部展示发布信息；未发布时**必填**合法 cron +「发布」 | `publish_dag` | `dags`(status/execution_order/cron) | 头部变「已发布」+ cron 徽标 |
| 6 | 删除 DAG | 每行右侧「⋯」或右键 → 操作菜单「删除」（**已发布项置灰禁用，须先下线**） | `delete_dag` | `dags` + 子表物理级联删 | 列表移除该项；若正选中则画布清空 |
| 7 | 选中节点看会话 | `ComponentCanvas` 节点点击 | `list_component_sessions` | `component_sessions` | 右侧列出 sessions |
| 8 | 新建组件 Session | `ComponentSessionPanel` +New | `create_component_session` | `component_sessions` | 切 Code 打开 + 列表刷新 |
| 9 | 打开某 Session | session 链接 | — | — | 切 Code 模式打开该 session |
| 10 | 删除组件 Session | × 按钮 | `delete_component_session` | `component_sessions` | 列表移除 |
| 11 | 运行 DAG | `ExecutionPanel` Run | `run_dag` | `dag_executions`+`execution_logs` | 历史 + 日志出现 |
| 12 | 查看执行历史/日志 | 点击 execution | `list_executions`/`get_execution_logs` | `dag_executions`+`execution_logs` | 展示 |
| 13 | 取消执行 | Cancel 按钮 | `cancel_execution` | — | ⚠️ 桩，无效果 |
| 14 | 下线 DAG | 每行右侧「⋯」或右键 → 操作菜单「下线」（仅已发布项显示） | `unpublish_dag` | `dags`(status→draft) | 头部/列表状态回到草稿，cron/execution_order 保留 |
| 15 | 注册组件 + 拖入画布（复用） | 左栏「组件」栏目「注册组件」写 `components` 表（`global=1`）；从组件列表拖已注册组件到画布 | `createComponent`（注册）+ `onDrop`(引用 component_id) + `update_dag` | `components`(注册时新建) + `dag_nodes`(component_id=已注册id + config缓存) | 注册后出现在组件列表；拖到画布生成引用该 component_id 的节点；同一组件可拖到多个 DAG（跨 DAG 复用） |
| 17 | 通用组件拖入画布（默认/非共享） | 左栏「组件」栏目**顶部「通用组件」拖拽项**，拖到画布 | `onDrop`(命中 `application/claw-generic`)→ `createComponent`(`global=0`) + `update_dag` | `components`(拖拽即建, global=0) + `dag_nodes`(component_id=新建id) | 拖到画布立即建一个非共享组件 + 节点（**不进**组件注册表列表）；这是日常默认用法 |
| 16 | 组件配置（右侧属性面板） | 点击节点 → 右侧面板分三块：①**节点名称**（`dag_nodes.label`，实例级显示名）；②组件定义（`GenericComponentForm`）；③运行参数（`InstanceConfigForm`） | **节点名称**：改 `dag_nodes.label` → `update_dag`（仅本节点）；**通用组件**定义：可编辑 → `updateComponent`(写 `components`)；**已注册组件（global=1）**定义：**只读**、不写 `components`；运行参数始终写 `dag_nodes.config.params`；`build_snapshot` 把组件 git/`configSchema`/name 注入冻结快照 | `dag_nodes.label`(节点名) + `components`(仅通用可改) + `dag_nodes`(运行参数) + `dag_executions.snapshot`(冻结副本) | 画布标题 = `label || component.name`（节点名兜底组件名，实时刷新）；已注册组件定义不可在此改（避免波及所有引用 DAG）；活 `dag_nodes.config` 仅含 `params` |

---

## 1. 切进 DAG 模式

- **用户操作**：左上角 `ModeToggle` 切到 DAG。
- **前端**：`App.tsx` 渲染 `<ComponentModeView>`（外包 `ErrorBoundary`）。
- **渲染**：三栏 —— 左栏 `ComponentFunctionList`（手风琴：`组件`/`dag`/`高级`，`dag` 下含 `DagListPanel`，`组件` 下含组件列表+「注册组件」）；中栏画布；右栏 `Properties`/`ExecutionPanel`（未选节点时）或 `ComponentSessionPanel`（选节点后）。
- **数据加载**：挂载时两个 effect 调 `listDags()` / `listComponents()` 填充 `dags` / `components`；另从 `dag-store` 读 `activeDagId`（上次选中的 DAG）。

## 2. 新建 DAG

- **用户操作**：左栏 `DagListPanel` 点 `+ New` → 列表内就地出现 `InlineTextPrompt` 输入框 → 输入名称 → 回车/Create。
- **前端**：`onCreateDag(name)` → `handleCreateDag` → `createDag(name)`（`tauri.ts` → `invoke("create_dag")`）。
- **后端**：`dag.rs::create_dag` → 生成 `id`（`generate_agent_ui_session_id`）→ `INSERT INTO dags (id, name, description, status='draft', execution_order=NULL, cron=NULL, created_at_ms, updated_at_ms)`。
- **渲染**：返回 `Dag` → `addDag(dag)`（写入 `dag-store`）→ 订阅者 `setDags` → 列表出现新项并高亮；同时 `setActiveDagDetail({...dag, nodes:[], edges:[]})` → 中栏 `<ComponentCanvas>` 挂载（已包 `<ReactFlowProvider>`，不再白屏）。
- **失败**：`message(err, {kind:"error"})`（dialog 插件，非 `window.alert`）。

## 3. 选中 / 切换 DAG

- **用户操作**：点列表某 DAG。
- **前端**：`onSelectDag(dagId)` → `handleSelectDag` → `setActiveDagId` + `setLocalActiveDagId`。
- **读取**：`activeDagId` 变化触发 effect → `getDag(id)`（`invoke("get_dag")`）。
- **后端**：`dag.rs::get_dag` → `SELECT … FROM dags` + `dag_nodes`（WHERE dag_id）+ `dag_edges`（WHERE dag_id）→ 拼成 `DagDetail`。
- **渲染**：`setActiveDagDetail(detail)` → 画布按 `nodes`/`edges` 渲染；节点 `type="component"`，`data.component` 来自 `components` 列表匹配 `component_id`。

## 4. 编辑画布（拖入组件 / 连线 / 移动）

- **拖入（通用组件，默认）**：从「组件」栏目**顶部「通用组件」拖拽项**，`handleDragStart`
  写 `dataTransfer["application/claw-generic"]`；`ComponentCanvas.onDrop` 命中该 key →
  `createComponent`（`global=0`）+ 以该 `component_id` 生成 `DagNode` →
  `onChange`(`create_component` + `update_dag`)。拖拽即建、非共享、不进注册表。
- **拖入（已注册组件，复用）**：从「组件」栏目列表拖拽已注册组件，`handleDragStart`
  写 `dataTransfer["application/claw-component"]` = component_id；`ComponentCanvas.onDrop`
  用同一 key 读取 → 以该 `component_id` 生成引用它的 `DagNode`（id 由画布生成）
  → `onChange`(`update_dag`)。
- **连线/移动**：React Flow 的 `onConnect`/`onNodesChange`/`onNodeDragStop` 累积到本地 `flowNodes`/`flowEdges`。
- **保存**：`handleChangeDag(nodes, edges)` → `updateDag(dag, nodes, edges)`（`invoke("update_dag")`）。
- **后端**：`dag.rs::update_dag` → **事务**：`UPDATE dags`（name/description/status/execution_order/cron/updated_at_ms）→ `DELETE FROM dag_nodes WHERE dag_id` → `DELETE FROM dag_edges WHERE dag_id` → 全量 `INSERT` 当前所有 nodes/edges。`cron` 在此一并保留，避免画布编辑时把已发布的 cron 清空。
  - ⚠️ 每次改动都是「先删后插」全量覆盖，没有增量；节点 id 若由前端每次重建会导致历史引用失效（当前由画布自身维护 id，可接受）。
- **渲染**：`setActiveDagDetail(prev => {...prev, nodes, edges})`。

## 5. 发布 DAG（含 cron 调度表达式）

- **用户操作**：点击某 DAG（左栏项）→ 中栏头部 `component-mode-toolbar` 展示该 DAG 的发布信息区 `dag-publish-area`。
  - **未发布**（`status != 'published'`）：显示 cron 输入框（placeholder `cron（必填，如 */5 * * * *）`）+ 蓝色「发布」按钮。**cron 必填且必须为合法 5 段 cron 表达式**，否则「发布」按钮禁用（空或格式非法时显示红色 `cron 格式非法` 提示，输入框标红）。
  - **已发布**：显示绿色「已发布」徽标 + cron 徽标（仅历史数据可能无 cron，显示「无 cron」）。
- **前端**：`handlePublishDag(dagId, cron)` → `publishDag(dagId, cron)`（`invoke("publish_dag")`，`cron` 为 trim 后的字符串）。前端 `isValidCron`（5 段、字段范围校验）做即时反馈；`activeDagDetail` 变化时会把 cron 输入框重置为该 DAG 已存值。
- **后端**：`dag.rs::publish_dag(dag_id, cron)` → 先校验 cron：`None`/空 → `Err("cron 表达式为必填…")`；非空但 `is_valid_cron` 不过 → `Err("cron 表达式格式非法：…")`；通过后才 `get_dag` → `validate_dag_for_publish`（环检测 + 组件文件齐全性检查）→ `topological_order` 算执行顺序 → `UPDATE dags SET status='published', execution_order=<JSON数组>, cron=<表达式>, updated_at_ms`。
- **落库列**：`dags.cron`（TEXT，必填；合法 cron 字符串）。`cron: Option<String>`，发布时恒为非空 `Some(...)`。
- **渲染**：`updateDagStore(dag)` + `setActiveDagDetail(status, executionOrder, cron)` → 头部切到「已发布」+ cron 徽标。
- **失败**（cron 缺失/非法/有环/缺文件）：`message(err, {kind:"error"})`。
- **说明（2026-07-07 改）**：发布现在是**可选的「提测/校验」动作**，不再是运行的前置条件（见 #11）。它把 `status` 置为 `published` 并记录拓扑顺序，便于生产调度按固定顺序执行；草稿（`draft`）可直接运行测试。如需「撤销发布」可后续加 `unpublish_dag`（当前未实现）。

## 6. 删除 DAG

- **用户操作**：每个 DAG 行右侧的「⋯」按钮，或在该行上**右键** → 弹出操作菜单（`dag-menu`）→ 点「删除」。
- **前置约束（2026-07-07 加）**：**已发布的 DAG 不允许删除**。菜单里「删除」项在 `status === 'published'` 时**置灰禁用**（title `请先下线后再删除`）；只有先点「下线」把状态退回 `draft` 后，「删除」才可点击。这是双保险——前端禁用 + 后端拒绝。
- **前端**：`onDeleteDag(dagId)` → `handleDeleteDag` → `confirm("Delete this DAG?")`（`@tauri-apps/plugin-dialog`，**非** `window.confirm`）→ 确认后 `deleteDag(dagId)`（`invoke("delete_dag")`）。菜单外点击由 `dag-menu-backdrop` 关闭。
- **后端**：`dag.rs::delete_dag` 先做状态校验——若 `status == 'published'` 直接 `Err("该 DAG 已发布，无法删除：请先在操作菜单中点「下线」…")`；否则在**单个事务**内显式 `DELETE` 子表（`dag_nodes`/`dag_edges`/`execution_logs`/`dag_executions`）后再删 `dags` 行 —— **物理删除**，不写软删标记。显式级联比单纯依赖 `ON DELETE CASCADE` 更稳，即使 DB 里缺外键约束也能清干净。
- **渲染**：`removeDag(dagId)`（dag-store）→ 列表移除；若删的是当前 active，则 `setActiveDagDetail(null)` → 中栏回到 "Select or create a DAG to start."。

## 7. 选中节点查看组件会话

- **用户操作**：点画布上某组件节点。
- **前端**：`onSelectNode(componentId)` → `handleSelectNode` → `setSelectedComponent`（从 `components` 匹配）→ 右栏改渲染 `ComponentSessionPanel`。
- **读取**：`ComponentSessionPanel` 挂载 effect → `listComponentSessions(component.id)`（`invoke("list_component_sessions")`）。
- **后端**：`component_session.rs::list_component_sessions` → `SELECT … FROM component_sessions WHERE component_id ORDER BY updated_at_ms DESC`。
- **渲染**：列出该组件的 session（title / sessionId）。

## 8. 新建组件 Session

- **用户操作**：右栏 `+ New session`。
- **前端**：`handleCreate` → `createComponentSession(component.id, "New session")`（`invoke("create_component_session")`）。
- **后端**：`component_session.rs::create_component_session` → 生成 `session_id` → `compute_session_path(workspace_root)` 解析到 `~/.claude/projects/<workspace-root-sanitized>/<session_id>.jsonl` → `INSERT INTO component_sessions (id, component_id, session_id, session_path, title, …)`。
- **渲染**：`onOpenCode(workspaceRoot, sessionId)` → App 切到 Code 模式并打开该 session 文件；同时 `refresh()` 刷新列表。
- ✅ `handleCreate` 的 catch 已改用 dialog `message(err, {kind:"error"})`，报错不再静默（2026-07-07 修）。

## 9. 打开某 Session（切 Code 模式）

- **用户操作**：点某 session 链接 / 新建后自动。
- **前端**：`onOpenCode(workspaceRoot, sessionId)` → `App` 把模式切回 `code` 并以该 `workspaceRoot` + `sessionId` 打开 Code 模式会话（复用 Code 模式的 session 打开能力）。
- **落库**：无直接写库，session 关联已在 #9 写 `component_sessions`。

## 10. 删除组件 Session（逻辑删除）

- **用户操作**：某 session 项的 `×` 按钮。
- **前端**：`handleDelete(session.id)` → `confirm("Delete this session association?")`（`@tauri-apps/plugin-dialog`，**非** `window.confirm`）→ 确认后 `deleteComponentSession(sessionId)`（`invoke`）。✅ 此前用 `window.confirm` 导致删除永不触发，已修（2026-07-07）。
- **后端（2026-07-07 改）**：`component_session.rs::delete_component_session` → **逻辑删除** `UPDATE component_sessions SET deleted_at_ms = ? WHERE id`（不再物理 `DELETE`）。`list_component_sessions` 已加 `AND deleted_at_ms IS NULL` 过滤，软删后不再列出。
  - 落库列：schema 新增 `component_sessions.deleted_at_ms INTEGER`（迁移函数 `add_column_if_missing` 安全加列，不破坏已有数据）。
  - 关联的 Code 模式 `.jsonl` session 文件**保留不动**（逻辑删除只标记关联，不删磁盘文件）。

## 11. 运行 DAG

- **用户操作**：右栏 `ExecutionPanel` 点 `Run DAG`。
- **前端**：`handleRun` → `runDag(dagId)`（`invoke("run_dag")`）。
- **后端（2026-07-11 修正架构）**：`scheduler.rs::run_dag` → `submit_dag_run`：
  - **只做 producer**：向 `dag_executions` 插入 `status='submit'` 并立即返回 `DagExecution`，**不亲自跑节点**。
  - **真正执行由独立的 Python 引擎 `engine_executor/worker.py` 轮询消费**：它读同一 SQLite、
    原子领取 `submit` 行、按 `execution_order` 依次跑各节点 `run.py`、写 `execution_logs` /
    `node_executions`、终态置 `dag_executions.status='success'/'failed'`（见
    [docs/engine-executor.md](engine-executor.md)）。
  - **不再要求 `published`**：草稿（`draft`）也可直接运行做测试（发布仅作为可选提测/校验，见 #5）。
  - 节点执行 / 跨节点边路由 / 组件源码拉取**只在 `worker.py` 一处实现**（Rust 同步路径
    `run_dag_sync` + `executor.rs` 已于 2026-07-11 删除）。
- **渲染**：返回 `DagExecution` → `setExecutions([execution, ...prev])` + 选中它 → 日志区加载。
- ✅ `handleRun` 的 catch 已改用 dialog `message(err, {kind:"error"})`，运行失败不再静默（2026-07-07 修）。

## 12. 查看执行历史 / 日志

- **用户操作**：点某 execution 项。
- **前端**：`setSelectedExecutionId(id)` → effect 调 `getExecutionLogs(id)`（`invoke("get_execution_logs")`）。
- **后端**：`scheduler.rs::get_execution_logs` → `SELECT … FROM execution_logs WHERE execution_id`。
- **渲染**：按 level 着色展示日志。
- 历史列表由 `listExecutions(dagId)` 在进入 DAG 时加载（`dag_executions` 表）。

## 13. 取消执行 / 查看当前运行状态

- **查看当前状态（2026-07-07 加）**：`ExecutionPanel` 头部新增 `currentStatus` 徽标，显示
  `running / success / failed / idle / no-dag`（彩色药丸）；点 Run 后按钮置为 `Running…`
  并禁用，直到 `runDag` promise 落地才恢复。
  - 注意：`run_dag` 当前是**同步阻塞**命令（spawn_blocking 但 invoke 会等最终结果），所以
    `running` 态只在执行期间短暂可见；若要做到「实时看到执行中」需在后端改异步执行并
    emit `agent-dag-event` 事件流，前端订阅刷新（当前后端未 emit 该事件）。
- **取消执行**：点 Cancel → `cancelExecution(executionId)`（`invoke("cancel_execution")`）。
  - **后端**：`scheduler.rs::cancel_execution` → ⚠️ **桩函数**，直接 `Ok(())`，不真正中断进程。
    需要进程追踪（pid/子进程句柄）才能真取消。

---

## 已知链路缺陷汇总

| 位置 | 问题 | 影响 | 状态 |
|------|------|------|------|
| `ComponentSessionPanel.handleCreate` | catch 用 `window.alert` | 新建 session 失败静默 | ✅ 已改 `message` |
| `ComponentSessionPanel.handleDelete` | 用 `window.confirm` | 删除 session 永远不执行 | ✅ 已改 dialog `confirm` |
| `ExecutionPanel.handleRun` | catch 用 `window.alert` | 运行失败静默 | ✅ 已改 `message` |
| `scheduler.cancel_execution` | 桩函数 | 取消执行无效 | ⏳ 待做（需进程追踪） |
| `update_dag` | 全量删插 | 改动即覆盖，无增量 diff | ⏳ 可优化 |
| `run_dag` | 必须 `published` | 草稿不能测试运行 | ✅ 已放开（草稿可运行） |
| `delete_component_session` | 物理 DELETE | 误删不可恢复 | ✅ 已改逻辑删除 |
| `agent-dag-event` | 后端未 emit | 无实时「执行中」事件流 | ⏳ 如需实时状态再补 |

> 约定：Tauri WebView **不实现** `window.prompt` / `window.confirm` / `window.alert`，任何对话框必须用内联 UI 或 `@tauri-apps/plugin-dialog` 的 `confirm`/`message`。

## 14. 下线 DAG

- **用户操作**：已发布（`status === 'published'`）的 DAG，在其行右侧「⋯」或右键弹出的操作菜单中点「下线」（草稿项不显示此菜单项，仅显示「删除」）。
- **前端**：`onUnpublishDag(dagId)` → `handleUnpublishDag` → `confirm("下线该 DAG？…")`（`@tauri-apps/plugin-dialog`，**非** `window.confirm`）→ 确认后 `unpublishDag(dagId)`（`invoke("unpublish_dag")`）。
- **后端**：`dag.rs::unpublish_dag(dag_id)` → `get_dag` → `UPDATE dags SET status='draft', updated_at_ms=? WHERE id`（`cron`/`execution_order` **保留**，便于再次发布，无需重填 cron）。
- **渲染**：`updateDagStore(dag)` → 列表状态变 `draft`；若下线的是当前 active，则 `setActiveDagDetail(status, executionOrder, cron)` → 中栏头部回到「未发布」态（cron 输入框预填原 cron）。
- **失败**：`message(err, {kind:"error"})`。
- **说明**：「下线」是「发布」的逆操作，仅把状态退回草稿，不删除任何数据；与「删除」（物理级联删）不同。调度器尚未消费 `cron`（见待办），故下线目前仅影响状态展示与可再次发布。
- **与删除的关系（2026-07-07 加）**：已发布的 DAG **不能直接删除**（见 #6 前置约束）。流程闭环是：发布 → 下线 → 删除。这样避免误删线上任务。

## 15. 注册组件 + 拖入画布（复用，引用已注册 component）

- **注册**：左栏「组件」栏目点「注册组件」→ 内联表单填 名称/git 地址/分支/entryPoint/参数/IO
  → `createComponent(component)`（`invoke("create_component")`，`global=1`）写 `components` 表；随后出现在
  组件列表（仅 `global=1` 显示）。
- **拖入**：从「组件」列表拖一个已注册组件到中栏画布。
- **前端**：列表项 `onDragStart` 写 `dataTransfer` 键 `application/claw-component` = component_id；
  `ComponentCanvas.onDrop` 命中该键后，以该 `component_id` 新建 `DagNode`（`config` 仅缓存 name，
  真正配置在 `components`）；随后 `onSelectNode(node.id)` **自动选中**该节点。
- **后端**：`update_dag` 把节点写入 `dag_nodes`（`component_id` = 已注册 component 的 id，非空）。
  该节点引用一个已存在的 component，已关联当前 DAG。
- **渲染**：`onChange` → `handleChangeDag` 更新 `activeDagDetail.nodes`；画布出现引用该组件的节点；
  因自动选中，右侧属性面板立即展开配置表单（见 #16）。
- **复用**：同一 component_id 可再被另一个 DAG 的节点引用 → 跨 DAG 复用组件定义。
- 说明：拖拽时**不再 `createComponent`**；`components` 仅由「注册组件」表单或通用组件拖拽写入。

## 16. 组件配置（右侧属性面板）

- **用户操作**：点击画布上的节点 → 右侧 `component-mode-properties` 区「配置」tab 渲染**三块**：
  0. **节点名称**（`NodeNameField`）—— 编辑**本节点实例**的显示名（写 `dag_nodes.label`）；
  1. `GenericComponentForm` —— 编辑该节点**所属 component** 的**定义**；
  2. `InstanceConfigForm`（运行参数）—— 编辑**本节点实例**的参数（写 `dag_nodes.config.params`）。
- **节点名称（`NodeNameField`，实例级显示名）**：
  - 写 `dag_nodes.label`，**仅作用于当前节点**：多次拖入同一组件时可分别命名以区分。
  - 留空则画布标题兜底 `component.name`（`ComponentCanvas` 标题 = `dagNode.label || component.name`）。
  - **不碰 `components` 表**：这是「节点显示名」，不是「组件名称」；通用/注册组件一视同仁均可改。
  - 前端：`onChange({...node, label})` → `onUpdateNode` → `update_dag` 全量写回（保留其它字段）；
    改后画布标题实时刷新（topology rebuild useEffect 依赖 `nodes` 引用变化）。
  - 防失焦：本地受控 state，仅在 `node.id` 变化时 resync（参照 `InstanceConfigForm`）。
- **组件定义（`GenericComponentForm`）**：
  - 写入 `components` 表，作为跨 DAG 共享的定义真相源；`build_snapshot` 在提交运行时注入冻结快照，
    不冗余写 `dag_nodes.config`。
  - **已注册组件（global=1）：此面板定义字段全部只读**——定义是共享契约，节点配置里**不允许改动**
    （否则会波及所有引用它的 DAG）；字段 `disabled` 且有 hover 说明「已注册组件定义不可在节点配置中修改」。
    要改定义请走组件库的「修改」入口。
  - **通用组件（global=0）：可在此编辑并写回 `components` 表**（`updateComponent`）。
  - 字段：`name`（写 `components.name`，**不再**写 `dag_nodes.label`——节点显示名已独立为上面的
    「节点名称」字段）、`inputs`/`outputs`（端口，type 暂仅 `parquet`/`csv`）、
    `gitUrl`、`gitBranch`、`gitRef`、`entryPoint`。
- **实例参数（`InstanceConfigForm`，即「运行参数」）**：
  - 写 `dag_nodes.config.params`，**仅作用于当前节点**，与组件定义解耦；
    注册/通用组件都在此填实例值（如 dataset-loader 的 `file` 路径）。
  - 前端：`onChange(updatedNode)` → `update_dag` 落库节点。
- **前端**：`GenericComponentForm` 受控于 `component`（本地 state 仅在切换节点时同步，避免输入丢焦点）；
  通用组件任一字段变更即 `onChange(updatedComponent)` → `updateComponent` 落库、同步画布标题。
- **说明**：通用组件的「配置」tab 编辑的是 component 定义本身（多节点可共享同一 component，改一处全生效）；
  **已注册组件的「配置」tab 只展示定义（只读），真正可改的是下方「运行参数」（实例级，写 `dag_nodes`）**。

## 17. 通用组件拖入画布（默认 / 非共享）

- **用户操作**：左栏「组件」栏目**顶部「通用组件」拖拽项** → 拖到中栏画布。
- **前端**：拖拽项 `onDragStart` 写 `dataTransfer` 键 `application/claw-generic`（payload 任意非空，
  仅用于命中）；`ComponentCanvas.onDrop` 先查该 key，命中后：
  1. 以 `makeUuid()` 生成 `component_id`，构造 `global=0` 的 `Component`
     （名称「通用组件」、git/IO 为空、未配置）；
  2. 调 `createComponent(component)` 写 `components` 表（随即 `onComponentCreated` 刷新前端 store，
     使节点→组件查找可命中）；
  3. 以该 `component_id` 生成 `DagNode`（`config` 仅缓存 name，真正配置留空待填）；
  4. `onChange`(`update_dag`) 落库节点，`onSelectNode(node.id)` 自动选中。
- **后端**：`create_component` 写入 `components`（`global=0`）；`update_dag` 写入 `dag_nodes`
  （`component_id` = 新建组件 id，非空）。
- **渲染**：画布立即出现一个非共享组件节点；因自动选中，右侧属性面板展开配置表单，可即时填 git/IO。
- **特征**：该组件 `global=0`，**不出现**在「组件」注册表列表，不被复用；若需复用，见 #16 勾选「注册此组件」。
- 说明：通用组件与已注册组件**数据结构完全相同**（都是 `components` 行），仅 `global` 位不同；
  删节点级联删 `components` 仍仅在无其它节点引用时发生（见 #6/#16 删除语义）。
