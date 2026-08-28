// ─── DAG / Component / Execution HTTP API ─────────────────────────────
//
// dag mode is a pure HTTP remote mode.
// This module maps the dag/component/component-session/execution commands
// exposed via Tauri IPC in main.rs one-to-one onto axum HTTP routes, reusing
// the existing handlers (components.rs / component_session.rs / dag.rs /
// scheduler.rs) and only wrapping them with a JSON request/response layer.
// These handlers are pure functions (internally call open_sqlite_database(),
// with no State dependency), so this router does not need to carry AppState.
//
// Convention: all paths use the /api/ prefix to avoid colliding with the
// existing code/agent routes.
// Errors: handlers return Result<T, String>, uniformly converted by AppError
// to 500 + {"error":..}.

use axum::{
    Json, Router,
    extract::{Path, Query},
    http::{HeaderName, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post, put},
};
use serde::Deserialize;

use crate::server::{AppError, AppState};

use crate::component_session;
use crate::components;
use crate::dag;
use crate::scheduler;
use crate::types::{Component, ComponentSession, Dag, DagEdge, DagNode, DagExecution, ExecutionLog, NodeExecution, NodeLogFile};

// ─── Request bodies ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateComponentSessionRequest {
    #[serde(rename = "componentId")]
    component_id: String,
    title: Option<String>,
}

#[derive(Deserialize)]
struct CreateDagRequest {
    name: String,
}

#[derive(Deserialize)]
struct UpdateDagRequest {
    dag: Dag,
    nodes: Vec<DagNode>,
    edges: Vec<DagEdge>,
}

#[derive(Deserialize)]
struct PublishRequest {
    cron: Option<String>,
}

#[derive(Deserialize)]
struct SessionTitleRequest {
    title: String,
}

// ─── Component handlers ──────────────────────────────────────────────

async fn list_components_handler() -> Result<Json<Vec<Component>>, AppError> {
    components::list_components().map(Json).map_err(AppError::new)
}

async fn get_component_handler(Path(component_id): Path<String>) -> Result<Json<Component>, AppError> {
    components::get_component(component_id).map(Json).map_err(AppError::new)
}

async fn create_component_handler(Json(component): Json<Component>) -> Result<Json<Component>, AppError> {
    components::create_component(component).map(Json).map_err(AppError::new)
}

async fn update_component_handler(Json(component): Json<Component>) -> Result<Json<Component>, AppError> {
    components::update_component(component).map(Json).map_err(AppError::new)
}

async fn delete_component_handler(Path(component_id): Path<String>) -> Result<Json<()>, AppError> {
    components::delete_component(component_id).map(Json).map_err(AppError::new)
}

async fn list_component_files_handler(Path(component_id): Path<String>) -> Result<Json<Vec<String>>, AppError> {
    components::list_component_files(component_id).map(Json).map_err(AppError::new)
}

async fn verify_component_handler(Path(component_id): Path<String>) -> Result<Json<Vec<String>>, AppError> {
    components::verify_component(component_id).map(Json).map_err(AppError::new)
}

// ─── Component session handlers ──────────────────────────────────────

async fn create_component_session_handler(
    Json(req): Json<CreateComponentSessionRequest>,
) -> Result<Json<ComponentSession>, AppError> {
    component_session::create_component_session(req.component_id, req.title)
        .map(Json)
        .map_err(AppError::new)
}

async fn list_component_sessions_handler(
    Path(component_id): Path<String>,
) -> Result<Json<Vec<ComponentSession>>, AppError> {
    component_session::list_component_sessions(component_id)
        .map(Json)
        .map_err(AppError::new)
}

async fn update_component_session_title_handler(
    Path(session_id): Path<String>,
    Json(req): Json<SessionTitleRequest>,
) -> Result<Json<ComponentSession>, AppError> {
    component_session::update_component_session_title(session_id, req.title)
        .map(Json)
        .map_err(AppError::new)
}

async fn delete_component_session_handler(
    Path(session_id): Path<String>,
) -> Result<Json<()>, AppError> {
    component_session::delete_component_session(session_id)
        .map(Json)
        .map_err(AppError::new)
}

// ─── Dag handlers ────────────────────────────────────────────────────

async fn list_dags_handler() -> Result<Json<Vec<Dag>>, AppError> {
    dag::list_dags().map(Json).map_err(AppError::new)
}

async fn get_dag_handler(Path(dag_id): Path<String>) -> Result<Json<crate::types::DagDetail>, AppError> {
    dag::get_dag(dag_id).map(Json).map_err(AppError::new)
}

async fn create_dag_handler(Json(req): Json<CreateDagRequest>) -> Result<Json<Dag>, AppError> {
    dag::create_dag(req.name).map(Json).map_err(AppError::new)
}

async fn update_dag_handler(
    Json(req): Json<UpdateDagRequest>,
) -> Result<Json<()>, AppError> {
    dag::update_dag(req.dag, req.nodes, req.edges)
        .map(Json)
        .map_err(AppError::new)
}

async fn delete_dag_handler(Path(dag_id): Path<String>) -> Result<Json<()>, AppError> {
    dag::delete_dag(dag_id).map(Json).map_err(AppError::new)
}

async fn delete_dag_node_handler(
    Path((dag_id, node_id)): Path<(String, String)>,
) -> Result<Json<()>, AppError> {
    dag::delete_dag_node(dag_id, node_id).map(Json).map_err(AppError::new)
}

async fn publish_dag_handler(
    Path(dag_id): Path<String>,
    Json(req): Json<PublishRequest>,
) -> Result<Json<Dag>, AppError> {
    dag::publish_dag(dag_id, req.cron).map(Json).map_err(AppError::new)
}

async fn unpublish_dag_handler(Path(dag_id): Path<String>) -> Result<Json<Dag>, AppError> {
    dag::unpublish_dag(dag_id).map(Json).map_err(AppError::new)
}

// ─── Execution handlers ──────────────────────────────────────────────

async fn run_dag_handler(Path(dag_id): Path<String>) -> Result<Json<DagExecution>, AppError> {
    scheduler::run_dag(dag_id).map(Json).map_err(AppError::new)
}

async fn get_execution_handler(Path(execution_id): Path<String>) -> Result<Json<DagExecution>, AppError> {
    scheduler::get_execution(execution_id).map(Json).map_err(AppError::new)
}

async fn list_executions_handler(Path(dag_id): Path<String>) -> Result<Json<Vec<DagExecution>>, AppError> {
    scheduler::list_executions(dag_id).map(Json).map_err(AppError::new)
}

async fn get_execution_logs_handler(
    Path(execution_id): Path<String>,
) -> Result<Json<Vec<ExecutionLog>>, AppError> {
    scheduler::get_execution_logs(execution_id).map(Json).map_err(AppError::new)
}

// Per-node on-disk log, paginated. The file holds the node's full (untruncated)
// stdout/stderr; the client pages via `offset`/`limit` (default 2000 lines).
#[derive(Deserialize)]
struct LogQuery {
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_log_limit")]
    limit: usize,
}
fn default_log_limit() -> usize {
    2000
}

async fn get_node_log_handler(
    Path((execution_id, node_id)): Path<(String, String)>,
    Query(query): Query<LogQuery>,
) -> Result<Json<NodeLogFile>, AppError> {
    scheduler::get_node_log(execution_id, node_id, query.offset, query.limit)
        .map(Json)
        .map_err(AppError::new)
}

async fn get_node_executions_handler(
    Path(execution_id): Path<String>,
) -> Result<Json<Vec<NodeExecution>>, AppError> {
    scheduler::get_node_executions(execution_id).map(Json).map_err(AppError::new)
}

async fn cancel_execution_handler(Path(execution_id): Path<String>) -> Result<Json<()>, AppError> {
    scheduler::cancel_execution(execution_id).map(Json).map_err(AppError::new)
}

// Node-output preview: first N rows of CSV/JSON; unsupported formats such as
// parquet return an "unsupported" hint.
#[derive(Deserialize)]
struct PreviewQuery {
    #[serde(default = "default_preview_limit")]
    limit: usize,
}
fn default_preview_limit() -> usize {
    100
}

async fn preview_node_output_handler(
    Path((execution_id, node_id, output_name)): Path<(String, String, String)>,
    Query(query): Query<PreviewQuery>,
) -> Result<Json<scheduler::OutputPreview>, AppError> {
    scheduler::preview_node_output(execution_id, node_id, output_name, query.limit)
        .map(Json)
        .map_err(AppError::new)
}

/// Download the raw output file produced by a node execution as an
/// attachment. The file lives on the DAG server's disk; we stream it back
/// as bytes with a `Content-Disposition: attachment` header so the browser
/// / webview saves it instead of trying to display it.
async fn download_node_output_handler(
    Path((execution_id, node_id, output_name)): Path<(String, String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let path = scheduler::get_output_file_path(&execution_id, &node_id, &output_name)?;
    let filename = std::path::Path::new(&path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("output");
    let bytes = std::fs::read(&path)
        .map_err(|e| AppError::new(format!("读文件失败 {}: {}", path, e)))?;
    let cd = format!("attachment; filename=\"{}\"", filename);
    let header_val = HeaderValue::from_str(&cd)
        .map_err(|e| AppError::new(format!("构造 Content-Disposition 失败: {}", e)))?;
    Ok((
        StatusCode::OK,
        [(HeaderName::from_static("content-disposition"), header_val)],
        bytes,
    ))
}

// ─── Router ──────────────────────────────────────────────────────────

/// Mount the dag/component/component-session/execution HTTP routes onto the
/// given `Router<AppState>`. Taking and returning `Router<AppState>` avoids a
/// state-type mismatch (`AppState`) with the main router that would make
/// `merge` fail; the dag handlers do not extract State, so the router's state
/// type stays unchanged after mounting.
pub fn register_dag_routes(router: Router<AppState>) -> Router<AppState> {
    router
        // components
        .route("/api/components", get(list_components_handler).post(create_component_handler))
        .route("/api/components/:component_id", get(get_component_handler).put(update_component_handler).delete(delete_component_handler))
        .route("/api/components/:component_id/files", get(list_component_files_handler))
        .route("/api/components/:component_id/verify", get(verify_component_handler))
        // component sessions
        .route("/api/component-sessions", post(create_component_session_handler))
        .route("/api/components/:component_id/sessions", get(list_component_sessions_handler))
        .route("/api/component-sessions/:session_id/title", put(update_component_session_title_handler))
        .route("/api/component-sessions/:session_id", delete(delete_component_session_handler))
        // dags
        .route("/api/dags", get(list_dags_handler).post(create_dag_handler))
        .route("/api/dags/:dag_id", get(get_dag_handler).put(update_dag_handler).delete(delete_dag_handler))
        .route("/api/dags/:dag_id/nodes/:node_id", delete(delete_dag_node_handler))
        .route("/api/dags/:dag_id/publish", post(publish_dag_handler))
        .route("/api/dags/:dag_id/unpublish", post(unpublish_dag_handler))
        // executions
        .route("/api/dags/:dag_id/run", post(run_dag_handler))
        .route("/api/dags/:dag_id/executions", get(list_executions_handler))
        .route("/api/executions/:execution_id", get(get_execution_handler))
        .route("/api/executions/:execution_id/logs", get(get_execution_logs_handler))
        .route(
            "/api/executions/:execution_id/nodes/:node_id/log",
            get(get_node_log_handler),
        )
        .route("/api/executions/:execution_id/nodes", get(get_node_executions_handler))
        .route("/api/executions/:execution_id/cancel", post(cancel_execution_handler))
        .route(
            "/api/executions/:execution_id/nodes/:node_id/outputs/:output_name/preview",
            get(preview_node_output_handler),
        )
        .route(
            "/api/executions/:execution_id/nodes/:node_id/outputs/:output_name/download",
            get(download_node_output_handler),
        )
}
