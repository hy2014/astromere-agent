//! DAG-mode server connection persistence.
//!
//! The DAG-mode server address (the `RemoteProfile` the user fills in the
//! "first-connection config" panel, e.g. `http://192.168.1.x:7421`) used to live in the
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

/// Resolve the on-disk directory that holds per-execution component logs.
///
/// The Python engine writes each node's full (untruncated) stdout/stderr to
/// `<log_dir>/<execution_id>/<node_id>.log`, and the HTTP server serves those
/// files back via `/api/executions/:id/nodes/:node_id/log`. Priority:
/// `$AGENT_UI_LOG_DIR` (set by the server when it spawns the worker, so both
/// sides agree) → `<agent_ui_home>/logs`.
pub fn log_dir() -> PathBuf {
    if let Ok(v) = std::env::var("AGENT_UI_LOG_DIR") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    agent_ui_home().join("logs")
}

fn dag_server_path() -> PathBuf {
    agent_ui_home().join("dag-mode").join("dagServer.json")
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn load_dag_server() -> Option<RemoteProfileFile> {
    let path = dag_server_path();
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn save_dag_server(profile: RemoteProfileFile) -> Result<(), String> {
    let dir = dag_mode_dir().map_err(|e| e.to_string())?;
    let path = dir.join("dagServer.json");
    let data = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn clear_dag_server() -> Result<(), String> {
    let path = dag_server_path();
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
