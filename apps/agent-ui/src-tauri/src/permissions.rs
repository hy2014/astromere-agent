use crate::types::AgentPermissionState;
use crate::utils::error_to_string;
use crate::mcp::astromere_mcp_config_path;

#[tauri::command]
pub fn get_agent_permission_state() -> Result<AgentPermissionState, String> {
    Ok(AgentPermissionState {
        current_mode: "default".to_string(),
        available_modes: available_permission_modes(),
    })
}

#[tauri::command]
pub fn set_agent_permission_mode(_root: String, mode: String) -> Result<AgentPermissionState, String> {
    let _ = normalize_permission_mode(&mode)?;
    Ok(AgentPermissionState {
        current_mode: mode,
        available_modes: available_permission_modes(),
    })
}

#[tauri::command]
pub fn respond_agent_permission(
    root: String,
    session_id: String,
    request_id: String,
    approved: bool,
) -> Result<crate::types::AgentReplSendResult, String> {
    use serde_json::json;
    use crate::repl::claw_processes;

    let processes = claw_processes()?;
    let key = crate::utils::process_key(&root, &session_id);
    let Some(proc) = processes.get(&key) else {
        return Err("No active process for this session".to_string());
    };

    let permission_command = if approved { "yes" } else { "no" };
    let payload = json!({
        "type": "permission",
        "permission": permission_command,
        "request_id": request_id
    });

    let line = format!("{}\n", serde_json::to_string(&payload).map_err(error_to_string)?);
    let mut stdin = &proc.stdin;
    stdin.write_all(line.as_bytes()).map_err(error_to_string)?;

    Ok(crate::types::AgentReplSendResult { accepted: true })
}

pub fn normalize_permission_mode(value: &str) -> Result<&'static str, String> {
    match value {
        "default" => Ok("default"),
        "bypassed" => Ok("bypassed"),
        "prompt" => Ok("prompt"),
        other => Err(format!(
            "invalid permission mode '{other}'; expected one of: default, bypassed, prompt"
        )),
    }
}

pub fn available_permission_modes() -> Vec<String> {
    vec![
        "default".to_string(),
        "bypassed".to_string(),
        "prompt".to_string(),
    ]
}

use std::io::Write;
