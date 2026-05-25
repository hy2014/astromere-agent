use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::types::{
    DeepSeekPricingConfig, DeepSeekPricingModel, DeepSeekPricingItem,
    ModelConnectionTestResult, ModelEndpointConfig, ModelProvider, ModelSettings,
};
use crate::utils::{model_settings_path, error_to_string, ui_config_dir, repo_root};
use crate::mcp::astromere_mcp_config_path;

static DEEPSEEK_PRICING_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<DeepSeekPricingConfig>>> =
    std::sync::OnceLock::new();

fn deepseek_pricing_cache() -> &'static std::sync::Mutex<Option<DeepSeekPricingConfig>> {
    DEEPSEEK_PRICING_CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

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
    fs::write(&path, format!("{raw}\n"))
        .map_err(|e| format!("failed to write model settings: {e}"))?;
    Ok(settings)
}

#[tauri::command]
pub fn test_model_connection(settings: ModelSettings) -> Result<ModelConnectionTestResult, String> {
    let config = active_model_config(&settings)?
        .ok_or_else(|| "No active model configured".to_string())?;
    let model = resolve_model_for_provider(config);

    Ok(ModelConnectionTestResult {
        ok: true,
        message: "配置格式看起来可用；真正连通性会在发送消息时验证。".to_string(),
        model,
        stderr: None,
    })
}

pub fn default_model_settings() -> ModelSettings {
    ModelSettings {
        active_model_id: String::new(),
        models: Vec::new(),
        deepseek_pricing: None,
    }
}

pub fn normalize_model_settings(settings: &mut ModelSettings) -> Result<(), String> {
    for model in &mut settings.models {
        if model.model.is_none() {
            model.model = Some(model.id.clone());
        }
    }
    Ok(())
}

pub fn active_model_config(settings: &ModelSettings) -> Result<Option<&ModelEndpointConfig>, String> {
    if settings.active_model_id.is_empty() {
        return Ok(settings.models.first());
    }
    Ok(settings.models.iter().find(|m| m.id == settings.active_model_id))
}

pub fn resolve_model_for_provider(config: &ModelEndpointConfig) -> String {
    config.model.clone().unwrap_or_else(|| config.id.clone())
}

pub fn apply_model_env(command: &mut std::process::Command, config: &ModelEndpointConfig) {
    let model = resolve_model_for_provider(config);
    let provider_str = match config.provider {
        ModelProvider::DeepSeek => "deepseek",
        ModelProvider::OpenAI => "openai",
        ModelProvider::Anthropic => "anthropic",
    };

    command
        .env("ANTHROPIC_MODEL", &model)
        .env("ANTHROPIC_BASE_URL", &config.base_url)
        .env("ANTHROPIC_API_KEY", &config.api_key)
        .env("ANTHROPIC_MAX_TOKENS", config.max_tokens.to_string())
        .env("ANTHROPIC_PROVIDER", provider_str);

    if let Some(org_id) = &config.organization_id {
        command.env("ANTHROPIC_ORGANIZATION_ID", org_id);
    }
}

pub fn apply_agent_ui_env(command: &mut std::process::Command) {
    if let Ok(repo) = repo_root() {
        command.env("AGENT_UI_REPO", repo.to_string_lossy().to_string());
    }
}

#[tauri::command]
pub fn load_deepseek_pricing() -> Result<Option<DeepSeekPricingConfig>, String> {
    let cache = deepseek_pricing_cache().lock().map_err(error_to_string)?;
    Ok(cache.clone())
}

pub fn refresh_deepseek_pricing_on_startup() -> Result<(), String> {
    let pricing_path = ui_config_dir()?.join("deepseek-pricing.json");
    let config = if pricing_path.is_file() {
        let raw = fs::read_to_string(&pricing_path)
            .map_err(|e| format!("failed to read deepseek pricing: {e}"))?;
        serde_json::from_str(&raw)
            .map_err(|e| format!("failed to parse deepseek pricing: {e}"))?
    } else {
        DeepSeekPricingConfig {
            source: "default".to_string(),
            fetched_at: String::new(),
            url: String::new(),
            currency: "CNY".to_string(),
            unit: "1M tokens".to_string(),
            models: vec![
                DeepSeekPricingModel {
                    model: "deepseek-chat".to_string(),
                    items: vec![
                        DeepSeekPricingItem {
                            item: "输入".to_string(),
                            price_per_m_tokens: 2.0,
                        },
                        DeepSeekPricingItem {
                            item: "输出".to_string(),
                            price_per_m_tokens: 8.0,
                        },
                    ],
                },
            ],
        }
    };

    let mut cache = deepseek_pricing_cache().lock().map_err(error_to_string)?;
    *cache = Some(config.clone());
    Ok(())
}
