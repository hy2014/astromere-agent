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

// ─── Component / DAG platform types ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    /// Deprecated: retained as a physical column to avoid a dangerous DROP/ALTER
    /// rebuild. No longer used for logical decisions; session paths are derived
    /// from `component_id` instead.
    pub workspace_root: String,
    /// Git source — the configuration truth-source for where the code lives.
    pub git_url: String,
    pub git_branch: String,
    /// Optional pinned ref (tag/branch); folded into the env cache key.
    pub git_ref: String,
    /// Git entry file relative path, e.g. `run.py` or `subdir/run.py`.
    pub entry_point: String,
    pub input_schema: Value,
    pub output_schema: Value,
    /// Configuration schema (config_schema): the list of parameter declarations
    /// the component exposes to its users. Stored as a JSON array of
    /// `{key, label, type, required, default, enum, description}`. NULL/empty =
    /// no parameters. Declared by the user in the UI, NOT by the git author.
    pub config_schema: Value,
    pub tags: Vec<String>,
    /// Registry flag: `true` => registered/global component (appears in the
    /// "component" list, reusable across DAGs); `false` => a generic, non-global
    /// component created by dragging "generic component" onto the canvas.
    pub global: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSession {
    pub id: String,
    pub component_id: String,
    pub session_id: String,
    pub session_path: String,
    pub title: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dag {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub execution_order: Option<Value>,
    pub cron: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DagNode {
    pub id: String,
    pub dag_id: String,
    pub component_id: String,
    pub label: String,
    pub position: DagNodePosition,
    pub config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DagNodePosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DagEdge {
    pub id: String,
    pub dag_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub source_handle: String,
    pub target_handle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DagDetail {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub execution_order: Option<Value>,
    pub cron: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub nodes: Vec<DagNode>,
    pub edges: Vec<DagEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DagExecution {
    pub id: String,
    pub dag_id: String,
    pub status: String,
    pub trigger_kind: Option<String>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub outputs: Option<Value>,
    /// Frozen DAG plan (nodes w/ config + edges + execution_order) captured at
    /// submit time. Lets a historical run replay / display the exact config it
    /// ran with, not the live DAG that may have changed since.
    pub snapshot: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeExecution {
    pub id: String,
    pub execution_id: String,
    pub node_id: String,
    pub status: String,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub output_path: Option<String>,
    /// Per-output-port runtime artifacts (third layer = runtime artifacts), indexed by
    /// output port key, e.g. `{"data": "/path/a.csv", "metrics": "/path/m.json"}`.
    /// Written by the Python execution engine; NOT a user configuration input.
    pub outputs: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionLog {
    pub id: Option<i64>,
    pub execution_id: String,
    pub node_id: Option<String>,
    pub level: String,
    pub message: String,
    pub timestamp_ms: i64,
}

/// A single page of a node's on-disk log file
/// (`<log_dir>/<execution_id>/<node_id>.log`).
///
/// The file holds the node's *full* (untruncated) stdout/stderr, so the client
/// pages through it explicitly via `offset`/`limit` instead of loading the
/// whole thing into memory. `total` is the line count of the file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeLogFile {
    pub lines: Vec<String>,
    pub offset: usize,
    pub limit: usize,
    pub total: usize,
    /// Always `false` for a single page — the client drives paging via
    /// `offset`/`limit`, so a page is never "truncated" server-side.
    pub truncated: bool,
}

// ─── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── RuntimeSessionSummary ──

    #[test]
    fn test_runtime_session_summary_serialization() {
        let s = RuntimeSessionSummary {
            id: "abc-123".into(),
            title: "My session".into(),
            path: "/tmp/sessions/abc-123.jsonl".into(),
            updated_at_ms: 1700000000000,
            modified_epoch_millis: 1700000000000,
            message_count: 5,
            parent_session_id: Some("parent-456".into()),
            branch_name: Some("main".into()),
        };
        let json = serde_json::to_value(&s).unwrap();
        // RuntimeSessionSummary uses snake_case for IPC compatibility with the frontend
        assert_eq!(json["id"], "abc-123");
        assert_eq!(json["title"], "My session");
        assert_eq!(json["message_count"], 5);
        assert_eq!(json["parent_session_id"], "parent-456");
        assert_eq!(json["branch_name"], "main");
        assert_eq!(json["updated_at_ms"], 1700000000000u64);
        assert_eq!(json["modified_epoch_millis"], 1700000000000u64);
    }

    #[test]
    fn test_runtime_session_summary_no_parent() {
        let s = RuntimeSessionSummary {
            id: "x".into(), title: "t".into(), path: "p".into(),
            updated_at_ms: 0, modified_epoch_millis: 0, message_count: 0,
            parent_session_id: None, branch_name: None,
        };
        let json = serde_json::to_value(&s).unwrap();
        assert!(json["parent_session_id"].is_null());
        assert!(json["branch_name"].is_null());
    }

    // ── AgentReplProcessState ──

    #[test]
    fn test_agent_repl_process_state_camelcase() {
        let s = AgentReplProcessState {
            session_id: "sid-1".into(),
            root: "/proj".into(),
            model: "deepseek-chat".into(),
            permission_mode: "default".into(),
        };
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["sessionId"], "sid-1");
        assert_eq!(json["root"], "/proj");
        assert_eq!(json["model"], "deepseek-chat");
        assert_eq!(json["permissionMode"], "default");
    }

    // ── AgentReplProcessStatus ──

    #[test]
    fn test_agent_repl_process_status_camelcase() {
        let s = AgentReplProcessStatus {
            session_id: "sid-1".into(),
            root: "/proj".into(),
            running: true,
            pid: Some(12345),
        };
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["sessionId"], "sid-1");
        assert_eq!(json["running"], true);
        assert_eq!(json["pid"], 12345);
    }

    #[test]
    fn test_agent_repl_process_status_not_running() {
        let s = AgentReplProcessStatus {
            session_id: "sid-2".into(), root: "/proj".into(),
            running: false, pid: None,
        };
        let json = serde_json::to_value(&s).unwrap();
        assert!(!json["running"].as_bool().unwrap());
        assert!(json["pid"].is_null());
    }

    // ── AgentReplSendResult ──

    #[test]
    fn test_agent_repl_send_result_camelcase() {
        let s = AgentReplSendResult { accepted: true };
        let json = serde_json::to_value(&s).unwrap();
        assert!(json["accepted"].as_bool().unwrap());
    }

    // ── AgentReplCapabilities ──

    #[test]
    fn test_agent_repl_capabilities_camelcase() {
        let caps = AgentReplCapabilities {
            root: "/proj".into(),
            session_id: "sid-1".into(),
            commands: vec![AgentReplCapabilityItem {
                name: "build".into(), slash: "/build".into(),
                kind: "command".into(), description: Some("build project".into()),
            }],
            skills: vec![],
            slash_commands: vec![],
            updated_at_ms: 1700000000000,
        };
        let json = serde_json::to_value(&caps).unwrap();
        assert_eq!(json["root"], "/proj");
        assert_eq!(json["sessionId"], "sid-1");
        assert_eq!(json["updatedAtMs"], 1700000000000u64);
        assert_eq!(json["commands"][0]["name"], "build");
        assert_eq!(json["commands"][0]["description"], "build project");
    }

    // ── AgentContextUsage ──

    #[test]
    fn test_agent_context_usage_camelcase() {
        let usage = AgentContextUsage {
            root: "/proj".into(),
            session_id: "sid-1".into(),
            data: json!({"tokens": 1234}),
            updated_at_ms: 1700000000000,
        };
        let json = serde_json::to_value(&usage).unwrap();
        assert_eq!(json["sessionId"], "sid-1");
        assert_eq!(json["updatedAtMs"], 1700000000000u64);
        assert_eq!(json["data"]["tokens"], 1234);
    }

    // ── ModelSettings deserialization ──

    #[test]
    fn test_model_settings_deserialization() {
        let json = json!({
            "activeModelId": "deepseek",
            "models": [{
                "id": "deepseek",
                "name": "DeepSeek",
                "provider": "deepseek",
                "model": "deepseek-chat",
                "apiKey": "sk-xxx",
                "baseUrl": "https://api.deepseek.com/anthropic",
                "maxTokens": 4096,
                "temperature": 0.2,
                "enabled": true
            }]
        });
        let settings: ModelSettings = serde_json::from_value(json).unwrap();
        assert_eq!(settings.active_model_id, "deepseek");
        assert_eq!(settings.models.len(), 1);
        assert_eq!(settings.models[0].provider, ModelProvider::DeepSeek);
        assert!(settings.deepseek_pricing.is_none());
    }

    #[test]
    fn test_model_settings_with_pricing() {
        let json = json!({
            "activeModelId": "deepseek",
            "models": [],
            "deepseekPricing": {
                "source": "api",
                "fetchedAt": "2026-01-01",
                "url": "https://api.deepseek.com/pricing",
                "currency": "CNY",
                "unit": "per 1M tokens",
                "models": []
            }
        });
        let settings: ModelSettings = serde_json::from_value(json).unwrap();
        let pricing = settings.deepseek_pricing.unwrap();
        assert_eq!(pricing.source, "api");
        assert_eq!(pricing.currency, "CNY");
    }

    // ── ModelEndpointConfig defaults ──

    #[test]
    fn test_model_endpoint_config_optional_fields() {
        // support_models defaults to [], organization_id defaults to None
        let json = json!({
            "id": "test",
            "name": "Test",
            "provider": "openai",
            "apiKey": "sk-xxx",
            "baseUrl": "https://api.openai.com",
            "maxTokens": 4096,
            "temperature": 0.0,
            "enabled": true
        });
        let config: ModelEndpointConfig = serde_json::from_value(json).unwrap();
        assert!(config.support_models.is_empty());
        assert!(config.organization_id.is_none());
    }

    // ── WorkspaceFileReference ──

    #[test]
    fn test_workspace_file_reference_snake_case() {
        let f = WorkspaceFileReference {
            path: "/proj/src/main.rs".into(),
            name: "main.rs".into(),
            directory: "/proj/src".into(),
            extension: Some("rs".into()),
            size_bytes: Some(1024),
            modified_epoch_millis: Some(1700000000000),
            score: 100,
        };
        let json = serde_json::to_value(&f).unwrap();
        assert_eq!(json["size_bytes"], 1024);
        assert_eq!(json["modified_epoch_millis"].as_u64(), Some(1700000000000));
    }

    // ── ProjectEntryKind ──

    #[test]
    fn test_project_entry_kind_lowercase() {
        let e = ProjectEntry { name: "f".into(), path: "/f".into(), kind: ProjectEntryKind::File };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "file");

        let d = ProjectEntry { name: "d".into(), path: "/d".into(), kind: ProjectEntryKind::Directory };
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json["kind"], "directory");
    }

    // ── McpServerConfig deserialization ──

    #[test]
    fn test_mcp_server_config_deserialization() {
        use crate::mcp::McpServerConfig; // import from mcp module
        let json = json!({
            "enabled": true,
            "type": "stdio",
            "command": "node",
            "args": ["server.js"],
            "env": {"NODE_ENV": "production"},
            "cwd": "/project",
            "tools": [{"name": "search", "description": "search tool"}]
        });
        let config: McpServerConfig = serde_json::from_value(json).unwrap();
        assert_eq!(config.enabled, Some(true));
        assert_eq!(config.server_type, Some("stdio".to_string()));
        assert_eq!(config.command, "node");
        assert_eq!(config.args, Some(vec!["server.js".to_string()]));
        assert_eq!(config.env.unwrap().get("NODE_ENV").unwrap(), "production");
        assert_eq!(config.cwd, Some("/project".to_string()));
        assert_eq!(config.tools.len(), 1);
    }

    #[test]
    fn test_mcp_server_config_minimal() {
        use crate::mcp::McpServerConfig;
        let json = json!({"command": "echo"});
        let config: McpServerConfig = serde_json::from_value(json).unwrap();
        assert_eq!(config.command, "echo");
        assert!(config.enabled.is_none());
        assert!(config.server_type.is_none());
        assert!(config.args.is_none());
        assert!(config.env.is_none());
        assert!(config.cwd.is_none());
        assert!(config.tools.is_empty());
    }

    // ── McpSettings deserialization ──

    #[test]
    fn test_mcp_settings_deserialization() {
        use crate::mcp::McpSettings;
        let json = json!({
            "mcpServers": {
                "srv1": {"command": "node"},
                "srv2": {"command": "python"}
            }
        });
        let settings: McpSettings = serde_json::from_value(json).unwrap();
        assert_eq!(settings.mcp_servers.len(), 2);
        assert!(settings.mcp_servers.contains_key("srv1"));
        assert!(settings.mcp_servers.contains_key("srv2"));
    }

    // ── GrepRuntimeRequest ──

    #[test]
    fn test_grep_runtime_request_all_fields() {
        let json = json!({
            "pattern": "TODO",
            "path": "src",
            "glob": "*.rs",
            "output_mode": "content",
            "case_insensitive": true,
            "head_limit": 50
        });
        let req: GrepRuntimeRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.pattern, "TODO");
        assert_eq!(req.path, Some("src".to_string()));
        assert_eq!(req.glob, Some("*.rs".to_string()));
        assert_eq!(req.output_mode, Some("content".to_string()));
        assert_eq!(req.case_insensitive, Some(true));
        assert_eq!(req.head_limit, Some(50));
    }

    // ── BashRuntimeRequest ──

    #[test]
    fn test_bash_runtime_request_all_fields() {
        let json = json!({"command": "ls", "timeout_ms": 5000});
        let req: BashRuntimeRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.command, "ls");
        assert_eq!(req.timeout_ms, Some(5000));
    }

    // ── DeepSeekPricingConfig roundtrip ──

    #[test]
    fn test_deepseek_pricing_roundtrip() {
        let pricing = DeepSeekPricingConfig {
            source: "api".into(),
            fetched_at: "2026-06-15".into(),
            url: "https://api.deepseek.com/pricing".into(),
            currency: "CNY".into(),
            unit: "per 1M tokens".into(),
            models: vec![DeepSeekPricingModel {
                model: "deepseek-chat".into(),
                items: vec![DeepSeekPricingItem {
                    item: "input".into(),
                    price_per_m_tokens: 1.0,
                }],
            }],
        };
        let json = serde_json::to_value(&pricing).unwrap();
        assert_eq!(json["source"], "api");
        assert_eq!(json["currency"], "CNY");
        assert_eq!(json["models"][0]["model"], "deepseek-chat");

        let back: DeepSeekPricingConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.source, "api");
        assert_eq!(back.models[0].items[0].price_per_m_tokens, 1.0);
    }

    // ── GitDiff ──

    #[test]
    fn test_git_diff_separate_path() {
        let gd = GitDiff { path: Some("file.rs".into()), diff: "diff content".into(), is_empty: false };
        let json = serde_json::to_value(&gd).unwrap();
        assert_eq!(json["path"], "file.rs");
        assert_eq!(json["diff"], "diff content");
        assert!(!json["is_empty"].as_bool().unwrap());
    }

    // ── ModelProvider serialize/deserialize ──

    #[test]
    fn test_model_provider_lowercase() {
        let v = serde_json::to_value(ModelProvider::DeepSeek).unwrap();
        assert_eq!(v, "deepseek");
        let v = serde_json::to_value(ModelProvider::OpenAI).unwrap();
        assert_eq!(v, "openai");
        let v = serde_json::to_value(ModelProvider::Anthropic).unwrap();
        assert_eq!(v, "anthropic");

        let p: ModelProvider = serde_json::from_value(json!("deepseek")).unwrap();
        assert_eq!(p, ModelProvider::DeepSeek);
    }
}
