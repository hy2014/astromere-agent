//! Topological scheduling and execution state machine for the component DAG platform.

use crate::dag::get_dag;
use crate::sqlite::open_sqlite_database;
use crate::types::{DagDetail, DagExecution, ExecutionLog, NodeExecution};
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;

fn error_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// 节点输出预览的返回结构（前端表格框按 `columns` + `rows` 渲染）。
/// `unsupported` 非空表示服务端暂不能预览该格式（如 parquet），此时
/// `columns`/`rows` 为空，前端改为展示提示文案与文件路径。
#[derive(Serialize)]
pub struct OutputPreview {
    pub output_name: String,
    pub format: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
    pub total: Option<usize>,
    pub unsupported: Option<String>,
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
                // history view's "各节点" snapshot display.
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

/// 取某个节点在指定执行里的单行 `node_executions` 记录（用于定位输出文件路径）。
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

/// 预览节点某输出端口的前 `limit` 行数据。
///
/// 文件路径来自 DB 中 worker 写入的 `outputs[output_name].path`，`output_name`
/// 只用作 map 的 key **不参与任何文件系统路径拼接**，因此无路径穿越风险。
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
    let path = entry
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "outputs 条目缺少 path 字段".to_string())?
        .to_string();
    let format = entry
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let meta = std::fs::metadata(&path).map_err(error_to_string)?;
    if !meta.is_file() {
        return Err(format!("输出文件不存在或不是常规文件: {}", path));
    }

    match format.as_str() {
        "csv" => preview_csv(&path, &output_name, limit),
        "json" | "jsonl" => preview_json(&path, &output_name, limit),
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
    })
}

fn preview_json(path: &str, output_name: &str, limit: usize) -> Result<OutputPreview, String> {
    let text = std::fs::read_to_string(path).map_err(error_to_string)?;
    // 支持「JSON 数组」或「JSON Lines」两种布局
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
