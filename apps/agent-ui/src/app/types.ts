import type {FileView, GitDiff, LocalFileReferenceSummary, StreamLink, WorkspaceFileReference} from "../types";
import type {AgentReplCapabilityItem} from "../runtime";

export type LocalImageMetadata = {
  path?: string;
  filePath?: string;
  file_path?: string;
  displayPath?: string;
  display_path?: string;
  name?: string;
  filename?: string;
  fileName?: string;
  mimeType?: string;
  mime_type?: string;
  sizeBytes?: number;
  size_bytes?: number;
  width?: number | null;
  height?: number | null;
  inlinePreview?: boolean;
  inline_preview?: boolean;
  previewable?: boolean;
  reason?: string;
  error?: string;
  [key: string]: unknown;
};

export type PreviewTab =
  | {
      id: string;
      kind: "file";
      title: string;
      file: FileView;
      diff?: GitDiff;
    }
  | {
      id: string;
      kind: "reference";
      title: string;
      link: StreamLink;
    };

export type ProjectSession = {
  id: string;
  title: string;
  isPending?: boolean;
  processStatus?: "active" | "stopped";
  processPid?: number;
  worktreeName?: string;
  worktreePath?: string;
};

export type ProjectFolder = {
  id: string;
  name: string;
  root: string;
  sessions: ProjectSession[];
  worktreeSessions: ProjectSession[];
};

export type HiddenSession = {
  root: string;
  projectName: string;
  sessionId: string;
  title: string;
  hiddenAt: number;
  path?: string;
  updatedAtMs?: number;
};

export type DebugStreamEvent = {
  id: string;
  sessionId: string;
  root: string;
  eventType: string;
  receivedAt: number;
  payload: Record<string, unknown>;
  debugStorageSource: string;
};

export type AssistantMessageDebugBundle = {
  messageId: string;
  modelCallIds: string[];
  sessionId: string;
  root: string;
  userMessage?: string;
  transportMessage?: string | undefined;
  fileReferences?: LocalFileReferenceSummary[] | undefined;
  displayText: string;
  startedAt: number;
  updatedAt: number;
  completed: boolean;
  events: DebugStreamEvent[];
};

export type LocalFileReference = WorkspaceFileReference & {
  addedAt: number;
};

export type FileMentionState = {
  active: boolean;
  query: string;
  start: number;
  end: number;
};

export type SlashCommandMenuLevel = "root" | "skills" | "commands";

export type SlashCommandMenuState = {
  active: boolean;
  level: SlashCommandMenuLevel;
  query: string;
  start: number;
  end: number;
  selectedIndex: number;
  skills: AgentReplCapabilityItem[];
  commands: AgentReplCapabilityItem[];
  isLoadingSkills: boolean;
  error?: string;
};

export type SlashRootItem = {
  id: "skills" | "commands" | "agents" | "workflows";
  label: string;
  description: string;
  disabled?: boolean;
};

export type SettingsSection = "models" | "remote" | "sessions";

export type SettingsViewProps = {
  hiddenSessions: HiddenSession[];
  onRestoreSession: (session: HiddenSession) => void | Promise<void>;
};

export type AppView = "workspace" | "skills" | "mcp" | "settings" | "terminal";

export type AppMode = "code" | "dag";

export type ResolvedRuntimeBundleEvent = {
  event: import("../types").AgentReplStreamEvent;
  bundleId: string | null;
  previousBundleId: string | null;
  modelCallId: string | null;
  createsBundle: boolean;
  completesBundle: boolean;
};

export type ModelCallUsageCandidate = {
  modelCallId: string;
  model?: string | null;
  stopReason?: string | null;
  usage: Record<string, unknown>;
  eventIndex: number;
  terminal: boolean;
  completenessScore: number;
};

export type BundleUsageModelCost = {
  modelCallId: string;
  model?: string | null;
  currency: string;
  costAmount?: number | null;
  costUsd?: number | null;
  reason?: string | null;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  outputTokens: number;
  cacheHitInputCost?: number | null;
  cacheMissInputCost?: number | null;
  outputCost?: number | null;
};

export type LocalFileReferenceBuildResult = {
  prompt: string;
  fileReferences: LocalFileReferenceSummary[];
};

export type RuntimeSessionArtifacts = {
  items: import("../types").StreamItem[];
  bundles: Record<string, AssistantMessageDebugBundle>;
};

export type AssistantProcessTimelineItem =
  | {
      id: string;
      kind: "text";
      title: string;
      detail: string;
      receivedAt: number;
    }
  | {
      id: string;
      kind: "tool";
      title: string;
      detail: string;
      status: "pending" | "success" | "error";
      receivedAt: number;
    }
  | {
      id: string;
      kind: "tool_call";
      title: string;
      detail: string;
      receivedAt: number;
      tool?: unknown;
    }
  | {
      id: string;
      kind: "tool_result";
      title: string;
      detail: string;
      receivedAt: number;
    }
  | {
      id: string;
      kind: "error";
      title: string;
      detail: string;
      receivedAt: number;
    }
  | {
      id: string;
      kind: "permission";
      title: string;
      detail: string;
      receivedAt: number;
      allowed: boolean;
    }
  | {
      id: string;
      kind: "model";
      model: string;
      title?: string;
      detail?: string;
      receivedAt: number;
    }
  | {
      id: string;
      kind: "cost";
      detail: string;
      title?: string;
      receivedAt: number;
    }
  | {
      id: string;
      kind: "info";
      detail: string;
      title?: string;
      receivedAt: number;
    };

export type SessionUsageIndicatorKey =
  | "costAmount"
  | "totalInputTokens"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadInputTokens"
  | "cacheCreationInputTokens"
  | "hitRate"
  | "modelCallCount";

export type SkillsViewProps = {
  activeProject?: ProjectFolder;
};

export type SkillViewMode = "grid" | "list";

export type McpEnvDraftRow = {
  id: string;
  key: string;
  value: string;
};

export type McpServerDraftRow = {
  id: string;
  name: string;
  type: string;
  command: string;
  argsText: string;
  envRows: McpEnvDraftRow[];
};

export type RichMarkdownBlock =
  | { kind: "text"; content: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "code"; language: string; code: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };
