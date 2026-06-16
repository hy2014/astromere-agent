use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::{
    WorkspaceRegistry, RuntimeSessionSummary,
};

static SESSION_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn generate_agent_ui_session_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let counter = SESSION_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id() as u64;

    let high = (nanos as u64) ^ counter.rotate_left(17) ^ (pid << 32);
    let low = ((nanos >> 64) as u64) ^ counter.rotate_left(31) ^ 0xa5a5_5a5a_d3c3_b4b4u64;

    let part1 = (high >> 32) as u32;
    let part2 = ((high >> 16) & 0xffff) as u16;
    let part3 = (0x4000 | (high & 0x0fff)) as u16;
    let part4 = (0x8000 | ((low >> 48) & 0x3fff)) as u16;
    let part5 = low & 0x0000_ffff_ffff_ffff;

    format!(
        "{part1:08x}-{part2:04x}-{part3:04x}-{part4:04x}-{part5:012x}"
    )
}

pub fn process_key(root: &str, session_id: &str) -> String {
    format!("{root}\n{session_id}")
}

pub fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn error_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub fn truncate_for_log(text: &str, max_len: usize) -> String {
    if text.chars().count() <= max_len {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_len).collect();
    format!("{}…<truncated>", truncated)
}

pub fn value_summary_for_log(value: &Value) -> String {
    let event_type = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("<missing>");
    let request_id = crate::control::control_response_request_id(value)
        .or_else(|| value.get("request_id").and_then(|v| v.as_str()).map(|v| v.to_string()))
        .unwrap_or_else(|| "<none>".to_string());
    let session_id = crate::control::stream_value_session_id(value).unwrap_or_else(|| "<none>".to_string());
    let subtype = value
        .get("request")
        .and_then(|request| request.get("subtype"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("subtype"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("<none>");
    let raw = serde_json::to_string(value).unwrap_or_else(|_| "<unserializable json>".to_string());

    format!(
        "type={} request_id={} session_id={} subtype={} raw={}",
        event_type,
        request_id,
        session_id,
        subtype,
        truncate_for_log(&raw, 1600)
    )
}

pub fn repo_root() -> Result<PathBuf, String> {
    if let Ok(val) = std::env::var("ASTROMERE_REPO_ROOT") {
        let p = PathBuf::from(val);
        if p.is_dir() {
            return Ok(p);
        }
    }
    let manifest_dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| "Failed to resolve repo root from CARGO_MANIFEST_DIR".to_string())?;
    Ok(repo.to_path_buf())
}

pub fn ui_config_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "failed to resolve home directory".to_string())?;
    Ok(PathBuf::from(home).join(".agent-ui"))
}

pub fn claude_config_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "failed to resolve home directory".to_string())?;
    Ok(PathBuf::from(home).join(".claude"))
}

pub fn sanitize_claude_project_path(path: &Path) -> String {
    // path.to_string_lossy()
    //     .replace('/', "_")
    //     .replace('\\', "_")
    //     .replace(':', "_")
    path.to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

pub fn claude_project_sessions_dir(root: &Path) -> Result<PathBuf, String> {
    let config_dir = claude_config_dir()?;
    let project_name = sanitize_claude_project_path(root);
    Ok(config_dir
        .join("projects")
        .join(project_name))
}

pub fn canonical_workspace_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root).canonicalize().map_err(error_to_string)?;
    if !path.is_dir() {
        return Err(format!("workspace root is not a directory: {root}"));
    }
    Ok(path)
}

pub fn resolve_workspace_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let target = root.join(path);
    if !target.exists() {
        return Err(format!("file not found: {}", target.display()));
    }
    if !target.starts_with(root) {
        return Err(format!("path escapes workspace root: {}", target.display()));
    }
    Ok(target)
}

pub fn resolve_workspace_path_allow_missing(root: &Path, path: &str) -> Result<PathBuf, String> {
    let target = root.join(path);
    if !target.starts_with(root) {
        return Err(format!("path escapes workspace root: {}", target.display()));
    }
    Ok(target)
}

pub fn resolve_local_reference_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = normalize_reference_path_input(path);
    if let Some(abs) = expand_absolute_or_home_reference(&path) {
        if abs.starts_with(root) {
            return Ok(abs);
        }
    }
    let joined = root.join(&path);
    if joined.starts_with(root) {
        Ok(joined)
    } else {
        Err(format!(
            "local reference path {} escapes workspace root {}",
            path,
            root.display()
        ))
    }
}

pub fn normalize_reference_path_input(path: &str) -> String {
    path.trim()
        .trim_matches('`')
        .trim_matches('"')
        .trim_matches('\'')
        .replace('～', "~")
}

pub fn model_settings_path() -> Result<PathBuf, String> {
    let dir = ui_config_dir()?;
    Ok(dir.join("model-settings.json"))
}

pub fn workspace_registry_path() -> Result<PathBuf, String> {
    let dir = ui_config_dir()?;
    Ok(dir.join("workspace-registry.json"))
}

fn legacy_workspace_registry_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".agent-ui").join("workspace-registry.json")
}

pub fn read_workspace_registry() -> Result<WorkspaceRegistry, String> {
    let path = workspace_registry_path()?;
    if path.is_file() {
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("failed to read workspace registry: {e}"))?;
        return serde_json::from_str(&raw)
            .map_err(|e| format!("failed to parse workspace registry: {e}"));
    }

    // Migrate from legacy path (~/.claw-agent-ui/workspace-registry.json)
    let legacy = legacy_workspace_registry_path();
    if legacy.is_file() {
        let raw = fs::read_to_string(&legacy)
            .map_err(|e| format!("failed to read legacy workspace registry: {e}"))?;
        let registry: WorkspaceRegistry = serde_json::from_str(&raw)
            .map_err(|e| format!("failed to parse legacy workspace registry: {e}"))?;
        // Write to new location
        write_workspace_registry(&registry)?;
        // Remove legacy file
        let _ = fs::remove_file(&legacy);
        return Ok(registry);
    }

    Ok(WorkspaceRegistry::default())
}

pub fn write_workspace_registry(registry: &WorkspaceRegistry) -> Result<(), String> {
    let path = workspace_registry_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create workspace registry dir: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(registry)
        .map_err(|e| format!("failed to serialize workspace registry: {e}"))?;
    fs::write(&path, format!("{raw}\n"))
        .map_err(|e| format!("failed to write workspace registry: {e}"))
}

pub fn home_dir_path() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|home| !home.trim().is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(PathBuf::from)
}

pub fn expand_absolute_or_home_reference(value: &str) -> Option<PathBuf> {
    if value.starts_with("~/") || value == "~" {
        let home = home_dir_path()?;
        if value == "~" {
            Some(home)
        } else {
            Some(home.join(value.strip_prefix("~/").unwrap()))
        }
    } else if Path::new(value).is_absolute() {
        Some(PathBuf::from(value))
    } else {
        None
    }
}

pub fn is_absolute_or_home_reference(value: &str) -> bool {
    value.starts_with('/') || value.starts_with("~/") || value == "~"
}

pub fn display_local_reference_path(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if let Some(home) = home_dir_path().and_then(|home| home.canonicalize().ok()) {
        if let Ok(relative) = canonical.strip_prefix(&home) {
            let suffix = relative.to_string_lossy().replace('\\', "/");
            return if suffix.is_empty() {
                "~".to_string()
            } else {
                format!("~/{suffix}")
            };
        }
    }
    canonical.to_string_lossy().replace('\\', "/")
}

pub fn language_for_path(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
    {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "json" => "json",
        "md" => "markdown",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "html" => "html",
        "css" => "css",
        other => other,
    }
    .to_string()
}

pub fn session_title(session_id: &str, message_count: usize) -> String {
    if message_count == 0 {
        "New session".to_string()
    } else {
        format!("{session_id} ({message_count} messages)")
    }
}

pub fn is_supported_image_path(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg") => true,
        _ => false,
    }
}

pub fn image_mime_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

pub fn collect_session_files(dir: &Path, out: &mut Vec<RuntimeSessionSummary>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(error_to_string)? {
        let entry = entry.map_err(error_to_string)?;
        let path = entry.path();

        if path.is_dir() {
            if path.file_name().and_then(|s| s.to_str()) == Some("subagents") {
                continue;
            }

            collect_session_files(&path, out)?;
            continue;
        }

        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }

        if is_subagent_transcript_path(&path) {
            continue;
        }
        let metadata = fs::metadata(&path).map_err(error_to_string)?;
        let modified = metadata.modified().unwrap_or(SystemTime::now());
        let modified_ms = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let content = fs::read_to_string(&path).unwrap_or_default();
        let message_count = content.lines().filter(|l| !l.trim().is_empty()).count();
        let id = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        out.push(RuntimeSessionSummary {
            id: id.clone(),
            title: first_user_title_from_jsonl(&content)
                .unwrap_or_else(|| session_title(&id, message_count)),
            path: path.to_string_lossy().to_string(),
            updated_at_ms: modified_ms as u64,
            modified_epoch_millis: modified_ms,
            message_count,
            parent_session_id: None,
            branch_name: None
        });
    }

    Ok(())
}

fn is_subagent_transcript_path(path: &Path) -> bool {
    let under_subagents = path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|name| name == "subagents")
            .unwrap_or(false)
    });
    if under_subagents {
        return true;
    }
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
        .unwrap_or(false)
}

#[allow(dead_code)]
fn modified_epoch_millis(path: &Path) -> Option<u128> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    Some(
        modified
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis(),
    )
}

#[allow(dead_code)]
fn extract_parent_session_id(content: &str) -> Option<String> {
    for line in content.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(parent_id) = value.get("parent_session_id").and_then(|v| v.as_str()) {
                return Some(parent_id.to_string());
            }
        }
    }
    None
}

fn first_user_title_from_jsonl(content: &str) -> Option<String> {
    for line in content.lines() {
        let value = serde_json::from_str::<Value>(line).ok()?;

        if value
            .get("isMeta")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }

        let role = value
            .get("message")
            .and_then(|m| m.get("role"))
            .or_else(|| value.get("role"))
            .and_then(|v| v.as_str());

        let event_type = value.get("type").and_then(|v| v.as_str());

        if role != Some("user") && event_type != Some("user") {
            continue;
        }

        let content_value = value
            .get("message")
            .and_then(|m| m.get("content"))
            .or_else(|| value.get("content"))
            .or_else(|| value.get("text"));

        let title = content_value
            .map(extract_text_from_json_value)
            .unwrap_or_default()
            .trim()
            .replace('\n', " ");

        if title.is_empty() {
            continue;
        }

        if !looks_like_real_user_title(&title) {
            continue;
        }

        return Some(truncate_title(&title, 80));
    }

    None
}

fn looks_like_real_user_title(title: &str) -> bool {
    let trimmed = title.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') || trimmed.starts_with("[Request interrupted")
    {
        return false;
    }

    let lower = trimmed.to_lowercase();
    let skipped_prefixes = [
        "<system-reminder",
        "tool_result",
        "tool result",
        "system:",
        "context:",
        "cwd:",
        "this session is being continued",
        "we need continue",
        "here is a summary",
        "automatic context",
        "auto context",
    ];

    !skipped_prefixes
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

fn truncate_title(value: &str, max_chars: usize) -> String {
    let text = value.trim();
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max_chars - 1).collect::<String>())
    }
}

use std::fs;

// ─── jsonl session message parsing (migrated from stable) ──────────────────

/// Extract text content from a Claude Code jsonl value.
/// Handles both plain text strings and Anthropic API content blocks (array of {type, text}).
pub fn extract_text_from_json_value(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }

    if let Some(items) = value.as_array() {
        let mut parts = Vec::new();
        for item in items {
            let item_type = item.get("type").and_then(|v| v.as_str());
            if item_type == Some("text") {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    parts.push(text.to_string());
                }
            } else if item_type.is_none() {
                let text = extract_text_from_json_value(item);
                if !text.trim().is_empty() {
                    parts.push(text);
                }
            }
        }
        return parts.join(" ");
    }

    String::new()
}

/// Check if a json value or any of its children contains a specific "type" field.
fn json_value_contains_type(value: &Value, expected_type: &str) -> bool {
    if value.get("type").and_then(|v| v.as_str()) == Some(expected_type) {
        return true;
    }
    match value {
        Value::Array(items) => items
            .iter()
            .any(|item| json_value_contains_type(item, expected_type)),
        Value::Object(map) => map
            .values()
            .any(|item| json_value_contains_type(item, expected_type)),
        _ => false,
    }
}

/// Extract message.id from the raw jsonl structure.
fn canonical_message_id_from_raw_json(value: &Value) -> Option<&str> {
    value
        .get("message")
        .and_then(|message| message.get("id"))
        .and_then(|id| id.as_str())
        .filter(|id| !id.trim().is_empty())
}

/// Parse a jsonl session file into normalized {id, role, text, event_type, raw_json} messages.
pub fn parse_jsonl_messages(content: &str) -> Vec<Value> {
    content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let value = serde_json::from_str::<Value>(line).ok()?;

            if value
                .get("isMeta")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                return None;
            }

            let event_type = value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("system")
                .to_string();
            let role = value
                .get("message")
                .and_then(|m| m.get("role"))
                .or_else(|| value.get("role"))
                .or_else(|| value.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("system");

            let has_tool_result_content = json_value_contains_type(&value, "tool_result");
            let normalized_role = if event_type == "tool_result" || has_tool_result_content {
                "tool"
            } else {
                match role {
                    "assistant" => "assistant",
                    "result" => "assistant",
                    "user" => "user",
                    "tool" | "tool_result" => "tool",
                    _ => "system",
                }
            };

            let content_value = value
                .get("message")
                .and_then(|m| m.get("content"))
                .or_else(|| value.get("content"))
                .or_else(|| value.get("text"))
                .or_else(|| value.get("result"));

            let text = content_value
                .map(extract_text_from_json_value)
                .unwrap_or_default()
                .trim()
                .to_string();

            let has_tool_use = extract_tool_uses_from_jsonl(&value).len() > 0;
            let keep_for_debug = has_tool_use
                || matches!(
                    event_type.as_str(),
                    "assistant" | "result" | "tool_result" | "user"
                )
                || normalized_role == "tool";

            if text.is_empty() && !keep_for_debug {
                return None;
            }

            let message_id = canonical_message_id_from_raw_json(&value);
            let uuid = value
                .get("uuid")
                .and_then(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .map(|v| v.to_string());
            let parent_uuid = value
                .get("parentUuid")
                .or_else(|| value.get("parent_uuid"))
                .and_then(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .map(|v| v.to_string());

            Some(serde_json::json!({
                "id": message_id
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| format!("missing-message-id-{index}")),
                "uuid": uuid,
                "parentUuid": parent_uuid,
                "role": normalized_role,
                "text": text,
                "event_type": event_type,
                "bind_status": if message_id.is_some() { "ok" } else { "missing_message_id" },
                "raw_json": value
            }))
        })
        .collect()
}

/// Extract tool_use blocks from a raw jsonl value (used by parse_jsonl_messages).
pub fn extract_tool_uses_from_jsonl(value: &Value) -> Vec<Value> {
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

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── canonical_workspace_root ──

    #[test]
    fn test_canonical_workspace_root_valid_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let path = canonical_workspace_root(tmp.path().to_str().unwrap()).unwrap();
        assert!(path.is_dir());
    }

    #[test]
    fn test_canonical_workspace_root_nonexistent() {
        let result = canonical_workspace_root("/nonexistent/path/xyz12345");
        assert!(result.is_err());
    }

    // ── sanitize_claude_project_path ──

    #[test]
    fn test_sanitize_claude_project_path_replaces_special_chars() {
        let result = sanitize_claude_project_path(std::path::Path::new("/Users/foo/workspace"));
        assert!(!result.contains('/'));
        assert!(!result.contains(':'));
        // All chars should be ascii alphanumeric or '-'
        assert!(result.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    // ── truncate_for_log ──

    #[test]
    fn test_truncate_for_log_short_text() {
        assert_eq!(truncate_for_log("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_for_log_long_text() {
        let result = truncate_for_log("hello world this is long", 10);
        assert!(result.ends_with("<truncated>"));
        assert!(result.len() <= 10 + "<truncated>".len() + 3); // … is 3 bytes in UTF-8
    }

    // ── session_title ──

    #[test]
    fn test_session_title_zero_messages() {
        assert_eq!(session_title("abc-123", 0), "New session");
    }

    #[test]
    fn test_session_title_with_messages() {
        let title = session_title("abc-123", 5);
        assert!(title.contains("abc-123"));
        assert!(title.contains("5 messages"));
    }

    // ── normalize_reference_path_input ──

    #[test]
    fn test_normalize_reference_path_trims_quotes() {
        assert_eq!(normalize_reference_path_input("`/path/to/file`"), "/path/to/file");
        assert_eq!(normalize_reference_path_input("\"/path\""), "/path");
        assert_eq!(normalize_reference_path_input("'/path'"), "/path");
    }

    #[test]
    fn test_normalize_reference_path_trims_whitespace() {
        assert_eq!(normalize_reference_path_input("  /path  "), "/path");
    }

    #[test]
    fn test_normalize_reference_path_replaces_fullwidth_tilde() {
        // ～ (fullwidth tilde, U+FF5E) should become ~
        assert_eq!(normalize_reference_path_input("～/docs"), "~/docs");
    }

    // ── extract_text_from_json_value ──

    #[test]
    fn test_extract_text_from_plain_string() {
        let v = serde_json::json!("hello world");
        assert_eq!(extract_text_from_json_value(&v), "hello world");
    }

    #[test]
    fn test_extract_text_from_content_blocks() {
        let v = serde_json::json!([
            {"type": "text", "text": "Hello "},
            {"type": "text", "text": "World"}
        ]);
        // Content blocks are joined with a single space; note first
        // block "Hello " already has trailing space, so result is "Hello  World"
        assert_eq!(extract_text_from_json_value(&v), "Hello  World");
    }

    #[test]
    fn test_extract_text_from_empty_array() {
        let v = serde_json::json!([]);
        assert_eq!(extract_text_from_json_value(&v), "");
    }

    // ── is_absolute_or_home_reference ──

    #[test]
    fn test_is_absolute_or_home_reference() {
        assert!(is_absolute_or_home_reference("/absolute/path"));
        assert!(is_absolute_or_home_reference("~/docs"));
        assert!(is_absolute_or_home_reference("~"));
        assert!(!is_absolute_or_home_reference("relative/path"));
        assert!(!is_absolute_or_home_reference("./relative"));
    }

    // ── expand_absolute_or_home_reference ──

    #[test]
    fn test_expand_home_reference() {
        let result = expand_absolute_or_home_reference("~/docs");
        assert!(result.is_some());
        let path = result.unwrap();
        assert!(path.to_string_lossy().ends_with("/docs"));
    }

    #[test]
    fn test_expand_absolute_path() {
        let result = expand_absolute_or_home_reference("/tmp/test");
        assert_eq!(result, Some(std::path::PathBuf::from("/tmp/test")));
    }

    #[test]
    fn test_expand_relative_path_is_none() {
        assert_eq!(expand_absolute_or_home_reference("relative/path"), None);
    }

    // ── process_key ──

    #[test]
    fn test_process_key_format() {
        let key = process_key("/root", "abc-123");
        assert_eq!(key, "/root\nabc-123");
    }

    // ── generate_agent_ui_session_id ──

    #[test]
    fn test_session_id_is_uuid_format() {
        let id = generate_agent_ui_session_id();
        assert_eq!(id.len(), 36);
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 4);
        assert_eq!(parts[2].len(), 4);
        assert_eq!(parts[3].len(), 4);
        assert_eq!(parts[4].len(), 12);
    }

    #[test]
    fn test_session_id_unique() {
        let id1 = generate_agent_ui_session_id();
        let id2 = generate_agent_ui_session_id();
        assert_ne!(id1, id2);
    }

    // ── parse_jsonl_messages ──

    #[test]
    fn test_parse_jsonl_with_meta_message_skipped() {
        let content = r#"{"isMeta":true,"message":{"role":"user","content":"skip me"}}
{"type":"user","message":{"role":"user","content":"real message"}}"#;
        let messages = parse_jsonl_messages(content);
        // Meta messages should be skipped, only the real one remains
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
    }

    #[test]
    fn test_parse_jsonl_empty_content() {
        let messages = parse_jsonl_messages("");
        assert!(messages.is_empty());
    }

    #[test]
    fn test_parse_jsonl_corrupted_lines_skipped() {
        let content = r#"not json at all
{"type":"user","message":{"role":"user","content":"valid"}}"#;
        let messages = parse_jsonl_messages(content);
        // Corrupted line should be skipped
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn test_parse_jsonl_messages_have_text_field() {
        // Use a real jsonl session file to verify the parser produces valid {id, role, text} output
        let home = std::env::var("HOME").unwrap_or_default();
        let _possible_roots = [
            format!("{}/workspace/astromere-infra", home),
            format!("{}/workspace/claude-code/apps/agent-ui", home),
        ];

        // Verify that claude_project_sessions_dir resolves to the right path
        // by checking that the test workspace root is found
        let test_root = std::path::PathBuf::from("/Users/nazario.wang/workspace/astromere-infra");
        let resolved = claude_project_sessions_dir(&test_root).unwrap();
        assert!(resolved.exists(), "sessions dir should exist: {:?}", resolved);
        eprintln!("VERIFIED: sessions dir {:?} exists", resolved);

        // Try to find jsonl files from any claude project directory
        let projects_dir = std::path::PathBuf::from(&home).join(".claude").join("projects");

        let mut tested = false;
        if projects_dir.is_dir() {
            for project_entry in std::fs::read_dir(&projects_dir).unwrap() {
                let project_entry = project_entry.unwrap();
                let project_path = project_entry.path();
                if !project_path.is_dir() {
                    continue;
                }
                // Check project root (no /sessions subdir) and /sessions subdir
                let search_dirs: Vec<std::path::PathBuf> = if project_path.join("sessions").is_dir() {
                    vec![project_path.join("sessions"), project_path.clone()]
                } else {
                    vec![project_path.clone()]
                };
                for search_dir in &search_dirs {
                for entry in std::fs::read_dir(search_dir).unwrap() {
                    let entry = entry.unwrap();
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let content = std::fs::read_to_string(&path).unwrap();
                    let messages = parse_jsonl_messages(&content);
                    assert!(!messages.is_empty(), "should parse messages from {:?}", path);
                    for msg in &messages {
                        let text = msg.get("text");
                        assert!(text.is_some(), "message missing 'text' field in {:?}: {:?}", path, msg.get("id"));
                        assert!(text.unwrap().is_string(), "'text' should be string, got {:?}", text);
                        assert!(msg.get("role").is_some(), "message missing 'role' field");
                        assert!(msg.get("id").is_some(), "message missing 'id' field");
                    }
                    eprintln!(
                        "PASS: parsed {} messages from {:?} (project {:?}), all have id+role+text",
                        messages.len(),
                        path.file_name().unwrap(),
                        project_path.file_name().unwrap(),
                    );
                    tested = true;
                    break;
                }
                if tested {
                    break;
                }
            }
            if tested {
                break;
            }
            }
        }

        if !tested {
            eprintln!("SKIP: no jsonl session files found (may run in CI without real data)");
        }
    }
}
