use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use crate::utils::ui_config_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolConfig {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default, rename = "type")]
    pub server_type: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub tools: Vec<McpToolConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, McpServerConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettingsFile {
    pub path: String,
    pub settings: McpSettings,
}

fn default_mcp_settings() -> McpSettings {
    McpSettings {
        mcp_servers: BTreeMap::new(),
    }
}

pub fn astromere_mcp_config_path() -> Result<PathBuf, String> {
    let dir = ui_config_dir()?;
    Ok(dir.join("mcp.json"))
}

#[tauri::command]
pub fn load_mcp_settings() -> Result<McpSettingsFile, String> {
    let path = astromere_mcp_config_path()?;

    if !path.is_file() {
        return Ok(McpSettingsFile {
            path: path.to_string_lossy().to_string(),
            settings: default_mcp_settings(),
        });
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read MCP settings {}: {error}", path.display()))?;

    let settings = serde_json::from_str::<McpSettings>(&raw)
        .map_err(|error| format!("failed to parse MCP settings {}: {error}", path.display()))?;

    Ok(McpSettingsFile {
        path: path.to_string_lossy().to_string(),
        settings,
    })
}

#[tauri::command]
pub fn save_mcp_settings(settings: McpSettings) -> Result<McpSettingsFile, String> {
    let path = astromere_mcp_config_path()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create MCP settings dir {}: {error}", parent.display()))?;
    }

    let raw = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("failed to serialize MCP settings: {error}"))?;

    fs::write(&path, format!("{raw}\n"))
        .map_err(|error| format!("failed to write MCP settings {}: {error}", path.display()))?;

    Ok(McpSettingsFile {
        path: path.to_string_lossy().to_string(),
        settings,
    })
}
