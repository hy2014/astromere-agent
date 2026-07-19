// ─── session_core.rs — Session management pure functions ───────────────
// Core logic shared by Tauri IPC and HTTP; does not depend on any framework.

use std::fs;

use serde_json::{json, Value};

use crate::types::RuntimeSessionSummary;
use crate::utils::{
    canonical_workspace_root, claude_project_sessions_dir, collect_session_files,
    now_millis, parse_jsonl_messages,
};

/// List all sessions under `root`.
pub fn list_sessions(root: &str) -> Result<Vec<RuntimeSessionSummary>, String> {
    let root_path = canonical_workspace_root(root)?;
    let sessions_dir = claude_project_sessions_dir(&root_path)?;
    let mut sessions = Vec::new();

    if sessions_dir.exists() {
        collect_session_files(&sessions_dir, &mut sessions)?;
    }

    sessions.sort_by(|a, b| b.modified_epoch_millis.cmp(&a.modified_epoch_millis));
    Ok(sessions)
}

/// Load the full data (JSONL messages) of the specified session.
pub fn load_session(root: &str, reference: &str) -> Result<Value, String> {
    let root_path = canonical_workspace_root(root)?;
    let sessions = list_sessions(root)?;
    let found = sessions
        .into_iter()
        .find(|s| s.id == reference || s.path == reference);

    if let Some(summary) = found {
        let content = fs::read_to_string(&summary.path)
            .map_err(|e| format!("failed to read session file: {e}"))?;
        let messages = parse_jsonl_messages(&content);

        // Use file creation time for created_at_ms if available,
        // otherwise fall back to modification time
        let created_at_ms = fs::metadata(&summary.path)
            .ok()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(summary.updated_at_ms);

        Ok(json!({
            "id": summary.id,
            "path": summary.path,
            "title": summary.title,
            "version": 1,
            "created_at_ms": created_at_ms,
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
        Err(format!("session not found: {reference}"))
    }
}

/// Create a new session (placeholder only; does not create a JSONL file).
pub fn create_session(root: &str) -> Result<RuntimeSessionSummary, String> {
    let root_path = canonical_workspace_root(root)?;
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

// ─── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::Path;

    fn setup_temp_root() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let root_str = root.to_str().unwrap().to_string();

        // Create sessions in the Claude project dir
        let sessions_dir = claude_project_sessions_dir(&root).unwrap();
        fs::create_dir_all(&sessions_dir).unwrap();

        // Create two test session JSONL files
        let session1_path = sessions_dir.join("abc123.jsonl");
        let mut f1 = fs::File::create(&session1_path).unwrap();
        writeln!(f1, r#"{{"role":"user","content":"hello"}}"#).unwrap();
        writeln!(f1, r#"{{"role":"assistant","content":"hi there"}}"#).unwrap();

        let session2_path = sessions_dir.join("def456.jsonl");
        let mut f2 = fs::File::create(&session2_path).unwrap();
        writeln!(f2, r#"{{"role":"user","content":"test"}}"#).unwrap();

        (tmp, root_str)
    }

    #[test]
    fn test_list_sessions_returns_all() {
        let (_tmp, root) = setup_temp_root();
        let sessions = list_sessions(&root).unwrap();
        assert_eq!(sessions.len(), 2);
    }

    #[test]
    fn test_list_sessions_sorts_by_mtime_desc() {
        let (_tmp, root) = setup_temp_root();
        let sessions = list_sessions(&root).unwrap();
        // The later-created file has a larger mtime and should sort first.
        assert!(sessions[0].modified_epoch_millis >= sessions[1].modified_epoch_millis);
    }

    #[test]
    fn test_load_session_by_id() {
        let (_tmp, root) = setup_temp_root();
        let detail = load_session(&root, "abc123").unwrap();
        assert_eq!(detail["id"], "abc123");
        assert_eq!(detail["message_count"], 2);
    }

    #[test]
    fn test_load_session_not_found() {
        let (_tmp, root) = setup_temp_root();
        let result = load_session(&root, "nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_create_session_has_id() {
        let (_tmp, root) = setup_temp_root();
        let session = create_session(&root).unwrap();
        assert!(session.id.starts_with("new-"));
        assert_eq!(session.message_count, 0);
    }

    #[test]
    fn test_session_id_preserved_on_load() {
        let (_tmp, root) = setup_temp_root();
        let detail = load_session(&root, "abc123").unwrap();
        // sessionId matches the JSONL file name.
        assert_eq!(detail["id"], "abc123");
    }

    #[test]
    fn test_empty_sessions_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_str().unwrap().to_string();
        // Create the sessions directory but place no files in it.
        let sessions_dir = claude_project_sessions_dir(Path::new(&root)).unwrap();
        fs::create_dir_all(&sessions_dir).unwrap();

        let sessions = list_sessions(&root).unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_invalid_root() {
        let result = list_sessions("/nonexistent/path/12345");
        assert!(result.is_err());
    }

    // ── load_session by path (not id) ──

    #[test]
    fn test_load_session_by_path() {
        let (_tmp, root) = setup_temp_root();
        let sessions = list_sessions(&root).unwrap();
        let found = sessions.iter().find(|s| s.id == "abc123").unwrap();
        // Load using the full path (not id)
        let detail = load_session(&root, &found.path).unwrap();
        assert_eq!(detail["id"], "abc123");
    }

    // ── load_session with empty JSONL ──

    #[test]
    fn test_load_empty_jsonl_session() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let sessions_dir = claude_project_sessions_dir(&root).unwrap();
        std::fs::create_dir_all(&sessions_dir).unwrap();
        // Create an empty JSONL file
        let empty_path = sessions_dir.join("empty.jsonl");
        std::fs::write(&empty_path, "").unwrap();

        let detail = load_session(root.to_str().unwrap(), "empty").unwrap();
        assert_eq!(detail["message_count"], 0);
        assert!(detail["messages"].as_array().unwrap().is_empty());
    }

    // ── load_session with corrupted JSONL ──

    #[test]
    fn test_load_session_with_corrupted_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let sessions_dir = claude_project_sessions_dir(&root).unwrap();
        std::fs::create_dir_all(&sessions_dir).unwrap();

        let path = sessions_dir.join("corrupt.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, r#"{{"role":"user","content":"good"}}"#).unwrap();
        writeln!(f, r#"this is not json"#).unwrap();
        writeln!(f, r#"{{"role":"assistant","content":"also good"}}"#).unwrap();

        let detail = load_session(root.to_str().unwrap(), "corrupt").unwrap();
        // Corrupted lines should be skipped by parse_jsonl_messages
        assert!(detail["message_count"].as_u64().unwrap() >= 1);
    }

    // ── load_session created_at_ms vs updated_at_ms ──

    #[test]
    fn test_session_created_at_vs_updated_at() {
        let (_tmp, root) = setup_temp_root();
        let detail = load_session(&root, "abc123").unwrap();
        // created_at_ms should use file creation time (or fall back to updated_at_ms)
        let created = detail["created_at_ms"].as_u64().unwrap();
        let updated = detail["updated_at_ms"].as_u64().unwrap();
        // created_at_ms should be <= updated_at_ms (creation can't be after modification)
        assert!(created <= updated, "created_at_ms ({created}) should be <= updated_at_ms ({updated})");
    }
}
