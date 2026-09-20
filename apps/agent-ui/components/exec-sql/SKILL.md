# exec-sql

Executes free-form SQL against a database registered in the platform's shared
connection registry. Multi-statement SQL runs in a single transaction — any
failure rolls back everything. SQL can reference an upstream input file's columns
with `$<输入端口名>.<列名>`, which runs that statement once per row (exec batch).

## When to use

- Upserting / maintaining warehouse tables from an upstream parquet/csv: load
  the file into the `t` port and write `INSERT ... ON CONFLICT ... DO UPDATE`
  using `$t.<列>`.
- One-off DDL or data fixes inside a DAG.
- NOT for free-form queries that need no input file — just leave `t` empty
  and write plain SQL; such statements run once.

## Parameters (config_schema)

| key        | type     | required | meaning                                                        |
|------------|----------|----------|----------------------------------------------------------------|
| connection | string   | **yes**  | name in the shared connection registry (高级配置 → 数据库); the component reads it via SDK `component_sdk.resolve_db_connection(name)` and connects itself |
| database   | string   | **yes**  | target database name |
| sql        | textarea | **yes**  | the SQL to run; `$端口.列` tokens bind input columns per row, split on `;` |

## Input / Output ports

- Input `t` (file): upstream data files referenced by `$<输入端口名>.<列名>`.
- Output `exec-status` (file): JSON summary (`message`, `affected_rows`).

Example batch upsert:

```sql
INSERT INTO t(id, price) VALUES ($t.id, $t.price)
    ON CONFLICT(id) DO UPDATE SET price = EXCLUDED.price
```

One statement may only reference columns of a single input port (different
statements may use different ports). A missing column or an empty input port is
a clear Chinese error, never a silent no-op.

## Validation

The node form shows a 验证配置 button (Rust-side, `platform_components/exec_sql.rs`):
it checks the connection is registered, connects, and `EXPLAIN`s each statement —
syntax / table / column / permission errors surface before submit. EXPLAIN never
executes the writes. `$端口.列` tokens are neutralized to a literal before EXPLAIN
(PG positional params like `$1` are left untouched).
