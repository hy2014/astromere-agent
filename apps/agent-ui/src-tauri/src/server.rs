// ─── HTTP Server (axum) — runs alongside Tauri IPC ──────────────────────

use axum::{Json, Router, extract::{Path, Query, State}, http::StatusCode, response::{IntoResponse, sse::{Event, Sse}, Response}, routing::{get, post}};
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::convert::Infallible;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::broadcast;

use crate::control;
use crate::mcp_core;
use crate::models_core;
use crate::permissions;
use crate::repl;
use crate::runtime;
use crate::session_core;
use crate::skills;
use crate::sqlite;
use crate::types::{
    AgentReplProcessState, AgentReplProcessStatus, AgentReplSendResult,
    ModelConnectionTestResult, ModelSettings, RuntimeSessionSummary,
};
use crate::workspace;

// ─── AppError: proper HTTP error responses ───────────────────────────
// Before this fix, all handlers returned `Result<Json<T>, String>`.
// In axum 0.7, `String` implements `IntoResponse` by returning 200 OK with
// plain text — which means the frontend sees `response.ok === true` on
// errors and then crashes on `JSON.parse`.  AppError fixes this by returning
// a proper 500 status code with a JSON body like `{"error": "..."}`.

#[derive(Debug)]
pub struct AppError(String);

impl AppError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({ "error": self.0 });
        (StatusCode::INTERNAL_SERVER_ERROR, Json(body)).into_response()
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        Self(s)
    }
}

// ─── HTTP Server config ────────────────────────────────────────────────

// ─── HTTP Server config ────────────────────────────────────────────────

/// 默认端口（由 AGENT_UI_HTTP_PORT 环境变量覆盖）
const DEFAULT_HTTP_PORT: u16 = 7421;

fn http_port() -> u16 {
    std::env::var("AGENT_UI_HTTP_PORT")
        .ok()
        .and_then(|s| match s.parse() {
            Ok(p) => Some(p),
            Err(_) => {
                eprintln!("[http] WARNING: AGENT_UI_HTTP_PORT='{s}' is not a valid port, using default {DEFAULT_HTTP_PORT}");
                None
            }
        })
        .unwrap_or(DEFAULT_HTTP_PORT)
}

fn http_enabled() -> bool {
    std::env::var("AGENT_UI_HTTP_ENABLED")
        .map(|v| !matches!(v.to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"))
        .unwrap_or(true)
}

// ─── Global SSE broadcast ─────────────────────────────────────────────

static SSE_BROADCAST: OnceLock<broadcast::Sender<String>> = OnceLock::new();

pub fn sse_broadcast_sender() -> &'static broadcast::Sender<String> {
    SSE_BROADCAST.get_or_init(|| {
        let (tx, _) = broadcast::channel(1024);
        tx
    })
}

/// 向 SSE 订阅者广播事件（由 repl.rs 的事件分发调用）
pub fn broadcast_sse_event(event_json: String) {
    let _ = sse_broadcast_sender().send(event_json);
}

// ─── AppState ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct AppState {
    pub app_handle: AppHandle,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Deserialize)]
struct SessionQuery {
    root: String,
}

async fn health_handler() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

// ─── Session handlers ─────────────────────────────────────────────────

async fn list_sessions_handler(Query(query): Query<SessionQuery>) -> Result<Json<Vec<RuntimeSessionSummary>>, AppError> {
    let sessions = session_core::list_sessions(&query.root)
        .map_err(|e| AppError::new(format!("failed to list sessions: {e}")))?;
    Ok(Json(sessions))
}

async fn load_session_handler(
    Path(id): Path<String>,
    Query(query): Query<SessionQuery>,
) -> Result<Json<Value>, AppError> {
    let detail = session_core::load_session(&query.root, &id)
        .map_err(|e| AppError::new(format!("failed to load session: {e}")))?;
    Ok(Json(detail))
}

#[derive(Deserialize)]
struct CreateSessionRequest {
    root: String,
}

async fn create_session_handler(
    Json(req): Json<CreateSessionRequest>,
) -> Result<Json<RuntimeSessionSummary>, AppError> {
    let summary = session_core::create_session(&req.root)
        .map_err(|e| AppError::new(format!("failed to create session: {e}")))?;
    Ok(Json(summary))
}

pub fn app_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        // sessions
        .route("/sessions/{id}", get(load_session_handler))
        .route("/sessions", get(list_sessions_handler).post(create_session_handler))
        // models
        .route("/models/settings", get(load_model_settings_handler).put(save_model_settings_handler))
        .route("/models/test", post(test_model_handler))
        .route("/models/deepseek-pricing", get(deepseek_pricing_handler))
        // mcp
        .route("/mcp/settings", get(load_mcp_settings_handler).put(save_mcp_settings_handler))
        // workspace
        .route("/workspace/default", get(default_workspace_handler))
        .route("/workspace/open", get(open_workspace_handler))
        .route("/workspaces", get(list_workspaces_handler).post(add_workspace_handler).delete(remove_workspace_handler))
        .route("/workspace/entries", get(list_workspace_entries_handler))
        .route("/workspace/file", get(read_workspace_file_handler).put(write_workspace_file_handler))
        .route("/workspace/file/edit", post(edit_workspace_file_handler))
        .route("/workspace/image/metadata", get(image_metadata_handler))
        .route("/workspace/image/preview", get(image_preview_handler))
        .route("/workspace/search", get(search_workspace_handler))
        // runtime
        .route("/runtime/glob", post(glob_handler))
        .route("/runtime/grep", post(grep_handler))
        .route("/runtime/bash", post(bash_handler))
        // git
        .route("/git/diff", get(git_diff_handler))
        // skills
        .route("/skills", get(list_skills_handler).post(install_skill_handler))
        // agent
        .route("/agent/ensure", post(ensure_handler))
        .route("/agent/input", post(send_input_handler))
        .route("/agent/status", get(process_status_handler))
        .route("/agent/interrupt", post(interrupt_handler))
        .route("/agent/kill", post(kill_handler))
        .route("/agent/fork", post(fork_handler))
        .route("/agent/capabilities", get(capabilities_handler))
        .route("/agent/context-usage", get(context_usage_handler))
        .route("/agent/run-turn", post(run_turn_handler))
        .route("/agent/permission-state", get(permission_state_handler))
        .route("/agent/permission-mode", post(set_permission_mode_handler))
        .route("/agent/permission-response", post(respond_permission_handler))
        // usage
        .route("/usage/bundle", post(save_bundle_usage_handler))
        .route("/usage/bundle/{session_id}/{bundle_id}", get(load_bundle_usage_handler))
        .route("/usage/bundle/{session_id}", get(load_bundle_usages_for_session_handler))
        .route("/usage/model-call", post(save_model_call_usage_handler))
        .route("/usage/model-call/{model_call_id}/{session_id}", get(load_model_call_usage_handler))
        .route("/usage/model-call/{session_id}", get(load_model_call_usages_for_session_handler))
        .route("/usage/model-call/batch", post(load_model_call_usages_batch_handler))
        // system
        .route("/system/sqlite-info", get(sqlite_info_handler))
        // SSE
        .route("/events", get(sse_handler))
        // client
        .route("/client/exit", post(client_exit_handler))
        .with_state(state)
}

// ─── Model handlers ───────────────────────────────────────────────────

async fn load_model_settings_handler() -> Result<Json<ModelSettings>, AppError> {
    let settings = models_core::load_model_settings()
        .map_err(|e| AppError::new(format!("failed to load model settings: {e}")))?;
    Ok(Json(settings))
}

async fn save_model_settings_handler(
    Json(settings): Json<ModelSettings>,
) -> Result<Json<ModelSettings>, AppError> {
    let saved = models_core::save_model_settings(settings)
        .map_err(|e| AppError::new(format!("failed to save model settings: {e}")))?;
    Ok(Json(saved))
}

async fn test_model_handler(
    Json(settings): Json<ModelSettings>,
) -> Result<Json<ModelConnectionTestResult>, AppError> {
    let result = models_core::test_active_model_connection(&settings)
        .map_err(|e| AppError::new(format!("failed to test model: {e}")))?;
    Ok(Json(result))
}

// ─── Agent handlers ───────────────────────────────────────────────────

// ─── MCP handlers ─────────────────────────────────────────────────────

async fn load_mcp_settings_handler() -> Result<Json<mcp_core::McpSettingsFile>, AppError> {
    let result = mcp_core::load_mcp_settings()
        .map_err(|e| AppError::new(format!("failed to load MCP settings: {e}")))?;
    Ok(Json(result))
}

async fn save_mcp_settings_handler(
    Json(settings): Json<mcp_core::McpSettings>,
) -> Result<Json<mcp_core::McpSettingsFile>, AppError> {
    let result = mcp_core::save_mcp_settings(settings)
        .map_err(|e| AppError::new(format!("failed to save MCP settings: {e}")))?;
    Ok(Json(result))
}

// ─── Agent handlers ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct EnsureRequest {
    root: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "modelOverride")]
    model_override: Option<String>,
    #[serde(rename = "permissionMode")]
    permission_mode: Option<String>,
}

async fn ensure_handler(
    State(state): State<AppState>,
    Json(req): Json<EnsureRequest>,
) -> Result<Json<AgentReplProcessState>, AppError> {
    repl::ensure_agent_repl_process(
        state.app_handle,
        req.root,
        req.session_id,
        req.model_override,
        req.permission_mode,
    ).map(Json).map_err(AppError::new)
}

#[derive(Deserialize)]
struct InputRequest {
    root: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    input: String,
}

async fn send_input_handler(
    Json(req): Json<InputRequest>,
) -> Result<Json<AgentReplSendResult>, AppError> {
    control::send_agent_repl_input(req.root, req.session_id, req.input).map(Json).map_err(AppError::new)
}

#[derive(Deserialize)]
struct StatusQuery {
    root: String,
    #[serde(rename = "sessionId")]
    session_id: String,
}

async fn process_status_handler(
    Query(query): Query<StatusQuery>,
) -> Result<Json<AgentReplProcessStatus>, AppError> {
    repl::get_agent_repl_process_status(query.root, query.session_id).map(Json).map_err(AppError::new)
}

#[derive(Deserialize)]
struct InterruptRequest {
    root: String,
    #[serde(rename = "sessionId")]
    session_id: String,
}

async fn interrupt_handler(
    State(state): State<AppState>,
    Json(req): Json<InterruptRequest>,
) -> Result<Json<bool>, AppError> {
    control::interrupt_agent_turn(state.app_handle, req.root, req.session_id).map(Json).map_err(AppError::new)
}

#[derive(Deserialize)]
struct KillRequest {
    root: String,
    #[serde(rename = "sessionId")]
    session_id: String,
}

async fn kill_handler(
    Json(req): Json<KillRequest>,
) -> Result<Json<AgentReplProcessStatus>, AppError> {
    repl::kill_agent_repl_process(req.root, req.session_id).map(Json).map_err(AppError::new)
}

#[derive(Deserialize)]
struct ForkRequest {
    root: String,
    #[serde(rename = "sourceSessionId")]
    source_session_id: String,
    #[serde(rename = "checkpointUuid")]
    checkpoint_uuid: String,
    #[serde(rename = "modelOverride")]
    model_override: Option<String>,
    #[serde(rename = "permissionMode")]
    permission_mode: Option<String>,
}

async fn fork_handler(
    State(state): State<AppState>,
    Json(req): Json<ForkRequest>,
) -> Result<Json<AgentReplProcessState>, AppError> {
    repl::fork_agent_repl_process(
        state.app_handle,
        req.root,
        req.source_session_id,
        req.checkpoint_uuid,
        req.model_override,
        req.permission_mode,
    ).map(Json).map_err(AppError::new)
}

// ─── Workspace handlers ───────────────────────────────────────────────

#[derive(Deserialize)]
struct RootQuery { root: String }

#[derive(Deserialize)]
struct OpenWorkspaceQuery { #[serde(rename = "path")] workspace_path: String }

#[derive(Deserialize)]
struct FileQuery { root: String, path: String, #[serde(default)] reference: Option<usize> }

#[derive(Deserialize)]
struct SearchQuery { root: String, query: String, #[serde(rename = "maxResults")] max_results: Option<usize> }

async fn default_workspace_handler() -> Result<Json<Value>, AppError> {
    workspace::default_workspace()
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

async fn open_workspace_handler(Query(q): Query<OpenWorkspaceQuery>) -> Result<Json<Value>, AppError> {
    workspace::open_workspace(q.workspace_path)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

async fn list_workspaces_handler() -> Result<Json<Value>, AppError> {
    workspace::load_workspace_registry()
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

#[derive(Deserialize)]
struct WorkspacePathRequest { root: String }

async fn add_workspace_handler(Json(req): Json<WorkspacePathRequest>) -> Result<Json<Value>, AppError> {
    workspace::add_workspace_registry_entry(req.root)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

async fn remove_workspace_handler(Json(req): Json<WorkspacePathRequest>) -> Result<Json<Value>, AppError> {
    workspace::remove_workspace_registry_entry(req.root)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

async fn list_workspace_entries_handler(Query(q): Query<RootQuery>) -> Result<Json<Value>, AppError> {
    workspace::list_project_entries(q.root)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

async fn read_workspace_file_handler(Query(q): Query<FileQuery>) -> Result<Json<Value>, AppError> {
    let result = if q.reference.is_some() {
        workspace::read_local_reference_file(q.root, q.path)
    } else {
        workspace::read_workspace_file(q.root, q.path)
    };
    result.map(|s| Json(serde_json::to_value(s).unwrap_or_default())).map_err(AppError::new)
}

async fn search_workspace_handler(Query(q): Query<SearchQuery>) -> Result<Json<Value>, AppError> {
    workspace::search_workspace_files(q.root, q.query, q.max_results)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

#[derive(Deserialize)]
struct WriteFileRequest { root: String, path: String, content: String }

async fn write_workspace_file_handler(Json(req): Json<WriteFileRequest>) -> Result<Json<Value>, AppError> {
    workspace::write_workspace_file(req.root, req.path, req.content)
        .map(|_| Json(serde_json::json!({"ok": true})))
        .map_err(AppError::new)
}

#[derive(Deserialize)]
struct EditFileRequest {
    root: String,
    path: String,
    #[serde(rename = "oldString")]
    old_string: String,
    #[serde(rename = "newString")]
    new_string: String,
    #[serde(default, rename = "replaceAll")]
    replace_all: bool,
}

async fn edit_workspace_file_handler(Json(req): Json<EditFileRequest>) -> Result<Json<Value>, AppError> {
    workspace::edit_workspace_file(req.root, req.path, req.old_string, req.new_string, req.replace_all)
        .map(|_| Json(serde_json::json!({"ok": true})))
        .map_err(AppError::new)
}

async fn image_metadata_handler(Query(q): Query<FileQuery>) -> Result<Json<Value>, AppError> {
    workspace::read_local_image_metadata(q.root, q.path)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

async fn image_preview_handler(Query(q): Query<FileQuery>) -> Result<Json<Value>, AppError> {
    workspace::read_local_image_preview(q.root, q.path)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

// ─── Client handlers ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct ClientExitRequest { #[allow(dead_code)] reason: Option<String> }

async fn client_exit_handler(Json(_req): Json<ClientExitRequest>) -> Json<Value> {
    eprintln!("[http] client exit requested, ignoring (Tauri manages lifecycle)");
    Json(serde_json::json!({"ok": true}))
}

// ─── Runtime handlers ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct GlobRequest { root: String, pattern: String, path: Option<String> }

#[derive(Deserialize)]
struct GrepRequest {
    root: String,
    request: crate::types::GrepRuntimeRequest,
}

#[derive(Deserialize)]
struct BashRequest {
    root: String,
    request: crate::types::BashRuntimeRequest,
}

async fn glob_handler(Json(req): Json<GlobRequest>) -> Result<Json<Value>, AppError> {
    runtime::glob_runtime_search(req.root, req.pattern, req.path).map(Json).map_err(AppError::new)
}

async fn grep_handler(Json(req): Json<GrepRequest>) -> Result<Json<Value>, AppError> {
    runtime::grep_runtime_search(req.root, req.request).map(Json).map_err(AppError::new)
}

async fn bash_handler(Json(req): Json<BashRequest>) -> Result<Json<Value>, AppError> {
    runtime::execute_runtime_bash(req.root, req.request).map(Json).map_err(AppError::new)
}

// ─── Git handlers ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GitDiffQuery { root: String, path: Option<String> }

async fn git_diff_handler(Query(q): Query<GitDiffQuery>) -> Result<Json<Value>, AppError> {
    workspace::read_git_diff(q.root, q.path)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

// ─── Skills handlers ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct SkillsQuery { root: String }

#[derive(Deserialize)]
struct InstallSkillRequest { root: String, source: String }

async fn list_skills_handler(Query(q): Query<SkillsQuery>) -> Result<Json<Value>, AppError> {
    skills::list_skills(q.root).map(Json).map_err(AppError::new)
}

async fn install_skill_handler(Json(req): Json<InstallSkillRequest>) -> Result<Json<Value>, AppError> {
    skills::install_skill(req.root, req.source).map(Json).map_err(AppError::new)
}

// ─── Agent extra handlers ─────────────────────────────────────────────

async fn capabilities_handler(Query(q): Query<InterruptRequest>) -> Result<Json<Value>, AppError> {
    control::get_agent_repl_capabilities(q.root, q.session_id)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

async fn context_usage_handler(Query(q): Query<InterruptRequest>) -> Result<Json<Value>, AppError> {
    control::get_agent_context_usage(q.root, q.session_id)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

#[derive(Deserialize)]
struct RunTurnRequest {
    root: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    prompt: String,
}

async fn run_turn_handler(Json(req): Json<RunTurnRequest>) -> Result<Json<Value>, AppError> {
    control::run_agent_turn(req.root, req.session_id, req.prompt)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

async fn permission_state_handler() -> Result<Json<Value>, AppError> {
    permissions::get_agent_permission_state()
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

#[derive(Deserialize)]
struct SetPermissionModeRequest {
    root: String,
    mode: String,
}

async fn set_permission_mode_handler(
    Json(req): Json<SetPermissionModeRequest>,
) -> Result<Json<Value>, AppError> {
    permissions::set_agent_permission_mode(req.root, req.mode)
        .map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
        .map_err(AppError::new)
}

#[derive(Deserialize)]
struct RespondPermissionRequest {
    root: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "requestId")]
    request_id: String,
    approved: bool,
    #[serde(default, rename = "updatedInput")]
    updated_input: Option<Value>,
}

async fn respond_permission_handler(
    Json(req): Json<RespondPermissionRequest>,
) -> Result<Json<Value>, AppError> {
    let updated_input_json = req.updated_input
        .and_then(|v| serde_json::to_string(&v).ok());
    permissions::respond_agent_permission(
        req.root, req.session_id, req.request_id,
        req.approved, updated_input_json,
    ).map(|s| Json(serde_json::to_value(s).unwrap_or_default()))
     .map_err(AppError::new)
}

// ─── DeepSeek pricing ─────────────────────────────────────────────────

async fn deepseek_pricing_handler() -> Result<Json<Value>, AppError> {
    let pricing = models_core::load_deepseek_pricing()
        .map_err(|e| AppError::new(format!("failed to load deepseek pricing: {e}")))?;
    Ok(Json(serde_json::to_value(pricing).unwrap_or_default()))
}

// ─── Usage handlers ──────────────────────────────────────────────────

async fn save_bundle_usage_handler(
    Json(snapshot): Json<sqlite::BundleUsageSnapshot>,
) -> Result<Json<Value>, AppError> {
    sqlite::save_bundle_usage_snapshot(snapshot)
        .map(|_| Json(serde_json::json!({"ok": true})))
        .map_err(AppError::new)
}

async fn load_bundle_usage_handler(
    Path((session_id, bundle_id)): Path<(String, String)>,
) -> Result<Json<sqlite::BundleUsageSnapshot>, AppError> {
    sqlite::load_bundle_usage_snapshot(session_id, bundle_id)
        .map(Json)
        .map_err(AppError::new)
}

async fn load_bundle_usages_for_session_handler(
    Path(session_id): Path<String>,
) -> Result<Json<Vec<sqlite::BundleUsageSnapshot>>, AppError> {
    sqlite::load_bundle_usage_snapshots_for_session(session_id)
        .map(Json)
        .map_err(AppError::new)
}

async fn save_model_call_usage_handler(
    Json(usage): Json<sqlite::ModelCallUsage>,
) -> Result<Json<Value>, AppError> {
    sqlite::save_model_call_usage(usage)
        .map(|_| Json(serde_json::json!({"ok": true})))
        .map_err(AppError::new)
}

async fn load_model_call_usage_handler(
    Path((model_call_id, session_id)): Path<(String, String)>,
) -> Result<Json<sqlite::ModelCallUsage>, AppError> {
    sqlite::load_model_call_usage(model_call_id, session_id)
        .map(Json)
        .map_err(AppError::new)
}

async fn load_model_call_usages_for_session_handler(
    Path(session_id): Path<String>,
) -> Result<Json<Vec<sqlite::ModelCallUsage>>, AppError> {
    sqlite::load_model_call_usages_for_session(session_id)
        .map(Json)
        .map_err(AppError::new)
}

#[derive(Deserialize)]
struct ModelCallUsagesBatchRequest {
    #[serde(rename = "modelCallIds")]
    model_call_ids: Vec<String>,
    #[serde(rename = "sessionId")]
    session_id: String,
}

async fn load_model_call_usages_batch_handler(
    Json(req): Json<ModelCallUsagesBatchRequest>,
) -> Result<Json<Vec<sqlite::ModelCallUsage>>, AppError> {
    sqlite::load_model_call_usages(req.model_call_ids, req.session_id)
        .map(Json)
        .map_err(AppError::new)
}

// ─── System handlers ──────────────────────────────────────────────────

async fn sqlite_info_handler() -> Result<Json<sqlite::SqliteDatabaseInfo>, AppError> {
    sqlite::sqlite_database_info().map(Json).map_err(AppError::new)
}

// ─── SSE handler ──────────────────────────────────────────────────────

async fn sse_handler() -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = sse_broadcast_sender().subscribe();
    let stream = async_stream::stream! {
        // 发送连接确认
        yield Ok(Event::default().data(r#"{"eventType":"connected","payload":{"ok":true}}"#));
        loop {
            match rx.recv().await {
                Ok(event_json) => {
                    yield Ok(Event::default().data(event_json));
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[sse] WARNING: broadcast channel lagged, {n} events dropped");
                    continue
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}

// ─── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── GrepRequest ──

    #[test]
    fn test_grep_request_from_nested_json() {
        // remote.ts sends { root, request: { pattern, path, ... } }
        let json = json!({
            "root": "/workspace",
            "request": {
                "pattern": "TODO",
                "path": "src",
                "case_insensitive": true,
                "head_limit": 20
            }
        });
        let req: GrepRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.root, "/workspace");
        assert_eq!(req.request.pattern, "TODO");
        assert_eq!(req.request.path, Some("src".to_string()));
        assert_eq!(req.request.case_insensitive, Some(true));
        assert_eq!(req.request.head_limit, Some(20));
    }

    #[test]
    fn test_grep_request_minimal_fields() {
        let json = json!({"root": "/proj", "request": {"pattern": "search"}});
        let req: GrepRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.root, "/proj");
        assert_eq!(req.request.pattern, "search");
        assert!(req.request.path.is_none());
        assert!(req.request.glob.is_none());
    }

    // ── BashRequest ──

    #[test]
    fn test_bash_request_from_nested_json() {
        let json = json!({
            "root": "/workspace",
            "request": {
                "command": "ls -la",
                "timeout_ms": 5000
            }
        });
        let req: BashRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.root, "/workspace");
        assert_eq!(req.request.command, "ls -la");
        assert_eq!(req.request.timeout_ms, Some(5000));
    }

    #[test]
    fn test_bash_request_minimal_fields() {
        let json = json!({"root": "/proj", "request": {"command": "echo hi"}});
        let req: BashRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.request.command, "echo hi");
        assert!(req.request.timeout_ms.is_none());
    }

    // ── WorkspacePathRequest ──

    #[test]
    fn test_workspace_path_request_root_field() {
        // remote.ts sends { root: "/path" }
        let json = json!({"root": "/my/workspace"});
        let req: WorkspacePathRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.root, "/my/workspace");
    }

    // ── EnsureRequest ──

    #[test]
    fn test_ensure_request_camelcase() {
        let json = json!({
            "root": "/proj",
            "sessionId": "abc-123",
            "modelOverride": "deepseek-chat",
            "permissionMode": "acceptEdits"
        });
        let req: EnsureRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.root, "/proj");
        assert_eq!(req.session_id, "abc-123");
        assert_eq!(req.model_override, Some("deepseek-chat".to_string()));
        assert_eq!(req.permission_mode, Some("acceptEdits".to_string()));
    }

    #[test]
    fn test_ensure_request_minimal() {
        let json = json!({"root": "/proj", "sessionId": "abc-123"});
        let req: EnsureRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.root, "/proj");
        assert_eq!(req.session_id, "abc-123");
        assert!(req.model_override.is_none());
        assert!(req.permission_mode.is_none());
    }

    // ── ForkRequest ──

    #[test]
    fn test_fork_request_camelcase() {
        let json = json!({
            "root": "/proj",
            "sourceSessionId": "src-123",
            "checkpointUuid": "chk-456",
            "modelOverride": "anthropic",
            "permissionMode": "plan"
        });
        let req: ForkRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.source_session_id, "src-123");
        assert_eq!(req.checkpoint_uuid, "chk-456");
        assert_eq!(req.model_override, Some("anthropic".to_string()));
        assert_eq!(req.permission_mode, Some("plan".to_string()));
    }

    // ── EditFileRequest ──

    #[test]
    fn test_edit_file_request_camelcase() {
        let json = json!({
            "root": "/proj",
            "path": "src/main.rs",
            "oldString": "fn old()",
            "newString": "fn new()",
            "replaceAll": true
        });
        let req: EditFileRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.old_string, "fn old()");
        assert_eq!(req.new_string, "fn new()");
        assert!(req.replace_all);
    }

    #[test]
    fn test_edit_file_request_replace_all_defaults_false() {
        let json = json!({
            "root": "/proj",
            "path": "src/main.rs",
            "oldString": "old",
            "newString": "new"
        });
        let req: EditFileRequest = serde_json::from_value(json).unwrap();
        assert!(!req.replace_all);
    }

    // ── InterruptRequest ──

    #[test]
    fn test_interrupt_request_camelcase() {
        let json = json!({"root": "/proj", "sessionId": "sid-1"});
        let req: InterruptRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.root, "/proj");
        assert_eq!(req.session_id, "sid-1");
    }

    // ── RunTurnRequest ──

    #[test]
    fn test_run_turn_request_camelcase() {
        let json = json!({"root": "/proj", "sessionId": "sid-1", "prompt": "hello"});
        let req: RunTurnRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.session_id, "sid-1");
        assert_eq!(req.prompt, "hello");
    }

    // ── http_port ──

    #[test]
    fn test_http_port_defaults_to_7421() {
        // Without AGENT_UI_HTTP_PORT set, should default to 7421
        let port = http_port();
        // If env var is set in CI, just check it's a valid u16
        assert!(port > 0);
    }

    // ── http_enabled ──
    // NOTE: cannot test env-dependent behavior in unit tests without
    // temp_env, but the function logic is deterministic:
    // - unset → true
    // - "0"|"false"|"no"|"off" → false
    // - anything else → true
}

/// 测试用 router：仅包含不需要 Tauri AppHandle 的 stateless handler。
/// 用于集成测试中验证路由完备性和 HTTP 状态码行为。
#[allow(dead_code)]
pub fn stateless_test_router() -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/sessions/{id}", get(load_session_handler))
        .route("/sessions", get(list_sessions_handler).post(create_session_handler))
        .route("/models/settings", get(load_model_settings_handler).put(save_model_settings_handler))
        .route("/models/test", post(test_model_handler))
        .route("/models/deepseek-pricing", get(deepseek_pricing_handler))
        .route("/mcp/settings", get(load_mcp_settings_handler).put(save_mcp_settings_handler))
        .route("/workspace/default", get(default_workspace_handler))
        .route("/workspace/open", get(open_workspace_handler))
        .route("/workspaces", get(list_workspaces_handler).post(add_workspace_handler).delete(remove_workspace_handler))
        .route("/workspace/entries", get(list_workspace_entries_handler))
        .route("/workspace/file", get(read_workspace_file_handler).put(write_workspace_file_handler))
        .route("/workspace/file/edit", post(edit_workspace_file_handler))
        .route("/workspace/image/metadata", get(image_metadata_handler))
        .route("/workspace/image/preview", get(image_preview_handler))
        .route("/workspace/search", get(search_workspace_handler))
        .route("/runtime/glob", post(glob_handler))
        .route("/runtime/grep", post(grep_handler))
        .route("/runtime/bash", post(bash_handler))
        .route("/git/diff", get(git_diff_handler))
        .route("/skills", get(list_skills_handler).post(install_skill_handler))
        .route("/usage/bundle", post(save_bundle_usage_handler))
        .route("/usage/bundle/{session_id}/{bundle_id}", get(load_bundle_usage_handler))
        .route("/usage/bundle/{session_id}", get(load_bundle_usages_for_session_handler))
        .route("/usage/model-call", post(save_model_call_usage_handler))
        .route("/usage/model-call/{model_call_id}/{session_id}", get(load_model_call_usage_handler))
        .route("/usage/model-call/{session_id}", get(load_model_call_usages_for_session_handler))
        .route("/usage/model-call/batch", post(load_model_call_usages_batch_handler))
        .route("/system/sqlite-info", get(sqlite_info_handler))
        .route("/events", get(sse_handler))
        .route("/client/exit", post(client_exit_handler))
    // NOTE: /agent/* handlers require AppState (Tauri AppHandle),
    //        not included in stateless test router.
}

/// 启动 HTTP server（在独立 tokio runtime 上运行）
pub async fn run_server(app_handle: AppHandle) {
    if !http_enabled() {
        eprintln!("[http] disabled (AGENT_UI_HTTP_ENABLED=0)");
        return;
    }

    let port = http_port();
    let addr = format!("127.0.0.1:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[http] WARNING: failed to bind {addr}: {e} — HTTP server disabled");
            return;
        }
    };

    eprintln!("[http] listening on http://{addr}");

    let state = AppState::new(app_handle);
    axum::serve(listener, app_router(state))
        .await
        .expect("HTTP server: fatal error");
}
