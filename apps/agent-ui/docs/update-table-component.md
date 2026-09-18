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

### configSchema

| key | type | 说明 |
| --- | --- | --- |
| `table_name` | string | 目标表名（必填） |
| `columns` | list(string) | 列映射，每项 `目标列=输入列`（必填，≥1） |
| `conflict_cols` | list(string) | `on conflict (<这些列>)` 的唯一键（必填，≥1） |
| `update_conflict` | boolean | true=`do update`，false=`do nothing`（默认 true） |

`columns` 用 `目标列=输入列` 的列表表达映射（输入列名与目标列名允许不同）。separator 用 `=`：列名里不含 `=`，不会歧义。

> 为什么不是「两个平行列表」或「对象列表」：configSchema 的 list 只支持**标量元素**
> （`{kind:"list", element:<base>}`，见 `types.ts` `ConfigFieldType`），表达不了
> `[{input, target}]`；两个平行列表要靠人工保持对齐，容易错位。

### configSchema 示例

```json
[
  {"key": "table_name", "label": "目标表", "type": "string", "required": true},
  {"key": "columns", "label": "列映射 [目标=输入]", "type": {"kind": "list", "element": "string"}, "required": true},
  {"key": "conflict_cols", "label": "唯一键列", "type": {"kind": "list", "element": "string"}, "required": true},
  {"key": "update_conflict", "label": "冲突时更新", "type": "boolean", "required": false, "default": true}
]
```

## 运行行为

1. 读输入端口 `table`（`component_sdk.read_as_df_from_card` 或按需列表逐项 concat）。
2. 校验每个 `目标列=输入列` 里的**输入列确实存在于输入表**，不在 → 报错退出。
3. 组装一条 UPSERT 语句：
   ```sql
   INSERT INTO <table_name> (<目标列...>) VALUES (<占位符...>)
   ON CONFLICT (<conflict_cols...>) DO UPDATE SET <目标列 = EXCLUDED.<目标列>, ...>
   ```
   `update_conflict=false` 时尾部改为 `DO NOTHING`。占位符按所选 DB 层来（psycopg2 `%s` / SQLAlchemy `:name`），不写死。
4. 用 `executemany`（批量绑定）逐行插入，列值来自 `table.<输入列>`。
5. 成功 → 输出端口 `update_status` 记 `inserted N rows`。

## 关键设计点

- **只替换 `table.` 前缀的占位符**，`EXCLUDED.`、`ON CONFLICT` 是 SQL 自身语法，不碰。
- **参数绑定而非字符串拼接**：防注入 + 批量执行快。
- **幂等靠 SQL 的 upsert**：`ON CONFLICT DO UPDATE` 覆盖出现的行；不会清理这次数据里消失的行（只增不减的数据无影响，需要整体重写的场景用 delete+insert 更合适，属另一个组件，不并入）。
- **不做**：多表 join、自定义 where/聚合、非 upsert 的写入模式。配置化只覆盖「单表 upsert」，兜不住的场景另写组件或脚本。

## 待定：DB 连接从哪来

这是唯一没定的点，且必须定，否则组件跑不起来：

| 选项 | 说明 | 顾虑 |
| --- | --- | --- |
| (a) configSchema 里配连接 | host/port/db/user/password 或一条 DSN | 密码进 `dag_nodes.config`（明文落库） |
| (b) 环境变量 / 服务器上的配置文件 | 组件读 env 或固定路径的配置 | 换库要改服务器，节点不可自描述 |
| (c) 复用平台仓库之外某业务仓库里的 DB 工具 | 组件去 import 别的仓库 | **方向不对**：agent-ui 的通用组件不该依赖业务仓库 |

倾向 (a) + 密码走环境变量（DSN 里不含密码），但这需要你拍板。

## 待验证

- 单测/冒烟：列名匹配、目标/输入列顺序、`do update` vs `do nothing` 两条 SQL 正确性、缺列报错、重复跑幂等（行数不翻倍）。
- 端到端：接一个产表节点的输出，同输入跑两次，表内行数不翻倍（验证 upsert 幂等）。

## 变更清单

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | 组件 | `components/update-table/{run.py, requirements.txt, README.md}` |
| 2 | 文档 | 本文档 |

注册到 DB（`components` 行 + configSchema/outputSchema）是配置操作，不涉及平台代码改动；worker / runner / SDK 零改动。