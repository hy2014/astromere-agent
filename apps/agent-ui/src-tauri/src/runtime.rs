use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

use crate::types::{BashRuntimeRequest, GrepRuntimeRequest, RuntimeSessionSummary};
use crate::utils::{
    canonical_workspace_root, claude_project_sessions_dir, error_to_string,
    now_millis, collect_session_files, parse_jsonl_messages,
};

#[tauri::command]
pub fn glob_runtime_search(
    root: String,
    pattern: String,
    path: Option<String>,
) -> Result<Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let base = match path {
        Some(p) if !p.is_empty() => crate::utils::resolve_workspace_path(&root_path, &p)?,
        _ => root_path,
    };

    let output = std::process::Command::new("find")
        .arg(&base)
        .arg("-name")
        .arg(&pattern)
        .output()
        .map_err(error_to_string)?;

    Ok(json!({
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "success": output.status.success()
    }))
}

#[tauri::command]
pub fn grep_runtime_search(
    root: String,
    request: GrepRuntimeRequest,
) -> Result<Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let base = match request.path {
        Some(p) if !p.is_empty() => crate::utils::resolve_workspace_path(&root_path, &p)?,
        _ => root_path,
    };

    let mut cmd = std::process::Command::new("grep");
    cmd.arg("-R").arg("-n");

    if request.case_insensitive.unwrap_or(false) {
        cmd.arg("-i");
    }

    if let Some(glob) = request.glob {
        cmd.arg(format!("--include={glob}"));
    }

    cmd.arg(&request.pattern).arg(&base);

    let output = cmd.output().map_err(error_to_string)?;
    let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if let Some(limit) = request.head_limit {
        stdout = stdout.lines().take(limit).collect::<Vec<_>>().join("\n");
    }

    Ok(json!({
        "stdout": stdout,
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "success": output.status.success(),
        "output_mode": request.output_mode.unwrap_or_else(|| "content".to_string())
    }))
}

#[tauri::command]
pub fn execute_runtime_bash(
    root: String,
    request: BashRuntimeRequest,
) -> Result<Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let output = std::process::Command::new("bash")
        .arg("-lc")
        .arg(&request.command)
        .current_dir(&root_path)
        .output()
        .map_err(error_to_string)?;

    Ok(json!({
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "success": output.status.success(),
        "timeout_ms": request.timeout_ms
    }))
}

#[tauri::command]
pub fn list_runtime_sessions(root: String) -> Result<Vec<RuntimeSessionSummary>, String> {
    let root_path = canonical_workspace_root(&root)?;
    let sessions_dir = claude_project_sessions_dir(&root_path)?;
    let mut sessions = Vec::new();

    if sessions_dir.exists() {
        collect_session_files(&sessions_dir, &mut sessions)?;
    }

    sessions.sort_by(|a, b| b.modified_epoch_millis.cmp(&a.modified_epoch_millis));
    Ok(sessions)
}

#[tauri::command]
pub fn load_runtime_session(root: String, reference: String) -> Result<Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let sessions = list_runtime_sessions(root)?;
    let found = sessions
        .into_iter()
        .find(|s| s.id == reference || s.path == reference);

    if let Some(summary) = found {
        let content = fs::read_to_string(&summary.path)
            .map_err(|e| format!("failed to read session file: {e}"))?;
        let messages = parse_jsonl_messages(&content);

        Ok(json!({
            "id": summary.id,
            "path": summary.path,
            "title": summary.title,
            "version": 1,
            "created_at_ms": summary.updated_at_ms,
            "updated_at_ms": summary.updated_at_ms,
            "message_count": messages.len(),
            "prompt_history_count": 0,
            "model": null,
            "workspace_root": root_path.to_string_lossy().to_string(),
            "has_compaction": false,
            "messages": messages,
            "fork": null
        }))
    } else {
        Err("session not found".to_string())
    }
}

#[allow(dead_code)]
fn find_session_file(
    dir: &PathBuf,
    session_id: &str,
    found: &mut Option<PathBuf>,
) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(error_to_string)? {
        let entry = entry.map_err(error_to_string)?;
        let path = entry.path();
        if path.is_dir() {
            find_session_file(&path, session_id, found)?;
            if found.is_some() {
                return Ok(());
            }
        } else if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
            if name == session_id || name.starts_with(&format!("{session_id}_")) {
                *found = Some(path);
                return Ok(());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn create_runtime_session(root: String) -> Result<RuntimeSessionSummary, String> {
    let root_path = canonical_workspace_root(&root)?;
    let id = format!("new-{}", now_millis());

    Ok(RuntimeSessionSummary {
        id,
        title: "New session".to_string(),
        path: claude_project_sessions_dir(&root_path)?
            .to_string_lossy()
            .to_string(),
        updated_at_ms: now_millis() as u64,
        modified_epoch_millis: now_millis(),
        message_count: 0,
        parent_session_id: None,
        branch_name: None,
    })
}
