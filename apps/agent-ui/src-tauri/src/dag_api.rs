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
    body::Body,
    extract::{Path, Query},
    http::{header, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path as FsPath;

use crate::server::{AppError, AppState};

use crate::component_session;
use crate::components;
use crate::dag;
use crate::scheduler;
use crate::types::{Component, ComponentSession, Dag, DagEdge, DagNode, DagExecution, ExecutionLog, NodeExecution, NodeLogFile};
use crate::zip_store::{self, ZipMember};

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

// 提供配置验证的组件 name 列表（前端据此决定是否显示「验证配置」按钮）。
async fn validate_capabilities_handler() -> Json<Vec<&'static str>> {
    Json(crate::platform_components::registry().keys().copied().collect())
}

// 节点表单「验证配置」按钮的落点：body 是该节点的运行参数。
async fn validate_component_handler(
    Path(component_id): Path<String>,
    Json(params): Json<serde_json::Value>,
) -> Result<Json<crate::platform_components::ValidateResult>, AppError> {
    let component = components::get_component(component_id).map_err(AppError::new)?;
    let Some(handler) = crate::platform_components::registry().get(component.name.as_str()) else {
        return Err(AppError::not_found(format!(
            "组件「{}」未提供配置验证。",
            component.name
        )));
    };
    Ok(Json(handler(params).await))
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

/// Submit a resume run for a single node. The node's ancestors are seeded
/// with their most recent successful outputs from the last successful full-run
/// of the same DAG. The resulting execution runs only the target node.
async fn run_single_node_handler(
    Path((dag_id, node_id)): Path<(String, String)>,
) -> Result<Json<DagExecution>, AppError> {
    scheduler::submit_resume_run(dag_id, node_id)
        .map(Json)
        .map_err(AppError::new)
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

// Node-output preview: first N rows of CSV/JSON/parquet. `index` selects which
// artifact to preview when the port value is a list (default 0 = the first).
#[derive(Deserialize)]
struct PreviewQuery {
    #[serde(default = "default_preview_limit")]
    limit: usize,
    #[serde(default)]
    index: usize,
}
fn default_preview_limit() -> usize {
    100
}

async fn preview_node_output_handler(
    Path((execution_id, node_id, output_name)): Path<(String, String, String)>,
    Query(query): Query<PreviewQuery>,
) -> Result<Json<scheduler::OutputPreview>, AppError> {
    scheduler::preview_node_output(
        execution_id,
        node_id,
        output_name,
        query.limit,
        query.index,
    )
    .map(Json)
    .map_err(AppError::new)
}

/// `index` selects which artifact to download when the port value is a list
/// (default 0). Single-valued ports are unaffected.
#[derive(Deserialize)]
struct DownloadQuery {
    #[serde(default)]
    index: usize,
}

/// Download one artifact produced by a node execution as an attachment. The
/// artifact lives on the DAG server's disk; we read it back with a
/// `Content-Disposition: attachment` header so the browser / webview saves it
/// instead of trying to display it.
async fn download_node_output_handler(
    Path((execution_id, node_id, output_name)): Path<(String, String, String)>,
    Query(query): Query<DownloadQuery>,
) -> Result<impl IntoResponse, AppError> {
    let (path, _format) =
        scheduler::resolve_output_file_path(&execution_id, &node_id, &output_name, query.index)?;
    let filename = FsPath::new(&path)
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

/// Pack EVERY artifact of an output port into one streamed zip archive.
///
/// The archive is produced as a byte stream (see `zip_store`), so a table with
/// many partitions downloads without buffering the whole archive in memory.
/// Artifact paths may be files or directories; directories keep their internal
/// shape inside the archive (`month=202401/data.parquet`).
async fn download_node_outputs_all_handler(
    Path((execution_id, node_id, output_name)): Path<(String, String, String)>,
) -> Result<Response, AppError> {
    let artifacts =
        scheduler::output_artifacts(&execution_id, &node_id, &output_name).map_err(AppError::new)?;

    let mut members: Vec<ZipMember> = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    for (i, artifact) in artifacts.iter().enumerate() {
        let base = FsPath::new(&artifact.path)
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("artifact_{i}"));
        let prefix = unique_archive_name(&base, &mut used);
        let mut found = zip_store::collect_members(FsPath::new(&artifact.path), &prefix)
            .map_err(AppError::new)?;
        members.append(&mut found);
    }

    let filename = format!("{output_name}.zip");
    let cd = format!("attachment; filename=\"{filename}\"");
    let cd_val = HeaderValue::from_str(&cd)
        .map_err(|e| AppError::new(format!("构造 Content-Disposition 失败: {}", e)))?;

    let mut response = Response::new(Body::from_stream(zip_store::zip_stream(members)));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    response
        .headers_mut()
        .insert(header::CONTENT_DISPOSITION, cd_val);
    Ok(response)
}

/// Keep archive member names unique: two partitions both named `data.parquet`
/// must not collide inside one archive. First use keeps the plain name;
/// later duplicates get `_2`, `_3`, … before the extension.
fn unique_archive_name(base: &str, used: &mut HashSet<String>) -> String {
    if used.insert(base.to_string()) {
        return base.to_string();
    }
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (base.to_string(), String::new()),
    };
    let mut n = 2;
    loop {
        let candidate = format!("{stem}_{n}{ext}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        n += 1;
    }
}

// ─── Router ──────────────────────────────────────────────────────────

/// Mount the dag/component/component-session/execution HTTP routes onto the
/// given `Router<AppState>`. Taking and returning `Router<AppState>` avoids a
/// state-type mismatch (`AppState`) with the main router that would make
/// `merge` fail; the dag handlers do not extract State, so the router's state
/// type stays unchanged after mounting. Generic over `S` so the stateless test
/// router mounts the SAME route list (no test/production drift).
pub fn register_dag_routes<S: Clone + Send + Sync + 'static>(router: Router<S>) -> Router<S> {
    router
        // components
        .route("/api/components", get(list_components_handler).post(create_component_handler))
        .route("/api/components/:component_id", get(get_component_handler).put(update_component_handler).delete(delete_component_handler))
        .route("/api/components/:component_id/files", get(list_component_files_handler))
        .route("/api/components/:component_id/verify", get(verify_component_handler))
        // platform component validate（Rust 侧 platform_components/ 提供）
        .route("/api/components/validate-capabilities", get(validate_capabilities_handler))
        .route("/api/components/:component_id/validate", post(validate_component_handler))
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
        .route(
            "/api/dags/:dag_id/nodes/:node_id/resume",
            post(run_single_node_handler),
        )
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
        .route(
            "/api/executions/:execution_id/nodes/:node_id/outputs/:output_name/download-all",
            get(download_node_outputs_all_handler),
        )
}
