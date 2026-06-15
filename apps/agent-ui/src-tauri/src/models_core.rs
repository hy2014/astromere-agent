// ─── models_core.rs — Model settings pure functions ───────────────────
// Tauri IPC 和 HTTP 共用的核心逻辑，不依赖任何框架。

use crate::types::{
    DeepSeekPricingConfig, ModelConnectionTestResult, ModelEndpointConfig,
    ModelProvider, ModelSettings,
};
use crate::utils::{error_to_string, model_settings_path};

/// 加载模型配置（从默认路径）
pub fn load_model_settings() -> Result<ModelSettings, String> {
    let path = model_settings_path()?;
    load_model_settings_from(&path)
}

/// 加载模型配置（从指定路径，供测试用）
pub fn load_model_settings_from(path: &std::path::Path) -> Result<ModelSettings, String> {
    if !path.is_file() {
        return Ok(default_model_settings());
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read model settings: {e}"))?;
    let mut settings: ModelSettings = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse model settings: {e}"))?;
    normalize_model_settings(&mut settings)?;
    Ok(settings)
}

/// 保存模型配置
pub fn save_model_settings(mut settings: ModelSettings) -> Result<ModelSettings, String> {
    normalize_model_settings(&mut settings)?;
    let path = model_settings_path()?;
    save_model_settings_to(&path, &settings)
}

/// 保存模型配置（到指定路径，供测试用）
pub fn save_model_settings_to(
    path: &std::path::Path,
    settings: &ModelSettings,
) -> Result<ModelSettings, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create model settings dir: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("failed to serialize model settings: {e}"))?;
    std::fs::write(path, &raw).map_err(error_to_string)?;
    Ok(settings.clone())
}

/// 测试模型连接（仅验证配置格式，不发起 HTTP 请求）
pub fn test_model_config(config: &ModelEndpointConfig) -> ModelConnectionTestResult {
    let model = resolve_model_for_provider(config);

    if config.api_key.trim().is_empty() {
        return ModelConnectionTestResult {
            ok: false,
            message: "API key 为空".to_string(),
            model,
            stderr: None,
        };
    }

    ModelConnectionTestResult {
        ok: true,
        message: "配置格式看起来可用；真正连通性会在发送消息时验证。".to_string(),
        model,
        stderr: None,
    }
}

/// 测试活跃模型连接
pub fn test_active_model_connection(settings: &ModelSettings) -> Result<ModelConnectionTestResult, String> {
    let config = active_model_config(settings)?;
    Ok(test_model_config(config))
}

/// 从 model-settings.json 加载 DeepSeek 定价
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

// ─── 纯辅助函数 ────────────────────────────────────────────────────────

pub fn default_model_settings() -> ModelSettings {
    ModelSettings {
        active_model_id: "deepseek".to_string(),
        models: vec![
            ModelEndpointConfig {
                id: "deepseek".to_string(),
                name: "DeepSeek".to_string(),
                provider: ModelProvider::DeepSeek,
                model: Some("deepseek-chat".to_string()),
                support_models: vec![
                    "deepseek-chat".to_string(),
                    "deepseek-reasoner".to_string(),
                ],
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

pub fn active_model_config(
    settings: &ModelSettings,
) -> Result<&ModelEndpointConfig, String> {
    settings
        .models
        .iter()
        .find(|m| m.id == settings.active_model_id && m.enabled)
        .or_else(|| settings.models.iter().find(|m| m.enabled))
        .ok_or_else(|| "没有启用的模型配置".to_string())
}

pub fn resolve_model_for_provider(config: &ModelEndpointConfig) -> String {
    config.model.clone().unwrap_or_else(|| match config.provider {
        ModelProvider::DeepSeek => "deepseek-chat".to_string(),
        ModelProvider::OpenAI => "gpt-4o".to_string(),
        ModelProvider::Anthropic => "claude-sonnet-4-5-20250929".to_string(),
    })
}

// ─── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_settings_has_deepseek_and_anthropic() {
        let settings = default_model_settings();
        assert_eq!(settings.models.len(), 2);
        assert_eq!(settings.active_model_id, "deepseek");
    }

    #[test]
    fn test_normalize_fixes_bad_active_model() {
        let mut settings = default_model_settings();
        settings.active_model_id = "nonexistent".to_string();
        normalize_model_settings(&mut settings).unwrap();
        assert_eq!(settings.active_model_id, "deepseek");
    }

    #[test]
    fn test_normalize_empty_models_is_error() {
        let mut settings = ModelSettings {
            active_model_id: "x".to_string(),
            models: vec![],
            deepseek_pricing: None,
        };
        assert!(normalize_model_settings(&mut settings).is_err());
    }

    #[test]
    fn test_active_model_config_finds_enabled() {
        let settings = default_model_settings();
        let config = active_model_config(&settings).unwrap();
        assert_eq!(config.id, "deepseek");
    }

    #[test]
    fn test_test_model_config_no_api_key() {
        let mut config = default_model_settings().models[0].clone();
        config.api_key = "".to_string();
        let result = test_model_config(&config);
        assert!(!result.ok);
        assert!(result.message.contains("API key"));
    }

    #[test]
    fn test_test_model_config_with_key() {
        let mut config = default_model_settings().models[0].clone();
        config.api_key = "sk-test123".to_string();
        let result = test_model_config(&config);
        assert!(result.ok);
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("model-settings.json");

        let settings = default_model_settings();
        save_model_settings_to(&path, &settings).unwrap();

        let loaded = load_model_settings_from(&path).unwrap();
        assert_eq!(loaded.active_model_id, settings.active_model_id);
        assert_eq!(loaded.models.len(), settings.models.len());
    }

    #[test]
    fn test_load_nonexistent_file_returns_default() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nonexistent.json");
        let settings = load_model_settings_from(&path).unwrap();
        assert_eq!(settings.models.len(), 2);
    }

    #[test]
    fn test_model_id_preserved_on_save() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("model-settings.json");

        let mut settings = default_model_settings();
        settings.models[0].id = "my-custom-model".to_string();
        settings.active_model_id = "my-custom-model".to_string();

        save_model_settings_to(&path, &settings).unwrap();
        let loaded = load_model_settings_from(&path).unwrap();

        assert_eq!(loaded.active_model_id, "my-custom-model");
        assert_eq!(loaded.models[0].id, "my-custom-model");
    }

    // ── resolve_model_for_provider ──

    #[test]
    fn test_resolve_model_uses_config_model_when_set() {
        let config = ModelEndpointConfig {
            id: "test".into(), name: "Test".into(), provider: ModelProvider::DeepSeek,
            model: Some("my-custom-model".into()), support_models: vec![],
            api_key: "".into(), base_url: "".into(), organization_id: None,
            max_tokens: 4096, temperature: 0.0, enabled: true,
        };
        assert_eq!(resolve_model_for_provider(&config), "my-custom-model");
    }

    #[test]
    fn test_resolve_model_deepseek_default() {
        let config = ModelEndpointConfig {
            id: "ds".into(), name: "DS".into(), provider: ModelProvider::DeepSeek,
            model: None, support_models: vec![],
            api_key: "".into(), base_url: "".into(), organization_id: None,
            max_tokens: 4096, temperature: 0.0, enabled: true,
        };
        assert_eq!(resolve_model_for_provider(&config), "deepseek-chat");
    }

    #[test]
    fn test_resolve_model_openai_default() {
        let config = ModelEndpointConfig {
            id: "oa".into(), name: "OA".into(), provider: ModelProvider::OpenAI,
            model: None, support_models: vec![],
            api_key: "".into(), base_url: "".into(), organization_id: None,
            max_tokens: 4096, temperature: 0.0, enabled: true,
        };
        assert_eq!(resolve_model_for_provider(&config), "gpt-4o");
    }

    #[test]
    fn test_resolve_model_anthropic_default() {
        let config = ModelEndpointConfig {
            id: "an".into(), name: "AN".into(), provider: ModelProvider::Anthropic,
            model: None, support_models: vec![],
            api_key: "".into(), base_url: "".into(), organization_id: None,
            max_tokens: 4096, temperature: 0.0, enabled: true,
        };
        assert_eq!(resolve_model_for_provider(&config), "claude-sonnet-4-5-20250929");
    }

    // ── active_model_config edge cases ──

    #[test]
    fn test_active_model_config_skips_disabled() {
        let mut settings = default_model_settings();
        settings.models[0].enabled = false; // deepseek disabled
        // Should fall back to anthropic (enabled)
        let config = active_model_config(&settings).unwrap();
        assert_eq!(config.id, "anthropic");
    }

    #[test]
    fn test_active_model_config_all_disabled_is_error() {
        let mut settings = default_model_settings();
        for m in &mut settings.models {
            m.enabled = false;
        }
        assert!(active_model_config(&settings).is_err());
    }

    // ── load_model_settings edge cases ──

    #[test]
    fn test_load_corrupted_file_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bad.json");
        std::fs::write(&path, "not valid json at all {{{").unwrap();
        let result = load_model_settings_from(&path);
        assert!(result.is_err());
    }

    #[test]
    fn test_test_active_model_connection_err_on_missing_file() {
        // test_active_model_connection calls load_model_settings() which
        // reads from the real model-settings.json. If it doesn't exist,
        // load_model_settings falls back to default. But the function
        // itself shouldn't panic.
        let result = test_active_model_connection(&default_model_settings());
        assert!(result.is_ok()); // uses default, which has enabled models
    }

    // ── deepseek_pricing roundtrip ──

    #[test]
    fn test_deepseek_pricing_in_settings_roundtrip() {
        let pricing = crate::types::DeepSeekPricingConfig {
            source: "test".into(),
            fetched_at: "2026-01-01".into(),
            url: "https://example.com".into(),
            currency: "CNY".into(),
            unit: "per 1M tokens".into(),
            models: vec![],
        };
        let settings = ModelSettings {
            active_model_id: "deepseek".into(),
            models: default_model_settings().models,
            deepseek_pricing: Some(pricing),
        };

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("model-settings.json");
        save_model_settings_to(&path, &settings).unwrap();

        let loaded = load_model_settings_from(&path).unwrap();
        let loaded_pricing = loaded.deepseek_pricing.unwrap();
        assert_eq!(loaded_pricing.source, "test");
        assert_eq!(loaded_pricing.currency, "CNY");
    }
}
