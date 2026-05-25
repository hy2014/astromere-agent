use base64::{engine::general_purpose, Engine as _};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::types::{
    FileView, GitDiff, LocalImageMetadata, LocalImagePreview, ProjectEntry, ProjectEntryKind,
    WorkspaceFileReference, WorkspaceRegistry, WorkspaceRegistryEntry, WorkspaceState,
};
use crate::utils::{
    canonical_workspace_root, error_to_string, expand_absolute_or_home_reference,
    is_absolute_or_home_reference, is_supported_image_path, image_mime_for_path,
    language_for_path, read_workspace_registry, resolve_workspace_path,
    resolve_workspace_path_allow_missing, write_workspace_registry,
};

fn is_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | ".next"
            | ".turbo"
            | "dist"
            | ".claude"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".mypy_cache"
            | ".pytest_cache"
            | ".DS_Store"
    )
}

fn normalize_reference_query(value: &str) -> String {
    value.trim().to_lowercase()
}

fn raw_reference_query(value: &str) -> String {
    value.to_string()
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

fn file_reference_from_absolute_path(path: &Path, score: i64) -> Option<WorkspaceFileReference> {
    let path_str = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let directory = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = path.extension().and_then(|e| e.to_str()).map(|e| e.to_string());
    let metadata = fs::metadata(path).ok()?;
    let size = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis());

    Some(WorkspaceFileReference {
        path: path_str,
        name,
        directory,
        extension,
        size_bytes: Some(size),
        modified_epoch_millis: modified,
        score,
    })
}

fn search_absolute_or_home_file_references(
    query: &str,
    max_results: usize,
) -> Result<Vec<WorkspaceFileReference>, String> {
    let base_path = expand_absolute_or_home_reference(query)
        .ok_or_else(|| format!("invalid path: {query}"))?;

    if base_path.is_file() {
        if let Some(reference) = file_reference_from_absolute_path(&base_path, 1000) {
            return Ok(vec![reference]);
        }
        return Ok(vec![]);
    }

    if base_path.is_dir() {
        let mut results = Vec::new();
        let read_dir = fs::read_dir(&base_path)
            .map_err(|e| format!("failed to read directory: {e}"))?;

        for entry in read_dir.filter_map(|e| e.ok()).take(max_results) {
            let path = entry.path();
            if path.is_file() {
                if let Some(reference) = file_reference_from_absolute_path(&path, 500) {
                    results.push(reference);
                }
            }
        }
        return Ok(results);
    }

    Ok(vec![])
}

fn file_reference_score(path: &str, name: &str, query: &str) -> Option<i64> {
    let lower_name = name.to_lowercase();
    let lower_path = path.to_lowercase();

    if lower_name == query {
        return Some(1000);
    }
    if lower_name.starts_with(query) {
        return Some(900);
    }
    if lower_name.contains(query) {
        return Some(700);
    }
    if lower_path.contains(query) {
        return Some(300);
    }
    None
}

fn workspace_file_reference_from_path(
    root: &Path,
    path: &Path,
    query: &str,
) -> Option<WorkspaceFileReference> {
    let relative = path.strip_prefix(root).ok()?;
    let path_str = relative.to_string_lossy().to_string();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let score = file_reference_score(&path_str, &name, query)?;

    let directory = relative
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = path.extension().and_then(|e| e.to_str()).map(|e| e.to_string());
    let metadata = fs::metadata(path).ok()?;
    let size = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis());

    Some(WorkspaceFileReference {
        path: path_str,
        name,
        directory,
        extension,
        size_bytes: Some(size),
        modified_epoch_millis: modified,
        score,
    })
}

fn collect_workspace_file_references(
    root: &Path,
    query: &str,
    max_results: usize,
) -> Result<Vec<WorkspaceFileReference>, String> {
    let mut results = Vec::new();
    let mut dirs_to_visit = vec![root.to_path_buf()];
    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    while let Some(dir) = dirs_to_visit.pop() {
        if results.len() >= max_results {
            break;
        }
        if !visited.insert(dir.clone()) {
            continue;
        }

        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.filter_map(|e| e.ok()) {
            if results.len() >= max_results {
                break;
            }

            let path = entry.path();
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            if is_ignored_dir(&file_name) {
                continue;
            }

            if path.is_dir() {
                dirs_to_visit.push(path);
            } else if path.is_file() {
                if let Some(reference) = workspace_file_reference_from_path(root, &path, query) {
                    results.push(reference);
                }
            }
        }
    }

    results.sort_by(|a, b| b.score.cmp(&a.score));
    results.truncate(max_results);
    Ok(results)
}

#[tauri::command]
pub fn default_workspace() -> Result<WorkspaceState, String> {
    let registry = read_workspace_registry()?;
    if let Some(entry) = registry.workspaces.first() {
        return Ok(WorkspaceState {
            root: entry.root.clone(),
            name: entry.name.clone(),
        });
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME not set".to_string())?;
    Ok(WorkspaceState {
        root: home,
        name: "Home".to_string(),
    })
}

#[tauri::command]
pub fn open_workspace(path: String) -> Result<WorkspaceState, String> {
    let resolved = PathBuf::from(&path);
    if !resolved.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let name = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();

    let mut registry = read_workspace_registry()?;
    registry.workspaces.retain(|e| e.root != path);
    registry.workspaces.insert(
        0,
        WorkspaceRegistryEntry {
            root: path.clone(),
            name: name.clone(),
        },
    );
    write_workspace_registry(&registry)?;

    Ok(WorkspaceState {
        root: path,
        name,
    })
}

#[tauri::command]
pub fn load_workspace_registry() -> Result<WorkspaceRegistry, String> {
    read_workspace_registry()
}

#[tauri::command]
pub fn add_workspace_registry_entry(path: String) -> Result<WorkspaceRegistry, String> {
    let mut registry = read_workspace_registry()?;
    let resolved = PathBuf::from(&path);
    let name = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();
    registry.workspaces.retain(|e| e.root != path);
    registry.workspaces.push(WorkspaceRegistryEntry {
        root: path,
        name,
    });
    write_workspace_registry(&registry)?;
    Ok(registry)
}

#[tauri::command]
pub fn remove_workspace_registry_entry(path: String) -> Result<WorkspaceRegistry, String> {
    let mut registry = read_workspace_registry()?;
    registry.workspaces.retain(|e| e.root != path);
    write_workspace_registry(&registry)?;
    Ok(registry)
}

#[tauri::command]
pub fn list_project_entries(root: String) -> Result<Vec<ProjectEntry>, String> {
    let root_path = canonical_workspace_root(&root)?;
    let mut entries = Vec::new();
    collect_directory_entries(&root_path, &root_path, &mut entries, 0)?;
    Ok(entries)
}

fn collect_directory_entries(
    root: &Path,
    dir: &Path,
    entries: &mut Vec<ProjectEntry>,
    depth: usize,
) -> Result<(), String> {
    if depth > 2 {
        return Ok(());
    }
    let read_dir = fs::read_dir(dir)
        .map_err(|e| format!("failed to read directory {}: {e}", dir.display()))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("failed to read entry: {e}"))?;
        let path = entry.path();

        if is_ignored_dir(path.file_name().and_then(|n| n.to_str()).unwrap_or("")) {
            continue;
        }

        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if path.is_dir() {
            entries.push(ProjectEntry {
                name: file_name,
                path: path.to_string_lossy().to_string(),
                kind: ProjectEntryKind::Directory,
            });
            collect_directory_entries(root, &path, entries, depth + 1)?;
        } else {
            entries.push(ProjectEntry {
                name: file_name,
                path: path.to_string_lossy().to_string(),
                kind: ProjectEntryKind::File,
            });
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
    let limit = max_results.unwrap_or(50);
    let normalized_query = normalize_reference_query(&query);

    let mut results = Vec::new();

    if is_absolute_or_home_reference(&query) {
        let refs = search_absolute_or_home_file_references(&query, limit)?;
        results.extend(refs);
    }

    if results.len() < limit {
        let file_refs = collect_workspace_file_references(&root_path, &normalized_query, limit)?;
        for r in file_refs {
            if !results.iter().any(|existing: &WorkspaceFileReference| existing.path == r.path) {
                results.push(r);
            }
        }
    }

    results.truncate(limit);
    Ok(results)
}

#[tauri::command]
pub fn read_workspace_file(root: String, path: String) -> Result<FileView, String> {
    let root_path = canonical_workspace_root(&root)?;
    let file_path = resolve_workspace_path(&root_path, &path)?;

    let metadata = fs::metadata(&file_path)
        .map_err(|e| format!("failed to read file metadata: {e}"))?;
    let size_bytes = metadata.len();

    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("failed to read file: {e}"))?;

    let total_lines = content.lines().count();
    let language = language_for_path(&path);

    Ok(FileView {
        path: file_path.to_string_lossy().to_string(),
        content,
        total_lines,
        size_bytes,
        language,
    })
}

#[tauri::command]
pub fn read_local_reference_file(root: String, path: String) -> Result<FileView, String> {
    let root_path = canonical_workspace_root(&root)?;
    let (file_path, _display_path) = resolve_local_reference_file_path(&root_path, &path)?;

    let metadata = fs::metadata(&file_path)
        .map_err(|e| format!("failed to read file metadata: {e}"))?;
    let size_bytes = metadata.len();

    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("failed to read file: {e}"))?;

    let total_lines = content.lines().count();
    let language = language_for_path(&path);

    Ok(FileView {
        path: file_path.to_string_lossy().to_string(),
        content,
        total_lines,
        size_bytes,
        language,
    })
}

#[tauri::command]
pub fn read_local_image_metadata(root: String, path: String) -> Result<LocalImageMetadata, String> {
    let root_path = canonical_workspace_root(&root)?;
    let file_path = resolve_workspace_path(&root_path, &path)?;

    if !is_supported_image_path(&file_path) {
        return Err(format!("unsupported image format: {}", file_path.display()));
    }

    let metadata = fs::metadata(&file_path)
        .map_err(|e| format!("failed to read image metadata: {e}"))?;
    let mime_type = image_mime_for_path(&file_path).to_string();

    Ok(LocalImageMetadata {
        path: file_path.to_string_lossy().to_string(),
        mime_type,
        size_bytes: metadata.len(),
    })
}

#[tauri::command]
pub fn read_local_image_preview(root: String, path: String) -> Result<LocalImagePreview, String> {
    let root_path = canonical_workspace_root(&root)?;
    let file_path = resolve_workspace_path(&root_path, &path)?;

    if !is_supported_image_path(&file_path) {
        return Err(format!("unsupported image format: {}", file_path.display()));
    }

    let metadata = fs::metadata(&file_path)
        .map_err(|e| format!("failed to read image metadata: {e}"))?;
    let mime_type = image_mime_for_path(&file_path);

    let mut buffer = Vec::new();
    fs::File::open(&file_path)
        .map_err(|e| format!("failed to open image: {e}"))?
        .read_to_end(&mut buffer)
        .map_err(|e| format!("failed to read image: {e}"))?;

    let data_url = format!(
        "data:{};base64,{}",
        mime_type,
        general_purpose::STANDARD.encode(&buffer)
    );

    Ok(LocalImagePreview {
        path: file_path.to_string_lossy().to_string(),
        mime_type: mime_type.to_string(),
        data_url,
        size_bytes: metadata.len(),
    })
}

#[tauri::command]
pub fn write_workspace_file(root: String, path: String, content: String) -> Result<(), String> {
    let root_path = canonical_workspace_root(&root)?;
    let file_path = resolve_workspace_path_allow_missing(&root_path, &path)?;

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent directories: {e}"))?;
    }

    fs::write(&file_path, &content)
        .map_err(|e| format!("failed to write file: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn edit_workspace_file(
    root: String,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: bool,
) -> Result<(), String> {
    let root_path = canonical_workspace_root(&root)?;
    let file_path = resolve_workspace_path(&root_path, &path)?;

    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("failed to read file: {e}"))?;

    let new_content = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        match content.find(&old_string) {
            Some(pos) => {
                let mut result = content[..pos].to_string();
                result.push_str(&new_string);
                result.push_str(&content[pos + old_string.len()..]);
                result
            }
            None => return Err(format!("old_string not found in file: {path}")),
        }
    };

    if new_content == content {
        return Err("no changes made (old_string not found or replacement identical)".to_string());
    }

    fs::write(&file_path, &new_content)
        .map_err(|e| format!("failed to write file after edit: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn read_git_diff(root: String, path: Option<String>) -> Result<GitDiff, String> {
    let root_path = canonical_workspace_root(&root)?;

    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(&root_path)
        .arg("diff")
        .arg("--no-color");

    if let Some(ref p) = path {
        cmd.arg("--").arg(p);
    }

    let output = cmd.output()
        .map_err(|e| format!("failed to run git diff: {e}"))?;

    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(GitDiff {
        path,
        is_empty: diff.is_empty(),
        diff,
    })
}
