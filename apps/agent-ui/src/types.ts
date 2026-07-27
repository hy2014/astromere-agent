export type WorkspaceState = {
  root: string;
  name: string;
};

export type WorkspaceRegistry = {
  workspaces: WorkspaceState[];
};

export type SqliteValue =
  | null
  | boolean
  | number
  | string
  | Record<string, unknown>
  | unknown[];

export type SqliteQueryRow = Record<string, unknown>;

export type SqliteDatabaseInfo = {
  path: string;
};

export type SqliteExecuteResult = {
  rowsAffected: number;
  lastInsertRowid: number;
  databasePath: string;
};

export type ProjectEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
};

export type SkillSourceKind =
  | "project"
  | "user"
  | "managed"
  | "plugin"
  | "mcp"
  | "bundled"
  | "remote";

export type SkillSummary = {
  id?: string;
  name: string;
  description?: string;
  whenToUse?: string;
  version?: string;
  path?: string;
  skillRoot?: string;
  source?: {
    kind?: SkillSourceKind;
    label?: string;
    path?: string;
  };
  origin?: {
    id?: string;
    label?: string;
  };
  enabled?: boolean;
  userInvocable?: boolean;
  modelInvocable?: boolean;
  context?: "inline" | "fork";
  agent?: string;
  model?: string;
  effort?: string;
  allowedTools?: string[];
  capabilities?: string[];
  paths?: string[];
  hooks?: string[];
  sizeBytes?: number;
  installedAtMs?: number;
  validation?: string[];
  shadowedBy?: unknown;
  shadowed_by?: unknown;
};

export type SkillSourceSummary = {
  kind: SkillSourceKind;
  label: string;
  path: string;
  exists: boolean;
  count: number;
};

export type SkillsReport = {
  kind: "skills";
  action: "list";
  installed?: SkillSummary;
  sources?: SkillSourceSummary[];
  summary?: {
    total: number;
    active: number;
    shadowed: number;
  };
  skills: SkillSummary[];
};

export type FileView = {
  path: string;
  content: string;
  total_lines: number;
  size_bytes: number;
  language: string;
};


export type LocalFileReferenceSummary = {
  path: string;
  name?: string;
  language?: string;
  total_lines?: number | null;
  size_bytes?: number | null;
  injected_bytes?: number | null;
  truncated?: boolean;
  failed?: boolean;
  error?: string;
};

export type WorkspaceFileReference = {
  path: string;
  name: string;
  directory: string;
  extension?: string | null;
  size_bytes?: number | null;
  modified_epoch_millis?: number | null;
  score: number;
};

export type LocalImagePreview = {
  path: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
};

export type LocalImageMetadata = {
  path: string;
  mimeType: string;
  sizeBytes: number;
};

export type GitDiff = {
  path?: string;
  diff: string;
  is_empty: boolean;
};

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan";

export type AgentPermissionState = {
  currentMode: PermissionMode;
  availableModes: PermissionMode[];
};

export type AgentTurnResponse = {
  ok: boolean;
  message: string;
  requires_confirmation: boolean;
  permission_prompt?: string | null;
  model?: string;
  iterations?: number;
  tool_uses?: unknown[];
  tool_results?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  estimated_cost?: string;
  raw_json?: unknown;
  stderr?: string;
};

export type AgentReplProcessState = {
  sessionId: string;
  root: string;
  model: string;
  permissionMode: PermissionMode;
};

export type AgentReplProcessStatus = {
  sessionId: string;
  root: string;
  running: boolean;
  pid?: number | null;
};

export type AgentReplSendResult = {
  accepted: boolean;
};

export type AgentReplStreamEvent = {
  sessionId: string;
  root: string;
  eventType: string;
  bindStatus?: "ok" | "missing_assistant_message_id" | string | null;
  payload: Record<string, unknown>;
};

export type ContextUsageCategory = {
  name: string;
  tokens: number;
  color?: string;
  isDeferred?: boolean;
};

export type ContextUsageData = {
  categories?: ContextUsageCategory[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens?: number;
  percentage?: number;
  model?: string;
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
  apiUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
};

export type AgentContextUsage = {
  root: string;
  sessionId: string;
  data: ContextUsageData;
  updatedAtMs: number;
};

export type McpToolConfig = {
  name: string;
  description?: string | null;
  parameters: Record<string, unknown>;
};

export type McpServerConfig = {
  enabled?: boolean;
  type?: "stdio" | string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  tools: McpToolConfig[];
};

export type McpSettings = {
  mcpServers: Record<string, McpServerConfig>;
};

export type McpSettingsFile = {
  path: string;
  settings: McpSettings;
};

export type ModelProvider = "deepseek" | "openai" | "anthropic";

export type ModelEndpointConfig = {
  id: string;
  name: string;
  provider: ModelProvider;
  model?: string;
  supportModels?: string[];
  apiKey: string;
  baseUrl: string;
  organizationId?: string | null;
  maxTokens: number;
  temperature: number;
  enabled: boolean;
};

export type DeepSeekPricingItem = {
  item: "cache_hit_input" | "cache_miss_input" | "output" | string;
  pricePerMTokens: number;
};

export type DeepSeekPricingModel = {
  model: string;
  items: DeepSeekPricingItem[];
};

export type DeepSeekPricingConfig = {
  source: "official" | string;
  fetchedAt: string;
  url: string;
  currency: "CNY" | string;
  unit: "CNY_PER_1M_TOKENS" | string;
  models: DeepSeekPricingModel[];
};

export type ModelSettings = {
  activeModelId: string;
  models: ModelEndpointConfig[];
  deepseekPricing?: DeepSeekPricingConfig | null;
};

export type ModelConnectionTestResult = {
  ok: boolean;
  message: string;
  model: string;
  stderr?: string;
};

export type GrepRuntimeRequest = {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "files_with_matches" | "content" | "count";
  case_insensitive?: boolean;
  head_limit?: number;
};

export type BashRuntimeRequest = {
  command: string;
  timeout_ms?: number;
};

export type RuntimeSessionSummary = {
  id: string;
  title: string;
  path: string;
  updated_at_ms: number;
  modified_epoch_millis: number;
  message_count: number;
  parent_session_id?: string;
  branch_name?: string;
};

export type RuntimeSessionMessage = {
  id: string;
  uuid?: string | null;
  parentUuid?: string | null;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  raw_json?: unknown;
  event_type?: string | null;
};

export type RuntimeSessionDetail = {
  id: string;
  path: string;
  title: string;
  version: number;
  created_at_ms: number;
  updated_at_ms: number;
  message_count: number;
  prompt_history_count: number;
  model?: string | null;
  workspace_root?: string | null;
  has_compaction: boolean;
  messages: RuntimeSessionMessage[];
  fork?: {
    parent_session_id: string;
    branch_name?: string | null;
  } | null;
};

export type StreamItem =
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant" | "system";
      text: string;
      links?: StreamLink[];
      /** Assistant-only: intermediate assistant text observed before the final result. */
      progressText?: string;
      /** Assistant-only: whether this message is still receiving stream-json events. */
      status?: "streaming" | "complete";
      /** Top-level jsonl uuid. Used as a safe checkpoint for fork-from-here. */
      checkpointUuid?: string;
      /** Assistant-only: whether the intermediate process panel is open. */
      progressOpen?: boolean;
      /** User-only: local files referenced with @ and injected into the transport prompt. */
      fileReferences?: LocalFileReferenceSummary[] | undefined;
    }
  | {
      id: string;
      kind: "system";
      subtype:
        | "status"
        | "compact_notice"
        | "permission_request"
        | "permission_response"
        | "interrupt"
        | "session_switch"
        | "session_clear"
        | "permissions"
        | "model"
        | "cost"
        | "error"
        | "info";
      title: string;
      detail: string;
    }
  | {
      id: string;
      kind: "tool";
      title: string;
      detail: string;
      status: "pending" | "success" | "error";
    }
  | {
      id: string;
      kind: "artifact";
      title: string;
      artifactKind: "markdown" | "json" | "file" | "table" | "chart" | "diff" | "link";
      preview: string;
      path?: string;
    };

export type StreamLink = {
  id: string;
  label: string;
  kind: "file" | "markdown" | "pdf" | "image" | "report";
  path: string;
};

// ─── Component / DAG platform types ───────────────────────────────────────

export type ParameterSchema = {
  type: "object";
  properties: Record<string, ParameterDef>;
  required?: string[];
};

export type ParameterDef = {
  // "status" is used ONLY for IO-port encoding: a control-flow (status) port is
  // stored as {type:"status"} in input_schema/output_schema. The other values
  // are standard JSON-schema types used by data (file) ports and config params.
  type: "string" | "number" | "integer" | "boolean" | "array" | "object" | "status";
  description?: string;
  default?: unknown;
  items?: ParameterDef;
  // Carries the component port's file *format* (e.g. "parquet" | "csv" | "json")
  // when the property is derived from a component IO port. A file port may omit
  // it (= any file). Optional / non-standard.
  format?: string;
};

// ─── Component configuration schema (config_schema) ────────────────────────
// Declared by the user in the UI (definition-level), NOT by the git author.
// Each item is one parameter the component exposes to its instances. See
// docs/components.md "config-item schema (config_schema)".

export type ConfigFieldBaseType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "path"
  | "date";

// A `list` parameter is encoded as an object so the element type is explicit:
// `{kind: "list", element: <base type>}`.
export type ConfigFieldType = ConfigFieldBaseType | {kind: "list"; element: ConfigFieldBaseType};

export type ConfigSchemaItem = {
  key: string;
  label: string;
  type: ConfigFieldType;
  required: boolean;
  default?: unknown;
  // Only meaningful when `type === "enum"`: the allowed values.
  enum?: string[];
  description?: string;
};

export type Component = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "exploring" | "generated" | "published" | "deprecated";
  // Deprecated: retained only because the backend column still exists
  // (avoiding a dangerous DROP rebuild). Never used for logic anymore.
  workspaceRoot: string;
  // Git source — the configuration truth-source for where the code lives.
  gitUrl: string;
  gitBranch: string;
  gitRef: string;
  entryPoint: string;
  inputSchema: ParameterSchema;
  outputSchema: ParameterSchema;
  // Declared parameter schema (config_schema). Empty array / undefined = no
  // parameters. Stored as a JSON array on the backend.
  configSchema?: ConfigSchemaItem[];
  tags: string[];
  // Registry flag: true = registered/global (reusable across DAGs, shown in the
  // "component" list); false = generic, non-global (created by dragging a "generic component",
  // not shown in the list).
  global: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ComponentSession = {
  id: string;
  componentId: string;
  sessionId: string;
  sessionPath: string;
  title?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type DagNodePosition = {
  x: number;
  y: number;
};

export type Dag = {
  id: string;
  name: string;
  description?: string;
  status: "draft" | "published" | "archived";
  executionOrder?: string[];
  cron?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type DagNode = {
  id: string;
  dagId: string;
  componentId: string;
  label: string;
  position: DagNodePosition;
  config: Record<string, unknown>;
};

export type DagEdge = {
  id: string;
  dagId: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle: string;
  targetHandle: string;
};

// ---- Generic component (built-in, no pre-defined template library) ----
// `GenericComponentConfig` is the **component-definition** shape edited by
// `GenericComponentForm` / `RegisterComponentForm` and persisted to the
// `components` table (git source, IO ports, name, parameter schema). It is NOT
// the `DagNode.config` instance payload — that carries only `params` (see
// `InstanceConfigForm`). The two are distinct: definition lives in `components`,
// instance params live in `node.config.params`.

// A port's *kind*:
//   - "file"   : data port carrying a file reference. Its *format*
//                (parquet / csv / json / …) is a sub-property (`format`), NOT a
//                separate PortType — that was the earlier modeling mistake
//                (PortType was wrongly "file" | "parquet" | "csv").
//   - "status" : control-flow port. Carries no data; a status edge expresses a
//                pure task dependency (upstream failed/skipped ⇒ downstream is
//                skipped). See docs/engine-executor.md "status gating".
export type PortType = "file" | "status";

export type PortDef = {
  name: string;
  type: PortType;
  // Only meaningful for file ports: the file format this port carries
  // (parquet | csv | json | …). Undefined / omitted = any file. Ignored for
  // status ports.
  format?: string;
};

export type GenericComponentConfig = {
  name: string;
  inputs: PortDef[];
  outputs: PortDef[];
  gitUrl: string;
  gitBranch: string; // empty => "master" at execution time
  gitRef: string; // optional pinned ref (tag/branch)
  params: Record<string, string>;
  entryPoint: string;
  // Declared parameter schema (definition-level). Empty = no parameters.
  configSchema: ConfigSchemaItem[];
};

export type DagDetail = Dag & {
  nodes: DagNode[];
  edges: DagEdge[];
};

export type DagExecution = {
  id: string;
  dagId: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  triggerKind?: "manual" | "cron" | "api";
  startedAtMs?: number;
  completedAtMs?: number;
  outputs?: Record<string, unknown>;
  /** Frozen DAG plan (nodes w/ config + edges + execution order) captured at
   *  submit time. Viewing a historical run shows this config, not the live one. */
  snapshot?: string;
};

export type NodeExecution = {
  id: string;
  executionId: string;
  nodeId: string;
  status: "preparing" | "running" | "success" | "failed" | "cancelled" | "skipped";
  startedAtMs?: number;
  completedAtMs?: number;
  outputPath?: string;
  // Per-output-port runtime artifacts (third layer = run artifacts), indexed by
  // output port key, e.g. {"data": "/path/a.csv", "metrics": "/path/m.json"}.
  outputs?: Record<string, unknown>;
  error?: string;
};

export type ExecutionLog = {
  id?: number;
  executionId: string;
  nodeId?: string;
  level: "info" | "error" | "stdout" | "stderr";
  message: string;
  timestampMs: number;
};

// A single page of a node's on-disk log file (full, untruncated). Returned by
// GET /api/executions/:id/nodes/:node_id/log with offset/limit paging.
export type NodeLogFile = {
  lines: string[];
  offset: number;
  limit: number;
  total: number;
  truncated: boolean;
};
