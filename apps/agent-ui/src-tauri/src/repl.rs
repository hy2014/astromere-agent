use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

use crate::types::{
    AgentReplProcessState, AgentReplProcessStatus, ClawProcess,
    SessionReadyRegistry,
};
use crate::utils::{
    canonical_workspace_root, claude_project_sessions_dir, error_to_string,
    process_key, repo_root,
};
use crate::models::{active_model_config, apply_agent_ui_env, apply_model_env, default_model_settings, load_model_settings, resolve_model_for_provider};
use crate::mcp::astromere_mcp_config_path;
use crate::control::{
    remember_control_response, capabilities_from_control_response,
    shared_session_id, set_shared_session_id, stream_value_session_id,
    wait_for_fork_session_id, remember_fork_session_hint,
};

// ── Global state ──

static CLAW_PROCESSES: OnceLock<Mutex<HashMap<String, ClawProcess>>> = OnceLock::new();
static SESSION_READY: OnceLock<SessionReadyRegistry> = OnceLock::new();

pub fn claw_processes() -> Result<std::sync::MutexGuard<'static, HashMap<String, ClawProcess>>, String> {
    CLAW_PROCESSES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|e| format!("claw_processes lock: {e}"))
}

pub fn claw_processes_mut() -> Result<std::sync::MutexGuard<'static, HashMap<String, ClawProcess>>, String> {
    CLAW_PROCESSES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|e| format!("claw_processes lock: {e}"))
}

fn session_ready_registry() -> &'static SessionReadyRegistry {
    SESSION_READY.get_or_init(|| SessionReadyRegistry {
        sessions: Mutex::new(HashMap::new()),
        condvar: Condvar::new(),
    })
}

// ── Session ready helpers ──

fn session_ready_key(root: &str, session_id: &str) -> String {
    format!("{}::{}", root, session_id)
}

pub fn clear_session_ready(root: &str, session_id: &str) {
    let registry = session_ready_registry();
    let mut sessions = registry.sessions.lock().unwrap();
    sessions.remove(&session_ready_key(root, session_id));
}

pub fn mark_session_ready(root: &str, session_id: &str) {
    let registry = session_ready_registry();
    let mut sessions = registry.sessions.lock().unwrap();
    sessions.insert(session_ready_key(root, session_id), true);
    registry.condvar.notify_all();
}

fn wait_for_session_ready(root: &str, session_id: &str, timeout: Duration) -> Result<(), String> {
    let registry = session_ready_registry();
    let mut sessions = registry.sessions.lock().unwrap();
    let key = session_ready_key(root, session_id);

    if sessions.get(&key).copied().unwrap_or(false) {
        return Ok(());
    }

    let result = registry
        .condvar
        .wait_timeout_while(sessions, timeout, |s| !s.get(&key).copied().unwrap_or(false));

    match result {
        Ok((_, timeout_result)) => {
            if timeout_result.timed_out() {
                Err("timed out waiting for session to be ready".to_string())
            } else {
                Ok(())
            }
        }
        Err(e) => Err(format!("wait interrupted: {e}")),
    }
}

// ── Process helpers ──

fn is_existing_claude_session_id(session_id: &str) -> bool {
    session_id.len() == 36 && session_id.chars().filter(|&c| c == '-').count() == 4
}

fn claude_session_file_exists(root_path: &Path, session_id: &str) -> bool {
    if !is_existing_claude_session_id(session_id) {
        return false;
    }
    if let Ok(sessions_dir) = claude_project_sessions_dir(root_path) {
        return sessions_dir.join(format!("{session_id}.jsonl")).is_file();
    }
    false
}

fn rekey_process_session(root: &str, old_session_id: &str, new_session_id: &str) -> Option<u32> {
    let mut map = CLAW_PROCESSES.get()?.lock().ok()?;
    let old_key = process_key(root, old_session_id);
    let proc = map.remove(&old_key)?;
    let pid = proc.pid;
    let new_key = process_key(root, new_session_id);
    map.insert(new_key, proc);
    Some(pid)
}

fn poll_fork_wait_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if start.elapsed() > timeout {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return false,
        }
    }
}

fn fork_debug(message: impl AsRef<str>) {
    eprintln!("[agent-ui][fork] {}", message.as_ref());
}

fn emit_process_status(
    app: &tauri::AppHandle,
    root: &str,
    session_id: &str,
    running: bool,
    pid: Option<u32>,
    reason: &str,
) {
    let _ = app.emit(
        "agent-repl-process-status",
        json!({
            "sessionId": session_id,
            "root": root,
            "running": running,
            "pid": pid,
            "reason": reason,
        }),
    );
}

// ── Stdout reader ──

fn spawn_repl_stdout_reader(
    stdout: std::process::ChildStdout,
    app: tauri::AppHandle,
    root: &str,
    session_id: &str,
    shared_session: &Arc<Mutex<String>>,
) {
    let root = root.to_string();
    let session_id = session_id.to_string();
    let shared_session = shared_session.clone();
    let mut reader = BufReader::new(stdout);
    let mut line_buffer = String::new();

    loop {
        line_buffer.clear();
        match reader.read_line(&mut line_buffer) {
            Ok(0) => {
                fork_debug("stdout reader EOF");
                break;
            }
            Ok(_) => {}
            Err(e) => {
                fork_debug(format!("stdout reader error: {e}"));
                break;
            }
        }

        let line = line_buffer.trim();
        if line.is_empty() {
            continue;
        }

        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                fork_debug(format!("stdout reader json error: {e} line={}", crate::utils::truncate_for_log(line, 200)));
                continue;
            }
        };

        let event_type = value
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let current_session = shared_session_id(&shared_session);
        let event_session_id = stream_value_session_id(&value).unwrap_or_else(|| session_id.clone());

        let effective_session_id = if event_type == "session_id" {
            let new_session_id = value
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or(&event_session_id);
            if new_session_id != &current_session {
                fork_debug(format!(
                    "process changed session: {} -> {}",
                    current_session, new_session_id
                ));
                set_shared_session_id(&shared_session, new_session_id);
                rekey_process_session(&root, &current_session, new_session_id);
            }
            new_session_id.to_string()
        } else {
            event_session_id
        };

        // Handle control responses
        if event_type == "response" || event_type == "control" || event_type == "permission" {
            remember_control_response(&value);
        }

        // Handle session_ready
        if event_type == "session_ready" {
            mark_session_ready(&root, &effective_session_id);
        }

        // Handle capabilities updates
        if event_type == "capabilities" {
            if let Some(_caps) = capabilities_from_control_response(&value, &root, &effective_session_id) {
                let _ = app.emit(
                    "agent-repl-event",
                    json!({
                        "sessionId": effective_session_id,
                        "root": root,
                        "eventType": "capabilities",
                        "payload": value,
                    }),
                );
            }
        }

        // Emit event to frontend
        let _ = app.emit(
            "agent-repl-event",
            json!({
                "sessionId": effective_session_id,
                "root": root,
                "eventType": event_type,
                "payload": value,
            }),
        );

        // Handle process exit
        if event_type == "process_exit" {
            let pid = value.get("pid").and_then(|v| v.as_u64());
            emit_process_status(&app, &root, &effective_session_id, false, pid.map(|p| p as u32), "exited");
        }
    }
}

// ── Tauri commands ──

#[tauri::command]
pub fn get_agent_repl_process_status(
    root: String,
    session_id: String,
) -> Result<AgentReplProcessStatus, String> {
    let mut map = claw_processes_mut()?;
    let key = process_key(&root, &session_id);

    if let Some(proc) = map.get_mut(&key) {
        match proc.child.try_wait().map_err(error_to_string)? {
            None => {
                return Ok(AgentReplProcessStatus {
                    session_id,
                    root,
                    running: true,
                    pid: Some(proc.pid),
                });
            }
            Some(_) => {
                return Ok(AgentReplProcessStatus {
                    session_id,
                    root,
                    running: false,
                    pid: Some(proc.pid),
                });
            }
        }
    }

    Ok(AgentReplProcessStatus {
        session_id,
        root,
        running: false,
        pid: None,
    })
}

#[tauri::command]
pub fn kill_agent_repl_process(
    app: tauri::AppHandle,
    root: String,
    session_id: String,
) -> Result<AgentReplProcessStatus, String> {
    let mut map = claw_processes_mut()?;
    let key = process_key(&root, &session_id);

    let old_pid = map.get(&key).map(|p| p.pid);

    if let Some(mut proc) = map.remove(&key) {
        let _ = proc.stdin.write_all(b"{\"type\":\"interrupt\"}\n");
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }

    drop(map);
    clear_session_ready(&root, &session_id);

    if let Some(pid) = old_pid {
        emit_process_status(&app, &root, &session_id, false, Some(pid), "killed");
    }

    Ok(AgentReplProcessStatus {
        session_id,
        root,
        running: false,
        pid: old_pid,
    })
}

#[tauri::command]
pub fn ensure_agent_repl_process(
    app: tauri::AppHandle,
    root: String,
    session_id: String,
    model_override: Option<String>,
    permission_mode: Option<String>,
) -> Result<AgentReplProcessState, String> {
    let permission_mode =
        crate::permissions::normalize_permission_mode(permission_mode.as_deref().unwrap_or("default"))?.to_string();
    let root_path = canonical_workspace_root(&root)?;
    let repo = repo_root()?;
    let settings = load_model_settings().unwrap_or_else(|_| default_model_settings());
    let config = active_model_config(&settings).ok().flatten().cloned();

    let model = model_override.unwrap_or_else(|| {
        config
            .as_ref()
            .map(|c| resolve_model_for_provider(c))
            .unwrap_or_else(|| "default".to_string())
    });

    let key = process_key(&root, &session_id);

    // Check for existing process
    {
        let mut processes = CLAW_PROCESSES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(error_to_string)?;

        if let Some(proc_state) = processes.get_mut(&key) {
            match proc_state.child.try_wait().map_err(error_to_string)? {
                None => {
                    let _ = app.emit(
                        "agent-repl-event",
                        json!({
                            "sessionId": session_id,
                            "root": root,
                            "eventType": "startup",
                            "payload": {
                                "bridge": "bun-stream-json",
                                "process": "reused",
                                "pid": proc_state.pid,
                                "model": model,
                            },
                        }),
                    );
                    emit_process_status(&app, &root, &session_id, true, Some(proc_state.pid), "reused");

                    return Ok(AgentReplProcessState {
                        session_id,
                        root,
                        model,
                        permission_mode: permission_mode.clone(),
                    });
                }
                Some(status) => {
                    let old_pid = proc_state.pid;
                    processes.remove(&key);

                    let _ = app.emit(
                        "agent-repl-event",
                        json!({
                            "sessionId": session_id,
                            "root": root,
                            "eventType": "process_exit",
                            "payload": {
                                "running": false,
                                "pid": old_pid,
                                "status": status.to_string(),
                                "reason": "exited_before_ensure",
                            },
                        }),
                    );
                    emit_process_status(&app, &root, &session_id, false, Some(old_pid), "exited_before_ensure");
                }
            }
        }
    }

    // Build CLI command
    let mut cmd = Command::new("bun");
    cmd.arg("run")
        .arg(repo.join("src/entrypoints/cli.tsx"))
        .arg("-p")
        .arg("--input-format").arg("stream-json")
        .arg("--output-format").arg("stream-json")
        .arg("--verbose")
        .arg("--replay-user-messages")
        .arg("--permission-mode").arg(&permission_mode)
        .arg("--permission-prompt-tool").arg("stdio");

    let mcp_config_path = astromere_mcp_config_path()?;
    if mcp_config_path.is_file() {
        cmd.arg("--mcp-config").arg(mcp_config_path.to_string_lossy().to_string());
    }

    if claude_session_file_exists(&root_path, &session_id) {
        cmd.arg("--resume").arg(&session_id);
    } else if is_existing_claude_session_id(&session_id) {
        cmd.arg("--session-id").arg(&session_id);
    }

    cmd.current_dir(&root_path)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    apply_agent_ui_env(&mut cmd);
    if let Some(ref config) = config {
        apply_model_env(&mut cmd, config);
    } else {
        cmd.env("ANTHROPIC_MODEL", &model);
    }

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn agent process: {e}"))?;
    let pid = child.id();

    let stdin = child.stdin.take().ok_or_else(|| "stdin not available".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "stdout not available".to_string())?;
    let _stderr = child.stderr.take().ok_or_else(|| "stderr not available".to_string())?;

    let shared_session: Arc<Mutex<String>> = Arc::new(Mutex::new(session_id.clone()));
    let app_for_stdout = app.clone();
    let root_for_stdout = root.clone();
    let session_id_for_stdout = session_id.clone();
    let session_for_stdout = shared_session.clone();

    let _stdout_handle = std::thread::Builder::new()
        .name(format!("stdout-{pid}"))
        .spawn(move || {
            spawn_repl_stdout_reader(stdout, app_for_stdout, &root_for_stdout, &session_id_for_stdout, &session_for_stdout);
        })
        .map_err(|e| format!("failed to spawn stdout reader: {e}"))?;

    {
        let mut processes = CLAW_PROCESSES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(error_to_string)?;
        processes.insert(
            key.clone(),
            ClawProcess {
                root: root.clone(),
                session_id: session_id.clone(),
                pid,
                stdin,
                child,
            },
        );
    }

    let _ = app.emit(
        "agent-repl-event",
        json!({
            "sessionId": session_id,
            "root": root,
            "eventType": "startup",
            "payload": {
                "bridge": "bun-stream-json",
                "process": "started",
                "pid": pid,
                "model": model,
            },
        }),
    );
    emit_process_status(&app, &root, &session_id, true, Some(pid), "started");

    let ready_timeout = Duration::from_secs(30);
    if let Err(e) = wait_for_session_ready(&root, &session_id, ready_timeout) {
        let _ = app.emit(
            "agent-repl-event",
            json!({
                "sessionId": session_id,
                "root": root,
                "eventType": "stderr",
                "payload": { "text": format!("Session ready timeout: {e}") },
            }),
        );
    }

    Ok(AgentReplProcessState {
        session_id,
        root,
        model,
        permission_mode,
    })
}

#[tauri::command]
pub fn fork_agent_repl_process(
    app: tauri::AppHandle,
    root: String,
    source_session_id: String,
    checkpoint_uuid: String,
    model_override: Option<String>,
    permission_mode: Option<String>,
) -> Result<AgentReplProcessState, String> {
    let permission_mode =
        crate::permissions::normalize_permission_mode(permission_mode.as_deref().unwrap_or("default"))?.to_string();
    let root_path = canonical_workspace_root(&root)?;
    let repo = repo_root()?;
    let settings = load_model_settings().unwrap_or_else(|_| default_model_settings());
    let config = active_model_config(&settings).ok().flatten().cloned();

    let model = model_override.unwrap_or_else(|| {
        config
            .as_ref()
            .map(|c| resolve_model_for_provider(c))
            .unwrap_or_else(|| "default".to_string())
    });

    let excluded_session_ids: Vec<String> = {
        let processes = CLAW_PROCESSES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(error_to_string)?;
        processes
            .iter()
            .map(|(key, _)| key.split("::").nth(1).unwrap_or("").to_string())
            .collect()
    };

    let forked_session_id = crate::utils::generate_agent_ui_session_id();
    let forked_key = process_key(&root, &forked_session_id);

    // Kill the source process
    {
        let mut processes = CLAW_PROCESSES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(error_to_string)?;
        let source_key = process_key(&root, &source_session_id);
        if let Some(mut proc) = processes.remove(&source_key) {
            let _ = proc.stdin.write_all(b"{\"type\":\"interrupt\"}\n");
            poll_fork_wait_child_exit(&mut proc.child, Duration::from_secs(5));
        }
    }

    clear_session_ready(&root, &source_session_id);

    let mut cmd = Command::new("bun");
    cmd.arg("run")
        .arg(repo.join("src/entrypoints/cli.tsx"))
        .arg("-p")
        .arg("--input-format").arg("stream-json")
        .arg("--output-format").arg("stream-json")
        .arg("--verbose")
        .arg("--replay-user-messages")
        .arg("--permission-mode").arg(&permission_mode)
        .arg("--permission-prompt-tool").arg("stdio")
        .arg("--resume").arg(&source_session_id)
        .arg("--checkpoint-id").arg(&checkpoint_uuid);

    let mcp_config_path = astromere_mcp_config_path()?;
    if mcp_config_path.is_file() {
        cmd.arg("--mcp-config").arg(mcp_config_path.to_string_lossy().to_string());
    }

    cmd.current_dir(&root_path)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    apply_agent_ui_env(&mut cmd);
    if let Some(ref config) = config {
        apply_model_env(&mut cmd, config);
    } else {
        cmd.env("ANTHROPIC_MODEL", &model);
    }

    fork_debug(format!("spawning forked process session_id={forked_session_id} source={source_session_id}"));

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn forked agent process: {e}"))?;
    let pid = child.id();

    let stdin = child.stdin.take().ok_or_else(|| "stdin not available".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "stdout not available".to_string())?;
    let _stderr = child.stderr.take().ok_or_else(|| "stderr not available".to_string())?;

    let shared_session: Arc<Mutex<String>> = Arc::new(Mutex::new(forked_session_id.clone()));
    let app_for_stdout = app.clone();
    let root_for_stdout = root.clone();
    let session_id_for_stdout = forked_session_id.clone();
    let session_for_stdout = shared_session.clone();

    let _stdout_handle = std::thread::Builder::new()
        .name(format!("fork-stdout-{pid}"))
        .spawn(move || {
            spawn_repl_stdout_reader(stdout, app_for_stdout, &root_for_stdout, &session_id_for_stdout, &session_for_stdout);
        })
        .map_err(|e| format!("failed to spawn stdout reader: {e}"))?;

    let ready_timeout = Duration::from_secs(30);
    let ready_result = wait_for_session_ready(&root, &forked_session_id, ready_timeout);

    if ready_result.is_ok() {
        let detect_timeout = Duration::from_secs(10);
        match wait_for_fork_session_id(&root, &source_session_id, &excluded_session_ids, detect_timeout) {
            Ok(actual_session_id) if actual_session_id != forked_session_id => {
                fork_debug(format!("session id changed {} -> {}", forked_session_id, actual_session_id));

                let actual_key = process_key(&root, &actual_session_id);
                let mut processes = CLAW_PROCESSES
                    .get_or_init(|| Mutex::new(HashMap::new()))
                    .lock()
                    .map_err(error_to_string)?;
                if let Some(proc) = processes.remove(&forked_key) {
                    processes.insert(actual_key, proc);
                }
                remember_fork_session_hint(&root, &source_session_id, &actual_session_id);

                return Ok(AgentReplProcessState {
                    session_id: actual_session_id,
                    root,
                    model,
                    permission_mode,
                });
            }
            Ok(_) => {}
            Err(e) => {
                fork_debug(format!("failed to detect forked session id: {e}"));
            }
        }
    }

    {
        let mut processes = CLAW_PROCESSES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(error_to_string)?;
        processes.insert(
            forked_key,
            ClawProcess {
                root: root.clone(),
                session_id: forked_session_id.clone(),
                pid,
                stdin,
                child,
            },
        );
    }

    let _ = app.emit(
        "agent-repl-event",
        json!({
            "sessionId": forked_session_id,
            "root": root,
            "eventType": "startup",
            "payload": {
                "bridge": "bun-stream-json",
                "process": "forked",
                "pid": pid,
                "model": model,
            },
        }),
    );
    emit_process_status(&app, &root, &forked_session_id, true, Some(pid), "forked");

    if let Err(e) = ready_result {
        let _ = app.emit(
            "agent-repl-event",
            json!({
                "sessionId": forked_session_id,
                "root": root,
                "eventType": "stderr",
                "payload": { "text": format!("Session ready timeout (fork): {e}") },
            }),
        );
    }

    Ok(AgentReplProcessState {
        session_id: forked_session_id,
        root,
        model,
        permission_mode,
    })
}
