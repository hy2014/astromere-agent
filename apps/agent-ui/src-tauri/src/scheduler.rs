//! Topological scheduling and execution state machine for the component DAG platform.

use crate::dag::{get_dag, cron_matches};
use crate::dag_server_config::log_dir;
use crate::sqlite::open_sqlite_database;
use crate::types::{DagDetail, DagExecution, ExecutionLog, NodeExecution, NodeLogFile};
use chrono::{Local, Timelike};
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::time::{Duration, SystemTime};

fn error_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Return structure for node-output preview (the frontend table renders by
/// `columns` + `rows`).
/// A non-empty `unsupported` means the server cannot preview this format yet
/// (e.g. parquet); in that case `columns`/`rows` are empty and the frontend
/// shows a hint message and the file path instead.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPreview {
    pub output_name: String,
    pub format: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
    pub total: Option<usize>,
    pub unsupported: Option<String>,
    /// Absolute path to the underlying file on the server. Frontends render
    /// this so users can open the file directly if preview doesn't cover their
    /// needs (e.g. unsupported format, preview truncated).
    pub file_path: String,
}

/// Capture a frozen snapshot of the DAG plan at submit time: the node configs,
/// edges, and execution order. Stored as JSON on the `dag_executions` row so a
/// run always replays / displays the exact config it was launched with, even
/// if the live DAG is edited afterwards. The shape mirrors
/// `engine_executor/db.py::get_dag_plan` so the Python worker can use it
/// directly as a drop-in plan.
pub(crate) fn build_snapshot(detail: &DagDetail) -> Result<String, String> {
    let order: Vec<&str> = if let Some(Value::Array(arr)) = &detail.execution_order {
        arr.iter()
            .filter_map(|v| v.as_str())
            .collect()
    } else {
        Vec::new()
    };
    let nodes: Vec<Value> = detail
        .nodes
        .iter()
        .map(|n| {
            // Merge the component's git source into the node's config so the
            // Python worker reads the configuration truth-source from this frozen
            // snapshot. dag_nodes.config is only a runtime cache; see the binding
            // decision (2026-07-08-component-registry-and-sidebar.md).
            let mut config = match &n.config {
                Value::Object(map) => map.clone(),
                _ => serde_json::Map::new(),
            };
            if let Ok(component) = crate::components::get_component(n.component_id.clone()) {
                config.insert("gitUrl".to_string(), Value::String(component.git_url));
                config.insert("gitBranch".to_string(), Value::String(component.git_branch));
                config.insert("gitRef".to_string(), Value::String(component.git_ref));
                config.insert(
                    "entryPoint".to_string(),
                    Value::String(component.entry_point),
                );
                // Carry the component's declared parameter schema into the frozen
                // plan so the worker / history view can render the instance form.
                config.insert("configSchema".to_string(), component.config_schema.clone());
                // Live `dag_nodes.config` no longer stores the node name (it lives
                // in the component definition), so re-inject it here for the
                // history view's "per-node" snapshot display.
                config.insert("name".to_string(), serde_json::Value::String(component.name));
            }
            serde_json::json!({
                "id": n.id,
                "component_id": n.component_id,
                "config": Value::Object(config),
            })
        })
        .collect();
    let edges: Vec<Value> = detail
        .edges
        .iter()
        .map(|e| {
            serde_json::json!({
                "source_node_id": e.source_node_id,
                "target_node_id": e.target_node_id,
                "source_handle": e.source_handle,
                "target_handle": e.target_handle,
            })
        })
        .collect();
    let plan = serde_json::json!({
        "execution_order": order,
        "nodes": nodes,
        "edges": edges,
    });
    serde_json::to_string(&plan).map_err(error_to_string)
}

/// Producer entry point: enqueue a DAG run by inserting a `dag_executions`
/// row with status `submit`. The actual execution is performed by the
/// separate Python execution engine (`engine_executor/`), which polls for
/// `submit` rows, claims them, and drives the node-level state machine.
///
/// This keeps Rust as a thin broker (mirroring a MySQL-style queue) so the
/// same job can be triggered by a manual run, the cron scheduler, or any API.
pub fn submit_dag_run(dag_id: &str, trigger_kind: &str) -> Result<DagExecution, String> {
    // Ensure the DAG exists before enqueuing, and freeze its plan now.
    let detail = get_dag(dag_id.to_string())?;
    let snapshot = build_snapshot(&detail)?;

    let (conn, _path) = open_sqlite_database()?;
    let id = crate::utils::generate_agent_ui_session_id();
    let now = chrono::Utc::now().timestamp_millis();
    let execution = DagExecution {
        id: id.clone(),
        dag_id: dag_id.to_string(),
        status: "submit".to_string(),
        trigger_kind: Some(trigger_kind.to_string()),
        started_at_ms: Some(now),
        completed_at_ms: None,
        outputs: None,
        snapshot: Some(snapshot),
    };

    conn.execute(
        "INSERT INTO dag_executions (id, dag_id, status, trigger_kind, started_at_ms, \
         completed_at_ms, outputs, snapshot) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            execution.id,
            execution.dag_id,
            execution.status,
            execution.trigger_kind,
            execution.started_at_ms,
            execution.completed_at_ms,
            execution.outputs.as_ref().map(|v| serde_json::to_string(v).unwrap_or_default()),
            execution.snapshot,
        ],
    )
    .map_err(error_to_string)?;

    Ok(execution)
}

/// Background cron scheduler for published DAGs.
///
/// Spawns its own thread (mirroring `engine::start_worker_supervisor`) so it can
/// be launched inline from `run_server` without blocking the HTTP server. Every
/// minute it scans all `published` DAGs that carry a cron expression, fires
/// those whose schedule matches the current *local* minute, and records the
/// fired minute in `dags.last_cron_run_ms` to avoid double-firing within the
/// same minute. If a previous run is still executing, the due tick is *queued*
/// behind it (coalesced to at most one waiting run) rather than run in parallel
/// or dropped — the serial FIFO worker starts it as soon as the current run
/// finishes. So long-running schedules never overlap and never pile up
/// unboundedly. Errors are logged, never fatal — the loop keeps running.
///
/// Intended to run only on the execution host (called from inside
/// `if run_worker { ... }` in `server.rs`), so there is exactly one scheduler
/// per database / worker.
pub fn start_cron_scheduler() {
    std::thread::spawn(|| {
        loop {
            if let Err(e) = cron_tick_once() {
                eprintln!("[cron] tick error: {e}");
            }
            sleep_until_next_minute();
        }
    });
}

/// True if the DAG already has a run *waiting to start* — i.e. a `submit` row
/// the worker has not claimed yet. Used to coalesce cron ticks into a queue of
/// depth 1: while a previous run is executing, the first matching tick enqueues
/// one waiting run (which the serial FIFO worker picks up as soon as the current
/// one finishes), and any further ticks are merged until that waiting run
/// starts. Net effect: never overlap, never drop a due tick, never pile up
/// unboundedly — at most one running + one queued.
///
/// Note: `accepted` / `running` are deliberately NOT counted here — a run that
/// is already executing must not block the *next* one from being queued behind
/// it, otherwise a long run would silently drop the following schedule (that
/// would be the old "skip" behaviour, not queueing).
fn dag_has_pending_run(conn: &rusqlite::Connection, dag_id: &str) -> bool {
    conn
        .query_row(
            "SELECT 1 FROM dag_executions \
             WHERE dag_id = ?1 AND status = 'submit' \
             LIMIT 1",
            params![dag_id],
            |_| Ok(()),
        )
        .is_ok()
}

/// One scheduler pass: find DAGs due this minute and enqueue them.
///
/// If the DAG is idle it fires immediately. If a previous run is still
/// executing, the due tick is *queued* behind it (one waiting run max) so the
/// serial FIFO worker runs it right after the current one finishes — rather than
/// dropping the tick. Further ticks while a run is already queued are merged.
fn cron_tick_once() -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;

    // Collect (id, cron, last_cron_run_ms) for every published DAG with a cron.
    let mut stmt = conn
        .prepare(
            "SELECT id, cron, last_cron_run_ms FROM dags \
             WHERE status = 'published' AND cron IS NOT NULL AND cron != ''",
        )
        .map_err(error_to_string)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(error_to_string)?;

    let mut due: Vec<(String, String, Option<i64>)> = Vec::new();
    for r in rows {
        due.push(r.map_err(error_to_string)?);
    }

    let now = Local::now();
    // Epoch-ms of the start of the current *local* minute — used as the dedup key.
    let total_ns = now.timestamp() as i64 * 1_000_000_000 + now.timestamp_subsec_nanos() as i64;
    let off_ns = now.offset().local_minus_utc() as i64 * 1_000_000_000;
    let local_minute_ns = total_ns + off_ns - ((total_ns + off_ns) % (60 * 1_000_000_000));
    let start_of_minute_ms = local_minute_ns / 1_000_000;

    for (id, cron, last) in due {
        if !cron_matches(&cron, &now) {
            continue;
        }
        if last == Some(start_of_minute_ms) {
            // Already fired for this minute.
            continue;
        }
        // Coalesce: if a run is already waiting to start (a `submit` row not yet
        // claimed), merge this tick into it instead of stacking a second
        // waiting run. A currently executing (accepted/running) run does NOT
        // block queueing — the new run is enqueued behind it and the serial
        // worker picks it up when the current one finishes, so a due tick is
        // never dropped. Queue depth stays at most 1.
        if dag_has_pending_run(&conn, &id) {
            eprintln!("[cron] merge {} (cron '{}'): a run is already queued waiting", id, cron);
            continue;
        }
        match submit_dag_run(&id, "cron") {
            Ok(_) => {
                eprintln!("[cron] triggered dag {} (cron '{}')", id, cron);
                if let Err(e) = conn.execute(
                    "UPDATE dags SET last_cron_run_ms = ?2 WHERE id = ?1",
                    params![id, start_of_minute_ms],
                ) {
                    eprintln!("[cron] update last_cron_run_ms for {} failed: {}", id, e);
                }
            }
            Err(e) => eprintln!("[cron] submit {} failed: {}", id, e),
        }
    }

    Ok(())
}

/// Sleep until just past the next minute boundary so the next tick lands on a
/// fresh minute.
fn sleep_until_next_minute() {
    let now = Local::now();
    let secs_into_minute = now.second() as u64;
    let nanos_into_sec = now.timestamp_subsec_nanos() as u64;
    let millis_to_next = (60 - secs_into_minute) * 1000 - (nanos_into_sec / 1_000_000) as u64;
    // small slack so we don't fire a hair early
    std::thread::sleep(Duration::from_millis(millis_to_next.max(1) + 50));
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn run_dag(dag_id: String) -> Result<DagExecution, String> {
    // Manual trigger: just enqueue; the Python execution engine consumes it.
    submit_dag_run(&dag_id, "manual")
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn get_execution(execution_id: String) -> Result<DagExecution, String> {
    let (conn, _path) = open_sqlite_database()?;
    let execution = conn
        .query_row(
            "SELECT id, dag_id, status, trigger_kind, started_at_ms, completed_at_ms, outputs, snapshot \
             FROM dag_executions WHERE id = ?1",
            params![execution_id],
            |row| {
                let outputs_json: Option<String> = row.get("outputs")?;
                Ok(DagExecution {
                    id: row.get("id")?,
                    dag_id: row.get("dag_id")?,
                    status: row.get("status")?,
                    trigger_kind: row.get("trigger_kind")?,
                    started_at_ms: row.get("started_at_ms")?,
                    completed_at_ms: row.get("completed_at_ms")?,
                    outputs: outputs_json.and_then(|s| serde_json::from_str(&s).ok()),
                    snapshot: row.get("snapshot")?,
                })
            },
        )
        .map_err(error_to_string)?;
    Ok(execution)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn list_executions(dag_id: String) -> Result<Vec<DagExecution>, String> {
    let (conn, _path) = open_sqlite_database()?;
    let mut statement = conn
        .prepare(
            "SELECT id, dag_id, status, trigger_kind, started_at_ms, completed_at_ms, outputs, snapshot \
             FROM dag_executions WHERE dag_id = ?1 ORDER BY started_at_ms DESC",
        )
        .map_err(error_to_string)?;

    let rows = statement
        .query_map(params![dag_id], |row| {
            let outputs_json: Option<String> = row.get("outputs")?;
            Ok(DagExecution {
                id: row.get("id")?,
                dag_id: row.get("dag_id")?,
                status: row.get("status")?,
                trigger_kind: row.get("trigger_kind")?,
                started_at_ms: row.get("started_at_ms")?,
                completed_at_ms: row.get("completed_at_ms")?,
                outputs: outputs_json.and_then(|s| serde_json::from_str(&s).ok()),
                snapshot: row.get("snapshot")?,
            })
        })
        .map_err(error_to_string)?;

    let mut executions = Vec::new();
    for row in rows {
        executions.push(row.map_err(error_to_string)?);
    }
    Ok(executions)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn get_execution_logs(execution_id: String) -> Result<Vec<ExecutionLog>, String> {
    let (conn, _path) = open_sqlite_database()?;
    let mut statement = conn
        .prepare(
            "SELECT id, execution_id, node_id, level, message, timestamp_ms FROM execution_logs \
             WHERE execution_id = ?1 ORDER BY timestamp_ms ASC",
        )
        .map_err(error_to_string)?;

    let rows = statement
        .query_map(params![execution_id], |row| {
            Ok(ExecutionLog {
                id: row.get("id")?,
                execution_id: row.get("execution_id")?,
                node_id: row.get("node_id")?,
                level: row.get("level")?,
                message: row.get("message")?,
                timestamp_ms: row.get("timestamp_ms")?,
            })
        })
        .map_err(error_to_string)?;

    let mut logs = Vec::new();
    for row in rows {
        logs.push(row.map_err(error_to_string)?);
    }
    Ok(logs)
}

/// Read a single page of a node's on-disk log file.
///
/// The Python engine writes each node's full (untruncated) stdout/stderr to
/// `<log_dir>/<execution_id>/<node_id>.log`. This returns lines
/// `[offset, offset+limit)` plus the total line count, so the UI pages through
/// the log without ever loading the whole file into memory.
///
/// Returns an error (→ HTTP 4xx) when the file does not exist — that happens
/// for executions that ran *before* file-based logging was introduced, and the
/// client falls back to the legacy DB-backed `/logs` endpoint for those.
pub fn get_node_log(
    execution_id: String,
    node_id: String,
    offset: usize,
    limit: usize,
) -> Result<NodeLogFile, String> {
    let path = log_dir().join(&execution_id).join(format!("{node_id}.log"));
    if !path.exists() {
        return Err(format!("node log file not found: {}", path.display()));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let all: Vec<&str> = content.split('\n').collect();
    // A trailing newline yields one spurious empty final element; drop it.
    let total = if all.last().map_or(false, |l| l.is_empty()) {
        all.len().saturating_sub(1)
    } else {
        all.len()
    };
    let start = offset.min(total);
    let end = (start + limit).min(total);
    let lines: Vec<String> = all[start..end].iter().map(|s| s.to_string()).collect();
    Ok(NodeLogFile {
        lines,
        offset: start,
        limit,
        total,
        truncated: false,
    })
}

/// Remove on-disk component-log directories whose execution is older than
/// `days` days. Best-effort: any individual error is ignored. Called on server
/// startup so stale logs don't accumulate forever (the user's retention
/// policy: keep 30 days). `<log_dir>` contains *only* per-execution log
/// directories, so pruning it by mtime is safe.
pub fn prune_old_logs(days: u64) {
    let dir = log_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(days * 24 * 3600))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        if let Ok(meta) = fs::metadata(&p) {
            if let Ok(mtime) = meta.modified() {
                if mtime < cutoff {
                    let _ = fs::remove_dir_all(&p);
                }
            }
        }
    }
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn get_node_executions(execution_id: String) -> Result<Vec<NodeExecution>, String> {
    let (conn, _path) = open_sqlite_database()?;
    let mut statement = conn
        .prepare(
            "SELECT id, execution_id, node_id, status, started_at_ms, completed_at_ms, \
             output_path, outputs, error FROM node_executions WHERE execution_id = ?1 \
             ORDER BY started_at_ms ASC",
        )
        .map_err(error_to_string)?;

    let rows = statement
        .query_map(params![execution_id], |row| {
            let outputs_json: Option<String> = row.get("outputs")?;
            Ok(NodeExecution {
                id: row.get("id")?,
                execution_id: row.get("execution_id")?,
                node_id: row.get("node_id")?,
                status: row.get("status")?,
                started_at_ms: row.get("started_at_ms")?,
                completed_at_ms: row.get("completed_at_ms")?,
                output_path: row.get("output_path")?,
                outputs: outputs_json.and_then(|s| serde_json::from_str(&s).ok()),
                error: row.get("error")?,
            })
        })
        .map_err(error_to_string)?;

    let mut executions = Vec::new();
    for row in rows {
        executions.push(row.map_err(error_to_string)?);
    }
    Ok(executions)
}

/// Fetch the single `node_executions` row for a node within a given execution
/// (used to locate the output file path).
pub fn get_node_execution(
    execution_id: String,
    node_id: String,
) -> Result<Option<NodeExecution>, String> {
    let (conn, _path) = open_sqlite_database()?;
    let mut statement = conn
        .prepare(
            "SELECT id, execution_id, node_id, status, started_at_ms, completed_at_ms, \
             output_path, outputs, error FROM node_executions \
             WHERE execution_id = ?1 AND node_id = ?2 LIMIT 1",
        )
        .map_err(error_to_string)?;
    let mut rows = statement
        .query_map(params![execution_id, node_id], |row| {
            let outputs_json: Option<String> = row.get("outputs")?;
            Ok(NodeExecution {
                id: row.get("id")?,
                execution_id: row.get("execution_id")?,
                node_id: row.get("node_id")?,
                status: row.get("status")?,
                started_at_ms: row.get("started_at_ms")?,
                completed_at_ms: row.get("completed_at_ms")?,
                output_path: row.get("output_path")?,
                outputs: outputs_json.and_then(|s| serde_json::from_str(&s).ok()),
                error: row.get("error")?,
            })
        })
        .map_err(error_to_string)?;
    match rows.next() {
        None => Ok(None),
        Some(row) => Ok(Some(row.map_err(error_to_string)?)),
    }
}

/// Preview the first `limit` rows of a node's given output port.
///
/// The file path comes from `outputs[output_name].path`, which the worker
/// writes into the DB. `output_name` is only used as a map key and **never
/// participates in any filesystem path construction**, so there is no path
/// traversal risk.
/// Guess a file's preview format from its extension. Case-insensitive.
/// Recognises: csv, json, jsonl, parquet (.parquet / .pq / .parq).
/// Unknown extensions return "" which downstream converts to a friendly
/// "unsupported format" hint rather than a crash.
fn guess_format_from_path(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".csv") {
        "csv".to_string()
    } else if lower.ends_with(".jsonl") {
        "json".to_string()
    } else if lower.ends_with(".json") {
        "json".to_string()
    } else if lower.ends_with(".parquet") || lower.ends_with(".pq") || lower.ends_with(".parq") {
        "parquet".to_string()
    } else {
        String::new()
    }
}

/// Shared helper: extract a file path (and its format hint) from a node
/// execution's outputs JSON for a given output port. Understands both the
/// canonical file-card entry `{path, format}` and the legacy raw-string
/// shortcut that older components emit.
pub fn resolve_output_file_path(
    execution_id: &str,
    node_id: &str,
    output_name: &str,
) -> Result<(String, String), String> {
    let ne = get_node_execution(execution_id.to_string(), node_id.to_string())?
        .ok_or_else(|| format!("未找到节点执行记录 (execution={}, node={})", execution_id, node_id))?;
    let outputs = ne
        .outputs
        .ok_or_else(|| "该节点执行没有 outputs 记录".to_string())?;
    let entry = outputs
        .get(output_name)
        .ok_or_else(|| format!("outputs 中不存在名为 '{}' 的输出端口", output_name))?;

    match entry {
        Value::Object(map) => {
            let path = map
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    format!(
                        "outputs 条目缺少 path 字段（entry 是对象但不含 path，可能是非文件端口如 status）: {:?}",
                        entry
                    )
                })?;
            let format = map
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Ok((path.to_string(), format))
        }
        Value::String(s) => {
            let fmt = guess_format_from_path(s);
            Ok((s.clone(), fmt))
        }
        _ => Err(format!(
            "outputs 条目格式不支持（既不是对象也不是字符串）: {:?}",
            entry
        )),
    }
}

/// Return the absolute server-side file path of a node's output.
/// Thin wrapper over `resolve_output_file_path` — useful for callers that
/// only need the file path (e.g. download handlers) and don't care about
/// the format hint.
pub fn get_output_file_path(
    execution_id: &str,
    node_id: &str,
    output_name: &str,
) -> Result<String, String> {
    resolve_output_file_path(execution_id, node_id, output_name).map(|(p, _)| p)
}

pub fn preview_node_output(
    execution_id: String,
    node_id: String,
    output_name: String,
    limit: usize,
) -> Result<OutputPreview, String> {
    let limit = limit.clamp(1, 1000);
    let ne = get_node_execution(execution_id.clone(), node_id.clone())?
        .ok_or_else(|| format!("未找到节点执行记录 (execution={}, node={})", execution_id, node_id))?;
    let outputs = ne
        .outputs
        .ok_or_else(|| "该节点执行没有 outputs 记录".to_string())?;
    let entry = outputs
        .get(&output_name)
        .ok_or_else(|| format!("outputs 中不存在名为 '{}' 的输出端口", output_name))?;

    // Compatibility shim: components may emit either the proper *file card*
    // ({"path": "/abs/file.csv", "format": "csv"}) or a raw string path
    // ("/abs/file.csv") as a legacy shortcut. Non-file values (status ports,
    // scalar summaries) surface a clear error instead of silently 500-ing.
    let (path, format) = match entry {
        Value::Object(map) => {
            let path = map
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    format!(
                        "outputs 条目缺少 path 字段（entry 是对象但不含 path，可能是非文件端口如 status）: {:?}",
                        entry
                    )
                })?;
            let format = map.get("format").and_then(|v| v.as_str()).unwrap_or("").to_string();
            (path.to_string(), format)
        }
        Value::String(s) => {
            let fmt = guess_format_from_path(s);
            // Unknown extension → fmt is "" → downstream match falls into
            // `other` arm and returns a friendly "unsupported format" hint.
            (s.clone(), fmt)
        }
        _ => {
            return Err(format!(
                "outputs 条目格式不支持（既不是对象也不是字符串）: {:?}",
                entry
            ));
        }
    };

    let meta = std::fs::metadata(&path).map_err(error_to_string)?;
    if !meta.is_file() {
        return Err(format!("输出文件不存在或不是常规文件: {}", path));
    }

    match format.as_str() {
        "csv" => preview_csv(&path, &output_name, limit),
        "json" | "jsonl" => preview_json(&path, &output_name, limit),
        "parquet" => preview_parquet_via_python(&path, &output_name, limit),
        other => Ok(OutputPreview {
            output_name,
            format: other.to_string(),
            columns: vec![],
            rows: vec![],
            truncated: false,
            total: None,
            unsupported: Some(format!(
                "暂不支持 '{}' 格式预览，请在服务端直接打开文件查看：\n{}",
                other, path
            )),
            file_path: path.clone(),
        }),
    }
}

fn preview_csv(path: &str, output_name: &str, limit: usize) -> Result<OutputPreview, String> {
    let mut rdr = csv::Reader::from_path(path).map_err(error_to_string)?;
    let headers = rdr.headers().map_err(error_to_string)?.clone();
    let columns: Vec<String> = headers.iter().map(|s| s.to_string()).collect();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;
    for result in rdr.records() {
        if rows.len() >= limit {
            truncated = true;
            break;
        }
        let rec = result.map_err(error_to_string)?;
        rows.push(rec.iter().map(|s| Value::String(s.to_string())).collect());
    }
    Ok(OutputPreview {
        output_name: output_name.to_string(),
        format: "csv".to_string(),
        columns,
        rows,
        truncated,
        total: None,
        unsupported: None,
        file_path: path.to_string(),
    })
}

fn preview_json(path: &str, output_name: &str, limit: usize) -> Result<OutputPreview, String> {
    let text = std::fs::read_to_string(path).map_err(error_to_string)?;
    // Supports both the "JSON array" and "JSON Lines" layouts.
    let objects: Vec<Value> = if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&text) {
        arr
    } else {
        text.lines()
            .filter_map(|l| {
                let t = l.trim();
                if t.is_empty() {
                    None
                } else {
                    serde_json::from_str::<Value>(t).ok()
                }
            })
            .collect()
    };
    let mut columns: Vec<String> = Vec::new();
    for obj in objects.iter().take(limit) {
        if let Value::Object(map) = obj {
            for k in map.keys() {
                if !columns.contains(k) {
                    columns.push(k.clone());
                }
            }
        }
    }
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;
    for obj in objects.into_iter() {
        if rows.len() >= limit {
            truncated = true;
            break;
        }
        if let Value::Object(map) = obj {
            rows.push(
                columns
                    .iter()
                    .map(|c| map.get(c).cloned().unwrap_or(Value::Null))
                    .collect(),
            );
        } else {
            rows.push(vec![obj]);
        }
    }
    Ok(OutputPreview {
        output_name: output_name.to_string(),
        format: "json".to_string(),
        columns,
        rows,
        truncated,
        total: None,
        unsupported: None,
        file_path: path.to_string(),
    })
}

/// Inline Python script that reads a parquet file, takes the first `limit`
/// rows, and prints a JSON object `{columns, rows, truncated, total}` to
/// stdout. Stays as a raw `&str` constant — no extra files to bundle, no
/// dependency on the engine_executor directory being present at runtime.
const PARQUET_PREVIEW_PYTHON: &str = r#"
import json, sys

def main():
    f, limit_s = sys.argv[1], int(sys.argv[2])
    try:
        import pyarrow.parquet as _pq
        table = _pq.read_table(f)
        total = table.num_rows
        head = table.slice(0, limit_s).to_pylist()
        cols = [table.schema.field(i).name for i in range(table.num_columns)]
        rows = [[rec.get(c) for c in cols] for rec in head]
    except ImportError:
        try:
            import pandas as _pd
            pdf = _pd.read_parquet(f)
            total = len(pdf)
            cols = list(pdf.columns)
            rows = json.loads(
                pdf.head(limit_s).to_json(orient='values', date_format='iso')
            )
        except ImportError:
            sys.stderr.write(
                "no parquet engine installed on server: need pyarrow or pandas\n"
            )
            sys.exit(2)

    # pyarrow scalars / numpy types -> native JSON-friendly values.
    def _clean(v):
        if v is None:
            return None
        if hasattr(v, "as_py"):
            return v.as_py()
        return v

    rows = [[_clean(c) for c in row] for row in rows]
    out = {"columns": cols, "rows": rows, "truncated": total > limit_s, "total": total}
    print(json.dumps(out))

main()
"#;

/// Read a parquet file by spawning `python3` with the inline script above.
/// Returns a normal `OutputPreview` (columns + rows) when successful.
/// Errors are surfaced as plain strings; callers bubble them up as HTTP 500.
fn preview_parquet_via_python(
    path: &str,
    output_name: &str,
    limit: usize,
) -> Result<OutputPreview, String> {
    let output = std::process::Command::new("python3")
        .arg("-c")
        .arg(PARQUET_PREVIEW_PYTHON)
        .arg(path)
        .arg(limit.to_string())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("failed to spawn python3 for parquet preview: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        match output.status.code() {
            Some(2) => {
                // Our script exits 2 when neither pyarrow nor pandas is available.
                return Err(format!(
                    "parquet 预览需要 pyarrow 或 pandas：远程服务器缺少依赖\n{}",
                    stderr.trim()
                ));
            }
            _ => {
                return Err(format!(
                    "python3 执行失败 ({}): {}",
                    output.status,
                    stderr.trim()
                ));
            }
        }
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(&stdout).map_err(|e| {
        format!(
            "python3 输出不是合法 JSON: {e}\nraw: {}",
            stdout.chars().take(200).collect::<String>()
        )
    })?;

    let columns: Vec<String> = parsed
        .get("columns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let rows: Vec<Vec<Value>> = parsed
        .get("rows")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|row| row.as_array().map(|r| r.clone()))
                .collect()
        })
        .unwrap_or_default();

    let truncated = parsed
        .get("truncated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let total = parsed
        .get("total")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize);

    Ok(OutputPreview {
        output_name: output_name.to_string(),
        format: "parquet".to_string(),
        columns,
        rows,
        truncated,
        total,
        unsupported: None,
        file_path: path.to_string(),
    })
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn cancel_execution(execution_id: String) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    // Only request cancellation for runs that are still in flight. Terminal
    // states (success / failed / cancelled) are left untouched. The Python
    // execution engine polls for `cancel_requested` and terminates the process.
    conn.execute(
        "UPDATE dag_executions SET status = 'cancel_requested' \
         WHERE id = ?1 AND status NOT IN ('success', 'failed', 'cancelled')",
        params![execution_id],
    )
    .map_err(error_to_string)?;
    Ok(())
}

/// Tauri command: write raw bytes to an absolute path chosen by the user
/// via the native "Save As" dialog. Used by the DataPreviewModal download
/// flow — the frontend streams the file from the DAG server, shows live
/// progress, then hands the bytes off here so the file lands exactly where
/// the user picked.
///
/// Only compiled when the "gui" feature is on (Tauri build); the headless
/// HTTP server has no IPC layer and therefore doesn't expose this command.
#[cfg(feature = "gui")]
#[tauri::command]
pub fn save_bytes_to_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    // Ensure the parent directory exists — dialog.save() doesn't create it
    // automatically if the user picks a folder that was just mounted.
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!("创建目标目录失败 {}: {}", parent.display(), e)
        })?;
    }
    std::fs::write(&path, &bytes).map_err(|e| {
        format!("写文件失败 {}: {}", path, e)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guess_format_from_path_handles_csv() {
        assert_eq!(guess_format_from_path("/tmp/data.csv"), "csv");
        assert_eq!(guess_format_from_path("/tmp/data.CSV"), "csv");
        assert_eq!(guess_format_from_path("data.Csv"), "csv");
    }

    #[test]
    fn guess_format_from_path_handles_json_and_jsonl() {
        assert_eq!(guess_format_from_path("/tmp/data.json"), "json");
        assert_eq!(guess_format_from_path("/tmp/data.JSON"), "json");
        assert_eq!(guess_format_from_path("/tmp/data.jsonl"), "json");
        assert_eq!(guess_format_from_path("/tmp/data.JSONL"), "json");
    }

    #[test]
    fn guess_format_from_path_handles_parquet() {
        assert_eq!(guess_format_from_path("/tmp/data.parquet"), "parquet");
        assert_eq!(guess_format_from_path("/tmp/data.PARQUET"), "parquet");
        assert_eq!(guess_format_from_path("/tmp/data.pq"), "parquet");
        assert_eq!(guess_format_from_path("/tmp/data.parq"), "parquet");
    }

    #[test]
    fn guess_format_from_path_returns_empty_for_unknown() {
        assert_eq!(guess_format_from_path("/tmp/data.txt"), "");
        assert_eq!(guess_format_from_path("/tmp/data.bin"), "");
        assert_eq!(guess_format_from_path("no_extension"), "");
    }

    #[test]
    fn guess_format_from_path_handles_paths_with_dots() {
        // Path itself contains dots but ends with a known extension.
        assert_eq!(guess_format_from_path("/tmp/v1.2.3/data.csv"), "csv");
        assert_eq!(guess_format_from_path("/tmp/report.2024-01.json"), "json");
        assert_eq!(guess_format_from_path("/tmp/report.2024-01.parquet"), "parquet");
    }
}
