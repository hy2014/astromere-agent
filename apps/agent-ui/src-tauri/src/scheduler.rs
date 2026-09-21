//! Topological scheduling and execution state machine for the component DAG platform.

use crate::dag::{get_dag, cron_matches};
use crate::dag_server_config::log_dir;
use crate::sqlite::open_sqlite_database;
use crate::types::{DagDetail, DagExecution, ExecutionLog, NodeExecution, NodeLogFile};
use chrono::{DateTime, Datelike, Local, NaiveDate, Timelike};
use rusqlite::params;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
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
    /// All artifacts of this port (a port value may be a single artifact or a
    /// list). `file_path` above is the previewed one. Length 1 = single-valued
    /// port → frontends hide the artifact selector.
    pub artifacts: Vec<OutputArtifact>,
}

/// One artifact of an output port: a path on the server plus its format hint.
/// The path may point at a regular file OR a directory (a partition dir such
/// as `month=YYYYMM/`, or a hive-partitioned table root).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutputArtifact {
    pub path: String,
    pub format: String,
}

/// Normalize one output-port value into a list of artifacts.
///
/// Accepted shapes (all coexist — legacy values must keep working):
///   - raw string path            `"/abs/a.csv"`
///   - file card                  `{"path": "/abs/a", "format": "parquet"}`
///   - list of either of the above  `[ ... ]`
///
/// A single-element list is semantically identical to a single value, so
/// callers never need to branch on the shape. An empty list is a real error
/// (the port produced nothing) — surfaced rather than silently returning [].
fn parse_port_entry(entry: &Value) -> Result<Vec<OutputArtifact>, String> {
    match entry {
        Value::Array(items) => {
            if items.is_empty() {
                return Err("该输出端口本次没有产出（输出列表为空）".to_string());
            }
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                out.push(
                    parse_single_entry(item)
                        .map_err(|e| format!("输出列表第 {} 项解析失败: {e}", i))?,
                );
            }
            Ok(out)
        }
        other => Ok(vec![parse_single_entry(other)?]),
    }
}

fn parse_single_entry(entry: &Value) -> Result<OutputArtifact, String> {
    match entry {
        Value::Object(map) => {
            let path = map
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    format!(
                        "条目缺少 path 字段（可能是非文件端口如 status）: {entry:?}"
                    )
                })?;
            let declared = map.get("format").and_then(|v| v.as_str()).unwrap_or("");
            Ok(OutputArtifact {
                path: path.to_string(),
                format: resolve_artifact_format(path, declared),
            })
        }
        Value::String(s) => Ok(OutputArtifact {
            path: s.clone(),
            format: guess_format_from_path(s),
        }),
        _ => Err(format!(
            "条目格式不支持（既不是对象、字符串，也不是列表）: {entry:?}"
        )),
    }
}

/// Effective format of an artifact: the card's declared `format` wins;
/// otherwise infer from the extension. A directory has no extension, so an
/// undeclared format on a directory yields "" and the caller reports a clear
/// hint instead of guessing.
fn resolve_artifact_format(path: &str, declared: &str) -> String {
    if !declared.is_empty() {
        return declared.to_string();
    }
    guess_format_from_path(path)
}

/// All artifacts of a node's output port, normalized to a list.
pub fn output_artifacts(
    execution_id: &str,
    node_id: &str,
    output_name: &str,
) -> Result<Vec<OutputArtifact>, String> {
    let ne = get_node_execution(execution_id.to_string(), node_id.to_string())?
        .ok_or_else(|| format!("未找到节点执行记录 (execution={}, node={})", execution_id, node_id))?;
    let outputs = ne
        .outputs
        .ok_or_else(|| "该节点执行没有 outputs 记录".to_string())?;
    let entry = outputs
        .get(output_name)
        .ok_or_else(|| format!("outputs 中不存在名为 '{}' 的输出端口", output_name))?;
    parse_port_entry(entry)
}

/// Resolve date expressions in every string value of a node's `params`
/// (list elements included). See `resolve_param_expr`.
fn resolve_params(params: &mut Value, now: DateTime<Local>) -> Result<(), String> {
    let map = match params.as_object_mut() {
        Some(map) => map,
        None => return Ok(()),
    };
    for (key, value) in map.iter_mut() {
        match value {
            Value::String(s) => {
                *s = resolve_param_expr(s, now).map_err(|e| format!("参数 {key}: {e}"))?;
            }
            Value::Array(items) => {
                for (i, item) in items.iter_mut().enumerate() {
                    if let Value::String(s) = item {
                        *s = resolve_param_expr(s, now)
                            .map_err(|e| format!("参数 {key}[{i}]: {e}"))?;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// 把参数值里的日期表达式换成具体值，提交时解析一次：
///
///     $current_month(yyyyMM, -1)   上月，如 202608
///     $current_day(yyyyMMdd, -1)   昨天，如 20260917
///
/// `fmt` 用 yyyy / MM / dd 记号，其余字符原样输出（如 `yyyy-MM`）。`$current_month`
/// 只到月，fmt 里出现 dd 报错。不是表达式的值原样返回；形状像表达式但写错则报错
/// （避免把 `$current_month(...)` 当普通字符串传给组件，让组件报看不懂的日期错）。
fn resolve_param_expr(value: &str, now: DateTime<Local>) -> Result<String, String> {
    let body = match value.strip_prefix('$') {
        Some(body) => body,
        None => return Ok(value.to_string()),
    };
    let open = match body.find('(') {
        Some(i) if body.ends_with(')') => i,
        _ => return Ok(value.to_string()),
    };
    let name = &body[..open];
    let args: Vec<&str> = body[open + 1..body.len() - 1]
        .split(',')
        .map(str::trim)
        .collect();

    if name != "current_month" && name != "current_day" {
        return Err(format!("未知函数 ${name}（支持 $current_month / $current_day）"));
    }
    if args.len() != 2 || args[0].is_empty() {
        return Err(format!("${name} 需要 2 个参数：fmt, delta"));
    }
    let (fmt, delta_arg) = (args[0], args[1]);
    let delta: i64 = delta_arg
        .parse()
        .map_err(|_| format!("delta 必须是整数: {delta_arg:?}"))?;

    let today = now.date_naive();
    let date = if name == "current_month" {
        shift_months(today, delta)?
    } else {
        today
            .checked_add_signed(chrono::Duration::days(delta))
            .ok_or_else(|| format!("日期越界: 今天 {delta} 天"))?
    };
    format_date(date, fmt, name == "current_day")
}

/// `date` 所在月平移 delta 个月后的 1 号。
fn shift_months(date: NaiveDate, delta: i64) -> Result<NaiveDate, String> {
    let total = date.year() as i64 * 12 + (date.month() as i64 - 1) + delta;
    NaiveDate::from_ymd_opt(
        total.div_euclid(12) as i32,
        (total.rem_euclid(12) + 1) as u32,
        1,
    )
    .ok_or_else(|| format!("月份越界: delta={delta}"))
}

fn format_date(date: NaiveDate, fmt: &str, allow_day: bool) -> Result<String, String> {
    let chars: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let rest: String = chars[i..].iter().collect();
        if rest.starts_with("yyyy") {
            out.push_str(&format!("{:04}", date.year()));
            i += 4;
        } else if rest.starts_with("MM") {
            out.push_str(&format!("{:02}", date.month()));
            i += 2;
        } else if rest.starts_with("dd") {
            if !allow_day {
                return Err("$current_month 的 fmt 不支持 dd（只能用 yyyy / MM）".to_string());
            }
            out.push_str(&format!("{:02}", date.day()));
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    Ok(out)
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
    let now = Local::now();
    let nodes: Vec<Value> = detail
        .nodes
        .iter()
        .map(|n| -> Result<Value, String> {
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
                // Carry the declared output ports too: the Python worker validates
                // a node's "注册到DW" port selection against this frozen schema.
                config.insert("outputSchema".to_string(), component.output_schema.clone());
                // Live `dag_nodes.config` no longer stores the node name (it lives
                // in the component definition), so re-inject it here for the
                // history view's "per-node" snapshot display.
                config.insert("name".to_string(), serde_json::Value::String(component.name));
            }
            // 参数里的日期表达式在这里解析成具体值，冻结进快照（见 resolve_param_expr）。
            let label = config
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&n.id)
                .to_string();
            if let Some(params) = config.get_mut("params") {
                resolve_params(params, now).map_err(|e| format!("节点「{label}」{e}"))?;
            }
            Ok(serde_json::json!({
                "id": n.id,
                "component_id": n.component_id,
                "config": Value::Object(config),
            }))
        })
        .collect::<Result<Vec<Value>, String>>()?;
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
        // Freeze the DW root at submit time: later settings changes only
        // affect new executions, and resume runs replay with the same value.
        "dw_root": crate::dw_core::load_dw_settings()
            .map(|s| s.dw_root)
            .unwrap_or_else(|_| crate::dw_core::default_dw_root()),
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

/// BFS on reversed edges to collect every ancestor of `target_id`.
/// Cycles are handled by a visited set; the target itself is *not* included.
pub(crate) fn get_node_ancestors(
    detail: &DagDetail,
    target_id: &str,
) -> Result<Vec<String>, String> {
    let mut rev_adj: HashMap<String, Vec<String>> = HashMap::new();
    for e in &detail.edges {
        rev_adj
            .entry(e.target_node_id.clone())
            .or_default()
            .push(e.source_node_id.clone());
    }
    let mut ancestors: Vec<String> = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut frontier: Vec<String> = vec![target_id.to_string()];
    while let Some(cur) = frontier.pop() {
        if let Some(sources) = rev_adj.get(&cur) {
            for src in sources {
                if visited.insert(src.clone()) {
                    ancestors.push(src.clone());
                    frontier.push(src.clone());
                }
            }
        }
    }
    Ok(ancestors)
}

/// Find the most recent success execution for `dag_id`, then pull
/// node_executions.outputs for each ancestor. Returns a map keyed by
/// ancestor node_id → outputs JSON object. Ancestors without outputs
/// (failed / skipped / never executed) are simply absent from the map.
pub(crate) fn load_upstream_outputs(
    dag_id: &str,
    ancestor_ids: &[String],
) -> Result<Map<String, Value>, String> {
    if ancestor_ids.is_empty() {
        return Ok(Map::new());
    }
    let (conn, _path) = open_sqlite_database()?;

    // Most recent success execution.
    let exec_id: String = conn
        .query_row(
            "SELECT id FROM dag_executions \
             WHERE dag_id = ?1 AND status = 'success' \
             ORDER BY started_at_ms DESC LIMIT 1",
            params![dag_id],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                format!(
                    "未找到 DAG {} 成功的历史运行记录，无法继续执行。请先完整运行一次 DAG。",
                    dag_id
                )
            }
            other => error_to_string(other),
        })?;

    // Pull outputs for each ancestor.
    let mut result = Map::new();
    for ancestor in ancestor_ids {
        let outputs_str: Option<String> = conn
            .query_row(
                "SELECT outputs FROM node_executions \
                 WHERE execution_id = ?1 AND node_id = ?2 LIMIT 1",
                params![exec_id, ancestor],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        if let Some(s) = outputs_str {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                result.insert(ancestor.clone(), v);
            }
        }
    }
    Ok(result)
}

/// Build a snapshot JSON for a resume run — same shape as `build_snapshot`
/// except execution_order contains only the target node and an additional
/// `upstream_outputs` key carries ancestor outputs pulled from the last
/// successful execution.
pub(crate) fn build_resume_snapshot(
    detail: &DagDetail,
    target_node_id: &str,
    upstream_outputs: Map<String, Value>,
) -> Result<String, String> {
    let base = build_snapshot(detail)?;
    let mut plan: Value = serde_json::from_str(&base).map_err(error_to_string)?;

    // execution_order → just the target node
    plan["execution_order"] = Value::Array(vec![Value::String(target_node_id.to_string())]);

    // upstream_outputs — ancestors' outputs pulled from the DB
    let outer = if let Some(obj) = plan.as_object_mut() {
        obj
    } else {
        return Err("snapshot root is not an object".to_string());
    };
    outer.insert("upstream_outputs".to_string(), Value::Object(upstream_outputs));

    serde_json::to_string(&plan).map_err(error_to_string)
}

/// Submit a "run this single node" execution. Ancestor outputs are seeded
/// from the most recent successful full-run of the DAG (or any execution
/// where the ancestor actually produced outputs).
#[cfg_attr(feature = "gui", tauri::command)]
pub fn submit_resume_run(dag_id: String, node_id: String) -> Result<DagExecution, String> {
    let detail = get_dag(dag_id.clone())?;

    // Confirm target node actually belongs to this DAG.
    let node_exists = detail.nodes.iter().any(|n| n.id == node_id);
    if !node_exists {
        return Err(format!("节点 {} 不在 DAG {} 中", node_id, dag_id));
    }

    let ancestors = get_node_ancestors(&detail, &node_id)?;
    let upstream_outputs = load_upstream_outputs(&dag_id, &ancestors)?;

    let snapshot = build_resume_snapshot(&detail, &node_id, upstream_outputs)?;

    let (conn, _path) = open_sqlite_database()?;
    let id = crate::utils::generate_agent_ui_session_id();
    let now = chrono::Utc::now().timestamp_millis();
    let execution = DagExecution {
        id: id.clone(),
        dag_id: dag_id.clone(),
        status: "submit".to_string(),
        trigger_kind: Some("resume".to_string()),
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

/// Shared helper: extract the `index`-th artifact path (and format hint) from a
/// node execution's outputs JSON for a given output port. Understands all port
/// value shapes via `parse_port_entry` (raw string / file card / list).
pub fn resolve_output_file_path(
    execution_id: &str,
    node_id: &str,
    output_name: &str,
    index: usize,
) -> Result<(String, String), String> {
    let artifacts = output_artifacts(execution_id, node_id, output_name)?;
    let total = artifacts.len();
    artifacts
        .into_iter()
        .nth(index)
        .map(|a| (a.path, a.format))
        .ok_or_else(|| format!("产物索引越界: index={index}，该端口共 {total} 项"))
}

pub fn preview_node_output(
    execution_id: String,
    node_id: String,
    output_name: String,
    limit: usize,
    index: usize,
) -> Result<OutputPreview, String> {
    let limit = limit.clamp(1, 1000);
    let artifacts = output_artifacts(&execution_id, &node_id, &output_name)?;
    let total_artifacts = artifacts.len();
    let selected = artifacts
        .get(index)
        .ok_or_else(|| format!("产物索引越界: index={index}，该端口共 {total_artifacts} 项"))?
        .clone();

    let path = selected.path.clone();
    let format = selected.format.clone();

    // The artifact may be a regular file OR a directory (e.g. a `month=YYYYMM/`
    // partition dir or a hive-partitioned table root). Directory handling is
    // format-dependent:
    //   * parquet → hand the DIRECTORY to the previewer: pyarrow/pandas both do
    //     hive discovery, so a dir previews natively (no file picking needed).
    //   * csv/json/… → a directory has no single stream; resolve the one file
    //     inside it, and fail loudly if the choice is ambiguous.
    let meta = std::fs::metadata(&path).map_err(error_to_string)?;
    let target = if meta.is_dir() {
        if format.is_empty() {
            return Err(format!(
                "目录产物未声明格式（format），无法预览: {path}"
            ));
        }
        if format == "parquet" {
            path.clone()
        } else {
            resolve_dir_data_path(&path, &format)?
        }
    } else if meta.is_file() {
        path.clone()
    } else {
        return Err(format!("输出路径既不是常规文件也不是目录: {path}"));
    };

    let mut preview = match format.as_str() {
        "csv" => preview_csv(&target, &output_name, limit)?,
        "json" | "jsonl" => preview_json(&target, &output_name, limit)?,
        "parquet" => preview_parquet_via_python(&target, &output_name, limit)?,
        other => OutputPreview {
            output_name: output_name.clone(),
            format: other.to_string(),
            columns: vec![],
            rows: vec![],
            truncated: false,
            total: None,
            unsupported: Some(format!(
                "暂不支持 '{}' 格式预览，请在服务端直接打开文件查看：\n{}",
                other, target
            )),
            file_path: target.clone(),
            artifacts: vec![],
        },
    };
    preview.artifacts = artifacts;
    preview.file_path = target;
    Ok(preview)
}

/// Pick the single data file of `format` inside `dir`. Only used for formats
/// that cannot be previewed as a directory (csv/json); parquet dirs are handed
/// over as-is. Errors when the choice is ambiguous so the user gets a precise
/// message instead of a silently-wrong preview.
fn resolve_dir_data_path(dir: &str, format: &str) -> Result<String, String> {
    let mut matches: Vec<String> = Vec::new();
    for entry in fs::read_dir(dir).map_err(error_to_string)? {
        let entry = entry.map_err(error_to_string)?;
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let s = p.to_string_lossy().to_string();
        if guess_format_from_path(&s) == format {
            matches.push(s);
        }
    }
    matches.sort();
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(format!("目录内没有 {format} 格式的数据文件: {dir}")),
        n => Err(format!(
            "目录内有 {n} 个 {format} 文件，无法确定预览哪一个: {dir}（请直接指定文件路径）"
        )),
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
        artifacts: vec![],
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
        artifacts: vec![],
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
    import datetime as _dt
    def _clean(v):
        if v is None:
            return None
        if hasattr(v, "as_py"):
            v = v.as_py()
        if isinstance(v, _dt.datetime):
            return v.isoformat()
        if isinstance(v, _dt.date):
            return v.isoformat()
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
        artifacts: vec![],
    })
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn cancel_execution(execution_id: String) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    // First, check current status. If the execution hasn't started running yet
    // (submit / accepted), we can cancel it directly — there's no running
    // process to signal, so `cancel_requested` would just sit there forever
    // (workers only claim `submit` status). If it's already running, set
    // `cancel_requested` and let the Python worker detect it and shut down
    // gracefully. Terminal states are left untouched.
    let mut stmt = conn
        .prepare("SELECT status FROM dag_executions WHERE id = ?1")
        .map_err(error_to_string)?;
    let mut rows = stmt.query(params![execution_id]).map_err(error_to_string)?;
    let status: Option<String> = if let Some(row) = rows.next().map_err(error_to_string)? {
        Some(row.get(0).map_err(error_to_string)?)
    } else {
        None
    };
    drop(rows);
    drop(stmt);

    match status.as_deref() {
        Some("submit") | Some("accepted") | Some("preparing") | Some("pending") => {
            // Not running yet — cancel immediately
            let now_ms = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            conn.execute(
                "UPDATE dag_executions SET status = 'cancelled', completed_at_ms = ?2 \
                 WHERE id = ?1",
                params![execution_id, now_ms],
            )
            .map_err(error_to_string)?;
        }
        Some("running") | Some("cancel_requested") => {
            // Running — ask the worker to stop gracefully
            conn.execute(
                "UPDATE dag_executions SET status = 'cancel_requested' \
                 WHERE id = ?1 AND status NOT IN ('success', 'failed', 'cancelled')",
                params![execution_id],
            )
            .map_err(error_to_string)?;
        }
        _ => {
            // Terminal or unknown — no-op
        }
    }
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
    use chrono::TimeZone;

    fn at(y: i32, m: u32, d: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, 18, 0, 0).unwrap()
    }

    #[test]
    fn param_expr_current_month() {
        let now = at(2026, 9, 18);
        assert_eq!(resolve_param_expr("$current_month(yyyyMM, 0)", now).unwrap(), "202609");
        assert_eq!(resolve_param_expr("$current_month(yyyyMM, -1)", now).unwrap(), "202608");
        assert_eq!(resolve_param_expr("$current_month(yyyy-MM, 1)", now).unwrap(), "2026-10");
        assert_eq!(resolve_param_expr("$current_month(yyyyMM, -13)", now).unwrap(), "202508");
    }

    #[test]
    fn param_expr_current_month_crosses_year() {
        let now = at(2026, 12, 5);
        assert_eq!(resolve_param_expr("$current_month(yyyyMM, 1)", now).unwrap(), "202701");
        assert_eq!(resolve_param_expr("$current_month(yyyyMM, -12)", now).unwrap(), "202512");
    }

    #[test]
    fn param_expr_current_day() {
        let now = at(2026, 9, 18);
        assert_eq!(resolve_param_expr("$current_day(yyyyMMdd, 0)", now).unwrap(), "20260918");
        assert_eq!(resolve_param_expr("$current_day(yyyyMMdd, -1)", now).unwrap(), "20260917");
        assert_eq!(resolve_param_expr("$current_day(yyyy-MM-dd, 14)", now).unwrap(), "2026-10-02");
        // 跨月/跨年
        let nye = at(2026, 1, 1);
        assert_eq!(resolve_param_expr("$current_day(yyyyMMdd, -1)", nye).unwrap(), "20251231");
    }

    #[test]
    fn param_expr_passes_through_plain_values() {
        let now = at(2026, 9, 18);
        for v in ["202001", "000001", "/home/x/run.sh", "", "$HOME/x", "a(b)c"] {
            assert_eq!(resolve_param_expr(v, now).unwrap(), v, "value={v}");
        }
    }

    #[test]
    fn param_expr_rejects_bad_input() {
        let now = at(2026, 9, 18);
        for v in [
            "$current_month(yyyyMMdd, 0)",  // 月函数不支持 dd
            "$current_month(yyyyMM)",       // 参数个数
            "$current_month(yyyyMM, x)",    // delta 非整数
            "$current_month(, 0)",          // fmt 为空
            "$current_week(yyyyMM, 0)",     // 未知函数
        ] {
            assert!(resolve_param_expr(v, now).is_err(), "应当报错: {v}");
        }
    }

    #[test]
    fn resolve_params_walks_strings_and_lists() {
        let now = at(2026, 9, 18);
        let mut params = serde_json::json!({
            "start_month": "$current_month(yyyyMM, -1)",
            "end_month": "$current_month(yyyyMM, 0)",
            "symbols": ["$current_month(yyyyMM, -2)", "000001"],
            "cb_to_stock": false,
            "limit": 10,
        });
        resolve_params(&mut params, now).unwrap();
        assert_eq!(params["start_month"], "202608");
        assert_eq!(params["end_month"], "202609");
        assert_eq!(params["symbols"][0], "202607");
        assert_eq!(params["symbols"][1], "000001");
        assert_eq!(params["cb_to_stock"], false);
        assert_eq!(params["limit"], 10);

        // 报错信息带上参数名，方便定位
        let mut bad = serde_json::json!({"start_month": "$current_month(yyyyMMdd, 0)"});
        let err = resolve_params(&mut bad, now).unwrap_err();
        assert!(err.contains("start_month") && err.contains("dd"), "err={err}");
    }

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
