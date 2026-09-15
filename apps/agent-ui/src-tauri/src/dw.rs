// ─── dw.rs — DW (data warehouse) settings: Tauri IPC commands ───────────

use serde::{Deserialize, Serialize};

use crate::dw_core;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DwSettings {
    /// Root directory of the data warehouse on the worker machine.
    /// Component outputs registered to DW are written under `{dw_root}/{dw_table}/`.
    #[serde(default = "default_dw_root")]
    pub dw_root: String,
}

pub fn default_dw_root() -> String {
    dw_core::default_dw_root()
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn load_dw_settings() -> Result<DwSettings, String> {
    dw_core::load_dw_settings()
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn save_dw_settings(settings: DwSettings) -> Result<DwSettings, String> {
    dw_core::save_dw_settings(settings)
}
