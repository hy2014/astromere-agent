mod sqlite;
mod terminal;

use claw_agent_ui::server;

#[cfg(feature = "gui")]
use claw_agent_ui::component_session;

#[cfg(feature = "gui")]
use claw_agent_ui::components;

#[cfg(feature = "gui")]
use claw_agent_ui::control;

#[cfg(feature = "gui")]
use claw_agent_ui::dag;
#[cfg(feature = "gui")]
use claw_agent_ui::dag_server_config;

#[cfg(feature = "gui")]
use claw_agent_ui::mcp;

#[cfg(feature = "gui")]
use claw_agent_ui::models;

#[cfg(feature = "gui")]
use claw_agent_ui::permissions;

#[cfg(feature = "gui")]
use claw_agent_ui::repl;

#[cfg(feature = "gui")]
use claw_agent_ui::runtime;

#[cfg(feature = "gui")]
use claw_agent_ui::scheduler;

#[cfg(feature = "gui")]
use claw_agent_ui::skills;

#[cfg(feature = "gui")]
use claw_agent_ui::workspace;

#[cfg(feature = "gui")]
use sqlite::{
    sqlite_database_info, sqlite_execute, sqlite_query,
    load_bundle_usage_snapshot,
    load_bundle_usage_snapshots_for_session,
    save_bundle_usage_snapshot,
    save_model_call_usage,
    load_model_call_usage,
    load_model_call_usages,
    load_model_call_usages_for_session,
};

#[cfg(feature = "gui")]
use terminal::{terminal_kill, terminal_list, terminal_resize, terminal_spawn, terminal_write};

fn main() {
    let is_remote = std::env::args().any(|a| a == "--remote");

    // Arm a SIGTERM handler so `kill -TERM` (restart script / systemd) stops the
    // worker child gracefully instead of orphaning it. (No-op on non-Unix.)
    claw_agent_ui::engine::install_termination_handler();

    #[cfg(not(feature = "gui"))]
    {
        // No Tauri — always headless. This IS the server role: run the worker.
        eprintln!("[agent-ui] headless mode — HTTP server only");
        let rt = tokio::runtime::Runtime::new()
            .expect("HTTP server: failed to create tokio runtime");
        rt.block_on(server::run_server(None, true));
        return;
    }

    #[cfg(feature = "gui")]
    {
        if is_remote {
            eprintln!("[agent-ui] remote mode — HTTP server only (server role, runs worker)");
            let rt = tokio::runtime::Runtime::new()
                .expect("HTTP server: failed to create tokio runtime");
            rt.block_on(server::run_server(None, true));
            return;
        }

        tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            terminal::set_app_handle(app.handle().clone());
            std::thread::spawn(|| {
                if let Err(error) = models::refresh_deepseek_pricing_on_startup() {
                    eprintln!("[deepseek-pricing] refresh failed: {error}");
                }
            });
            // The HTTP server runs on its own dedicated tokio runtime.
            // The desktop GUI is a pure client of the dag (the dag talks over
            // remote HTTP); this machine does not run a worker (run_worker=false),
            // and the local HTTP server only serves code mode.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new()
                    .expect("HTTP server: failed to create tokio runtime");
                rt.block_on(server::run_server(Some(app_handle), false));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sqlite_query,
            sqlite_execute,
            sqlite_database_info,
            workspace::default_workspace,
            workspace::open_workspace,
            workspace::load_workspace_registry,
            models::load_deepseek_pricing,
            workspace::add_workspace_registry_entry,
            workspace::remove_workspace_registry_entry,
            workspace::list_project_entries,
            workspace::search_workspace_files,
            skills::list_skills,
            skills::install_skill,
            workspace::read_workspace_file,
            workspace::read_local_image_metadata,
            workspace::read_local_image_preview,
            workspace::read_local_reference_file,
            workspace::write_workspace_file,
            workspace::edit_workspace_file,
            runtime::glob_runtime_search,
            runtime::grep_runtime_search,
            runtime::execute_runtime_bash,
            runtime::list_runtime_sessions,
            runtime::load_runtime_session,
            runtime::create_runtime_session,
            workspace::read_git_diff,
            models::load_model_settings,
            models::save_model_settings,
            mcp::load_mcp_settings,
            mcp::save_mcp_settings,
            models::test_model_connection,
            permissions::get_agent_permission_state,
            control::interrupt_agent_turn,
            repl::get_agent_repl_process_status,
            repl::kill_agent_repl_process,
            permissions::respond_agent_permission,
            permissions::set_agent_permission_mode,
            repl::ensure_agent_repl_process,
            repl::fork_agent_repl_process,
            control::get_agent_repl_capabilities,
            control::get_agent_context_usage,
            control::send_agent_repl_input,
            control::run_agent_turn,
            components::list_components,
            components::get_component,
            components::create_component,
            components::update_component,
            components::delete_component,
            components::list_component_files,
            components::verify_component,
            component_session::create_component_session,
            component_session::list_component_sessions,
            component_session::update_component_session_title,
            component_session::delete_component_session,
            dag::list_dags,
            dag::get_dag,
            dag::create_dag,
            dag::update_dag,
            dag::delete_dag,
            dag::delete_dag_node,
            dag::publish_dag,
            dag::unpublish_dag,
            scheduler::run_dag,
            scheduler::submit_resume_run,
            scheduler::get_execution,
            scheduler::list_executions,
            scheduler::get_execution_logs,
            scheduler::get_node_executions,
            scheduler::cancel_execution,
            scheduler::save_bytes_to_file,
            dag_server_config::load_dag_server,
            dag_server_config::save_dag_server,
            dag_server_config::clear_dag_server,
            save_bundle_usage_snapshot,
            load_bundle_usage_snapshot,
            load_bundle_usage_snapshots_for_session,
            save_model_call_usage,
            load_model_call_usage,
            load_model_call_usages,
            load_model_call_usages_for_session,
            terminal_spawn,
            terminal_write,
            terminal_kill,
            terminal_resize,
            terminal_list,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Claw Agent UI");
    // After the app exits, reclaim the execution engine worker (stop_worker sets
    // SHUTDOWN so the supervisor will not recreate it).
    claw_agent_ui::engine::stop_worker();
    } // #[cfg(feature = "gui")]
}
