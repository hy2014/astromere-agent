use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::utils::{canonical_workspace_root, error_to_string, repo_root};

fn normalize_frontmatter_key(key: &str) -> String {
    key.trim().to_lowercase().replace('-', "_").replace(' ', "_")
}

fn clean_frontmatter_value(value: &str) -> String {
    value.trim().trim_matches('"').to_string()
}

fn parse_skill_frontmatter(markdown: &str) -> HashMap<String, Vec<String>> {
    let mut frontmatter: HashMap<String, Vec<String>> = HashMap::new();
    let markdown = markdown.trim();

    if !markdown.starts_with("---") {
        return frontmatter;
    }

    let end = markdown[3..].find("---").map(|pos| pos + 3);
    let Some(end_pos) = end else {
        return frontmatter;
    };

    let block = &markdown[3..end_pos];
    let mut current_key: Option<String> = None;

    for line in block.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(pos) = line.find(':') {
            let key = normalize_frontmatter_key(&line[..pos]);
            let value = clean_frontmatter_value(&line[pos + 1..]);
            current_key = Some(key.clone());

            if value.is_empty() {
                frontmatter.entry(key).or_default();
            } else {
                frontmatter.entry(key).or_default().push(value);
            }
        } else if let Some(ref key) = current_key {
            let value = clean_frontmatter_value(line);
            if !value.is_empty() {
                frontmatter.entry(key.clone()).or_default().push(value);
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

fn capability_for_tool(tool: &str) -> String {
    match tool {
        "Read" | "Write" | "Edit" | "Glob" | "Grep" => "files".to_string(),
        "Bash" => "bash".to_string(),
        "Agent" => "delegation".to_string(),
        "Image" | "ImageGeneration" => "image".to_string(),
        "WebFetch" | "WebSearch" => "web".to_string(),
        "Computer" | "ComputerUse" | "Screenshot" => "computer".to_string(),
        "TextEditor" => "text-editor".to_string(),
        _ => "custom".to_string(),
    }
}

fn capabilities_for_tools(tools: &[String]) -> Vec<String> {
    let mut caps: Vec<String> = tools.iter().map(|t| capability_for_tool(t)).collect();
    caps.sort();
    caps.dedup();
    caps
}

fn build_skill_summary(
    root: &Path,
    path: &Path,
    subdirectory: &str,
    frontmatter: &HashMap<String, Vec<String>>,
) -> Value {
    let name = frontmatter_first(frontmatter, &["name", "title"])
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unnamed")
                .to_string()
        });

    let description = frontmatter_first(frontmatter, &[
        "description",
        "description_for_model",
        "summary",
    ])
    .unwrap_or_default();

    let tools = frontmatter_list(frontmatter, &[
        "tools",
        "required_tools",
        "used_tools",
        "tool",
        "functions",
    ]);
    let capabilities = capabilities_for_tools(&tools);

    let when_to_use = frontmatter_first(frontmatter, &[
        "when-to-use", "when_to_use", "whenToUse",
    ]);

    let dangerous = frontmatter_bool(frontmatter, &["dangerous", "danger", "requires_confirmation"], false);

    let model = frontmatter_first(frontmatter, &["model", "recommended_model"]);

    let relative_path = path
        .strip_prefix(root)
        .ok()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string();

    json!({
        "name": name,
        "description": description,
        "tools": tools,
        "capabilities": capabilities,
        "path": relative_path,
        "dangerous": dangerous,
        "whenToUse": when_to_use,
        "model": model,
        "raw": {
            "path": relative_path,
            "subdirectory": subdirectory,
            "name": name,
            "description": description,
            "tools": tools,
            "dangerous": dangerous
        }
    })
}

#[tauri::command]
pub fn list_skills(root: String) -> Result<Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let skills_dir = root_path.join(".claude").join("skills");

    if !skills_dir.is_dir() {
        return Ok(json!({
            "skills": [],
            "root": root,
            "skillsDir": skills_dir.to_string_lossy().to_string(),
            "isDir": false
        }));
    }

    let mut skills = Vec::new();
    collect_skills(&root_path, &skills_dir, "", &mut skills)?;

    Ok(json!({
        "skills": skills,
        "root": root,
        "skillsDir": skills_dir.to_string_lossy().to_string(),
        "isDir": true
    }))
}

fn collect_skills(
    root: &Path,
    dir: &Path,
    subdirectory: &str,
    skills: &mut Vec<Value>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(error_to_string)? {
        let entry = entry.map_err(error_to_string)?;
        let path = entry.path();

        if path.is_dir() {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            let sub = if subdirectory.is_empty() {
                name.to_string()
            } else {
                format!("{subdirectory}/{name}")
            };
            collect_skills(root, &path, &sub, skills)?;
            continue;
        }

        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let content = fs::read_to_string(&path).unwrap_or_default();
        let frontmatter = parse_skill_frontmatter(&content);

        if frontmatter.is_empty() {
            continue;
        }

        skills.push(build_skill_summary(root, &path, subdirectory, &frontmatter));
    }

    Ok(())
}

#[tauri::command]
pub fn install_skill(root: String, source: String) -> Result<Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let skills_dir = root_path.join(".claude").join("skills");
    fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("failed to create skills directory: {e}"))?;

    if source.starts_with("http://") || source.starts_with("https://") {
        return install_skill_from_url(&skills_dir, &source);
    }

    let source_path = Path::new(&source);
    if source_path.is_file() {
        return install_skill_from_file(&skills_dir, source_path);
    }
    if source_path.is_dir() {
        return install_skill_from_dir(&skills_dir, source_path);
    }

    Err(format!("invalid skill source: {source}"))
}

fn install_skill_from_url(skills_dir: &Path, url: &str) -> Result<Value, String> {
    Err(format!("URL installation not supported yet: {url}"))
}

fn install_skill_from_file(skills_dir: &Path, source: &Path) -> Result<Value, String> {
    let name = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let dest = skills_dir.join(source.file_name().unwrap());

    fs::copy(source, &dest)
        .map_err(|e| format!("failed to copy skill: {e}"))?;

    Ok(json!({
        "name": name,
        "path": dest.to_string_lossy().to_string(),
        "status": "installed"
    }))
}

fn install_skill_from_dir(skills_dir: &Path, source: &Path) -> Result<Value, String> {
    let name = source
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let dest = skills_dir.join(&name);

    if dest.exists() {
        fs::remove_dir_all(&dest)
            .map_err(|e| format!("failed to remove existing skill directory: {e}"))?;
    }

    let copy_options = fs_extra::dir::CopyOptions::new();
    fs_extra::dir::copy(source, skills_dir, &copy_options)
        .map_err(|e| format!("failed to copy skill directory: {e}"))?;

    Ok(json!({
        "name": name,
        "path": dest.to_string_lossy().to_string(),
        "status": "installed"
    }))
}
