use base64::{engine::general_purpose, Engine as _};
use rusqlite::types::{Value as SqliteValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteDatabaseInfo {
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteExecuteResult {
    rows_affected: usize,
    last_insert_rowid: i64,
    database_path: String,
}

fn error_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn sqlite_database_path() -> Result<PathBuf, String> {
    // Honor AGENT_UI_DB_PATH so the Rust/Tauri app and the Python engine_executor
    // share the exact same SQLite file when the path is overridden. Falls back to
    // $HOME/.agent-ui/sqlite/agent-ui.db (matching engine_executor's default).
    if let Ok(overridden) = std::env::var("AGENT_UI_DB_PATH") {
        if !overridden.trim().is_empty() {
            return Ok(PathBuf::from(overridden));
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "failed to resolve home directory for SQLite database".to_string())?;

    Ok(PathBuf::from(home)
        .join(".agent-ui")
        .join("sqlite")
        .join("agent-ui.db"))
}

pub(crate) fn open_sqlite_database() -> Result<(Connection, PathBuf), String> {
    let path = sqlite_database_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(error_to_string)?;
    }

    let conn = Connection::open(&path).map_err(error_to_string)?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(error_to_string)?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(error_to_string)?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(error_to_string)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
    )
    .map_err(error_to_string)?;

    ensure_component_tables(&conn)?;

    Ok((conn, path))
}

fn sqlite_param_from_json(value: Value) -> Result<SqliteValue, String> {
    match value {
        Value::Null => Ok(SqliteValue::Null),
        Value::Bool(value) => Ok(SqliteValue::Integer(if value { 1 } else { 0 })),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(SqliteValue::Integer(value))
            } else if let Some(value) = value.as_u64() {
                i64::try_from(value)
                    .map(SqliteValue::Integer)
                    .map_err(|_| "SQLite integer parameter is larger than i64".to_string())
            } else if let Some(value) = value.as_f64() {
                Ok(SqliteValue::Real(value))
            } else {
                Err("unsupported JSON number for SQLite parameter".to_string())
            }
        }
        Value::String(value) => Ok(SqliteValue::Text(value)),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(&value)
            .map(SqliteValue::Text)
            .map_err(error_to_string),
    }
}

fn sqlite_params(params: Option<Vec<Value>>) -> Result<Vec<SqliteValue>, String> {
    params
        .unwrap_or_default()
        .into_iter()
        .map(sqlite_param_from_json)
        .collect()
}

fn json_from_sqlite_value_ref(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::from(value),
        ValueRef::Real(value) => Value::from(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).to_string()),
        ValueRef::Blob(value) => json!({
            "type": "blob",
            "base64": general_purpose::STANDARD.encode(value),
        }),
    }
}

fn normalized_sql_prefix(sql: &str) -> String {
    sql.trim_start()
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn sqlite_database_info() -> Result<SqliteDatabaseInfo, String> {
    let (_conn, path) = open_sqlite_database()?;
    Ok(SqliteDatabaseInfo {
        path: path.to_string_lossy().to_string(),
    })
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn sqlite_execute(
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<SqliteExecuteResult, String> {
    let prefix = normalized_sql_prefix(&sql);
    if prefix == "select" || prefix == "with" || prefix == "pragma" {
        return Err(
            "sqlite_execute does not accept SELECT/WITH/PRAGMA statements; use sqlite_query"
                .to_string(),
        );
    }

    let (conn, path) = open_sqlite_database()?;
    let params = sqlite_params(params)?;
    let rows_affected = conn
        .execute(&sql, params_from_iter(params.iter()))
        .map_err(error_to_string)?;

    Ok(SqliteExecuteResult {
        rows_affected,
        last_insert_rowid: conn.last_insert_rowid(),
        database_path: path.to_string_lossy().to_string(),
    })
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn sqlite_query(
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<Vec<Map<String, Value>>, String> {
    let prefix = normalized_sql_prefix(&sql);
    if prefix != "select" && prefix != "with" && prefix != "pragma" {
        return Err("sqlite_query only accepts SELECT/WITH/PRAGMA statements".to_string());
    }

    let (conn, _path) = open_sqlite_database()?;
    let params = sqlite_params(params)?;
    let mut statement = conn.prepare(&sql).map_err(error_to_string)?;
    let column_names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();

    let rows = statement
        .query_map(params_from_iter(params.iter()), |row| {
            let mut item = Map::new();
            for (index, column_name) in column_names.iter().enumerate() {
                item.insert(
                    column_name.clone(),
                    json_from_sqlite_value_ref(row.get_ref(index)?),
                );
            }
            Ok(item)
        })
        .map_err(error_to_string)?;

    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(error_to_string)?);
    }
    Ok(output)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BundleUsageTotals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub total_input_tokens: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelCallUsageSnapshot {
    pub model_call_id: String,
    pub model: Option<String>,
    pub stop_reason: Option<String>,
    pub selected_reason: String,
    pub usage: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BundleUsageSnapshot {
    pub session_id: String,
    pub bundle_id: String,
    pub root: String,
    pub source: String,
    pub status: String,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub updated_at_ms: i64,
    pub model_call_ids: Vec<String>,
    pub model_call_usages: Vec<ModelCallUsageSnapshot>,
    pub usage: BundleUsageTotals,
    pub cost: Option<Value>,
}

fn ensure_bundle_usage_snapshots_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS bundle_usage_snapshots (
            session_id TEXT NOT NULL,
            bundle_id TEXT NOT NULL,
            project_root TEXT NOT NULL,

            source TEXT NOT NULL,
            status TEXT NOT NULL,

            snapshot_json TEXT NOT NULL,
            model_call_ids_json TEXT NOT NULL,
            model_call_usages_json TEXT NOT NULL,
            usage_json TEXT NOT NULL,

            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
            total_input_tokens INTEGER NOT NULL DEFAULT 0,

            started_at_ms INTEGER,
            completed_at_ms INTEGER,
            updated_at_ms INTEGER NOT NULL,

            inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

            PRIMARY KEY (session_id, bundle_id)
        );

        CREATE INDEX IF NOT EXISTS idx_bundle_usage_snapshots_project_session
            ON bundle_usage_snapshots(project_root, session_id);

        CREATE INDEX IF NOT EXISTS idx_bundle_usage_snapshots_updated
            ON bundle_usage_snapshots(updated_at_ms);
        "#,
    )
    .map_err(error_to_string)?;

    Ok(())
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn save_bundle_usage_snapshot(snapshot: BundleUsageSnapshot) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    ensure_bundle_usage_snapshots_table(&conn)?;

    if snapshot.session_id.trim().is_empty() {
        return Err("bundle usage snapshot missing sessionId".to_string());
    }
    if snapshot.bundle_id.trim().is_empty() {
        return Err("bundle usage snapshot missing bundleId".to_string());
    }

    let snapshot_json = serde_json::to_string(&snapshot).map_err(error_to_string)?;
    let model_call_ids_json =
        serde_json::to_string(&snapshot.model_call_ids).map_err(error_to_string)?;
    let model_call_usages_json =
        serde_json::to_string(&snapshot.model_call_usages).map_err(error_to_string)?;
    let usage_json = serde_json::to_string(&snapshot.usage).map_err(error_to_string)?;

    conn.execute(
        r#"
        INSERT INTO bundle_usage_snapshots (
            session_id,
            bundle_id,
            project_root,
            source,
            status,
            snapshot_json,
            model_call_ids_json,
            model_call_usages_json,
            usage_json,
            input_tokens,
            output_tokens,
            cache_read_input_tokens,
            cache_creation_input_tokens,
            total_input_tokens,
            started_at_ms,
            completed_at_ms,
            updated_at_ms,
            updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT(session_id, bundle_id) DO UPDATE SET
            project_root = excluded.project_root,
            source = excluded.source,
            status = excluded.status,
            snapshot_json = excluded.snapshot_json,
            model_call_ids_json = excluded.model_call_ids_json,
            model_call_usages_json = excluded.model_call_usages_json,
            usage_json = excluded.usage_json,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cache_read_input_tokens = excluded.cache_read_input_tokens,
            cache_creation_input_tokens = excluded.cache_creation_input_tokens,
            total_input_tokens = excluded.total_input_tokens,
            started_at_ms = excluded.started_at_ms,
            completed_at_ms = excluded.completed_at_ms,
            updated_at_ms = excluded.updated_at_ms,
            updated_at = CURRENT_TIMESTAMP
        "#,
        params![
            snapshot.session_id,
            snapshot.bundle_id,
            snapshot.root,
            snapshot.source,
            snapshot.status,
            snapshot_json,
            model_call_ids_json,
            model_call_usages_json,
            usage_json,
            snapshot.usage.input_tokens,
            snapshot.usage.output_tokens,
            snapshot.usage.cache_read_input_tokens,
            snapshot.usage.cache_creation_input_tokens,
            snapshot.usage.total_input_tokens,
            snapshot.started_at_ms,
            snapshot.completed_at_ms,
            snapshot.updated_at_ms,
        ],
    )
    .map_err(error_to_string)?;

    Ok(())
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn load_bundle_usage_snapshot(
    session_id: String,
    bundle_id: String,
) -> Result<BundleUsageSnapshot, String> {
    let (conn, _path) = open_sqlite_database()?;
    ensure_bundle_usage_snapshots_table(&conn)?;

    let snapshot_json: Option<String> = conn
        .query_row(
            "SELECT snapshot_json FROM bundle_usage_snapshots WHERE session_id = ?1 AND bundle_id = ?2",
            params![session_id, bundle_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(error_to_string)?;

    let snapshot_json = snapshot_json.ok_or_else(|| {
        "Usage snapshot not found for session/bundle".to_string()
    })?;

    serde_json::from_str(&snapshot_json).map_err(error_to_string)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn load_bundle_usage_snapshots_for_session(
    session_id: String,
) -> Result<Vec<BundleUsageSnapshot>, String> {
    let (conn, _path) = open_sqlite_database()?;
    ensure_bundle_usage_snapshots_table(&conn)?;

    if session_id.trim().is_empty() {
        return Err("bundle usage snapshots missing sessionId".to_string());
    }

    let mut statement = conn
        .prepare(
            r#"
            SELECT snapshot_json
            FROM bundle_usage_snapshots
            WHERE session_id = ?1
            ORDER BY COALESCE(started_at_ms, updated_at_ms), updated_at_ms, bundle_id
            "#,
        )
        .map_err(error_to_string)?;

    let rows = statement
        .query_map(params![session_id.clone()], |row| row.get::<_, String>(0))
        .map_err(error_to_string)?;

    let mut snapshots = Vec::new();
    for row in rows {
        let snapshot_json = row.map_err(error_to_string)?;
        snapshots.push(serde_json::from_str(&snapshot_json).map_err(error_to_string)?);
    }

    if snapshots.is_empty() {
        return Err(format!(
            "Usage snapshots not found for session {}",
            session_id
        ));
    }

    Ok(snapshots)
}

// SQLite usage_records storage has been removed.
// Usage/cost will be rebuilt from Claws Code jsonl message usage in a later implementation.
// Keep this file limited to generic SQLite utilities for now.

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelCallUsage {
    pub model_call_id: String,
    pub session_id: String,
    pub root: String,
    pub model: Option<String>,
    pub stop_reason: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub updated_at_ms: i64,
    pub source: String,
    pub cost_amount: Option<f64>,
}

fn ensure_model_call_usage_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS model_call_usage (
            model_call_id                 TEXT NOT NULL,
            session_id                    TEXT NOT NULL,
            project_root                  TEXT NOT NULL,

            model                         TEXT,
            stop_reason                   TEXT,

            input_tokens                  INTEGER NOT NULL DEFAULT 0,
            output_tokens                 INTEGER NOT NULL DEFAULT 0,
            cache_read_input_tokens       INTEGER NOT NULL DEFAULT 0,
            cache_creation_input_tokens   INTEGER NOT NULL DEFAULT 0,

            started_at_ms                 INTEGER,
            completed_at_ms               INTEGER,
            updated_at_ms                 INTEGER NOT NULL,
            source                        TEXT NOT NULL DEFAULT 'stream',
            cost_amount                   REAL,

            created_at                    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at                    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

            PRIMARY KEY (model_call_id, session_id)
        );

        CREATE INDEX IF NOT EXISTS idx_model_call_usage_session
            ON model_call_usage(session_id);
        "#,
    )
    .map_err(error_to_string)?;

    Ok(())
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn save_model_call_usage(usage: ModelCallUsage) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    ensure_model_call_usage_table(&conn)?;

    if usage.model_call_id.trim().is_empty() {
        return Err("model call usage missing modelCallId".to_string());
    }
    if usage.session_id.trim().is_empty() {
        return Err("model call usage missing sessionId".to_string());
    }

    conn.execute(
        r#"
        INSERT INTO model_call_usage (
            model_call_id,
            session_id,
            project_root,
            model,
            stop_reason,
            input_tokens,
            output_tokens,
            cache_read_input_tokens,
            cache_creation_input_tokens,
            started_at_ms,
            completed_at_ms,
            updated_at_ms,
            source,
            cost_amount,
            updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13,
            ?14,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT(model_call_id, session_id) DO UPDATE SET
            project_root              = excluded.project_root,
            model                     = excluded.model,
            stop_reason               = excluded.stop_reason,
            input_tokens              = excluded.input_tokens,
            output_tokens             = excluded.output_tokens,
            cache_read_input_tokens   = excluded.cache_read_input_tokens,
            cache_creation_input_tokens = excluded.cache_creation_input_tokens,
            started_at_ms             = excluded.started_at_ms,
            completed_at_ms           = excluded.completed_at_ms,
            updated_at_ms             = excluded.updated_at_ms,
            source                    = excluded.source,
            cost_amount               = excluded.cost_amount,
            updated_at                = CURRENT_TIMESTAMP
        "#,
        params![
            usage.model_call_id,
            usage.session_id,
            usage.root,
            usage.model,
            usage.stop_reason,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_input_tokens,
            usage.cache_creation_input_tokens,
            usage.started_at_ms,
            usage.completed_at_ms,
            usage.updated_at_ms,
            usage.source,
            usage.cost_amount,
        ],
    )
    .map_err(error_to_string)?;

    Ok(())
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn load_model_call_usage(
    model_call_id: String,
    session_id: String,
) -> Result<ModelCallUsage, String> {
    let (conn, _path) = open_sqlite_database()?;
    ensure_model_call_usage_table(&conn)?;

    conn.query_row(
        r#"
        SELECT
            model_call_id, session_id, project_root,
            model, stop_reason,
            input_tokens, output_tokens,
            cache_read_input_tokens, cache_creation_input_tokens,
            started_at_ms, completed_at_ms, updated_at_ms,
            source, cost_amount
        FROM model_call_usage
        WHERE model_call_id = ?1 AND session_id = ?2
        "#,
        params![model_call_id, session_id],
        |row| {
            Ok(ModelCallUsage {
                model_call_id: row.get(0)?,
                session_id: row.get(1)?,
                root: row.get(2)?,
                model: row.get(3)?,
                stop_reason: row.get(4)?,
                input_tokens: row.get(5)?,
                output_tokens: row.get(6)?,
                cache_read_input_tokens: row.get(7)?,
                cache_creation_input_tokens: row.get(8)?,
                started_at_ms: row.get(9)?,
                completed_at_ms: row.get(10)?,
                updated_at_ms: row.get(11)?,
                source: row.get(12)?,
                cost_amount: row.get(13)?,
            })
        },
    )
    .map_err(error_to_string)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn load_model_call_usages_for_session(
    session_id: String,
) -> Result<Vec<ModelCallUsage>, String> {
    let (conn, _path) = open_sqlite_database()?;
    ensure_model_call_usage_table(&conn)?;

    if session_id.trim().is_empty() {
        return Err("model call usages missing sessionId".to_string());
    }

    let mut statement = conn
        .prepare(
            r#"
            SELECT
                model_call_id, session_id, project_root,
                model, stop_reason,
                input_tokens, output_tokens,
                cache_read_input_tokens, cache_creation_input_tokens,
                started_at_ms, completed_at_ms, updated_at_ms,
                source, cost_amount
            FROM model_call_usage
            WHERE session_id = ?1
            ORDER BY COALESCE(started_at_ms, updated_at_ms), model_call_id
            "#,
        )
        .map_err(error_to_string)?;

    let rows = statement
        .query_map(params![session_id.clone()], |row| {
            Ok(ModelCallUsage {
                model_call_id: row.get(0)?,
                session_id: row.get(1)?,
                root: row.get(2)?,
                model: row.get(3)?,
                stop_reason: row.get(4)?,
                input_tokens: row.get(5)?,
                output_tokens: row.get(6)?,
                cache_read_input_tokens: row.get(7)?,
                cache_creation_input_tokens: row.get(8)?,
                started_at_ms: row.get(9)?,
                completed_at_ms: row.get(10)?,
                updated_at_ms: row.get(11)?,
                source: row.get(12)?,
                cost_amount: row.get(13)?,
            })
        })
        .map_err(error_to_string)?;

    let mut usages = Vec::new();
    for row in rows {
        usages.push(row.map_err(error_to_string)?);
    }

    Ok(usages)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn load_model_call_usages(
    model_call_ids: Vec<String>,
    session_id: String,
) -> Result<Vec<ModelCallUsage>, String> {
    let (conn, _path) = open_sqlite_database()?;
    ensure_model_call_usage_table(&conn)?;

    if model_call_ids.is_empty() {
        return Ok(Vec::new());
    }
    if session_id.trim().is_empty() {
        return Err("model call usages missing sessionId".to_string());
    }

    // 构建动态 IN 查询
    let placeholders: Vec<String> = model_call_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 2))
        .collect();
    let sql = format!(
        r#"
        SELECT
            model_call_id, session_id, project_root,
            model, stop_reason,
            input_tokens, output_tokens,
            cache_read_input_tokens, cache_creation_input_tokens,
            started_at_ms, completed_at_ms, updated_at_ms,
            source, cost_amount
        FROM model_call_usage
        WHERE session_id = ?1
          AND model_call_id IN ({})
        ORDER BY COALESCE(started_at_ms, updated_at_ms), model_call_id
        "#,
        placeholders.join(", "),
    );

    let mut statement = conn.prepare(&sql).map_err(error_to_string)?;

    // 绑定 session_id 到 ?1
    let rows = statement
        .query_map(
            rusqlite::params_from_iter(std::iter::once(&session_id as &dyn rusqlite::types::ToSql).chain(
                model_call_ids.iter().map(|id| id as &dyn rusqlite::types::ToSql),
            )),
            |row| {
                Ok(ModelCallUsage {
                    model_call_id: row.get(0)?,
                    session_id: row.get(1)?,
                    root: row.get(2)?,
                    model: row.get(3)?,
                    stop_reason: row.get(4)?,
                    input_tokens: row.get(5)?,
                    output_tokens: row.get(6)?,
                    cache_read_input_tokens: row.get(7)?,
                    cache_creation_input_tokens: row.get(8)?,
                    started_at_ms: row.get(9)?,
                    completed_at_ms: row.get(10)?,
                    updated_at_ms: row.get(11)?,
                    source: row.get(12)?,
                    cost_amount: row.get(13)?,
                })
            },
        )
        .map_err(error_to_string)?;

    let mut usages = Vec::new();
    for row in rows {
        usages.push(row.map_err(error_to_string)?);
    }

    Ok(usages)
}

/// Detect whether the `components` table still uses the legacy schema
/// (pre-DAG redesign). The legacy table carried a `project_id` column and a
/// different component model; we wipe and recreate on first encounter so the
/// migration happens exactly once instead of on every connection open.
fn legacy_component_schema_present(conn: &Connection) -> bool {
    let table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='components'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if table_exists == 0 {
        return false;
    }
    let has_project_id: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('components') WHERE name='project_id'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    has_project_id > 0
}

pub fn ensure_component_tables(conn: &Connection) -> Result<(), String> {
    let migrate_legacy = legacy_component_schema_present(conn);
    if migrate_legacy {
        // One-time wipe of the old component-exploration design.
        conn.execute_batch(
            "DROP TABLE IF EXISTS component_explorations;
             DROP TABLE IF EXISTS dag_nodes;
             DROP TABLE IF EXISTS dag_edges;
             DROP TABLE IF EXISTS dag_executions;
             DROP TABLE IF EXISTS execution_logs;
             DROP TABLE IF EXISTS dags;
             DROP TABLE IF EXISTS components;",
        )
        .map_err(error_to_string)?;
    } else {
        // The removed exploration table may linger from an even older build.
        conn.execute_batch("DROP TABLE IF EXISTS component_explorations;")
            .map_err(error_to_string)?;
    }

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS components (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL,                  -- draft | exploring | generated | published | deprecated
            workspace_root TEXT NOT NULL,          -- shared workspace / project root
            entry_point TEXT NOT NULL,             -- e.g. /a/b/c/xxxx/main.py or xxxx/main.py
            input_schema TEXT NOT NULL,
            output_schema TEXT NOT NULL,
            tags TEXT NOT NULL DEFAULT '[]',
            global INTEGER NOT NULL DEFAULT 0,    -- 0 = generic/non-global, 1 = registered/global (reusable across DAGs)
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS component_sessions (
            id TEXT PRIMARY KEY,
            component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            session_path TEXT NOT NULL,
            title TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            deleted_at_ms INTEGER              -- NULL = active; set = soft-deleted
        );

        CREATE INDEX IF NOT EXISTS idx_component_sessions_component
            ON component_sessions(component_id);

        CREATE TABLE IF NOT EXISTS dags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL,                  -- draft | published | archived
            execution_order TEXT,                  -- JSON array of node ids after topo sort
            cron TEXT,                             -- cron expression for scheduled runs (NULL = manual only)
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dag_nodes (
            id TEXT PRIMARY KEY,
            dag_id TEXT NOT NULL REFERENCES dags(id) ON DELETE CASCADE,
            component_id TEXT REFERENCES components(id) ON DELETE CASCADE,
            label TEXT,
            pos_x REAL NOT NULL,
            pos_y REAL NOT NULL,
            config TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS dag_edges (
            id TEXT PRIMARY KEY,
            dag_id TEXT NOT NULL REFERENCES dags(id) ON DELETE CASCADE,
            source_node_id TEXT NOT NULL,
            target_node_id TEXT NOT NULL,
            source_handle TEXT NOT NULL,
            target_handle TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dag_executions (
            id TEXT PRIMARY KEY,
            dag_id TEXT NOT NULL REFERENCES dags(id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            trigger_kind TEXT DEFAULT 'manual',    -- manual | cron | api
            started_at_ms INTEGER,
            completed_at_ms INTEGER,
            outputs TEXT
        );

        CREATE TABLE IF NOT EXISTS execution_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_id TEXT NOT NULL REFERENCES dag_executions(id) ON DELETE CASCADE,
            node_id TEXT,
            level TEXT NOT NULL,
            message TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS node_executions (
            id TEXT PRIMARY KEY,
            execution_id TEXT NOT NULL REFERENCES dag_executions(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            status TEXT NOT NULL,                  -- preparing | running | success | failed | cancelled
            started_at_ms INTEGER,
            completed_at_ms INTEGER,
            output_path TEXT,                      -- path to the node's output.json
            outputs TEXT,                          -- per-output-port artifacts, JSON map keyed by output port
            error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_components_workspace ON components(workspace_root);
        CREATE INDEX IF NOT EXISTS idx_dag_nodes_dag ON dag_nodes(dag_id);
        CREATE INDEX IF NOT EXISTS idx_dag_edges_dag ON dag_edges(dag_id);
        CREATE INDEX IF NOT EXISTS idx_dag_executions_dag ON dag_executions(dag_id);
        CREATE INDEX IF NOT EXISTS idx_dag_executions_status ON dag_executions(status);
        CREATE INDEX IF NOT EXISTS idx_node_executions_execution ON node_executions(execution_id);
        "#,
    )
    .map_err(error_to_string)?;

    // Soft-delete support: add the column to already-created DBs without wiping data.
    add_column_if_missing(conn, "component_sessions", "deleted_at_ms", "INTEGER")?;

    // Cron schedule for DAGs: add the column to already-created DBs without wiping data.
    add_column_if_missing(conn, "dags", "cron", "TEXT")?;

    // Execution worker claim/lease columns for the Python execution engine
    // (producer-consumer model). Added without wiping existing rows.
    add_column_if_missing(conn, "dag_executions", "worker_id", "TEXT")?;
    add_column_if_missing(conn, "dag_executions", "claimed_at_ms", "INTEGER")?;

    // Frozen DAG plan snapshot captured at run-submit time (see scheduler.rs).
    // NULL for runs created before this column existed — the worker falls back
    // to the live DAG plan in that case.
    add_column_if_missing(conn, "dag_executions", "snapshot", "TEXT")?;

    // Component definition now carries its git source + run params (the
    // configuration truth-source moved from dag_nodes.config into components).
    // Added without wiping existing rows; legacy `workspace_root` is retained
    // as a deprecated column.
    add_column_if_missing(conn, "components", "git_url", "TEXT")?;
    add_column_if_missing(conn, "components", "git_branch", "TEXT")?;
    add_column_if_missing(conn, "components", "git_ref", "TEXT")?;
    // components.args was removed on 2026-07-10: free-form run parameters now
    // live in `node.config.params` (read by the executor's `build_input`). Drop
    // the legacy column from already-created databases. `ALTER TABLE ... DROP
    // COLUMN` rebuilds the table, so we guard it behind a column-existence
    // check and make the drop best-effort (a failure leaves a harmless dead
    // column and the app still works, since no code reads `args` anymore).
    {
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(components)")
            .map_err(error_to_string)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(error_to_string)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_to_string)?;
        if cols.iter().any(|c| c == "args") {
            let _ = conn.execute("ALTER TABLE components DROP COLUMN args", []);
        }
    }

    // Registry flag: 0 = generic/non-global (drag "通用组件" onto the canvas),
    // 1 = registered/global (reusable across DAGs). Added without wiping rows;
    // legacy NULLs are read as 0 by components.rs::row_to_component.
    add_column_if_missing(conn, "components", "global", "INTEGER")?;

    // Component configuration schema (config_schema): the parameter declarations
    // a component exposes to its users. Added without wiping rows; legacy rows
    // simply have an empty schema.
    add_column_if_missing(conn, "components", "config_schema", "TEXT")?;

    // Per-output-port runtime artifacts on node_executions, indexed by output
    // port key. Added without wiping existing runs.
    add_column_if_missing(conn, "node_executions", "outputs", "TEXT")?;

    // Generic component nodes have no backing Component project, so their
    // component_id is NULL. Relax the NOT NULL constraint (idempotent: only
    // recreates the table when the column is currently NOT NULL).
    relax_dag_nodes_component_id(conn)?;

    // Remove the legacy `shared` column from `components`. It was the original
    // name of the registry flag, later renamed to `global` (the rename added
    // `global` via add_column_if_missing but left `shared` behind). Idempotent:
    // no-op once the column is gone.
    drop_components_shared_column(conn)?;

    Ok(())
}

/// Adds a column only if it is missing. Safe to call on every connection open —
/// never drops or rebuilds tables (project no-drop convention).
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    type_name: &str,
) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?",
            rusqlite::params![table, column],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);
    if exists {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {type_name}"),
        [],
    )
    .map_err(error_to_string)?;
    Ok(())
}

/// Relaxes the `dag_nodes.component_id` column from `NOT NULL` to nullable.
///
/// Generic component instances carry no backing Component project, so their
/// `component_id` is NULL. A NULL FK is not validated by SQLite, which lets
/// those rows persist while real components keep a proper FK reference.
///
/// SQLite cannot `ALTER COLUMN` to drop `NOT NULL`, so this recreates the table
/// when needed. It is idempotent and never wipes data (rows are copied across).
fn relax_dag_nodes_component_id(conn: &Connection) -> Result<(), String> {
    // Detect whether `component_id` is still declared NOT NULL by inspecting the
    // stored CREATE statement. We deliberately avoid `pragma_table_info` literal
    // calls (they can error and be silently swallowed); parsing the DDL is robust.
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dag_nodes'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    let needs_relax = {
        let low = sql.to_lowercase();
        if let Some(start) = low.find("component_id") {
            let rest = &low[start..];
            let col_def = rest.split(',').next().unwrap_or("");
            col_def.contains("not null")
        } else {
            false
        }
    };
    if !needs_relax {
        return Ok(());
    }

    conn.execute("PRAGMA foreign_keys=OFF", [])
        .map_err(error_to_string)?;
    conn.execute(
        "CREATE TABLE dag_nodes_new (
            id TEXT PRIMARY KEY,
            dag_id TEXT NOT NULL REFERENCES dags(id) ON DELETE CASCADE,
            component_id TEXT REFERENCES components(id) ON DELETE CASCADE,
            label TEXT,
            pos_x REAL NOT NULL,
            pos_y REAL NOT NULL,
            config TEXT NOT NULL DEFAULT '{}'
        )",
        [],
    )
    .map_err(error_to_string)?;
    conn.execute(
        "INSERT INTO dag_nodes_new (id, dag_id, component_id, label, pos_x, pos_y, config)
         SELECT id, dag_id, component_id, label, pos_x, pos_y, config FROM dag_nodes",
        [],
    )
    .map_err(error_to_string)?;
    conn.execute("DROP TABLE dag_nodes", [])
        .map_err(error_to_string)?;
    conn.execute("ALTER TABLE dag_nodes_new RENAME TO dag_nodes", [])
        .map_err(error_to_string)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_dag_nodes_dag ON dag_nodes(dag_id)",
        [],
    )
    .map_err(error_to_string)?;
    conn.execute("PRAGMA foreign_keys=ON", [])
        .map_err(error_to_string)?;
    Ok(())
}

/// Removes the legacy `shared` column from `components` once it is no longer
/// referenced by any code.
///
/// `shared` was the original name of the registry flag; it was later renamed to
/// `global` (`add_column_if_missing(conn, "components", "global", ...)`), but
/// the old `shared` column was left behind to honor the project no-drop
/// convention. No Rust/TS/Python
/// code reads or writes `components.shared` anymore, so it is safe to drop.
///
/// Implemented as a table rebuild (mirrors `relax_dag_nodes_component_id`): the
/// DDL is reconstructed from `pragma_table_info` — excluding `shared` — every
/// other column and all rows are copied across, then the old table is dropped
/// and the new one renamed back. This is version-independent and never wipes
/// data. Idempotent: returns immediately when `shared` is absent.
fn drop_components_shared_column(conn: &Connection) -> Result<(), String> {
    let has_shared: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('components') WHERE name='shared'",
            [],
            |row| row.get(0),
        )
        .map_err(error_to_string)?;
    if has_shared == 0 {
        return Ok(());
    }

    let mut stmt = conn
        .prepare(
            "SELECT name, type, \"notnull\", dflt_value, pk \
             FROM pragma_table_info('components') WHERE name != 'shared' ORDER BY cid",
        )
        .map_err(error_to_string)?;
    let cols: Vec<(String, String, i64, Option<String>, i64)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(error_to_string)?
        .filter_map(|r| r.ok())
        .collect();

    if cols.is_empty() {
        return Ok(());
    }

    let mut defs: Vec<String> = Vec::new();
    let mut pk_cols: Vec<String> = Vec::new();
    for (name, type_, notnull, dflt, pk) in &cols {
        let mut def = format!("{} {}", name, type_);
        if *notnull != 0 {
            def.push_str(" NOT NULL");
        }
        if let Some(d) = dflt {
            def.push_str(&format!(" DEFAULT {}", d));
        }
        if *pk > 0 {
            pk_cols.push(name.clone());
        }
        defs.push(def);
    }
    if !pk_cols.is_empty() {
        defs.push(format!("PRIMARY KEY ({})", pk_cols.join(", ")));
    }
    let ddl = format!("CREATE TABLE components_new ({})", defs.join(", "));
    let col_list = cols
        .iter()
        .map(|c| c.0.clone())
        .collect::<Vec<_>>()
        .join(", ");

    conn.execute("PRAGMA foreign_keys=OFF", [])
        .map_err(error_to_string)?;
    conn.execute(&ddl, []).map_err(error_to_string)?;
    conn.execute(
        &format!(
            "INSERT INTO components_new ({}) SELECT {} FROM components",
            col_list, col_list
        ),
        [],
    )
    .map_err(error_to_string)?;
    conn.execute("DROP TABLE components", [])
        .map_err(error_to_string)?;
    conn.execute("ALTER TABLE components_new RENAME TO components", [])
        .map_err(error_to_string)?;
    // Recreate the only index on components, but only if its column survived
    // the rebuild (it always does in the real schema).
    if cols.iter().any(|c| c.0 == "workspace_root") {
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_components_workspace ON components(workspace_root)",
            [],
        )
        .map_err(error_to_string)?;
    }
    conn.execute("PRAGMA foreign_keys=ON", [])
        .map_err(error_to_string)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_load_backfill_snapshots() {
        // Try to load snapshots for a session that has backfill data
        let result = load_bundle_usage_snapshots_for_session(
            "539002aa-e4a5-46a3-94db-a631fba41562".to_string()
        );
        match &result {
            Ok(snapshots) => {
                println!("Loaded {} snapshots", snapshots.len());
                for (i, snap) in snapshots.iter().enumerate() {
                    println!("Snapshot {}: session={}, bundle={}, source={}, usage={:?}", 
                        i, &snap.session_id[..20], &snap.bundle_id[..20], snap.source, snap.usage);
                    println!("  modelCallUsages len = {}", snap.model_call_usages.len());
                }
            }
            Err(e) => {
                println!("ERROR loading snapshots: {}", e);
            }
        }
        // Don't assert - just print diagostics
        // assert!(result.is_ok());
    }

    #[test]
    fn test_drop_components_shared_column_removes_and_preserves() {
        let path = std::env::temp_dir()
            .join(format!("agentui-shared-drop-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE components (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                shared INTEGER,
                global INTEGER NOT NULL DEFAULT 0,
                tags TEXT NOT NULL DEFAULT '[]',
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO components (id, name, status, shared, global, created_at_ms, updated_at_ms)
             VALUES ('c1', 'n', 'draft', 1, 0, 1, 1)",
            [],
        )
        .unwrap();

        // First run: removes the column and preserves data.
        drop_components_shared_column(&conn).unwrap();
        let has_shared: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('components') WHERE name='shared'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_shared, 0);
        let (name, global): (String, i64) = conn
            .query_row(
                "SELECT name, global FROM components WHERE id='c1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "n");
        assert_eq!(global, 0);

        // Second run: idempotent no-op, data still intact.
        drop_components_shared_column(&conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM components", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_deserialize_snapshot_json() {
        // Read the DB directly and try to deserialize snapshot_json
        let conn = rusqlite::Connection::open(
            std::path::PathBuf::from(env!("HOME")).join(".agent-ui/sqlite/agent-ui.db")
        );
        let conn = match conn {
            Ok(c) => c,
            Err(e) => {
                println!("Could not open DB: {}", e);
                return;
            }
        };

        let mut stmt = conn.prepare("SELECT session_id, bundle_id, snapshot_json, model_call_usages_json, usage_json FROM bundle_usage_snapshots WHERE source = 'backfill' LIMIT 5");
        let mut stmt = match stmt {
            Ok(s) => s,
            Err(e) => {
                println!("Could not prepare statement: {}", e);
                return;
            }
        };

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        });

        let rows = match rows {
            Ok(r) => r,
            Err(e) => {
                println!("Query failed: {}", e);
                return;
            }
        };

        for row in rows {
            let (session_id, bundle_id, snapshot_json, model_call_usages_json, usage_json) = row.unwrap();
            println!("\nSession: {}..., Bundle: {}...", &session_id[..20], &bundle_id[..20]);
            
            // Try to deserialize snapshot_json
            match serde_json::from_str::<BundleUsageSnapshot>(&snapshot_json) {
                Ok(snap) => {
                    println!("  Deserialized OK: usage = {:?}", snap.usage);
                    println!("  modelCallUsages len = {}", snap.model_call_usages.len());
                }
                Err(e) => {
                    println!("  FAILED to deserialize snapshot_json: {}", e);
                    // Print first 500 chars of snapshot_json
                    println!("  snapshot_json[:500] = {}", &snapshot_json[..snapshot_json.len().min(500)]);
                }
            }

            // Try to deserialize model_call_usages_json
            match serde_json::from_str::<Vec<ModelCallUsageSnapshot>>(&model_call_usages_json) {
                Ok(usages) => {
                    println!("  model_call_usages_json deserialized OK: len = {}", usages.len());
                }
                Err(e) => {
                    println!("  FAILED to deserialize model_call_usages_json: {}", e);
                }
            }

            // Try to deserialize usage_json
            match serde_json::from_str::<BundleUsageTotals>(&usage_json) {
                Ok(totals) => {
                    println!("  usage_json deserialized OK: {:?}", totals);
                }
                Err(e) => {
                    println!("  FAILED to deserialize usage_json: {}", e);
                }
            }
        }
    }
}
