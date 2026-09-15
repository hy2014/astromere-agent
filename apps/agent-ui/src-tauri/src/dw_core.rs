// ─── dw_core.rs — DW (data warehouse) settings pure functions ───────────
// Core logic shared by Tauri IPC and HTTP; does not depend on any framework.

use crate::dw::DwSettings;
use crate::utils::{dw_settings_path, error_to_string};

/// Default dw root, used when the settings file doesn't exist or the stored
/// value is blank. This path is on the machine that runs the Python worker
/// (engine_executor), not necessarily the desktop client.
pub fn default_dw_root() -> String {
    "/opt/agent-ui/dw".to_string()
}

/// Load dw settings (from the default path). Missing file → defaults.
pub fn load_dw_settings() -> Result<DwSettings, String> {
    let path = dw_settings_path()?;
    load_dw_settings_from(&path)
}

/// Load dw settings (from a given path; used by tests).
pub fn load_dw_settings_from(path: &std::path::Path) -> Result<DwSettings, String> {
    if !path.is_file() {
        return Ok(DwSettings {
            dw_root: default_dw_root(),
        });
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read dw settings: {e}"))?;
    let settings: DwSettings = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse dw settings: {e}"))?;
    Ok(normalize_dw_settings(settings))
}

/// Save dw settings.
pub fn save_dw_settings(settings: DwSettings) -> Result<DwSettings, String> {
    let path = dw_settings_path()?;
    save_dw_settings_to(&path, &settings)
}

/// Save dw settings (to a given path; used by tests).
pub fn save_dw_settings_to(
    path: &std::path::Path,
    settings: &DwSettings,
) -> Result<DwSettings, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create dw settings dir: {e}"))?;
    }
    let normalized = normalize_dw_settings(settings.clone());
    let raw = serde_json::to_string_pretty(&normalized)
        .map_err(|e| format!("failed to serialize dw settings: {e}"))?;
    std::fs::write(path, &raw).map_err(error_to_string)?;
    Ok(normalized)
}

/// Blank/whitespace dw_root falls back to the default.
pub fn normalize_dw_settings(mut settings: DwSettings) -> DwSettings {
    if settings.dw_root.trim().is_empty() {
        settings.dw_root = default_dw_root();
    }
    settings
}

// ─── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_nonexistent_file_returns_default() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nonexistent.json");
        let settings = load_dw_settings_from(&path).unwrap();
        assert_eq!(settings.dw_root, default_dw_root());
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("dw-settings.json");

        let settings = DwSettings {
            dw_root: "/data/dw".to_string(),
        };
        let saved = save_dw_settings_to(&path, &settings).unwrap();
        assert_eq!(saved.dw_root, "/data/dw");

        let loaded = load_dw_settings_from(&path).unwrap();
        assert_eq!(loaded.dw_root, "/data/dw");
    }

    #[test]
    fn test_blank_dw_root_normalized_to_default() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("dw-settings.json");

        let settings = DwSettings {
            dw_root: "   ".to_string(),
        };
        let saved = save_dw_settings_to(&path, &settings).unwrap();
        assert_eq!(saved.dw_root, default_dw_root());

        let loaded = load_dw_settings_from(&path).unwrap();
        assert_eq!(loaded.dw_root, default_dw_root());
    }

    #[test]
    fn test_load_corrupted_file_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bad.json");
        std::fs::write(&path, "not valid json {{{").unwrap();
        assert!(load_dw_settings_from(&path).is_err());
    }
}
