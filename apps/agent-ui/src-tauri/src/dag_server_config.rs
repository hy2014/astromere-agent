//! DAG-mode server connection persistence.
//!
//! The DAG-mode server address (the `RemoteProfile` the user fills in the
//! "首连配置" panel, e.g. `http://192.168.1.x:7421`) used to live in the
//! webview `localStorage` (`agent-ui.dagServer.v1`). It is now persisted to
//! disk under `<AGENT_UI_HOME>/dag-mode/dagServer.json` so the connection
//! survives cache wipes and is shared across webview reloads.
//!
//! `<AGENT_UI_HOME>` defaults to `~/.agent-ui` and can be overridden by the
//! `AGENT_UI_HOME` environment variable (mirroring the other `AGENT_UI_*`
//! knobs such as `AGENT_UI_DB_PATH` / `AGENT_UI_HTTP_HOST`).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProfileFile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub token: Option<String>,
}

/// Resolve the agent-ui home directory.
///
/// Priority: `$AGENT_UI_HOME` (if set and non-empty) →
/// `$HOME`/`$USERPROFILE` joined with `.agent-ui`.
fn agent_ui_home() -> PathBuf {
    if let Ok(v) = std::env::var("AGENT_UI_HOME") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".agent-ui")
}

/// `<AGENT_UI_HOME>/dag-mode`, created on demand.
fn dag_mode_dir() -> std::io::Result<PathBuf> {
    let dir = agent_ui_home().join("dag-mode");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn dag_server_path() -> PathBuf {
    agent_ui_home().join("dag-mode").join("dagServer.json")
}

#[tauri::command]
pub fn load_dag_server() -> Option<RemoteProfileFile> {
    let path = dag_server_path();
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

#[tauri::command]
pub fn save_dag_server(profile: RemoteProfileFile) -> Result<(), String> {
    let dir = dag_mode_dir().map_err(|e| e.to_string())?;
    let path = dir.join("dagServer.json");
    let data = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_dag_server() -> Result<(), String> {
    let path = dag_server_path();
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
