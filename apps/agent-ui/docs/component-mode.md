# component-mode — DAG canvas & palette UI

Module: `src/app/component-mode/*`（`ComponentModeView`, `ComponentFunctionList`, `ComponentCanvas`,
`RegisterComponentForm`, `PropertiesPanel`, `ComponentSessionPanel`, `ExecutionPanel`）
Related: [docs/mode-toggle.md](mode-toggle.md), [docs/components.md](components.md),
[docs/dag.md](dag.md), [docs/component-session.md](component-session.md)

## 布局

进入 DAG 模式后（`ModeToggle` 切到 DAG），整体为三栏 grid（240px / 1fr / 280px）：

- 左侧栏（自上而下）：`ModeToggle`（切回 Code）→ brand → **功能列表手风琴**
  （`ComponentFunctionList`）：三个一级栏目 `组件` / `dag` / `高级`，每个带 `>>`
  （逆时针 90°）chevron 可展开/收起；二级是各组的功能/列表：
  - `组件`：**顶部「通用组件」拖拽项**（拖入即建非共享节点，默认用法）+ 已注册组件列表
    （`global=1`，拖拽到画布实例化复用）+「注册组件」按钮（写 `components` 表 `global=1`）。
  - `dag`：原 `DagListPanel` 内容。
  - `高级`：占位骨架（设置/调试后续填）。
- 中间：`ComponentCanvas`（React Flow 画布）。
- 右侧（选中节点时）：`PropertiesPanel`（子 tab：配置 / 探索）；
  **注册态时**：右栏变为"注册组件"专页（画布已收起，见上）。
- **执行历史**已上移到顶部 **DAG 工具栏**（与「运行 DAG」「发布」并列的「执行历史」按钮），
  点击后右侧展示 `ExecutionPanel`（只读：历次运行 / 各节点运行状态 / 运行时配置快照 / 日志）。
  组件属性面板不再含执行历史 tab。

> 历史：早期 `DagListPanel` 是画布底部一个固定 160px 的 footer；2026-07-07
> 改为移入左侧栏，与组件列表并排。

## 左侧栏手风琴（ComponentFunctionList）

- 三个一级栏目 `组件` / `dag` / `高级`，各带「`>>`」chevron（逆时针 90° 表示可展开），
  点击栏目头切换展开/收起（手风琴，用 React `useState` 控制，不遮挡画布）。
- `dag` 栏目下是 `DagListPanel`（根节点 `.dag-list-section` 普通块级。**曾用**的
  `.sidebar-section*`（flex:1/min-height:0/overflow:hidden + `DAGs` 大写标题 +
  `+ New` 实线蓝按钮）已整体删除——它嵌在手风琴 `.fn-section-body`（高度由内容决定）
  里会塌成 0 高度把列表裁掉，且视觉语言与手风琴不一致）。现结构：可滚动 `.dag-list`
  列表（选中高亮、kebab 展开 下线/删除）+ **底部整宽虚线靛蓝「+ 新建 DAG」按钮**
  （`.fn-add-btn`，点击就地弹出 `InlineTextPrompt` 取名字）。
- `组件` 栏目下：
  - **顶部「通用组件」拖拽项**：`dataTransfer` key `application/claw-generic`，拖到画布
    即 `createComponent`（`global=0`）+ 写 `dag_nodes` 引用它（**拖拽即建、非共享、不进注册表**，
    见 [docs/dag-interaction-map.md](dag-interaction-map.md) #17）。这是默认/日常用法。
  - **已注册组件列表**：读 `components` 表**仅 `global=1`**（按 `updated_at_ms` 倒序），
    每条卡片可拖拽到画布（`dataTransfer` key `application/claw-component`，payload =
    `component_id`），落库为一条引用该 `component_id` 的 `dag_nodes`（复用，见 #15）。
  - **已注册组件卡片的 kebab（⋮）菜单**：每条已注册组件卡片右上角有 kebab 按钮（与 `dag`
    栏目的 DAG 列表 kebab 交互一致），点开弹菜单，菜单**仅「修改」一项**：点「修改」→
    复用 `RegisterComponentForm` 进入**编辑模式**（按该组件当前 `components` 行预填表单），
    提交调后端 `update_component` 写回**同一 `component_id`**（不新建），画布所有引用不受影响。
    kebab 不抢「拖到画布」的拖拽手势。
  - **「注册组件」按钮**（`.fn-add-btn`，与 dag 栏「+ 新建 DAG」同一整宽虚线靛蓝样式）：
    注册是一个**与画布无关的专注任务**——点击后整体进入"注册态"
    （`component-mode-shell.registering`）：**中间画布整列收起**（`main` 设 `display:none`，
    因为注册不需要画布），左栏导航保留，**右侧面板变宽为一张"注册组件"专页**
    （`RegisterComponentForm` 套 `.register-page` 容器：名称 / 描述 / Git 地址 / 分支 /
    Git Ref / 执行入口），表单居中限宽（max 560px），不再挤在 280px 属性栏里。提交调
    `createComponent` 写 `components` 表（`global=1`），完成后退出注册态回到节点属性面板；
    取消直接退出。表单不内联在左侧栏（避免挤占手风琴）。
- `高级` 栏目下：占位骨架（设置/调试后续填）。

## 通用组件 vs 已注册组件 vs 拖拽

- **通用组件（默认）** = 从「组件」栏目顶部「通用组件」拖拽项拖到画布：`onDrop` 调
  `createComponent`（`global=0`）+ 写 `dag_nodes` 引用它。拖拽即建，**不复用**、**不进**注册表列表。
  IO 端口在画布「配置」tab 手画（`+ 输入 / + 输出`）——这是通用组件的专属能力。
- **注册** = 写 `components` 表（`global=1`：组件定义 git 来源 / 入口 / 参数 / IO）。
  注册表单内含「输入/输出端口」编辑区（key + 类型，默认 `file`），注册即声明 IO，画布只读展示。
- **拖拽（复用）** = 从「组件」列表拖一个已注册组件到画布，写 `dag_nodes`（`component_id`
  引用已注册组件）。拖拽时**不再新建空白组件**。
- **IO 端口编辑按组件类型区分（2026-07-10 决策）**：
  - 通用组件（`global=0`）：画布「配置」tab 可手画端口（`+ 输入 / + 输出`，可编辑改名/类型/删除）。
  - 注册的 global 组件（`global=1`）：IO 由注册时声明的 `input_schema` / `output_schema` 决定，
    画布「配置」tab 对其**只读展示**端口 key，**不可手画、不可编辑**。注册组件只关心 input/output 的 key。
  - 注册时端口类型默认 `file`（选项 `file` / `csv` / `parquet`）；与「端口传文件引用、格式在 payload
    里」的 file-centric 模型一致。
  - 画布节点圆点严格按 schema 渲染，**0 声明 ⇒ 0 点**，通用组件与已注册组件完全一致，
    无任何兜底画点（画布即 schema 镜像：看到几个点就是几个端口，没有写死的隐藏点）。
    通用组件想连线，先在配置 tab 用「+ 输入 / + 输出」声明端口，圆点才出现。
  - 旧文档「配置 tab 可编辑 IO」的笼统说法已作废。
- 同一 `component_id` 可被多个 DAG 的节点引用 → 跨 DAG 复用组件定义
  （见 [docs/components.md](components.md)）。
- 组件配置表单的「注册此组件」勾选可在 `global=0/1` 间切换：勾选即从通用晋升为已注册
  （进入注册表、可被复用），覆盖"多次使用 → 注册"。

## 对话框约定（重要）

Tauri WebView **未实现 `window.prompt` / `window.confirm` / `window.alert`**，调用它们是空操作。
因此本模块内**严禁**使用这三个 API：

- 文本输入用内联组件 `InlineTextPrompt`（如 DAG「+ 新建 DAG」取名）。
- 确认框用 `@tauri-apps/plugin-dialog` 的 `confirm(...)`（如删除 DAG）。
- 错误/提示用该插件的 `message(..., { kind: "error" })`（如 publish 失败、组件表单校验）。

> 注：dialog 插件的 `prompt`（文本输入）在 v2.7.1 已被移除，只有 `ask`/`confirm`/`message`。

## ComponentCanvas

- React Flow 画布；节点 `type="component"`，数据含 `component` + `dagNode`。
- 拖动/连线变更通过 `onChange(nodes, edges)` 回调，最终 `update_dag` 落库。
- ⚠️ **必须**整体包在 `<ReactFlowProvider>` 内：`useReactFlow()`（用于
  `screenToFlowPosition`）在 Provider 外调用会在挂载时抛错导致整屏白屏。
- 渲染门控：`ComponentModeView` 仅在 `activeDagDetail` 非空时挂载画布；新建/选中
  DAG 时 `activeDagDetail` 变非空，画布才首次挂载，因此 Provider 缺失的崩溃只在
  这一步触发。

### 节点渲染

- **标题格式**：单行 `类型短字｜label`。通用组件显示 `通｜<名字>`，注册组件显示
  `注｜<名字>`；「通 / 注」为蓝色字、`label` 为黑色字、分隔符 `｜` 灰色。名字取
  `dag_nodes.label || component.name`（节点显示名可单独编辑，不影响组件定义）。
- **右键菜单**：在节点上右键弹出自定义下拉菜单（不污染节点本体 UI），含「预览数据」「删除」等项。
- **节点输出预览**：右键 → 「预览数据」→ 弹 `DataPreviewModal`，按**每个输出端口一个 tab** 切换，
  表格展示该端口输出文件的前 100 行（column + value）；预览取自该节点最近一次有输出的执行。
- **尺寸**：节点固定宽度 170px、最小高度 30px，紧凑纵向风格（标题单行、超长省略号）。

## ComponentSessionPanel

- 点击画布节点 → 右侧展示该 Component 的 session 列表
  （`list_component_sessions`）。
- 新建或打开 session → 调 `App.handleOpenComponentCode(workspace_root, session_id)`，
  切回 Code 模式并把该组件 `workspace_root` 注册为项目、打开对应 session。

## 删除组件

- 入口：右侧「配置」tab 底部的「删除组件」按钮，或节点右键菜单的「删除」项
  （画布节点上的 `×` 按钮已移除，避免干扰节点 UI）。
- 两者都调 `delete_dag_node(dag_id, node_id)`（见 [docs/dag.md](dag.md)）：物理删除节点 +
  触及它的边；仅当该 component 不被其它节点引用时才级联删 `components` 行（其 session 一并清掉）。
- 删除前用 `@tauri-apps/plugin-dialog` 的 `confirm` 二次确认（不使用原生 `window.confirm`）。

## 执行历史（ExecutionPanel）

- 入口：顶部 DAG 工具栏的「执行历史」按钮（与「运行 DAG」「发布」并列）。点击后右侧展示
  `ExecutionPanel`，**不再放在组件属性面板里**（属性面板只有「配置 / 探索」tab）。
- 「运行 DAG」（绿色按钮，`ComponentModeView.handleRunDag` 调 `runDag`）后点击「执行历史」
  即可查看本次及历次运行；运行会通过 `runSignal` 触发列表刷新。
- `ExecutionPanel` 只**只读展示**该 DAG 的历次运行（列表 / 各节点状态 / 配置快照 / 日志），
  **不含任何写动作按钮**。点某次运行展开详情：
  - **整体 DAG 状态**（`dag_executions.status`）；
  - **每个节点的运行状态**（`get_node_executions` → `node_executions` 表，按开始时间排序）；
  - **运行时的配置快照**：解析 `dag_executions.snapshot`（见 [docs/dag.md](dag.md) 运行快照），
    只读展示当时每个节点的 git 地址 / 分支 / 入口 / 参数，而非当前最新配置。
- 底部仍是该次运行的 execution log。

## 典型流程

**默认（通用组件，不共享）：**
1. DAG 模式 → 左侧「组件」栏目顶部「通用组件」拖拽项 → 拖到画布 → 自动建一个 `global=0`
   的组件 + 节点（关联当前 DAG）。
2. 点该节点 → 右侧「配置」tab 编辑组件定义（git/分支/入口/参数/名称；IO 端口在此**手画**，
   见上「IO 端口编辑按组件类型区分」）；连线表达依赖。
3. 若之后发现要复用 → 勾选「注册此组件」→ 该组件晋升 `global=1`，出现在「组件」列表，
   此后画布上其 IO 转为**只读展示**（由注册声明决定）。

**复用（已注册组件）：**
1. 点「注册组件」→ 右侧面板打开注册表单，填名称 / Git 地址 / 分支 / 执行入口，
   并在「输入/输出端口」区声明组件的 IO（key + 类型，默认 `file`）→ 写入
   `components` 表（`global=1`，IO 落 `input_schema` / `output_schema`）。
2. 从「组件」列表把刚注册的组件拖到画布 → 生成一条引用该 `component_id` 的节点。
3. 同一组件可再拖到另一个 DAG，实现跨 DAG 复用。
4. 之后若要改该组件（git 地址 / 分支 / 入口 / 参数 / IO）：点组件卡片的 kebab（⋮）→
   「修改」→ 在编辑模式改完提交，写回同一 `component_id`，所有引用它的节点自动跟随新定义。

**运行：**
1. 配置饱满后 → 顶部工具栏点「运行 DAG」（也可先「发布」交给 scheduler 定时跑）→
   编排执行链路、调度 worker、监控、输出 execution log；每次运行都会冻结一份
   配置快照（含组件 git 配置），便于事后回看当时配置。运行记录可点顶部工具栏「执行历史」
   按钮查看（只读）。

## 测试

- 注册组件表单的纯逻辑（组装 `Component` → `global=true`、必填校验）抽在
  `src/app/component-mode/componentModel.ts`（`assembleRegisterComponent` /
  `canSubmitRegister`），便于单测、且测试时不触发 Tauri 副作用。
- 测试：`src/app/component-mode/register-component.test.ts`，用 Node 内置 `node:test` +
  项目已有的 `tsx` 运行（`npm run test` = `node --import tsx --test ...`），**零新依赖**，
  不引入 vitest/jest（与 `checker/` 目录的轻量测试风格一致）。
- 覆盖：注册组件恒为 `global=true`；各字段 trim；默认值（status/schemas/tags）；
  必填 name（空白/纯空格被拒）。
