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
    format!("{}::{}", root, session_id)
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
    let raw = serde_json::to_string(value).unwrap_or_else(|_| "<unserializable json>".to_string());
    format!(
        "type={} raw={}",
        event_type,
        truncate_for_log(&raw, 1600)
    )
}

pub fn repo_root() -> Result<PathBuf, String> {
    let manifest_dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = manifest_dir
        .parent()
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
    path.to_string_lossy()
        .replace('/', "_")
        .replace('\\', "_")
        .replace(':', "_")
}

pub fn claude_project_sessions_dir(root: &Path) -> Result<PathBuf, String> {
    let config_dir = claude_config_dir()?;
    let project_name = sanitize_claude_project_path(root);
    Ok(config_dir
        .join("projects")
        .join(project_name)
        .join("sessions"))
}

pub fn canonical_workspace_root(root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(root);
    if path.is_relative() {
        return Err(format!("workspace root must be an absolute path: {root}"));
    }
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
    let path = path.trim();
    if let Some(stripped) = path.strip_prefix("./") {
        stripped.to_string()
    } else if let Some(stripped) = path.strip_prefix(".\\") {
        stripped.to_string()
    } else {
        path.to_string()
    }
}

pub fn model_settings_path() -> Result<PathBuf, String> {
    let dir = ui_config_dir()?;
    Ok(dir.join("models.json"))
}

pub fn workspace_registry_path() -> Result<PathBuf, String> {
    let dir = ui_config_dir()?;
    Ok(dir.join("workspaces.json"))
}

pub fn read_workspace_registry() -> Result<WorkspaceRegistry, String> {
    let path = workspace_registry_path()?;
    if !path.is_file() {
        return Ok(WorkspaceRegistry::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read workspace registry: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse workspace registry: {e}"))
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
    if let Ok(rel) = path.strip_prefix("/") {
        format!("/{}", rel.display())
    } else {
        path.display().to_string()
    }
}

pub fn language_for_path(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "rs" => "rust".to_string(),
        "ts" | "tsx" => "typescript".to_string(),
        "js" | "jsx" | "mjs" => "javascript".to_string(),
        "py" => "python".to_string(),
        "json" => "json".to_string(),
        "md" | "mdx" => "markdown".to_string(),
        "css" => "css".to_string(),
        "html" => "html".to_string(),
        "yaml" | "yml" => "yaml".to_string(),
        "sh" | "bash" | "zsh" => "shell".to_string(),
        "toml" => "toml".to_string(),
        "sql" => "sql".to_string(),
        _ => "text".to_string(),
    }
}

pub fn session_title(session_id: &str, message_count: usize) -> String {
    if message_count > 0 {
        format!("Session #{}", &session_id[..8])
    } else {
        "New Session".to_string()
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
    if !dir.is_dir() {
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("failed to read sessions dir: {e}"))?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.path());

    for entry in entries {
        let path = entry.path();
        if path.is_dir() && !is_subagent_transcript_path(&path) {
            collect_session_files(&path, out)?;
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(_metadata) = fs::metadata(&path) else { continue };
        let modified_epoch = modified_epoch_millis(&path).unwrap_or(0);
        let file_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let session_id = if file_name.contains('_') {
            file_name.split('_').next().unwrap_or(&file_name).to_string()
        } else {
            file_name.clone()
        };
        let content = fs::read_to_string(&path).unwrap_or_default();
        let message_count = parse_jsonl_messages(&content).len();
        let title = first_user_title_from_jsonl(&content)
            .unwrap_or_else(|| session_title(&session_id, message_count));
        let parent_session_id = extract_parent_session_id(&content);

        let sub_dir = path.parent().and_then(|p| {
            if p == dir { None } else { p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()) }
        });

        let branch_name = sub_dir;

        out.push(RuntimeSessionSummary {
            id: session_id,
            title,
            path: path.to_string_lossy().to_string(),
            updated_at_ms: modified_epoch as u64,
            modified_epoch_millis: modified_epoch,
            message_count,
            parent_session_id,
            branch_name,
        });
    }
    Ok(())
}

fn is_subagent_transcript_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

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

fn parse_jsonl_messages(content: &str) -> Vec<Value> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str(line).ok()
        })
        .collect()
}

fn first_user_title_from_jsonl(content: &str) -> Option<String> {
    for line in content.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(text) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
            {
                let text = text.trim();
                if !text.is_empty() && looks_like_real_user_title(text) {
                    return Some(truncate_title(text, 80));
                }
            }
        }
    }
    None
}

fn looks_like_real_user_title(text: &str) -> bool {
    let text = text.trim();
    if text.len() < 3 {
        return false;
    }
    !text.starts_with('/')
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
