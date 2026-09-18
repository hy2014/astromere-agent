# engine-executor — Python 执行引擎（consumer 侧）

Module: `engine_executor/`（`worker.py` / `db.py` / `runner.py` / `config.py`）
Related: [docs/scheduler.md](scheduler.md), [docs/sqlite.md](sqlite.md), [docs/executor.md](executor.md)

> **唯一执行引擎（2026-07-11 起）**：Rust 同步执行路径（`run_dag_sync` + `executor.rs`）
> 已删除，节点 Python 代码的执行、跨节点边路由、组件源码拉取**只在本模块实现**。Rust 端
> 仅做薄 broker（`run_dag` 入队、`get_execution` 查状态、snapshot 冻结）。新增执行能力请
> 在本模块实现，勿在 Rust 侧重建。

## 职责（用户明确的范围）

`engine_executor` **只做三件事**：

1. **env prepare** —— 准备组件运行环境（git clone + venv + pip install）。
2. **run component** —— 运行组件的 `entry_point`（`run.py`）。
3. **save running log to db** —— 把运行状态流转与 stdout/stderr 写回同一个 SQLite DB。

**不包含** cron 调度器（cron 触发由独立 scheduler 负责，本质也是向 `dag_executions`
插入一条 `submit`）。

## 整体模型：producer-consumer + SQLite 当 broker

```
 Rust run_dag (manual) ─┐
                         ├─> INSERT dag_executions(status='submit') ─> [SQLite]
 cron scheduler (later) ─┘                                            │
                                                                poll + 原子领取
                                                                        │
                                                          engine_executor/worker.py
                                                        (accepted → per-node → success)
```

- Rust 只"写个状态"（类比 MySQL 队列），不真正执行 Python。
- Python worker 是独立进程，读**同一个** `~/.agent-ui/sqlite/agent-ui.db`（WAL 模式）。
- `run_dag`（人触发）与 cron 调度器（定时触发）产出的任务**完全一致**，只是
  `trigger_kind` 不同（`manual` / `cron`）。

## 目录结构

| 文件 | 职责 |
|---|---|
| `worker.py` | 主循环：轮询 → 原子领取 → 按 `execution_order` 跑节点 → 汇总状态；信号处理优雅退出 |
| `db.py` | SQLite 访问：claim / 状态流转 / `node_executions` / 日志 / 读 DAG 计划；启动时 `ensure_executor_schema` |
| `runner.py` | 环境准备（缓存 clone + venv）与单节点执行（subprocess + 日志流 + 取消轮询） |
| `config.py` | 从环境变量读取 `AGENT_UI_DB_PATH` / `ENGINE_EXECUTOR_POLL_INTERVAL` / `ENGINE_EXECUTOR_CACHE_ROOT` / `ENGINE_EXECUTOR_WORKER_ID` / `ENGINE_EXECUTOR_CANCEL_POLL` |
| `requirements.txt` | 空（仅用标准库，无需第三方依赖） |

## 状态机

### 整条执行 `dag_executions.status`

```
submit → accepted → success | failed | cancelled
```

取值枚举（文档化）：

| 状态 | 写入方 | 含义 |
|---|---|---|
| `submit` | Producer（Rust run_dag / cron） | 已入队，等待领取 |
| `accepted` | worker（claim） | 已被某 worker 原子领取 |
| `success` | worker | 所有节点成功 |
| `failed` | worker | 任一节点失败 |
| `cancelled` | worker | worker 检测到 `cancel_requested` 并终止 |

### 单节点 `node_executions.status`（方案 B）

```
preparing → running → success | failed | cancelled | skipped
```

- `preparing`：环境准备（clone / venv / install）。
- `running`：`entry_point` 真正执行中。
- `skipped`：**status 门控跳过**——某上游节点 failed/skipped，本节点被跳过，不 clone、不运行
  （对下游而言等价于 failed，继续传播）。
- 整条状态由节点状态汇总：任一节点 `failed` → 整体 `failed`；中途取消 → 整体 `cancelled`。
  被跳过的节点（`skipped`）不单独算「失败」，但导致它被跳过的那个 `failed` 上游会让整体 `failed`。

### status 门控（分支隔离，2026-07-14）

节点失败**不再中止整条 DAG**，改为**分支级隔离**：

- **门控**：进入某节点前，检查它的所有上游（沿任意入边，data 或 status）是否有 failed/skipped；
  有则本节点标 `skipped` 并 `continue`（失败沿边继续向下游传播）。
- **失败不 abort**：节点自身运行失败 → 标 `failed`、记 `any_failed`、`continue`；**与它无边相连的
  其他分支照常跑完**。
- **门控与端口 kind 无关**：worker 只看「上游节点状态」+ 图的边，不解析端口是 file 还是 status。
  status 端口的意义在前端——给用户一个 handle 去画一条「本无文件关系」的控制依赖边；这条边一旦存在，
  门控就沿它生效。所以「两组件有依赖但无文件传递」= 用 status 边把它们连起来即可。
- **收尾**：有任一 `failed` → 整体 `failed`（但已放行分支都跑完）；否则 `success`；取消 → `cancelled`。

> 各节点状态独立落库，UI 可据此在画布上把每个节点实时标色（runtime instance，第三层 = 运行产物，
> 由 worker 写回，含按输出端口 key 索引的 `outputs`；详见 [docs/components.md](components.md) 三层模型）。

## 原子领取（防重复执行）

`db.claim_next()` 用单条条件 UPDATE + `rowcount` 校验实现乐观锁：

```sql
UPDATE dag_executions
SET status='accepted', worker_id=?, claimed_at_ms=?
WHERE id=? AND status='submit';   -- rowcount == 1 才算抢到
```

多 worker 部署时天然安全；v1 单 worker 也兼容（表结构已留 `worker_id` / `claimed_at_ms`
租约位，未来可加超时回收）。

## 执行流程（worker.process）

1. `claim_next()` 取到 `exec_id`。
2. 读 `dag_executions.dag_id` → `get_dag_plan(dag_id)`（execution_order / nodes / edges）。
3. `compute_order`：优先用 `dags.execution_order`；为空则按 edges 拓扑排序。
4. 逐节点：
   - `upsert_node_execution(status='preparing')`；检查 `cancel_requested`。
   - `resolve_node`：
     - 节点的 `component_id` **永远非空**——拖通用组件到画布即创建一条 `components` 行并
       与之绑定（见 `docs/sqlite.md` 的"通用组件即组件"约定）。`resolve_node` 一律查
       `components` 表取 `git_url/git_branch/git_ref/entry_point`，再 `prepare_env` 解析根目录。
     - **不存在**"空 component_id、git 只存 node.config"的例外：活 `node.config` 只含实例
       参数 `params`，绝不含 git 字段；历史展示用的 git 由 `build_snapshot` 冻结进
       `dag_executions.snapshot`（见 `docs/dag.md`）。读 git 的唯一来源是 `components` 表。
   - `upsert_node_execution(status='running')`。
   - `build_input`：无上游节点 → `config.params` 作为入参；有上游 → 合并上游输出。
   - `runner.run_node` 执行，把 stdout/stderr 写 `execution_logs`。
   - 成功 → `upsert_node_execution(status='success', outputs)` 并记录 `node_outputs` 与
     `node_status[node]='success'`；`outputs` 是按**输出端口 key** 索引的运行产物（如
     `{"data": {"path": "/path/a.csv", "format": "csv"}}`；端口值也可为卡片列表，
     见下「端口值契约」），属三层模型的第三层（运行产物，由 worker 写回，非用户配置）；
     失败 → 写 `failed`、`node_status[node]='failed'`、`any_failed=True` 后 **`continue`（不再终止整体，
     见上「status 门控」分支隔离）**；取消 → 写 `cancelled` 并终止整体。
   - **门控前置**：真正 clone/run 之前先查上游 `node_status`，任一 failed/skipped → 本节点写
     `skipped`、`node_status[node]='failed'`、`continue`。
5. 收尾：`any_failed` → `set_execution_status('failed', outputs=node_outputs)`；否则
   `set_execution_status('success', outputs=node_outputs)`。

## 组件运行契约（entry_point 约定）

- **解释器**：`runner.run_node` 以 `[interpreter, entry_point]` 形式启动组件进程。当前
  `resolve_python` 恒返回 python 解释器，故 `entry_point` 被当作 Python 脚本执行；要直接跑
  `bash` / `node` 等非 Python entry_point，需把解释器解析改成按扩展名选择（`.py→python`、
  `.sh→bash`、`.js→node`，即"方案 B"，尚未实现）。
- **成功判定 = 进程退出码**：`runner.run_node` 返回
  `success = (proc.returncode == 0 and not cancelled)`（`runner.py`）。**这是语言无关的通用契约**——
  Python 跑通 / 抛异常、bash 退出 0 / 非 0，对引擎而言都只看退出码。退出码正是 status 端口
  `success` / `failed` 信号的数据源。
- **⚠️ bash 脚本必须主动上报失败**：bash 默认「遇错不停止、只取最后一条命令的退出码」。一个
  中间命令失败、但末尾 `echo done` 成功的脚本，整体退出码是 `0`，引擎会**误判成功**。正确写法是
  在脚本开头加 `set -euo pipefail`（任一命令失败立即以非 0 退出），或显式 `cmd || { echo err >&2; exit 1; }`。
  只有脚本以非 0 退出，引擎才标记节点 `failed` → status 端口发 `failed` → 下游分支级联 `skipped`。

## 环境准备与缓存（`runner.prepare_env`）

- **git URL（含本地 `file://` 传输）**：`gitUrl` 为 `https://`、`git@` 或
  `file:///abs/path` 等 git 可克隆地址 → 走 `git clone`，按 `(gitUrl, gitBranch, gitRef)`
  哈希缓存到 `CACHE_ROOT/<hash>/`。`file://` 与远程 URL 走**完全相同**的 clone 代码路径，
  是本地验证 git 组件的最佳方式。
- **代码变更检测（核心）**：相同 `(gitUrl, gitBranch, gitRef)` 永远落到同一目录（缓存 key
  确定性），但 **cache 命中后会先重新拉取再复用**，而不是永远用第一次 clone 的旧代码。具体：
  - 首次：clone（`--depth 1 --branch <branch>`），写 `.claw-fetched` 标记。
  - 之后每次：`git fetch --depth 1 origin <branch>` + `git reset --hard origin/<branch>`
    把工作树同步到远程最新。
  - **分支取不到（拼错 / 被删）必须直接报错，绝不回退到其他分支**——否则会静默跑到用户
    从未指定的代码。首次 clone 与缓存命中 re-sync 均遵循此规则（抛 `RuntimeError`，由 worker
    标记节点失败）。
  - 这就是"**改完代码 → push → 再 run dag**"能跑到新代码的保证：executor 不会跑旧缓存；
    同时"分支不存在"这种错误会被明确暴露而非被掩盖。
- **怎么 check 代码变更**：`prepare_env` 接受 `log_fn(kind, msg)` 回调，sync 时会打
  `info` 级日志——`prepare_env: cache exists; re-pulling origin/<branch>`（命中缓存并拉取）
  或 `prepare_env: cache exists; pinning to ref <ref>`（命中缓存并锁定到指定 ref）。worker 把
  该回调接到 `execution_logs`，所以在 UI 的执行日志里就能看到每次运行是"重新拉取了最新"
  还是"命中缓存未变"。
- **可选的版本锁定 `gitRef`**：节点 config 可带 `gitRef`（分支名 / tag 名）。
  - 它被并入缓存 key → **不同 ref 落到不同目录**，互不污染。
  - sync 后把工作树 checkout + reset 到该 ref（`_pin_ref`：先按分支 refspec 取、再按
    tag 取、最后回退取分支以便解析 raw sha）。这样"到底跑了哪份代码"可复现、可审计。
  - 不传 `gitRef`（默认）则永远跑分支最新——绝大多数场景够用；需要锁版本时再填。
- **直接本地目录**：`gitUrl` 为绝对/相对路径、或已存在的目录（非 git URL）→ 直接作为
  `component_root`，**不 clone、不 sync**（适合开发期就地调试）。每次运行直接读该目录，
  所以"改完本地目录里的代码、再 run"立即生效（无需 push）。
- 区分规则：`runner._looks_like_local` 仅把以 `/`、`./`、`../` 开头或本就存在的目录判定为
  "直接本地目录"；其余（含 `file://`）一律当作 git URL 去 clone。
- **依赖**：`requirements.txt` 非空才建 `.venv`（`python3 -m venv`）并 `pip install -r`；
  为空则直接用系统 `python3`。

## 日志

`runner.run_node` 用线程分别读 stdout/stderr，边读边通过 `db.add_log` 写
`execution_logs`（level = stdout/stderr/info/error）。UI 轮询 `get_execution_logs`
即可实时看到，天然跨进程、无需推送。

## 节点级状态查询（UI 用）

Rust 侧 `scheduler::get_node_executions(execution_id)`（`#[tauri::command]` 已注册）
返回该次执行下每个节点的 `node_executions` 行（`NodeExecution`：id / executionId /
nodeId / status / startedAtMs / completedAtMs / outputPath / error）。UI 画布据此把
每个节点实时标色（preparing=灰/转圈、running=蓝、success=绿、failed=红、cancelled=黄），
对应"runtime instance（第三层 = 运行产物）"。与 `get_execution`（整条状态）配合使用。

## 取消（`cancel_requested`）

- Rust `cancel_execution` 置 `status='cancel_requested'`（仅对未完成态生效）。
- worker 在节点**运行期间**按 `ENGINE_EXECUTOR_CANCEL_POLL` 间隔轮询
  `is_cancel_requested`；命中则向组件所在的**进程组**发 `SIGTERM`（超时则 `SIGKILL`），
  确保组件派生的子进程一并终止，节点与整体置 `cancelled`。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_UI_DB_PATH` | `~/.agent-ui/sqlite/agent-ui.db` | 共享 DB 路径（测试时指向临时库） |
| `ENGINE_EXECUTOR_POLL_INTERVAL` | `1.0` | 无任务时空轮询间隔（秒） |
| `ENGINE_EXECUTOR_CACHE_ROOT` | `~/.agent-ui/component-cache` | git clone / 每轮工作目录根 |
| `ENGINE_EXECUTOR_WORKER_ID` | `worker-<pid>` | 写入 `dag_executions.worker_id` |
| `ENGINE_EXECUTOR_CANCEL_POLL` | `0.25` | 运行中取消检测间隔（秒） |

> Rust 侧 `sqlite_database_path` 同样优先读取 `AGENT_UI_DB_PATH`；覆盖该变量时
> Rust 与 Python 引擎会指向同一文件，保证"共享 DB"契约始终成立。

## 运行

```bash
cd engine_executor
python3 worker.py
# 或指定库与缓存：
AGENT_UI_DB_PATH=/path/to/agent-ui.db ENGINE_EXECUTOR_CACHE_ROOT=/tmp/cache python3 worker.py
```

仅依赖标准库，无需 `pip install`。

## 端口值契约（输入/输出端口）

> 本文档是端口值形态的**唯一定义处**，其他文档只引用不重复描述。
> 状态：平台侧（解析 / 预览 / 下载 / SDK）**已实现**；组件侧接入待做
> （见 `docs/dw-export-design.md` §7）。

组件运行结束时以 `output.json`（`$AGENT_UI_OUTPUT_PATH`）回传产物，key = **裸输出端口名**。
每个端口的值支持三种形态：

| 形态 | 值 | 用途 |
|---|---|---|
| 标量 | 字符串 / 数字 / 布尔 | status 端口、摘要值 |
| 单个文件卡片 | `{"path": <绝对路径>, "format": "csv"\|"parquet"\|...}` | 单产物端口 |
| **产物卡片列表** | `[{"path": ..., "format": ...}, ...]` | 一个端口产出**多个独立产物**（如按月/按天分区落盘的表） |

裸字符串路径（`"/abs/file.csv"`）是历史兼容形态，等价于只含 `path` 的卡片，平台按扩展名推断 `format`。

**`path` 可以是常规文件，也可以是目录**（如按分区组织落盘的 `month=YYYYMM/`）。目录形态下
`format` **必填**——目录路径没有扩展名，平台推断不出来，缺省会明确报错而不是猜：

- `format=parquet` 的目录：直接把**目录**交给预览器，pyarrow / pandas 都做 hive 分区发现，
  因此一个分区目录原生可预览（无需平台去挑文件）。
- 其它格式（csv / json）：目录没有单一数据流，平台解析目录内**唯一**匹配文件；不唯一则报错，
  不猜。

**透传规则**：worker 只做搬运——`build_input` 把上游端口值**原样**放进下游 `input.json`。
「上游输出什么形态，下游就收到什么形态」，引擎不做形态转换。由此：

- 老组件（期望单值）在上游仍只出单值时**零改动**继续可用；
- 消费列表形态的组件**必须用 `component_sdk` 归一化**（见下），不要手写 `isinstance` 分支——
  类型适配属于平台契约，应收敛在一处。

**列表的语义（重要）**：列表是该端口**本次执行对应数据范围的完整产出**，不是「本次新算的部分」。
以按月分区的表为例，续跑/复用的月份**同样必须出现在列表里**。下游只对自己的输入负责，
不需要也无法判断哪些是新算的、哪些是复用的——所以「变更集」不属于端口值语义，
需要它应另开端口或由下游自行幂等处理。

**平台侧呈现**：列表端口在预览中**逐项**展示（`index` 选中第 N 项，越界明确报错、不静默回退）；
下载既可**逐项**，也可**打包全部**（`download-all` 返回 ZIP，目录产物按原分层形状收进压缩包）。

## 组件 SDK（`component_sdk`）

平台契约（`AGENT_UI_*` 环境变量）由 **agent-ui 拥有并实现**，组件只是消费方。SDK 因此放在
agent-ui 仓库内（`engine_executor/sdk`），由 `runner.run_node` 在启动组件进程时注入：

| 注入项 | 内容 |
|---|---|
| `PYTHONPATH` | 追加 `<agent-ui>/engine_executor/sdk` |
| `AGENT_UI_SDK_PATH` | 同上的绝对路径（非 Python 组件可直接读该变量） |

组件侧：

```python
from component_sdk import read_input_files

paths = read_input_files("out_features")   # 恒返回 list[str]；单值自动包成 [单值]
```

设计要点：

- **SDK 随 worker 同源同版本**（同仓库同部署）：契约变更时组件自动跟上，组件仓库**不需要**
  vendor 它、也不需要写进 `requirements.txt`；
- 形态归一化只发生在 SDK 内部一处，组件代码里不出现类型分支；
- 契约本体是**环境变量**，不是 Python 包——bash 等非 Python 组件不受影响，直接读 env 即可；
- 这与「instance 配置不得泄漏进组件」的原则不冲突：SDK 承载的是**平台 I/O 契约**
  （对所有组件一致），而非某个节点的配置决策。

## 文件卡片消费示例（helloworld）

`format=file` 端口传递的是**文件卡片** `{ "path": <绝对路径>, "format": "csv"|"parquet" }`，
而不是文件内容。生产节点（如 `dataset-loader`）只校验并回传路径；**消费节点必须自己
`open(path)` 读取**。参考实现见 `components/helloworld/run.py`：

- 入参：上游 `outputFile` 卡片经 `build_input` 落到本节点的输入端口 `Input`：
  `data["Input"] == {"path": "/x.csv", "format": "csv"}`。helloworld **按端口名 `Input`
  显式读取**这份文件卡片（绝不扫描所有入参值找 `path`）——端口名是组件契约，改端口名须同步改代码。
- 处理：用标准库 `csv` 读取，给每一行（含表头）追加 `helloworld` 列，值恒为 `"helloworld"`。
- 出参：写出一份新 CSV，再以**输出端口名 `output`** 为 key 回传文件卡片
  `{"output": {"path": <新csv>, "format": "csv"}}`（worker 按 `source_handle` 路由下游，
  所以 key 必须匹配输出端口名）。

> 端口类型对齐：消费节点的输入端口应声明 `format=file`（如 helloworld 的 `Input`）、
> 产出文件卡片的输出端口同样声明 `format=file`（如 `output`），与 `dataset-loader` 的
> `outputFile`(format=file) 端口语义一致，避免"文件卡片 ↔ csv 标量"的端口类型错位。

> **列表形态**：若上游该端口回传卡片列表，下游拿到的 `data["Input"]` 就是数组。此时不要
> 自己写 `isinstance` 判断——用 `component_sdk.read_input_files("<端口名>")` 归一化后逐项读取
> （见上「组件 SDK」）。helloworld 是纯单值示例，不含该分支。

## 测试

`src-tauri/tests/executor_e2e.rs`：

1. `setup_home` 指向临时目录（隔离真实 DB）。
2. 建本地 helloworld 组件目录（`run.py` 输入文本、输出加 `helloworld` 列 + 空
   `requirements.txt`）。
3. 建 DAG + 节点：先 `insert_component` 注册正规 `components` 行（git/entry_point 在组件表），
   节点 `config` 只含 `params={text:hello}`（活 `node.config` 不含 git），`publish_dag`。
4. spawn `python3 worker.py`（`AGENT_UI_DB_PATH`=临时库）。
5. `scheduler::run_dag(dag_id)` 触发提交。
6. 轮询监控 `dag_executions` 与 `node_executions` 状态流转。
7. 断言：最终 `success`、节点 `success`、输出含 `helloworld` 列且值正确、全流程状态完整。
8. 结束 kill worker。
