use crate::types::AgentPermissionState;
use crate::utils::error_to_string;

#[tauri::command]
pub fn get_agent_permission_state() -> Result<AgentPermissionState, String> {
    Ok(AgentPermissionState {
        current_mode: "default".to_string(),
        available_modes: available_permission_modes(),
    })
}

#[tauri::command]
pub fn set_agent_permission_mode(_root: String, mode: String) -> Result<AgentPermissionState, String> {
    let normalized = normalize_permission_mode(&mode)?.to_string();
    Ok(AgentPermissionState {
        current_mode: normalized,
        available_modes: available_permission_modes(),
    })
}

#[tauri::command]
pub fn respond_agent_permission(
    root: String,
    session_id: String,
    request_id: String,
    approved: bool,
    updated_input_json: Option<String>,
) -> Result<crate::types::AgentReplSendResult, String> {
    use crate::repl::claw_processes;
    use serde_json::json;

    let behavior = if approved { "allow" } else { "deny" };
    let updated_input = match &updated_input_json {
        Some(s) => serde_json::from_str::<serde_json::Value>(s).unwrap_or(json!({})),
        None => json!({}),
    };
    let payload = json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": behavior,
                "updatedInput": updated_input
            }
        }
    });

    let line = serde_json::to_string(&payload).map_err(error_to_string)?;
    let key = crate::utils::process_key(&root, &session_id);
    let mut processes = claw_processes()?;

    let proc_state = if processes.contains_key(&key) {
        processes.get_mut(&key)
    } else {
        processes
            .iter_mut()
            .find(|(_, candidate)| candidate.root == root)
            .map(|(_, candidate)| candidate)
    }
    .ok_or_else(|| "REPL process is not running for permission response".to_string())?;

    use std::io::Write;
    writeln!(proc_state.stdin, "{line}").map_err(error_to_string)?;
    proc_state.stdin.flush().map_err(error_to_string)?;

    Ok(crate::types::AgentReplSendResult { accepted: true })
}

pub fn normalize_permission_mode(value: &str) -> Result<&'static str, String> {
    match value {
        "default" => Ok("default"),
        "acceptEdits" => Ok("acceptEdits"),
        "bypassPermissions" => Ok("bypassPermissions"),
        "dontAsk" => Ok("dontAsk"),
        "plan" => Ok("plan"),
        _ => Err(format!("invalid permission mode: {value}")),
    }
}

pub fn available_permission_modes() -> Vec<String> {
    vec![
        "default".to_string(),
        "acceptEdits".to_string(),
        "bypassPermissions".to_string(),
        "dontAsk".to_string(),
        "plan".to_string(),
    ]
}

// ─── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_permission_mode_all_valid() {
        assert_eq!(normalize_permission_mode("default").unwrap(), "default");
        assert_eq!(normalize_permission_mode("acceptEdits").unwrap(), "acceptEdits");
        assert_eq!(normalize_permission_mode("bypassPermissions").unwrap(), "bypassPermissions");
        assert_eq!(normalize_permission_mode("dontAsk").unwrap(), "dontAsk");
        assert_eq!(normalize_permission_mode("plan").unwrap(), "plan");
    }

    #[test]
    fn test_normalize_permission_mode_invalid() {
        assert!(normalize_permission_mode("invalid").is_err());
        assert!(normalize_permission_mode("bypassed").is_err());
        assert!(normalize_permission_mode("prompt").is_err());
        assert!(normalize_permission_mode("").is_err());
    }

    #[test]
    fn test_available_permission_modes() {
        let modes = available_permission_modes();
        assert_eq!(modes.len(), 5);
        assert!(modes.contains(&"default".to_string()));
        assert!(modes.contains(&"acceptEdits".to_string()));
        assert!(modes.contains(&"bypassPermissions".to_string()));
        assert!(modes.contains(&"dontAsk".to_string()));
        assert!(modes.contains(&"plan".to_string()));
    }
}
