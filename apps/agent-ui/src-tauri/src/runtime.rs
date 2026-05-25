use serde_json::Value;
use std::fs;
use std::path::PathBuf;

use crate::types::{
    BashRuntimeRequest, GrepRuntimeRequest, RuntimeSessionSummary,
};
use crate::utils::{
    canonical_workspace_root, error_to_string, claude_project_sessions_dir,
    session_title, now_millis, collect_session_files,
};

#[tauri::command]
pub fn glob_runtime_search(
    root: String,
    pattern: String,
    path: Option<String>,
) -> Result<Vec<String>, String> {
    let root_path = canonical_workspace_root(&root)?;

    let search_dir = match &path {
        Some(p) => {
            let dir = root_path.join(p);
            if !dir.is_dir() {
                return Err(format!("directory not found: {p}"));
            }
            dir
        }
        None => root_path.clone(),
    };

    let pattern_path = PathBuf::from(&pattern);
    let file_name = pattern_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&pattern);
    let parent_pattern = pattern_path.parent().and_then(|p| p.to_str());

    let mut results = Vec::new();
    let walker = walkdir::WalkDir::new(&search_dir)
        .max_depth(10)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules" && name != "target"
        });

    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.contains(file_name) {
            continue;
        }
        if let Some(parent) = parent_pattern {
            if let Some(entry_parent) = entry.path().parent() {
                let rel = entry_parent
                    .strip_prefix(&search_dir)
                    .unwrap_or(entry_parent);
                if !rel.to_string_lossy().contains(parent) {
                    continue;
                }
            }
        }
        let rel_path = entry
            .path()
            .strip_prefix(&root_path)
            .unwrap_or(entry.path());
        results.push(rel_path.to_string_lossy().to_string());
        if results.len() >= 50 {
            break;
        }
    }

    Ok(results)
}

#[tauri::command]
pub fn grep_runtime_search(
    root: String,
    request: GrepRuntimeRequest,
) -> Result<Vec<String>, String> {
    let root_path = canonical_workspace_root(&root)?;
    let mut cmd = std::process::Command::new("rg");

    cmd.arg("--no-heading")
        .arg("--line-number")
        .arg("--color")
        .arg("never");

    if let Some(glob) = &request.glob {
        cmd.arg("--glob").arg(glob);
    }

    if request.case_insensitive.unwrap_or(false) {
        cmd.arg("-i");
    }

    if let Some(limit) = request.head_limit {
        cmd.arg("-m").arg(limit.to_string());
    }

    cmd.arg(&request.pattern);

    if let Some(search_path) = &request.path {
        cmd.arg(root_path.join(search_path));
    } else {
        cmd.arg(&root_path);
    }

    let output = cmd.output()
        .map_err(|e| format!("failed to run ripgrep: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let results: Vec<String> = stdout
        .lines()
        .map(|l| l.to_string())
        .collect();

    Ok(results)
}

#[tauri::command]
pub fn execute_runtime_bash(
    root: String,
    request: BashRuntimeRequest,
) -> Result<Value, String> {
    let root_path = canonical_workspace_root(&root)?;

    let timeout_ms = request.timeout_ms.unwrap_or(30_000);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string());

    let mut cmd = std::process::Command::new(&shell);
    cmd.arg("-c")
        .arg(&request.command)
        .current_dir(&root_path);

    let child = cmd.spawn()
        .map_err(|e| format!("failed to spawn bash: {e}"))?;

    let start = std::time::Instant::now();
    let output = child.wait_with_output()
        .map_err(|e| format!("failed to wait for bash: {e}"))?;
    let elapsed = start.elapsed().as_millis() as u64;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(serde_json::json!({
        "exit_code": output.status.code().unwrap_or(-1),
        "stdout": stdout,
        "stderr": stderr,
        "elapsed_ms": elapsed,
        "timed_out": elapsed >= timeout_ms
    }))
}

#[tauri::command]
pub fn list_runtime_sessions(root: String) -> Result<Vec<RuntimeSessionSummary>, String> {
    let root_path = canonical_workspace_root(&root)?;
    let sessions_dir = claude_project_sessions_dir(&root_path)?;

    let mut sessions = Vec::new();
    collect_session_files(&sessions_dir, &mut sessions)?;

    sessions.sort_by(|a, b| b.modified_epoch_millis.cmp(&a.modified_epoch_millis));

    Ok(sessions)
}

#[tauri::command]
pub fn load_runtime_session(root: String, reference: String) -> Result<Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let sessions_dir = claude_project_sessions_dir(&root_path)?;

    let session_path = if reference.contains('/') || reference.contains('\\') {
        PathBuf::from(&reference)
    } else {
        let mut found = None;
        find_session_file(&sessions_dir, &reference, &mut found)?;
        found.ok_or_else(|| format!("session not found: {reference}"))?
    };

    let content = fs::read_to_string(&session_path)
        .map_err(|e| format!("failed to read session file: {e}"))?;

    let messages: Vec<Value> = content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str(line).ok()
        })
        .collect();

    let session_id = reference.clone();

    Ok(serde_json::json!({
        "sessionId": session_id,
        "messages": messages,
        "messageCount": messages.len()
    }))
}

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
    let session_id = crate::utils::generate_agent_ui_session_id();
    let sessions_dir = claude_project_sessions_dir(&root_path)?;

    fs::create_dir_all(&sessions_dir)
        .map_err(|e| format!("failed to create sessions dir: {e}"))?;

    let session_path = sessions_dir.join(format!("{session_id}.jsonl"));

    fs::write(&session_path, "")
        .map_err(|e| format!("failed to create session file: {e}"))?;

    let now = now_millis();

    Ok(RuntimeSessionSummary {
        id: session_id.clone(),
        title: session_title(&session_id, 0),
        path: session_path.to_string_lossy().to_string(),
        updated_at_ms: now as u64,
        modified_epoch_millis: now,
        message_count: 0,
        parent_session_id: None,
        branch_name: None,
    })
}
