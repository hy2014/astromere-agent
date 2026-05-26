mod sqlite;
mod terminal;

use claw_agent_ui::control;
use claw_agent_ui::mcp;
use claw_agent_ui::models;
use claw_agent_ui::permissions;
use claw_agent_ui::repl;
use claw_agent_ui::runtime;
use claw_agent_ui::skills;
use claw_agent_ui::workspace;
use sqlite::{
    sqlite_database_info, sqlite_execute, sqlite_query,
    load_bundle_usage_snapshot,
    load_bundle_usage_snapshots_for_session,
    save_bundle_usage_snapshot,
};
use terminal::{terminal_kill, terminal_list, terminal_resize, terminal_spawn, terminal_write};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            terminal::set_app_handle(app.handle().clone());
            std::thread::spawn(|| {
                if let Err(error) = models::refresh_deepseek_pricing_on_startup() {
                    eprintln!("[deepseek-pricing] refresh failed: {error}");
                }
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
            models::load_deepseek_pricing,
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
            save_bundle_usage_snapshot,
            load_bundle_usage_snapshot,
            load_bundle_usage_snapshots_for_session,
            terminal_spawn,
            terminal_write,
            terminal_kill,
            terminal_resize,
            terminal_list,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Claw Agent UI");
}
