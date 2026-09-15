# DW 数据仓库落库 — 系统设计方案

> 状态：已实现（2026-09-15）
> 日期：2026-09-15
> 范围：agent-ui（编排 IDE + 执行引擎）与 component-repo（组件仓库）

## 1. 背景与目标

为 DAG 系统增加数据仓库（dw）能力：

- 全局设置一个 **dw 根目录**作为数据根（默认 `/opt/agent-ui/dw`），在 agent-ui 中配置
- 组件节点参数可配置 **`dw_table`（表名）**，并**选择该组件的一个输出端口**
- 执行时，选中的输出端口数据**直接写入** `{dw_root}/{dw_table}/`
- 下游组件以该输出为输入时，**自动从 dw 读取**

### 核心原则（已与需求方确认）

1. **对组件业务逻辑透明**：上层（runner）解析参数后把"表根目录"传给组件，组件按普通输出写入；表内子目录/分区格式由业务方（组件代码）自行控制，runner 只保证目录存在。
2. **读写都只认 table dir**：不引入新的读写 API，路径即契约。
3. **不做后置拷贝**：不是"算完再搬"，而是输出路径本身就指向 dw。

## 2. 现状架构（与本设计相关的部分）

```
┌─────────────────────────────────────────────────────────────────┐
│ agent-ui (Tauri + Next.js)                                       │
│                                                                  │
│  Rust scheduler (src-tauri/src/scheduler.rs)                     │
│    └─ 提交执行: 冻结 node config(含 params) + configSchema        │
│       → SQLite dag_executions.snapshot (L39-105)                 │
│                                                                  │
│  engine_executor/worker.py  (独立 python 进程, 轮询共享 SQLite;   │
│    DB path 由 src-tauri/src/engine.rs L62-72 注入 env)           │
│    ├─ build_input (L158-216): 上游 node_executions.outputs[port] │
│    │   登记的文件路径 → 下游 input.json（路径即数据，透明）         │
│    └─ work_dir = cache_root/runs/{exec_id}/{node_id} (L382)      │
│                                                                  │
│  engine_executor/runner.py run_node (L504-632)                   │
│    └─ env: AGENT_UI_INPUT_PATH / AGENT_UI_OUTPUT_PATH            │
│       (=work_dir/output.json) / AGENT_UI_COMPONENT_ROOT          │
│    └─ spawn 组件 python，结束后读 output.json 回填 DB             │
│                                                                  │
│  预览/下载 (scheduler.rs L684-837):                               │
│    按 output.json 登记路径直读 csv/json/parquet                   │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ component-repo (组件仓库)                                       │
│  components/<name>/run.py                                        │
│    数据文件路径组件自选（如 comp-upstream L931:                │
│    tempfile.mkdtemp()/out_features.parquet）               │
│    再把 {"端口名": "文件路径"} 写进 AGENT_UI_OUTPUT_PATH           │
│  comp-downstream 已有 _write_output(port, path) 登记helper(L37-57)│
└─────────────────────────────────────────────────────────────────┘
```

**关键发现**：数据文件的实际路径由**组件**决定，output.json 只负责登记"端口 → 路径"。因此：

- "输出直接写入 dw" = runner 注入"数据目录"环境变量 + 组件输出落点 3 行小改；
- 下游读取（build_input）、预览、下载读的都是登记路径 → 登记的是 dw 路径后**全部零改动自动生效**。

## 3. 总体设计

### 3.1 数据流

```
① 用户全局设置 dw_root ──→ ~/.agent-ui/dw-settings.json (仿 ModelSettings 先例)
② 节点 Config 面板 "注册到DW" 区块
     开关 + 输出端口下拉(来自组件 outputSchema) + dw_table
     → node.config.params: dw.enabled / dw.port / dw.table   (dw. 前缀隔离)
③ 提交执行: Rust 把 dw_root 冻结进 snapshot 顶层
     (设置后续修改只影响新执行; resume 自动携带; worker 常驻无需重启)
④ worker 解析 dw.* + snapshot.dw_root, 校验(port∈组件outputs, 表名合法)
     → run_node(dw_export={port, table_dir})
⑤ runner: os.makedirs(table_dir, exist_ok=True)
     env 注入 AGENT_UI_OUTPUT_DATA_DIRS = '{"<port>": "<table_dir>"}'
⑥ 组件: 共享 helper resolve_output_data_dir(port) 读 env
     → 数据文件写入表目录(业务方自定子目录/分区); 未配置时维持现状 temp dir
⑦ output.json 登记的路径即 dw 路径
     → 下游 input.json / Rust 预览 / 下载: 零改动自动生效
```

### 3.2 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 落库执行方 | runner 注入目录 + 组件透明写入（非 runner 后置拷贝） | 需求方明确；表内分区布局归业务方控制 |
| dw_root 存储 | Rust 侧 JSON 文件（`~/.agent-ui/dw-settings.json`） | 与 ModelSettings/McpSettings 先例一致，无 DB migration |
| dw_root 流转 | 提交执行时冻结进 snapshot 顶层 | worker 常驻进程，env 方式改设置不生效；snapshot 方式零 schema 变更（worker 已解析 snapshot）、历史执行可复现、resume 自动携带 |
| 节点参数命名 | `dw.` 前缀（`dw.enabled/port/table`） | 仿 `system.` 前缀隔离模式；避免污染源节点输入（源节点 params 会整个作为 input payload，见 worker.py L172-178） |
| 目录注入方式 | 环境变量 `AGENT_UI_OUTPUT_DATA_DIRS`（JSON map：端口→目录） | 结构上天然支持未来多端口扩展；组件侧 helper 一行读取 |
| 表内布局 | 业务方自控（runner 只 mkdir 表根目录） | 需求方明确 |

## 4. 实现步骤

| # | 改动 | 文件 | 要点 |
|---|---|---|---|
| 1 | Rust 全局设置 | `src-tauri/src/utils.rs`、`models_core.rs`（或新建 `dw_core.rs`）、`main.rs`、`server.rs`、设置 UI | `dw_settings_path()`（仿 `model_settings_path()`）；`DwSettings{dw_root}` load/save；tauri command `load_dw_settings`/`save_dw_settings`；**server.rs 两处路由表（L184 与 L937）都加 `/dw/settings` GET/PUT**；设置面板仿 models-settings-panel，默认 `/opt/agent-ui/dw` |
| 2 | snapshot 冻结 | `scheduler.rs` `build_snapshot`（L46-76） | 顶层注入 `dw_root`（读设置文件，空则默认值）；`build_resume_snapshot` 调 build_snapshot，resume 自动携带 |
| 3 | 节点配置 UI | `InstanceConfigForm.tsx` | `DW_PREFIX="dw."`，readParams/commit 仿 SYSTEM_PREFIX 的剥离/保留（L243-255）；固定"注册到DW"区块：开关 + 端口下拉（`component.outputSchema` → PortDef，见 componentModel.ts L21-38；outputSchema 为空的组件隐藏区块）+ 表名文本框 |
| 4 | worker | `engine_executor/worker.py` | 解析 `dw.enabled/port/table`；校验 `dw.port` ∈ snapshot node config 的 outputs、`dw_root` 非空、表名合法（不合法 → 节点 fail + 日志）；`dw_export={port, table_dir}` 传入 run_node（L389 调用点加参）；build_input 源节点分支（L172-178）过滤 `dw.*`（顺带过滤 `system.*`，消除既有污染） |
| 5 | runner | `engine_executor/runner.py` `run_node` | 新参数 `dw_export=None`；表名白名单 `^[A-Za-z0-9_\-]+$`（拒绝 `..` 与绝对路径，防穿越）；`os.makedirs(table_dir, exist_ok=True)`；env.update（L529）注入 `AGENT_UI_OUTPUT_DATA_DIRS=json.dumps({port: table_dir})`；info 日志记录落库目录 |
| 6 | 组件接入 | component-repo：共享 util + `components/comp-upstream/run.py`（L931）+ `components/comp-downstream/run.py` 等 | 新 helper `resolve_output_data_dir(port)`：读 `AGENT_UI_OUTPUT_DATA_DIRS`，未配置返回 None；组件数据文件落点改为 `resolve_output_data_dir(port) or tempfile.mkdtemp(...)`；`_write_output` 登记逻辑不变 |
| 7 | 下游读/预览/下载 | — | **零改动**（登记路径即 dw 路径） |

另：本设计文档存于 `agent-ui/docs/dw-export-design.md`；实现后在 component-repo 组件开发规范中补"DW 落库"一节（表目录约定、原子写建议）。

## 5. 边界与风险

| 风险 | 处理 |
|---|---|
| 并发写同一张表 | 不做文件锁；文档约定组件对分区原子写（临时文件 + rename）；目录创建由 runner 保证 |
| 老执行兼容（snapshot 无 dw_root） | worker `plan.get("dw_root")` 缺省 → 跳过落库，行为回退现状 |
| resume 重跑 | snapshot 携带 dw_root 与首次一致；重复写分区要求组件幂等（覆盖写） |
| 表名路径穿越 | runner 白名单校验 `^[A-Za-z0-9_\-]+$`，拒绝 `..`/绝对路径，不合法节点 fail |
| 默认路径跨平台 | 默认值是 worker 所在 Linux 机器的路径；macOS 开发机不存在时 `mkdir -p` 自动创建 |
| 多端口扩展 | env 为 JSON map，本期 UI 单端口单表，未来可扩多端口映射 |
| 双路由遗漏 | server.rs 本地/HTTP 两处路由表必须同时加，漏一处导致某模式设置不生效 |
| pyarrow 缺失 | 与现状一致（组件自装依赖），dw 不引入新依赖 |

## 6. 验证方案

**单测**
- Rust：`DwSettings` load/save（仿 models_core 测试）；`build_snapshot` 含 dw_root；表名校验函数
- Python：worker 解析 `dw.*` 与端口校验；build_input 过滤 `dw.*`/`system.*`；runner 表名穿越拒绝（engine_executor 已有 test_prepare_env.py 先例）

**端到端**
1. 设置 dw_root
2. DAG：comp-upstream → comp-downstream，前者配 `dw.enabled` + 端口 + 表名
3. 执行后检查：① `{dw_root}/{table}/` 生成数据文件；② 下游 input.json 中输入路径为 dw 路径；③ 预览/下载正常
4. resume 单节点重跑正常
5. 修改 dw_root 后新执行生效、老执行重放仍用旧值（快照冻结语义）
6. 回归：不配置 dw 的 DAG 行为与现状完全一致
