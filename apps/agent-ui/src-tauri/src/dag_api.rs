// ─── DAG / Component / Execution HTTP API ─────────────────────────────
//
// dag mode 是纯 HTTP 远程模式。
// 本模块把 main.rs 中通过 Tauri IPC 暴露的 dag/component/component-session/
// execution 命令，逐一对映成 axum HTTP 路由，逻辑全部复用现有 handler
// （components.rs / component_session.rs / dag.rs / scheduler.rs），只包一层
// JSON 收发包。这些 handler 是纯函数（内部 open_sqlite_database()、无 State
// 依赖），所以本路由不需要携带 AppState。
//
// 约定：所有路径以 /api/ 前缀，避免与 code/agent 既有路由冲突。
// 错误：handler 返回 Result<T, String>，统一经 AppError 转 500 + {"error":..}。

use axum::{
    Json, Router,
    extract::{Path, Query},
    routing::{delete, get, post, put},
};
use serde::Deserialize;

use crate::server::{AppError, AppState};

use crate::component_session;
use crate::components;
use crate::dag;
use crate::scheduler;
use crate::types::{Component, ComponentSession, Dag, DagEdge, DagNode, DagExecution, ExecutionLog, NodeExecution};

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

async fn get_node_executions_handler(
    Path(execution_id): Path<String>,
) -> Result<Json<Vec<NodeExecution>>, AppError> {
    scheduler::get_node_executions(execution_id).map(Json).map_err(AppError::new)
}

async fn cancel_execution_handler(Path(execution_id): Path<String>) -> Result<Json<()>, AppError> {
    scheduler::cancel_execution(execution_id).map(Json).map_err(AppError::new)
}

// 节点输出预览：CSV/JSON 前 N 行；parquet 等不支持格式返回 unsupported 提示。
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

// ─── Router ──────────────────────────────────────────────────────────

/// 把 dag/component/component-session/execution 的 HTTP 路由挂到传入的
/// `Router<AppState>` 上。以 `Router<AppState>` 入参/出参，避免与主路由的
/// state 类型（`AppState`）不匹配导致 `merge` 失败；dag handler 本身不提取
/// State，挂上去后路由的 state 类型保持不变。
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
        .route("/api/executions/:execution_id/nodes", get(get_node_executions_handler))
        .route("/api/executions/:execution_id/cancel", post(cancel_execution_handler))
        .route(
            "/api/executions/:execution_id/nodes/:node_id/outputs/:output_name/preview",
            get(preview_node_output_handler),
        )
}
