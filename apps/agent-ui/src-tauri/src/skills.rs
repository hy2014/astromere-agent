use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::utils::{canonical_workspace_root, error_to_string};

fn normalize_frontmatter_key(key: &str) -> String {
    key.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace('_', "-")
        .to_ascii_lowercase()
}

fn clean_frontmatter_value(value: &str) -> String {
    value.trim().trim_matches('"').to_string()
}

fn parse_skill_frontmatter(markdown: &str) -> HashMap<String, Vec<String>> {
    let mut frontmatter = HashMap::new();
    let mut lines = markdown.lines();

    if lines.next().map(str::trim) != Some("---") {
        return frontmatter;
    }

    let mut current_key: Option<String> = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(item) = trimmed.strip_prefix("- ") {
            if let Some(key) = current_key.as_ref() {
                frontmatter
                    .entry(key.clone())
                    .or_insert_with(Vec::new)
                    .push(clean_frontmatter_value(item));
            }
            continue;
        }
        if let Some(item) = trimmed.strip_prefix("  - ") {
            if let Some(key) = current_key.as_ref() {
                frontmatter
                    .entry(key.clone())
                    .or_insert_with(Vec::new)
                    .push(clean_frontmatter_value(item));
            }
            continue;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            let key = normalize_frontmatter_key(key);
            let value = clean_frontmatter_value(value);
            current_key = Some(key.clone());
            frontmatter.entry(key.clone()).or_insert_with(Vec::new);
            if !value.is_empty() {
                frontmatter.insert(key, vec![value]);
            }
        }
    }

    frontmatter
}

fn frontmatter_first(frontmatter: &HashMap<String, Vec<String>>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(values) = frontmatter.get(&normalize_frontmatter_key(key)) {
            if let Some(value) = values.first() {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

fn frontmatter_list(frontmatter: &HashMap<String, Vec<String>>, keys: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    for key in keys {
        if let Some(items) = frontmatter.get(&normalize_frontmatter_key(key)) {
            for item in items {
                let trimmed = item.trim();
                if !trimmed.is_empty()
                    && !values.iter().any(|value: &String| value.as_str() == trimmed)
                {
                    values.push(trimmed.to_string());
                }
            }
        }
    }
    values
}

fn frontmatter_bool(
    frontmatter: &HashMap<String, Vec<String>>,
    keys: &[&str],
    default: bool,
) -> bool {
    match frontmatter_first(frontmatter, keys)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "true" | "yes" | "1" | "on" => true,
        "false" | "no" | "0" | "off" => false,
        _ => default,
    }
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            match fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => metadata.len(),
                Ok(metadata) if metadata.is_dir() => directory_size(&path),
                _ => 0,
            }
        })
        .sum()
}

fn modified_epoch_millis(path: &Path) -> Option<u128> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
}

fn relative_path_string(root_path: &Path, path: &Path) -> String {
    path.strip_prefix(root_path)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn claude_config_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME environment variable not set".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".claude"))
}

fn capability_for_tool(tool: &str) -> String {
    let lower = tool.to_ascii_lowercase();
    if lower.starts_with("bash(git") || lower.contains(" git") {
        "Git".to_string()
    } else if lower.starts_with("bash") {
        "Shell".to_string()
    } else if lower.starts_with("read") {
        "File Read".to_string()
    } else if lower.starts_with("write")
        || lower.starts_with("edit")
        || lower.starts_with("multiedit")
    {
        "File Write".to_string()
    } else if lower.starts_with("grep") || lower.starts_with("glob") || lower.starts_with("ls") {
        "Search".to_string()
    } else if lower.starts_with("web") {
        "Network".to_string()
    } else if lower.starts_with("agent") {
        "Sub Agent".to_string()
    } else if lower.starts_with("skill") {
        "Skill Invoke".to_string()
    } else {
        tool.split(['(', ':'])
            .next()
            .unwrap_or(tool)
            .trim()
            .to_string()
    }
}

fn capabilities_for_tools(tools: &[String]) -> Vec<String> {
    let mut capabilities = Vec::new();
    for tool in tools {
        let capability = capability_for_tool(tool);
        if !capability.is_empty() && !capabilities.contains(&capability) {
            capabilities.push(capability);
        }
    }
    capabilities
}

fn build_skill_summary(
    root_path: &Path,
    skill_dir: &Path,
    source_kind: &str,
    source_label: &str,
    source_base: &Path,
) -> Value {
    let directory_name = skill_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let skill_md = skill_dir.join("SKILL.md");
    let markdown = fs::read_to_string(&skill_md).unwrap_or_default();
    let frontmatter = parse_skill_frontmatter(&markdown);
    let mut validation = Vec::new();

    if !skill_md.exists() {
        validation.push("Missing SKILL.md".to_string());
    }
    if markdown.starts_with("---") && frontmatter.is_empty() {
        validation.push("Unable to parse frontmatter".to_string());
    }

    let name = frontmatter_first(&frontmatter, &["name"]).unwrap_or(directory_name);
    let description = frontmatter_first(&frontmatter, &["description"]);
    let when_to_use = frontmatter_first(&frontmatter, &["when-to-use", "when_to_use", "whenToUse"]);
    let version = frontmatter_first(&frontmatter, &["version"]);
    let allowed_tools = frontmatter_list(
        &frontmatter,
        &["allowed-tools", "allowed_tools", "allowedTools"],
    );
    let paths = frontmatter_list(&frontmatter, &["paths"]);
    let hooks = frontmatter_list(&frontmatter, &["hooks"]);
    let context =
        frontmatter_first(&frontmatter, &["context"]).unwrap_or_else(|| "inline".to_string());
    let agent = frontmatter_first(&frontmatter, &["agent"]);
    let model = frontmatter_first(&frontmatter, &["model"]);
    let effort = frontmatter_first(&frontmatter, &["effort"]);
    let user_invocable = frontmatter_bool(
        &frontmatter,
        &["user-invocable", "user_invocable", "userInvocable"],
        true,
    );
    let disable_model_invocation = frontmatter_bool(
        &frontmatter,
        &[
            "disable-model-invocation",
            "disable_model_invocation",
            "disableModelInvocation",
        ],
        false,
    );
    let model_invocable = !disable_model_invocation;
    let size_bytes = directory_size(skill_dir);
    let installed_at_ms =
        modified_epoch_millis(&skill_md).or_else(|| modified_epoch_millis(skill_dir));
    let skill_root = relative_path_string(root_path, skill_dir);
    let skill_path = relative_path_string(root_path, &skill_md);
    let capabilities = capabilities_for_tools(&allowed_tools);

    json!({
        "id": format!("{source_kind}:{name}"),
        "name": name,
        "description": description,
        "whenToUse": when_to_use,
        "version": version,
        "path": skill_path,
        "skillRoot": skill_root,
        "source": {
            "kind": source_kind,
            "label": source_label,
            "path": source_base.to_string_lossy().to_string()
        },
        "origin": {
            "id": source_kind,
            "label": source_label
        },
        "enabled": true,
        "userInvocable": user_invocable,
        "modelInvocable": model_invocable,
        "context": context,
        "agent": agent,
        "model": model,
        "effort": effort,
        "allowedTools": allowed_tools,
        "capabilities": capabilities,
        "paths": paths,
        "hooks": hooks,
        "sizeBytes": size_bytes,
        "installedAtMs": installed_at_ms,
        "validation": validation,
        "shadowedBy": [],
        "shadowed_by": []
    })
}

#[tauri::command]
pub fn list_skills(root: String) -> Result<Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let project_skills_dir = root_path.join(".claude").join("skills");
    let user_skills_dir = claude_config_dir()?.join("skills");
    let skill_sources = vec![
        ("project", "Project", project_skills_dir),
        ("user", "User", user_skills_dir),
    ];
    let mut skills = Vec::new();
    let mut sources = Vec::new();
    let mut seen_by_name: HashMap<String, String> = HashMap::new();
    let mut shadowed = 0usize;

    for (source_kind, source_label, skills_dir) in skill_sources {
        let mut source_count = 0usize;
        if skills_dir.exists() {
            let mut entries = fs::read_dir(&skills_dir)
                .map_err(error_to_string)?
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
            source_count = entries.len();

            for entry in entries {
                let mut skill = build_skill_summary(
                    &root_path,
                    &entry.path(),
                    source_kind,
                    source_label,
                    &skills_dir,
                );
                let name_key = skill
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let skill_id = skill
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();

                if let Some(shadowing_id) = seen_by_name.get(&name_key).cloned() {
                    if let Some(object) = skill.as_object_mut() {
                        object.insert("enabled".to_string(), json!(false));
                        object.insert("shadowedBy".to_string(), json!([shadowing_id.clone()]));
                        object.insert("shadowed_by".to_string(), json!([shadowing_id]));
                    }
                    shadowed += 1;
                } else if !name_key.is_empty() {
                    seen_by_name.insert(name_key, skill_id);
                }

                skills.push(skill);
            }
        }

        sources.push(json!({
            "kind": source_kind,
            "label": source_label,
            "path": skills_dir.to_string_lossy().to_string(),
            "exists": skills_dir.exists(),
            "count": source_count
        }));
    }

    let active = skills.len().saturating_sub(shadowed);
    Ok(json!({
        "kind": "skills",
        "action": "list",
        "sources": sources,
        "summary": {
            "total": skills.len(),
            "active": active,
            "shadowed": shadowed
        },
        "skills": skills
    }))
}

#[tauri::command]
pub fn install_skill(root: String, source: String) -> Result<Value, String> {
    let _ = source;
    let root_path = canonical_workspace_root(&root)?;
    let skills_dir = root_path.join(".claude").join("skills");
    fs::create_dir_all(&skills_dir).map_err(error_to_string)?;

    Ok(json!({
        "kind": "skills",
        "action": "list",
        "installed": {
            "name": source,
            "path": skills_dir.to_string_lossy().to_string()
        },
        "summary": {
            "total": 0,
            "active": 0,
            "shadowed": 0
        },
        "skills": []
    }))
}
