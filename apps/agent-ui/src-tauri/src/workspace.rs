use base64::{engine::general_purpose, Engine as _};
use std::fs;
use std::path::{Path, PathBuf};

use crate::types::{
    FileView, GitDiff, LocalImageMetadata, LocalImagePreview, ProjectEntry,
    ProjectEntryKind, WorkspaceFileReference, WorkspaceRegistry,
    WorkspaceRegistryEntry, WorkspaceState,
};
use crate::utils::{
    canonical_workspace_root, display_local_reference_path, error_to_string,
    expand_absolute_or_home_reference, is_absolute_or_home_reference,
    is_supported_image_path, image_mime_for_path,
    language_for_path, read_workspace_registry, resolve_workspace_path,
    resolve_workspace_path_allow_missing, write_workspace_registry,
};

#[allow(dead_code)]
fn is_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "dist"
            | "target"
            | "build"
            | ".next"
            | ".nuxt"
            | ".turbo"
            | ".cache"
            | ".bun"
            | ".venv"
            | "venv"
            | "__pycache__"
            | "coverage"
            | "vendor"
    )
}

fn is_ignored_file_reference_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "dist"
            | "target"
            | "build"
            | ".next"
            | ".nuxt"
            | ".turbo"
            | ".cache"
            | ".bun"
            | ".venv"
            | "venv"
            | "__pycache__"
            | "coverage"
            | "vendor"
    )
}

fn normalize_reference_query(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('@')
        .replace('～', "~")
        .to_ascii_lowercase()
        .replace('\\', "/")
}

fn raw_reference_query(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('@')
        .replace('～', "~")
        .replace('\\', "/")
}

fn resolve_local_reference_file_path(root: &Path, path: &str) -> Result<(PathBuf, String), String> {
    let raw_path = raw_reference_query(path);
    if raw_path.is_empty() {
        return Err("empty file reference path".to_string());
    }

    if is_absolute_or_home_reference(&raw_path) {
        let expanded = expand_absolute_or_home_reference(&raw_path)
            .ok_or_else(|| format!("invalid file reference path: {path}"))?;
        let resolved = expanded.canonicalize().map_err(error_to_string)?;
        if !resolved.is_file() {
            return Err("referenced path is not a file".to_string());
        }
        let display_path = crate::utils::display_local_reference_path(&resolved);
        return Ok((resolved, display_path));
    }

    let resolved = resolve_workspace_path(root, &raw_path)?;
    if !resolved.is_file() {
        return Err("referenced path is not a file".to_string());
    }
    Ok((resolved, raw_path))
}

fn fuzzy_contains(value: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let mut query_chars = query.chars();
    let mut current = match query_chars.next() {
        Some(ch) => ch,
        None => return true,
    };
    for ch in value.chars() {
        if ch == current {
            match query_chars.next() {
                Some(next) => current = next,
                None => return true,
            }
        }
    }
    false
}

fn file_reference_from_absolute_path(path: &Path, score: i64) -> Option<WorkspaceFileReference> {
    let canonical = path.canonicalize().ok()?;
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() {
        return None;
    }

    let name = canonical.file_name()?.to_string_lossy().to_string();
    let display_path = display_local_reference_path(&canonical);
    let directory = canonical
        .parent()
        .map(display_local_reference_path)
        .unwrap_or_default();
    let extension = canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_string());
    let modified_epoch_millis = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());

    Some(WorkspaceFileReference {
        path: display_path,
        name,
        directory,
        extension,
        size_bytes: Some(metadata.len()),
        modified_epoch_millis,
        score,
    })
}

fn search_absolute_or_home_file_references(
    query: &str,
    limit: usize,
) -> Vec<WorkspaceFileReference> {
    let raw_query = raw_reference_query(query);
    if !is_absolute_or_home_reference(&raw_query) {
        return Vec::new();
    }

    let Some(expanded) = expand_absolute_or_home_reference(&raw_query) else {
        return Vec::new();
    };

    if let Some(reference) = file_reference_from_absolute_path(&expanded, 30_000) {
        return vec![reference];
    }

    let (directory, partial_name) = if expanded.is_dir() {
        (expanded, String::new())
    } else {
        let parent = expanded
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| expanded.clone());
        let partial = expanded
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        (parent, partial)
    };

    if !directory.is_dir() {
        return Vec::new();
    }

    let normalized_partial = partial_name.to_ascii_lowercase();
    let mut references = Vec::new();
    if let Ok(entries) = fs::read_dir(&directory) {
        for entry in entries.flatten() {
            if references.len() >= limit.saturating_mul(3) {
                break;
            }
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else { continue };
            if !metadata.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let normalized_name = name.to_ascii_lowercase();
            if !normalized_partial.is_empty()
                && !normalized_name.contains(&normalized_partial)
                && !fuzzy_contains(&normalized_name, &normalized_partial)
            {
                continue;
            }
            let score = if normalized_partial.is_empty() {
                10_000_i64.saturating_sub(name.len() as i64)
            } else if normalized_name == normalized_partial {
                24_000
            } else if normalized_name.starts_with(&normalized_partial) {
                20_000
            } else if normalized_name.contains(&normalized_partial) {
                16_000
            } else {
                12_000
            };
            if let Some(reference) = file_reference_from_absolute_path(&path, score) {
                references.push(reference);
            }
        }
    }

    references.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    references.dedup_by(|a, b| a.path == b.path);
    references.truncate(limit);
    references
}

fn file_reference_score(path: &str, name: &str, query: &str) -> Option<i64> {
    let normalized_path = path.to_ascii_lowercase().replace('\\', "/");
    let normalized_name = name.to_ascii_lowercase();
    let query = normalize_reference_query(query);

    if query.is_empty() {
        return Some(10_000_i64.saturating_sub(path.len() as i64));
    }

    let query_tokens: Vec<&str> = query
        .split(|ch: char| ch.is_whitespace())
        .filter(|token| !token.is_empty())
        .collect();

    if query_tokens
        .iter()
        .any(|token| !normalized_path.contains(token) && !fuzzy_contains(&normalized_path, token))
    {
        return None;
    }

    let mut score = 0_i64;
    if normalized_path == query {
        score += 20_000;
    }
    if normalized_name == query {
        score += 16_000;
    }
    if normalized_name.starts_with(&query) {
        score += 12_000;
    }
    if normalized_path.starts_with(&query) {
        score += 10_000;
    }
    if normalized_path.contains(&format!("/{query}")) {
        score += 8_000;
    }
    if normalized_path.contains(&query) {
        score += 5_000;
    } else if fuzzy_contains(&normalized_path, &query) {
        score += 2_000;
    }

    score += (query_tokens.len() as i64) * 100;
    score -= path.len().min(300) as i64;
    Some(score)
}

fn workspace_file_reference_from_path(
    root: &Path,
    relative_path: &str,
    query: &str,
) -> Option<WorkspaceFileReference> {
    let normalized_relative = relative_path.trim().replace('\\', "/");
    if normalized_relative.is_empty() || normalized_relative.ends_with('/') {
        return None;
    }
    if normalized_relative
        .split('/')
        .any(|part| is_ignored_file_reference_dir(part))
    {
        return None;
    }

    let absolute = root.join(&normalized_relative);
    let metadata = fs::metadata(&absolute).ok()?;
    if !metadata.is_file() {
        return None;
    }

    let name = Path::new(&normalized_relative)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&normalized_relative)
        .to_string();
    let score = file_reference_score(&normalized_relative, &name, query)?;
    let directory = Path::new(&normalized_relative)
        .parent()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_string());
    let extension = Path::new(&normalized_relative)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string());
    let modified_epoch_millis = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());

    Some(WorkspaceFileReference {
        path: normalized_relative,
        name,
        directory,
        extension,
        size_bytes: Some(metadata.len()),
        modified_epoch_millis,
        score,
    })
}

fn collect_workspace_file_references(
    root: &Path,
    current: &Path,
    query: &str,
    out: &mut Vec<WorkspaceFileReference>,
    scanned: &mut usize,
) -> Result<(), String> {
    if *scanned > 20_000 {
        return Ok(());
    }

    for entry in fs::read_dir(current).map_err(error_to_string)? {
        let entry = entry.map_err(error_to_string)?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            if !is_ignored_file_reference_dir(&name) {
                collect_workspace_file_references(root, &path, query, out, scanned)?;
            }
            continue;
        }

        *scanned += 1;
        if let Ok(relative) = path.strip_prefix(root) {
            let relative_string = relative.to_string_lossy().replace('\\', "/");
            if let Some(reference) =
                workspace_file_reference_from_path(root, &relative_string, query)
            {
                out.push(reference);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn search_workspace_files(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<WorkspaceFileReference>, String> {
    let root_path = canonical_workspace_root(&root)?;
    let limit = max_results.unwrap_or(20).clamp(1, 50);
    let external_references = search_absolute_or_home_file_references(&query, limit);
    if !external_references.is_empty() {
        return Ok(external_references);
    }
    let normalized_query = normalize_reference_query(&query);
    let mut references = Vec::new();

    let git_output = std::process::Command::new("git")
        .arg("-C")
        .arg(&root_path)
        .arg("ls-files")
        .arg("--cached")
        .arg("--others")
        .arg("--exclude-standard")
        .output();

    if let Ok(output) = git_output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if let Some(reference) =
                    workspace_file_reference_from_path(&root_path, line, &normalized_query)
                {
                    references.push(reference);
                }
            }
        }
    }

    if references.is_empty() {
        let mut scanned = 0_usize;
        collect_workspace_file_references(
            &root_path,
            &root_path,
            &normalized_query,
            &mut references,
            &mut scanned,
        )?;
    }

    references.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    references.dedup_by(|a, b| a.path == b.path);
    references.truncate(limit);
    Ok(references)
}

#[tauri::command]
pub fn read_workspace_file(root: String, path: String) -> Result<FileView, String> {
    let root_path = canonical_workspace_root(&root)?;
    let resolved = resolve_workspace_path(&root_path, &path)?;
    let metadata = fs::metadata(&resolved).map_err(error_to_string)?;
    let content = fs::read_to_string(&resolved).map_err(error_to_string)?;

    Ok(FileView {
        path,
        total_lines: content.lines().count(),
        size_bytes: metadata.len(),
        language: language_for_path(&resolved.to_string_lossy()),
        content,
    })
}

#[tauri::command]
pub fn read_local_reference_file(root: String, path: String) -> Result<FileView, String> {
    let root_path = canonical_workspace_root(&root)?;
    let (resolved, display_path) = resolve_local_reference_file_path(&root_path, &path)?;
    let metadata = fs::metadata(&resolved).map_err(error_to_string)?;
    let content = fs::read_to_string(&resolved).map_err(error_to_string)?;

    Ok(FileView {
        path: display_path,
        total_lines: content.lines().count(),
        size_bytes: metadata.len(),
        language: language_for_path(&resolved.to_string_lossy()),
        content,
    })
}

#[tauri::command]
pub fn read_local_image_metadata(root: String, path: String) -> Result<LocalImageMetadata, String> {
    let root_path = canonical_workspace_root(&root)?;
    let resolved = crate::utils::resolve_local_reference_path(&root_path, &path)?;

    if !is_supported_image_path(&resolved) {
        return Err(
            "only png, jpg, jpeg, gif, webp, and svg image previews are supported".to_string(),
        );
    }

    let metadata = fs::metadata(&resolved).map_err(error_to_string)?;
    if !metadata.is_file() {
        return Err("image preview path is not a file".to_string());
    }

    Ok(LocalImageMetadata {
        path: resolved.to_string_lossy().to_string(),
        mime_type: image_mime_for_path(&resolved).to_string(),
        size_bytes: metadata.len(),
    })
}

#[tauri::command]
pub fn read_local_image_preview(root: String, path: String) -> Result<LocalImagePreview, String> {
    let root_path = canonical_workspace_root(&root)?;
    let resolved = crate::utils::resolve_local_reference_path(&root_path, &path)?;

    if !is_supported_image_path(&resolved) {
        return Err(
            "only png, jpg, jpeg, gif, webp, and svg image previews are supported".to_string(),
        );
    }

    let metadata = fs::metadata(&resolved).map_err(error_to_string)?;
    if !metadata.is_file() {
        return Err("image preview path is not a file".to_string());
    }

    const MAX_IMAGE_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;
    if metadata.len() > MAX_IMAGE_PREVIEW_BYTES {
        return Err(format!(
            "image is too large to preview inline ({} bytes, max {} bytes)",
            metadata.len(),
            MAX_IMAGE_PREVIEW_BYTES
        ));
    }

    let bytes = fs::read(&resolved).map_err(error_to_string)?;
    let mime_type = image_mime_for_path(&resolved).to_string();
    let data_url = format!(
        "data:{};base64,{}",
        mime_type,
        general_purpose::STANDARD.encode(bytes)
    );

    Ok(LocalImagePreview {
        path: resolved.to_string_lossy().to_string(),
        mime_type,
        data_url,
        size_bytes: metadata.len(),
    })
}

#[tauri::command]
pub fn write_workspace_file(root: String, path: String, content: String) -> Result<(), String> {
    let root_path = canonical_workspace_root(&root)?;
    let resolved = resolve_workspace_path_allow_missing(&root_path, &path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(error_to_string)?;
    }
    fs::write(resolved, content).map_err(error_to_string)
}

#[tauri::command]
pub fn edit_workspace_file(
    root: String,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: bool,
) -> Result<serde_json::Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let resolved = resolve_workspace_path(&root_path, &path)?;
    let content = fs::read_to_string(&resolved).map_err(error_to_string)?;

    let updated = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };

    if updated == content {
        return Err("oldString not found".to_string());
    }

    fs::write(&resolved, updated).map_err(error_to_string)?;
    Ok(serde_json::json!({ "ok": true, "path": path }))
}

#[tauri::command]
pub fn read_git_diff(root: String, path: Option<String>) -> Result<GitDiff, String> {
    let root_path = canonical_workspace_root(&root)?;
    let mut cmd = std::process::Command::new("git");
    cmd.arg("diff");

    if let Some(p) = &path {
        cmd.arg("--").arg(p);
    }

    let output = cmd
        .current_dir(&root_path)
        .output()
        .map_err(error_to_string)?;
    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(GitDiff {
        path,
        is_empty: diff.trim().is_empty(),
        diff,
    })
}

fn workspace_state_from_path(path: &Path) -> Result<WorkspaceState, String> {
    let canonical = path.canonicalize().map_err(error_to_string)?;
    if !canonical.is_dir() {
        return Err("workspace path is not a directory".to_string());
    }
    Ok(WorkspaceState {
        root: canonical.to_string_lossy().to_string(),
        name: canonical
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
    })
}

#[tauri::command]
pub fn default_workspace() -> Result<WorkspaceState, String> {
    let cwd = std::env::current_dir().map_err(error_to_string)?;
    workspace_state_from_path(&cwd)
}

#[tauri::command]
pub fn open_workspace(path: String) -> Result<WorkspaceState, String> {
    workspace_state_from_path(Path::new(&path))
}

#[tauri::command]
pub fn load_workspace_registry() -> Result<WorkspaceRegistry, String> {
    read_workspace_registry()
}

#[tauri::command]
pub fn add_workspace_registry_entry(path: String) -> Result<WorkspaceRegistry, String> {
    let ws = workspace_state_from_path(Path::new(&path))?;
    let mut registry = read_workspace_registry().unwrap_or_default();
    if !registry.workspaces.iter().any(|w| w.root == ws.root) {
        registry.workspaces.push(WorkspaceRegistryEntry {
            root: ws.root,
            name: ws.name,
        });
    }
    write_workspace_registry(&registry)?;
    Ok(registry)
}

#[tauri::command]
pub fn remove_workspace_registry_entry(path: String) -> Result<WorkspaceRegistry, String> {
    let mut registry = read_workspace_registry().unwrap_or_default();
    registry.workspaces.retain(|w| w.root != path);
    write_workspace_registry(&registry)?;
    Ok(registry)
}

#[tauri::command]
pub fn list_project_entries(root: String) -> Result<Vec<ProjectEntry>, String> {
    let root_path = canonical_workspace_root(&root)?;
    let mut entries = Vec::new();

    for entry in fs::read_dir(&root_path).map_err(error_to_string)? {
        let entry = entry.map_err(error_to_string)?;
        let name = entry.file_name().to_string_lossy().to_string();

        if name == ".git" || name == "node_modules" || name == "dist" || name == "target" {
            continue;
        }

        let path = entry.path();
        let kind = if path.is_dir() {
            ProjectEntryKind::Directory
        } else {
            ProjectEntryKind::File
        };

        entries.push(ProjectEntry {
            name,
            path: path
                .strip_prefix(&root_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string(),
            kind,
        });
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}
