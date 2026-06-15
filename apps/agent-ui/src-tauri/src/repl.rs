use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
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
use crate::models::{apply_agent_ui_env, apply_model_env};
use crate::models_core::{active_model_config, default_model_settings, load_model_settings, resolve_model_for_provider};
use crate::mcp::astromere_mcp_config_path;
use crate::control::{
    remember_control_response, shared_session_id, set_shared_session_id,
    stream_value_session_id, remember_fork_session_hint,
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
    if root.trim().is_empty() || session_id.trim().is_empty() {
        fork_debug(format!("mark_session_ready skipped: root='{root}' session_id='{session_id}'"));
        return;
    }
    let registry = session_ready_registry();
    let mut sessions = registry.sessions.lock().unwrap();
    let key = session_ready_key(root, session_id);
    fork_debug(format!("mark_session_ready: key={key}"));
    sessions.insert(key, true);
    registry.condvar.notify_all();
}

#[allow(dead_code)]
fn wait_for_session_ready(root: &str, session_id: &str, timeout: Duration) -> Result<(), String> {
    let registry = session_ready_registry();
    let key = session_ready_key(root, session_id);
    let deadline = std::time::Instant::now() + timeout;
    let mut sessions = registry.sessions.lock().unwrap();

    loop {
        if sessions.get(&key).copied().unwrap_or(false) {
            fork_debug(format!("wait_for_session_ready: ready immediately key={key}"));
            return Ok(());
        }

        let now = std::time::Instant::now();
        if now >= deadline {
            fork_debug(format!("wait_for_session_ready: TIMEOUT key={key} sessions_keys={:?}", sessions.keys().collect::<Vec<_>>()));
            return Err(format!(
                "timed out waiting for session to be ready"
            ));
        }

        let wait_for = deadline.saturating_duration_since(now).min(Duration::from_millis(250));
        let (next_sessions, _wait_result) = registry
            .condvar
            .wait_timeout(sessions, wait_for)
            .map_err(|e| format!("wait interrupted: {e}"))?;
        sessions = next_sessions;
        fork_debug(format!("wait_for_session_ready: woke up key={key} elapsed_ms={}", deadline.elapsed().as_millis()));
    }
}

// ── Process helpers ──

fn is_existing_claude_session_id(session_id: &str) -> bool {
    if session_id.starts_with("new-") || session_id.starts_with("pending-") {
        return false;
    }

    let parts: Vec<&str> = session_id.split('-').collect();
    parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && session_id
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

fn claude_session_file_path(root_path: &Path, session_id: &str) -> Result<PathBuf, String> {
    if !is_existing_claude_session_id(session_id) {
        return Err(format!("not a Claude session id: {session_id}"));
    }

    Ok(claude_project_sessions_dir(root_path)?.join(format!("{session_id}.jsonl")))
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

fn wait_for_session_jsonl_created(
    root: &str,
    root_path: &Path,
    session_id: &str,
    timeout: Duration,
) -> Result<PathBuf, String> {
    let path = claude_session_file_path(root_path, session_id)?;
    let deadline = std::time::Instant::now() + timeout;
    let started = std::time::Instant::now();
    let mut next_progress_log = started + Duration::from_secs(2);

    loop {
        if let Ok(metadata) = std::fs::metadata(&path) {
            if metadata.is_file() && metadata.len() > 0 {
                fork_debug(format!(
                    "fork JSONL ready; session_id={} path={} bytes={} elapsed_ms={}",
                    session_id,
                    path.display(),
                    metadata.len(),
                    started.elapsed().as_millis()
                ));
                mark_session_ready(root, session_id);
                return Ok(path);
            }
        }

        {
            let mut processes = claw_processes()?;
            let key = process_key(root, session_id);
            let Some(proc_state) = processes.get_mut(&key) else {
                return Err(format!(
                    "Forked CLI process disappeared before creating session file: {session_id}"
                ));
            };

            if let Some(status) = proc_state.child.try_wait().map_err(error_to_string)? {
                return Err(format!(
                    "Forked CLI process exited before creating session file {session_id}: {status}"
                ));
            }
        }

        let now = std::time::Instant::now();
        if now >= deadline {
            return Err(format!(
                "Timed out waiting for forked CLI process to create session file after {}s: {}",
                timeout.as_secs(),
                path.display()
            ));
        }

        if now >= next_progress_log {
            fork_debug(format!(
                "waiting for fork JSONL; session_id={} path={} elapsed_ms={}",
                session_id,
                path.display(),
                started.elapsed().as_millis()
            ));
            next_progress_log += Duration::from_secs(2);
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}

fn rekey_process_session(root: &str, old_session_id: &str, new_session_id: &str) -> Option<u32> {
    if old_session_id == new_session_id || new_session_id.trim().is_empty() {
        return None;
    }

    let old_key = process_key(root, old_session_id);
    let new_key = process_key(root, new_session_id);

    let mut map = CLAW_PROCESSES.get()?.lock().ok()?;

    if map.contains_key(&new_key) {
        return map.get(&new_key).map(|proc| proc.pid);
    }

    let mut proc = map.remove(&old_key)?;
    let pid = proc.pid;
    proc.session_id = new_session_id.to_string();
    map.insert(new_key, proc);
    Some(pid)
}

#[allow(dead_code)]
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

/// Emit to both Tauri event system and SSE broadcast.
/// When `app` is None (remote mode), only SSE is broadcast.
pub(crate) fn emit_event(app: Option<&tauri::AppHandle>, event_name: &str, event: serde_json::Value) {
    if let Some(a) = app {
        let _ = a.emit(event_name, &event);
    }
    if let Ok(json_str) = serde_json::to_string(&event) {
        crate::server::broadcast_sse_event(json_str);
    }
}

pub(crate) fn emit_process_status(
    app: Option<&tauri::AppHandle>,
    root: &str,
    session_id: &str,
    running: bool,
    pid: Option<u32>,
    reason: &str,
) {
    emit_event(app, "agent-repl-event",
        json!({
            "sessionId": session_id,
            "root": root,
            "eventType": "process_status",
            "payload": {
                "running": running,
                "pid": pid,
                "reason": reason,
            },
        }),
    );
}

fn remove_process_session(root: &str, session_id: &str) {
    let Some(Ok(mut processes)) = CLAW_PROCESSES.get().map(|m| m.lock()) else { return };
    let key = process_key(root, session_id);
    if let Some(mut process) = processes.remove(&key) {
        match process.child.try_wait() {
            Ok(Some(status)) => fork_debug(format!(
                "process removed after child exit; root={} session_id={} stored_session_id={} pid={} status={} code={:?} success={}",
                root, session_id, process.session_id, process.pid, status, status.code(), status.success()
            )),
            Ok(None) => fork_debug(format!(
                "process removed while child still running; root={} session_id={} stored_session_id={} pid={}",
                root, session_id, process.session_id, process.pid
            )),
            Err(e) => fork_debug(format!(
                "process remove try_wait error; root={} session_id={} stored_session_id={} pid={} error={}",
                root, session_id, process.session_id, process.pid, e
            )),
        }
    }
}

// ── Stdout reader ──

fn extract_assistant_text(value: &Value) -> String {
    let mut parts = Vec::new();

    if let Some(message_content) = value.get("message").and_then(|m| m.get("content")) {
        collect_text_blocks(message_content, &mut parts);
    }

    if parts.is_empty() {
        for key in ["content", "text", "result", "output_text", "delta"] {
            if let Some(child) = value.get(key) {
                collect_text_blocks(child, &mut parts);
            }
        }
    }

    parts.join("")
}

fn collect_text_blocks(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            if !text.trim().is_empty() {
                parts.push(text.clone());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_text_blocks(item, parts);
            }
        }
        Value::Object(_) => {
            let block_type = value.get("type").and_then(|v| v.as_str());
            if matches!(block_type, Some("text") | Some("output_text")) {
                if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
                    if !text.trim().is_empty() {
                        parts.push(text.to_string());
                    }
                }
                return;
            }

            for key in ["content", "text", "result", "output_text", "delta"] {
                if let Some(child) = value.get(key) {
                    collect_text_blocks(child, parts);
                }
            }
        }
        _ => {}
    }
}

fn extract_tool_uses(value: &Value) -> Vec<Value> {
    let mut tools = Vec::new();

    if let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                tools.push(block.clone());
            }
        }
    }

    tools
}

fn value_summary_for_log(value: &Value) -> String {
    let event_type = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("<missing>");
    let maybe_session_id = stream_value_session_id(value).unwrap_or_default();
    let maybe_request_id = value
        .get("request_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut summary = format!("type={event_type}");
    if !maybe_session_id.is_empty() {
        summary.push_str(&format!(" session_id={maybe_session_id}"));
    }
    if !maybe_request_id.is_empty() {
        summary.push_str(&format!(" request_id={maybe_request_id}"));
    }
    summary
}

pub(crate) fn spawn_repl_stdout_reader(
    app: Option<tauri::AppHandle>,
    shared_session: Arc<Mutex<String>>,
    root: String,
    stdout: std::process::ChildStdout,
    ignored_rekey_session_ids: Vec<String>,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut current_message_id_by_session: HashMap<String, String> = HashMap::new();
        let mut _saw_text = false;

        for line in reader.lines() {
            let mut event_session_id = shared_session_id(&shared_session);
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    fork_debug(format!(
                        "stdout reader error; session_id={} error={}",
                        event_session_id, error
                    ));
                    emit_event(app.as_ref(), "agent-repl-event",
                        json!({
                            "sessionId": event_session_id,
                            "root": root,
                            "eventType": "error",
                            "payload": {
                                "text": error.to_string()
                            }
                        }),
                    );
                    break;
                }
            };

            if line.trim().is_empty() {
                continue;
            }

            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => {
                    fork_debug(format!(
                        "stdout non-json line; session_id={} error={} line={}",
                        event_session_id,
                        error,
                        crate::utils::truncate_for_log(&line, 1600)
                    ));
                    emit_event(app.as_ref(), "agent-repl-event",
                        json!({
                            "sessionId": event_session_id,
                            "root": root,
                            "eventType": "stderr",
                            "payload": {
                                "text": line
                            }
                        }),
                    );
                    continue;
                }
            };

            let parsed_event_type = value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("<missing>")
                .to_string();
            let parsed_session_id = stream_value_session_id(&value);
            if parsed_event_type == "control_response"
                || parsed_event_type == "control_request"
                || parsed_session_id
                    .as_deref()
                    .map(|sid| sid != event_session_id)
                    .unwrap_or(false)
            {
                fork_debug(format!(
                    "stdout event; current_session_id={} {}",
                    event_session_id,
                    value_summary_for_log(&value)
                ));
            }

            remember_control_response(&value);

            if let Some(real_session_id) = parsed_session_id.as_deref() {
                if real_session_id != event_session_id
                    && ignored_rekey_session_ids
                        .iter()
                        .any(|ignored| ignored.trim() == real_session_id)
                {
                    fork_debug(format!(
                        "stdout ignored session id change because candidate is excluded; current_session_id={} ignored_session_id={} ignored_rekey_session_ids={:?}",
                        event_session_id, real_session_id, ignored_rekey_session_ids
                    ));
                    continue;
                }
            }

            if let Some(real_session_id) = parsed_session_id {
                mark_session_ready(&root, &real_session_id);
                if real_session_id != event_session_id {
                    fork_debug(format!(
                        "stdout session id changed; previous_session_id={} real_session_id={}",
                        event_session_id, real_session_id
                    ));
                    remember_fork_session_hint(&root, &event_session_id, &real_session_id);
                    let process_pid = if event_session_id.trim().is_empty() {
                        None
                    } else {
                        rekey_process_session(&root, &event_session_id, &real_session_id)
                    };
                    set_shared_session_id(&shared_session, &real_session_id);
                    event_session_id = real_session_id.clone();
                    fork_debug(format!(
                        "stdout rekey result; real_session_id={} process_pid={:?}",
                        real_session_id, process_pid
                    ));
                    if process_pid.is_some() {
                        emit_process_status(
                            app.as_ref(),
                            &root,
                            &real_session_id,
                            true,
                            process_pid,
                            "rekeyed",
                        );
                    }
                }
            }

            emit_event(app.as_ref(), "agent-repl-event",
                json!({
                    "sessionId": event_session_id,
                    "root": root,
                    "eventType": "raw_json",
                    "payload": {
                        "raw_json": value.clone()
                    }
                }),
            );

            match value.get("type").and_then(|v| v.as_str()) {
                Some("system") => {
                    let subtype = value.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                    let event_type = if subtype == "init" {
                        "startup"
                    } else {
                        "system"
                    };
                    emit_event(app.as_ref(), "agent-repl-event",
                        json!({
                            "sessionId": event_session_id,
                            "root": root,
                            "eventType": event_type,
                            "payload": value
                        }),
                    );
                }
                Some("assistant") => {
                    let assistant_message_id = value
                        .get("message")
                        .and_then(|message| message.get("id"))
                        .and_then(|id| id.as_str())
                        .map(|id| id.to_string());

                    if let Some(assistant_message_id) = assistant_message_id.as_deref() {
                        current_message_id_by_session
                            .insert(event_session_id.clone(), assistant_message_id.to_string());
                        eprintln!(
                            "[usage] current assistant_message_id set session_id={} assistant_message_id={}",
                            event_session_id, assistant_message_id
                        );
                    } else {
                        eprintln!(
                            "[usage][warn] assistant event missing raw_json.message.id session_id={}",
                            event_session_id
                        );
                    }

                    for tool in extract_tool_uses(&value) {
                        emit_event(app.as_ref(), "agent-repl-event",
                            json!({
                                "sessionId": event_session_id,
                                "root": root,
                                "eventType": "tool_call",
                                "payload": {
                                    "tool": tool,
                                    "raw_json": value
                                }
                            }),
                        );
                    }

                    let text = extract_assistant_text(&value);
                    if !text.trim().is_empty() {
                        _saw_text = true;
                        let assistant_message_id_for_emit =
                            assistant_message_id.map(|id| id.to_string());
                        let assistant_bind_status_for_emit =
                            if assistant_message_id_for_emit.is_some() {
                                "ok"
                            } else {
                                "missing_assistant_message_id"
                            };
                        emit_event(app.as_ref(), "agent-repl-event",
                            json!({
                                "sessionId": event_session_id,
                                "root": root,
                                "eventType": "turn_text",
                                "bindStatus": assistant_bind_status_for_emit,
                                "payload": {
                                    "text": text,
                                    "raw_json": value
                                }
                            }),
                        );
                    }
                }
                Some("result") => {
                    let result_text = value
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    let real_session_id = stream_value_session_id(&value);

                    let mut process_pid = None;
                    if let Some(real_session_id) = real_session_id.as_deref() {
                        mark_session_ready(&root, real_session_id);
                        if real_session_id != event_session_id {
                            process_pid =
                                rekey_process_session(&root, &event_session_id, real_session_id);
                            set_shared_session_id(&shared_session, real_session_id);
                            emit_process_status(
                                app.as_ref(),
                                &root,
                                real_session_id,
                                true,
                                process_pid,
                                "rekeyed",
                            );
                        }
                    }

                    let usage_binding_session_id = real_session_id
                        .as_deref()
                        .unwrap_or(event_session_id.as_str())
                        .to_string();

                    if usage_binding_session_id != event_session_id {
                        if let Some(current_message_id) = current_message_id_by_session
                            .get(&event_session_id)
                            .cloned()
                        {
                            current_message_id_by_session
                                .insert(usage_binding_session_id.clone(), current_message_id);
                        }
                    }

                    if let Some(current_message_id) =
                        current_message_id_by_session.get(&usage_binding_session_id)
                    {
                        eprintln!(
                            "[usage] turn_complete bound session_id={} assistant_message_id={}",
                            usage_binding_session_id, current_message_id
                        );
                    } else {
                        eprintln!(
                            "[usage][warn] turn_complete missing current assistant_message_id session_id={} event_session_id={}",
                            usage_binding_session_id, event_session_id
                        );
                    }

                    let usage_bound_assistant_message_id = current_message_id_by_session
                        .get(&usage_binding_session_id)
                        .map(|mid| mid.as_str());

                    let usage_bound_assistant_message_id_for_emit =
                        usage_bound_assistant_message_id.map(|id| id.to_string());
                    let usage_bind_status_for_emit =
                        if usage_bound_assistant_message_id_for_emit.is_some() {
                            "ok"
                        } else {
                            "missing_assistant_message_id"
                        };

                    emit_event(app.as_ref(), "agent-repl-event", json!({
                        "sessionId": event_session_id,
                        "root": root,
                        "eventType": "turn_complete",
                        "bindStatus": usage_bind_status_for_emit,
                        "payload": {
                            "ok": value.get("is_error").and_then(|v| v.as_bool()).map(|v| !v).unwrap_or(true),
                            "text": result_text,
                            "realSessionId": real_session_id,
                            "pid": process_pid,
                            "raw_json": value
                        }
                    }));

                    _saw_text = false;
                }
                Some("control_request") => {
                    let request = value.get("request").cloned().unwrap_or_else(|| json!({}));
                    let request_id = value
                        .get("request_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let subtype = request
                        .get("subtype")
                        .and_then(|v| v.as_str())
                        .unwrap_or("permission")
                        .to_string();
                    let tool_name = request
                        .get("tool_name")
                        .or_else(|| request.get("toolName"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
                    let prompt = format!("{} requests permission to use {}", subtype, tool_name);

                    emit_event(app.as_ref(), "agent-repl-event",
                        json!({
                            "sessionId": event_session_id,
                            "root": root,
                            "eventType": "permission_request",
                            "payload": {
                                "requestId": request_id,
                                "subtype": subtype,
                                "toolName": tool_name,
                                "input": input,
                                "prompt": prompt,
                                "raw_json": value
                            }
                        }),
                    );
                }
                Some("streamlined_text") => {
                    let text = value.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if !text.is_empty() {
                        _saw_text = true;
                        let assistant_message_id_for_emit = value
                            .get("message")
                            .and_then(|message| message.get("id"))
                            .and_then(|id| id.as_str())
                            .map(|id| id.to_string());
                        let assistant_bind_status_for_emit =
                            if assistant_message_id_for_emit.is_some() {
                                "ok"
                            } else {
                                "missing_assistant_message_id"
                            };
                        emit_event(app.as_ref(), "agent-repl-event",
                            json!({
                                "sessionId": event_session_id,
                                "root": root,
                                "eventType": "turn_text",
                                "bindStatus": assistant_bind_status_for_emit,
                                "payload": {
                                    "text": text,
                                    "raw_json": value
                                }
                            }),
                        );
                    }
                }
                _ => {
                    emit_event(app.as_ref(), "agent-repl-event",
                        json!({
                            "sessionId": event_session_id,
                            "root": root,
                            "eventType": "raw",
                            "payload": value
                        }),
                    );
                }
            }
        }

        let final_session_id = shared_session_id(&shared_session);
        fork_debug(format!(
            "stdout reader ended; final_session_id={} root={}",
            final_session_id, root
        ));
        remove_process_session(&root, &final_session_id);
        emit_event(app.as_ref(), "agent-repl-event",
            json!({
                "sessionId": final_session_id,
                "root": root,
                "eventType": "process_exit",
                "payload": {
                    "running": false,
                    "reason": "stdout_closed"
                }
            }),
        );
        emit_process_status(app.as_ref(), &root, &final_session_id, false, None, "stdout_closed");

        // Send a session_end event to signal SSE clients that this session is done.
        // The SSE connection itself stays open for other sessions.
        emit_event(app.as_ref(), "agent-repl-event",
            json!({
                "sessionId": final_session_id,
                "root": root,
                "eventType": "session_end",
                "payload": {
                    "reason": "process_exit"
                }
            }),
        );
    });
}

// ── stderr reader thread (mirrors stable) ──

fn spawn_repl_stderr_reader(
    app: Option<tauri::AppHandle>,
    shared_session: Arc<Mutex<String>>,
    root: String,
    stderr: std::process::ChildStderr,
) {
    use crate::control::shared_session_id;
    use crate::utils::truncate_for_log;
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if line.trim().is_empty() {
                continue;
            }
            let event_session_id = shared_session_id(&shared_session);
            fork_debug(format!(
                "stderr line; session_id={} line={}",
                event_session_id,
                truncate_for_log(&line, 1600)
            ));
            emit_event(app.as_ref(), "agent-repl-event",
                json!({
                    "sessionId": event_session_id,
                    "root": root,
                    "eventType": "stderr",
                    "payload": {
                        "text": line
                    }
                }),
            );
        }
    });
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
    root: String,
    session_id: String,
) -> Result<AgentReplProcessStatus, String> {
    let key = process_key(&root, &session_id);
    let mut processes = claw_processes_mut()?;

    let Some(mut proc) = processes.remove(&key) else {
        return Ok(AgentReplProcessStatus {
            root,
            session_id,
            running: false,
            pid: None,
        });
    };

    let pid = proc.pid;
    let _ = proc.child.kill();
    let _ = proc.child.wait();

    Ok(AgentReplProcessStatus {
        root,
        session_id,
        running: false,
        pid: Some(pid),
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
    ensure_agent_repl_process_inner(Some(app), root, session_id, model_override, permission_mode)
}

pub fn ensure_agent_repl_process_inner(
    app: Option<tauri::AppHandle>,
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
    let config = active_model_config(&settings).ok().cloned();

    let model = model_override.unwrap_or_else(|| {
        config
            .as_ref()
            .map(resolve_model_for_provider)
            .unwrap_or_else(|| "default".to_string())
    });

    let key = process_key(&root, &session_id);

    // Check for existing process
    {
        let mut processes = claw_processes()?;

        if let Some(proc_state) = processes.get_mut(&key) {
            match proc_state.child.try_wait().map_err(error_to_string)? {
                None => {
                    emit_event(app.as_ref(), "agent-repl-event",
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
                    emit_process_status(app.as_ref(), &root, &session_id, true, Some(proc_state.pid), "reused");

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

                    emit_event(app.as_ref(), "agent-repl-event",
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
                    emit_process_status(app.as_ref(), &root, &session_id, false, Some(old_pid), "exited_before_ensure");
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

    let mcp_path = astromere_mcp_config_path()?.to_string_lossy().to_string();
    if std::path::Path::new(&mcp_path).is_file() {
        cmd.arg("--mcp-config").arg(&mcp_path);
    }

    if claude_session_file_exists(&root_path, &session_id) {
        cmd.arg("--resume").arg(&session_id);
    } else if is_existing_claude_session_id(&session_id) {
        cmd.arg("--session-id").arg(&session_id);
    }

    cmd.current_dir(&root_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    apply_agent_ui_env(&mut cmd, &root_path, &session_id)?;

    if let Some(config) = config.as_ref() {
        apply_model_env(&mut cmd, config);

        if model != "default" {
            cmd.arg("--model").arg(&model);
        }
    }

    let mut child = cmd.spawn().map_err(error_to_string)?;
    let pid = child.id();

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open child stdin".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open child stdout".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to open child stderr".to_string())?;

    let shared_session = Arc::new(Mutex::new(session_id.clone()));
    let app_for_stdout = app.clone();
    let root_for_stdout = root.clone();
    let shared_session_for_stdout = shared_session.clone();

    let _stdout_handle = std::thread::Builder::new()
        .name(format!("stdout-{pid}"))
        .spawn(move || {
            spawn_repl_stdout_reader(app_for_stdout, shared_session_for_stdout, root_for_stdout, stdout, Vec::new());
        })
        .map_err(|e| format!("failed to spawn stdout reader: {e}"))?;

    spawn_repl_stderr_reader(app.clone(), shared_session.clone(), root.clone(), stderr);

    emit_event(app.as_ref(), "agent-repl-event", json!({
        "sessionId": session_id,
        "root": root,
        "eventType": "startup",
        "payload": {
            "bridge": "bun-stream-json",
            "process": "spawned",
            "pid": pid,
            "model": model,
            "provider": config.as_ref().map(|c| c.provider),
            "baseUrl": config.as_ref().map(|c| c.base_url.clone()).unwrap_or_default(),
            "apiKeyPresent": config.as_ref().map(|c| !c.api_key.trim().is_empty()).unwrap_or(false)
        }
    }));

    emit_process_status(app.as_ref(), &root, &session_id, true, Some(pid), "spawned");

    {
        let mut processes = claw_processes()?;
        processes.insert(
            key,
            ClawProcess {
                root: root.clone(),
                session_id: session_id.clone(),
                pid,
                stdin,
                child,
            },
        );
    }

    Ok(AgentReplProcessState {
        session_id,
        root,
        model,
        permission_mode: permission_mode.clone(),
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
    fork_agent_repl_process_inner(Some(app), root, source_session_id, checkpoint_uuid, model_override, permission_mode)
}

pub fn fork_agent_repl_process_inner(
    app: Option<tauri::AppHandle>,
    root: String,
    source_session_id: String,
    checkpoint_uuid: String,
    model_override: Option<String>,
    permission_mode: Option<String>,
) -> Result<AgentReplProcessState, String> {
    let source_session_id = source_session_id.trim().to_string();
    if source_session_id.is_empty() {
        return Err("source_session_id is required".to_string());
    }
    let checkpoint_uuid = checkpoint_uuid.trim().to_string();
    if checkpoint_uuid.is_empty() {
        return Err("checkpoint_uuid is required".to_string());
    }

    let permission_mode =
        crate::permissions::normalize_permission_mode(permission_mode.as_deref().unwrap_or("default"))?.to_string();
    let root_path = canonical_workspace_root(&root)?;
    let settings = load_model_settings().unwrap_or_else(|_| default_model_settings());
    let config = active_model_config(&settings).ok().cloned();

    let model = model_override.unwrap_or_else(|| {
        config
            .as_ref()
            .map(resolve_model_for_provider)
            .unwrap_or_else(|| "default".to_string())
    });

    let source_jsonl_exists = claude_session_file_exists(&root_path, &source_session_id);
    let source_arg_is_file = Path::new(&source_session_id).is_file();
    fork_debug(format!(
        "command received; root={} canonical_root={} source_session_id={} checkpoint_uuid={} source_jsonl_exists={} source_arg_is_file={} model={} permission_mode={}",
        root,
        root_path.display(),
        source_session_id,
        checkpoint_uuid,
        source_jsonl_exists,
        source_arg_is_file,
        model,
        permission_mode
    ));

    if !(source_jsonl_exists || source_arg_is_file) {
        fork_debug(format!(
            "source session missing before fork; source_session_id={} root={}",
            source_session_id,
            root_path.display()
        ));
        return Err(format!("source session not found: {source_session_id}"));
    }

    let forked_session_id = crate::utils::generate_agent_ui_session_id();
    clear_session_ready(&root, &forked_session_id);
    crate::control::clear_fork_session_hint(&root, &forked_session_id);

    let repo = repo_root()?;
    let mut cmd = Command::new("bun");
    cmd.arg("run")
        .arg(repo.join("src/entrypoints/cli.tsx"))
        .arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--replay-user-messages")
        .arg("--resume")
        .arg(&source_session_id)
        .arg("--resume-session-at")
        .arg(&checkpoint_uuid)
        .arg("--fork-session")
        .arg("-desktop-mode")
        .arg("--session-id")
        .arg(&forked_session_id)
        .arg("--permission-mode")
        .arg(&permission_mode)
        .arg("--permission-prompt-tool")
        .arg("stdio");

    cmd.current_dir(&root_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    apply_agent_ui_env(&mut cmd, &root_path, &forked_session_id)?;

    if let Some(config) = config.as_ref() {
        apply_model_env(&mut cmd, config);

        if model != "default" {
            cmd.arg("--model").arg(&model);
        }
    }

    fork_debug(format!(
        "spawning native CLI fork; source_session_id={} forked_session_id={} checkpoint_uuid={} mode=pregenerated_session_id",
        source_session_id,
        forked_session_id,
        checkpoint_uuid
    ));

    let mut child = cmd.spawn().map_err(error_to_string)?;
    let pid = child.id();

    fork_debug(format!(
        "spawned native CLI fork process; source_session_id={} forked_session_id={} pid={} cwd={} checkpoint_uuid={}",
        source_session_id,
        forked_session_id,
        pid,
        root_path.display(),
        checkpoint_uuid
    ));

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open fork child stdin".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open fork child stdout".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to open fork child stderr".to_string())?;

    let fork_key = process_key(&root, &forked_session_id);
    {
        let mut processes = claw_processes()?;
        processes.insert(
            fork_key,
            ClawProcess {
                root: root.clone(),
                session_id: forked_session_id.clone(),
                pid,
                stdin,
                child,
            },
        );
    }

    let shared_session = Arc::new(Mutex::new(forked_session_id.clone()));
    spawn_repl_stdout_reader(app.clone(), shared_session.clone(), root.clone(), stdout, Vec::new());
    spawn_repl_stderr_reader(app.clone(), shared_session.clone(), root.clone(), stderr);

    let forked_jsonl_path = match wait_for_session_jsonl_created(
        &root,
        &root_path,
        &forked_session_id,
        Duration::from_secs(30),
    ) {
        Ok(path) => path,
        Err(error) => {
            fork_debug(format!(
                "native CLI fork did not create JSONL; source_session_id={} forked_session_id={} pid={} error={}",
                source_session_id,
                forked_session_id,
                pid,
                error
            ));
            if let Ok(mut processes) = claw_processes() {
                if let Some(mut proc_state) = processes.remove(&process_key(&root, &forked_session_id)) {
                    match proc_state.child.try_wait() {
                        Ok(Some(status)) => {
                            fork_debug(format!(
                                "fork child already exited before cleanup; forked_session_id={} pid={} status={} code={:?} success={}",
                                forked_session_id,
                                pid,
                                status,
                                status.code(),
                                status.success()
                            ));
                        }
                        Ok(None) => {
                            fork_debug(format!(
                                "fork child still running after JSONL wait timeout; killing; forked_session_id={} pid={}",
                                forked_session_id,
                                pid
                            ));
                            let _ = proc_state.child.kill();
                            match proc_state.child.wait() {
                                Ok(status) => fork_debug(format!(
                                    "fork child exited after kill; forked_session_id={} pid={} status={} code={:?} success={}",
                                    forked_session_id,
                                    pid,
                                    status,
                                    status.code(),
                                    status.success()
                                )),
                                Err(wait_error) => fork_debug(format!(
                                    "fork child wait after kill failed; forked_session_id={} pid={} error={}",
                                    forked_session_id,
                                    pid,
                                    wait_error
                                )),
                            }
                        }
                        Err(wait_error) => {
                            fork_debug(format!(
                                "fork child try_wait failed during cleanup; forked_session_id={} pid={} error={}",
                                forked_session_id,
                                pid,
                                wait_error
                            ));
                            let _ = proc_state.child.kill();
                            let _ = proc_state.child.wait();
                        }
                    }
                }
            }
            emit_process_status(app.as_ref(), &root, &forked_session_id, false, Some(pid), "fork_start_timeout");
            return Err(error);
        }
    };

    fork_debug(format!(
        "native CLI fork ready; source_session_id={} forked_session_id={} pid={} jsonl_path={}",
        source_session_id,
        forked_session_id,
        pid,
        forked_jsonl_path.display()
    ));

    emit_event(app.as_ref(), "agent-repl-event",
        json!({
            "sessionId": forked_session_id.clone(),
            "root": root.clone(),
            "eventType": "fork_created",
            "payload": {
                "sourceSessionId": source_session_id.clone(),
                "checkpointUuid": checkpoint_uuid.clone(),
                "pid": pid,
                "model": model.clone(),
            }
        }),
    );

    emit_process_status(app.as_ref(), &root, &forked_session_id, true, Some(pid), "forked");

    Ok(AgentReplProcessState {
        session_id: forked_session_id,
        root,
        model,
        permission_mode: permission_mode.clone(),
    })
}
