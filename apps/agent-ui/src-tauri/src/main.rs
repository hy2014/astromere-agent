use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

mod sqlite;
use sqlite::{
    sqlite_database_info, sqlite_execute, sqlite_query,
    save_bundle_usage_snapshot,
    load_bundle_usage_snapshot,
    load_bundle_usage_snapshots_for_session,
};

#[derive(Debug, Serialize)]
struct WorkspaceState {
    root: String,
    name: String
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRegistryEntry {
    root: String,
    name: String
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRegistry {
    workspaces: Vec<WorkspaceRegistryEntry>
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct ProjectEntry {
    name: String,
    path: String,
    kind: ProjectEntryKind
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProjectEntryKind {
    File,
    Directory
}

#[derive(Debug, Serialize)]
struct FileView {
    path: String,
    content: String,
    total_lines: usize,
    size_bytes: u64,
    language: String
}

#[derive(Debug, Serialize)]
struct WorkspaceFileReference {
    path: String,
    name: String,
    directory: String,
    extension: Option<String>,
    size_bytes: Option<u64>,
    modified_epoch_millis: Option<u128>,
    score: i64
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalImagePreview {
    path: String,
    mime_type: String,
    data_url: String,
    size_bytes: u64
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalImageMetadata {
    path: String,
    mime_type: String,
    size_bytes: u64
}

#[derive(Debug, Serialize)]
struct GitDiff {
    path: Option<String>,
    diff: String,
    is_empty: bool
}

#[derive(Debug, Serialize)]
struct AgentTurnResponse {
    ok: bool,
    message: String,
    requires_confirmation: bool,
    permission_prompt: Option<String>,
    model: Option<String>,
    iterations: Option<u64>,
    tool_uses: Vec<serde_json::Value>,
    tool_results: Vec<serde_json::Value>,
    usage: Option<serde_json::Value>,
    estimated_cost: Option<String>,
    raw_json: Option<serde_json::Value>,
    stderr: Option<String>
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ModelProvider {
    DeepSeek,
    OpenAI,
    Anthropic
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelEndpointConfig {
    id: String,
    name: String,
    provider: ModelProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    support_models: Vec<String>,
    api_key: String,
    base_url: String,
    organization_id: Option<String>,
    max_tokens: u32,
    temperature: f32,
    enabled: bool
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeepSeekPricingItem {
    item: String,
    price_per_m_tokens: f64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeepSeekPricingModel {
    model: String,
    items: Vec<DeepSeekPricingItem>
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeepSeekPricingConfig {
    source: String,
    fetched_at: String,
    url: String,
    currency: String,
    unit: String,
    models: Vec<DeepSeekPricingModel>
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelSettings {
    active_model_id: String,
    models: Vec<ModelEndpointConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deepseek_pricing: Option<DeepSeekPricingConfig>
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConnectionTestResult {
    ok: bool,
    message: String,
    model: String,
    stderr: Option<String>
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPermissionState {
    current_mode: String,
    available_modes: Vec<String>
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentReplProcessState {
    session_id: String,
    root: String,
    model: String,
    permission_mode: String
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentReplSendResult {
    accepted: bool
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentReplProcessStatus {
    session_id: String,
    root: String,
    running: bool,
    pid: Option<u32>
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentReplCapabilityItem {
    name: String,
    slash: String,
    kind: String,
    description: Option<String>
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentReplCapabilities {
    root: String,
    session_id: String,
    commands: Vec<AgentReplCapabilityItem>,
    skills: Vec<AgentReplCapabilityItem>,
    slash_commands: Vec<AgentReplCapabilityItem>,
    updated_at_ms: u64
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentContextUsage {
    root: String,
    session_id: String,
    data: Value,
    updated_at_ms: u64
}

#[derive(Debug, Deserialize)]
struct GrepRuntimeRequest {
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    output_mode: Option<String>,
    case_insensitive: Option<bool>,
    head_limit: Option<usize>
}

#[derive(Debug, Deserialize)]
struct BashRuntimeRequest {
    command: String,
    timeout_ms: Option<u64>
}

#[derive(Debug, Serialize)]
struct RuntimeSessionSummary {
    id: String,
    title: String,
    path: String,
    updated_at_ms: u64,
    modified_epoch_millis: u128,
    message_count: usize,
    parent_session_id: Option<String>,
    branch_name: Option<String>
}

struct ClawProcess {
    root: String,
    session_id: String,
    pid: u32,
    stdin: ChildStdin,
    child: Child
}

struct ControlResponseRegistry {
    responses: Mutex<HashMap<String, Value>>,
    condvar: Condvar
}

struct ForkSessionRegistry {
    sessions: Mutex<HashMap<String, String>>,
}

struct SessionReadyRegistry {
    sessions: Mutex<HashMap<String, bool>>,
    condvar: Condvar
}

static SESSION_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

static CLAW_PROCESSES: OnceLock<Mutex<HashMap<String, ClawProcess>>> = OnceLock::new();
static CONTROL_RESPONSES: OnceLock<ControlResponseRegistry> = OnceLock::new();
static FORK_SESSIONS: OnceLock<ForkSessionRegistry> = OnceLock::new();
static SESSION_READY: OnceLock<SessionReadyRegistry> = OnceLock::new();


fn truncate_for_log(text: &str, max_len: usize) -> String {
    if text.chars().count() <= max_len {
        return text.to_string();
    }

    let truncated: String = text.chars().take(max_len).collect();
    format!("{}…<truncated>", truncated)
}

fn value_summary_for_log(value: &Value) -> String {
    let event_type = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("<missing>");
    let request_id = control_response_request_id(value)
        .or_else(|| value.get("request_id").and_then(|v| v.as_str()).map(|v| v.to_string()))
        .unwrap_or_else(|| "<none>".to_string());
    let session_id = stream_value_session_id(value).unwrap_or_else(|| "<none>".to_string());
    let subtype = value
        .get("request")
        .and_then(|request| request.get("subtype"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("subtype"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("<none>");
    let raw = serde_json::to_string(value).unwrap_or_else(|_| "<unserializable json>".to_string());

    format!(
        "type={} request_id={} session_id={} subtype={} raw={}",
        event_type,
        request_id,
        session_id,
        subtype,
        truncate_for_log(&raw, 1600)
    )
}

fn fork_debug(message: impl AsRef<str>) {
    eprintln!("[agent-ui][fork] {}", message.as_ref());
}

fn generate_agent_ui_session_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let counter = SESSION_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id() as u64;

    let high = (nanos as u64) ^ counter.rotate_left(17) ^ (pid << 32);
    let low = ((nanos >> 64) as u64) ^ counter.rotate_left(31) ^ 0xa5a5_5a5a_d3c3_b4b4u64;

    let part1 = (high >> 32) as u32;
    let part2 = ((high >> 16) & 0xffff) as u16;
    let part3 = (0x4000 | (high & 0x0fff)) as u16;
    let part4 = (0x8000 | ((low >> 48) & 0x3fff)) as u16;
    let part5 = low & 0x0000_ffff_ffff_ffff;

    format!(
        "{part1:08x}-{part2:04x}-{part3:04x}-{part4:04x}-{part5:012x}"
    )
}

fn claw_processes() -> &'static Mutex<HashMap<String, ClawProcess>> {
    CLAW_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn control_responses() -> &'static ControlResponseRegistry {
    CONTROL_RESPONSES.get_or_init(|| ControlResponseRegistry {
        responses: Mutex::new(HashMap::new()),
        condvar: Condvar::new()
})
}

fn fork_sessions() -> &'static ForkSessionRegistry {
    FORK_SESSIONS.get_or_init(|| ForkSessionRegistry {
        sessions: Mutex::new(HashMap::new())
})
}

fn session_ready_registry() -> &'static SessionReadyRegistry {
    SESSION_READY.get_or_init(|| SessionReadyRegistry {
        sessions: Mutex::new(HashMap::new()),
        condvar: Condvar::new()
})
}

fn session_ready_key(root: &str, session_id: &str) -> String {
    format!("{}::{}", root, session_id)
}

fn clear_session_ready(root: &str, session_id: &str) {
    let registry = session_ready_registry();
    if let Ok(mut sessions) = registry.sessions.lock() {
        sessions.remove(&session_ready_key(root, session_id));
    }
}

fn mark_session_ready(root: &str, session_id: &str) {
    if session_id.trim().is_empty() {
        return;
    }

    let registry = session_ready_registry();
    if let Ok(mut sessions) = registry.sessions.lock() {
        sessions.insert(session_ready_key(root, session_id), true);
        registry.condvar.notify_all();
    }
}

fn wait_for_session_ready(root: &str, session_id: &str, timeout: Duration) -> Result<(), String> {
    let registry = session_ready_registry();
    let key = session_ready_key(root, session_id);
    let deadline = Instant::now() + timeout;
    let mut sessions = registry.sessions.lock().map_err(error_to_string)?;

    loop {
        if sessions.get(&key).copied().unwrap_or(false) {
            return Ok(());
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(format!(
                "Timed out waiting for forked CLI process to report session id after {}s",
                timeout.as_secs()
            ));
        }

        let wait_for = deadline.saturating_duration_since(now).min(Duration::from_millis(250));
        let (next_sessions, wait_result) = registry
            .condvar
            .wait_timeout(sessions, wait_for)
            .map_err(error_to_string)?;
        sessions = next_sessions;

        if wait_result.timed_out() && Instant::now() >= deadline {
            return Err(format!(
                "Timed out waiting for forked CLI process to report session id after {}s",
                timeout.as_secs()
            ));
        }
    }
}

fn wait_for_session_jsonl_created(
    root: &str,
    root_path: &Path,
    session_id: &str,
    timeout: Duration,
) -> Result<PathBuf, String> {
    let path = claude_session_file_path(root_path, session_id)?;
    let deadline = Instant::now() + timeout;
    let started = Instant::now();
    let mut next_progress_log = started + Duration::from_secs(2);

    loop {
        if let Ok(metadata) = fs::metadata(&path) {
            if metadata.is_file() && metadata.len() > 0 {
                fork_debug(format!(
                    "fork JSONL ready; session_id={} path={} bytes={} elapsed_ms={}",
                    session_id,
                    path.display(),
                    metadata.len(),
                    started.elapsed().as_millis()
                ));
                mark_session_ready(root, session_id);
                return Ok(path);
            }
        }

        {
            let mut processes = claw_processes().lock().map_err(error_to_string)?;
            let key = process_key(root, session_id);
            let Some(proc_state) = processes.get_mut(&key) else {
                return Err(format!(
                    "Forked CLI process disappeared before creating session file: {session_id}"
                ));
            };

            if let Some(status) = proc_state.child.try_wait().map_err(error_to_string)? {
                return Err(format!(
                    "Forked CLI process exited before creating session file {session_id}: {status}"
                ));
            }
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(format!(
                "Timed out waiting for forked CLI process to create session file after {}s: {}",
                timeout.as_secs(),
                path.display()
            ));
        }

        if now >= next_progress_log {
            fork_debug(format!(
                "waiting for fork JSONL; session_id={} path={} elapsed_ms={}",
                session_id,
                path.display(),
                started.elapsed().as_millis()
            ));
            next_progress_log += Duration::from_secs(2);
        }

        thread::sleep(Duration::from_millis(100));
    }
}

fn fork_session_wait_key(root: &str, source_session_id: &str) -> String {
    format!("{}::{}", root, source_session_id)
}

fn clear_fork_session_hint(root: &str, source_session_id: &str) {
    if let Ok(mut sessions) = fork_sessions().sessions.lock() {
        sessions.remove(&fork_session_wait_key(root, source_session_id));
    }
}

fn remember_fork_session_hint(root: &str, source_session_id: &str, forked_session_id: &str) {
    if source_session_id.trim().is_empty()
        || forked_session_id.trim().is_empty()
        || source_session_id == forked_session_id
    {
        return;
    }

    if let Ok(mut sessions) = fork_sessions().sessions.lock() {
        sessions.insert(
            fork_session_wait_key(root, source_session_id),
            forked_session_id.to_string(),
        );
    }
}

fn take_fork_session_hint(root: &str, source_session_id: &str) -> Option<String> {
    fork_sessions()
        .sessions
        .lock()
        .ok()
        .and_then(|mut sessions| sessions.remove(&fork_session_wait_key(root, source_session_id)))
}

fn control_response_request_id(value: &Value) -> Option<String> {
    value
        .get("request_id")
        .and_then(|v| v.as_str())
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("request_id"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("response"))
                .and_then(|response| response.get("request_id"))
                .and_then(|v| v.as_str())
        })
        .filter(|request_id| !request_id.trim().is_empty())
        .map(|request_id| request_id.to_string())
}

fn remember_control_response(value: &Value) {
    if value.get("type").and_then(|v| v.as_str()) != Some("control_response") {
        return;
    }

    let Some(request_id) = control_response_request_id(value) else {
        fork_debug(format!(
            "saw control_response without request_id; {}",
            value_summary_for_log(value)
        ));
        return;
    };

    fork_debug(format!(
        "saw control_response; request_id={} {}",
        request_id,
        value_summary_for_log(value)
    ));

    let registry = control_responses();
    if let Ok(mut responses) = registry.responses.lock() {
        responses.insert(request_id.clone(), value.clone());
        registry.condvar.notify_all();
        fork_debug(format!("stored control_response; request_id={}", request_id));
    } else {
        fork_debug(format!("failed to lock control_response registry; request_id={}", request_id));
    }
}

fn wait_for_control_response(request_id: &str, timeout: Duration) -> Result<Value, String> {
    let registry = control_responses();
    let deadline = Instant::now() + timeout;
    let mut responses = registry.responses.lock().map_err(error_to_string)?;

    loop {
        if let Some(response) = responses.remove(request_id) {
            return Ok(response);
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(format!(
                "Timed out waiting for control response {request_id}"
            ));
        }

        let wait_for = deadline.saturating_duration_since(now);
        let (next_responses, wait_result) = registry
            .condvar
            .wait_timeout(responses, wait_for)
            .map_err(error_to_string)?;
        responses = next_responses;

        if wait_result.timed_out() {
            return Err(format!(
                "Timed out waiting for control response {request_id}"
            ));
        }
    }
}

fn capability_item_from_value(
    value: &Value,
    fallback_kind: &str,
) -> Option<AgentReplCapabilityItem> {
    if let Some(name) = value.as_str() {
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        return Some(AgentReplCapabilityItem {
            name: name.to_string(),
            slash: format!("/{name}"),
            kind: fallback_kind.to_string(),
            description: None
});
    }

    let object = value.as_object()?;
    let name = object
        .get("name")
        .or_else(|| object.get("command"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().trim_start_matches('/').to_string())
        .filter(|v| !v.is_empty())?;

    let slash = object
        .get("slash")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("/{name}"));

    let kind = object
        .get("kind")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| fallback_kind.to_string());

    let description = object
        .get("description")
        .or_else(|| object.get("summary"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    Some(AgentReplCapabilityItem {
        name,
        slash,
        kind,
        description
})
}

fn capability_items_from_value(
    value: Option<&Value>,
    fallback_kind: &str,
) -> Vec<AgentReplCapabilityItem> {
    value
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| capability_item_from_value(item, fallback_kind))
                .collect()
        })
        .unwrap_or_default()
}

fn capabilities_from_control_response(
    root: &str,
    session_id: &str,
    value: &Value,
) -> Result<AgentReplCapabilities, String> {
    let capabilities = value
        .pointer("/response/capabilities")
        .or_else(|| value.pointer("/response/response/capabilities"))
        .ok_or_else(|| format!("Control response did not include capabilities: {value}"))?;

    let commands = capability_items_from_value(capabilities.get("commands"), "command");
    let skills = capability_items_from_value(capabilities.get("skills"), "skill");

    let slash_commands = capability_items_from_value(
        capabilities
            .get("slashCommands")
            .or_else(|| capabilities.get("slash_commands")),
        "command",
    );

    let slash_commands = if slash_commands.is_empty() {
        commands
            .iter()
            .cloned()
            .chain(skills.iter().cloned())
            .collect()
    } else {
        slash_commands
    };

    Ok(AgentReplCapabilities {
        root: root.to_string(),
        session_id: session_id.to_string(),
        commands,
        skills,
        slash_commands,
        updated_at_ms: now_millis() as u64
})
}


fn context_usage_from_control_response(
    root: &str,
    session_id: &str,
    value: &Value,
) -> Result<AgentContextUsage, String> {
    let data = value
        .pointer("/response/response")
        .or_else(|| value.pointer("/response"))
        .ok_or_else(|| format!("Control response did not include context usage: {value}"))?
        .clone();

    Ok(AgentContextUsage {
        root: root.to_string(),
        session_id: session_id.to_string(),
        data,
        updated_at_ms: now_millis() as u64
    })
}

fn process_key(root: &str, session_id: &str) -> String {
    format!("{root}\n{session_id}")
}

fn is_existing_claude_session_id(session_id: &str) -> bool {
    if session_id.starts_with("new-") || session_id.starts_with("pending-") {
        return false;
    }

    let parts: Vec<&str> = session_id.split('-').collect();
    parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && session_id
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

fn claude_session_file_exists(root_path: &Path, session_id: &str) -> bool {
    if !is_existing_claude_session_id(session_id) {
        return false;
    }

    claude_project_sessions_dir(root_path)
        .map(|dir| dir.join(format!("{session_id}.jsonl")).is_file())
        .unwrap_or(false)
}

fn claude_session_file_path(root_path: &Path, session_id: &str) -> Result<PathBuf, String> {
    if !is_existing_claude_session_id(session_id) {
        return Err(format!("not a Claude session id: {session_id}"));
    }

    Ok(claude_project_sessions_dir(root_path)?.join(format!("{session_id}.jsonl")))
}

fn rekey_process_session(root: &str, old_session_id: &str, new_session_id: &str) -> Option<u32> {
    if old_session_id == new_session_id || new_session_id.trim().is_empty() {
        return None;
    }

    let old_key = process_key(root, old_session_id);
    let new_key = process_key(root, new_session_id);

    if let Ok(mut processes) = claw_processes().lock() {
        if let Some(existing) = processes.get(&new_key) {
            return Some(existing.pid);
        }

        if let Some(mut proc_state) = processes.remove(&old_key) {
            let pid = proc_state.pid;
            proc_state.session_id = new_session_id.to_string();
            processes.insert(new_key, proc_state);
            return Some(pid);
        }
    }

    None
}

fn remove_process_session(root: &str, session_id: &str) {
    if let Ok(mut processes) = claw_processes().lock() {
        let key = process_key(root, session_id);
        if let Some(mut process) = processes.remove(&key) {
            match process.child.try_wait() {
                Ok(Some(status)) => fork_debug(format!(
                    "process removed after child exit; root={} session_id={} stored_session_id={} pid={} status={} code={:?} success={}",
                    root,
                    session_id,
                    process.session_id,
                    process.pid,
                    status,
                    status.code(),
                    status.success()
                )),
                Ok(None) => fork_debug(format!(
                    "process removed while child still running; root={} session_id={} stored_session_id={} pid={}",
                    root,
                    session_id,
                    process.session_id,
                    process.pid
                )),
                Err(error) => fork_debug(format!(
                    "process removed but child exit status check failed; root={} session_id={} stored_session_id={} pid={} error={}",
                    root,
                    session_id,
                    process.session_id,
                    process.pid,
                    error
                )),
            }
        } else {
            fork_debug(format!(
                "process remove requested but no process entry found; root={} session_id={}",
                root,
                session_id
            ));
        }
    } else {
        fork_debug(format!(
            "process remove requested but process map lock failed; root={} session_id={}",
            root,
            session_id
        ));
    }
}

fn poll_fork_wait_child_exit(
    root: &str,
    session_id: &str,
) -> Option<Result<(u32, String, std::process::ExitStatus), String>> {
    let key = process_key(root, session_id);
    let mut processes = match claw_processes().lock() {
        Ok(processes) => processes,
        Err(error) => return Some(Err(error_to_string(error))),
    };

    let Some(process) = processes.get_mut(&key) else {
        return None;
    };

    match process.child.try_wait() {
        Ok(Some(status)) => Some(Ok((process.pid, process.session_id.clone(), status))),
        Ok(None) => None,
        Err(error) => Some(Err(error_to_string(error))),
    }
}

fn shared_session_id(shared: &Arc<Mutex<String>>) -> String {
    shared
        .lock()
        .map(|session_id| session_id.clone())
        .unwrap_or_else(|_| "unknown".to_string())
}

fn set_shared_session_id(shared: &Arc<Mutex<String>>, session_id: &str) {
    if let Ok(mut current) = shared.lock() {
        *current = session_id.to_string();
    }
}

fn stream_value_session_id(value: &Value) -> Option<String> {
    value
        .get("session_id")
        .or_else(|| value.get("sessionId"))
        .and_then(|session_id| session_id.as_str())
        .map(str::trim)
        .filter(|session_id| !session_id.is_empty())
        .map(str::to_string)
}

fn find_string_field_deep(value: &Value, keys: &[&str]) -> Option<String> {
    if let Some(object) = value.as_object() {
        for key in keys {
            if let Some(candidate) = object
                .get(*key)
                .and_then(|candidate| candidate.as_str())
                .map(str::trim)
                .filter(|candidate| !candidate.is_empty())
            {
                return Some(candidate.to_string());
            }
        }

        for child in object.values() {
            if let Some(candidate) = find_string_field_deep(child, keys) {
                return Some(candidate);
            }
        }
    } else if let Some(array) = value.as_array() {
        for child in array {
            if let Some(candidate) = find_string_field_deep(child, keys) {
                return Some(candidate);
            }
        }
    }

    None
}

fn is_allowed_forked_session_id(candidate: &str, excluded_session_ids: &[String]) -> bool {
    let candidate = candidate.trim();
    !candidate.is_empty()
        && excluded_session_ids
            .iter()
            .all(|excluded| excluded.trim() != candidate)
}

fn fork_session_id_from_control_response(value: &Value, excluded_session_ids: &[String]) -> Option<String> {
    find_string_field_deep(
        value,
        &[
            "forked_session_id",
            "forkedSessionId",
            "new_session_id",
            "newSessionId",
        ],
    )
    .filter(|session_id| is_allowed_forked_session_id(session_id, excluded_session_ids))
    .or_else(|| {
        find_string_field_deep(value, &["session_id", "sessionId"])
            .filter(|session_id| is_allowed_forked_session_id(session_id, excluded_session_ids))
    })
}

fn take_control_response(request_id: &str) -> Result<Option<Value>, String> {
    let registry = control_responses();
    let mut responses = registry.responses.lock().map_err(error_to_string)?;
    Ok(responses.remove(request_id))
}

fn wait_for_fork_session_id(
    request_id: &str,
    root: &str,
    source_session_id: &str,
    excluded_session_ids: &[String],
    timeout: Duration,
) -> Result<(String, Option<Value>), String> {
    let started = Instant::now();
    let deadline = started + timeout;
    let mut next_progress_log = started + Duration::from_secs(2);

    fork_debug(format!(
        "wait started; request_id={} source_session_id={} excluded_session_ids={:?} timeout_s={}",
        request_id,
        source_session_id,
        excluded_session_ids,
        timeout.as_secs()
    ));

    loop {
        if let Some(forked_session_id) = take_fork_session_hint(root, source_session_id) {
            if is_allowed_forked_session_id(&forked_session_id, excluded_session_ids) {
                fork_debug(format!(
                    "wait resolved from stream session hint; request_id={} source_session_id={} forked_session_id={} elapsed_ms={}",
                    request_id,
                    source_session_id,
                    forked_session_id,
                    started.elapsed().as_millis()
                ));
                return Ok((forked_session_id, None));
            }

            fork_debug(format!(
                "wait ignored stream session hint; request_id={} source_session_id={} candidate_session_id={} excluded_session_ids={:?} elapsed_ms={}",
                request_id,
                source_session_id,
                forked_session_id,
                excluded_session_ids,
                started.elapsed().as_millis()
            ));
        }

        if let Some(response) = take_control_response(request_id)? {
            fork_debug(format!(
                "wait saw matching control_response; request_id={} {}",
                request_id,
                value_summary_for_log(&response)
            ));

            if let Some(forked_session_id) =
                fork_session_id_from_control_response(&response, excluded_session_ids)
            {
                fork_debug(format!(
                    "wait resolved from control_response; request_id={} source_session_id={} forked_session_id={} elapsed_ms={}",
                    request_id,
                    source_session_id,
                    forked_session_id,
                    started.elapsed().as_millis()
                ));
                return Ok((forked_session_id, Some(response)));
            }

            if response
                .get("error")
                .or_else(|| response.get("message"))
                .is_some()
            {
                let message = format!(
                    "CLI fork response did not include a new session id: {}",
                    response
                );
                fork_debug(format!(
                    "wait failed from error control_response; request_id={} elapsed_ms={} error={}",
                    request_id,
                    started.elapsed().as_millis(),
                    message
                ));
                return Err(message);
            }

            fork_debug(format!(
                "matching control_response had no forked session id and no error; request_id={} elapsed_ms={}",
                request_id,
                started.elapsed().as_millis()
            ));
        }

        if let Some(exit_result) = poll_fork_wait_child_exit(root, source_session_id) {
            match exit_result {
                Ok((pid, stored_session_id, status)) => {
                    let message = format!(
                        "fork CLI child exited before reporting a forked session id; request_id={} source_session_id={} stored_session_id={} pid={} status={} code={:?} success={} elapsed_ms={}",
                        request_id,
                        source_session_id,
                        stored_session_id,
                        pid,
                        status,
                        status.code(),
                        status.success(),
                        started.elapsed().as_millis()
                    );
                    fork_debug(&message);
                    return Err(message);
                }
                Err(error) => {
                    let message = format!(
                        "fork CLI child exit-status check failed while waiting for forked session id; request_id={} source_session_id={} error={} elapsed_ms={}",
                        request_id,
                        source_session_id,
                        error,
                        started.elapsed().as_millis()
                    );
                    fork_debug(&message);
                    return Err(message);
                }
            }
        }

        let now = Instant::now();
        if now >= deadline {
            let message = format!(
                "Timed out waiting for forked session id from host CLI process after {}s",
                timeout.as_secs()
            );
            fork_debug(format!(
                "wait timed out; request_id={} source_session_id={} elapsed_ms={}",
                request_id,
                source_session_id,
                started.elapsed().as_millis()
            ));
            return Err(message);
        }

        if now >= next_progress_log {
            fork_debug(format!(
                "still waiting; request_id={} source_session_id={} elapsed_ms={}",
                request_id,
                source_session_id,
                started.elapsed().as_millis()
            ));
            next_progress_log += Duration::from_secs(2);
        }

        thread::sleep(Duration::from_millis(50));
    }
}

fn emit_process_status(
    app: &tauri::AppHandle,
    root: &str,
    session_id: &str,
    running: bool,
    pid: Option<u32>,
    reason: &str,
) {
    let _ = app.emit(
        "agent-repl-event",
        json!({
            "sessionId": session_id,
            "root": root,
            "eventType": "process_status",
            "payload": {
                "running": running,
                "pid": pid,
                "reason": reason
            }
        }),
    );
}

#[tauri::command]
fn default_workspace() -> Result<WorkspaceState, String> {
    let cwd = std::env::current_dir().map_err(error_to_string)?;
    workspace_state_from_path(&cwd)
}

#[tauri::command]
fn open_workspace(path: String) -> Result<WorkspaceState, String> {
    workspace_state_from_path(Path::new(&path))
}

#[tauri::command]
fn load_workspace_registry() -> Result<WorkspaceRegistry, String> {
    read_workspace_registry()
}

#[tauri::command]
fn add_workspace_registry_entry(path: String) -> Result<WorkspaceRegistry, String> {
    let ws = workspace_state_from_path(Path::new(&path))?;
    let mut registry = read_workspace_registry().unwrap_or_default();

    if !registry.workspaces.iter().any(|w| w.root == ws.root) {
        registry.workspaces.push(WorkspaceRegistryEntry {
            root: ws.root,
            name: ws.name
});
    }

    write_workspace_registry(&registry)?;
    Ok(registry)
}

#[tauri::command]
fn remove_workspace_registry_entry(path: String) -> Result<WorkspaceRegistry, String> {
    let mut registry = read_workspace_registry().unwrap_or_default();
    registry.workspaces.retain(|w| w.root != path);
    write_workspace_registry(&registry)?;
    Ok(registry)
}

#[tauri::command]
fn load_deepseek_pricing() -> Result<Option<DeepSeekPricingConfig>, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let settings_path = std::path::Path::new(&home).join(".claw-agent-ui").join("model-settings.json");
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

#[tauri::command]
fn get_agent_permission_state() -> Result<AgentPermissionState, String> {
    Ok(AgentPermissionState {
        current_mode: "default".to_string(),
        available_modes: available_permission_modes()
})
}

#[tauri::command]
fn interrupt_agent_turn(
    app: tauri::AppHandle,
    root: String,
    session_id: String,
) -> Result<bool, String> {
    let request_id = format!("agent-ui-interrupt-{}", now_millis());
    let request = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "interrupt"
        }
    });

    let key = process_key(&root, &session_id);
    let mut processes = claw_processes().lock().map_err(error_to_string)?;

    let proc_state = if processes.contains_key(&key) {
        processes.get_mut(&key)
    } else {
        processes
            .iter_mut()
            .find(|(_, candidate)| candidate.root == root)
            .map(|(_, candidate)| candidate)
    };

    match proc_state {
        Some(proc_state) => {
            let line = serde_json::to_string(&request).map_err(error_to_string)?;
            writeln!(proc_state.stdin, "{line}").map_err(error_to_string)?;
            proc_state.stdin.flush().map_err(error_to_string)?;
            let _ = app.emit(
                "agent-repl-event",
                json!({
                    "sessionId": session_id,
                    "root": root,
                    "eventType": "interrupt",
                    "payload": {
                        "ok": true,
                        "text": "Interrupt signal sent"
                    }
                }),
            );
            Ok(true)
        }
        None => {
            let _ = app.emit(
                "agent-repl-event",
                json!({
                    "sessionId": session_id,
                    "root": root,
                    "eventType": "interrupt",
                    "payload": {
                        "ok": false,
                        "text": "No running process to interrupt"
                    }
                }),
            );
            Ok(false)
        }
    }
}

#[tauri::command]
fn get_agent_repl_process_status(
    root: String,
    session_id: String,
) -> Result<AgentReplProcessStatus, String> {
    let key = process_key(&root, &session_id);
    let mut processes = claw_processes().lock().map_err(error_to_string)?;

    if let Some(proc_state) = processes.get_mut(&key) {
        match proc_state.child.try_wait().map_err(error_to_string)? {
            None => {
                return Ok(AgentReplProcessStatus {
                    session_id,
                    root,
                    running: true,
                    pid: Some(proc_state.pid)
});
            }
            Some(_) => {
                processes.remove(&key);
            }
        }
    }

    Ok(AgentReplProcessStatus {
        session_id,
        root,
        running: false,
        pid: None
})
}

#[tauri::command]
fn respond_agent_permission(
    root: String,
    session_id: String,
    request_id: String,
    approved: bool,
) -> Result<AgentReplSendResult, String> {
    let behavior = if approved { "allow" } else { "deny" };
    let response = json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": behavior,
                "updatedInput": {}
            }
        }
    });

    let line = serde_json::to_string(&response).map_err(error_to_string)?;
    let key = process_key(&root, &session_id);
    let mut processes = claw_processes().lock().map_err(error_to_string)?;

    let proc_state = if processes.contains_key(&key) {
        processes.get_mut(&key)
    } else {
        processes
            .iter_mut()
            .find(|(_, candidate)| candidate.root == root)
            .map(|(_, candidate)| candidate)
    }
    .ok_or_else(|| "REPL process is not running for permission response".to_string())?;

    eprintln!(
        "[DEBUG] respond_agent_permission: root={}, session={}, request={}, approved={}",
        root, session_id, request_id, approved
    );
    eprintln!("[DEBUG] response line: {}", line);
    writeln!(proc_state.stdin, "{}", line).map_err(error_to_string)?;
    proc_state.stdin.flush().map_err(error_to_string)?;
    eprintln!("[DEBUG] response written and flushed");

    Ok(AgentReplSendResult { accepted: true })
}

#[tauri::command]
fn set_agent_permission_mode(_root: String, mode: String) -> Result<AgentPermissionState, String> {
    let normalized = normalize_permission_mode(&mode)?.to_string();
    Ok(AgentPermissionState {
        current_mode: normalized,
        available_modes: available_permission_modes()
})
}

#[tauri::command]
fn list_project_entries(root: String) -> Result<Vec<ProjectEntry>, String> {
    let root_path = canonical_workspace_root(&root)?;
    let mut entries = Vec::new();

    for entry in fs::read_dir(&root_path).map_err(error_to_string)? {
        let entry = entry.map_err(error_to_string)?;
        let name = entry.file_name().to_string_lossy().to_string();

        if name == ".git" || name == "node_modules" || name == "dist" || name == "target" {
            continue;
        }

        let path = entry.path();
        let kind = if path.is_dir() {
            ProjectEntryKind::Directory
        } else {
            ProjectEntryKind::File
        };

        entries.push(ProjectEntry {
            name,
            path: path
                .strip_prefix(&root_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string(),
            kind
});
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

fn is_ignored_file_reference_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "dist"
            | "target"
            | "build"
            | ".next"
            | ".nuxt"
            | ".turbo"
            | ".cache"
            | ".bun"
            | ".venv"
            | "venv"
            | "__pycache__"
            | "coverage"
            | "vendor"
    )
}

fn normalize_reference_query(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('@')
        .replace('～', "~")
        .to_ascii_lowercase()
        .replace('\\', "/")
}

fn raw_reference_query(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('@')
        .replace('～', "~")
        .replace('\\', "/")
}

fn home_dir_path() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|home| !home.trim().is_empty())
        .map(PathBuf::from)
}

fn expand_absolute_or_home_reference(value: &str) -> Option<PathBuf> {
    let query = raw_reference_query(value);
    if query == "~" {
        return home_dir_path();
    }
    if let Some(rest) = query.strip_prefix("~/") {
        return home_dir_path().map(|home| home.join(rest));
    }
    let path = PathBuf::from(&query);
    if path.is_absolute() {
        return Some(path);
    }
    None
}

fn is_absolute_or_home_reference(value: &str) -> bool {
    let query = raw_reference_query(value);
    query == "~" || query.starts_with("~/") || Path::new(&query).is_absolute()
}

fn display_local_reference_path(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if let Some(home) = home_dir_path().and_then(|home| home.canonicalize().ok()) {
        if let Ok(relative) = canonical.strip_prefix(&home) {
            let suffix = relative.to_string_lossy().replace('\\', "/");
            return if suffix.is_empty() {
                "~".to_string()
            } else {
                format!("~/{suffix}")
            };
        }
    }
    canonical.to_string_lossy().replace('\\', "/")
}

fn file_reference_from_absolute_path(path: &Path, score: i64) -> Option<WorkspaceFileReference> {
    let canonical = path.canonicalize().ok()?;
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() {
        return None;
    }

    let name = canonical.file_name()?.to_string_lossy().to_string();
    let display_path = display_local_reference_path(&canonical);
    let directory = canonical
        .parent()
        .map(display_local_reference_path)
        .unwrap_or_default();
    let extension = canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_string());
    let modified_epoch_millis = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());

    Some(WorkspaceFileReference {
        path: display_path,
        name,
        directory,
        extension,
        size_bytes: Some(metadata.len()),
        modified_epoch_millis,
        score
})
}

fn search_absolute_or_home_file_references(
    query: &str,
    limit: usize,
) -> Vec<WorkspaceFileReference> {
    let raw_query = raw_reference_query(query);
    if !is_absolute_or_home_reference(&raw_query) {
        return Vec::new();
    }

    let Some(expanded) = expand_absolute_or_home_reference(&raw_query) else {
        return Vec::new();
    };

    if let Some(reference) = file_reference_from_absolute_path(&expanded, 30_000) {
        return vec![reference];
    }

    let (directory, partial_name) = if expanded.is_dir() {
        (expanded, String::new())
    } else {
        let parent = expanded
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| expanded.clone());
        let partial = expanded
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        (parent, partial)
    };

    if !directory.is_dir() {
        return Vec::new();
    }

    let normalized_partial = partial_name.to_ascii_lowercase();
    let mut references = Vec::new();
    if let Ok(entries) = fs::read_dir(&directory) {
        for entry in entries.flatten() {
            if references.len() >= limit.saturating_mul(3) {
                break;
            }
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let normalized_name = name.to_ascii_lowercase();
            if !normalized_partial.is_empty()
                && !normalized_name.contains(&normalized_partial)
                && !fuzzy_contains(&normalized_name, &normalized_partial)
            {
                continue;
            }
            let score = if normalized_partial.is_empty() {
                10_000_i64.saturating_sub(name.len() as i64)
            } else if normalized_name == normalized_partial {
                24_000
            } else if normalized_name.starts_with(&normalized_partial) {
                20_000
            } else if normalized_name.contains(&normalized_partial) {
                16_000
            } else {
                12_000
            };
            if let Some(reference) = file_reference_from_absolute_path(&path, score) {
                references.push(reference);
            }
        }
    }

    references.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    references.dedup_by(|a, b| a.path == b.path);
    references.truncate(limit);
    references
}

fn resolve_local_reference_file_path(root: &Path, path: &str) -> Result<(PathBuf, String), String> {
    let raw_path = raw_reference_query(path);
    if raw_path.is_empty() {
        return Err("empty file reference path".to_string());
    }

    if is_absolute_or_home_reference(&raw_path) {
        let expanded = expand_absolute_or_home_reference(&raw_path)
            .ok_or_else(|| format!("invalid file reference path: {path}"))?;
        let resolved = expanded.canonicalize().map_err(error_to_string)?;
        if !resolved.is_file() {
            return Err("referenced path is not a file".to_string());
        }
        let display_path = display_local_reference_path(&resolved);
        return Ok((resolved, display_path));
    }

    let resolved = resolve_workspace_path(root, &raw_path)?;
    if !resolved.is_file() {
        return Err("referenced path is not a file".to_string());
    }
    Ok((resolved, raw_path))
}

fn fuzzy_contains(value: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }

    let mut query_chars = query.chars();
    let mut current = match query_chars.next() {
        Some(ch) => ch,
        None => return true
};

    for ch in value.chars() {
        if ch == current {
            match query_chars.next() {
                Some(next) => current = next,
                None => return true
}
        }
    }

    false
}

fn file_reference_score(path: &str, name: &str, query: &str) -> Option<i64> {
    let normalized_path = path.to_ascii_lowercase().replace('\\', "/");
    let normalized_name = name.to_ascii_lowercase();
    let query = normalize_reference_query(query);

    if query.is_empty() {
        return Some(10_000_i64.saturating_sub(path.len() as i64));
    }

    let query_tokens: Vec<&str> = query
        .split(|ch: char| ch.is_whitespace())
        .filter(|token| !token.is_empty())
        .collect();

    if query_tokens
        .iter()
        .any(|token| !normalized_path.contains(token) && !fuzzy_contains(&normalized_path, token))
    {
        return None;
    }

    let mut score = 0_i64;
    if normalized_path == query {
        score += 20_000;
    }
    if normalized_name == query {
        score += 16_000;
    }
    if normalized_name.starts_with(&query) {
        score += 12_000;
    }
    if normalized_path.starts_with(&query) {
        score += 10_000;
    }
    if normalized_path.contains(&format!("/{query}")) {
        score += 8_000;
    }
    if normalized_path.contains(&query) {
        score += 5_000;
    } else if fuzzy_contains(&normalized_path, &query) {
        score += 2_000;
    }

    score += (query_tokens.len() as i64) * 100;
    score -= path.len().min(300) as i64;
    Some(score)
}

fn workspace_file_reference_from_path(
    root: &Path,
    relative_path: &str,
    query: &str,
) -> Option<WorkspaceFileReference> {
    let normalized_relative = relative_path.trim().replace('\\', "/");
    if normalized_relative.is_empty() || normalized_relative.ends_with('/') {
        return None;
    }
    if normalized_relative
        .split('/')
        .any(|part| is_ignored_file_reference_dir(part))
    {
        return None;
    }

    let absolute = root.join(&normalized_relative);
    let metadata = fs::metadata(&absolute).ok()?;
    if !metadata.is_file() {
        return None;
    }

    let name = Path::new(&normalized_relative)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&normalized_relative)
        .to_string();
    let score = file_reference_score(&normalized_relative, &name, query)?;
    let directory = Path::new(&normalized_relative)
        .parent()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_string());
    let extension = Path::new(&normalized_relative)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string());
    let modified_epoch_millis = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());

    Some(WorkspaceFileReference {
        path: normalized_relative,
        name,
        directory,
        extension,
        size_bytes: Some(metadata.len()),
        modified_epoch_millis,
        score
})
}

fn collect_workspace_file_references(
    root: &Path,
    current: &Path,
    query: &str,
    out: &mut Vec<WorkspaceFileReference>,
    scanned: &mut usize,
) -> Result<(), String> {
    if *scanned > 20_000 {
        return Ok(());
    }

    for entry in fs::read_dir(current).map_err(error_to_string)? {
        let entry = entry.map_err(error_to_string)?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            if !is_ignored_file_reference_dir(&name) {
                collect_workspace_file_references(root, &path, query, out, scanned)?;
            }
            continue;
        }

        *scanned += 1;
        if let Ok(relative) = path.strip_prefix(root) {
            let relative_string = relative.to_string_lossy().replace('\\', "/");
            if let Some(reference) =
                workspace_file_reference_from_path(root, &relative_string, query)
            {
                out.push(reference);
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn search_workspace_files(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<WorkspaceFileReference>, String> {
    let root_path = canonical_workspace_root(&root)?;
    let limit = max_results.unwrap_or(20).clamp(1, 50);
    let external_references = search_absolute_or_home_file_references(&query, limit);
    if !external_references.is_empty() {
        return Ok(external_references);
    }
    let normalized_query = normalize_reference_query(&query);
    let mut references = Vec::new();

    let git_output = Command::new("git")
        .arg("-C")
        .arg(&root_path)
        .arg("ls-files")
        .arg("--cached")
        .arg("--others")
        .arg("--exclude-standard")
        .output();

    if let Ok(output) = git_output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if let Some(reference) =
                    workspace_file_reference_from_path(&root_path, line, &normalized_query)
                {
                    references.push(reference);
                }
            }
        }
    }

    if references.is_empty() {
        let mut scanned = 0_usize;
        collect_workspace_file_references(
            &root_path,
            &root_path,
            &normalized_query,
            &mut references,
            &mut scanned,
        )?;
    }

    references.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    references.dedup_by(|a, b| a.path == b.path);
    references.truncate(limit);
    Ok(references)
}

fn normalize_frontmatter_key(key: &str) -> String {
    key.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace('_', "-")
        .to_ascii_lowercase()
}

fn clean_frontmatter_value(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string()
}

fn parse_skill_frontmatter(markdown: &str) -> HashMap<String, Vec<String>> {
    let mut frontmatter = HashMap::new();
    let mut lines = markdown.lines();

    if lines.next().map(str::trim) != Some("---") {
        return frontmatter;
    }

    let mut current_key: Option<String> = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(item) = trimmed.strip_prefix("- ") {
            if let Some(key) = current_key.as_ref() {
                frontmatter
                    .entry(key.clone())
                    .or_insert_with(Vec::new)
                    .push(clean_frontmatter_value(item));
            }
            continue;
        }
        if let Some(item) = trimmed.strip_prefix("  - ") {
            if let Some(key) = current_key.as_ref() {
                frontmatter
                    .entry(key.clone())
                    .or_insert_with(Vec::new)
                    .push(clean_frontmatter_value(item));
            }
            continue;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            let key = normalize_frontmatter_key(key);
            let value = clean_frontmatter_value(value);
            current_key = Some(key.clone());
            frontmatter.entry(key.clone()).or_insert_with(Vec::new);
            if !value.is_empty() {
                frontmatter.insert(key, vec![value]);
            }
        }
    }

    frontmatter
}

fn frontmatter_first(frontmatter: &HashMap<String, Vec<String>>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| frontmatter.get(&normalize_frontmatter_key(key)))
        .and_then(|values| values.iter().find(|value| !value.trim().is_empty()))
        .cloned()
}

fn frontmatter_list(frontmatter: &HashMap<String, Vec<String>>, keys: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    for key in keys {
        if let Some(items) = frontmatter.get(&normalize_frontmatter_key(key)) {
            for item in items {
                let trimmed = item.trim();
                if !trimmed.is_empty()
                    && !values
                        .iter()
                        .any(|value: &String| value.as_str() == trimmed)
                {
                    values.push(trimmed.to_string());
                }
            }
        }
    }
    values
}

fn frontmatter_bool(
    frontmatter: &HashMap<String, Vec<String>>,
    keys: &[&str],
    default: bool,
) -> bool {
    match frontmatter_first(frontmatter, keys)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "true" | "yes" | "1" | "on" => true,
        "false" | "no" | "0" | "off" => false,
        _ => default
}
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };

    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            match fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => metadata.len(),
                Ok(metadata) if metadata.is_dir() => directory_size(&path),
                _ => 0
}
        })
        .sum()
}

fn modified_epoch_millis(path: &Path) -> Option<u128> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
}

fn relative_path_string(root_path: &Path, path: &Path) -> String {
    path.strip_prefix(root_path)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn capability_for_tool(tool: &str) -> String {
    let lower = tool.to_ascii_lowercase();
    if lower.starts_with("bash(git") || lower.contains(" git") {
        "Git".to_string()
    } else if lower.starts_with("bash") {
        "Shell".to_string()
    } else if lower.starts_with("read") {
        "File Read".to_string()
    } else if lower.starts_with("write")
        || lower.starts_with("edit")
        || lower.starts_with("multiedit")
    {
        "File Write".to_string()
    } else if lower.starts_with("grep") || lower.starts_with("glob") || lower.starts_with("ls") {
        "Search".to_string()
    } else if lower.starts_with("web") {
        "Network".to_string()
    } else if lower.starts_with("agent") {
        "Sub Agent".to_string()
    } else if lower.starts_with("skill") {
        "Skill Invoke".to_string()
    } else {
        tool.split(['(', ':'])
            .next()
            .unwrap_or(tool)
            .trim()
            .to_string()
    }
}

fn capabilities_for_tools(tools: &[String]) -> Vec<String> {
    let mut capabilities = Vec::new();
    for tool in tools {
        let capability = capability_for_tool(tool);
        if !capability.is_empty() && !capabilities.contains(&capability) {
            capabilities.push(capability);
        }
    }
    capabilities
}

fn build_skill_summary(
    root_path: &Path,
    skill_dir: &Path,
    source_kind: &str,
    source_label: &str,
    source_base: &Path,
) -> serde_json::Value {
    let directory_name = skill_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let skill_md = skill_dir.join("SKILL.md");
    let markdown = fs::read_to_string(&skill_md).unwrap_or_default();
    let frontmatter = parse_skill_frontmatter(&markdown);
    let mut validation = Vec::new();

    if !skill_md.exists() {
        validation.push("Missing SKILL.md".to_string());
    }
    if markdown.starts_with("---") && frontmatter.is_empty() {
        validation.push("Unable to parse frontmatter".to_string());
    }

    let name = frontmatter_first(&frontmatter, &["name"]).unwrap_or(directory_name);
    let description = frontmatter_first(&frontmatter, &["description"]);
    let when_to_use = frontmatter_first(&frontmatter, &["when-to-use", "when_to_use", "whenToUse"]);
    let version = frontmatter_first(&frontmatter, &["version"]);
    let allowed_tools = frontmatter_list(
        &frontmatter,
        &["allowed-tools", "allowed_tools", "allowedTools"],
    );
    let paths = frontmatter_list(&frontmatter, &["paths"]);
    let hooks = frontmatter_list(&frontmatter, &["hooks"]);
    let context =
        frontmatter_first(&frontmatter, &["context"]).unwrap_or_else(|| "inline".to_string());
    let agent = frontmatter_first(&frontmatter, &["agent"]);
    let model = frontmatter_first(&frontmatter, &["model"]);
    let effort = frontmatter_first(&frontmatter, &["effort"]);
    let user_invocable = frontmatter_bool(
        &frontmatter,
        &["user-invocable", "user_invocable", "userInvocable"],
        true,
    );
    let disable_model_invocation = frontmatter_bool(
        &frontmatter,
        &[
            "disable-model-invocation",
            "disable_model_invocation",
            "disableModelInvocation"
],
        false,
    );
    let model_invocable = !disable_model_invocation;
    let size_bytes = directory_size(skill_dir);
    let installed_at_ms =
        modified_epoch_millis(&skill_md).or_else(|| modified_epoch_millis(skill_dir));
    let skill_root = relative_path_string(root_path, skill_dir);
    let skill_path = relative_path_string(root_path, &skill_md);
    let capabilities = capabilities_for_tools(&allowed_tools);

    json!({
        "id": format!("{source_kind}:{name}"),
        "name": name,
        "description": description,
        "whenToUse": when_to_use,
        "version": version,
        "path": skill_path,
        "skillRoot": skill_root,
        "source": {
            "kind": source_kind,
            "label": source_label,
            "path": source_base.to_string_lossy().to_string()
        },
        "origin": {
            "id": source_kind,
            "label": source_label
        },
        "enabled": true,
        "userInvocable": user_invocable,
        "modelInvocable": model_invocable,
        "context": context,
        "agent": agent,
        "model": model,
        "effort": effort,
        "allowedTools": allowed_tools,
        "capabilities": capabilities,
        "paths": paths,
        "hooks": hooks,
        "sizeBytes": size_bytes,
        "installedAtMs": installed_at_ms,
        "validation": validation,
        "shadowedBy": [],
        "shadowed_by": []
    })
}

#[tauri::command]
fn list_skills(root: String) -> Result<serde_json::Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let project_skills_dir = root_path.join(".claude").join("skills");
    let user_skills_dir = claude_config_dir()?.join("skills");
    let skill_sources = vec![
        ("project", "Project", project_skills_dir),
        ("user", "User", user_skills_dir)
];
    let mut skills = Vec::new();
    let mut sources = Vec::new();
    let mut seen_by_name: HashMap<String, String> = HashMap::new();
    let mut shadowed = 0usize;

    for (source_kind, source_label, skills_dir) in skill_sources {
        let mut source_count = 0usize;
        if skills_dir.exists() {
            let mut entries = fs::read_dir(&skills_dir)
                .map_err(error_to_string)?
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
            source_count = entries.len();

            for entry in entries {
                let mut skill = build_skill_summary(
                    &root_path,
                    &entry.path(),
                    source_kind,
                    source_label,
                    &skills_dir,
                );
                let name_key = skill
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let skill_id = skill
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();

                if let Some(shadowing_id) = seen_by_name.get(&name_key).cloned() {
                    if let Some(object) = skill.as_object_mut() {
                        object.insert("enabled".to_string(), json!(false));
                        object.insert("shadowedBy".to_string(), json!([shadowing_id.clone()]));
                        object.insert("shadowed_by".to_string(), json!([shadowing_id]));
                    }
                    shadowed += 1;
                } else if !name_key.is_empty() {
                    seen_by_name.insert(name_key, skill_id);
                }

                skills.push(skill);
            }
        }

        sources.push(json!({
            "kind": source_kind,
            "label": source_label,
            "path": skills_dir.to_string_lossy().to_string(),
            "exists": skills_dir.exists(),
            "count": source_count
        }));
    }

    let active = skills.len().saturating_sub(shadowed);
    Ok(json!({
        "kind": "skills",
        "action": "list",
        "sources": sources,
        "summary": {
            "total": skills.len(),
            "active": active,
            "shadowed": shadowed
        },
        "skills": skills
    }))
}

#[tauri::command]
fn install_skill(root: String, source: String) -> Result<serde_json::Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let skills_dir = root_path.join(".claude").join("skills");
    fs::create_dir_all(&skills_dir).map_err(error_to_string)?;

    Ok(json!({
        "kind": "skills",
        "action": "list",
        "installed": {
            "name": source,
            "path": skills_dir.to_string_lossy().to_string()
        },
        "summary": {
            "total": 0,
            "active": 0,
            "shadowed": 0
        },
        "skills": []
    }))
}

#[tauri::command]
fn read_workspace_file(root: String, path: String) -> Result<FileView, String> {
    let root_path = canonical_workspace_root(&root)?;
    let resolved = resolve_workspace_path(&root_path, &path)?;
    let metadata = fs::metadata(&resolved).map_err(error_to_string)?;
    let content = fs::read_to_string(&resolved).map_err(error_to_string)?;

    Ok(FileView {
        path,
        total_lines: content.lines().count(),
        size_bytes: metadata.len(),
        language: language_for_path(&resolved.to_string_lossy()),
        content
})
}

#[tauri::command]
fn read_local_reference_file(root: String, path: String) -> Result<FileView, String> {
    let root_path = canonical_workspace_root(&root)?;
    let (resolved, display_path) = resolve_local_reference_file_path(&root_path, &path)?;
    let metadata = fs::metadata(&resolved).map_err(error_to_string)?;
    let content = fs::read_to_string(&resolved).map_err(error_to_string)?;

    Ok(FileView {
        path: display_path,
        total_lines: content.lines().count(),
        size_bytes: metadata.len(),
        language: language_for_path(&resolved.to_string_lossy()),
        content
})
}

#[tauri::command]
fn read_local_image_metadata(root: String, path: String) -> Result<LocalImageMetadata, String> {
    let root_path = canonical_workspace_root(&root)?;
    let resolved = resolve_local_reference_path(&root_path, &path)?;

    if !is_supported_image_path(&resolved) {
        return Err(
            "only png, jpg, jpeg, gif, webp, and svg image previews are supported".to_string(),
        );
    }

    let metadata = fs::metadata(&resolved).map_err(error_to_string)?;
    if !metadata.is_file() {
        return Err("image preview path is not a file".to_string());
    }

    Ok(LocalImageMetadata {
        path: resolved.to_string_lossy().to_string(),
        mime_type: image_mime_for_path(&resolved).to_string(),
        size_bytes: metadata.len()
})
}

#[tauri::command]
fn read_local_image_preview(root: String, path: String) -> Result<LocalImagePreview, String> {
    let root_path = canonical_workspace_root(&root)?;
    let resolved = resolve_local_reference_path(&root_path, &path)?;

    if !is_supported_image_path(&resolved) {
        return Err(
            "only png, jpg, jpeg, gif, webp, and svg image previews are supported".to_string(),
        );
    }

    let metadata = fs::metadata(&resolved).map_err(error_to_string)?;
    if !metadata.is_file() {
        return Err("image preview path is not a file".to_string());
    }

    const MAX_IMAGE_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;
    if metadata.len() > MAX_IMAGE_PREVIEW_BYTES {
        return Err(format!(
            "image is too large to preview inline ({} bytes, max {} bytes)",
            metadata.len(),
            MAX_IMAGE_PREVIEW_BYTES
        ));
    }

    let bytes = fs::read(&resolved).map_err(error_to_string)?;
    let mime_type = image_mime_for_path(&resolved).to_string();
    let data_url = format!(
        "data:{};base64,{}",
        mime_type,
        general_purpose::STANDARD.encode(bytes)
    );

    Ok(LocalImagePreview {
        path: resolved.to_string_lossy().to_string(),
        mime_type,
        data_url,
        size_bytes: metadata.len()
})
}

#[tauri::command]
fn write_workspace_file(root: String, path: String, content: String) -> Result<(), String> {
    let root_path = canonical_workspace_root(&root)?;
    let resolved = resolve_workspace_path_allow_missing(&root_path, &path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(error_to_string)?;
    }
    fs::write(resolved, content).map_err(error_to_string)
}

#[tauri::command]
fn edit_workspace_file(
    root: String,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: bool,
) -> Result<serde_json::Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let resolved = resolve_workspace_path(&root_path, &path)?;
    let content = fs::read_to_string(&resolved).map_err(error_to_string)?;

    let updated = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };

    if updated == content {
        return Err("oldString not found".to_string());
    }

    fs::write(&resolved, updated).map_err(error_to_string)?;
    Ok(json!({ "ok": true, "path": path }))
}

#[tauri::command]
fn glob_runtime_search(
    root: String,
    pattern: String,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let base = match path {
        Some(p) if !p.is_empty() => resolve_workspace_path(&root_path, &p)?,
        _ => root_path
};

    let output = Command::new("find")
        .arg(&base)
        .arg("-name")
        .arg(&pattern)
        .output()
        .map_err(error_to_string)?;

    Ok(json!({
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "success": output.status.success()
    }))
}

#[tauri::command]
fn grep_runtime_search(
    root: String,
    request: GrepRuntimeRequest,
) -> Result<serde_json::Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let base = match request.path {
        Some(p) if !p.is_empty() => resolve_workspace_path(&root_path, &p)?,
        _ => root_path
};

    let mut cmd = Command::new("grep");
    cmd.arg("-R").arg("-n");

    if request.case_insensitive.unwrap_or(false) {
        cmd.arg("-i");
    }

    if let Some(glob) = request.glob {
        cmd.arg(format!("--include={glob}"));
    }

    cmd.arg(&request.pattern).arg(&base);

    let output = cmd.output().map_err(error_to_string)?;
    let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if let Some(limit) = request.head_limit {
        stdout = stdout.lines().take(limit).collect::<Vec<_>>().join("\n");
    }

    Ok(json!({
        "stdout": stdout,
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "success": output.status.success(),
        "output_mode": request.output_mode.unwrap_or_else(|| "content".to_string())
    }))
}

#[tauri::command]
fn execute_runtime_bash(
    root: String,
    request: BashRuntimeRequest,
) -> Result<serde_json::Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let output = Command::new("bash")
        .arg("-lc")
        .arg(&request.command)
        .current_dir(&root_path)
        .output()
        .map_err(error_to_string)?;

    Ok(json!({
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "success": output.status.success(),
        "timeout_ms": request.timeout_ms
    }))
}

#[tauri::command]
fn list_runtime_sessions(root: String) -> Result<Vec<RuntimeSessionSummary>, String> {
    let root_path = canonical_workspace_root(&root)?;
    let sessions_dir = claude_project_sessions_dir(&root_path)?;
    let mut sessions = Vec::new();

    if sessions_dir.exists() {
        collect_session_files(&sessions_dir, &mut sessions)?;
    }

    sessions.sort_by(|a, b| b.modified_epoch_millis.cmp(&a.modified_epoch_millis));
    Ok(sessions)
}

#[tauri::command]
fn load_runtime_session(root: String, reference: String) -> Result<serde_json::Value, String> {
    let root_path = canonical_workspace_root(&root)?;
    let sessions = list_runtime_sessions(root)?;
    let found = sessions
        .into_iter()
        .find(|s| s.id == reference || s.path == reference);

    if let Some(summary) = found {
        let content = fs::read_to_string(&summary.path).map_err(error_to_string)?;
        let messages = parse_jsonl_messages(&content);

        Ok(json!({
            "id": summary.id,
            "path": summary.path,
            "title": summary.title,
            "version": 1,
            "created_at_ms": summary.updated_at_ms,
            "updated_at_ms": summary.updated_at_ms,
            "message_count": messages.len(),
            "prompt_history_count": 0,
            "model": null,
            "workspace_root": root_path.to_string_lossy().to_string(),
            "has_compaction": false,
            "messages": messages,
            "fork": null
        }))
    } else {
        Err("session not found".to_string())
    }
}

#[tauri::command]
fn create_runtime_session(root: String) -> Result<RuntimeSessionSummary, String> {
    let root_path = canonical_workspace_root(&root)?;
    let id = format!("new-{}", now_millis());

    Ok(RuntimeSessionSummary {
        id,
        title: "New session".to_string(),
        path: claude_project_sessions_dir(&root_path)?
            .to_string_lossy()
            .to_string(),
        updated_at_ms: now_millis() as u64,
        modified_epoch_millis: now_millis(),
        message_count: 0,
        parent_session_id: None,
        branch_name: None
})
}

#[tauri::command]
fn read_git_diff(root: String, path: Option<String>) -> Result<GitDiff, String> {
    let root_path = canonical_workspace_root(&root)?;
    let mut cmd = Command::new("git");
    cmd.arg("diff");

    if let Some(p) = &path {
        cmd.arg("--").arg(p);
    }

    let output = cmd
        .current_dir(&root_path)
        .output()
        .map_err(error_to_string)?;
    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(GitDiff {
        path,
        is_empty: diff.trim().is_empty(),
        diff
})
}

#[tauri::command]
fn load_model_settings() -> Result<ModelSettings, String> {
    let path = model_settings_path()?;

    let mut settings = if path.exists() {
        let content = fs::read_to_string(path).map_err(error_to_string)?;
        serde_json::from_str(&content).map_err(error_to_string)?
    } else {
        default_model_settings()
    };

    Ok(settings)
}

#[tauri::command]
fn save_model_settings(mut settings: ModelSettings) -> Result<ModelSettings, String> {
    normalize_model_settings(&mut settings)?;

    let path = model_settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(error_to_string)?;
    }

    fs::write(
        &path,
        serde_json::to_string_pretty(&settings).map_err(error_to_string)?,
    )
    .map_err(error_to_string)?;

    Ok(settings)
}

#[tauri::command]
fn test_model_connection(settings: ModelSettings) -> Result<ModelConnectionTestResult, String> {
    let config = active_model_config(&settings)?;
    let model = resolve_model_for_provider(config);

    if config.api_key.trim().is_empty() {
        return Ok(ModelConnectionTestResult {
            ok: false,
            message: "API key 为空".to_string(),
            model,
            stderr: None
});
    }

    Ok(ModelConnectionTestResult {
        ok: true,
        message: "配置格式看起来可用；真正连通性会在发送消息时验证。".to_string(),
        model,
        stderr: None
})
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpToolConfig {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    parameters: serde_json::Value
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerConfig {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default, rename = "type")]
    server_type: Option<String>,
    command: String,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    tools: Vec<McpToolConfig>
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpSettings {
    #[serde(default)]
    mcp_servers: std::collections::BTreeMap<String, McpServerConfig>
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpSettingsFile {
    path: String,
    settings: McpSettings
}

fn default_mcp_settings() -> McpSettings {
    McpSettings {
        mcp_servers: std::collections::BTreeMap::new()
}
}

fn astromere_mcp_config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "failed to resolve home directory for MCP settings".to_string())?;

    Ok(PathBuf::from(home)
        .join(".claude")
        .join("astromere")
        .join("mcp.json"))
}

#[tauri::command]
fn load_mcp_settings() -> Result<McpSettingsFile, String> {
    let path = astromere_mcp_config_path()?;

    if !path.is_file() {
        return Ok(McpSettingsFile {
            path: path.to_string_lossy().to_string(),
            settings: default_mcp_settings()
});
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read MCP settings {}: {error}", path.display()))?;

    let settings = serde_json::from_str::<McpSettings>(&raw)
        .map_err(|error| format!("failed to parse MCP settings {}: {error}", path.display()))?;

    Ok(McpSettingsFile {
        path: path.to_string_lossy().to_string(),
        settings
})
}

#[tauri::command]
fn save_mcp_settings(settings: McpSettings) -> Result<McpSettingsFile, String> {
    let path = astromere_mcp_config_path()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create MCP settings dir {}: {error}",
                parent.display()
            )
        })?;
    }

    let raw = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("failed to serialize MCP settings: {error}"))?;

    fs::write(&path, format!("{raw}\n"))
        .map_err(|error| format!("failed to write MCP settings {}: {error}", path.display()))?;

    Ok(McpSettingsFile {
        path: path.to_string_lossy().to_string(),
        settings
})
}

#[tauri::command]
fn ensure_agent_repl_process(
    app: tauri::AppHandle,
    root: String,
    session_id: String,
    model_override: Option<String>,
    permission_mode: Option<String>,
) -> Result<AgentReplProcessState, String> {
    let permission_mode =
        normalize_permission_mode(permission_mode.as_deref().unwrap_or("default"))?.to_string();
    let root_path = canonical_workspace_root(&root)?;
    let repo = repo_root()?;
    let settings = load_model_settings().unwrap_or_else(|_| default_model_settings());
    let config = active_model_config(&settings).ok().cloned();

    let model = model_override.unwrap_or_else(|| {
        config
            .as_ref()
            .map(resolve_model_for_provider)
            .unwrap_or_else(|| "default".to_string())
    });

    let key = process_key(&root, &session_id);

    {
        let mut processes = claw_processes().lock().map_err(error_to_string)?;

        if let Some(proc_state) = processes.get_mut(&key) {
            match proc_state.child.try_wait().map_err(error_to_string)? {
                None => {
                    let _ = app.emit(
                        "agent-repl-event",
                        json!({
                            "sessionId": session_id,
                            "root": root,
                            "eventType": "startup",
                            "payload": {
                                "bridge": "bun-stream-json",
                                "process": "reused",
                                "pid": proc_state.pid,
                                "model": model
                            }
                        }),
                    );

                    emit_process_status(
                        &app,
                        &root,
                        &session_id,
                        true,
                        Some(proc_state.pid),
                        "reused",
                    );

                    return Ok(AgentReplProcessState {
                        session_id,
                        root,
                        model,
                        permission_mode: permission_mode.clone()
});
                }
                Some(status) => {
                    let old_pid = proc_state.pid;
                    processes.remove(&key);

                    let _ = app.emit(
                        "agent-repl-event",
                        json!({
                            "sessionId": session_id,
                            "root": root,
                            "eventType": "process_exit",
                            "payload": {
                                "running": false,
                                "pid": old_pid,
                                "status": status.to_string(),
                                "reason": "exited_before_ensure"
                            }
                        }),
                    );

                    emit_process_status(
                        &app,
                        &root,
                        &session_id,
                        false,
                        Some(old_pid),
                        "exited_before_ensure",
                    );
                }
            }
        }
    }

    let mut cmd = Command::new("bun");
    cmd.arg("run")
        .arg(repo.join("src/entrypoints/cli.tsx"))
        .arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--replay-user-messages")
        .arg("--permission-mode")
        .arg(&permission_mode)
        .arg("--permission-prompt-tool")
        .arg("stdio");

    if claude_session_file_exists(&root_path, &session_id) {
        cmd.arg("--resume").arg(&session_id);
    } else if is_existing_claude_session_id(&session_id) {
        cmd.arg("--session-id").arg(&session_id);
    }

    cmd.current_dir(&root_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    apply_agent_ui_env(&mut cmd, &root_path, &session_id)?;

    if let Some(config) = config.as_ref() {
        apply_model_env(&mut cmd, config);

        if model != "default" {
            cmd.arg("--model").arg(&model);
        }
    }

    let mut child = cmd.spawn().map_err(error_to_string)?;
    let pid = child.id();

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open child stdin".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open child stdout".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to open child stderr".to_string())?;

    let shared_session = Arc::new(Mutex::new(session_id.clone()));

    spawn_repl_stdout_reader(app.clone(), shared_session.clone(), root.clone(), stdout, Vec::new());
    spawn_repl_stderr_reader(app.clone(), shared_session.clone(), root.clone(), stderr);

    let _ = app.emit("agent-repl-event", json!({
        "sessionId": session_id,
        "root": root,
        "eventType": "startup",
        "payload": {
            "bridge": "bun-stream-json",
            "process": "spawned",
            "pid": pid,
            "model": model,
            "provider": config.as_ref().map(|c| c.provider),
            "baseUrl": config.as_ref().map(|c| c.base_url.clone()).unwrap_or_default(),
            "apiKeyPresent": config.as_ref().map(|c| !c.api_key.trim().is_empty()).unwrap_or(false)
        }
    }));

    emit_process_status(&app, &root, &session_id, true, Some(pid), "spawned");

    {
        let mut processes = claw_processes().lock().map_err(error_to_string)?;

        processes.insert(
            key,
            ClawProcess {
                root: root.clone(),
                session_id: session_id.clone(),
                pid,
                stdin,
                child
},
        );
    }

    Ok(AgentReplProcessState {
        session_id,
        root,
        model,
        permission_mode: permission_mode.clone()
})
}



#[tauri::command]
fn fork_agent_repl_process(
    app: tauri::AppHandle,
    root: String,
    source_session_id: String,
    checkpoint_uuid: String,
    model_override: Option<String>,
    permission_mode: Option<String>,
) -> Result<AgentReplProcessState, String> {
    let source_session_id = source_session_id.trim().to_string();
    if source_session_id.is_empty() {
        return Err("source_session_id is required".to_string());
    }
    let checkpoint_uuid = checkpoint_uuid.trim().to_string();
    if checkpoint_uuid.is_empty() {
        return Err("checkpoint_uuid is required".to_string());
    }

    let permission_mode =
        normalize_permission_mode(permission_mode.as_deref().unwrap_or("default"))?.to_string();
    let root_path = canonical_workspace_root(&root)?;
    let settings = load_model_settings().unwrap_or_else(|_| default_model_settings());
    let config = active_model_config(&settings).ok().cloned();

    let model = model_override.unwrap_or_else(|| {
        config
            .as_ref()
            .map(resolve_model_for_provider)
            .unwrap_or_else(|| "default".to_string())
    });

    let source_jsonl_exists = claude_session_file_exists(&root_path, &source_session_id);
    let source_arg_is_file = Path::new(&source_session_id).is_file();
    fork_debug(format!(
        "command received; root={} canonical_root={} source_session_id={} checkpoint_uuid={} source_jsonl_exists={} source_arg_is_file={} model={} permission_mode={}",
        root,
        root_path.display(),
        source_session_id,
        checkpoint_uuid,
        source_jsonl_exists,
        source_arg_is_file,
        model,
        permission_mode
    ));

    if !(source_jsonl_exists || source_arg_is_file) {
        fork_debug(format!(
            "source session missing before fork; source_session_id={} root={}",
            source_session_id,
            root_path.display()
        ));
        return Err(format!("source session not found: {source_session_id}"));
    }

    // Same contract as normal session creation:
    // agent-ui owns the target session id; fork only changes the CLI startup args.
    let forked_session_id = generate_agent_ui_session_id();
    clear_session_ready(&root, &forked_session_id);
    clear_fork_session_hint(&root, &forked_session_id);

    let repo = repo_root()?;
    let mut cmd = Command::new("bun");
    cmd.arg("run")
        .arg(repo.join("src/entrypoints/cli.tsx"))
        .arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--replay-user-messages")
        .arg("--resume")
        .arg(&source_session_id)
        .arg("--resume-session-at")
        .arg(&checkpoint_uuid)
        .arg("--fork-session")
        .arg("-desktop-mode")
        .arg("--session-id")
        .arg(&forked_session_id)
        .arg("--permission-mode")
        .arg(&permission_mode)
        .arg("--permission-prompt-tool")
        .arg("stdio");

    cmd.current_dir(&root_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    apply_agent_ui_env(&mut cmd, &root_path, &forked_session_id)?;

    if let Some(config) = config.as_ref() {
        apply_model_env(&mut cmd, config);

        if model != "default" {
            cmd.arg("--model").arg(&model);
        }
    }

    fork_debug(format!(
        "spawning native CLI fork; source_session_id={} forked_session_id={} checkpoint_uuid={} mode=pregenerated_session_id",
        source_session_id,
        forked_session_id,
        checkpoint_uuid
    ));

    let mut child = cmd.spawn().map_err(error_to_string)?;
    let pid = child.id();

    fork_debug(format!(
        "spawned native CLI fork process; source_session_id={} forked_session_id={} pid={} cwd={} checkpoint_uuid={}",
        source_session_id,
        forked_session_id,
        pid,
        root_path.display(),
        checkpoint_uuid
    ));

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open fork child stdin".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open fork child stdout".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to open fork child stderr".to_string())?;

    let fork_key = process_key(&root, &forked_session_id);
    {
        let mut processes = claw_processes().lock().map_err(error_to_string)?;
        processes.insert(
            fork_key,
            ClawProcess {
                root: root.clone(),
                session_id: forked_session_id.clone(),
                pid,
                stdin,
                child,
            },
        );
    }

    let shared_session = Arc::new(Mutex::new(forked_session_id.clone()));
    spawn_repl_stdout_reader(app.clone(), shared_session.clone(), root.clone(), stdout, Vec::new());
    spawn_repl_stderr_reader(app.clone(), shared_session.clone(), root.clone(), stderr);

    let forked_jsonl_path = match wait_for_session_jsonl_created(
        &root,
        &root_path,
        &forked_session_id,
        Duration::from_secs(30),
    ) {
        Ok(path) => path,
        Err(error) => {
            fork_debug(format!(
                "native CLI fork did not create JSONL; source_session_id={} forked_session_id={} pid={} error={}",
                source_session_id,
                forked_session_id,
                pid,
                error
            ));
            if let Ok(mut processes) = claw_processes().lock() {
                if let Some(mut proc_state) = processes.remove(&process_key(&root, &forked_session_id)) {
                    match proc_state.child.try_wait() {
                        Ok(Some(status)) => {
                            fork_debug(format!(
                                "fork child already exited before cleanup; forked_session_id={} pid={} status={} code={:?} success={}",
                                forked_session_id,
                                pid,
                                status,
                                status.code(),
                                status.success()
                            ));
                        }
                        Ok(None) => {
                            fork_debug(format!(
                                "fork child still running after JSONL wait timeout; killing; forked_session_id={} pid={}",
                                forked_session_id,
                                pid
                            ));
                            let _ = proc_state.child.kill();
                            match proc_state.child.wait() {
                                Ok(status) => fork_debug(format!(
                                    "fork child exited after kill; forked_session_id={} pid={} status={} code={:?} success={}",
                                    forked_session_id,
                                    pid,
                                    status,
                                    status.code(),
                                    status.success()
                                )),
                                Err(wait_error) => fork_debug(format!(
                                    "fork child wait after kill failed; forked_session_id={} pid={} error={}",
                                    forked_session_id,
                                    pid,
                                    wait_error
                                )),
                            }
                        }
                        Err(wait_error) => {
                            fork_debug(format!(
                                "fork child try_wait failed during cleanup; forked_session_id={} pid={} error={}",
                                forked_session_id,
                                pid,
                                wait_error
                            ));
                            let _ = proc_state.child.kill();
                            let _ = proc_state.child.wait();
                        }
                    }
                }
            }
            emit_process_status(&app, &root, &forked_session_id, false, Some(pid), "fork_start_timeout");
            return Err(error);
        }
    };

    fork_debug(format!(
        "native CLI fork ready; source_session_id={} forked_session_id={} pid={} jsonl_path={}",
        source_session_id,
        forked_session_id,
        pid,
        forked_jsonl_path.display()
    ));

    let _ = app.emit(
        "agent-repl-event",
        json!({
            "sessionId": forked_session_id.clone(),
            "root": root.clone(),
            "eventType": "fork_created",
            "payload": {
                "sourceSessionId": source_session_id.clone(),
                "checkpointUuid": checkpoint_uuid.clone(),
                "pid": pid,
                "model": model.clone(),
            }
        }),
    );

    emit_process_status(&app, &root, &forked_session_id, true, Some(pid), "forked");

    Ok(AgentReplProcessState {
        session_id: forked_session_id,
        root,
        model,
        permission_mode: permission_mode.clone()
})
}

#[tauri::command]
fn kill_agent_repl_process(
    root: String,
    session_id: String,
) -> Result<AgentReplProcessStatus, String> {
    let key = process_key(&root, &session_id);
    let mut processes = claw_processes().lock().map_err(error_to_string)?;

    let Some(mut proc_state) = processes.remove(&key) else {
        return Ok(AgentReplProcessStatus {
            root,
            session_id,
            running: false,
            pid: None
});
    };

    let pid = proc_state.pid;
    let _ = proc_state.child.kill();
    let _ = proc_state.child.wait();

    Ok(AgentReplProcessStatus {
        root,
        session_id,
        running: false,
        pid: Some(pid)
})
}

#[tauri::command]
fn send_agent_repl_input(
    root: String,
    session_id: String,
    input: String,
) -> Result<AgentReplSendResult, String> {
    let key = process_key(&root, &session_id);
    let mut processes = claw_processes().lock().map_err(error_to_string)?;
    let proc_state = processes
        .get_mut(&key)
        .ok_or_else(|| "REPL process is not running".to_string())?;

    let message = json!({
        "type": "user",
        "session_id": session_id,
        "message": {
            "role": "user",
            "content": input
        },
        "parent_tool_use_id": null
    });

    let line = serde_json::to_string(&message).map_err(error_to_string)?;
    writeln!(proc_state.stdin, "{}", line).map_err(error_to_string)?;
    proc_state.stdin.flush().map_err(error_to_string)?;

    Ok(AgentReplSendResult { accepted: true })
}

#[tauri::command]
fn get_agent_repl_capabilities(
    root: String,
    session_id: String,
) -> Result<AgentReplCapabilities, String> {
    let request_id = format!("agent-ui-capabilities-{}", now_millis());
    let request = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "get_capabilities"
        }
    });

    {
        let registry = control_responses();
        let mut responses = registry.responses.lock().map_err(error_to_string)?;
        responses.remove(&request_id);
    }

    let line = serde_json::to_string(&request).map_err(error_to_string)?;
    let key = process_key(&root, &session_id);

    {
        let mut processes = claw_processes().lock().map_err(error_to_string)?;
        let proc_state = processes
            .get_mut(&key)
            .ok_or_else(|| "REPL process is not running".to_string())?;

        writeln!(proc_state.stdin, "{line}").map_err(error_to_string)?;
        proc_state.stdin.flush().map_err(error_to_string)?;
    }

    let response = wait_for_control_response(&request_id, Duration::from_secs(5))?;
    capabilities_from_control_response(&root, &session_id, &response)
}


#[tauri::command]
fn get_agent_context_usage(
    root: String,
    session_id: String,
) -> Result<AgentContextUsage, String> {
    let request_id = format!("agent-ui-context-{}", now_millis());
    let request = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "get_context_usage"
        }
    });

    {
        let registry = control_responses();
        let mut responses = registry.responses.lock().map_err(error_to_string)?;
        responses.remove(&request_id);
    }

    let line = serde_json::to_string(&request).map_err(error_to_string)?;
    let key = process_key(&root, &session_id);

    {
        let mut processes = claw_processes().lock().map_err(error_to_string)?;
        let proc_state = processes
            .get_mut(&key)
            .ok_or_else(|| "REPL process is not running".to_string())?;

        writeln!(proc_state.stdin, "{line}").map_err(error_to_string)?;
        proc_state.stdin.flush().map_err(error_to_string)?;
    }

    let response = wait_for_control_response(&request_id, Duration::from_secs(5))?;
    context_usage_from_control_response(&root, &session_id, &response)
}

#[tauri::command]
fn run_agent_turn(
    root: String,
    session_id: String,
    prompt: String,
) -> Result<AgentTurnResponse, String> {
    let root_path = canonical_workspace_root(&root)?;
    let repo = repo_root()?;
    let settings = load_model_settings().unwrap_or_else(|_| default_model_settings());
    let config = active_model_config(&settings).ok().cloned();

    let mut cmd = Command::new("bun");
    cmd.arg("run")
        .arg(repo.join("src/entrypoints/cli.tsx"))
        .arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("json")
        .current_dir(&root_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    apply_agent_ui_env(&mut cmd, &root_path, &session_id)?;

    if let Some(config) = config.as_ref() {
        apply_model_env(&mut cmd, config);
        let model = resolve_model_for_provider(config);
        if model != "default" {
            cmd.arg("--model").arg(model);
        }
    }

    let output = cmd.output().map_err(error_to_string)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let raw_json = serde_json::from_str::<serde_json::Value>(&stdout).ok();

    let message = raw_json
        .as_ref()
        .and_then(|v| v.get("result"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            raw_json
                .as_ref()
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if stdout.trim().is_empty() {
                stderr.clone()
            } else {
                stdout.clone()
            }
        });

    Ok(AgentTurnResponse {
        ok: output.status.success(),
        message,
        requires_confirmation: false,
        permission_prompt: None,
        model: config.as_ref().map(resolve_model_for_provider),
        iterations: None,
        tool_uses: vec![],
        tool_results: vec![],
        usage: raw_json.as_ref().and_then(|v| v.get("usage")).cloned(),
        estimated_cost: raw_json
            .as_ref()
            .and_then(|v| v.get("total_cost_usd").or_else(|| v.get("cost_usd")))
            .map(|v| v.to_string()),
        raw_json,
        stderr: if stderr.trim().is_empty() {
            None
        } else {
            Some(stderr)
        }
})
}

fn spawn_repl_stdout_reader(
    app: tauri::AppHandle,
    shared_session: Arc<Mutex<String>>,
    root: String,
    stdout: ChildStdout,
    ignored_rekey_session_ids: Vec<String>,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut current_message_id_by_session: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        let mut saw_text = false;

        for line in reader.lines() {
            let mut event_session_id = shared_session_id(&shared_session);
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    fork_debug(format!(
                        "stdout reader error; session_id={} error={}",
                        event_session_id,
                        error
                    ));
                    let _ = app.emit(
                        "agent-repl-event",
                        json!({
                            "sessionId": event_session_id,
                            "root": root,
                            "eventType": "error",
                            "payload": {
                                "text": error.to_string()
                            }
                        }),
                    );
                    break;
                }
            };

            if line.trim().is_empty() {
                continue;
            }

            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => {
                    fork_debug(format!(
                        "stdout non-json line; session_id={} error={} line={}",
                        event_session_id,
                        error,
                        truncate_for_log(&line, 1600)
                    ));
                    let _ = app.emit(
                        "agent-repl-event",
                        json!({
                            "sessionId": event_session_id,
                            "root": root,
                            "eventType": "stderr",
                            "payload": {
                                "text": line
                            }
                        }),
                    );
                    continue;
                }
            };

            let parsed_event_type = value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("<missing>")
                .to_string();
            let parsed_session_id = stream_value_session_id(&value);
            if parsed_event_type == "control_response"
                || parsed_event_type == "control_request"
                || parsed_session_id
                    .as_deref()
                    .map(|session_id| session_id != event_session_id)
                    .unwrap_or(false)
            {
                fork_debug(format!(
                    "stdout event; current_session_id={} {}",
                    event_session_id,
                    value_summary_for_log(&value)
                ));
            }

            remember_control_response(&value);

            if let Some(real_session_id) = parsed_session_id.as_deref() {
                if real_session_id != event_session_id
                    && ignored_rekey_session_ids
                        .iter()
                        .any(|ignored| ignored.trim() == real_session_id)
                {
                    fork_debug(format!(
                        "stdout ignored session id change because candidate is excluded; current_session_id={} ignored_session_id={} ignored_rekey_session_ids={:?}",
                        event_session_id,
                        real_session_id,
                        ignored_rekey_session_ids
                    ));
                    continue;
                }
            }

            if let Some(real_session_id) = parsed_session_id {
                mark_session_ready(&root, &real_session_id);
                if real_session_id != event_session_id {
                    fork_debug(format!(
                        "stdout session id changed; previous_session_id={} real_session_id={}",
                        event_session_id,
                        real_session_id
                    ));
                    remember_fork_session_hint(&root, &event_session_id, &real_session_id);
                    let process_pid = if event_session_id.trim().is_empty() {
                        None
                    } else {
                        rekey_process_session(&root, &event_session_id, &real_session_id)
                    };
                    set_shared_session_id(&shared_session, &real_session_id);
                    event_session_id = real_session_id.clone();
                    fork_debug(format!(
                        "stdout rekey result; real_session_id={} process_pid={:?}",
                        real_session_id,
                        process_pid
                    ));
                    if process_pid.is_some() {
                        emit_process_status(
                            &app,
                            &root,
                            &real_session_id,
                            true,
                            process_pid,
                            "rekeyed",
                        );
                    }
                }
            }

            let _ = app.emit(
                "agent-repl-event",
                json!({
                    "sessionId": event_session_id,
                    "root": root,
                    "eventType": "raw_json",
                    "payload": {
                        "raw_json": value.clone()
                    }
                }),
            );

            match value.get("type").and_then(|v| v.as_str()) {
                Some("system") => {
                    let subtype = value.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                    let event_type = if subtype == "init" {
                        "startup"
                    } else {
                        "system"
                    };
                    let _ = app.emit(
                        "agent-repl-event",
                        json!({
                            "sessionId": event_session_id,
                            "root": root,
                            "eventType": event_type,
                            "payload": value
                        }),
                    );
                }
                Some("assistant") => {
                    let assistant_message_id = value
                        .get("message")
                        .and_then(|message| message.get("id"))
                        .and_then(|id| id.as_str())
                        .map(|id| id.to_string());

                    if let Some(assistant_message_id) = assistant_message_id.as_deref() {
                        current_message_id_by_session
                            .insert(event_session_id.clone(), assistant_message_id.to_string());
                        eprintln!(
                            "[usage] current assistant_message_id set session_id={} assistant_message_id={}",
                            event_session_id,
                            assistant_message_id
                        );
                    } else {
                        eprintln!(
                            "[usage][warn] assistant event missing raw_json.message.id session_id={}",
                            event_session_id
                        );
                    }

                    for tool in extract_tool_uses(&value) {
                        let _ = app.emit(
                            "agent-repl-event",
                            json!({
                                "sessionId": event_session_id,
                                "root": root,
                                "eventType": "tool_call",
                                "payload": {
                                    "tool": tool,
                                    "raw_json": value
                                }
                            }),
                        );
                    }

                    let text = extract_assistant_text(&value);
                    if !text.trim().is_empty() {
                        saw_text = true;
                        let assistant_message_id_for_emit =
                            assistant_message_id.map(|id| id.to_string());
                        let assistant_bind_status_for_emit =
                            if assistant_message_id_for_emit.is_some() {
                                "ok"
                            } else {
                                "missing_assistant_message_id"
                            };
                        let _ = app.emit(
                            "agent-repl-event",
                            json!({
                                "sessionId": event_session_id,
                                "root": root,
                                "eventType": "turn_text",
                                "bindStatus": assistant_bind_status_for_emit,
                                "payload": {
                                    "text": text,
                                    "raw_json": value
                                }
                            }),
                        );
                    }
                }
                Some("result") => {
                    let result_text = value
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    let real_session_id = stream_value_session_id(&value);

                    let mut process_pid = None;
                    if let Some(real_session_id) = real_session_id.as_deref() {
                        mark_session_ready(&root, real_session_id);
                        if real_session_id != event_session_id {
                            process_pid =
                                rekey_process_session(&root, &event_session_id, real_session_id);
                            set_shared_session_id(&shared_session, real_session_id);
                            emit_process_status(
                                &app,
                                &root,
                                real_session_id,
                                true,
                                process_pid,
                                "rekeyed",
                            );
                        }
                    }

                    let usage_binding_session_id = real_session_id
                        .as_deref()
                        .unwrap_or(event_session_id.as_str())
                        .to_string();

                    if usage_binding_session_id != event_session_id {
                        if let Some(current_message_id) = current_message_id_by_session
                            .get(&event_session_id)
                            .cloned()
                        {
                            current_message_id_by_session
                                .insert(usage_binding_session_id.clone(), current_message_id);
                        }
                    }

                    if let Some(current_message_id) =
                        current_message_id_by_session.get(&usage_binding_session_id)
                    {
                        eprintln!(
                            "[usage] turn_complete bound session_id={} assistant_message_id={}",
                            usage_binding_session_id, current_message_id
                        );
                    } else {
                        eprintln!(
                            "[usage][warn] turn_complete missing current assistant_message_id session_id={} event_session_id={}",
                            usage_binding_session_id,
                            event_session_id
                        );
                    }

                    let usage_bound_assistant_message_id = current_message_id_by_session
                        .get(&usage_binding_session_id)
                        .map(|message_id| message_id.as_str());

                    let usage_bound_assistant_message_id_for_emit =
                        usage_bound_assistant_message_id.map(|id| id.to_string());
                    let usage_bind_status_for_emit =
                        if usage_bound_assistant_message_id_for_emit.is_some() {
                            "ok"
                        } else {
                            "missing_assistant_message_id"
                        };

                    let _ = app.emit("agent-repl-event", json!({
                        "sessionId": event_session_id,
                        "root": root,
                        "eventType": "turn_complete",
                        "bindStatus": usage_bind_status_for_emit,
                        "payload": {
                            "ok": value.get("is_error").and_then(|v| v.as_bool()).map(|v| !v).unwrap_or(true),
                            "text": result_text,
                            "realSessionId": real_session_id,
                            "pid": process_pid,
                            "raw_json": value
                        }
                    }));

                    saw_text = false;
                }
                Some("control_request") => {
                    let request = value.get("request").cloned().unwrap_or_else(|| json!({}));
                    let request_id = value
                        .get("request_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let subtype = request
                        .get("subtype")
                        .and_then(|v| v.as_str())
                        .unwrap_or("permission")
                        .to_string();
                    let tool_name = request
                        .get("tool_name")
                        .or_else(|| request.get("toolName"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
                    let prompt = format!("{} requests permission to use {}", subtype, tool_name);

                    let _ = app.emit(
                        "agent-repl-event",
                        json!({
                            "sessionId": event_session_id,
                            "root": root,
                            "eventType": "permission_request",
                            "payload": {
                                "requestId": request_id,
                                "subtype": subtype,
                                "toolName": tool_name,
                                "input": input,
                                "prompt": prompt,
                                "raw_json": value
                            }
                        }),
                    );
                }
                Some("streamlined_text") => {
                    let text = value.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if !text.is_empty() {
                        saw_text = true;
                        let assistant_message_id_for_emit = value
                            .get("message")
                            .and_then(|message| message.get("id"))
                            .and_then(|id| id.as_str())
                            .map(|id| id.to_string());
                        let assistant_bind_status_for_emit =
                            if assistant_message_id_for_emit.is_some() {
                                "ok"
                            } else {
                                "missing_assistant_message_id"
                            };
                        let _ = app.emit(
                            "agent-repl-event",
                            json!({
                                "sessionId": event_session_id,
                                "root": root,
                                "eventType": "turn_text",
                                "bindStatus": assistant_bind_status_for_emit,
                                "payload": {
                                    "text": text,
                                    "raw_json": value
                                }
                            }),
                        );
                    }
                }
                _ => {
                    let _ = app.emit(
                        "agent-repl-event",
                        json!({
                            "sessionId": event_session_id,
                            "root": root,
                            "eventType": "raw",
                            "payload": value
                        }),
                    );
                }
            }
        }

        let final_session_id = shared_session_id(&shared_session);
        fork_debug(format!(
            "stdout reader ended; final_session_id={} root={}",
            final_session_id,
            root
        ));
        remove_process_session(&root, &final_session_id);
        let _ = app.emit(
            "agent-repl-event",
            json!({
                "sessionId": final_session_id,
                "root": root,
                "eventType": "process_exit",
                "payload": {
                    "running": false,
                    "reason": "stdout_closed"
                }
            }),
        );
        emit_process_status(&app, &root, &final_session_id, false, None, "stdout_closed");
    });
}

fn spawn_repl_stderr_reader(
    app: tauri::AppHandle,
    shared_session: Arc<Mutex<String>>,
    root: String,
    stderr: std::process::ChildStderr,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if line.trim().is_empty() {
                continue;
            }
            let event_session_id = shared_session_id(&shared_session);
            fork_debug(format!(
                "stderr line; session_id={} line={}",
                event_session_id,
                truncate_for_log(&line, 1600)
            ));
            let _ = app.emit(
                "agent-repl-event",
                json!({
                    "sessionId": event_session_id,
                    "root": root,
                    "eventType": "stderr",
                    "payload": {
                        "text": line
                    }
                }),
            );
        }
        let final_session_id = shared_session_id(&shared_session);
        fork_debug(format!(
            "stderr reader ended; final_session_id={} root={}",
            final_session_id,
            root
        ));
    });
}

fn collect_text_blocks(value: &serde_json::Value, parts: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            if !text.trim().is_empty() {
                parts.push(text.clone());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_text_blocks(item, parts);
            }
        }
        serde_json::Value::Object(_) => {
            let block_type = value.get("type").and_then(|v| v.as_str());
            if matches!(block_type, Some("text") | Some("output_text")) {
                if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
                    if !text.trim().is_empty() {
                        parts.push(text.to_string());
                    }
                }
                return;
            }

            for key in ["content", "text", "result", "output_text", "delta"] {
                if let Some(child) = value.get(key) {
                    collect_text_blocks(child, parts);
                }
            }
        }
        _ => {}
    }
}

fn extract_assistant_text(value: &serde_json::Value) -> String {
    let mut parts = Vec::new();

    if let Some(message_content) = value.get("message").and_then(|m| m.get("content")) {
        collect_text_blocks(message_content, &mut parts);
    }

    if parts.is_empty() {
        for key in ["content", "text", "result", "output_text", "delta"] {
            if let Some(child) = value.get(key) {
                collect_text_blocks(child, &mut parts);
            }
        }
    }

    parts.join("")
}

fn extract_tool_uses(value: &serde_json::Value) -> Vec<serde_json::Value> {
    let mut tools = Vec::new();

    if let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                tools.push(block.clone());
            }
        }
    }

    tools
}

fn workspace_state_from_path(path: &Path) -> Result<WorkspaceState, String> {
    let canonical = path.canonicalize().map_err(error_to_string)?;

    if !canonical.is_dir() {
        return Err("workspace path is not a directory".to_string());
    }

    Ok(WorkspaceState {
        root: canonical.to_string_lossy().to_string(),
        name: canonical
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
})
}

fn default_model_settings() -> ModelSettings {
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
                enabled: true
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
                enabled: true
}
],
        deepseek_pricing: None
}
}

fn refresh_deepseek_pricing_on_startup() -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(error_to_string)?;
    let candidates = [
        cwd.join("scripts/fetch-deepseek-pricing.mjs"),
        cwd.join("../scripts/fetch-deepseek-pricing.mjs"),
        cwd.join("../../scripts/fetch-deepseek-pricing.mjs")
];
    let script = candidates
        .iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| "scripts/fetch-deepseek-pricing.mjs not found".to_string())?;

    let output = Command::new("node")
        .arg(script)
        .arg("--write")
        .output()
        .map_err(error_to_string)?;

    if output.status.success() {
        eprintln!("[deepseek-pricing] refreshed on startup");
        eprintln!(
            "[usage-v2-read] enabled={}",
            true
        );
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn normalize_model_settings(settings: &mut ModelSettings) -> Result<(), String> {
    if settings.models.is_empty() {
        return Err("至少需要一个模型配置".to_string());
    }

    if !settings
        .models
        .iter()
        .any(|m| m.id == settings.active_model_id)
    {
        settings.active_model_id = settings.models[0].id.clone();
    }

    Ok(())
}

fn active_model_config(settings: &ModelSettings) -> Result<&ModelEndpointConfig, String> {
    settings
        .models
        .iter()
        .find(|m| m.id == settings.active_model_id && m.enabled)
        .or_else(|| settings.models.iter().find(|m| m.enabled))
        .ok_or_else(|| "没有启用的模型配置".to_string())
}

fn resolve_model_for_provider(config: &ModelEndpointConfig) -> String {
    config
        .model
        .clone()
        .unwrap_or_else(|| match config.provider {
            ModelProvider::DeepSeek => "deepseek-chat".to_string(),
            ModelProvider::OpenAI => "gpt-4o".to_string(),
            ModelProvider::Anthropic => "claude-sonnet-4-5-20250929".to_string()
})
}

fn apply_agent_ui_env(
    command: &mut Command,
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

    fs::create_dir_all(&output_dir).map_err(error_to_string)?;

    command.env("AGENT_UI_SESSION_ID", effective_session_id);
    command.env(
        "AGENT_UI_OUTPUT_DIR",
        output_dir.to_string_lossy().to_string(),
    );

    if let Ok(mcp_config_path) = astromere_mcp_config_path() {
        command.env(
            "ASTROMERE_MCP_CONFIG",
            mcp_config_path.to_string_lossy().to_string(),
        );
    }

    if let Ok(home) = std::env::var("HOME") {
        let helper_bin = PathBuf::from(home).join(".agent-ui").join("bin");
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

    Ok(())
}

fn apply_model_env(command: &mut Command, config: &ModelEndpointConfig) {
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

fn model_settings_path() -> Result<PathBuf, String> {
    Ok(ui_config_dir()?.join("model-settings.json"))
}

fn workspace_registry_path() -> Result<PathBuf, String> {
    Ok(ui_config_dir()?.join("workspace-registry.json"))
}

fn read_workspace_registry() -> Result<WorkspaceRegistry, String> {
    let path = workspace_registry_path()?;

    if !path.exists() {
        return Ok(WorkspaceRegistry::default());
    }

    let content = fs::read_to_string(path).map_err(error_to_string)?;
    serde_json::from_str(&content).map_err(error_to_string)
}

fn write_workspace_registry(registry: &WorkspaceRegistry) -> Result<(), String> {
    let path = workspace_registry_path()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(error_to_string)?;
    }

    fs::write(
        path,
        serde_json::to_string_pretty(registry).map_err(error_to_string)?,
    )
    .map_err(error_to_string)
}

fn ui_config_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME 环境变量不存在".to_string())?;
    Ok(PathBuf::from(home).join(".claw-agent-ui"))
}

fn claude_config_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME 环境变量不存在".to_string())?;
    Ok(PathBuf::from(home).join(".claude"))
}

fn sanitize_claude_project_path(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn claude_project_sessions_dir(root: &Path) -> Result<PathBuf, String> {
    Ok(claude_config_dir()?
        .join("projects")
        .join(sanitize_claude_project_path(root)))
}

fn canonical_workspace_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root).canonicalize().map_err(error_to_string)?;

    if !path.is_dir() {
        return Err("workspace root is not a directory".to_string());
    }

    Ok(path)
}

fn resolve_workspace_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let resolved = root.join(path).canonicalize().map_err(error_to_string)?;

    if !resolved.starts_with(root) {
        return Err("path escapes workspace root".to_string());
    }

    Ok(resolved)
}

fn resolve_workspace_path_allow_missing(root: &Path, path: &str) -> Result<PathBuf, String> {
    let joined = root.join(path);
    let parent = joined.parent().ok_or_else(|| "invalid path".to_string())?;
    let parent_canonical = parent.canonicalize().map_err(error_to_string)?;

    if !parent_canonical.starts_with(root) {
        return Err("path escapes workspace root".to_string());
    }

    Ok(joined)
}

fn normalize_reference_path_input(path: &str) -> String {
    path.trim()
        .trim_matches('`')
        .trim_matches('"')
        .trim_matches('\'')
        .replace('～', "~")
}

fn resolve_local_reference_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let normalized = normalize_reference_path_input(path);
    if normalized.is_empty() {
        return Err("empty preview path".to_string());
    }

    let expanded = if normalized == "~" || normalized.starts_with("~/") {
        let home = std::env::var("HOME").map_err(|_| "HOME 环境变量不存在".to_string())?;
        if normalized == "~" {
            PathBuf::from(home)
        } else {
            PathBuf::from(home).join(normalized.trim_start_matches("~/"))
        }
    } else {
        let candidate = PathBuf::from(&normalized);
        if candidate.is_absolute() {
            candidate
        } else {
            root.join(candidate)
        }
    };

    expanded.canonicalize().map_err(error_to_string)
}

fn image_mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream"
}
}

fn is_supported_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
    )
}

fn normalize_permission_mode(value: &str) -> Result<&'static str, String> {
    match value {
        "default" => Ok("default"),
        "acceptEdits" => Ok("acceptEdits"),
        "bypassPermissions" => Ok("bypassPermissions"),
        "dontAsk" => Ok("dontAsk"),
        "plan" => Ok("plan"),
        _ => Err(format!("invalid permission mode: {value}"))
}
}

fn available_permission_modes() -> Vec<String> {
    vec![
        "default".to_string(),
        "acceptEdits".to_string(),
        "bypassPermissions".to_string(),
        "dontAsk".to_string(),
        "plan".to_string()
]
}

fn repo_root() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "cannot resolve repo root".to_string())
}

fn is_subagent_transcript_path(path: &Path) -> bool {
    let under_subagents = path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|name| name == "subagents")
            .unwrap_or(false)
    });

    if under_subagents {
        return true;
    }

    path.file_name()
        .and_then(|s| s.to_str())
        .map(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
        .unwrap_or(false)
}

fn collect_session_files(dir: &Path, out: &mut Vec<RuntimeSessionSummary>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(error_to_string)? {
        let entry = entry.map_err(error_to_string)?;
        let path = entry.path();

        if path.is_dir() {
            if path.file_name().and_then(|s| s.to_str()) == Some("subagents") {
                continue;
            }

            collect_session_files(&path, out)?;
            continue;
        }

        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }

        if is_subagent_transcript_path(&path) {
            continue;
        }
        let metadata = fs::metadata(&path).map_err(error_to_string)?;
        let modified = metadata.modified().unwrap_or(SystemTime::now());
        let modified_ms = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let content = fs::read_to_string(&path).unwrap_or_default();
        let message_count = content.lines().filter(|l| !l.trim().is_empty()).count();
        let id = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        out.push(RuntimeSessionSummary {
            id: id.clone(),
            title: first_user_title_from_jsonl(&content)
                .unwrap_or_else(|| session_title(&id, message_count)),
            path: path.to_string_lossy().to_string(),
            updated_at_ms: modified_ms as u64,
            modified_epoch_millis: modified_ms,
            message_count,
            parent_session_id: None,
            branch_name: None
});
    }

    Ok(())
}

fn first_user_title_from_jsonl(content: &str) -> Option<String> {
    for line in content.lines() {
        let value = serde_json::from_str::<serde_json::Value>(line).ok()?;

        if value
            .get("isMeta")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }

        let role = value
            .get("message")
            .and_then(|m| m.get("role"))
            .or_else(|| value.get("role"))
            .and_then(|v| v.as_str());

        let event_type = value.get("type").and_then(|v| v.as_str());

        if role != Some("user") && event_type != Some("user") {
            continue;
        }

        let content_value = value
            .get("message")
            .and_then(|m| m.get("content"))
            .or_else(|| value.get("content"))
            .or_else(|| value.get("text"));

        let title = content_value
            .map(extract_text_from_json_value)
            .unwrap_or_default()
            .trim()
            .replace('\n', " ");

        if title.is_empty() {
            continue;
        }

        if !looks_like_real_user_title(&title) {
            continue;
        }

        return Some(truncate_title(&title, 80));
    }

    None
}

fn looks_like_real_user_title(title: &str) -> bool {
    let trimmed = title.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') || trimmed.starts_with("[Request interrupted")
    {
        return false;
    }

    let lower = trimmed.to_lowercase();
    let skipped_prefixes = [
        "<system-reminder",
        "tool_result",
        "tool result",
        "system:",
        "context:",
        "cwd:",
        "this session is being continued",
        "we need continue",
        "here is a summary",
        "automatic context",
        "auto context"
];

    !skipped_prefixes
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

fn extract_text_from_json_value(value: &serde_json::Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }

    if let Some(items) = value.as_array() {
        let mut parts = Vec::new();

        for item in items {
            let item_type = item.get("type").and_then(|v| v.as_str());

            if item_type == Some("text") {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    parts.push(text.to_string());
                }
            } else if item_type.is_none() {
                let text = extract_text_from_json_value(item);
                if !text.trim().is_empty() {
                    parts.push(text);
                }
            }
        }

        return parts.join(" ");
    }

    String::new()
}

fn truncate_title(value: &str, max_chars: usize) -> String {
    let mut result = String::new();

    for ch in value.chars().take(max_chars) {
        result.push(ch);
    }

    if value.chars().count() > max_chars {
        result.push('…');
    }

    result
}

fn json_value_contains_type(value: &serde_json::Value, expected_type: &str) -> bool {
    if value.get("type").and_then(|v| v.as_str()) == Some(expected_type) {
        return true;
    }

    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .any(|item| json_value_contains_type(item, expected_type)),
        serde_json::Value::Object(map) => map
            .values()
            .any(|item| json_value_contains_type(item, expected_type)),
        _ => false
}
}

fn canonical_message_id_from_raw_json(value: &serde_json::Value) -> Option<&str> {
    value
        .get("message")
        .and_then(|message| message.get("id"))
        .and_then(|id| id.as_str())
        .filter(|id| !id.trim().is_empty())
}

fn parse_jsonl_messages(content: &str) -> Vec<serde_json::Value> {
    content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let value = serde_json::from_str::<serde_json::Value>(line).ok()?;

            if value
                .get("isMeta")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                return None;
            }

            let event_type = value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("system")
                .to_string();
            let role = value
                .get("message")
                .and_then(|m| m.get("role"))
                .or_else(|| value.get("role"))
                .or_else(|| value.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("system");

            let has_tool_result_content = json_value_contains_type(&value, "tool_result");
            let normalized_role = if event_type == "tool_result" || has_tool_result_content {
                "tool"
            } else {
                match role {
                    "assistant" => "assistant",
                    "result" => "assistant",
                    "user" => "user",
                    "tool" | "tool_result" => "tool",
                    _ => "system"
}
            };

            let content_value = value
                .get("message")
                .and_then(|m| m.get("content"))
                .or_else(|| value.get("content"))
                .or_else(|| value.get("text"))
                .or_else(|| value.get("result"));

            let text = content_value
                .map(extract_text_from_json_value)
                .unwrap_or_default()
                .trim()
                .to_string();

            let has_tool_use = extract_tool_uses(&value).len() > 0;
            let keep_for_debug = has_tool_use
                || matches!(
                    event_type.as_str(),
                    "assistant" | "result" | "tool_result" | "user"
                )
                || normalized_role == "tool";

            if text.is_empty() && !keep_for_debug {
                return None;
            }

            let message_id = canonical_message_id_from_raw_json(&value);
            let bind_status = if message_id.is_some() {
                "ok"
            } else {
                eprintln!(
                    "[runtime][warn] jsonl history message missing raw_json.message.id index={} event_type={} role={}",
                    index, event_type, normalized_role
                );
                "missing_message_id"
            };

            let uuid = value
                .get("uuid")
                .and_then(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .map(|v| v.to_string());
            let parent_uuid = value
                .get("parentUuid")
                .or_else(|| value.get("parent_uuid"))
                .and_then(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .map(|v| v.to_string());

            Some(json!({
                "id": message_id
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| format!("missing-message-id-{index}")),
                "uuid": uuid,
                "parentUuid": parent_uuid,
                "role": normalized_role,
                "text": text,
                "event_type": event_type,
                "bind_status": bind_status,
                "raw_json": value
            }))
        })
        .collect()
}

fn language_for_path(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
    {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "json" => "json",
        "md" => "markdown",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "html" => "html",
        "css" => "css",
        other => other
}
    .to_string()
}

fn session_title(session_id: &str, message_count: usize) -> String {
    if message_count == 0 {
        "New session".to_string()
    } else {
        format!("{session_id} ({message_count} messages)")
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn error_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            thread::spawn(|| {
                if let Err(error) = refresh_deepseek_pricing_on_startup() {
                    eprintln!("[deepseek-pricing] refresh failed: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sqlite_query,
            sqlite_execute,
            sqlite_database_info,
            default_workspace,
            open_workspace,
            load_workspace_registry,
            load_deepseek_pricing,
            add_workspace_registry_entry,
            remove_workspace_registry_entry,
            list_project_entries,
            search_workspace_files,
            list_skills,
            install_skill,
            read_workspace_file,
            read_local_image_metadata,
            read_local_image_preview,
            read_local_reference_file,
            write_workspace_file,
            edit_workspace_file,
            glob_runtime_search,
            grep_runtime_search,
            execute_runtime_bash,
            list_runtime_sessions,
            load_runtime_session,
            create_runtime_session,
            read_git_diff,
            load_model_settings,
            save_model_settings,
            load_mcp_settings,
            save_mcp_settings,
            test_model_connection,
            get_agent_permission_state,
            interrupt_agent_turn,
            get_agent_repl_process_status,
            kill_agent_repl_process,
            respond_agent_permission,
            set_agent_permission_mode,
            ensure_agent_repl_process,
            fork_agent_repl_process,
            get_agent_repl_capabilities,
            get_agent_context_usage,
            send_agent_repl_input,
            run_agent_turn,
                    save_bundle_usage_snapshot,
            load_bundle_usage_snapshot,
            load_bundle_usage_snapshots_for_session,
])
        .run(tauri::generate_context!())
        .expect("failed to run Claw Agent UI");
}
