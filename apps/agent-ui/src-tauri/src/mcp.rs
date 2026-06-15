use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::mcp_core;

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

pub fn astromere_mcp_config_path() -> Result<PathBuf, String> {
    mcp_core::mcp_config_path()
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn load_mcp_settings() -> Result<McpSettingsFile, String> {
    mcp_core::load_mcp_settings()
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn save_mcp_settings(settings: McpSettings) -> Result<McpSettingsFile, String> {
    mcp_core::save_mcp_settings(settings)
}
