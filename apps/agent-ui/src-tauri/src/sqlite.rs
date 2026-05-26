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
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "failed to resolve home directory for SQLite database".to_string())?;

    Ok(PathBuf::from(home)
        .join(".agent-ui")
        .join("sqlite")
        .join("agent-ui.db"))
}

fn open_sqlite_database() -> Result<(Connection, PathBuf), String> {
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

#[tauri::command]
pub fn sqlite_database_info() -> Result<SqliteDatabaseInfo, String> {
    let (_conn, path) = open_sqlite_database()?;
    Ok(SqliteDatabaseInfo {
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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
// Usage/cost will be rebuilt from Claude Code jsonl message usage in a later implementation.
// Keep this file limited to generic SQLite utilities for now.
