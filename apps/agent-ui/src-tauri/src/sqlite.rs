use base64::{engine::general_purpose, Engine as _};
use rusqlite::types::{Value as SqliteValue, ValueRef};
use rusqlite::{params_from_iter, Connection, OptionalExtension};
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


#[tauri::command]
pub fn sqlite_usage_read_source() -> String {
    "runtime".to_string()
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

fn usage_table_columns(conn: &Connection, table_name: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table_name))
        .map_err(error_to_string)?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(error_to_string)?;

    let mut columns = Vec::new();
    for row in rows {
        columns.push(row.map_err(error_to_string)?);
    }
    Ok(columns)
}

fn usage_table_exists(conn: &Connection, table_name: &str) -> Result<bool, String> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(error_to_string)?;
    Ok(exists.is_some())
}

fn ensure_usage_records_table(conn: &Connection) -> Result<(), String> {
    if usage_table_exists(conn, "usage_records")? {
        let columns = usage_table_columns(conn, "usage_records")?;
        let has = |name: &str| columns.iter().any(|column| column == name);

        let compatible = has("turn_key")
            && has("session_id")
            && has("assistant_message_id")
            && has("turn_index")
            && has("created_day")
            && has("total_input_tokens")
            && has("price_model_key")
            && !has("price_snapshot_json");

        if !compatible {
            let backup_name = format!(
                "usage_records_legacy_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|err| err.to_string())?
                    .as_secs()
            );
            conn.execute(
                &format!("ALTER TABLE usage_records RENAME TO {}", backup_name),
                [],
            )
            .map_err(error_to_string)?;
        }
    }

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS usage_records (
            turn_key TEXT PRIMARY KEY,
            source TEXT NOT NULL DEFAULT 'legacy',

            session_id TEXT NOT NULL,
            assistant_message_id TEXT NOT NULL,
            project_root TEXT,

            turn_index INTEGER NOT NULL,

            created_at_ms INTEGER NOT NULL,
            created_day TEXT NOT NULL,

            model TEXT,

            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
            total_input_tokens INTEGER NOT NULL DEFAULT 0,

            input_hit_rate REAL,

            cost_usd REAL,
            cost_source TEXT NOT NULL DEFAULT 'model_settings.unavailable',
            price_model_key TEXT,

            metric_source TEXT NOT NULL,
            source_event_key TEXT,
            raw_json TEXT,

            inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_usage_records_source
            ON usage_records(source);

        CREATE INDEX IF NOT EXISTS idx_usage_records_source_session
            ON usage_records(source, session_id);

        CREATE INDEX IF NOT EXISTS idx_usage_records_source_message
            ON usage_records(source, assistant_message_id);

        CREATE INDEX IF NOT EXISTS idx_usage_records_session_id
            ON usage_records(session_id);

        CREATE INDEX IF NOT EXISTS idx_usage_records_assistant_message_id
            ON usage_records(assistant_message_id);

        CREATE INDEX IF NOT EXISTS idx_usage_records_turn_index
            ON usage_records(session_id, turn_index);

        CREATE INDEX IF NOT EXISTS idx_usage_records_created_day
            ON usage_records(created_day);

        CREATE INDEX IF NOT EXISTS idx_usage_records_created_at_ms
            ON usage_records(created_at_ms);
        "#,
    )
    .map_err(error_to_string)?;

    let columns = usage_table_columns(conn, "usage_records")?;
    if !columns.iter().any(|column| column == "source") {
        conn.execute(
            "ALTER TABLE usage_records ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy'",
            [],
        )
        .map_err(error_to_string)?;
    }

    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_usage_records_source
            ON usage_records(source);

        CREATE INDEX IF NOT EXISTS idx_usage_records_source_session
            ON usage_records(source, session_id);

        CREATE INDEX IF NOT EXISTS idx_usage_records_source_message
            ON usage_records(source, assistant_message_id);
        "#,
    )
    .map_err(error_to_string)?;

    Ok(())
}


fn ensure_usage_records_storage() -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    ensure_usage_records_table(&conn)
}


#[tauri::command]
pub fn sqlite_usage_records(
    session_id: String,
    source: Option<String>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let source = source.unwrap_or_else(sqlite_usage_read_source);

    ensure_usage_records_storage()?;

    sqlite_query(
        r#"
        SELECT
            turn_key,
            source,
            session_id,
            assistant_message_id,
            project_root,
            turn_index,
            created_at_ms,
            created_day,
            model,
            input_tokens,
            output_tokens,
            cache_read_input_tokens,
            cache_creation_input_tokens,
            total_input_tokens,
            input_hit_rate,
            cost_usd,
            cost_source,
            price_model_key,
            metric_source,
            source_event_key
        FROM usage_records
        WHERE session_id = ?
          AND source = ?
        ORDER BY turn_index ASC
        "#
        .to_string(),
        Some(vec![
            serde_json::Value::String(session_id),
            serde_json::Value::String(source),
        ]),
    )
}


#[tauri::command]
pub fn sqlite_usage_assistant_summaries(
    session_id: String,
    source: Option<String>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let source = source.unwrap_or_else(sqlite_usage_read_source);

    ensure_usage_records_storage()?;

    sqlite_query(
        r#"
        SELECT
            ?2 AS source,
            session_id,
            assistant_message_id,
            MIN(project_root) AS project_root,
            MIN(turn_index) AS first_turn_index,
            MAX(turn_index) AS last_turn_index,
            COUNT(*) AS turn_count,
            MIN(created_at_ms) AS created_at_ms,
            MIN(created_day) AS created_day,
            CASE
                WHEN COUNT(DISTINCT model) = 1 THEN MIN(model)
                WHEN COUNT(DISTINCT model) > 1 THEN 'mixed'
                ELSE NULL
            END AS model,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
            COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
            COALESCE(SUM(total_input_tokens), 0) AS total_input_tokens,
            CASE
                WHEN SUM(total_input_tokens) > 0
                THEN CAST(SUM(cache_read_input_tokens) AS REAL) / CAST(SUM(total_input_tokens) AS REAL)
                ELSE NULL
            END AS input_hit_rate,
            CASE
                WHEN COUNT(cost_usd) > 0 THEN SUM(cost_usd)
                ELSE NULL
            END AS cost_usd,
            GROUP_CONCAT(DISTINCT cost_source) AS cost_source,
            GROUP_CONCAT(DISTINCT price_model_key) AS price_model_key,
            GROUP_CONCAT(DISTINCT metric_source) AS metric_source,
            COUNT(DISTINCT source_event_key) AS source_event_count,
            MIN(source_event_key) AS first_source_event_key,
            COUNT(cost_usd) AS priced_turn_count
        FROM usage_records
        WHERE session_id = ?1
          AND source = ?2
        GROUP BY session_id, assistant_message_id
        ORDER BY first_turn_index ASC,
                 created_at_ms ASC,
                 assistant_message_id ASC
        "#
        .to_string(),
        Some(vec![
            serde_json::Value::String(session_id),
            serde_json::Value::String(source),
        ]),
    )
}

#[tauri::command]
pub fn sqlite_usage_session_summary(
    session_id: String,
    source: Option<String>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let source = source.unwrap_or_else(sqlite_usage_read_source);

    ensure_usage_records_storage()?;

    sqlite_query(
        r#"
        SELECT
            ?2 AS source,
            COUNT(*) AS turn_count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
            COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
            COALESCE(SUM(total_input_tokens), 0) AS total_input_tokens,
            CASE
                WHEN SUM(total_input_tokens) > 0
                THEN CAST(SUM(cache_read_input_tokens) AS REAL) / CAST(SUM(total_input_tokens) AS REAL)
                ELSE NULL
            END AS input_hit_rate,
            CASE
                WHEN COUNT(cost_usd) > 0 THEN SUM(cost_usd)
                ELSE NULL
            END AS cost_usd,
            COUNT(cost_usd) AS priced_turn_count
        FROM usage_records
        WHERE session_id = ?1
          AND source = ?2
        "#.to_string(),
        Some(vec![
            serde_json::Value::String(session_id),
            serde_json::Value::String(source),
        ]),
    )
}

#[tauri::command]
pub fn sqlite_usage_day_splits(
    session_id: String,
    source: Option<String>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let source = source.unwrap_or_else(sqlite_usage_read_source);

    ensure_usage_records_storage()?;

    sqlite_query(
        r#"
        SELECT
            ?2 AS source,
            created_day,
            COUNT(*) AS turn_count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
            COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
            COALESCE(SUM(total_input_tokens), 0) AS total_input_tokens,
            CASE
                WHEN SUM(total_input_tokens) > 0
                THEN CAST(SUM(cache_read_input_tokens) AS REAL) / CAST(SUM(total_input_tokens) AS REAL)
                ELSE NULL
            END AS input_hit_rate,
            CASE
                WHEN COUNT(cost_usd) > 0 THEN SUM(cost_usd)
                ELSE NULL
            END AS cost_usd,
            COUNT(cost_usd) AS priced_turn_count
        FROM usage_records
        WHERE session_id = ?1
          AND source = ?2
        GROUP BY created_day
        ORDER BY created_day ASC
        "#.to_string(),
        Some(vec![
            serde_json::Value::String(session_id),
            serde_json::Value::String(source),
        ]),
    )
}
