# exec-sql

Executes free-form SQL against a database registered in the platform's
advanced settings. Multi-statement SQL runs in a single transaction — any
failure rolls back everything.

## When to use

- Upserting / maintaining warehouse tables with hand-written SQL
  (`INSERT ... ON CONFLICT ... DO UPDATE`, `CREATE TABLE`, `DELETE`, ...).
- One-off DDL or data fixes inside a DAG.
- NOT for loading upstream parquet files into a table — that is a different
  component's job.

## Parameters (config_schema)

| key        | type     | required | meaning                                                        |
|------------|----------|----------|----------------------------------------------------------------|
| connection | string   | **yes**  | name in the shared connection registry (高级配置 → 数据库); the component reads it via SDK `component_sdk.resolve_db_connection(name)` and connects itself |
| database   | string   | **yes**  | target database name (appended by the component itself)        |
| sql        | textarea | **yes**  | the SQL to run; statements split on `;`, comments and string literals respected |

## Output ports

| port          | type   | meaning                                    |
|---------------|--------|--------------------------------------------|
| update_status | string | summary: how many statements ran, rows affected |

## Validation

The node form shows a 验证配置 button (Rust-side, `platform_components/exec_sql.rs`):
it checks the connection is registered, connects, and `EXPLAIN`s each statement —
syntax / table / column / permission errors surface before submit. EXPLAIN never
executes the writes.
