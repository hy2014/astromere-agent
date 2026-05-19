import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentPermissionState,
  AgentReplProcessState,
  AgentReplProcessStatus,
  AgentReplSendResult,
  AgentReplStreamEvent,
  AgentTurnResponse,
  BashRuntimeRequest,
  FileView,
  LocalImagePreview,
  LocalImageMetadata,
  GitDiff,
  GrepRuntimeRequest,
  ModelConnectionTestResult,
  McpSettings,
  McpSettingsFile,
  ModelSettings,
  PermissionMode,
  ProjectEntry,
  RuntimeSessionDetail,
  RuntimeSessionSummary,
  SkillsReport,
  WorkspaceFileReference,
  WorkspaceState,
  WorkspaceRegistry,
  SqliteDatabaseInfo,
  SqliteExecuteResult,
  SqliteQueryRow,
  SqliteValue,
} from "./types";

export type AgentReplCapabilityItem = {
  name: string;
  slash: string;
  kind: "command" | "skill" | string;
  description?: string | null;
};

export type AgentReplCapabilities = {
  root: string;
  sessionId: string;
  commands: AgentReplCapabilityItem[];
  skills: AgentReplCapabilityItem[];
  slashCommands: AgentReplCapabilityItem[];
  updatedAtMs: number;
};

export function getDefaultWorkspace(): Promise<WorkspaceState> {
  return invoke("default_workspace");
}

export function openWorkspace(path: string): Promise<WorkspaceState> {
  return invoke("open_workspace", { path });
}

export function loadWorkspaceRegistry(): Promise<WorkspaceRegistry> {
  return invoke("load_workspace_registry");
}

export function addWorkspaceRegistryEntry(path: string): Promise<WorkspaceRegistry> {
  return invoke("add_workspace_registry_entry", { path });
}

export function sqliteDatabaseInfo(): Promise<SqliteDatabaseInfo> {
  return invoke("sqlite_database_info");
}

export function listProjectEntries(root: string): Promise<ProjectEntry[]> {
  return invoke("list_project_entries", { root });
}

export function loadMcpSettings(): Promise<McpSettingsFile> {
  return invoke("load_mcp_settings");
}

export function saveMcpSettings(settings: McpSettings): Promise<McpSettingsFile> {
  return invoke("save_mcp_settings", { settings });
}

export function listSkills(root: string): Promise<SkillsReport> {
  return invoke("list_skills", { root });
}

export function installSkill(root: string, source: string): Promise<SkillsReport> {
  return invoke("install_skill", { root, source });
}

export function readWorkspaceFile(root: string, path: string): Promise<FileView> {
  return invoke("read_workspace_file", { root, path });
}

export function readLocalReferenceFile(root: string, path: string): Promise<FileView> {
  return invoke("read_local_reference_file", { root, path });
}

export function searchWorkspaceFiles(
  root: string,
  query: string,
  maxResults = 20,
): Promise<WorkspaceFileReference[]> {
  return invoke("search_workspace_files", { root, query, maxResults });
}

export function readLocalImagePreview(root: string, path: string): Promise<LocalImagePreview> {
  return invoke("read_local_image_preview", { root, path });
}

export function readLocalImageMetadata(root: string, path: string): Promise<LocalImageMetadata> {
  return invoke("read_local_image_metadata", { root, path });
}

export function writeWorkspaceFile(root: string, path: string, content: string): Promise<unknown> {
  return invoke("write_workspace_file", { root, path, content });
}

export function editWorkspaceFile(
  root: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<unknown> {
  return invoke("edit_workspace_file", { root, path, oldString, newString, replaceAll });
}

export function globRuntimeSearch(root: string, pattern: string, path?: string): Promise<unknown> {
  return invoke("glob_runtime_search", { root, pattern, path });
}

export function grepRuntimeSearch(root: string, request: GrepRuntimeRequest): Promise<unknown> {
  return invoke("grep_runtime_search", { root, request });
}

export function executeRuntimeBash(root: string, request: BashRuntimeRequest): Promise<unknown> {
  return invoke("execute_runtime_bash", { root, request });
}

export function listRuntimeSessions(root: string): Promise<RuntimeSessionSummary[]> {
  return invoke("list_runtime_sessions", { root });
}

export function createRuntimeSession(root: string): Promise<RuntimeSessionSummary> {
  return invoke("create_runtime_session", { root });
}

export function createForkRuntimeSession(
  root: string,
  sourceSessionId: string,
  checkpointUuid?: string,
): Promise<RuntimeSessionSummary> {
  return invoke("create_fork_runtime_session", {
    root,
    sourceSessionId,
    checkpointUuid,
  });
}

export function loadRuntimeSession(root: string, reference: string): Promise<unknown> {
  return invoke("load_runtime_session", { root, reference });
}

export function loadTypedRuntimeSession(root: string, reference: string): Promise<RuntimeSessionDetail> {
  return invoke("load_runtime_session", { root, reference });
}

export function readGitDiff(root: string, path?: string): Promise<GitDiff> {
  return invoke("read_git_diff", { root, path });
}

export function loadModelSettings(): Promise<ModelSettings> {
  return invoke("load_model_settings");
}

export function saveModelSettings(settings: ModelSettings): Promise<ModelSettings> {
  return invoke("save_model_settings", { settings });
}

export function testModelConnection(settings: ModelSettings): Promise<ModelConnectionTestResult> {
  return invoke("test_model_connection", { settings });
}

export function interruptAgentTurn(root: string, sessionId: string): Promise<boolean> {
  return invoke("interrupt_agent_turn", { root, sessionId });
}

export function getAgentReplProcessStatus(root: string, sessionId: string): Promise<AgentReplProcessStatus> {
  return invoke("get_agent_repl_process_status", { root, sessionId });
}

export function killAgentReplProcess(root: string, sessionId: string): Promise<AgentReplProcessStatus> {
  return invoke("kill_agent_repl_process", { root, sessionId });
}

export function getAgentPermissionState(): Promise<AgentPermissionState> {
  return invoke("get_agent_permission_state");
}

export function setAgentPermissionMode(root: string, mode: PermissionMode): Promise<AgentPermissionState> {
  return invoke("set_agent_permission_mode", { root, mode });
}

export function respondAgentPermission(
  root: string,
  sessionId: string,
  requestId: string,
  approved: boolean,
): Promise<AgentReplSendResult> {
  return invoke("respond_agent_permission", { root, sessionId, requestId, approved });
}

export function ensureAgentReplProcess(
  root: string,
  sessionId: string,
  modelOverride?: string,
  permissionMode?: PermissionMode,
): Promise<AgentReplProcessState> {
  return invoke("ensure_agent_repl_process", { root, sessionId, modelOverride, permissionMode });
}

export function forkAgentReplProcess(
  root: string,
  sourceSessionId: string,
  checkpointUuid: string,
  forkSessionId: string,
  modelOverride?: string,
  permissionMode?: PermissionMode,
): Promise<AgentReplProcessState> {
  return invoke("fork_agent_repl_process", {
    root,
    sourceSessionId,
    checkpointUuid,
    forkSessionId,
    modelOverride,
    permissionMode,
  });
}

export function getAgentReplCapabilities(
  root: string,
  sessionId: string,
): Promise<AgentReplCapabilities> {
  return invoke("get_agent_repl_capabilities", { root, sessionId });
}

export function sendAgentReplInput(
  root: string,
  sessionId: string,
  input: string,
): Promise<AgentReplSendResult> {
  return invoke("send_agent_repl_input", { root, sessionId, input });
}

export function listenAgentReplEvents(
  handler: (event: AgentReplStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentReplStreamEvent>("agent-repl-event", (event) => handler(event.payload));
}

export function runAgentTurn(
  root: string,
  sessionId: string,
  prompt: string,
): Promise<AgentTurnResponse> {
  return invoke("run_agent_turn", { root, sessionId, prompt });
}

export type BundleUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalInputTokens: number;
};

export type ModelCallUsageSnapshot = {
  modelCallId: string;
  model?: string | null;
  stopReason?: string | null;
  selectedReason: string;
  usage: Record<string, unknown>;
};

export type BundleUsageCost = {
  pricingMode?: string;
  currency?: string;
  unit?: string;
  costAmount?: number | null;
  costUsd?: number | null;
  reason?: string | null;
  pricedAtMs?: number;
  modelCosts?: unknown[];
};

export type BundleUsageSnapshot = {
  sessionId: string;
  bundleId: string;
  root: string;
  source: "stream" | "history_jsonl" | string;
  status: "streaming" | "complete" | "interrupted" | "error" | "process_exit" | "history" | string;
  startedAtMs?: number | null;
  completedAtMs?: number | null;
  updatedAtMs: number;
  modelCallIds: string[];
  modelCallUsages: ModelCallUsageSnapshot[];
  usage: BundleUsageTotals;
  cost?: BundleUsageCost | null;
};

export function saveBundleUsageSnapshot(snapshot: BundleUsageSnapshot): Promise<void> {
  return invoke("save_bundle_usage_snapshot", { snapshot });
}

export function loadBundleUsageSnapshot(
  sessionId: string,
  bundleId: string,
): Promise<BundleUsageSnapshot> {
  return invoke("load_bundle_usage_snapshot", { sessionId, bundleId });
}

export function loadBundleUsageSnapshotsForSession(
  sessionId: string,
): Promise<BundleUsageSnapshot[]> {
  return invoke("load_bundle_usage_snapshots_for_session", { sessionId });
}

export type UsageRecordRow = Record<string, unknown>;
export type UsageSummaryRow = Record<string, unknown>;
export type UsageAssistantSummaryRow = Record<string, unknown>;
export type UsageDaySplitRow = Record<string, unknown>;
export type UsageReadSource = "disabled" | string;

export function loadUsageReadSource(): Promise<UsageReadSource> {
  return Promise.resolve("disabled");
}

export function loadUsageRecords(_sessionId: string): Promise<UsageRecordRow[]> {
  return Promise.resolve([]);
}

export function loadUsageAssistantSummaries(
  _sessionId: string,
): Promise<UsageAssistantSummaryRow[]> {
  return Promise.resolve([]);
}

export function loadUsageSessionSummary(_sessionId: string): Promise<UsageSummaryRow[]> {
  return Promise.resolve([]);
}

export function loadUsageDaySplits(_sessionId: string): Promise<UsageDaySplitRow[]> {
  return Promise.resolve([]);
}
