use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

use crate::types::{BashRuntimeRequest, GrepRuntimeRequest, RuntimeSessionSummary};
use crate::utils::{canonical_workspace_root, error_to_string};

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
    crate::session_core::list_sessions(&root)
}

#[tauri::command]
pub fn load_runtime_session(root: String, reference: String) -> Result<Value, String> {
    crate::session_core::load_session(&root, &reference)
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
    crate::session_core::create_session(&root)
}
