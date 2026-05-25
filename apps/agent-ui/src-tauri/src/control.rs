use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::types::{
    AgentContextUsage, AgentReplCapabilities, AgentReplCapabilityItem,
    AgentReplProcessStatus, AgentReplSendResult, AgentTurnResponse,
    ControlResponseRegistry, ForkSessionRegistry,
};
use crate::utils::{error_to_string, process_key};

// ── Global state shared with repl.rs ──

use crate::repl::{claw_processes, claw_processes_mut};

static CONTROL_RESPONSES: OnceLock<ControlResponseRegistry> = OnceLock::new();
static FORK_SESSIONS: OnceLock<ForkSessionRegistry> = OnceLock::new();

fn control_responses() -> &'static ControlResponseRegistry {
    CONTROL_RESPONSES.get_or_init(|| ControlResponseRegistry {
        responses: Mutex::new(HashMap::new()),
        condvar: Condvar::new(),
    })
}

fn fork_sessions() -> &'static ForkSessionRegistry {
    FORK_SESSIONS.get_or_init(|| ForkSessionRegistry {
        sessions: Mutex::new(HashMap::new()),
    })
}

// ── Control response API ──

pub fn control_response_request_id(value: &Value) -> Option<String> {
    value
        .get("response")
        .and_then(|r| r.get("request_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            value
                .get("request")
                .and_then(|r| r.get("request_id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            value
                .get("request_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
}

pub fn remember_control_response(value: &Value) {
    if let Some(request_id) = control_response_request_id(value) {
        let registry = control_responses();
        let mut responses = registry.responses.lock().unwrap();
        responses.insert(request_id, value.clone());
        registry.condvar.notify_all();
    }
}

fn wait_for_control_response(request_id: &str, timeout: Duration) -> Result<Value, String> {
    let registry = control_responses();
    let mut responses = registry.responses.lock().unwrap();

    if let Some(value) = responses.remove(request_id) {
        return Ok(value);
    }

    let result = registry.condvar.wait_timeout_while(responses, timeout, |r| {
        !r.contains_key(request_id)
    });

    match result {
        Ok((mut responses, timeout_result)) => {
            if timeout_result.timed_out() {
                return Err(format!(
                    "timed out waiting for control response: {request_id}"
                ));
            }
            responses
                .remove(request_id)
                .ok_or_else(|| format!("control response not found: {request_id}"))
        }
        Err(e) => Err(format!("wait interrupted: {e}")),
    }
}

fn take_control_response(request_id: &str) -> Result<Option<Value>, String> {
    let registry = control_responses();
    let mut responses = registry.responses.lock().unwrap();
    Ok(responses.remove(request_id))
}

// ── Capability helpers ──

fn capability_item_from_value(value: &Value) -> Option<AgentReplCapabilityItem> {
    let name = value.get("name").and_then(|v| v.as_str())?.to_string();
    let kind = value
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("command")
        .to_string();
    let slash = value
        .get("slash")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let description = value.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());

    Some(AgentReplCapabilityItem { name, slash, kind, description })
}

fn capability_items_from_value(value: &Value, key: &str) -> Vec<AgentReplCapabilityItem> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|item| capability_item_from_value(item)).collect())
        .unwrap_or_default()
}

pub fn capabilities_from_control_response(
    value: &Value,
    root: &str,
    session_id: &str,
) -> Option<AgentReplCapabilities> {
    let response = value.get("response")?;
    let updated_at = response.get("updated_at_ms").and_then(|v| v.as_u64()).unwrap_or(0);

    Some(AgentReplCapabilities {
        root: root.to_string(),
        session_id: session_id.to_string(),
        commands: capability_items_from_value(response, "commands"),
        skills: capability_items_from_value(response, "skills"),
        slash_commands: capability_items_from_value(response, "slash_commands"),
        updated_at_ms: updated_at,
    })
}

fn context_usage_from_control_response(
    value: &Value,
    root: &str,
    session_id: &str,
) -> Option<AgentContextUsage> {
    let response = value.get("response")?;
    let data = response.get("data")?.clone();
    let updated_at = response.get("updated_at_ms").and_then(|v| v.as_u64()).unwrap_or(0);

    Some(AgentContextUsage {
        root: root.to_string(),
        session_id: session_id.to_string(),
        data,
        updated_at_ms: updated_at,
    })
}

// ── Fork session helpers ──

fn fork_session_wait_key(root: &str, source_session_id: &str) -> String {
    format!("{}::{}", root, source_session_id)
}

pub fn remember_fork_session_hint(root: &str, source_session_id: &str, forked_session_id: &str) {
    let sessions = fork_sessions();
    let mut map = sessions.sessions.lock().unwrap();
    map.insert(fork_session_wait_key(root, source_session_id), forked_session_id.to_string());
}

fn take_fork_session_hint(root: &str, source_session_id: &str) -> Option<String> {
    let sessions = fork_sessions();
    let mut map = sessions.sessions.lock().unwrap();
    map.remove(&fork_session_wait_key(root, source_session_id))
}

fn is_existing_claude_session_id(session_id: &str) -> bool {
    session_id.len() == 36 && session_id.chars().filter(|&c| c == '-').count() == 4
}

fn is_allowed_forked_session_id(candidate: &str, excluded_session_ids: &[String]) -> bool {
    is_existing_claude_session_id(candidate) && !excluded_session_ids.contains(&candidate.to_string())
}

pub fn wait_for_fork_session_id(
    root: &str,
    source_session_id: &str,
    excluded_session_ids: &[String],
    timeout: Duration,
) -> Result<String, String> {
    if let Some(hint) = take_fork_session_hint(root, source_session_id) {
        return Ok(hint);
    }

    let start = Instant::now();

    loop {
        let remaining = timeout.checked_sub(start.elapsed()).unwrap_or(Duration::ZERO);
        if remaining.is_zero() {
            return Err("timed out waiting for fork session id".to_string());
        }

        let sessions_dir = crate::utils::claude_project_sessions_dir(&std::path::PathBuf::from(root))?;
        if !sessions_dir.is_dir() {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }

        let mut candidates: Vec<(std::path::PathBuf, std::time::SystemTime)> =
            std::fs::read_dir(&sessions_dir)
                .map_err(error_to_string)?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
                .filter_map(|e| {
                    let metadata = e.metadata().ok()?;
                    let modified = metadata.modified().ok()?;
                    Some((e.path(), modified))
                })
                .collect();

        candidates.sort_by(|a, b| b.1.cmp(&a.1));

        for (path, _) in &candidates {
            if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                if is_allowed_forked_session_id(name, excluded_session_ids) {
                    let content = std::fs::read_to_string(path).unwrap_or_default();
                    if !content.trim().is_empty() {
                        return Ok(name.to_string());
                    }
                }
            }
        }

        std::thread::sleep(Duration::from_millis(200));

        if start.elapsed() >= timeout {
            return Err("timed out waiting for fork session id".to_string());
        }
    }
}

// ── Stream helpers (used by repl.rs stdout reader) ──

pub fn shared_session_id(shared: &Arc<Mutex<String>>) -> String {
    shared.lock().unwrap().clone()
}

pub fn set_shared_session_id(shared: &Arc<Mutex<String>>, session_id: &str) {
    *shared.lock().unwrap() = session_id.to_string();
}

pub fn stream_value_session_id(value: &Value) -> Option<String> {
    value
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            value
                .get("response")
                .and_then(|r| r.get("session_id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| find_string_field_deep(value, &["session", "id"]))
        .or_else(|| find_string_field_deep(value, &["session_id"]))
}

fn find_string_field_deep(value: &Value, keys: &[&str]) -> Option<String> {
    let mut current = value;
    for key in keys {
        current = current.get(key)?;
    }
    current.as_str().map(|s| s.to_string())
}

// ── Tauri commands (control protocol) ──

#[tauri::command]
pub fn interrupt_agent_turn(
    _app: tauri::AppHandle,
    root: String,
    session_id: String,
) -> Result<bool, String> {
    let mut map = claw_processes_mut().map_err(error_to_string)?;
    let key = process_key(&root, &session_id);

    if let Some(proc) = map.get_mut(&key) {
        let payload = json!({"type": "interrupt"});
        let line = format!("{}\n", serde_json::to_string(&payload).map_err(error_to_string)?);
        proc.stdin.write_all(line.as_bytes()).map_err(error_to_string)?;
        return Ok(true);
    }

    Err("No active process for this session".to_string())
}

#[tauri::command]
pub fn send_agent_repl_input(
    root: String,
    session_id: String,
    input: String,
) -> Result<AgentReplSendResult, String> {
    let map = claw_processes().map_err(error_to_string)?;
    let key = process_key(&root, &session_id);

    let Some(proc) = map.get(&key) else {
        return Err("No active process for this session".to_string());
    };

    let payload = json!({"type": "user_input", "text": input});
    let line = format!("{}\n", serde_json::to_string(&payload).map_err(error_to_string)?);

    let mut stdin = &proc.stdin;
    stdin.write_all(line.as_bytes()).map_err(error_to_string)?;

    Ok(AgentReplSendResult { accepted: true })
}

#[tauri::command]
pub fn get_agent_repl_capabilities(
    root: String,
    session_id: String,
) -> Result<AgentReplCapabilities, String> {
    let request_id = crate::utils::generate_agent_ui_session_id();
    let map = claw_processes().map_err(error_to_string)?;
    let key = process_key(&root, &session_id);

    let Some(proc) = map.get(&key) else {
        return Err("No active process for this session".to_string());
    };

    let payload = json!({
        "type": "request",
        "request_id": request_id,
        "action": "capabilities",
    });
    let line = format!("{}\n", serde_json::to_string(&payload).map_err(error_to_string)?);
    let mut stdin = &proc.stdin;
    stdin.write_all(line.as_bytes()).map_err(error_to_string)?;
    drop(map);

    let response = wait_for_control_response(&request_id, Duration::from_secs(30))?;
    capabilities_from_control_response(&response, &root, &session_id)
        .ok_or_else(|| "failed to parse capabilities from control response".to_string())
}

#[tauri::command]
pub fn get_agent_context_usage(
    root: String,
    session_id: String,
) -> Result<AgentContextUsage, String> {
    let request_id = crate::utils::generate_agent_ui_session_id();
    let map = claw_processes().map_err(error_to_string)?;
    let key = process_key(&root, &session_id);

    let Some(proc) = map.get(&key) else {
        return Err("No active process for this session".to_string());
    };

    let payload = json!({
        "type": "request",
        "request_id": request_id,
        "action": "context_usage",
    });
    let line = format!("{}\n", serde_json::to_string(&payload).map_err(error_to_string)?);
    let mut stdin = &proc.stdin;
    stdin.write_all(line.as_bytes()).map_err(error_to_string)?;
    drop(map);

    let response = wait_for_control_response(&request_id, Duration::from_secs(30))?;
    context_usage_from_control_response(&response, &root, &session_id)
        .ok_or_else(|| "failed to parse context usage from control response".to_string())
}

#[tauri::command]
pub fn run_agent_turn(
    _app: tauri::AppHandle,
    root: String,
    session_id: String,
    prompt: String,
) -> Result<AgentTurnResponse, String> {
    let request_id = crate::utils::generate_agent_ui_session_id();
    let map = claw_processes().map_err(error_to_string)?;
    let key = process_key(&root, &session_id);

    let Some(proc) = map.get(&key) else {
        return Err("No active process for this session".to_string());
    };

    let payload = json!({
        "type": "request",
        "request_id": request_id,
        "action": "run_turn",
        "prompt": prompt,
    });
    let line = format!("{}\n", serde_json::to_string(&payload).map_err(error_to_string)?);
    let mut stdin = &proc.stdin;
    stdin.write_all(line.as_bytes()).map_err(error_to_string)?;
    drop(map);

    let response = wait_for_control_response(&request_id, Duration::from_secs(300))?;

    let r = response.get("response");
    let ok = r.and_then(|r| r.get("ok")).and_then(|v| v.as_bool()).unwrap_or(false);
    let message = r.and_then(|r| r.get("message")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let requires_confirmation = r.and_then(|r| r.get("requires_confirmation")).and_then(|v| v.as_bool()).unwrap_or(false);
    let permission_prompt = r.and_then(|r| r.get("permission_prompt")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let iterations = r.and_then(|r| r.get("iterations")).and_then(|v| v.as_u64());
    let model = r.and_then(|r| r.get("model")).and_then(|v| v.as_str()).map(|s| s.to_string());

    let raw_json = r.cloned();
    let tool_uses = r.and_then(|r| r.get("tool_uses")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let tool_results = r.and_then(|r| r.get("tool_results")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let usage = r.and_then(|r| r.get("usage")).cloned();
    let estimated_cost = r.and_then(|r| r.get("estimated_cost")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let stderr = r.and_then(|r| r.get("stderr")).and_then(|v| v.as_str()).map(|s| s.to_string());

    Ok(AgentTurnResponse {
        ok,
        message,
        requires_confirmation,
        permission_prompt,
        model,
        iterations,
        tool_uses,
        tool_results,
        usage,
        estimated_cost,
        raw_json,
        stderr,
    })
}

use std::io::Write;
