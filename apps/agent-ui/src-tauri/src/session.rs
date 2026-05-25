// Re-export from sub-modules for backwards compatibility.
// session.rs previously contained both repl lifecycle and control protocol code.
// It has been split into:
//   - repl.rs    — REPL process lifecycle (ensure/fork/kill/status, stdout reader)
//   - control.rs — Process communication protocol (interrupt/send/capabilities/run-turn)
//
// This file re-exports tauri commands so main.rs doesn't need to change.

pub use crate::repl::{
    get_agent_repl_process_status,
    kill_agent_repl_process,
    ensure_agent_repl_process,
    fork_agent_repl_process,
};

pub use crate::control::{
    interrupt_agent_turn,
    send_agent_repl_input,
    get_agent_repl_capabilities,
    get_agent_context_usage,
    run_agent_turn,
};
