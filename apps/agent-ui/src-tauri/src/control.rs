use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::types::{
    AgentContextUsage, AgentReplCapabilities, AgentReplCapabilityItem,
    AgentReplSendResult, AgentTurnResponse,
    ControlResponseRegistry, ForkSessionRegistry,
};
use crate::utils::{error_to_string, process_key};

// ── Global state shared with repl.rs ──

use crate::repl::claw_processes_mut;

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
        .get("request_id")
        .and_then(|v| v.as_str())
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("request_id"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("response"))
                .and_then(|response| response.get("request_id"))
                .and_then(|v| v.as_str())
        })
        .filter(|request_id| !request_id.trim().is_empty())
        .map(|request_id| request_id.to_string())
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

#[allow(dead_code)]
fn take_control_response(request_id: &str) -> Result<Option<Value>, String> {
    let registry = control_responses();
    let mut responses = registry.responses.lock().unwrap();
    Ok(responses.remove(request_id))
}

// ── Capability helpers ──

fn capability_item_from_value(
    value: &Value,
    fallback_kind: &str,
) -> Option<AgentReplCapabilityItem> {
    if let Some(name) = value.as_str() {
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        return Some(AgentReplCapabilityItem {
            name: name.to_string(),
            slash: format!("/{name}"),
            kind: fallback_kind.to_string(),
            description: None,
        });
    }

    let object = value.as_object()?;
    let name = object
        .get("name")
        .or_else(|| object.get("command"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().trim_start_matches('/').to_string())
        .filter(|v| !v.is_empty())?;

    let slash = object
        .get("slash")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("/{name}"));

    let kind = object
        .get("kind")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| fallback_kind.to_string());

    let description = object
        .get("description")
        .or_else(|| object.get("summary"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    Some(AgentReplCapabilityItem {
        name,
        slash,
        kind,
        description,
    })
}

fn capability_items_from_value(
    value: Option<&Value>,
    fallback_kind: &str,
) -> Vec<AgentReplCapabilityItem> {
    value
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| capability_item_from_value(item, fallback_kind))
                .collect()
        })
        .unwrap_or_default()
}

pub fn capabilities_from_control_response(
    root: &str,
    session_id: &str,
    value: &Value,
) -> Result<AgentReplCapabilities, String> {
    let capabilities = value
        .pointer("/response/capabilities")
        .or_else(|| value.pointer("/response/response/capabilities"))
        .ok_or_else(|| format!("Control response did not include capabilities: {value}"))?;

    let commands = capability_items_from_value(capabilities.get("commands"), "command");
    let skills = capability_items_from_value(capabilities.get("skills"), "skill");

    let slash_commands = capability_items_from_value(
        capabilities
            .get("slashCommands")
            .or_else(|| capabilities.get("slash_commands")),
        "command",
    );

    let slash_commands = if slash_commands.is_empty() {
        commands
            .iter()
            .cloned()
            .chain(skills.iter().cloned())
            .collect()
    } else {
        slash_commands
    };

    Ok(AgentReplCapabilities {
        root: root.to_string(),
        session_id: session_id.to_string(),
        commands,
        skills,
        slash_commands,
        updated_at_ms: crate::utils::now_millis() as u64,
    })
}

fn context_usage_from_control_response(
    root: &str,
    session_id: &str,
    value: &Value,
) -> Result<AgentContextUsage, String> {
    let data = value
        .pointer("/response/response")
        .or_else(|| value.pointer("/response"))
        .ok_or_else(|| format!("Control response did not include context usage: {value}"))?
        .clone();

    Ok(AgentContextUsage {
        root: root.to_string(),
        session_id: session_id.to_string(),
        data,
        updated_at_ms: crate::utils::now_millis() as u64,
    })
}

// ── Fork session helpers ──

fn fork_session_wait_key(root: &str, source_session_id: &str) -> String {
    format!("{}::{}", root, source_session_id)
}

pub fn clear_fork_session_hint(root: &str, source_session_id: &str) {
    let sessions = fork_sessions();
    let mut map = sessions.sessions.lock().unwrap();
    map.remove(&fork_session_wait_key(root, source_session_id));
}

pub fn remember_fork_session_hint(root: &str, source_session_id: &str, forked_session_id: &str) {
    if source_session_id.trim().is_empty()
        || forked_session_id.trim().is_empty()
        || source_session_id == forked_session_id
    {
        return;
    }

    let sessions = fork_sessions();
    let mut map = sessions.sessions.lock().unwrap();
    map.insert(fork_session_wait_key(root, source_session_id), forked_session_id.to_string());
}

fn take_fork_session_hint(root: &str, source_session_id: &str) -> Option<String> {
    let sessions = fork_sessions();
    let mut map = sessions.sessions.lock().unwrap();
    map.remove(&fork_session_wait_key(root, source_session_id))
}

pub fn is_existing_claude_session_id(session_id: &str) -> bool {
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
    app: tauri::AppHandle,
    root: String,
    session_id: String,
) -> Result<bool, String> {
    interrupt_agent_turn_inner(Some(app), root, session_id)
}

pub fn interrupt_agent_turn_inner(
    app: Option<tauri::AppHandle>,
    root: String,
    session_id: String,
) -> Result<bool, String> {
    let request_id = format!("agent-ui-interrupt-{}", crate::utils::now_millis());
    let request = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "interrupt"
        }
    });

    let key = process_key(&root, &session_id);
    let mut processes = claw_processes_mut().map_err(error_to_string)?;

    let proc_state = if processes.contains_key(&key) {
        processes.get_mut(&key)
    } else {
        processes
            .iter_mut()
            .find(|(_, candidate)| candidate.root == root)
            .map(|(_, candidate)| candidate)
    };

    match proc_state {
        Some(proc_state) => {
            let line = serde_json::to_string(&request).map_err(error_to_string)?;
            use std::io::Write;
            writeln!(proc_state.stdin, "{line}").map_err(error_to_string)?;
            proc_state.stdin.flush().map_err(error_to_string)?;
            crate::repl::emit_event(app.as_ref(), "agent-repl-event",
                json!({
                    "sessionId": session_id,
                    "root": root,
                    "eventType": "interrupt",
                    "payload": {
                        "ok": true,
                        "text": "Interrupt signal sent"
                    }
                }),
            );
            Ok(true)
        }
        None => {
            crate::repl::emit_event(app.as_ref(), "agent-repl-event",
                json!({
                    "sessionId": session_id,
                    "root": root,
                    "eventType": "interrupt",
                    "payload": {
                        "ok": false,
                        "text": "No running process to interrupt"
                    }
                }),
            );
            Ok(false)
        }
    }
}

#[tauri::command]
pub fn send_agent_repl_input(
    root: String,
    session_id: String,
    input: String,
) -> Result<AgentReplSendResult, String> {
    let key = process_key(&root, &session_id);
    let mut processes = claw_processes_mut().map_err(error_to_string)?;
    let proc = processes
        .get_mut(&key)
        .ok_or_else(|| "REPL process is not running".to_string())?;

    let message = json!({
        "type": "user",
        "session_id": session_id,
        "message": {
            "role": "user",
            "content": input
        },
        "parent_tool_use_id": null
    });

    let line = serde_json::to_string(&message).map_err(error_to_string)?;
    use std::io::Write;
    writeln!(proc.stdin, "{}", line).map_err(error_to_string)?;
    proc.stdin.flush().map_err(error_to_string)?;

    Ok(AgentReplSendResult { accepted: true })
}

#[tauri::command]
pub fn get_agent_repl_capabilities(
    root: String,
    session_id: String,
) -> Result<AgentReplCapabilities, String> {
    let request_id = format!("agent-ui-capabilities-{}", crate::utils::now_millis());
    let request = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "get_capabilities"
        }
    });

    {
        let registry = control_responses();
        let mut responses = registry.responses.lock().unwrap();
        responses.remove(&request_id);
    }

    let line = serde_json::to_string(&request).map_err(error_to_string)?;
    let key = process_key(&root, &session_id);

    {
        use std::io::Write;
        let mut processes = claw_processes_mut().map_err(error_to_string)?;
        let proc = processes
            .get_mut(&key)
            .ok_or_else(|| "REPL process is not running".to_string())?;

        writeln!(proc.stdin, "{line}").map_err(error_to_string)?;
        proc.stdin.flush().map_err(error_to_string)?;
    }

    let response = wait_for_control_response(&request_id, Duration::from_secs(5))?;
    capabilities_from_control_response(&root, &session_id, &response)
}

#[tauri::command]
pub fn get_agent_context_usage(
    root: String,
    session_id: String,
) -> Result<AgentContextUsage, String> {
    let request_id = format!("agent-ui-context-{}", crate::utils::now_millis());
    let request = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "get_context_usage"
        }
    });

    {
        let registry = control_responses();
        let mut responses = registry.responses.lock().unwrap();
        responses.remove(&request_id);
    }

    let line = serde_json::to_string(&request).map_err(error_to_string)?;
    let key = process_key(&root, &session_id);

    {
        use std::io::Write;
        let mut processes = claw_processes_mut().map_err(error_to_string)?;
        let proc = processes
            .get_mut(&key)
            .ok_or_else(|| "REPL process is not running".to_string())?;

        writeln!(proc.stdin, "{line}").map_err(error_to_string)?;
        proc.stdin.flush().map_err(error_to_string)?;
    }

    let response = wait_for_control_response(&request_id, Duration::from_secs(5))?;
    context_usage_from_control_response(&root, &session_id, &response)
}

#[tauri::command]
pub fn run_agent_turn(
    root: String,
    session_id: String,
    prompt: String,
) -> Result<AgentTurnResponse, String> {
    let root_path = crate::utils::canonical_workspace_root(&root)?;
    let repo = crate::utils::repo_root()?;
    let settings = crate::models_core::load_model_settings().unwrap_or_else(|_| crate::models_core::default_model_settings());
    let config = crate::models_core::active_model_config(&settings).ok().cloned();

    let mut cmd = std::process::Command::new("bun");
    cmd.arg("run")
        .arg(repo.join("src/entrypoints/cli.tsx"))
        .arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("json")
        .current_dir(&root_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    crate::models::apply_agent_ui_env(&mut cmd, &root_path, &session_id)?;

    if let Some(config) = config.as_ref() {
        crate::models::apply_model_env(&mut cmd, config);
        let model = crate::models_core::resolve_model_for_provider(config);
        if model != "default" {
            cmd.arg("--model").arg(model);
        }
    }

    let output = cmd.output().map_err(error_to_string)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let raw_json = serde_json::from_str::<serde_json::Value>(&stdout).ok();

    let message = raw_json
        .as_ref()
        .and_then(|v| v.get("result"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            raw_json
                .as_ref()
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if stdout.trim().is_empty() {
                stderr.clone()
            } else {
                stdout.clone()
            }
        });

    Ok(AgentTurnResponse {
        ok: output.status.success(),
        message,
        requires_confirmation: false,
        permission_prompt: None,
        model: config.as_ref().map(|c| crate::models_core::resolve_model_for_provider(c)),
        iterations: None,
        tool_uses: vec![],
        tool_results: vec![],
        usage: raw_json.as_ref().and_then(|v| v.get("usage")).cloned(),
        estimated_cost: raw_json
            .as_ref()
            .and_then(|v| v.get("total_cost_usd").or_else(|| v.get("cost_usd")))
            .map(|v| v.to_string()),
        raw_json,
        stderr: if stderr.trim().is_empty() {
            None
        } else {
            Some(stderr)
        },
    })
}

// ─── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── is_existing_claude_session_id ──

    #[test]
    fn test_valid_uuid_is_recognized() {
        assert!(is_existing_claude_session_id(
            "abc12345-def4-5678-90ab-cdef01234567"
        ));
    }

    #[test]
    fn test_new_prefix_is_not_recognized() {
        assert!(!is_existing_claude_session_id("new-1234567890"));
    }

    #[test]
    fn test_pending_prefix_is_not_recognized() {
        assert!(!is_existing_claude_session_id("pending-1234567890"));
    }

    #[test]
    fn test_empty_string_is_not_recognized() {
        assert!(!is_existing_claude_session_id(""));
    }

    #[test]
    fn test_too_short_is_not_recognized() {
        assert!(!is_existing_claude_session_id("abc-def"));
    }

    #[test]
    fn test_non_hex_is_not_recognized() {
        assert!(!is_existing_claude_session_id("gggg1234-def4-5678-90ab-cdef01234567"));
    }

    #[test]
    fn test_wrong_part_count_is_not_recognized() {
        // 4 parts instead of 5
        assert!(!is_existing_claude_session_id("abc12345-def4-5678-cdef01234567"));
    }

    #[test]
    fn test_wrong_part_length_is_not_recognized() {
        // part[1] is 5 chars instead of 4
        assert!(!is_existing_claude_session_id("abc12345-def45-5678-90ab-cdef01234567"));
    }

    // ── stream_value_session_id ──

    #[test]
    fn test_session_id_at_top_level() {
        let v = json!({"session_id": "abc-123", "type": "result"});
        assert_eq!(stream_value_session_id(&v), Some("abc-123".to_string()));
    }

    #[test]
    fn test_session_id_in_response_object() {
        let v = json!({"response": {"session_id": "def-456"}});
        assert_eq!(stream_value_session_id(&v), Some("def-456".to_string()));
    }

    #[test]
    fn test_session_id_deep_in_session_object() {
        let v = json!({"session": {"id": "ghi-789"}});
        assert_eq!(stream_value_session_id(&v), Some("ghi-789".to_string()));
    }

    #[test]
    fn test_session_id_none_for_empty_json() {
        let v = json!({});
        assert_eq!(stream_value_session_id(&v), None);
    }

    #[test]
    fn test_session_id_top_level_takes_priority() {
        // top-level session_id should win over nested response.session_id
        let v = json!({"session_id": "top-111", "response": {"session_id": "nested-222"}});
        assert_eq!(stream_value_session_id(&v), Some("top-111".to_string()));
    }

    // ── control_response_request_id ──

    #[test]
    fn test_request_id_at_top_level() {
        let v = json!({"request_id": "req-123", "type": "control_response"});
        assert_eq!(control_response_request_id(&v), Some("req-123".to_string()));
    }

    #[test]
    fn test_request_id_in_response_wrapper() {
        let v = json!({"response": {"request_id": "req-456"}});
        assert_eq!(control_response_request_id(&v), Some("req-456".to_string()));
    }

    #[test]
    fn test_request_id_deeply_nested() {
        let v = json!({"response": {"response": {"request_id": "req-789"}}});
        assert_eq!(control_response_request_id(&v), Some("req-789".to_string()));
    }

    #[test]
    fn test_request_id_empty_string_filtered() {
        let v = json!({"request_id": "   "});
        assert_eq!(control_response_request_id(&v), None);
    }

    #[test]
    fn test_request_id_none_when_missing() {
        let v = json!({"type": "assistant"});
        assert_eq!(control_response_request_id(&v), None);
    }

    // ── capability_item_from_value ──

    #[test]
    fn test_capability_from_string() {
        let v = json!("my-command");
        let item = capability_item_from_value(&v, "command").unwrap();
        assert_eq!(item.name, "my-command");
        assert_eq!(item.slash, "/my-command");
        assert_eq!(item.kind, "command");
    }

    #[test]
    fn test_capability_from_string_trims_whitespace() {
        let v = json!("  my-command  ");
        let item = capability_item_from_value(&v, "command").unwrap();
        assert_eq!(item.name, "my-command");
    }

    #[test]
    fn test_capability_empty_string_is_none() {
        let v = json!("   ");
        assert!(capability_item_from_value(&v, "command").is_none());
    }

    #[test]
    fn test_capability_from_object_with_name() {
        let v = json!({"name": "/my-cmd", "kind": "tool", "description": "does things"});
        let item = capability_item_from_value(&v, "fallback").unwrap();
        assert_eq!(item.name, "my-cmd"); // leading slash stripped
        assert_eq!(item.slash, "/my-cmd");
        assert_eq!(item.kind, "tool");
        assert_eq!(item.description, Some("does things".to_string()));
    }

    #[test]
    fn test_capability_from_object_with_command_field() {
        let v = json!({"command": "build"});
        let item = capability_item_from_value(&v, "fallback").unwrap();
        assert_eq!(item.name, "build");
    }

    #[test]
    fn test_capability_from_object_with_summary_field() {
        let v = json!({"name": "lint", "summary": "runs linter"});
        let item = capability_item_from_value(&v, "fallback").unwrap();
        assert_eq!(item.description, Some("runs linter".to_string()));
    }

    #[test]
    fn test_capability_empty_name_is_none() {
        let v = json!({"name": ""});
        assert!(capability_item_from_value(&v, "fallback").is_none());
    }

    // ── capabilities_from_control_response ──

    #[test]
    fn test_capabilities_from_valid_response() {
        let response = json!({
            "response": {
                "capabilities": {
                    "commands": ["build", "test"],
                    "skills": [{"name": "lint", "kind": "skill"}]
                }
            }
        });
        let caps = capabilities_from_control_response("/root", "sid-1", &response).unwrap();
        assert_eq!(caps.root, "/root");
        assert_eq!(caps.session_id, "sid-1");
        assert_eq!(caps.commands.len(), 2);
        assert_eq!(caps.skills.len(), 1);
        // slash_commands fallback: commands + skills when no slashCommands field
        assert_eq!(caps.slash_commands.len(), 3);
        assert!(caps.updated_at_ms > 0);
    }

    #[test]
    fn test_capabilities_with_slash_commands() {
        let response = json!({
            "response": {
                "capabilities": {
                    "slashCommands": [{"name": "only-this", "kind": "command"}]
                }
            }
        });
        let caps = capabilities_from_control_response("/root", "sid-2", &response).unwrap();
        assert_eq!(caps.slash_commands.len(), 1);
        assert_eq!(caps.slash_commands[0].name, "only-this");
    }

    #[test]
    fn test_capabilities_missing_capabilities_field() {
        let response = json!({"response": {"something": "else"}});
        let result = capabilities_from_control_response("/root", "sid-3", &response);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("did not include capabilities"));
    }

    // ── context_usage_from_control_response ──

    #[test]
    fn test_context_usage_from_response_wrapped() {
        let response = json!({
            "response": {
                "response": {
                    "tokens": 1234,
                    "model": "deepseek-chat"
                }
            }
        });
        let usage = context_usage_from_control_response("/root", "sid-4", &response).unwrap();
        assert_eq!(usage.root, "/root");
        assert_eq!(usage.session_id, "sid-4");
        assert!(usage.updated_at_ms > 0);
    }

    #[test]
    fn test_context_usage_from_shallow_response() {
        let response = json!({
            "response": {
                "tokens": 5678
            }
        });
        let usage = context_usage_from_control_response("/root", "sid-5", &response).unwrap();
        assert_eq!(usage.data.get("tokens").and_then(|v| v.as_u64()), Some(5678));
    }

    // ── shared_session_id ──

    #[test]
    fn test_shared_session_id_read_write() {
        let shared = Arc::new(Mutex::new("initial".to_string()));
        assert_eq!(shared_session_id(&shared), "initial");
        set_shared_session_id(&shared, "updated");
        assert_eq!(shared_session_id(&shared), "updated");
    }
}
