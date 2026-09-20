# components — Component model & CRUD

Module: `src-tauri/src/components.rs`
Related: [docs/sqlite.md](sqlite.md), [docs/dag.md](dag.md), [docs/component-session.md](component-session.md)

## 数据模型

一个 Component 是**组件定义**（可运行配置 + IO 端口），存于本表。代码在 git 仓库里，
由 `git_url` / `git_branch` / `git_ref` / `entry_point` 定位。

组件有**两种身份**，由 `global` 列区分：

- **通用组件（`global = 0`，默认 / 日常）**：从「组件」分组**顶部「通用组件」拖拽项**
  拖到画布即 `createComponent`（`global=0`）+ 写 `dag_nodes` 引用它。**拖拽即建**，
  不复用、**不进**「组件」注册表列表。这是最常见用法。
- **已注册组件（`global = 1`，跨 DAG 复用）**：经「组件」分组的「注册组件」表单
  `createComponent`（`global=1`）写入；出现在「组件」列表，可拖入**多个 DAG**。
  同一 `component_id` 被多个 DAG 节点引用 → 组件定义只存一份（跨 DAG 复用）。

写入路径：

- **通用（拖拽即建）** = 拖「通用组件」项 → 画布 `onDrop` 调 `createComponent`（`global=0`）
  + 写 `dag_nodes`。
- **注册** = 「注册组件」表单写 `components`（`global=1`）；之后从「组件」列表拖拽引用
  （`application/claw-component` = component_id），**拖拽时不再新建组件**。
- 组件配置表单的「注册此组件」勾选可把任意组件在 `global=0/1` 间切换：勾选即进入注册表、
  可被其它 DAG 复用（覆盖"多次使用 → 注册"）。

其它：

- component 的可运行配置（git 地址、分支、ref、entrypoint、参数）**存本表**，是本表
  的真相源；活 `dag_nodes.config` 只承载实例参数 `params`，
  `build_snapshot` 在提交运行时把本表 git/entryPoint/`configSchema`/name 注入冻结快照（非写入 node.config）。
  本表 `workspace_root` 为遗留 deprecated 列，逻辑上不再使用。
- `component_root_from_entry_point()` 仍用于**本地 workspace 型** component 的
  文件校验，git 型 component 不走这条路径（见 `dag.rs::validate_dag_for_publish`）。

`component_root_from_entry_point()` 行为：

- `/a/b/c/xxxx/main.py` → `/a/b/c/xxxx`
- 相对路径 `xxxx/main.py` → `xxxx`
- 无父目录的路径（如 `main.py`，父目录为空）→ 报错（不会解析成 cwd）

## 三层模型（组件定义 / 实例配置 / 运行产物）

一个组件在系统里分三个层次，互不混淆：

| 层 | 存哪 | 性质 | 谁写入 |
|----|------|------|--------|
| 组件定义（元数据） | `components` 表 | 组件"是什么"：git 源 + IO 端口 + 配置项 schema | 注册/配置组件时，用户 |
| 组件实例配置 | `dag_nodes.config`（JSON） | 组件"在某 DAG 里怎么用"：按 schema 填的参数值 | 编辑 DAG 时，用户 |
| 运行产物 | `node_executions`（含 `outputs`） | 组件"这次跑出什么"：各输出端口的文件地址 | 运行时，worker |

- **`components` 表是定义的真相源**；`dag_nodes.config` 是实例级配置（节点级，非 DAG 级）；
  `node_executions.outputs` 是运行后才产生的**产物**，不是用户的"运行期配置"。
- 同一 `component_id` 被多个 DAG 的节点引用 → 定义只存一份；各 DAG 的实例配置值（`dag_nodes.config`）
  互不影响。这就是"组件在某 DAG 的配置 ≠ 组件本身的配置"。

## 配置项 schema（config_schema）

组件可声明一组**配置项（参数）**，供使用者（实例级）按 schema 填入。声明存于
`components.config_schema`（TEXT，JSON 数组，NULL/空 = 无参数）。

### 项结构

```json
{
  "key": "year",            // 唯一 key，须与 run.py 读取的入参名一致
  "label": "年份",          // UI 展示名
  "type": "number",         // 类型系统（见下）
  "required": true,         // 是否必填
  "default": null,          // 可选默认值
  "enum": null,             // type=enum 时的可选项
  "description": "要补的年份"
}
```

### 类型系统

- 基础类型：`string` / `number` / `boolean` / `enum`（带 `enum` 选项）/ `path`（文件或目录路径）/ `date` / `textarea`（多行文本，适合 SQL 等长文本）。
- `list`：列表类型，必须标明元素类型，结构为 `{"kind":"list","element":"<基础类型>"}`
  （如 `{"kind":"list","element":"string"}` 为字符串数组）。
- 每种类型对应一种 UI 控件 + 一种 validation 规则；`list` 还需校验每个元素符合元素类型。

> 注意：本节是**配置参数**（`components.config_schema`）的类型系统，与**端口值**形态是两回事。
> 端口值（`node_executions.outputs`，即组件回传的产物）的形态定义见
> `docs/engine-executor.md`「端口值契约」，不在此重复。

### 共享连接登记与 `resolve_db_connection`

`databases.json`（`~/.agent-ui/databases.json`）是**平台 UI 与组件共享的连接池**：
平台负责写（高级配置 → 数据库 tab 的登记增删改），组件运行时可经 SDK 读。它不是
「平台内部配置」——组件读它不违反平台透明性约束。

组件 configSchema 里以普通字符串字段声明连接名，运行时调用 SDK：

```python
from component_sdk import resolve_db_connection
info = resolve_db_connection(params["connection"])   # {host, port, dbname, user, password}
```

- SDK `resolve_db_connection(name)`：读共享登记文件，按 `name` 命中返回连接信息 dict，
  组件**自己按字段拼连**（psycopg2.connect(host=, port=, ...) 或拼 postgres:// DSN）。
- 找不到 name / 文件不可读 → 抛 `ValueError`（中文），组件明确报错，不静默空跑。
- 登记文件的读写权限：平台写、组件读；password 只在登记文件与组件进程内出现，
  不进快照、input.json。连接名拼错由 validate（见下）在节点表单提前暴露。

### validate 协议（Rust 侧组件域逻辑）

平台组件可在 `src-tauri/src/platform_components/` 下提供配置验证：一个组件一个
`<name>.rs`，在 `mod.rs` 的 `registry()` 里按组件 name 注册。没注册的组件前端不显示
「验证配置」按钮，行为不变。

| 方法 + 路径 | 语义 |
|---|---|
| `GET /api/components/validate-capabilities` | 提供 validate 的组件 name 列表 |
| `POST /api/components/:component_id/validate` | body 为该节点当前运行参数；返回 `{ok, message}`，前端原样展示 |

### 声明方（author vs UI）

`config_schema` 由**用户在 UI 注册/配置组件时手动声明**（增删参数行、设类型/必填/默认值/枚举），
写入 `components.config_schema`。理由：使用者最清楚组件要哪些参数，不依赖 git 作者在仓库里预埋元数据。
隐含约束：UI 声明的 `key` 必须与 `run.py` 实际读取的入参名一致（由使用者保证）。

## 命令（Tauri commands）

| 命令 | 说明 |
|---|---|
| `list_components()` | 按 `updated_at_ms` 倒序返回所有组件（含 `global`；前端按 `global` 过滤注册表列表） |
| `get_component(component_id)` | 取单个组件 |
| `update_component(component)` | 更新组件字段 |
| `delete_component(component_id)` | **物理删除**组件行（级联删 `component_sessions`，因 FK）。**被引用保护**：若仍有 `dag_nodes.component_id` 指向它（`ON DELETE CASCADE` 会静默删节点并留悬空边），则拒绝删除并返回中文报错，提示先删引用节点。前端组件库 `⋯` 菜单的「删除」入口走此命令 |
| `list_component_files(component_id)` | 列出 `component_root` 下文件 |
| `verify_component(component_id)` | 返回缺失的必需文件列表（见下） |

内部函数：`insert_component()`（仅测试/种子用，**当前未暴露为命令**）、
`read_component_file()` / `write_component_file()`、`component_root_from_entry_point()`。

## 发布前校验 `verify_component`

检查 `component_root`（即 `entry_point` 所在目录）下必须存在：

1. `entry_point` 文件本身
2. `requirements.txt`
3. `SKILL.md`

（`component.json` 曾作为第 4 个必需文件，但因其内容运行时从不被读取、易与数据库契约漂移，
已于 2026-07-11 删除该项校验及文件本身。）

返回**缺失项列表**（空 = 通过）。`publish_dag` 会逐个节点调用它。

## 创建组件（create_component）

- `create_component(component)` 命令：包装 `insert_component`（INSERT），返回完整 `Component`。
  已注册到 `main.rs` 的 `invoke_handler`，前端经 `tauri.ts` 的 `createComponent(component)` 调用。
- **两个调用方**：
  - 「注册组件」表单：填 git 来源/入口/参数/IO 后提交，写入 `global=1` 的组件定义，
    随后出现在「组件」注册表列表供复用。
  - 「通用组件」拖拽项：拖到画布时 `ComponentCanvas.onDrop` 调 `create_component`
    写入 `global=0` 的组件 + 写 `dag_nodes` 引用它（拖拽即建，不复用）。
  - 组件配置表单的「注册此组件」勾选可在 `global=0/1` 间切换。
  - 拖「已注册组件」到画布时**不再**调 `create_component`（只写 `dag_nodes`
    引用已注册 `component_id`）。

## 已知缺口（Known gap）

- （已修复）原先没有 `create_component` 命令，前端"新建组件"走 `updateComponent`（仅 UPDATE）无法落库；
  现已补齐 `create_component` 命令。`create_component` 现在由「注册组件」表单调用。
- `executor.rs` / `run_dag_sync`（Rust 同步执行路径）已于 2026-07-11 **删除**：它是生产
  `worker.py` 之外的第二份节点执行实现，违反「单一执行引擎」一致性原则；`integration` 测试
  已改为走 `run_dag`（入队）+ 启动 `worker.py`。
  `dag_nodes.config` 物理删除仍待后续单独迁移。
