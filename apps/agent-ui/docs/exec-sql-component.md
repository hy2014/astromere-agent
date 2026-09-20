# Exec-SQL 组件

在平台登记的数据库上执行自由 SQL（多语句单事务），并可用输入文件做逐行
批量 UPDATE/INSERT（exec batch）。平台自带组件，代码在
`components/exec-sql/`（gitUrl 指向 agent-ui 仓库自身）。

## 参数（config_schema）

| key | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `connection` | string | 是 | 共享连接登记里的连接名；组件经 SDK `component_sdk.resolve_db_connection(name)` 读取共享登记，拿到 host/port/user/password 自己连库（见 `docs/components.md`「共享连接登记」） |
| `database` | string | 是 | 目标库名 |
| `sql` | textarea | 是 | 要执行的 SQL；可含多条语句（分号分隔），单事务执行，任何一条失败整体回滚 |

## 端口

- 输入：`t`（file）。上游数据文件，供 SQL 以 `$端口名.列名` 引用。
- 输出 `exec-status`（file）：本次执行的摘要文件（JSON：`message` / `affected_rows`）。

## SQL 模板（$端口.列）

SQL 里可用 `$<端口名>.<列名>` 引用一份上游输入文件的列。含 `$` 的语句会
对输入端口的**每个文件、每一行各执行一次**，该行的列值作为绑定参数
（exec batch）；`$端口.列` 在运行时被替换成绑定占位符，不是字符串拼接，
无需担心注入。无 `$` 的语句原样执行一次。多语句共一个事务。

```sql
INSERT INTO t(id, price) VALUES ($t.id, $t.price)
    ON CONFLICT(id) DO UPDATE SET price = EXCLUDED.price
-- 对输入端口 t 的每行执行一次，id/price 取该行对应列
```

当前限制：一条语句里 `$端口.列` 只能引用**同一**输入端口；多条语句可各自
引用不同端口。引用不存在列、或端口无数据文件 → 明确报错（中文），不静默空跑。

## validate（Rust 侧）

`src-tauri/src/platform_components/exec_sql.rs`，按组件 name `Exec-SQL` 注册。
校验内容：连接名已登记 + 能连上 + 每条 SQL 均能被数据库 `EXPLAIN`（只做执行计划，
不执行写入，表/列/权限错误在这一步就会暴露）。含 `$端口.列` 的语句在 EXPLAIN
前把模板 token 中和成字面量（运行时会换成绑定参数，EXPLAIN 不认）；PG 自带
`$1` 这类位置参数不受影响。多语句按分号拆分，注释与字符串字面量里的分号不参与拆分。

## 注册信息

- name：`Exec-SQL`
- gitUrl：agent-ui 仓库自身；entryPoint：`apps/agent-ui/components/exec-sql/run.py`
- inputSchema：`{"type":"object","properties":{"t":{"type":"string","format":"file"}}}`
- configSchema：三字段见上表（连接名是普通字符串字段，组件经 SDK `resolve_db_connection` 读取共享登记）
- outputSchema：`{"type":"object","properties":{"exec-status":{"type":"string","format":"file"}}}`

## 边界

- SQL 原样执行，平台不做列映射、引用替换或方言转换；参数以占位符绑定，列名/端口名须与输入文件真实一致。
