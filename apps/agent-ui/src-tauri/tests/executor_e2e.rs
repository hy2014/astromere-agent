//! End-to-end test for the Python execution engine (`engine_executor/`).
//!
//! This exercises the full producer → consumer flow:
//!
//!   1. Rust `scheduler::run_dag` only *enqueues* a `dag_executions` row with
//!      status `submit` (producer, MySQL-style broker via SQLite).
//!   2. The Python `engine_executor/worker.py` polls, atomically claims the job,
//!      drives each node through preparing → running → success, writes
//!      `node_executions` + `execution_logs`, and finally marks the whole
//!      `dag_executions` row `success`.
//!
//! Run with:
//!     cargo test --no-default-features --test executor_e2e -- --test-threads=1
//!
//! The test points `$HOME` at a temporary directory so it never touches the
//! real `~/.agent-ui` database. A local "helloworld" component is registered
//! as a proper `components` row (git source in the table, the config
//! truth-source), so no git clone is needed — the worker resolves it from the
//! component's local `git_url`. `node.config` carries only instance params.

use claw_agent_ui::components;
use claw_agent_ui::dag;
use claw_agent_ui::scheduler;
use claw_agent_ui::types::{
    Component, DagEdge, DagNode, DagNodePosition,
};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Once;
use std::time::{Duration, Instant};

static INIT_HOME: Once = Once::new();

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Point $HOME at a fresh temp dir (process-global; tests run single-threaded).
fn setup_home() -> PathBuf {
    INIT_HOME.call_once(|| {
        let dir = tempfile::tempdir().unwrap().keep();
        std::env::set_var("HOME", &dir);
    });
    PathBuf::from(std::env::var("HOME").unwrap())
}

/// Create a local "helloworld" component under `<root>/helloworld/`.
///
/// `run.py` reads the input JSON, copies `text`, and adds a `helloworld`
/// column so the test can verify the output was transformed correctly.
fn make_helloworld(root: &PathBuf) -> PathBuf {
    let comp_root = root.join("helloworld");
    fs::create_dir_all(&comp_root).unwrap();
    let run_py = r#"
import os, json
inp = {}
p = os.environ.get("AGENT_UI_INPUT_PATH")
if p and os.path.exists(p):
    with open(p) as f:
        inp = json.load(f)
text = inp.get("text", "")
out = {"text": text, "helloworld": f"{text}-helloworld"}
with open(os.environ["AGENT_UI_OUTPUT_PATH"], "w") as f:
    json.dump(out, f)
print("helloworld component ran", flush=True)
"#;
    fs::write(comp_root.join("run.py"), run_py).unwrap();
    // Empty requirements.txt => the worker uses the system python3 (no venv).
    fs::write(comp_root.join("requirements.txt"), "").unwrap();
    comp_root
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

#[test]
fn test_executor_runs_generic_node_end_to_end() {
    let root = setup_home();
    let db_path = root.join(".agent-ui").join("sqlite").join("agent-ui.db");
    let cache_root = root.join("engine-cache");

    // 1. Build a DAG with a single node backed by the local helloworld
    //    component. The component's git source lives in the `components` table
    //    (the config truth-source); `node.config` carries ONLY instance params.
    let comp_root = make_helloworld(&root);
    let dag_model = dag::create_dag("Hello DAG".to_string()).unwrap();
    let dag_id = dag_model.id.clone();

    let component = Component {
        id: "helloworld-comp".to_string(),
        name: "helloworld".to_string(),
        description: String::new(),
        status: "draft".to_string(),
        workspace_root: String::new(),
        git_url: comp_root.to_string_lossy().to_string(),
        git_branch: "master".to_string(),
        git_ref: String::new(),
        entry_point: "run.py".to_string(),
        input_schema: json!({"type": "object", "properties": {}}),
        output_schema: json!({"type": "object", "properties": {}}),
        config_schema: json!([]),
        tags: vec![],
        global: false,
        created_at_ms: 0,
        updated_at_ms: 0,
    };
    components::insert_component(&component).unwrap();

    let nodes = vec![DagNode {
        id: "n1".to_string(),
        dag_id: dag_id.clone(),
        component_id: component.id.clone(),
        label: "Hello".to_string(),
        position: DagNodePosition { x: 0.0, y: 0.0 },
        config: json!({ "params": {"text": "hello"} }),
    }];
    let edges: Vec<DagEdge> = vec![];
    dag::update_dag(dag_model, nodes, edges).unwrap();

    // 2. Publish (computes execution_order, stores cron). Cron is mandatory.
    let published = dag::publish_dag(dag_id.clone(), Some("*/5 * * * *".to_string())).unwrap();
    assert_eq!(published.status, "published");

    // 3. Spawn the Python execution engine, pointed at the same SQLite DB.
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
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("failed to spawn engine_executor worker");
    let _guard = WorkerGuard(worker);

    // Give the worker time to run ensure_executor_schema() and start polling.
    std::thread::sleep(Duration::from_secs(1));

    // 4. Submit the run (producer). This only inserts a `submit` row.
    let execution = scheduler::run_dag(dag_id.clone()).unwrap();
    assert_eq!(execution.status, "submit", "run_dag must only enqueue");
    let exec_id = execution.id.clone();

    // 5. Poll until the whole execution reaches a terminal state.
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
    assert_eq!(final_status, "success", "the generic node should run to success");

    // 6. The node-level state machine must be recorded (Approach B).
    let node_execs = scheduler::get_node_executions(exec_id.clone()).unwrap();
    assert_eq!(node_execs.len(), 1, "one node => one node_executions row");
    let ne = &node_execs[0];
    assert_eq!(ne.node_id, "n1");
    assert_eq!(ne.status, "success");
    assert!(ne.started_at_ms.is_some(), "node should record started_at_ms");
    assert!(ne.completed_at_ms.is_some(), "node should record completed_at_ms");

    // 7. Output correctness: the helloworld column must be present and correct.
    let ex = scheduler::get_execution(exec_id.clone()).unwrap();
    let outputs = ex
        .outputs
        .expect("dag_executions.outputs should exist")
        .as_object()
        .unwrap()
        .clone();
    let node_out = outputs
        .get("n1")
        .expect("n1 output missing")
        .as_object()
        .unwrap();
    assert_eq!(
        node_out.get("text").and_then(|v| v.as_str()),
        Some("hello"),
        "input text should echo through"
    );
    assert_eq!(
        node_out.get("helloworld").and_then(|v| v.as_str()),
        Some("hello-helloworld"),
        "helloworld column should be added with the transformed value"
    );

    // 8. Cross-check the physical output file on disk.
    let out_path = ne
        .output_path
        .clone()
        .expect("node_executions.output_path should be set");
    let raw = fs::read_to_string(&out_path).unwrap_or_else(|e| panic!("read {out_path}: {e}"));
    let disk: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        disk.get("helloworld").and_then(|v| v.as_str()),
        Some("hello-helloworld")
    );

    // 9. Logs must capture the full preparing -> running -> success flow.
    let logs = scheduler::get_execution_logs(exec_id.clone()).unwrap();
    assert!(!logs.is_empty(), "execution logs must be recorded");
    let combined = logs
        .iter()
        .map(|l| format!("{}:{}", l.level, l.message))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        combined.contains("Preparing environment for node n1"),
        "expected 'preparing' log:\n{combined}"
    );
    assert!(
        combined.contains("Running node n1"),
        "expected 'running' log:\n{combined}"
    );
    assert!(
        combined.contains("Node succeeded"),
        "expected 'success' log:\n{combined}"
    );

    // cleanup
    let _ = dag::delete_dag(dag_id);
}
