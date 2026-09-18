# DW 数据仓库落库 — 系统设计方案

> 状态：DW 落库已实现（2026-09-15）；**端口值列表形态 + component_sdk 为设计已定、待实现**（见 §7）
> 日期：2026-09-15（§7 追加于 2026-09-18）
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
     → run_node(dw_export={port, table_dir}, output_ports=快照outputSchema全部端口)
⑤ runner: 对**每个**输出端口分配目录并 os.makedirs
     env 注入 AGENT_UI_OUTPUT_DATA_DIRS = '{注册端口: <table_dir>, 其余端口: {work_dir}/outputs/<port>}'
⑥ 组件: component_sdk.resolve_output_dir(port) 读 env（SDK 随 runner 注入, 无 DW 语义）
     → 数据文件写入环境给的目录; 未注入(单跑)时回退 temp dir
⑦ output.json 登记产出：单产物端口写文件卡片；分区表等多产物端口写**产物卡片列表**
     → 下游 input.json 原样透传；Rust 预览/下载已支持列表分支（见 §7）
```

**组件零 DW 感知**：DW 注册是 instance（节点配置）层的事，组件（class）只认识
"环境注入的输出目录"这一通用概念——agent-ui 的 runner 对所有文件端口统一注入
`AGENT_UI_OUTPUT_DATA_DIRS`，组件写入注入目录即可，不需要 import 任何 DW 模块。
未来若新增其他落库目标（S3/NFS），只需 runner 侧改目录分配策略，组件代码零改动。

### 3.2 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 落库执行方 | runner 注入目录 + 组件透明写入（非 runner 后置拷贝） | 需求方明确；表内分区布局归业务方控制 |
| dw_root 存储 | Rust 侧 JSON 文件（`~/.agent-ui/dw-settings.json`） | 与 ModelSettings/McpSettings 先例一致，无 DB migration |
| dw_root 流转 | 提交执行时冻结进 snapshot 顶层 | worker 常驻进程，env 方式改设置不生效；snapshot 方式零 schema 变更（worker 已解析 snapshot）、历史执行可复现、resume 自动携带 |
| 节点参数命名 | `dw.` 前缀（`dw.enabled/port/table`） | 仿 `system.` 前缀隔离模式；避免污染源节点输入（源节点 params 会整个作为 input payload，见 worker.py L172-178） |
| 目录注入方式 | 环境变量 `AGENT_UI_OUTPUT_DATA_DIRS`（JSON map：端口→目录），**对所有端口无条件注入** | 组件零 DW 感知（instance 配置不泄漏进 class）；结构上天然支持未来多端口扩展 |
| 表内布局 | 业务方自控（runner 只 mkdir 表根目录） | 需求方明确 |
| 端口值形态 | 标量 / 文件卡片 / **卡片列表**（契约统一定义在 `engine-executor.md`） | 一个端口可产出多个独立产物（分区表）；但列表语义是**数据范围的完整产出**，不含"变更集" |
| 形态归一化 | 平台 SDK `component_sdk`（agent-ui 拥有，runner 注入） | 类型适配收敛一处，组件不写 `isinstance` 分支；SDK 与 worker 同源同版本（详见 §7） |

## 4. 实现步骤

| # | 改动 | 文件 | 要点 |
|---|---|---|---|
| 1 | Rust 全局设置 | `src-tauri/src/utils.rs`、`models_core.rs`（或新建 `dw_core.rs`）、`main.rs`、`server.rs`、设置 UI | `dw_settings_path()`（仿 `model_settings_path()`）；`DwSettings{dw_root}` load/save；tauri command `load_dw_settings`/`save_dw_settings`；**server.rs 两处路由表（L184 与 L937）都加 `/dw/settings` GET/PUT**；设置面板仿 models-settings-panel，默认 `/opt/agent-ui/dw` |
| 2 | snapshot 冻结 | `scheduler.rs` `build_snapshot`（L46-76） | 顶层注入 `dw_root`（读设置文件，空则默认值）；`build_resume_snapshot` 调 build_snapshot，resume 自动携带 |
| 3 | 节点配置 UI | `InstanceConfigForm.tsx` | `DW_PREFIX="dw."`，readParams/commit 仿 SYSTEM_PREFIX 的剥离/保留（L243-255）；固定"注册到DW"区块：开关 + 端口下拉（`component.outputSchema` → PortDef，见 componentModel.ts L21-38；outputSchema 为空的组件隐藏区块）+ 表名文本框 |
| 4 | worker | `engine_executor/worker.py` | 解析 `dw.enabled/port/table`；校验 `dw.port` ∈ snapshot node config 的 outputs、`dw_root` 非空、表名合法（不合法 → 节点 fail + 日志）；`dw_export={port, table_dir}` 传入 run_node（L389 调用点加参）；build_input 源节点分支（L172-178）过滤 `dw.*`（顺带过滤 `system.*`，消除既有污染） |
| 5 | runner | `engine_executor/runner.py` `run_node` | 新参数 `dw_export=None`、`output_ports=None`；表名白名单 `^[A-Za-z0-9_\-]+$`（拒绝 `..` 与绝对路径，防穿越）；`os.makedirs(table_dir, exist_ok=True)`；对**所有端口**分配目录（注册端口 → 表目录，其余 → `{work_dir}/outputs/{port}`）并注入 `AGENT_UI_OUTPUT_DATA_DIRS=json.dumps(全端口map)`；info 日志记录落库目录 |
| 6 | 组件接入 | component-repo：`components/comp-upstream/run.py`、`components/comp-downstream/run.py` | 改用平台注入的 `component_sdk.resolve_output_dir(port)`（读 `AGENT_UI_OUTPUT_DATA_DIRS`，未注入返回 None，组件不 vendor SDK）；数据文件落点改为 `resolve_output_dir(port) or tempfile.mkdtemp(...)`；**不 import 任何 DW 模块**；`_write_output` 登记逻辑不变 |
| 7 | 下游读/预览/下载 | — | **零改动**（登记路径即 dw 路径）；列表形态需平台加分支，见 §7 |

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

## 7. 端口值列表形态 + component_sdk（平台侧已实现，组件侧待接入）

### 7.1 问题

一个端口可能产出**多个独立产物**——典型是按时序分区落盘的表（如 comp-upstream 的
`month=YYYYMM/` 目录）。平台原先 `output.json` 只支持单值（文件卡片或裸路径），这类端口
只能登记**目录**，而目录在平台侧预览/下载会因 `is_file()` 校验直接失败
（`scheduler.rs` `preview_node_output`、`dag_api.rs` `download_node_output_handler`）。

### 7.2 端口值形态

契约在 `docs/engine-executor.md`「端口值契约」统一定义（该文档是**唯一**定义处）：

| 形态 | 值 |
|---|---|
| 标量 | 字符串 / 数字 / 布尔（status 端口、摘要值） |
| 单个文件卡片 | `{"path": <绝对路径>, "format": "csv"\|"parquet"}` |
| **产物卡片列表** | `[{"path": ..., "format": ...}, ...]` |

裸字符串路径为历史兼容形态，等价于只含 `path` 的卡片。`path` 可以是文件或目录，为目录时
`format` 必填（细节见 `engine-executor.md` 同名章节）。

### 7.3 列表的语义：范围即输出（非变更集）

**列表 = 该端口本次执行对应数据范围的完整产出**，不是「本次新算的部分」。

组件只对**自己的输入范围**负责：输入给了 3 个月，就产出这 3 个月；其中可能是本次真算的，
也可能是复用历史已有分区的，**两者都必须出现在列表里**——否则下游拿到的数据是残缺的。
换言之「历史里已有」不构成不输出的理由。

推论：

- 组件侧枚举依据是**输入范围**（`month_expected` 一类），**不是**本次待算集合（`todo`/`flushed`）；
- 下游只对自己的输入负责，不判断 provenance、不接收任何 change 信号；
- 「变更集」不属于端口值语义——若确需，另开端口承载，或由下游自行幂等处理。

### 7.4 `component_sdk`（平台契约的客户端）

契约（`AGENT_UI_*` 环境变量）由 agent-ui 拥有，SDK 也归 agent-ui；组件只是消费方。

- **位置**：`apps/agent-ui/engine_executor/sdk/component_sdk/`
- **注入**：`runner.run_node` 追加 `PYTHONPATH` 指向 `sdk/`，并设 `AGENT_UI_SDK_PATH`
  （非 Python 组件可直接读该变量）
- **用法**：

```python
from component_sdk import read_input_files
paths = read_input_files("out_features")   # 恒返回 list[str]；单值自动包成 [单值]
```

优势：SDK 与 worker **同源同版本**（契约变更组件自动跟上，无需改组件仓库）；组件仓库
**零依赖**（不 vendor、不进 `requirements.txt`）；形态分支收敛在 SDK 内部一处。

> 与「instance 配置不得泄漏进组件」不冲突：SDK 承载的是**平台 I/O 契约**（对所有组件一致），
> 而非某个节点的配置决策。

### 7.5 改动清单

| # | 改动 | 文件 | 要点 |
|---|---|---|---|
| 8 | 平台支持列表 | `src-tauri/src/scheduler.rs`、`dag_api.rs` | 共用解析 `parse_port_entry`（列表/卡片/裸字符串统一收敛为 `OutputArtifact{path,format}`，空列表报错）；preview 加 `index` 参数并回填 `artifacts`，目录产物按 `format` 分流（parquet 直通 hive、csv/json 解析唯一匹配文件）；download 加 `index`，单值分支保留兼容 |
| 9 | SDK | 新增 `engine_executor/sdk/component_sdk/`；`runner.py` | 注入 `PYTHONPATH` + `AGENT_UI_SDK_PATH`；`read_input_files` 做形态归一化 |
| 10 | 组件登记 | component-repo `components/comp-upstream/run.py` | 登记改为产物卡片列表，每项是月分区**目录**（`[{path: "…/month=YYYYMM", format: "parquet"}]`）；枚举**输入范围**的月分区，含复用月份；`_check_and_register` 已保证完整 |
| 11 | 组件读取 | `components/comp-downstream/run.py`（以及 comp-upstream / comp-prep 的文件端口） | 改用 `component_sdk.read_input_files` 后逐项读 + concat，兼容单值 |
| 12 | 文档 | `engine-executor.md`（契约定义处）、`dag.md`、`component-mode.md`、本文件；component-repo 各组件设计文档 | 契约只定义一处，其余引用 |
| 13 | 打包下载 | 新增 `src-tauri/src/zip_store.rs`；`dag_api.rs` | 新增路由 `…/outputs/:output_name/download-all`：逐产物收集成员（目录递归、保留 `month=YYYYMM/` 形状）→ store-only ZIP 流式响应（零新依赖、CRC-32 + data descriptor），重名加 `_2`/`_3`；zip-slip 校验拒绝绝对路径与 `..` |
| 14 | 前端 | `component-mode/api.ts`、`DataPreviewModal.tsx` | `previewNodeOutput` / `downloadNodeOutput` 加 `index`；新增 `downloadAllNodeOutputs`；端口产物 >1 时渲染产物面板（逐项切换 + 下载 + 「打包下载全部」） |

### 7.6 验证

- **平台**（已验）：列表 preview `index=0/1`、越界报错、空列表报错、单卡片、裸字符串均正确；单产物
  download 与 `download-all` 生成的 zip 经 Python `zipfile.testzip()` 校验 CRC 全对、目录形状与内容
  逐字节一致；parquet 目录走 hive 发现（`filePath` 保持目录）；headless 构建通过
- **组件**：comp-upstream 在「全量首跑」与「续跑复用」两种情况下，登记的列表**一致**（都含复用月份）
- **下游**：comp-downstream 收到列表与收到单值时结果一致（归一化生效）
- **非 Python 组件**：不受影响（契约本体是环境变量）
