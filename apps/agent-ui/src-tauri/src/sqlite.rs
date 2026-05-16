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

#[derive(serde::Serialize)]
pub struct UsageRebuildResult {
    pub session_id: String,
    pub scanned_event_count: usize,
    pub extracted_turn_count: usize,
    pub bad_payload_json_count: usize,
    pub missing_assistant_message_id_count: usize,
    pub no_usage_count: usize,
    pub unavailable_cost_count: usize,
}

#[derive(Clone)]
struct UsageMetrics {
    input_tokens: i64,
    output_tokens: i64,
    cache_read_input_tokens: i64,
    cache_creation_input_tokens: i64,
    total_input_tokens: i64,
    input_hit_rate: Option<f64>,
}


#[derive(Clone)]
struct UsageCandidate {
    session_id: String,
    assistant_message_id: String,
    project_root: Option<String>,
    debug_rowid: i64,
    event_type: String,
    created_at_ms: i64,
    model: Option<String>,
    metric_source: String,
    source_event_key: Option<String>,
    usage_path: String,
    usage: serde_json::Value,
    payload: serde_json::Value,
    raw_json: serde_json::Value,
    raw_type: Option<String>,
    raw_subtype: Option<String>,
    usage_metrics: UsageMetrics,
}


struct UsageCostResult {
    cost_usd: Option<f64>,
    cost_source: String,
    price_model_key: Option<String>,
    reason: Option<String>,
}

struct UsagePriceCandidate {
    key: String,
    model_name: String,
    price_info: serde_json::Value,
}

fn debug_event_now_ms() -> Result<i64, String> {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(error_to_string)?;
    Ok(duration.as_millis() as i64)
}

fn debug_event_stable_hash(value: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in value.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn debug_event_raw_json(payload: &Value) -> &Value {
    payload.get("raw_json").unwrap_or(payload)
}

fn debug_event_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

fn ensure_debug_events_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS debug_events (
          event_key TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          project_root TEXT,
          assistant_message_id TEXT,
          event_type TEXT NOT NULL,
          source TEXT NOT NULL,
          received_at_ms INTEGER NOT NULL,
          event_timestamp_ms INTEGER,
          raw_type TEXT,
          raw_subtype TEXT,
          raw_uuid TEXT,
          raw_model TEXT,
          payload_json TEXT NOT NULL,
          inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_debug_events_session_received
          ON debug_events(session_id, received_at_ms);

        CREATE INDEX IF NOT EXISTS idx_debug_events_assistant_received
          ON debug_events(assistant_message_id, received_at_ms);

        CREATE INDEX IF NOT EXISTS idx_debug_events_project_session_received
          ON debug_events(project_root, session_id, received_at_ms);

        CREATE INDEX IF NOT EXISTS idx_debug_events_type_received
          ON debug_events(event_type, received_at_ms);

        CREATE INDEX IF NOT EXISTS idx_debug_events_raw_type_received
          ON debug_events(raw_type, received_at_ms);
        "#,
    )
    .map_err(error_to_string)?;

    Ok(())
}

pub fn sqlite_persist_debug_event_from_stdout(
    fallback_session_id: &str,
    assistant_message_id: Option<&str>,
    event_type: &str,
    payload: &Value,
) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    ensure_debug_events_table(&conn)?;

    let raw_json = debug_event_raw_json(payload);
    let session_id = debug_event_string(raw_json.get("sessionId"))
        .or_else(|| debug_event_string(raw_json.get("session_id")))
        .unwrap_or_else(|| fallback_session_id.to_string());

    if session_id.trim().is_empty() {
        return Err("debug event session_id is empty".to_string());
    }

    let project_root = debug_event_string(raw_json.get("cwd"));
    let raw_type = debug_event_string(raw_json.get("type"));
    let raw_subtype = debug_event_string(raw_json.get("subtype"));
    let raw_uuid = debug_event_string(raw_json.get("uuid"));
    let raw_model = raw_json
        .get("message")
        .and_then(|message| message.get("model"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());

    let payload_json = serde_json::to_string(payload).map_err(error_to_string)?;
    let received_at_ms = debug_event_now_ms()?;
    let event_hash = debug_event_stable_hash(&payload_json);
    let event_key = format!(
        "{}:{}:{}:{:08x}",
        session_id, event_type, received_at_ms, event_hash
    );

    conn.execute(
        r#"
        INSERT OR IGNORE INTO debug_events (
            event_key,
            session_id,
            project_root,
            assistant_message_id,
            event_type,
            source,
            received_at_ms,
            event_timestamp_ms,
            raw_type,
            raw_subtype,
            raw_uuid,
            raw_model,
            payload_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        "#,
        rusqlite::params![
            event_key,
            session_id,
            project_root,
            assistant_message_id,
            event_type,
            "rust_stdout",
            received_at_ms,
            Option::<i64>::None,
            raw_type,
            raw_subtype,
            raw_uuid,
            raw_model,
            payload_json,
        ],
    )
    .map_err(error_to_string)?;

    Ok(())
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

fn usage_model_settings_path() -> Result<PathBuf, String> {
    let db_path = sqlite_database_path()?;
    let claw_agent_ui_dir = db_path
        .parent()
        .and_then(|sqllite_dir| sqllite_dir.parent())
        .ok_or_else(|| {
            format!(
                "failed to resolve .claw-agent-ui directory from SQLite path {}",
                db_path.display()
            )
        })?;

    Ok(claw_agent_ui_dir.join("model-settings.json"))
}

fn usage_read_model_settings() -> Result<serde_json::Value, String> {
    let path = usage_model_settings_path()?;
    let text = std::fs::read_to_string(&path)
        .map_err(|err| format!("failed to read model settings {}: {}", path.display(), err))?;

    serde_json::from_str(&text)
        .map_err(|err| format!("failed to parse model settings {}: {}", path.display(), err))
}

fn usage_json_get<'a>(
    value: &'a serde_json::Value,
    names: &[&str],
) -> Option<&'a serde_json::Value> {
    for name in names {
        if let Some(found) = value.get(*name) {
            return Some(found);
        }
    }
    None
}

fn usage_json_number(value: Option<&serde_json::Value>) -> Option<f64> {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_f64(),
        Some(serde_json::Value::String(text)) => text.parse::<f64>().ok(),
        _ => None,
    }
}

fn usage_json_i64(value: Option<&serde_json::Value>) -> Option<i64> {
    usage_json_number(value).map(|value| value as i64)
}

fn usage_pick_i64(value: &serde_json::Value, names: &[&str]) -> i64 {
    usage_json_i64(usage_json_get(value, names)).unwrap_or(0)
}

fn usage_raw_json(payload: &serde_json::Value) -> &serde_json::Value {
    payload
        .get("raw_json")
        .or_else(|| payload.get("rawJson"))
        .unwrap_or(payload)
}

fn usage_extract_turn_text(
    payload: &serde_json::Value,
) -> Option<(String, serde_json::Value, Option<String>, serde_json::Value)> {
    let raw = usage_raw_json(payload);
    let message = raw.get("message")?;
    let usage = message.get("usage")?;

    Some((
        "turn_text.message.usage".to_string(),
        usage.clone(),
        message
            .get("model")
            .or_else(|| raw.get("model"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        raw.clone(),
    ))
}

fn usage_extract_turn_complete(
    payload: &serde_json::Value,
) -> Option<(String, serde_json::Value, Option<String>, serde_json::Value)> {
    let raw = usage_raw_json(payload);
    let usage = raw.get("usage")?;

    let model = raw
        .get("model")
        .or_else(|| raw.get("message").and_then(|message| message.get("model")))
        .or_else(|| {
            raw.get("modelUsage")
                .and_then(|model_usage| model_usage.get("model"))
        })
        .or_else(|| {
            raw.get("model_usage")
                .and_then(|model_usage| model_usage.get("model"))
        })
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());

    Some((
        "turn_complete.usage".to_string(),
        usage.clone(),
        model,
        raw.clone(),
    ))
}

fn usage_metrics_from_usage(usage: &serde_json::Value) -> UsageMetrics {
    let input_tokens = usage_pick_i64(
        usage,
        &[
            "input_tokens",
            "inputTokens",
            "cache_miss_input_tokens",
            "cacheMissInputTokens",
            "prompt_cache_miss_tokens",
            "promptCacheMissTokens",
        ],
    );

    let output_tokens = usage_pick_i64(
        usage,
        &[
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
        ],
    );

    let cache_read_input_tokens = usage_pick_i64(
        usage,
        &[
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "prompt_cache_hit_tokens",
            "promptCacheHitTokens",
            "cache_hit_input_tokens",
            "cacheHitInputTokens",
        ],
    );

    let cache_creation_input_tokens = usage_pick_i64(
        usage,
        &[
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
            "cache_write_input_tokens",
            "cacheWriteInputTokens",
        ],
    );

    let explicit_total_input = usage_pick_i64(
        usage,
        &[
            "total_input_tokens",
            "totalInputTokens",
            "prompt_tokens",
            "promptTokens",
        ],
    );

    let total_input_tokens = if explicit_total_input > 0 {
        explicit_total_input
    } else {
        input_tokens + cache_read_input_tokens + cache_creation_input_tokens
    };

    let input_hit_rate = if total_input_tokens > 0 {
        Some(cache_read_input_tokens as f64 / total_input_tokens as f64)
    } else {
        None
    };

    UsageMetrics {
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
        total_input_tokens,
        input_hit_rate,
    }
}

fn usage_normalize_model_name(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .trim_start_matches("models/")
        .replace(char::is_whitespace, "")
        .replace('_', "-")
}

fn usage_flatten_json(
    value: &serde_json::Value,
    prefix: String,
    out: &mut Vec<(String, serde_json::Value)>,
) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let next_prefix = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{}.{}", prefix, key)
                };
                usage_flatten_json(child, next_prefix, out);
            }
        }
        serde_json::Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                let next_prefix = if prefix.is_empty() {
                    index.to_string()
                } else {
                    format!("{}.{}", prefix, index)
                };
                usage_flatten_json(child, next_prefix, out);
            }
        }
        _ => out.push((prefix, value.clone())),
    }
}

fn usage_flattened(value: &serde_json::Value) -> Vec<(String, serde_json::Value)> {
    let mut out = Vec::new();
    usage_flatten_json(value, String::new(), &mut out);
    out
}

fn usage_normalize_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| *ch != '-' && *ch != '_' && *ch != '.' && !ch.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

fn usage_looks_like_price_info(value: &serde_json::Value) -> bool {
    let keys = usage_flattened(value)
        .into_iter()
        .map(|(key, _)| usage_normalize_key(&key))
        .collect::<Vec<_>>()
        .join(" ");

    keys.contains("inputprice")
        || keys.contains("outputprice")
        || keys.contains("cachehitprice")
        || keys.contains("cachereadprice")
        || keys.contains("completionprice")
        || keys.contains("promptprice")
}

fn usage_collect_price_candidates(
    value: &serde_json::Value,
    path_parts: &mut Vec<String>,
    candidates: &mut Vec<UsagePriceCandidate>,
) {
    match value {
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path_parts.push(index.to_string());
                usage_collect_price_candidates(item, path_parts, candidates);
                path_parts.pop();
            }
        }
        serde_json::Value::Object(map) => {
            if usage_looks_like_price_info(value) {
                let flat = usage_flattened(value);
                let mut names = Vec::new();

                for key in ["model", "modelName", "model_name", "id", "name"] {
                    if let Some(name) = value.get(key).and_then(|item| item.as_str()) {
                        names.push(name.to_string());
                    }
                }

                for (key, child) in flat {
                    let normalized_key = usage_normalize_key(&key);
                    if ["model", "modelname", "modelname", "id", "name"]
                        .contains(&normalized_key.as_str())
                    {
                        if let Some(name) = child.as_str() {
                            names.push(name.to_string());
                        }
                    }
                }

                names.extend(path_parts.iter().cloned());

                for name in names {
                    candidates.push(UsagePriceCandidate {
                        key: path_parts.join("."),
                        model_name: name,
                        price_info: value.clone(),
                    });
                }
            }

            for (key, child) in map {
                path_parts.push(key.clone());
                usage_collect_price_candidates(child, path_parts, candidates);
                path_parts.pop();
            }
        }
        _ => {}
    }
}

fn usage_find_model_price_info(
    model_settings: &serde_json::Value,
    model: Option<&str>,
) -> Option<UsagePriceCandidate> {
    let model = model?;
    let target = usage_normalize_model_name(model);

    // model-settings.json DeepSeek official pricing shape:
    // deepseekPricing.models[].items[] = { item, pricePerMTokens }
    if let Some(models) = model_settings
        .get("deepseekPricing")
        .and_then(|value| value.get("models"))
        .and_then(|value| value.as_array())
    {
        for (index, item) in models.iter().enumerate() {
            let model_name = item.get("model").and_then(|value| value.as_str());
            if let Some(model_name) = model_name {
                if usage_normalize_model_name(model_name) == target {
                    return Some(UsagePriceCandidate {
                        key: format!("deepseekPricing.models.{}", index),
                        model_name: model_name.to_string(),
                        price_info: item.clone(),
                    });
                }
            }
        }
    }

    let mut candidates = Vec::new();
    usage_collect_price_candidates(model_settings, &mut Vec::new(), &mut candidates);

    for candidate in &candidates {
        if usage_normalize_model_name(&candidate.model_name) == target {
            return Some(UsagePriceCandidate {
                key: candidate.key.clone(),
                model_name: candidate.model_name.clone(),
                price_info: candidate.price_info.clone(),
            });
        }
    }

    for candidate in candidates {
        let candidate_name = usage_normalize_model_name(&candidate.model_name);
        if !candidate_name.is_empty()
            && (candidate_name.contains(&target) || target.contains(&candidate_name))
        {
            return Some(candidate);
        }
    }

    None
}

fn usage_key_matches(normalized_key: &str, group: &[&str]) -> bool {
    group.iter().all(|part| normalized_key.contains(part))
}

fn usage_value_to_rate_per_token(normalized_key: &str, value: f64) -> f64 {
    if normalized_key.contains("permillion")
        || normalized_key.contains("per1m")
        || normalized_key.contains("permtok")
        || normalized_key.contains("permilliontokens")
    {
        value / 1_000_000.0
    } else if normalized_key.contains("perthousand")
        || normalized_key.contains("per1k")
        || normalized_key.contains("perk")
    {
        value / 1_000.0
    } else if normalized_key.contains("pertoken") || normalized_key.contains("usdpertoken") {
        value
    } else {
        // model-settings 中 DeepSeek 官方价格默认按 USD / 1M tokens 存。
        value / 1_000_000.0
    }
}

fn usage_rate_per_token(price_info: &serde_json::Value, groups: &[&[&str]]) -> Option<f64> {
    for (key, child) in usage_flattened(price_info) {
        let normalized_key = usage_normalize_key(&key);

        if !groups
            .iter()
            .any(|group| usage_key_matches(&normalized_key, group))
        {
            continue;
        }

        if let Some(value) = usage_json_number(Some(&child)) {
            return Some(usage_value_to_rate_per_token(&normalized_key, value));
        }
    }

    None
}

fn usage_deepseek_item_rate_per_token(
    price_info: &serde_json::Value,
    item_names: &[&str],
) -> Option<f64> {
    let items = price_info.get("items")?.as_array()?;

    for item in items {
        let item_name = item.get("item").and_then(|value| value.as_str())?;
        if !item_names.iter().any(|expected| *expected == item_name) {
            continue;
        }

        let price = usage_json_number(
            item.get("pricePerMTokens")
                .or_else(|| item.get("price_per_m_tokens"))
                .or_else(|| item.get("pricePerMillionTokens"))
                .or_else(|| item.get("price")),
        )?;

        return Some(price / 1_000_000.0);
    }

    None
}

fn usage_calculate_cost(
    metrics: &UsageMetrics,
    model: Option<&str>,
    model_settings: &serde_json::Value,
) -> UsageCostResult {
    let candidate = match usage_find_model_price_info(model_settings, model) {
        Some(candidate) => candidate,
        None => {
            return UsageCostResult {
                cost_usd: None,
                cost_source: "model_settings.unavailable".to_string(),
                price_model_key: None,
                reason: Some("model price info not found".to_string()),
            };
        }
    };

    let input_rate =
        usage_deepseek_item_rate_per_token(&candidate.price_info, &["cache_miss_input", "input"])
            .or_else(|| {
                usage_rate_per_token(
                    &candidate.price_info,
                    &[
                        &["input", "price"],
                        &["prompt", "price"],
                        &["cache", "miss", "price"],
                        &["prompt", "cache", "miss", "price"],
                    ],
                )
            });

    let output_rate = usage_deepseek_item_rate_per_token(&candidate.price_info, &["output"])
        .or_else(|| {
            usage_rate_per_token(
                &candidate.price_info,
                &[&["output", "price"], &["completion", "price"]],
            )
        });

    let cache_read_rate =
        usage_deepseek_item_rate_per_token(&candidate.price_info, &["cache_hit_input"]).or_else(
            || {
                usage_rate_per_token(
                    &candidate.price_info,
                    &[
                        &["cache", "read", "price"],
                        &["cache", "hit", "price"],
                        &["cached", "input", "price"],
                        &["prompt", "cache", "hit", "price"],
                    ],
                )
            },
        );

    let cache_creation_rate = usage_rate_per_token(
        &candidate.price_info,
        &[
            &["cache", "creation", "price"],
            &["cache", "write", "price"],
            &["prompt", "cache", "write", "price"],
        ],
    )
    .or(input_rate);

    let mut missing = Vec::new();
    if metrics.input_tokens > 0 && input_rate.is_none() {
        missing.push("input price");
    }
    if metrics.output_tokens > 0 && output_rate.is_none() {
        missing.push("output price");
    }
    if metrics.cache_read_input_tokens > 0 && cache_read_rate.is_none() {
        missing.push("cache read / cache hit price");
    }
    if metrics.cache_creation_input_tokens > 0 && cache_creation_rate.is_none() {
        missing.push("cache creation / cache write price");
    }

    if !missing.is_empty() {
        return UsageCostResult {
            cost_usd: None,
            cost_source: "model_settings.unavailable".to_string(),
            price_model_key: Some(candidate.key),
            reason: Some(format!("missing {}", missing.join(", "))),
        };
    }

    let cost_usd = metrics.input_tokens as f64 * input_rate.unwrap_or(0.0)
        + metrics.output_tokens as f64 * output_rate.unwrap_or(0.0)
        + metrics.cache_read_input_tokens as f64 * cache_read_rate.unwrap_or(0.0)
        + metrics.cache_creation_input_tokens as f64 * cache_creation_rate.unwrap_or(0.0);

    UsageCostResult {
        cost_usd: Some(cost_usd),
        cost_source: "model_settings.calculated".to_string(),
        price_model_key: Some(candidate.key),
        reason: None,
    }
}

fn usage_day_from_ms(conn: &Connection, ms: i64) -> Result<String, String> {
    conn.query_row(
        "SELECT date(?1 / 1000, 'unixepoch', 'localtime')",
        [ms],
        |row| row.get::<_, String>(0),
    )
    .map_err(error_to_string)
}


fn usage_debug_event_rows(
    conn: &Connection,
    session_id: &str,
) -> Result<
    Vec<(
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        i64,
        Option<String>,
    )>,
    String,
> {
    let columns = usage_table_columns(conn, "debug_events")?;
    let has_project_root = columns.iter().any(|column| column == "project_root");

    let sql = if has_project_root {
        r#"
        SELECT rowid, event_type, payload_json, assistant_message_id, source, received_at_ms, project_root
        FROM debug_events
        WHERE session_id = ?1
          AND event_type IN ('turn_text', 'turn_complete')
        ORDER BY session_id ASC, received_at_ms ASC, rowid ASC, assistant_message_id ASC
        "#
    } else {
        r#"
        SELECT rowid, event_type, payload_json, assistant_message_id, source, received_at_ms, NULL AS project_root
        FROM debug_events
        WHERE session_id = ?1
          AND event_type IN ('turn_text', 'turn_complete')
        ORDER BY session_id ASC, received_at_ms ASC, rowid ASC, assistant_message_id ASC
        "#
    };

    let mut stmt = conn.prepare(sql).map_err(error_to_string)?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(error_to_string)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(error_to_string)?);
    }

    Ok(out)
}


fn sqlite_debug_events_string_arg(args: &Value, camel: &str, snake: &str) -> Option<String> {
    args.get(camel)
        .or_else(|| args.get(snake))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn sqlite_debug_events_limit(args: &Value) -> i64 {
    args.get("limit")
        .and_then(|value| value.as_i64())
        .unwrap_or(2000)
        .clamp(1, 10000)
}

fn sqlite_resolve_runtime_assistant_message_id(
    conn: &Connection,
    session_id: Option<&str>,
    assistant_message_id: &str,
) -> Result<String, String> {
    if !assistant_message_id.starts_with("msg-")
        && !assistant_message_id.starts_with("assistant-pending-")
    {
        return Ok(assistant_message_id.to_string());
    }

    let sql_with_session = r#"
        SELECT json_extract(payload_json, '$.raw_json.message.id')
        FROM debug_events
        WHERE source != 'runtime'
          AND session_id = ?1
          AND assistant_message_id = ?2
          AND event_type = 'turn_text'
          AND json_extract(payload_json, '$.raw_json.message.id') IS NOT NULL
          AND json_extract(payload_json, '$.raw_json.message.id') != ''
        ORDER BY received_at_ms DESC
        LIMIT 1
    "#;

    let sql_without_session = r#"
        SELECT json_extract(payload_json, '$.raw_json.message.id')
        FROM debug_events
        WHERE source != 'runtime'
          AND assistant_message_id = ?1
          AND event_type = 'turn_text'
          AND json_extract(payload_json, '$.raw_json.message.id') IS NOT NULL
          AND json_extract(payload_json, '$.raw_json.message.id') != ''
        ORDER BY received_at_ms DESC
        LIMIT 1
    "#;

    let resolved: Option<String> = if let Some(session_id) = session_id {
        let mut stmt = conn.prepare(sql_with_session).map_err(error_to_string)?;
        let mut rows = stmt
            .query((session_id, assistant_message_id))
            .map_err(error_to_string)?;
        match rows.next().map_err(error_to_string)? {
            Some(row) => row.get(0).map_err(error_to_string)?,
            None => None,
        }
    } else {
        let mut stmt = conn.prepare(sql_without_session).map_err(error_to_string)?;
        let mut rows = stmt
            .query((assistant_message_id,))
            .map_err(error_to_string)?;
        match rows.next().map_err(error_to_string)? {
            Some(row) => row.get(0).map_err(error_to_string)?,
            None => None,
        }
    };

    Ok(resolved.unwrap_or_else(|| assistant_message_id.to_string()))
}

#[tauri::command]
pub fn sqlite_debug_events(args: Value) -> Result<Vec<Map<String, Value>>, String> {
    let (conn, _path) = open_sqlite_database()?;

    let session_id = sqlite_debug_events_string_arg(&args, "sessionId", "session_id");
    let assistant_message_id =
        sqlite_debug_events_string_arg(&args, "assistantMessageId", "assistant_message_id");
    let limit = sqlite_debug_events_limit(&args);

    if let Some(assistant_message_id) = assistant_message_id.as_deref() {
        let resolved_assistant_message_id = sqlite_resolve_runtime_assistant_message_id(
            &conn,
            session_id.as_deref(),
            assistant_message_id,
        )?;

        if let Some(session_id) = session_id {
            return sqlite_query(
                r#"
                SELECT *
                FROM debug_events
                WHERE source = ?1
                  AND session_id = ?2
                  AND assistant_message_id = ?3
                ORDER BY received_at_ms ASC
                LIMIT ?4
                "#
                .to_string(),
                Some(vec![
                    Value::String("runtime".to_string()),
                    Value::String(session_id),
                    Value::String(resolved_assistant_message_id),
                    Value::from(limit),
                ]),
            );
        }

        return sqlite_query(
            r#"
            SELECT *
            FROM debug_events
            WHERE source = ?1
              AND assistant_message_id = ?2
            ORDER BY received_at_ms ASC
            LIMIT ?3
            "#
            .to_string(),
            Some(vec![
                Value::String("runtime".to_string()),
                Value::String(resolved_assistant_message_id),
                Value::from(limit),
            ]),
        );
    }

    if let Some(session_id) = session_id {
        return sqlite_query(
            r#"
            SELECT *
            FROM debug_events
            WHERE source = ?1
              AND session_id = ?2
            ORDER BY received_at_ms ASC
            LIMIT ?3
            "#
            .to_string(),
            Some(vec![
                Value::String("runtime".to_string()),
                Value::String(session_id),
                Value::from(limit),
            ]),
        );
    }

    sqlite_query(
        r#"
        SELECT *
        FROM debug_events
        WHERE source = ?1
        ORDER BY received_at_ms DESC
        LIMIT ?2
        "#
        .to_string(),
        Some(vec![
            Value::String("runtime".to_string()),
            Value::from(limit),
        ]),
    )
}

#[tauri::command]

pub fn sqlite_rebuild_usage_records_from_debug_events(
    session_id: String,
) -> Result<UsageRebuildResult, String> {
    let (mut conn, _path) = open_sqlite_database()?;
    ensure_usage_records_table(&conn)?;

    let model_settings = usage_read_model_settings()?;
    let rows = usage_debug_event_rows(&conn, &session_id)?;

    let mut candidates: Vec<UsageCandidate> = Vec::new();

    let mut bad_payload_json_count = 0usize;
    let mut missing_assistant_message_id_count = 0usize;
    let mut no_usage_count = 0usize;
    let mut unavailable_cost_count = 0usize;

    for (
        debug_rowid,
        event_type,
        payload_json,
        assistant_message_id,
        _source,
        received_at_ms,
        project_root,
    ) in &rows
    {
        let assistant_message_id = match assistant_message_id {
            Some(value) if !value.trim().is_empty() => value.clone(),
            _ => {
                missing_assistant_message_id_count += 1;
                continue;
            }
        };

        let payload: serde_json::Value = match serde_json::from_str(payload_json) {
            Ok(value) => value,
            Err(_) => {
                bad_payload_json_count += 1;
                continue;
            }
        };

        let extracted = if event_type == "turn_complete" {
            usage_extract_turn_complete(&payload)
        } else if event_type == "turn_text" {
            usage_extract_turn_text(&payload)
        } else {
            None
        };

        let Some((metric_source, usage, model, raw_json)) = extracted else {
            no_usage_count += 1;
            continue;
        };

        let raw = usage_raw_json(&payload);
        let raw_type = payload
            .get("raw_type")
            .or_else(|| payload.get("rawType"))
            .or_else(|| raw.get("type"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        let raw_subtype = payload
            .get("raw_subtype")
            .or_else(|| payload.get("rawSubtype"))
            .or_else(|| raw.get("subtype"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());

        let usage_path = if metric_source == "turn_complete.usage" {
            "raw_json.usage"
        } else {
            "raw_json.message.usage"
        }
        .to_string();

        candidates.push(UsageCandidate {
            session_id: session_id.clone(),
            assistant_message_id: assistant_message_id.clone(),
            project_root: project_root.clone(),
            debug_rowid: *debug_rowid,
            event_type: event_type.clone(),
            created_at_ms: *received_at_ms,
            model,
            metric_source: metric_source.clone(),
            source_event_key: Some(format!(
                "debug_events:{}:{}:{}",
                debug_rowid, event_type, received_at_ms
            )),
            usage_path,
            usage_metrics: usage_metrics_from_usage(&usage),
            usage,
            payload,
            raw_json,
            raw_type,
            raw_subtype,
        });
    }

    candidates.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.created_at_ms.cmp(&right.created_at_ms))
            .then_with(|| left.debug_rowid.cmp(&right.debug_rowid))
            .then_with(|| left.assistant_message_id.cmp(&right.assistant_message_id))
    });

    let tx = conn.transaction().map_err(error_to_string)?;

    tx.execute(
        "DELETE FROM usage_records WHERE session_id = ?1 AND source = ?2",
        rusqlite::params![session_id, "runtime"],
    )
    .map_err(error_to_string)?;

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO usage_records (
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
                    source_event_key,
                    raw_json,
                    updated_at
                ) VALUES (
                    ?1,
                    ?2,
                    ?3,
                    ?4,
                    ?5,
                    ?6,
                    ?7,
                    ?8,
                    ?9,
                    ?10,
                    ?11,
                    ?12,
                    ?13,
                    ?14,
                    ?15,
                    ?16,
                    ?17,
                    ?18,
                    ?19,
                    ?20,
                    ?21,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT(turn_key) DO UPDATE SET
                    source = excluded.source,
                    session_id = excluded.session_id,
                    assistant_message_id = excluded.assistant_message_id,
                    project_root = excluded.project_root,
                    turn_index = excluded.turn_index,
                    created_at_ms = excluded.created_at_ms,
                    created_day = excluded.created_day,
                    model = excluded.model,
                    input_tokens = excluded.input_tokens,
                    output_tokens = excluded.output_tokens,
                    cache_read_input_tokens = excluded.cache_read_input_tokens,
                    cache_creation_input_tokens = excluded.cache_creation_input_tokens,
                    total_input_tokens = excluded.total_input_tokens,
                    input_hit_rate = excluded.input_hit_rate,
                    cost_usd = excluded.cost_usd,
                    cost_source = excluded.cost_source,
                    price_model_key = excluded.price_model_key,
                    metric_source = excluded.metric_source,
                    source_event_key = excluded.source_event_key,
                    raw_json = excluded.raw_json,
                    updated_at = CURRENT_TIMESTAMP
                "#,
            )
            .map_err(error_to_string)?;

        let mut next_turn_index_by_session = std::collections::BTreeMap::<String, i64>::new();

        for candidate in candidates.iter() {
            let metrics = &candidate.usage_metrics;
            let cost = usage_calculate_cost(metrics, candidate.model.as_deref(), &model_settings);
            if cost.cost_usd.is_none() {
                unavailable_cost_count += 1;
            }

            let turn_index_entry = next_turn_index_by_session
                .entry(candidate.session_id.clone())
                .or_insert(1);
            let turn_index = *turn_index_entry;
            *turn_index_entry += 1;

            let created_day = usage_day_from_ms(&tx, candidate.created_at_ms)?;
            let turn_key = format!(
                "{}:{}:turn:{}",
                candidate.session_id, candidate.assistant_message_id, turn_index
            );

            let raw_json = serde_json::json!({
                "debug_rowid": candidate.debug_rowid,
                "event_type": candidate.event_type.clone(),
                "raw_type": candidate.raw_type.clone(),
                "raw_subtype": candidate.raw_subtype.clone(),
                "usage_path": candidate.usage_path.clone(),
                "usage": candidate.usage.clone(),
                "payload": candidate.payload.clone(),
                "metric_source": candidate.metric_source.clone(),
                "source_event_key": candidate.source_event_key.clone(),
                "raw_json": candidate.raw_json.clone(),
                "cost_reason": cost.reason.clone(),
            })
            .to_string();

            stmt.execute(rusqlite::params![
                turn_key,
                "runtime",
                candidate.session_id,
                candidate.assistant_message_id,
                candidate.project_root,
                turn_index,
                candidate.created_at_ms,
                created_day,
                candidate.model,
                metrics.input_tokens,
                metrics.output_tokens,
                metrics.cache_read_input_tokens,
                metrics.cache_creation_input_tokens,
                metrics.total_input_tokens,
                metrics.input_hit_rate,
                cost.cost_usd,
                cost.cost_source,
                cost.price_model_key,
                candidate.metric_source,
                candidate.source_event_key,
                raw_json,
            ])
            .map_err(error_to_string)?;
        }
    }

    tx.commit().map_err(error_to_string)?;

    Ok(UsageRebuildResult {
        session_id,
        scanned_event_count: rows.len(),
        extracted_turn_count: candidates.len(),
        bad_payload_json_count,
        missing_assistant_message_id_count,
        no_usage_count,
        unavailable_cost_count,
    })
}


#[tauri::command]
pub fn sqlite_usage_records(
    session_id: String,
    source: Option<String>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let source = source.unwrap_or_else(sqlite_usage_read_source);

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
