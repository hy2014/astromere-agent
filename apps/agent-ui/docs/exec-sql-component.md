# Exec-SQL 组件

在平台登记的数据库上执行自由 SQL（多语句单事务）。平台自带组件，代码在
`components/exec-sql/`（gitUrl 指向 agent-ui 仓库自身）。

## 参数（config_schema）

| key | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `connection` | string | 是 | 共享连接登记里的连接名；组件经 SDK `component_sdk.resolve_db_connection(name)` 读取共享登记，拿到 host/port/user/password 自己连库（见 `docs/components.md`「共享连接登记」） |
| `database` | string | 是 | 目标库名 |
| `sql` | textarea | 是 | 要执行的 SQL；可含多条语句（分号分隔），单事务执行，任何一条失败整体回滚 |

## 端口

- 输入：无（不消费上游数据文件）。
- 输出 `update_status`：字符串摘要（执行了几条语句、共影响多少行）。

## validate（Rust 侧）

`src-tauri/src/platform_components/exec_sql.rs`，按组件 name `Exec-SQL` 注册。
校验内容：连接名已登记 + 能连上 + 每条 SQL 均能被数据库 `EXPLAIN`（只做执行计划，
不执行写入，表/列/权限错误在这一步就会暴露）。多语句按分号拆分，注释
（`--` / `/* */`）与字符串字面量里的分号不参与拆分。

## 注册信息

- name：`Exec-SQL`
- gitUrl：agent-ui 仓库自身；entryPoint：`apps/agent-ui/components/exec-sql/run.py`
- configSchema：三字段见上表（连接名是普通字符串字段，组件经 SDK `resolve_db_connection` 读取共享登记）
- outputSchema：`{"type":"object","properties":{"update_status":{"type":"string"}}}`

## 边界

- SQL 原样执行，平台不做列映射、引用替换或方言转换。
- 「上游 parquet → 表」的数据导入不在本组件范围（需要时另做组件）。
