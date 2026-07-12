//! agent-ui library crate — re-exports all public modules for use by
//! integration tests and external consumers.
//!
//! In `gui` mode (default), Tauri IPC is available. In headless mode
//! (`--no-default-features`), only the HTTP server runs — no GTK/webview.

// ─── Tauri shim: allows code to reference AppHandle in both modes ─────

/// When built with `gui` feature, this is `tauri::AppHandle`.
/// Without `gui`, it's a stub that compiles but does nothing.
#[cfg(feature = "gui")]
pub use tauri::AppHandle;

#[cfg(not(feature = "gui"))]
#[derive(Clone)]
pub struct AppHandle;

#[cfg(not(feature = "gui"))]
impl AppHandle {
    /// Stub emit — no-op in headless mode (events go through SSE instead)
    pub fn emit<S: serde::Serialize>(&self, _event: &str, _payload: S) -> Result<(), String> {
        Ok(())
    }
}

pub mod component_session;
pub mod components;
pub mod control;
pub mod dag;
pub mod dag_api;
pub mod engine;
pub mod mcp;
pub mod mcp_core;
pub mod models;
pub mod models_core;
pub mod permissions;
pub mod repl;
pub mod runtime;
pub mod scheduler;
pub mod server;
pub mod session;
pub mod session_core;
pub mod skills;
pub mod sqlite;
pub mod types;
pub mod utils;
pub mod workspace;
