use std::fs;

use crate::types::{
    DeepSeekPricingConfig,
    ModelConnectionTestResult, ModelEndpointConfig, ModelProvider, ModelSettings,
};
use crate::utils::{model_settings_path, error_to_string, repo_root};

#[tauri::command]
pub fn load_model_settings() -> Result<ModelSettings, String> {
    let path = model_settings_path()?;
    if !path.is_file() {
        return Ok(default_model_settings());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read model settings: {e}"))?;
    let mut settings: ModelSettings = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse model settings: {e}"))?;
    normalize_model_settings(&mut settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn save_model_settings(mut settings: ModelSettings) -> Result<ModelSettings, String> {
    normalize_model_settings(&mut settings)?;
    let path = model_settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create model settings dir: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("failed to serialize model settings: {e}"))?;
    fs::write(&path, &raw)
        .map_err(error_to_string)?;
    Ok(settings)
}

#[tauri::command]
pub fn test_model_connection(settings: ModelSettings) -> Result<ModelConnectionTestResult, String> {
    let config = active_model_config(&settings)?;
    let model = resolve_model_for_provider(config);

    if config.api_key.trim().is_empty() {
        return Ok(ModelConnectionTestResult {
            ok: false,
            message: "API key 为空".to_string(),
            model,
            stderr: None,
        });
    }

    Ok(ModelConnectionTestResult {
        ok: true,
        message: "配置格式看起来可用；真正连通性会在发送消息时验证。".to_string(),
        model,
        stderr: None,
    })
}

pub fn default_model_settings() -> ModelSettings {
    ModelSettings {
        active_model_id: "deepseek".to_string(),
        models: vec![
            ModelEndpointConfig {
                id: "deepseek".to_string(),
                name: "DeepSeek".to_string(),
                provider: ModelProvider::DeepSeek,
                model: Some("deepseek-chat".to_string()),
                support_models: vec!["deepseek-chat".to_string(), "deepseek-reasoner".to_string()],
                api_key: std::env::var("DEEPSEEK_API_KEY")
                    .or_else(|_| std::env::var("ANTHROPIC_API_KEY"))
                    .unwrap_or_default(),
                base_url: std::env::var("DEEPSEEK_BASE_URL")
                    .or_else(|_| std::env::var("ANTHROPIC_BASE_URL"))
                    .unwrap_or_else(|_| "https://api.deepseek.com/anthropic".to_string()),
                organization_id: None,
                max_tokens: 4096,
                temperature: 0.2,
                enabled: true,
            },
            ModelEndpointConfig {
                id: "anthropic".to_string(),
                name: "Anthropic".to_string(),
                provider: ModelProvider::Anthropic,
                model: Some("claude-sonnet-4-5-20250929".to_string()),
                support_models: vec![],
                api_key: std::env::var("ANTHROPIC_API_KEY").unwrap_or_default(),
                base_url: std::env::var("ANTHROPIC_BASE_URL").unwrap_or_default(),
                organization_id: None,
                max_tokens: 4096,
                temperature: 0.2,
                enabled: true,
            },
        ],
        deepseek_pricing: None,
    }
}

pub fn normalize_model_settings(settings: &mut ModelSettings) -> Result<(), String> {
    if settings.models.is_empty() {
        return Err("至少需要一个模型配置".to_string());
    }
    if !settings.models.iter().any(|m| m.id == settings.active_model_id) {
        settings.active_model_id = settings.models[0].id.clone();
    }
    Ok(())
}

pub fn active_model_config(settings: &ModelSettings) -> Result<&ModelEndpointConfig, String> {
    settings
        .models
        .iter()
        .find(|m| m.id == settings.active_model_id && m.enabled)
        .or_else(|| settings.models.iter().find(|m| m.enabled))
        .ok_or_else(|| "没有启用的模型配置".to_string())
}

pub fn resolve_model_for_provider(config: &ModelEndpointConfig) -> String {
    config
        .model
        .clone()
        .unwrap_or_else(|| match config.provider {
            ModelProvider::DeepSeek => "deepseek-chat".to_string(),
            ModelProvider::OpenAI => "gpt-4o".to_string(),
            ModelProvider::Anthropic => "claude-sonnet-4-5-20250929".to_string(),
        })
}

pub fn apply_model_env(command: &mut std::process::Command, config: &ModelEndpointConfig) {
    let model = resolve_model_for_provider(config);

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

#[tauri::command]
pub fn load_deepseek_pricing() -> Result<Option<DeepSeekPricingConfig>, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let settings_path = std::path::Path::new(&home).join(".agent-ui").join("model-settings.json");
    if settings_path.exists() {
        let data = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        let settings: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        if let Some(pricing) = settings.get("deepseekPricing") {
            serde_json::from_value(pricing.clone()).map_err(|e| e.to_string())
        } else {
            Ok(None)
        }
    } else {
        Ok(None)
    }
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
