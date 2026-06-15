use crate::types::{
    DeepSeekPricingConfig,
    ModelConnectionTestResult, ModelEndpointConfig, ModelProvider, ModelSettings,
};
use crate::utils::{error_to_string, repo_root};
use crate::models_core;

#[cfg_attr(feature = "gui", tauri::command)]
pub fn load_model_settings() -> Result<ModelSettings, String> {
    models_core::load_model_settings()
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn save_model_settings(settings: ModelSettings) -> Result<ModelSettings, String> {
    models_core::save_model_settings(settings)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn test_model_connection(settings: ModelSettings) -> Result<ModelConnectionTestResult, String> {
    models_core::test_active_model_connection(&settings)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn load_deepseek_pricing() -> Result<Option<DeepSeekPricingConfig>, String> {
    models_core::load_deepseek_pricing()
}

pub fn apply_model_env(command: &mut std::process::Command, config: &ModelEndpointConfig) {
    let model = models_core::resolve_model_for_provider(config);

    command.env("ANTHROPIC_MODEL", &model);
    command.env("ANTHROPIC_API_KEY", &config.api_key);

    if !config.base_url.trim().is_empty() {
        command.env("ANTHROPIC_BASE_URL", &config.base_url);
    }

    match config.provider {
        ModelProvider::DeepSeek => {
            command.env("DEEPSEEK_API_KEY", &config.api_key);
            if !config.base_url.trim().is_empty() {
                command.env("DEEPSEEK_BASE_URL", &config.base_url);
            }
        }
        ModelProvider::OpenAI => {
            command.env("OPENAI_API_KEY", &config.api_key);
            if !config.base_url.trim().is_empty() {
                command.env("OPENAI_BASE_URL", &config.base_url);
            }
        }
        ModelProvider::Anthropic => {}
    }
}

pub fn apply_agent_ui_env(
    command: &mut std::process::Command,
    root_path: &std::path::Path,
    session_id: &str,
) -> Result<(), String> {
    let effective_session_id = if session_id.trim().is_empty() {
        "default"
    } else {
        session_id.trim()
    };

    let output_dir = root_path.join(".agent-ui").join(effective_session_id);

    std::fs::create_dir_all(&output_dir).map_err(|error| {
        format!(
            "failed to create agent-ui output dir {}: {error}",
            output_dir.display()
        )
    })?;

    command.env("AGENT_UI_SESSION_ID", effective_session_id);
    command.env(
        "AGENT_UI_OUTPUT_DIR",
        output_dir.to_string_lossy().to_string(),
    );

    if let Ok(home) = std::env::var("HOME") {
        let helper_bin = std::path::PathBuf::from(&home).join(".agent-ui").join("bin");
        let helper_bin_str = helper_bin.to_string_lossy().to_string();
        let old_path = std::env::var("PATH").unwrap_or_default();

        let next_path = if old_path.trim().is_empty() {
            helper_bin_str.clone()
        } else {
            format!("{helper_bin_str}:{old_path}")
        };

        command.env("PATH", next_path);
        command.env("AGENT_UI_HELPER_BIN", helper_bin_str);
    }

    if let Ok(repo) = repo_root() {
        command.env("AGENT_UI_REPO", repo.to_string_lossy().to_string());
    }

    Ok(())
}

pub fn refresh_deepseek_pricing_on_startup() -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(error_to_string)?;
    let candidates = [
        cwd.join("scripts/fetch-deepseek-pricing.mjs"),
        cwd.join("../scripts/fetch-deepseek-pricing.mjs"),
        cwd.join("../../scripts/fetch-deepseek-pricing.mjs"),
    ];
    let script = candidates
        .iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| "scripts/fetch-deepseek-pricing.mjs not found".to_string())?;

    let output = std::process::Command::new("node")
        .arg(script)
        .arg("--write")
        .output()
        .map_err(error_to_string)?;

    if output.status.success() {
        eprintln!("[deepseek-pricing] refreshed on startup");
        eprintln!("[usage-v2-read] enabled={}", true);
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
