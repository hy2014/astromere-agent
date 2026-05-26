//! agent-ui library crate — re-exports all public modules for use by
//! integration tests and external consumers.
//!
//! Note: `sqlite` and `terminal` are declared in `main.rs` (bin) only, because
//! the `#[tauri::command]` proc-macro generates macros that must be in the
//! calling crate. Integration tests should test sqlite/terminal logic through
//! their serialization types or by exercising the Tauri binary directly.

pub mod control;
pub mod mcp;
pub mod models;
pub mod permissions;
pub mod repl;
pub mod runtime;
pub mod session;
pub mod skills;
pub mod types;
pub mod utils;
pub mod workspace;
