use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Serialize)]
pub struct WorkspaceState {
    pub root: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRegistryEntry {
    pub root: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRegistry {
    pub workspaces: Vec<WorkspaceRegistryEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProjectEntry {
    pub name: String,
    pub path: String,
    pub kind: ProjectEntryKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectEntryKind {
    File,
    Directory,
}

#[derive(Debug, Serialize)]
pub struct FileView {
    pub path: String,
    pub content: String,
    pub total_lines: usize,
    pub size_bytes: u64,
    pub language: String,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceFileReference {
    pub path: String,
    pub name: String,
    pub directory: String,
    pub extension: Option<String>,
    pub size_bytes: Option<u64>,
    pub modified_epoch_millis: Option<u128>,
    pub score: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImagePreview {
    pub path: String,
    pub mime_type: String,
    pub data_url: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImageMetadata {
    pub path: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct GitDiff {
    pub path: Option<String>,
    pub diff: String,
    pub is_empty: bool,
}

#[derive(Debug, Serialize)]
pub struct AgentTurnResponse {
    pub ok: bool,
    pub message: String,
    pub requires_confirmation: bool,
    pub permission_prompt: Option<String>,
    pub model: Option<String>,
    pub iterations: Option<u64>,
    pub tool_uses: Vec<Value>,
    pub tool_results: Vec<Value>,
    pub usage: Option<Value>,
    pub estimated_cost: Option<String>,
    pub raw_json: Option<Value>,
    pub stderr: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelProvider {
    DeepSeek,
    OpenAI,
    Anthropic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEndpointConfig {
    pub id: String,
    pub name: String,
    pub provider: ModelProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub support_models: Vec<String>,
    pub api_key: String,
    pub base_url: String,
    pub organization_id: Option<String>,
    pub max_tokens: u32,
    pub temperature: f32,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekPricingItem {
    pub item: String,
    pub price_per_m_tokens: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekPricingModel {
    pub model: String,
    pub items: Vec<DeepSeekPricingItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekPricingConfig {
    pub source: String,
    pub fetched_at: String,
    pub url: String,
    pub currency: String,
    pub unit: String,
    pub models: Vec<DeepSeekPricingModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    pub active_model_id: String,
    pub models: Vec<ModelEndpointConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deepseek_pricing: Option<DeepSeekPricingConfig>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnectionTestResult {
    pub ok: bool,
    pub message: String,
    pub model: String,
    pub stderr: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionState {
    pub current_mode: String,
    pub available_modes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReplProcessState {
    pub session_id: String,
    pub root: String,
    pub model: String,
    pub permission_mode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReplSendResult {
    pub accepted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReplProcessStatus {
    pub session_id: String,
    pub root: String,
    pub running: bool,
    pub pid: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentReplCapabilityItem {
    pub name: String,
    pub slash: String,
    pub kind: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentReplCapabilities {
    pub root: String,
    pub session_id: String,
    pub commands: Vec<AgentReplCapabilityItem>,
    pub skills: Vec<AgentReplCapabilityItem>,
    pub slash_commands: Vec<AgentReplCapabilityItem>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextUsage {
    pub root: String,
    pub session_id: String,
    pub data: Value,
    pub updated_at_ms: u64,
}

#[derive(Debug, Deserialize)]
pub struct GrepRuntimeRequest {
    pub pattern: String,
    pub path: Option<String>,
    pub glob: Option<String>,
    pub output_mode: Option<String>,
    pub case_insensitive: Option<bool>,
    pub head_limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct BashRuntimeRequest {
    pub command: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct RuntimeSessionSummary {
    pub id: String,
    pub title: String,
    pub path: String,
    pub updated_at_ms: u64,
    pub modified_epoch_millis: u128,
    pub message_count: usize,
    pub parent_session_id: Option<String>,
    pub branch_name: Option<String>,
}

pub struct ClawProcess {
    pub root: String,
    pub session_id: String,
    pub pid: u32,
    pub stdin: std::process::ChildStdin,
    pub child: std::process::Child,
}

pub struct ControlResponseRegistry {
    pub responses: std::sync::Mutex<HashMap<String, Value>>,
    pub condvar: std::sync::Condvar,
}

pub struct ForkSessionRegistry {
    pub sessions: std::sync::Mutex<HashMap<String, String>>,
}

pub struct SessionReadyRegistry {
    pub sessions: std::sync::Mutex<HashMap<String, bool>>,
    pub condvar: std::sync::Condvar,
}
