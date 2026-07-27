//! Auto-start and supervise the Python execution engine (`engine_executor/worker.py`).
//!
//! `run_dag` only enqueues a `submit` row into `dag_executions`; the actual execution
//! is performed by the standalone long-running `worker.py` process that polls the queue.
//! This module ensures the worker is launched when the app starts and kept alive (restart
//! on crash) for the app's lifetime, and is reaped on exit.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// The currently supervised worker child process, if any.
static WORKER_CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// Set when the app is shutting down; the supervisor stops respawning workers.
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// Resolve the path to `engine_executor/worker.py`.
///
/// Priority: `$AGENT_UI_WORKER_PATH` env var → walk up from the current executable's
/// directory looking for `engine_executor/worker.py` (dev layout:
/// `apps/agent-ui/engine_executor/worker.py`).
fn resolve_worker_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AGENT_UI_WORKER_PATH") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
        eprintln!(
            "[engine] AGENT_UI_WORKER_PATH set but not found: {}",
            pb.display()
        );
    }

    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?;
    for _ in 0..6 {
        let candidate = dir.join("engine_executor").join("worker.py");
        if candidate.exists() {
            return Some(candidate);
        }
        let candidate2 = dir
            .join("apps")
            .join("agent-ui")
            .join("engine_executor")
            .join("worker.py");
        if candidate2.exists() {
            return Some(candidate2);
        }
        dir = dir.parent()?;
    }
    None
}

/// Python interpreter to run the worker with.
fn python_bin() -> String {
    std::env::var("AGENT_UI_PYTHON").unwrap_or_else(|_| "python3".to_string())
}

/// Make sure `AGENT_UI_DB_PATH` is set so the worker reads/writes the same SQLite DB
/// as the Rust app (sqlite.rs honors the same env var / default).
fn ensure_db_path_env(cmd: &mut Command) {
    if std::env::var("AGENT_UI_DB_PATH").is_err() {
        if let Ok(home) = std::env::var("HOME") {
            let default = PathBuf::from(home)
                .join(".agent-ui")
                .join("sqlite")
                .join("agent-ui.db");
            if let Some(p) = default.to_str() {
                cmd.env("AGENT_UI_DB_PATH", p);
            }
        }
    }
}

/// Make sure `AGENT_UI_LOG_DIR` is set so the worker writes component logs to
/// the exact directory the HTTP server serves them from (`log_dir()`). Without
/// this the two sides could resolve different `~/.agent-ui/logs` paths (e.g. if
/// `AGENT_UI_HOME` is overridden), and the file-log endpoint would 404.
fn ensure_log_dir_env(cmd: &mut Command) {
    if std::env::var("AGENT_UI_LOG_DIR").is_err() {
        let dir = crate::dag_server_config::log_dir();
        if let Some(p) = dir.to_str() {
            cmd.env("AGENT_UI_LOG_DIR", p);
        }
    }
}

/// Spawn the worker process.
fn spawn_worker() -> std::io::Result<Child> {
    let worker =
        resolve_worker_path().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "engine_executor/worker.py not found")
        })?;
    let work_dir = worker
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let mut cmd = Command::new(python_bin());
    cmd.arg(&worker)
        .current_dir(&work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    ensure_db_path_env(&mut cmd);
    ensure_log_dir_env(&mut cmd);
    cmd.spawn()
}

/// Spawn the worker and store the child handle for supervision / cleanup.
fn spawn_and_store() -> std::io::Result<()> {
    let child = spawn_worker()?;
    eprintln!("[engine] worker spawned pid={}", child.id());
    *WORKER_CHILD.lock().unwrap() = Some(child);
    Ok(())
}

/// Launch the supervisor thread: keep a worker running for the app's lifetime.
///
/// The worker is a long-running poll loop; if it exits for any reason we restart it
/// after a short backoff. `try_wait()` (non-blocking) is used so the global child
/// handle stays reachable for `stop_worker()` on exit.
pub fn start_worker_supervisor() {
    std::thread::spawn(|| {
        if let Err(e) = spawn_and_store() {
            eprintln!("[engine] initial worker spawn failed: {e}; will retry");
        }
        loop {
            if SHUTDOWN.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
            if SHUTDOWN.load(Ordering::SeqCst) {
                break;
            }
            let should_respawn = {
                let mut guard = WORKER_CHILD.lock().unwrap();
                let exited = match guard.as_mut() {
                    Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                    None => true,
                };
                if exited {
                    *guard = None;
                }
                exited
            };
            if should_respawn && !SHUTDOWN.load(Ordering::SeqCst) {
                if let Err(e) = spawn_and_store() {
                    eprintln!("[engine] worker respawn failed: {e}; retrying");
                }
            }
        }
    });
}

/// Kill the supervised worker (called on app exit).
pub fn stop_worker() {
    SHUTDOWN.store(true, Ordering::SeqCst);
    if let Some(mut child) = WORKER_CHILD.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Arm a SIGTERM listener (Unix) that performs a graceful shutdown: stop the
/// supervised worker, then exit the process.
///
/// The default disposition of SIGTERM on Unix is to terminate the process
/// immediately, which would leave the `worker.py` child orphaned — and, across
/// restarts, let stale-code workers compete for the queue. Installing this
/// handler lets `kill -TERM` (e.g. from `restart_remote_server.sh` or systemd)
/// clean up the worker before the process goes away. SIGKILL cannot be caught;
/// for that, the restart script's global `pkill -f engine_executor/worker.py`
/// is the backstop.
#[cfg(unix)]
pub fn install_termination_handler() {
    std::thread::spawn(|| {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[engine] failed to build signal runtime: {e}");
                return;
            }
        };
        rt.block_on(async {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = match signal(SignalKind::terminate()) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[engine] failed to install SIGTERM handler: {e}");
                    return;
                }
            };
            let _ = sigterm.recv().await;
            eprintln!("[engine] SIGTERM received, shutting down worker");
            stop_worker();
            // Grace period for the supervisor loop to observe SHUTDOWN.
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::process::exit(0);
        });
    });
}

#[cfg(not(unix))]
pub fn install_termination_handler() {}
