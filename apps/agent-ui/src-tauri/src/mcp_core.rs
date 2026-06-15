// ─── mcp_core.rs — MCP configuration pure functions ───────────────────

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use crate::utils::ui_config_dir;

// Re-export types used by callers
pub use crate::mcp::{McpServerConfig, McpSettings, McpSettingsFile, McpToolConfig};

fn default_mcp_settings() -> McpSettings {
    McpSettings {
        mcp_servers: BTreeMap::new(),
    }
}

pub fn mcp_config_path() -> Result<PathBuf, String> {
    let dir = ui_config_dir()?;
    Ok(dir.join("mcp.json"))
}

pub fn load_mcp_settings() -> Result<McpSettingsFile, String> {
    let path = mcp_config_path()?;
    load_mcp_settings_from(&path)
}

pub fn load_mcp_settings_from(path: &PathBuf) -> Result<McpSettingsFile, String> {
    if !path.is_file() {
        return Ok(McpSettingsFile {
            path: path.to_string_lossy().to_string(),
            settings: default_mcp_settings(),
        });
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read MCP settings {}: {error}", path.display()))?;

    let settings = serde_json::from_str::<McpSettings>(&raw)
        .map_err(|error| format!("failed to parse MCP settings {}: {error}", path.display()))?;

    Ok(McpSettingsFile {
        path: path.to_string_lossy().to_string(),
        settings,
    })
}

pub fn save_mcp_settings(settings: McpSettings) -> Result<McpSettingsFile, String> {
    let path = mcp_config_path()?;
    save_mcp_settings_to(&path, &settings)
}

pub fn save_mcp_settings_to(path: &PathBuf, settings: &McpSettings) -> Result<McpSettingsFile, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create MCP settings dir {}: {error}", parent.display()))?;
    }

    let raw = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("failed to serialize MCP settings: {error}"))?;

    fs::write(path, format!("{raw}\n"))
        .map_err(|error| format!("failed to write MCP settings {}: {error}", path.display()))?;

    Ok(McpSettingsFile {
        path: path.to_string_lossy().to_string(),
        settings: settings.clone(),
    })
}

// ─── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn test_default_settings_empty() {
        let settings = default_mcp_settings();
        assert!(settings.mcp_servers.is_empty());
    }

    #[test]
    fn test_load_nonexistent_returns_default() {
        let path = PathBuf::from("/tmp/nonexistent_mcp_test.json");
        let result = load_mcp_settings_from(&path).unwrap();
        assert!(result.settings.mcp_servers.is_empty());
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mcp.json");

        let mut settings = default_mcp_settings();
        let server = McpServerConfig {
            enabled: Some(true),
            server_type: Some("stdio".to_string()),
            command: "node".to_string(),
            args: Some(vec!["server.js".to_string()]),
            env: None,
            cwd: None,
            tools: vec![],
        };
        settings.mcp_servers.insert("test-server".to_string(), server.clone());

        save_mcp_settings_to(&path, &settings).unwrap();
        let loaded = load_mcp_settings_from(&path).unwrap();

        assert_eq!(loaded.settings.mcp_servers.len(), 1);
        let loaded_server = loaded.settings.mcp_servers.get("test-server").unwrap();
        assert_eq!(loaded_server.command, "node");
    }

    // ── multiple servers ──

    #[test]
    fn test_multiple_servers_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mcp.json");

        let mut settings = default_mcp_settings();
        settings.mcp_servers.insert("srv1".into(), McpServerConfig {
            enabled: Some(true), server_type: Some("stdio".into()),
            command: "node".into(), args: Some(vec!["a.js".into()]),
            env: None, cwd: None, tools: vec![],
        });
        settings.mcp_servers.insert("srv2".into(), McpServerConfig {
            enabled: Some(false), server_type: Some("sse".into()),
            command: "python".into(), args: None,
            env: None, cwd: None, tools: vec![],
        });

        save_mcp_settings_to(&path, &settings).unwrap();
        let loaded = load_mcp_settings_from(&path).unwrap();

        assert_eq!(loaded.settings.mcp_servers.len(), 2);
        // BTreeMap preserves alphabetical order
        let keys: Vec<&String> = loaded.settings.mcp_servers.keys().collect();
        assert_eq!(keys, vec!["srv1", "srv2"]);
    }

    // ── disabled server roundtrip ──

    #[test]
    fn test_disabled_server_preserved() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mcp.json");

        let mut settings = default_mcp_settings();
        settings.mcp_servers.insert("off".into(), McpServerConfig {
            enabled: Some(false), server_type: None,
            command: "echo".into(), args: None,
            env: None, cwd: None, tools: vec![],
        });

        save_mcp_settings_to(&path, &settings).unwrap();
        let loaded = load_mcp_settings_from(&path).unwrap();

        let srv = loaded.settings.mcp_servers.get("off").unwrap();
        assert_eq!(srv.enabled, Some(false));
    }

    // ── env and cwd roundtrip ──

    #[test]
    fn test_env_and_cwd_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mcp.json");

        let mut env = BTreeMap::new();
        env.insert("KEY".into(), "value".into());

        let mut settings = default_mcp_settings();
        settings.mcp_servers.insert("srv".into(), McpServerConfig {
            enabled: Some(true), server_type: None,
            command: "cmd".into(), args: None,
            env: Some(env), cwd: Some("/tmp/work".into()),
            tools: vec![],
        });

        save_mcp_settings_to(&path, &settings).unwrap();
        let loaded = load_mcp_settings_from(&path).unwrap();

        let srv = loaded.settings.mcp_servers.get("srv").unwrap();
        assert_eq!(srv.cwd, Some("/tmp/work".into()));
        assert_eq!(srv.env.as_ref().unwrap().get("KEY").unwrap(), "value");
    }
}
