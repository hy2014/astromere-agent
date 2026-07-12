//! End-to-end integration test for the DAG / component platform.
//!
//! Run with:
//!     cargo test --no-default-features --test integration
//!
//! The test points `$HOME` at a temporary directory so it never touches the
//! real `~/.agent-ui` database, and exercises the public command functions
//! (which are plain `pub fn`s when built without the `gui` feature).

use claw_agent_ui::components;
use claw_agent_ui::dag;
use claw_agent_ui::scheduler;
use claw_agent_ui::types::{Component, DagEdge, DagNode, DagNodePosition};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Point $HOME at a fresh temp dir and return its path.
fn setup_home() -> PathBuf {
    let dir = tempfile::tempdir().unwrap().keep();
    std::env::set_var("HOME", &dir);
    dir
}

/// Ensures the spawned worker process is killed when dropped.
struct WorkerGuard(Child);
impl Drop for WorkerGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn python3() -> String {
    // Prefer the managed interpreter; fall back to whatever is on PATH.
    if let Ok(p) = std::env::var("PYTHON3") {
        return p;
    }
    if let Ok(home) = std::env::var("HOME") {
        let managed = std::path::Path::new(&home)
            .join(".workbuddy")
            .join("binaries")
            .join("python")
            .join("versions")
            .join("3.13.12")
            .join("bin")
            .join("python3");
        if managed.exists() {
            return managed.to_string_lossy().into_owned();
        }
    }
    "python3".to_string()
}

/// Create a component whose root lives under `<root>/comp/<id>/` (shared
/// workspace `<root>/comp`). Writes the four required files.
fn make_component(id: &str, name: &str, root: &PathBuf) -> Component {
    let workspace = root.join("comp");
    let comp_root = workspace.join(id);
    fs::create_dir_all(&comp_root).unwrap();
    let comp_src = comp_root.join("src");
    fs::create_dir_all(&comp_src).unwrap();

    let main_py = r#"
import os, json, sys
inp = {}
p = os.environ.get("AGENT_UI_INPUT_PATH")
if p and os.path.exists(p):
    with open(p) as f:
        inp = json.load(f)
out = {"ok": True, "node": os.environ.get("AGENT_UI_NODE_ID"), "echo": inp}
with open(os.environ["AGENT_UI_OUTPUT_PATH"], "w") as f:
    json.dump(out, f)
print("ran", file=sys.stdout)
"#;
    fs::write(comp_src.join("main.py"), main_py).unwrap();
    fs::write(comp_src.join("requirements.txt"), "").unwrap();
    fs::write(comp_src.join("SKILL.md"), "# skill").unwrap();

    Component {
        id: id.to_string(),
        name: name.to_string(),
        description: format!("desc {name}"),
        status: "draft".to_string(),
        workspace_root: workspace.to_string_lossy().to_string(),
        git_url: comp_root.to_string_lossy().to_string(),
        git_branch: "master".to_string(),
        git_ref: String::new(),
        entry_point: comp_src.join("main.py").to_string_lossy().to_string(),
        input_schema: json!({"type": "object", "properties": {}}),
        output_schema: json!({"type": "object", "properties": {}}),
        config_schema: json!([]),
        tags: vec![],
        global: false,
        created_at_ms: now(),
        updated_at_ms: now(),
    }
}

#[test]
fn test_full_dag_flow() {
    let root = setup_home();

    // 1. Create two components sharing one workspace.
    let c1 = make_component("c1", "Fetch", &root);
    let c2 = make_component("c2", "Email", &root);
    components::insert_component(&c1).unwrap();
    components::insert_component(&c2).unwrap();

    // 2. Listing returns both.
    let all = components::list_components().unwrap();
    assert_eq!(all.len(), 2, "expected two components");

    // 3. verify_component passes when all required files exist.
    let missing = components::verify_component("c1".to_string()).unwrap();
    assert!(missing.is_empty(), "c1 should be complete, got {missing:?}");

    // 4. verify_component reports a missing file.
    let comp2_root = PathBuf::from(&c2.entry_point).parent().unwrap().to_path_buf();
    fs::remove_file(comp2_root.join("SKILL.md")).unwrap();
    let missing2 = components::verify_component("c2".to_string()).unwrap();
    assert!(
        missing2.contains(&"SKILL.md".to_string()),
        "expected SKILL.md in missing list, got {missing2:?}"
    );
    // restore so publish can succeed
    fs::write(comp2_root.join("SKILL.md"), "# skill").unwrap();

    // 5. Create a DAG and wire nodes: n1 (c1) -> n2 (c2).
    let dag_model = dag::create_dag("Test DAG".to_string()).unwrap();
    let dag_id = dag_model.id.clone();

    let nodes = vec![
        DagNode {
            id: "n1".to_string(),
            dag_id: dag_id.clone(),
            component_id: "c1".to_string(),
            label: "Fetch".to_string(),
            position: DagNodePosition { x: 0.0, y: 0.0 },
            config: json!({}),
        },
        DagNode {
            id: "n2".to_string(),
            dag_id: dag_id.clone(),
            component_id: "c2".to_string(),
            label: "Email".to_string(),
            position: DagNodePosition { x: 200.0, y: 0.0 },
            config: json!({}),
        },
    ];
    let edges = vec![DagEdge {
        id: "e1".to_string(),
        dag_id: dag_id.clone(),
        source_node_id: "n1".to_string(),
        target_node_id: "n2".to_string(),
        source_handle: "output".to_string(),
        target_handle: "input".to_string(),
    }];

    dag::update_dag(dag_model, nodes, edges).unwrap();

    // 6. Publish performs topological sort, stores the cron expression, and writes execution_order.
    let published = dag::publish_dag(dag_id.clone(), Some("*/5 * * * *".to_string())).unwrap();
    assert_eq!(published.status, "published");
    assert_eq!(published.cron.as_deref(), Some("*/5 * * * *"));
    let order = published
        .execution_order
        .expect("execution_order should be set")
        .as_array()
        .expect("execution_order should be an array")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(order, vec!["n1", "n2"], "topological order wrong");

    // 7. Run the DAG through the real engine: `run_dag` only enqueues a
    //    `submit` row; the Python `worker.py` (the sole execution engine)
    //    polls, claims, and executes it.
    let db_path = root.join(".agent-ui").join("sqlite").join("agent-ui.db");
    let cache_root = root.join("engine-cache");
    let worker_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("engine_executor")
        .join("worker.py");
    assert!(
        worker_path.exists(),
        "engine_executor/worker.py not found at {:?}",
        worker_path
    );
    let worker = Command::new(python3())
        .arg(&worker_path)
        .env("AGENT_UI_DB_PATH", &db_path)
        .env("ENGINE_EXECUTOR_CACHE_ROOT", &cache_root)
        .env("ENGINE_EXECUTOR_POLL_INTERVAL", "0.2")
        .env("ENGINE_EXECUTOR_WORKER_ID", "test-worker")
        .env("ENGINE_EXECUTOR_CANCEL_POLL", "0.1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn engine_executor worker");
    let _guard = WorkerGuard(worker);
    // Give the worker time to ensure schema and start polling.
    std::thread::sleep(Duration::from_secs(1));

    let execution = scheduler::run_dag(dag_id.clone()).unwrap();
    assert_eq!(execution.status, "submit", "run_dag must only enqueue");
    let exec_id = execution.id.clone();

    // Poll until the whole execution reaches a terminal state.
    let start = Instant::now();
    let mut final_status = String::new();
    loop {
        let ex = scheduler::get_execution(exec_id.clone()).unwrap();
        final_status = ex.status.clone();
        if matches!(final_status.as_str(), "success" | "failed" | "cancelled") {
            break;
        }
        if start.elapsed() > Duration::from_secs(30) {
            panic!("execution did not finish within 30s (last status: {final_status})");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    assert_eq!(final_status, "success", "dag run should succeed");
    let outputs = scheduler::get_execution(exec_id.clone())
        .unwrap()
        .outputs
        .expect("outputs should exist")
        .as_object()
        .unwrap()
        .clone();
    assert!(outputs.contains_key("n1"), "n1 output missing");
    assert!(outputs.contains_key("n2"), "n2 output missing");

    // 8. Execution logs were recorded.
    let logs = scheduler::get_execution_logs(execution.id.clone()).unwrap();
    assert!(!logs.is_empty(), "expected execution logs");

    // 9. Persistence: a fresh read of the dag still shows published state
    //    (this would fail with the old drop-on-open bug).
    let reread = dag::get_dag(dag_id.clone()).unwrap();
    assert_eq!(reread.status, "published");
    assert_eq!(reread.nodes.len(), 2);

    // 9.5 A published DAG cannot be deleted directly — must go offline first.
    let del_published = dag::delete_dag(dag_id.clone());
    assert!(del_published.is_err(), "deleting a published DAG must be rejected");
    assert!(
        del_published.unwrap_err().contains("下线"),
        "error should mention going offline (下线) first"
    );

    // 10. Unpublish reverts status to draft while preserving cron; can be re-published later.
    let unpublished = dag::unpublish_dag(dag_id.clone()).unwrap();
    assert_eq!(unpublished.status, "draft");
    assert_eq!(unpublished.cron.as_deref(), Some("*/5 * * * *"));
    let reread2 = dag::get_dag(dag_id.clone()).unwrap();
    assert_eq!(reread2.status, "draft");

    // cleanup
    dag::delete_dag(dag_id).unwrap();
    components::delete_component("c1".to_string()).unwrap();
    components::delete_component("c2".to_string()).unwrap();
}

#[test]
fn test_publish_rejects_cycle() {
    let root = setup_home();

    let c1 = make_component("c1", "A", &root);
    let c2 = make_component("c2", "B", &root);
    components::insert_component(&c1).unwrap();
    components::insert_component(&c2).unwrap();

    let dag_model = dag::create_dag("Cycle DAG".to_string()).unwrap();
    let dag_id = dag_model.id.clone();
    let nodes = vec![
        DagNode {
            id: "n1".to_string(),
            dag_id: dag_id.clone(),
            component_id: "c1".to_string(),
            label: "A".to_string(),
            position: DagNodePosition { x: 0.0, y: 0.0 },
            config: json!({}),
        },
        DagNode {
            id: "n2".to_string(),
            dag_id: dag_id.clone(),
            component_id: "c2".to_string(),
            label: "B".to_string(),
            position: DagNodePosition { x: 0.0, y: 0.0 },
            config: json!({}),
        },
    ];
    // cycle: n1 -> n2 -> n1
    let edges = vec![
        DagEdge {
            id: "e1".to_string(),
            dag_id: dag_id.clone(),
            source_node_id: "n1".to_string(),
            target_node_id: "n2".to_string(),
            source_handle: "output".to_string(),
            target_handle: "input".to_string(),
        },
        DagEdge {
            id: "e2".to_string(),
            dag_id: dag_id.clone(),
            source_node_id: "n2".to_string(),
            target_node_id: "n1".to_string(),
            source_handle: "output".to_string(),
            target_handle: "input".to_string(),
        },
    ];
    dag::update_dag(dag_model, nodes, edges).unwrap();
    let result = dag::publish_dag(dag_id.clone(), None);
    assert!(result.is_err(), "cycle should be rejected on publish");

    dag::delete_dag(dag_id).unwrap();
    components::delete_component("c1".to_string()).unwrap();
    components::delete_component("c2".to_string()).unwrap();
}
