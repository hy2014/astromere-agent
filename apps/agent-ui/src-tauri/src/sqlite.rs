use base64::{engine::general_purpose, Engine as _};
use rusqlite::types::{Value as SqliteValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
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
        .join(".claw-agent-ui")
        .join("sqllite")
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

// SQLite usage_records storage has been removed.
// Usage/cost will be rebuilt from Claude Code jsonl message usage in a later implementation.
// Keep this file limited to generic SQLite utilities for now.
