# 通用写库组件 update-table（设计）

## 定位

一个**通用**组件：把前端某个输入表格（parquet）**增量 upsert** 进数据库表。平台自带，任何 DAG 复用，不绑定某张表/某条业务。

## 动机

DAG 里常见两种角色需要分开：

- **产出数据的节点**只负责把结果落成 parquet 并登记端口，不碰数据库（端口值形态见
  `docs/engine-executor.md`「端口值契约」）。
- **写入数据库**是独立动作，需要一个终端节点承接「读 parquet → upsert 进表」。

把它做成平台通用组件而不是写在某个业务组件里，是为了：任何 DAG 复用、不必为每个写库场景重写一遍「列映射 + 参数绑定 + 批量执行」。

## 契约

| 项 | 值 |
| --- | --- |
| 组件名 | `update-table` |
| 仓库 | `git@github.com:hy2014/astromere-agent.git` 分支 `dev` |
| 入口 | `apps/agent-ui/components/update-table/run.py` |
| 输入端口 | `table`（单输入，`format=file`）——引用方式固定为 `table.<列>` |
| 输出端口 | `update_status`（`type=status`）：`"inserted 1234 rows"`。与 `exec_bash` 的 `exec_status` 同形态，避免"组件未生成输出文件"告警 |

目标数据库：PostgreSQL（`ON CONFLICT ... DO UPDATE` 是 PG 语法，组件只支持 PG）。

### configSchema

| key | type | 说明 |
| --- | --- | --- |
| `database` | database | 目标数据库：下拉选择已登记的数据库（必填） |
| `table_name` | db_table | 目标表：下拉选择所选数据库里的表（必填） |
| `columns` | list(string) | 列映射，每项 `目标列=输入列`（必填，≥1） |
| `conflict_cols` | list(string) | `on conflict (<这些列>)` 的唯一键（必填，≥1） |
| `update_conflict` | boolean | true=`do update`，false=`do nothing`（默认 true） |

`database` / `db_table` 是 configSchema 新增的字段类型（语义见下「组件配置 UI」）。

节点 config 只存**引用**，不含任何连接信息，例：

```json
{"database": "dw-main", "table_name": "my_features",
 "columns": ["trade_date=日期", "sent=情绪值"],
 "conflict_cols": ["trade_date"], "update_conflict": true}
```

`columns` 用 `目标列=输入列` 的列表表达映射（输入列名与目标列名允许不同）。separator 用 `=`：列名里不含 `=`，不会歧义。

> 为什么不是「两个平行列表」或「对象列表」：configSchema 的 list 只支持**标量元素**
> （`{kind:"list", element:<base>}`，见 `types.ts` `ConfigFieldType`），表达不了
> `[{input, target}]`；两个平行列表要靠人工保持对齐，容易错位。

### configSchema 示例

```json
[
  {"key": "database", "label": "数据库", "type": "database", "required": true},
  {"key": "table_name", "label": "目标表", "type": "db_table", "required": true},
  {"key": "columns", "label": "列映射 [目标=输入]", "type": {"kind": "list", "element": "string"}, "required": true},
  {"key": "conflict_cols", "label": "唯一键列", "type": {"kind": "list", "element": "string"}, "required": true},
  {"key": "update_conflict", "label": "冲突时更新", "type": "boolean", "required": false, "default": true}
]
```

## 数据库注册（高级配置）

数据库连接信息统一登记在服务器侧，节点只引用登记名。

- **入口**：DAG 模式「高级配置」新增 tab「数据库」，与「服务器连接」「DW 数据仓库」并列（服务器侧配置，经 HTTP 读写）。
- **登记项**：`name`（唯一）、`host`、`port`、`dbname`、`user`、`password`。
- **API**（挂在 dag server 上，与 `/dw/settings` 同风格）：

| 方法 + 路径 | 语义 |
| --- | --- |
| `GET /databases` | 列表；**不返回 password** |
| `POST /databases` | 新增 |
| `PUT /databases/:name` | 修改；password 留空 = 保留原密码 |
| `DELETE /databases/:name` | 删除 |
| `POST /databases/:name/test` | 测试连接，返回 `{ok, message}` |
| `GET /databases/:name/tables` | 该库用户可访问的表名列表 |

- **存储**：服务器侧本地持久化，凭据不进公共仓库。

## 组件配置 UI（下拉联动 + 测试连接）

- `database` 字段渲染为**下拉**，选项 = `GET /databases` 的登记名列表；选定后右侧有「测试连接」按钮，调 `POST /databases/:name/test`，通过显示「连接成功」，失败显示原因。
- `table_name` 字段渲染为**下拉**，选项 = `GET /databases/:name/tables`（`name` 取 `database` 字段当前值）；`database` 未选时禁用。
- **联动**：`database` 变更后 `table_name` 选项刷新；原选值不在新库中则清空。
- 类型规则：一个组件的 configSchema 里最多声明一个 `database` 字段；`db_table` 的选项依赖该字段的当前值。

## 运行行为

1. **提交时校验**（`build_snapshot`）：节点 config 里 `database` 的值必须已登记，否则提交失败，中文报错（含节点 + 参数名）——与参数日期表达式非法报错同风格。数据库名随节点 config 冻结进快照。
2. **执行时解析连接**：worker 把 `database` 名解析为完整连接串（`postgresql://user:password@host:port/dbname`），经环境变量 `AGENT_UI_DB_DSN` 注入组件进程。连接信息**不随快照冻结**：注册表里改密码/换地址无需重新提交，下次执行即用新值；执行时该名已无登记 → 明确报错「数据库 <name> 未注册」。
3. 读输入端口 `table`（`component_sdk.read_as_df_from_card` 或按需列表逐项 concat）。
4. 校验每个 `目标列=输入列` 里的**输入列确实存在于输入表**，不在 → 报错退出。
5. 组装一条 UPSERT 语句：
   ```sql
   INSERT INTO <table_name> (<目标列...>) VALUES (%s, ...)
   ON CONFLICT (<conflict_cols...>) DO UPDATE SET <目标列 = EXCLUDED.<目标列>, ...>
   ```
   `update_conflict=false` 时尾部改为 `DO NOTHING`。占位符用 psycopg2 的 `%s`。
6. 用 `executemany`（批量绑定）逐行插入，列值来自 `table.<输入列>`。
7. 成功 → 输出端口 `update_status` 记 `inserted N rows`。

组件读连接的契约是**环境变量 `AGENT_UI_DB_DSN`**（bash 等非 Python 组件直接读 env）；SDK 提供 `read_db_dsn()` 包装，与 `read_input_files` 等同层。

## 关键设计点

- **凭据边界**：密码只存在于服务器侧注册表和执行时的组件进程环境；不进节点 config、不进快照、不进 `input.json`、不进公共仓库；`GET /databases` 不回显密码。update-table 组件代码进公共仓库，不含任何凭据。
- **节点 config 只存引用**：换库 = 下拉换一个登记名；节点配置自描述且无敏感信息。
- **只替换 `table.` 前缀的占位符**，`EXCLUDED.`、`ON CONFLICT` 是 SQL 自身语法，不碰。
- **参数绑定而非字符串拼接**：防注入 + 批量执行快。
- **幂等靠 SQL 的 upsert**：`ON CONFLICT DO UPDATE` 覆盖出现的行；不会清理这次数据里消失的行（只增不减的数据无影响，需要整体重写的场景用 delete+insert 更合适，属另一个组件，不并入）。
- **不做**：多表 join、自定义 where/聚合、非 upsert 的写入模式。配置化只覆盖「单表 upsert」，兜不住的场景另写组件或脚本。

## 待验证

- 组件：列名匹配、目标/输入列顺序、`do update` vs `do nothing` 两条 SQL 正确性、缺列报错、重复跑幂等（行数不翻倍）。
- 平台：登记 CRUD + 测试连接；下拉联动（换库后表名清空）；提交时未登记库名报错；执行注入 `AGENT_UI_DB_DSN`；密码不出现在节点 config / 快照 / 日志任何一处。
- 测试连接实现：server 侧用 Rust crate `tokio-postgres` 真连（TCP + 认证 + `SELECT 1`，8 秒超时），失败以 `{ok:false, message}` 返回而不是 5xx。
- 端到端：接一个产表节点的输出，同输入跑两次，表内行数不翻倍（验证 upsert 幂等）。

## 变更清单

| # | 改动 | 位置 |
| --- | --- | --- |
| 1 | 数据库注册：存储 + `/databases` 系列路由 + 测试连接 | `src-tauri/src/`（新模块，路由与 `/dw/settings` 同处注册） |
| 2 | 高级配置「数据库」tab（登记/编辑/删除/测试） | `DagAdvancedSettings.tsx` + `component-mode/api.ts` |
| 3 | configSchema 新类型 `database` / `db_table`（下拉 + 联动 + 测试连接按钮） | `types.ts` + `InstanceConfigForm.tsx` |
| 4 | 提交校验 + 执行时解析注入 `AGENT_UI_DB_DSN` | `scheduler.rs`（`build_snapshot`）+ `engine_executor/worker.py` |
| 5 | SDK `read_db_dsn()` | `engine_executor/sdk/component_sdk/` |
| 6 | 组件本体 | `components/update-table/{run.py, requirements.txt, README.md}` |
| 7 | 文档：本文档；`AGENT_UI_DB_DSN` 契约并入 `docs/engine-executor.md` | `docs/` |

组件注册到 DB（`components` 行 + configSchema/outputSchema）仍是配置操作。
