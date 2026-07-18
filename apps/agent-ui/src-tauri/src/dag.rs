//! DAG, node, and edge CRUD plus validation for the component DAG platform.

use crate::components::{get_component, verify_component};
use crate::sqlite::open_sqlite_database;
use crate::types::{Dag, DagDetail, DagEdge, DagNode, DagNodePosition};
use chrono::{DateTime, Datelike, Local, Timelike};
use rusqlite::params;
use serde_json::Map;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

fn error_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn row_to_dag(row: &rusqlite::Row) -> Result<Dag, rusqlite::Error> {
    let execution_order_json: Option<String> = row.get("execution_order")?;
    let execution_order: Option<Value> = execution_order_json
        .and_then(|json| serde_json::from_str(&json).ok());

    Ok(Dag {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        status: row.get("status")?,
        execution_order,
        cron: row.get("cron")?,
        created_at_ms: row.get("created_at_ms")?,
        updated_at_ms: row.get("updated_at_ms")?,
    })
}

fn row_to_dag_node(row: &rusqlite::Row) -> Result<DagNode, rusqlite::Error> {
    let config_json: String = row.get("config")?;
    let config: Value = serde_json::from_str(&config_json).unwrap_or(Value::Object(Map::new()));
    Ok(DagNode {
        id: row.get("id")?,
        dag_id: row.get("dag_id")?,
        component_id: row.get::<_, Option<String>>("component_id")?.unwrap_or_default(),
        label: row.get("label")?,
        position: DagNodePosition {
            x: row.get("pos_x")?,
            y: row.get("pos_y")?,
        },
        config,
    })
}

fn row_to_dag_edge(row: &rusqlite::Row) -> Result<DagEdge, rusqlite::Error> {
    Ok(DagEdge {
        id: row.get("id")?,
        dag_id: row.get("dag_id")?,
        source_node_id: row.get("source_node_id")?,
        target_node_id: row.get("target_node_id")?,
        source_handle: row.get("source_handle")?,
        target_handle: row.get("target_handle")?,
    })
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn list_dags() -> Result<Vec<Dag>, String> {
    let (conn, _path) = open_sqlite_database()?;
    let mut statement = conn
        .prepare(
            "SELECT id, name, description, status, execution_order, cron, created_at_ms, \
             updated_at_ms FROM dags ORDER BY updated_at_ms DESC",
        )
        .map_err(error_to_string)?;

    let rows = statement
        .query_map([], row_to_dag)
        .map_err(error_to_string)?;

    let mut dags = Vec::new();
    for row in rows {
        dags.push(row.map_err(error_to_string)?);
    }
    Ok(dags)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn get_dag(dag_id: String) -> Result<DagDetail, String> {
    let (conn, _path) = open_sqlite_database()?;

    let dag = conn
        .query_row(
            "SELECT id, name, description, status, execution_order, cron, created_at_ms, \
             updated_at_ms FROM dags WHERE id = ?1",
            params![dag_id],
            row_to_dag,
        )
        .map_err(error_to_string)?;

    let mut nodes_statement = conn
        .prepare(
            "SELECT id, dag_id, component_id, label, pos_x, pos_y, config FROM dag_nodes \
             WHERE dag_id = ?1",
        )
        .map_err(error_to_string)?;
    let nodes_rows = nodes_statement
        .query_map(params![dag_id], row_to_dag_node)
        .map_err(error_to_string)?;
    let mut nodes = Vec::new();
    for row in nodes_rows {
        nodes.push(row.map_err(error_to_string)?);
    }

    let mut edges_statement = conn
        .prepare(
            "SELECT id, dag_id, source_node_id, target_node_id, source_handle, target_handle \
             FROM dag_edges WHERE dag_id = ?1",
        )
        .map_err(error_to_string)?;
    let edges_rows = edges_statement
        .query_map(params![dag_id], row_to_dag_edge)
        .map_err(error_to_string)?;
    let mut edges = Vec::new();
    for row in edges_rows {
        edges.push(row.map_err(error_to_string)?);
    }

    Ok(DagDetail {
        id: dag.id,
        name: dag.name,
        description: dag.description,
        status: dag.status,
        execution_order: dag.execution_order,
        cron: dag.cron,
        created_at_ms: dag.created_at_ms,
        updated_at_ms: dag.updated_at_ms,
        nodes,
        edges,
    })
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn create_dag(name: String) -> Result<Dag, String> {
    let id = crate::utils::generate_agent_ui_session_id();
    let now = chrono::Utc::now().timestamp_millis();
    let dag = Dag {
        id,
        name,
        description: None,
        status: "draft".to_string(),
        execution_order: None,
        cron: None,
        created_at_ms: now,
        updated_at_ms: now,
    };

    let (conn, _path) = open_sqlite_database()?;
    conn.execute(
        "INSERT INTO dags (id, name, description, status, execution_order, created_at_ms, \
         updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            dag.id,
            dag.name,
            dag.description,
            dag.status,
            None::<String>,
            dag.created_at_ms,
            dag.updated_at_ms,
        ],
    )
    .map_err(error_to_string)?;

    Ok(dag)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn update_dag(
    dag: Dag,
    nodes: Vec<DagNode>,
    edges: Vec<DagEdge>,
) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    let tx = conn.unchecked_transaction().map_err(error_to_string)?;

    let execution_order_json = dag
        .execution_order
        .as_ref()
        .map(|v| serde_json::to_string(v).map_err(error_to_string))
        .transpose()?;

    tx.execute(
        "UPDATE dags SET name = ?2, description = ?3, status = ?4, execution_order = ?5, \
         cron = ?6, updated_at_ms = ?7 WHERE id = ?1",
        params![
            dag.id,
            dag.name,
            dag.description,
            dag.status,
            execution_order_json,
            dag.cron,
            dag.updated_at_ms,
        ],
    )
    .map_err(error_to_string)?;

    tx.execute("DELETE FROM dag_nodes WHERE dag_id = ?1", params![dag.id])
        .map_err(error_to_string)?;
    tx.execute("DELETE FROM dag_edges WHERE dag_id = ?1", params![dag.id])
        .map_err(error_to_string)?;

    let mut node_insert = tx
        .prepare(
            "INSERT INTO dag_nodes (id, dag_id, component_id, label, pos_x, pos_y, config) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .map_err(error_to_string)?;
    for node in &nodes {
        let config_json = serde_json::to_string(&node.config).map_err(error_to_string)?;
        // The drag flow always creates a component, so component_id is normally
        // set. Still tolerate an empty id (bind NULL) for robustness; non-empty
        // ids reference the components table via FK.
        let comp_id: Option<&str> = if node.component_id.trim().is_empty() {
            None
        } else {
            Some(node.component_id.as_str())
        };
        node_insert
            .execute(params![
                node.id,
                node.dag_id,
                comp_id,
                node.label,
                node.position.x,
                node.position.y,
                config_json,
            ])
            .map_err(error_to_string)?;
    }
    drop(node_insert);

    let mut edge_insert = tx
        .prepare(
            "INSERT INTO dag_edges (id, dag_id, source_node_id, target_node_id, source_handle, \
             target_handle) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(error_to_string)?;
    for edge in &edges {
        edge_insert
            .execute(params![
                edge.id,
                edge.dag_id,
                edge.source_node_id,
                edge.target_node_id,
                edge.source_handle,
                edge.target_handle,
            ])
            .map_err(error_to_string)?;
    }
    drop(edge_insert);

    tx.commit().map_err(error_to_string)?;
    Ok(())
}

/// Physically delete a DAG and all of its descendant rows (nodes, edges,
/// executions, and execution logs). Implemented as an explicit cascade inside a
/// single transaction so the delete is guaranteed to remove every related row
/// even when the `ON DELETE CASCADE` foreign keys are not present in a given
/// database file. This is a hard delete — no soft-delete marker is used.
#[cfg_attr(feature = "gui", tauri::command)]
pub fn delete_dag(dag_id: String) -> Result<(), String> {
    // A published DAG cannot be deleted directly — it must be taken offline first.
    let detail = get_dag(dag_id.clone())?;
    if detail.status == "published" {
        return Err(
            "该 DAG 已发布，无法删除：请先在操作菜单中点「下线」将其转为草稿后再删除".to_string(),
        );
    }

    let (conn, _path) = open_sqlite_database()?;
    let tx = conn.unchecked_transaction().map_err(error_to_string)?;

    // Children first to avoid foreign-key violations when FK enforcement is on.
    tx.execute("DELETE FROM dag_nodes WHERE dag_id = ?1", params![dag_id])
        .map_err(error_to_string)?;
    tx.execute("DELETE FROM dag_edges WHERE dag_id = ?1", params![dag_id])
        .map_err(error_to_string)?;
    tx.execute(
        "DELETE FROM execution_logs WHERE execution_id IN \
         (SELECT id FROM dag_executions WHERE dag_id = ?1)",
        params![dag_id],
    )
    .map_err(error_to_string)?;
    tx.execute("DELETE FROM dag_executions WHERE dag_id = ?1", params![dag_id])
        .map_err(error_to_string)?;
    tx.execute("DELETE FROM dags WHERE id = ?1", params![dag_id])
        .map_err(error_to_string)?;

    tx.commit().map_err(error_to_string)?;
    Ok(())
}

/// Delete a single node from a DAG. Removes the node row and any edges that
/// touch it. If the node's component is not referenced by any *other* node, the
/// component row is also removed (its `component_sessions` cascade via
/// `ON DELETE CASCADE`). A component still used by another node is kept.
/// This is a hard delete — no soft-delete marker is used.
#[cfg_attr(feature = "gui", tauri::command)]
pub fn delete_dag_node(dag_id: String, node_id: String) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;

    // Capture the component id before dropping the node row.
    let component_id: String = conn
        .query_row(
            "SELECT COALESCE(component_id, '') FROM dag_nodes WHERE id = ?1",
            params![node_id],
            |row| row.get(0),
        )
        .unwrap_or_default();

    conn.execute(
        "DELETE FROM dag_edges WHERE dag_id = ?1 AND (source_node_id = ?2 OR target_node_id = ?2)",
        params![dag_id, node_id],
    )
    .map_err(error_to_string)?;
    conn.execute("DELETE FROM dag_nodes WHERE id = ?1", params![node_id])
        .map_err(error_to_string)?;

    if !component_id.trim().is_empty() {
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM dag_nodes WHERE component_id = ?1",
                params![component_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if remaining == 0 {
            conn.execute("DELETE FROM components WHERE id = ?1", params![component_id])
                .map_err(error_to_string)?;
        }
    }

    Ok(())
}

fn build_dag_graph(
    nodes: &[DagNode],
    edges: &[DagEdge],
) -> (HashMap<String, Vec<String>>, HashMap<String, usize>) {
    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
    let mut in_degree: HashMap<String, usize> = HashMap::new();
    let node_ids: HashSet<String> = nodes.iter().map(|n| n.id.clone()).collect();

    for node_id in &node_ids {
        in_degree.insert(node_id.clone(), 0);
    }

    for edge in edges {
        if node_ids.contains(&edge.source_node_id) && node_ids.contains(&edge.target_node_id) {
            adjacency
                .entry(edge.source_node_id.clone())
                .or_default()
                .push(edge.target_node_id.clone());
            *in_degree.entry(edge.target_node_id.clone()).or_default() += 1;
        }
    }

    (adjacency, in_degree)
}

fn detect_cycle(nodes: &[DagNode], edges: &[DagEdge]) -> bool {
    let (adjacency, mut in_degree) = build_dag_graph(nodes, edges);
    let mut queue: VecDeque<String> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(id, _)| id.clone())
        .collect();
    let mut processed = 0;

    while let Some(node_id) = queue.pop_front() {
        processed += 1;
        if let Some(neighbors) = adjacency.get(&node_id) {
            for neighbor in neighbors {
                if let Some(deg) = in_degree.get_mut(neighbor) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(neighbor.clone());
                    }
                }
            }
        }
    }

    processed != nodes.len()
}

fn topological_order(nodes: &[DagNode], edges: &[DagEdge]) -> Result<Vec<String>, String> {
    let (adjacency, mut in_degree) = build_dag_graph(nodes, edges);
    let mut queue: VecDeque<String> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(id, _)| id.clone())
        .collect();
    let mut order = Vec::new();

    while let Some(node_id) = queue.pop_front() {
        order.push(node_id.clone());
        if let Some(neighbors) = adjacency.get(&node_id) {
            for neighbor in neighbors {
                if let Some(deg) = in_degree.get_mut(neighbor) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(neighbor.clone());
                    }
                }
            }
        }
    }

    if order.len() != nodes.len() {
        return Err("DAG contains a cycle".to_string());
    }

    Ok(order)
}

fn validate_dag_for_publish(nodes: &[DagNode], edges: &[DagEdge]) -> Result<(), String> {
    if detect_cycle(nodes, edges) {
        return Err("DAG contains a cycle".to_string());
    }

    for node in nodes {
        // Nodes with no component reference are skipped (defensive; the drag
        // flow always creates a component, but keep the guard).
        if node.component_id.trim().is_empty() {
            continue;
        }
        let component = get_component(node.component_id.clone())?;
        // Git-backed components resolve their code from the remote repo at
        // execution time, so there are no local files to verify here. Legacy
        // local components (workspace_root set, git_url empty) are still
        // verified on disk as before.
        if !component.git_url.trim().is_empty() {
            continue;
        }
        let missing = verify_component(component.id.clone())?;
        if !missing.is_empty() {
            return Err(format!(
                "Component {} is missing required files: {}",
                component.name,
                missing.join(", ")
            ));
        }
    }

    Ok(())
}

/// Validate a standard 5-field cron expression (minute hour day-of-month month day-of-week).
/// Returns true only when all five fields are syntactically and range-valid.
fn is_valid_cron(expr: &str) -> bool {
    let expr = expr.trim();
    if expr.is_empty() {
        return false;
    }
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    // (min, max) per field: minute, hour, day-of-month, month, day-of-week (0-7, 7=Sunday).
    let ranges = [(0u32, 59u32), (0, 23), (1, 31), (1, 12), (0, 7)];
    fields
        .iter()
        .enumerate()
        .all(|(i, field)| is_valid_cron_field(field, ranges[i].0, ranges[i].1))
}

fn is_valid_cron_field(field: &str, min: u32, max: u32) -> bool {
    // A field is a comma-separated list of items; every item must be valid.
    !field.is_empty() && field.split(',').all(|item| is_valid_cron_item(item, min, max))
}

fn is_valid_cron_item(item: &str, min: u32, max: u32) -> bool {
    if item.is_empty() {
        return false;
    }
    // Optional step suffix: base/step
    let (base, step) = match item.split_once('/') {
        Some((b, s)) => {
            if !is_uint(s) {
                return false;
            }
            (b, Some(s))
        }
        None => (item, None),
    };
    // base is one of: "*", "n", or "n-m"
    let base_ok = if base == "*" {
        true
    } else if let Some((a, b)) = base.split_once('-') {
        match (a.parse::<u32>(), b.parse::<u32>()) {
            (Ok(av), Ok(bv)) => av <= bv && av >= min && bv <= max,
            _ => false,
        }
    } else {
        match base.parse::<u32>() {
            Ok(v) => v >= min && v <= max,
            _ => false,
        }
    };
    if !base_ok {
        return false;
    }
    match step {
        Some(s) => s.parse::<u32>().map(|v| v >= 1).unwrap_or(false),
        None => true,
    }
}

fn is_uint(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// Returns true when the given local time satisfies a standard 5-field cron
/// expression (`minute hour day-of-month month day-of-week`). Reuses the same
/// field grammar as `is_valid_cron` (`*`, `a-b`, `a-b/step`, `*/step`, `a,b,c`).
///
/// Day-of-month / day-of-week follow Vixie-cron OR semantics: when both are
/// restricted, the schedule matches if *either* matches. `7` and `0` both
/// denote Sunday. The expression is matched against the **server's local
/// timezone** (the timezone of the machine running this process).
pub fn cron_matches(expr: &str, now: &DateTime<Local>) -> bool {
    let fields: Vec<&str> = expr.trim().split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    let minute = now.minute();
    let hour = now.hour();
    let dom = now.day();
    let month = now.month();
    let dow = now.weekday().num_days_from_sunday() as u32; // 0=Sun..6=Sat

    let m_min = cron_field_matches(fields[0], minute);
    let m_hour = cron_field_matches(fields[1], hour);
    let m_month = cron_field_matches(fields[3], month);

    // day-of-month / day-of-week OR semantics (Vixie cron)
    let dom_wild = fields[2] == "*";
    let dow_wild = fields[4] == "*";
    let m_dom = cron_field_matches(fields[2], dom);
    let m_dow = cron_field_matches(fields[4], dow) || (dow == 0 && cron_field_matches(fields[4], 7));
    let m_day = if dom_wild && dow_wild {
        true
    } else if dom_wild {
        m_dow
    } else if dow_wild {
        m_dom
    } else {
        m_dom || m_dow
    };

    m_min && m_hour && m_month && m_day
}

/// Does a single cron field (a comma-separated list of items) contain `value`?
fn cron_field_matches(field: &str, value: u32) -> bool {
    !field.is_empty() && field.split(',').any(|item| cron_item_matches(item, value))
}

/// Does one cron item (`*`, `n`, `n-m`, `*/step`, `n-m/step`) contain `value`?
fn cron_item_matches(item: &str, value: u32) -> bool {
    let (base, step) = match item.split_once('/') {
        Some((b, s)) => (b, s.parse::<u32>().ok()),
        None => (item, None),
    };
    let step = match step {
        Some(s) if s >= 1 => s,
        Some(_) => return false,
        None => 1,
    };
    if base == "*" {
        return value % step == 0;
    }
    if let Some((a, b)) = base.split_once('-') {
        if let (Ok(av), Ok(bv)) = (a.parse::<u32>(), b.parse::<u32>()) {
            return value >= av && value <= bv && (value - av) % step == 0;
        }
        return false;
    }
    if let Ok(v) = base.parse::<u32>() {
        return value == v;
    }
    false
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn publish_dag(dag_id: String, cron: Option<String>) -> Result<Dag, String> {
    let detail = get_dag(dag_id.clone())?;

    // cron is mandatory on publish and must be well-formed.
    let cron = cron.filter(|c| !c.trim().is_empty());
    let cron = match cron {
        None => {
            return Err(
                "cron 表达式为必填：发布前请填写合法的 cron 表达式（如 */5 * * * *）".to_string(),
            )
        }
        Some(c) if is_valid_cron(&c) => c,
        Some(c) => return Err(format!("cron 表达式格式非法：{}", c.trim())),
    };

    validate_dag_for_publish(&detail.nodes, &detail.edges)?;
    let order = topological_order(&detail.nodes, &detail.edges)?;

    let (conn, _path) = open_sqlite_database()?;
    let now = chrono::Utc::now().timestamp_millis();
    let execution_order_json = serde_json::to_string(&order).map_err(error_to_string)?;
    conn.execute(
        "UPDATE dags SET status = ?2, execution_order = ?3, cron = ?4, updated_at_ms = ?5 \
         WHERE id = ?1",
        params![dag_id, "published", execution_order_json, cron, now],
    )
    .map_err(error_to_string)?;

    Ok(Dag {
        id: detail.id,
        name: detail.name,
        description: detail.description,
        status: "published".to_string(),
        execution_order: Some(Value::Array(
            order.into_iter().map(Value::String).collect(),
        )),
        cron: Some(cron.clone()),
        created_at_ms: detail.created_at_ms,
        updated_at_ms: now,
    })
}

/// Take a published DAG offline: revert its status from `published` back to `draft`.
/// Cron and execution order are preserved so it can be re-published without re-entering them.
#[cfg_attr(feature = "gui", tauri::command)]
pub fn unpublish_dag(dag_id: String) -> Result<Dag, String> {
    let detail = get_dag(dag_id.clone())?;
    let (conn, _path) = open_sqlite_database()?;
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE dags SET status = ?2, updated_at_ms = ?3 WHERE id = ?1",
        params![dag_id, "draft", now],
    )
    .map_err(error_to_string)?;

    Ok(Dag {
        id: detail.id,
        name: detail.name,
        description: detail.description,
        status: "draft".to_string(),
        execution_order: detail.execution_order,
        cron: detail.cron,
        created_at_ms: detail.created_at_ms,
        updated_at_ms: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, dag_id: &str, component_id: &str) -> DagNode {
        DagNode {
            id: id.to_string(),
            dag_id: dag_id.to_string(),
            component_id: component_id.to_string(),
            label: id.to_string(),
            position: DagNodePosition { x: 0.0, y: 0.0 },
            config: json!({}),
        }
    }

    fn edge(id: &str, dag_id: &str, src: &str, tgt: &str) -> DagEdge {
        DagEdge {
            id: id.to_string(),
            dag_id: dag_id.to_string(),
            source_node_id: src.to_string(),
            target_node_id: tgt.to_string(),
            source_handle: "output".to_string(),
            target_handle: "input".to_string(),
        }
    }

    #[test]
    fn test_is_valid_cron() {
        // valid
        assert!(is_valid_cron("*/5 * * * *"));
        assert!(is_valid_cron("0 0 * * *"));
        assert!(is_valid_cron("5,10,15 * * * *"));
        assert!(is_valid_cron("0-30 9-17 * * 1-5"));
        assert!(is_valid_cron("0 0 1 1 0"));
        assert!(is_valid_cron("0 0 1 1 7")); // dow 7 = Sunday
        // invalid: empty / wrong field count
        assert!(!is_valid_cron(""));
        assert!(!is_valid_cron("   "));
        assert!(!is_valid_cron("* * * *")); // 4 fields
        assert!(!is_valid_cron("* * * * * *")); // 6 fields
        // invalid: out of range
        assert!(!is_valid_cron("60 * * * *")); // minute > 59
        assert!(!is_valid_cron("* 24 * * *")); // hour > 23
        assert!(!is_valid_cron("* * 0 * *")); // dom < 1
        assert!(!is_valid_cron("* * * 13 *")); // month > 12
        // invalid: bad characters / step
        assert!(!is_valid_cron("abc * * * *"));
        assert!(!is_valid_cron("*/0 * * * *")); // step must be >= 1
        assert!(!is_valid_cron("5-1 * * * *")); // reversed range
    }

    #[test]
    fn test_topological_order_linear_chain() {
        let nodes = vec![
            node("a", "d", "c1"),
            node("b", "d", "c2"),
            node("c", "d", "c3"),
        ];
        let edges = vec![
            edge("e1", "d", "a", "b"),
            edge("e2", "d", "b", "c"),
        ];
        let order = topological_order(&nodes, &edges).unwrap();
        assert_eq!(order, vec!["a", "b", "c"]);
        assert!(!detect_cycle(&nodes, &edges));
    }

    #[test]
    fn test_topological_order_diamond() {
        // a -> b, a -> c, b -> d, c -> d
        let nodes = vec![
            node("a", "d", "c1"),
            node("b", "d", "c2"),
            node("c", "d", "c3"),
            node("d", "d", "c4"),
        ];
        let edges = vec![
            edge("e1", "d", "a", "b"),
            edge("e2", "d", "a", "c"),
            edge("e3", "d", "b", "d"),
            edge("e4", "d", "c", "d"),
        ];
        let order = topological_order(&nodes, &edges).unwrap();
        // a must come first, d must come last
        assert_eq!(order[0], "a");
        assert_eq!(*order.last().unwrap(), "d");
        // b and c after a, before d
        let a_pos = order.iter().position(|n| n == "a").unwrap();
        let b_pos = order.iter().position(|n| n == "b").unwrap();
        let c_pos = order.iter().position(|n| n == "c").unwrap();
        let d_pos = order.iter().position(|n| n == "d").unwrap();
        assert!(a_pos < b_pos && a_pos < c_pos);
        assert!(b_pos < d_pos && c_pos < d_pos);
    }

    #[test]
    fn test_cycle_detection() {
        let nodes = vec![node("a", "d", "c1"), node("b", "d", "c2")];
        let edges = vec![edge("e1", "d", "a", "b"), edge("e2", "d", "b", "a")];
        assert!(detect_cycle(&nodes, &edges));
        assert!(topological_order(&nodes, &edges).is_err());
    }
}

#[cfg(test)]
mod cron_match_tests {
    use super::*;
    use chrono::TimeZone;

    // 2026-07-13 is a Monday, so weekdays are easy to reason about here.
    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).single().unwrap()
    }

    #[test]
    fn weekday_schedule_fires_on_weekday() {
        // Mon 2026-07-13 18:05 -> fires
        assert!(cron_matches("5 18 * * 1-5", &at(2026, 7, 13, 18, 5)));
    }

    #[test]
    fn weekday_schedule_skips_saturday() {
        // Sat 2026-07-18 18:05 -> no fire
        assert!(!cron_matches("5 18 * * 1-5", &at(2026, 7, 18, 18, 5)));
    }

    #[test]
    fn weekday_schedule_skips_off_minute() {
        // Mon 2026-07-13 18:06 -> no fire (minute mismatch)
        assert!(!cron_matches("5 18 * * 1-5", &at(2026, 7, 13, 18, 6)));
    }

    #[test]
    fn weekday_schedule_skips_off_hour() {
        // Mon 2026-07-13 09:05 -> no fire (hour mismatch)
        assert!(!cron_matches("5 18 * * 1-5", &at(2026, 7, 13, 9, 5)));
    }

    #[test]
    fn every_minute_fires() {
        assert!(cron_matches("* * * * *", &at(2026, 7, 13, 3, 7)));
        assert!(cron_matches("*/1 * * * *", &at(2026, 7, 13, 3, 7)));
    }

    #[test]
    fn step_minute() {
        // every 15 minutes: 0,15,30,45
        assert!(cron_matches("*/15 * * * *", &at(2026, 7, 13, 0, 30)));
        assert!(!cron_matches("*/15 * * * *", &at(2026, 7, 13, 0, 31)));
    }

    #[test]
    fn sunday_as_0_and_7() {
        // Sun 2026-07-19
        assert!(cron_matches("0 0 * * 0", &at(2026, 7, 19, 0, 0)));
        assert!(cron_matches("0 0 * * 7", &at(2026, 7, 19, 0, 0)));
    }

    #[test]
    fn dom_dow_or_semantics() {
        // dom=13 (Mon) restricted, dow=*  -> fires on the 13th regardless of weekday
        assert!(cron_matches("0 0 13 * *", &at(2026, 7, 13, 0, 0)));
        // dom=13, dow=5 (Fri) -> 2026-07-13 is Mon, but dom matches so fires (OR)
        assert!(cron_matches("0 0 13 * 5", &at(2026, 7, 13, 0, 0)));
    }
}
