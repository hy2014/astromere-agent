import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  addWorkspaceRegistryEntry,
  ensureAgentReplProcess,
  getAgentPermissionState,
  getAgentReplCapabilities,
  getAgentReplProcessStatus,
  killAgentReplProcess,
  interruptAgentTurn,
  listSkills,
  listenAgentReplEvents,
  listRuntimeSessions,
  loadWorkspaceRegistry,
  loadTypedRuntimeSession,
  loadModelSettings,
  openWorkspace,
  readGitDiff,
  readLocalImageMetadata,
  readLocalImagePreview,
  readLocalReferenceFile,
  readWorkspaceFile,
  respondAgentPermission,
  searchWorkspaceFiles,
  saveModelSettings,
  sendAgentReplInput,
  setAgentPermissionMode,
  testModelConnection,
} from "../tauri";
import type { AgentReplCapabilityItem } from "../tauri";
import type {
  AgentPermissionState,
  AgentReplStreamEvent,
  AgentTurnResponse,
  FileView,
  GitDiff,
  LocalFileReferenceSummary,
  LocalImagePreview,
  ModelEndpointConfig,
  ModelSettings,
  PermissionMode,
  RuntimeSessionDetail,
  SkillSummary,
  SkillsReport,
  StreamItem,
  StreamLink,
  WorkspaceFileReference,
} from "../types";



type LocalImageMetadata = {
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
type PreviewTab =
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

type ProjectSession = {
  id: string;
  title: string;
  isPending?: boolean;
  processStatus?: "active" | "stopped";
  processPid?: number;
};

type ProjectFolder = {
  id: string;
  name: string;
  root: string;
  sessions: ProjectSession[];
};

type HiddenSession = {
  root: string;
  projectName: string;
  sessionId: string;
  title: string;
  hiddenAt: number;
  path?: string;
  updatedAtMs?: number;
};

type DebugStreamEvent = {
  id: string;
  sessionId: string;
  root: string;
  eventType: string;
  receivedAt: number;
  payload: Record<string, unknown>;
};

type AssistantMessageDebugBundle = {
  messageId: string;
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

type LocalFileReference = WorkspaceFileReference & {
  addedAt: number;
};

type FileMentionState = {
  active: boolean;
  query: string;
  start: number;
  end: number;
};

type SlashCommandMenuLevel = "root" | "skills" | "commands";

type SlashCommandMenuState = {
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

type SlashRootItem = {
  id: "skills" | "commands" | "agents" | "workflows";
  label: string;
  description: string;
  disabled?: boolean;
};

const slashRootItems: SlashRootItem[] = [
  { id: "skills", label: "Skills", description: "Use a project or user skill" },
  { id: "commands", label: "Commands", description: "Built-in slash commands" },
  { id: "agents", label: "Agents", description: "Delegate to sub-agents, coming soon", disabled: true },
  { id: "workflows", label: "Workflows", description: "Run workflow templates, coming soon", disabled: true },
];


const maxReferencedFileBytes = 48 * 1024;
const maxReferencedFilesTotalBytes = 160 * 1024;

type SettingsSection = "models" | "sessions";

type SettingsViewProps = {
  hiddenSessions: HiddenSession[];
  onRestoreSession: (session: HiddenSession) => void | Promise<void>;
};

type AppView = "workspace" | "skills" | "settings";



const hiddenSessionsStorageKey = "agent-ui.hiddenSessions.v1";
const assistantDebugBundlesStorageKey = "agent-ui.assistantDebugBundles.v1";

const previewablePathPattern =
  /(?:^|[\s([`"'])((?:(?:~|～)\/|\/|[A-Za-z0-9_.@-]+\/)[^\n`"'<>|]*?\.(?:ck|rs|ts|tsx|js|jsx|json|toml|md|markdown|txt|csv|pdf|png|jpg|jpeg|gif|webp|svg|html|css|py|go|java|kt|swift|c|cc|cpp|h|hpp|yaml|yml|sql|sh|zsh|fish|rb|php|vue|svelte))(?:$|[\s)\]，。,.!?;:'"`])/gi;

function cleanPreviewPath(path: string): string {
  return path
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^['\"]+|['\"]+$/g, "")
    .replace(/[),.;，。！？!?]+$/g, "")
    .replace(/^～\//, "~/");
}

function linkKindForPath(path: string): StreamLink["kind"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "pdf";
  }
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/.test(lower)) {
    return "image";
  }
  if (/\.(md|markdown)$/.test(lower)) {
    return "markdown";
  }
  return "file";
}

function extractPreviewLinks(text: string): StreamLink[] {
  const seen = new Set<string>();
  const links: StreamLink[] = [];
  for (const match of text.matchAll(previewablePathPattern)) {
    const path = cleanPreviewPath(match[1] ?? "");
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    const pathParts = path.split("/");
    links.push({
      id: `link:${path}`,
      label: pathParts[pathParts.length - 1] ?? path,
      kind: linkKindForPath(path),
      path,
    });
  }
  return links.slice(0, 8);
}

function displayRole(role: "user" | "assistant"): string {
  return role === "user" ? "You" : "AI Assistant";
}

function lineNumberPreview(content: string): number[] {
  return Array.from(
    { length: Math.min(content.split("\n").length, 200) },
    (_, index) => index + 1,
  );
}

function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function projectIdFromRoot(root: string): string {
  return `project:${root}`;
}

function isNewSessionId(sessionId: string): boolean {
  return sessionId.startsWith("new-") || sessionId.startsWith("pending-");
}

function createClaudeSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function createPendingSession(): ProjectSession {
  return {
    id: createClaudeSessionId(),
    title: "新会话",
    isPending: true,
    processStatus: "stopped",
  };
}

function sessionKey(root: string, sessionId: string): string {
  return `${root}\n${sessionId}`;
}

function loadHiddenSessions(): HiddenSession[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const value = window.localStorage.getItem(hiddenSessionsStorageKey);
    if (!value) {
      return [];
    }
    const parsed = JSON.parse(value) as HiddenSession[];
    return Array.isArray(parsed)
      ? parsed.filter(
          (item) =>
            typeof item?.root === "string" &&
            typeof item?.sessionId === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function loadAssistantDebugBundles(): Record<string, AssistantMessageDebugBundle> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const value = window.localStorage.getItem(assistantDebugBundlesStorageKey);
    if (!value) {
      return {};
    }
    const parsed = JSON.parse(value) as Record<string, AssistantMessageDebugBundle>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const next: Record<string, AssistantMessageDebugBundle> = {};
    for (const [messageId, bundle] of Object.entries(parsed)) {
      if (
        typeof bundle?.messageId !== "string" ||
        typeof bundle?.sessionId !== "string" ||
        typeof bundle?.root !== "string" ||
        !Array.isArray(bundle?.events)
      ) {
        continue;
      }
      next[messageId] = {
        messageId,
        sessionId: bundle.sessionId,
        root: bundle.root,
        userMessage:
          typeof bundle.userMessage === "string" ? bundle.userMessage : undefined,
        displayText:
          typeof bundle.displayText === "string" ? bundle.displayText : "",
        startedAt:
          typeof bundle.startedAt === "number" ? bundle.startedAt : Date.now(),
        updatedAt:
          typeof bundle.updatedAt === "number" ? bundle.updatedAt : Date.now(),
        completed: bundle.completed === true,
        events: bundle.events
          .filter(
            (event) =>
              typeof event?.id === "string" &&
              typeof event?.sessionId === "string" &&
              typeof event?.root === "string" &&
              typeof event?.eventType === "string" &&
              typeof event?.receivedAt === "number" &&
              event?.payload &&
              typeof event.payload === "object",
          )
          .slice(-300),
      };
    }
    return next;
  } catch {
    return {};
  }
}

function persistAssistantDebugBundles(
  bundles: Record<string, AssistantMessageDebugBundle>,
) {
  if (typeof window === "undefined") {
    return;
  }

  const compactEntries = Object.entries(bundles)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, 120)
    .map(([messageId, bundle]) => [
      messageId,
      {
        ...bundle,
        events: bundle.events.slice(-220),
      },
    ]);

  try {
    window.localStorage.setItem(
      assistantDebugBundlesStorageKey,
      JSON.stringify(Object.fromEntries(compactEntries)),
    );
  } catch {
    // The debug cache is a convenience. Ignore quota/serialization failures.
  }
}

function uniqueHiddenSessions(sessions: HiddenSession[]): HiddenSession[] {
  const seen = new Set<string>();
  const unique: HiddenSession[] = [];
  for (const session of sessions) {
    const key = sessionKey(session.root, session.sessionId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(session);
  }
  return unique;
}

function isHiddenSession(
  hiddenSessions: HiddenSession[],
  root: string,
  sessionId: string,
): boolean {
  const key = sessionKey(root, sessionId);
  return hiddenSessions.some(
    (session) => sessionKey(session.root, session.sessionId) === key,
  );
}

function sessionsFromRuntimeSummaries(
  root: string,
  sessions: Array<{ id: string; title?: string }>,
  hiddenSessions: HiddenSession[],
): ProjectSession[] {
  const visibleSessions = sessions.filter(
    (session) => !isHiddenSession(hiddenSessions, root, session.id),
  );

  return visibleSessions.length > 0
    ? visibleSessions.map((session, index) => ({
        id: session.id,
        title: session.title || `会话${index + 1}`,
        processStatus: "stopped" as const,
      }))
    : [createPendingSession()];
}

function dedupeSessions(sessions: ProjectSession[]): ProjectSession[] {
  const seen = new Set<string>();
  const result: ProjectSession[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) {
      continue;
    }
    seen.add(session.id);
    result.push(session);
  }
  return result;
}

function truncateSessionTitle(value: string, maxLength = 80): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized || "新会话";
  }
  return `${normalized.slice(0, maxLength)}…`;
}

function firstUserTitleFromStream(items: StreamItem[]): string | null {
  const userMessage = items.find(
    (item) => item.kind === "message" && item.role === "user",
  );
  return userMessage?.kind === "message"
    ? truncateSessionTitle(userMessage.text)
    : null;
}

function realSessionIdFromEvent(event: AgentReplStreamEvent): string | null {
  const explicit = event.payload.realSessionId;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit;
  }
  const rawJson = event.payload.raw_json as
    | { session_id?: unknown }
    | undefined;
  return typeof rawJson?.session_id === "string" && rawJson.session_id.trim()
    ? rawJson.session_id
    : null;
}

function createDebugEvent(event: AgentReplStreamEvent): DebugStreamEvent {
  return {
    id: `debug:${event.sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    sessionId: event.sessionId,
    root: event.root,
    eventType: event.eventType,
    receivedAt: Date.now(),
    payload: event.payload,
  };
}

function appendDebugEvent(
  current: Record<string, DebugStreamEvent[]>,
  entry: DebugStreamEvent,
): Record<string, DebugStreamEvent[]> {
  const events = [...(current[entry.sessionId] ?? []), entry].slice(-600);
  return {
    ...current,
    [entry.sessionId]: events,
  };
}

function latestOpenAssistantDebugBundleId(
  current: Record<string, AssistantMessageDebugBundle>,
  sessionId: string,
): string | null {
  let selected: AssistantMessageDebugBundle | null = null;
  for (const bundle of Object.values(current)) {
    if (bundle.sessionId !== sessionId || bundle.completed) {
      continue;
    }
    if (!selected || bundle.startedAt > selected.startedAt) {
      selected = bundle;
    }
  }
  return selected?.messageId ?? null;
}

function updateAssistantDebugBundleForEvent(
  current: Record<string, AssistantMessageDebugBundle>,
  event: AgentReplStreamEvent,
  debugEvent: DebugStreamEvent,
): Record<string, AssistantMessageDebugBundle> {
  const messageId = latestOpenAssistantDebugBundleId(current, event.sessionId);
  if (!messageId) {
    return current;
  }

  const bundle = current[messageId];
  if (!bundle) {
    return current;
  }

  const text = payloadText(event);
  let displayText = bundle.displayText;
  if (event.eventType === "turn_text" && text) {
    displayText =
      displayText === pendingAssistantText ? text : `${displayText}${text}`;
  } else if (event.eventType === "turn_complete" && text) {
    displayText = text;
  }

  const completed =
    bundle.completed ||
    event.eventType === "turn_complete" ||
    event.eventType === "error" ||
    event.eventType === "interrupt" ||
    event.eventType === "process_exit";

  return {
    ...current,
    [messageId]: {
      ...bundle,
      displayText,
      completed,
      updatedAt: debugEvent.receivedAt,
      events: [...bundle.events, debugEvent].slice(-300),
    },
  };
}

function rekeyAssistantDebugBundles(
  current: Record<string, AssistantMessageDebugBundle>,
  oldSessionId: string,
  realSessionId: string,
): Record<string, AssistantMessageDebugBundle> {
  if (oldSessionId === realSessionId) {
    return current;
  }
  let changed = false;
  const next: Record<string, AssistantMessageDebugBundle> = {};
  for (const [messageId, bundle] of Object.entries(current)) {
    if (bundle.sessionId === oldSessionId) {
      changed = true;
      next[messageId] = { ...bundle, sessionId: realSessionId };
    } else {
      next[messageId] = bundle;
    }
  }
  return changed ? next : current;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function detectFileMention(value: string, cursor: number): FileMentionState {
  const beforeCursor = value.slice(0, cursor);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex < 0) {
    return { active: false, query: "", start: cursor, end: cursor };
  }

  const previous = atIndex === 0 ? " " : beforeCursor[atIndex - 1] ?? " ";
  const query = beforeCursor.slice(atIndex + 1);
  const hasBoundary = atIndex === 0 || /[\s([{,，。；;：:]/.test(previous);
  const hasInvalidQuery = /[\n\r\t ]/.test(query) || query.length > 160;

  if (!hasBoundary || hasInvalidQuery) {
    return { active: false, query: "", start: cursor, end: cursor };
  }

  return {
    active: true,
    query,
    start: atIndex,
    end: cursor,
  };
}



function renderPromptHighlightedText(value: string) {
  const parts: Array<string | JSX.Element> = [];
  const tokenRegex = /(^|\s)(\/[A-Za-z0-9:_-]+|@(?:"[^"]+"|[^\s]+))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(value)) !== null) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    const tokenStart = match.index + prefix.length;
    const tokenEnd = tokenStart + token.length;

    if (tokenStart > lastIndex) {
      parts.push(value.slice(lastIndex, tokenStart));
    }

    const isSkill = token.startsWith("/");
    parts.push(
      <span
        key={`${tokenStart}-${token}`}
        className={isSkill ? "prompt-inline-skill-token" : "prompt-inline-file-token"}
      >
        {token}
      </span>,
    );

    lastIndex = tokenEnd;
  }

  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }

  return parts.length > 0 ? parts : "";
}

function detectSlashCommandMenu(
  value: string,
  cursor: number,
): Pick<SlashCommandMenuState, "active" | "query" | "start" | "end"> {
  const beforeCursor = value.slice(0, cursor);
  const slashIndex = beforeCursor.lastIndexOf("/");
  if (slashIndex < 0) {
    return { active: false, query: "", start: cursor, end: cursor };
  }

  const previous = slashIndex === 0 ? " " : beforeCursor[slashIndex - 1] ?? " ";
  const query = beforeCursor.slice(slashIndex + 1);
  const hasBoundary = slashIndex === 0 || /[\s([{,，。；;：:]/.test(previous);
  const hasInvalidQuery = /[\n\r\t ]/.test(query) || query.length > 80;

  if (!hasBoundary || hasInvalidQuery) {
    return { active: false, query: "", start: cursor, end: cursor };
  }

  return { active: true, query, start: slashIndex, end: cursor };
}

function extractPromptSkillToken(value: string): string | null {
  const match = value.trimStart().match(/^\/([A-Za-z0-9:_-]+)/);
  return match?.[1] ?? null;
}

function formatFileSize(bytes?: number | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sanitizeFenceContent(content: string): string {
  return content.replace(/```/g, "`\u200b``");
}

function languageFence(language: string, path: string): string {
  const normalized = language.trim() || path.split(".").pop() || "text";
  return normalized.replace(/[^a-zA-Z0-9_-]/g, "") || "text";
}

function localFileReferenceName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || normalized || "file";
}

const localFileReferenceBlockPattern =
  /\n*<agent-ui-local-file-references>[\s\S]*?<\/agent-ui-local-file-references>\s*/gi;

function stripLocalFileReferenceBlock(text: string): string {
  return text.replace(localFileReferenceBlockPattern, "").trim();
}

function commandEnvelopeDisplayText(text: string): string | null {
  const commandNameMatch = text.match(/<command-name>\s*([\s\S]*?)\s*<\/command-name>/i);
  const commandMessageMatch = text.match(/<command-message>\s*([\s\S]*?)\s*<\/command-message>/i);
  const commandArgsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/i);

  const rawCommand = (commandNameMatch?.[1] ?? commandMessageMatch?.[1] ?? "").trim();
  if (!rawCommand) {
    return null;
  }

  const commandName = rawCommand.startsWith("/") ? rawCommand : `/${rawCommand}`;
  const commandArgs = stripLocalFileReferenceBlock(commandArgsMatch?.[1] ?? "").trim();

  return [commandName, commandArgs].filter(Boolean).join(" ").trim();
}

function parseLocalFileReferenceSummaries(text: string): LocalFileReferenceSummary[] {
  const blockMatches = Array.from(
    text.matchAll(/<agent-ui-local-file-references>([\s\S]*?)<\/agent-ui-local-file-references>/gi),
  );
  if (blockMatches.length === 0) {
    return [];
  }

  const summaries: LocalFileReferenceSummary[] = [];
  const seen = new Set<string>();

  for (const blockMatch of blockMatches) {
    const block = blockMatch[1] ?? "";
    const parts = block.split(/\n(?=###\s+)/g);
    for (const part of parts) {
      const header = part.match(/^###\s+(.+)\s*$/m);
      if (!header) {
        continue;
      }
      const path = header[1].trim();
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);

      const language = part.match(/^-\s*language:\s*(.+)$/m)?.[1]?.trim();
      const linesValue = part.match(/^-\s*lines:\s*(\d+)/m)?.[1];
      const truncated = /content truncated/i.test(part);
      const failed = /failed to read|skipped:/i.test(part);

      summaries.push({
        path,
        name: localFileReferenceName(path),
        language,
        total_lines: linesValue ? Number(linesValue) : null,
        size_bytes: null,
        injected_bytes: null,
        truncated,
        failed,
        error: failed ? part.split("\n").slice(1, 3).join(" ").trim() : undefined,
      });
    }
  }

  return summaries;
}

function localFileReferencesFromPromptText(text: string): LocalFileReferenceSummary[] {
  return parseLocalFileReferenceSummaries(text);
}

function displayPromptText(text: string): string {
  return commandEnvelopeDisplayText(text) ?? (stripLocalFileReferenceBlock(text) || text.trim());
}

type LocalFileReferenceBuildResult = {
  prompt: string;
  fileReferences: LocalFileReferenceSummary[];
};


function isImageReferencePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path.trim());
}

function isCsvFilePath(path?: string | null, language?: string | null): boolean {
  const normalizedPath = (path ?? "").trim().toLowerCase();
  const normalizedLanguage = (language ?? "").trim().toLowerCase();
  return normalizedLanguage === "csv" || normalizedPath.endsWith(".csv");
}

function isLocalReferenceLink(link: StreamLink): boolean {
  return link.id.startsWith("local-reference:");
}

function localReferenceToStreamLink(reference: LocalFileReference): StreamLink {
  const normalizedPath = reference.path;
  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  const label = reference.name || segments[segments.length - 1] || normalizedPath;
  return {
    id: `local-reference:${normalizedPath}`,
    label,
    kind: linkKindForPath(normalizedPath),
    path: normalizedPath,
  };
}

function localFileReferenceSummaryToStreamLink(reference: LocalFileReferenceSummary): StreamLink {
  const normalizedPath = reference.path;
  const label = reference.name || localFileReferenceName(normalizedPath);
  return {
    id: `local-reference:${normalizedPath}`,
    label,
    kind: linkKindForPath(normalizedPath),
    path: normalizedPath,
  };
}

function isAbsoluteOrHomeReferencePath(path: string): boolean {
  const normalized = path.trim();
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("～/")
  );
}

function shouldReadAsLocalReference(link: StreamLink): boolean {
  return isLocalReferenceLink(link) || isAbsoluteOrHomeReferencePath(link.path);
}

async function buildPromptWithLocalFileReferences(
  root: string,
  userPrompt: string,
  references: LocalFileReference[],
): Promise<LocalFileReferenceBuildResult> {
  const uniqueReferences = Array.from(
    new Map(references.map((reference) => [reference.path, reference])).values(),
  );

  if (uniqueReferences.length === 0) {
    return { prompt: userPrompt, fileReferences: [] };
  }

  const blocks: string[] = [];
  const fileSummaries: LocalFileReferenceSummary[] = [];
  let totalBytes = 0;

  for (const reference of uniqueReferences) {
    if (totalBytes >= maxReferencedFilesTotalBytes) {
      blocks.push(
        `### ${reference.path}\nSkipped: total referenced file content limit reached.`,
      );
      fileSummaries.push({
        path: reference.path,
        name: reference.name || localFileReferenceName(reference.path),
        language: reference.extension ?? undefined,
        size_bytes: reference.size_bytes ?? null,
        injected_bytes: 0,
        truncated: true,
        failed: true,
        error: "total referenced file content limit reached",
      });
      continue;
    }

    try {
      const file = await readLocalReferenceFile(root, reference.path);
      const availableBytes = Math.max(
        0,
        maxReferencedFilesTotalBytes - totalBytes,
      );
      const maxBytes = Math.min(maxReferencedFileBytes, availableBytes);
      const encoded = new TextEncoder().encode(file.content);
      const truncated = encoded.length > maxBytes;
      const content = truncated
        ? new TextDecoder().decode(encoded.slice(0, maxBytes))
        : file.content;
      const injectedBytes = Math.min(encoded.length, maxBytes);
      totalBytes += injectedBytes;

      fileSummaries.push({
        path: file.path,
        name: localFileReferenceName(file.path),
        language: file.language || reference.extension || "text",
        total_lines: file.total_lines,
        size_bytes: file.size_bytes,
        injected_bytes: injectedBytes,
        truncated,
        failed: false,
      });

      blocks.push(
        [
          `### ${file.path}`,
          `- language: ${file.language || reference.extension || "text"}`,
          `- lines: ${file.total_lines}`,
          `- size: ${formatFileSize(file.size_bytes)}`,
          truncated
            ? `- note: content truncated to ${formatFileSize(maxBytes)} for this request`
            : null,
          "",
          `\`\`\`${languageFence(file.language, file.path)}`,
          sanitizeFenceContent(content),
          "```",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      );
    } catch (reason) {
      blocks.push(
        `### ${reference.path}\nFailed to read this referenced file: ${String(reason)}`,
      );
      fileSummaries.push({
        path: reference.path,
        name: reference.name || localFileReferenceName(reference.path),
        language: reference.extension ?? undefined,
        size_bytes: reference.size_bytes ?? null,
        injected_bytes: 0,
        truncated: false,
        failed: true,
        error: String(reason),
      });
    }
  }

  return {
    prompt: [
      userPrompt,
      "",
      "<agent-ui-local-file-references>",
      "The user referenced these local files with @. They may be inside or outside the current workspace. Treat them as read-only context snapshots for this turn. Use exact paths when citing or discussing them. If a file is truncated or failed to read, say so instead of guessing missing content.",
      "",
      blocks.join("\n\n"),
      "</agent-ui-local-file-references>",
    ]
      .filter(Boolean)
      .join("\n"),
    fileReferences: fileSummaries,
  };
}

function rekeyDebugEvents(
  current: Record<string, DebugStreamEvent[]>,
  oldSessionId: string,
  realSessionId: string,
): Record<string, DebugStreamEvent[]> {
  if (oldSessionId === realSessionId) {
    return current;
  }
  const oldEvents = current[oldSessionId] ?? [];
  const realEvents = current[realSessionId] ?? [];
  const { [oldSessionId]: _removed, ...rest } = current;
  return {
    ...rest,
    [realSessionId]: [...realEvents, ...oldEvents].slice(-600),
  };
}

function formatDebugTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function welcomeStream(
  _projectName: string,
  _sessionTitle: string,
): StreamItem[] {
  return [];
}

type RuntimeSessionArtifacts = {
  items: StreamItem[];
  bundles: Record<string, AssistantMessageDebugBundle>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rawJsonFromRuntimeMessage(
  message: RuntimeSessionDetail["messages"][number],
): Record<string, unknown> | null {
  return isRecord(message.raw_json) ? message.raw_json : null;
}

function rawJsonFromDebugEvent(event: DebugStreamEvent): Record<string, unknown> | null {
  const rawJson = event.payload.raw_json;
  if (isRecord(rawJson)) {
    return rawJson;
  }
  return isRecord(event.payload) ? event.payload : null;
}

function jsonContainsTypedBlock(value: unknown, expectedType: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsTypedBlock(item, expectedType));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === expectedType) {
    return true;
  }
  return Object.values(value).some((item) => jsonContainsTypedBlock(item, expectedType));
}

function runtimeMessageRawType(
  message: RuntimeSessionDetail["messages"][number],
): string | null {
  const rawJson = rawJsonFromRuntimeMessage(message);
  const rawType = rawJson?.type;
  if (typeof rawType === "string" && rawType.trim()) {
    return rawType;
  }
  return typeof message.event_type === "string" && message.event_type.trim()
    ? message.event_type
    : null;
}

function looksLikeRealRuntimeUserText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || normalized.startsWith("[Request interrupted")) {
    return false;
  }

  // Claude Code persists slash commands as an XML-like command envelope, for
  // example `<command-name>/kline-chart</command-name>`. That is still the
  // user's turn and must split assistant turns during historical restore.
  if (commandEnvelopeDisplayText(normalized)) {
    return true;
  }

  if (normalized.startsWith("<")) {
    return false;
  }

  const lower = normalized.toLowerCase();
  const skippedPrefixes = [
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
    "auto context",
  ];

  return !skippedPrefixes.some((prefix) => lower.startsWith(prefix));
}

function isRuntimeRealUserMessage(
  message: RuntimeSessionDetail["messages"][number],
): boolean {
  if (message.role !== "user") {
    return false;
  }

  const rawJson = rawJsonFromRuntimeMessage(message);
  const rawType = runtimeMessageRawType(message);
  if (rawType === "tool_result" || rawType === "tool") {
    return false;
  }

  // Claude Code stores tool results as `type: "user"` + `message.role: "user"`
  // with content blocks like `{ type: "tool_result" }`. Those are tool output,
  // not a new human turn, so they must not split one assistant answer into N bubbles.
  if (rawJson && jsonContainsTypedBlock(rawJson, "tool_result")) {
    return false;
  }

  return looksLikeRealRuntimeUserText(message.text);
}

function debugEventTypeForRuntimeMessage(
  message: RuntimeSessionDetail["messages"][number],
): string {
  const rawJson = rawJsonFromRuntimeMessage(message);
  const rawType =
    typeof rawJson?.type === "string" ? rawJson.type : message.event_type;
  if (rawType === "result") {
    return "turn_complete";
  }
  if (rawType === "tool_result" || message.role === "tool") {
    return "tool_result";
  }
  if (rawType === "assistant" && extractToolUsesFromRawJson(rawJson).length > 0) {
    return "assistant_tool_use";
  }
  if (message.role === "assistant") {
    return "turn_text";
  }
  return typeof rawType === "string" && rawType.trim()
    ? rawType
    : `historical_${message.role}`;
}

function createHistoricalDebugEvent(
  detail: RuntimeSessionDetail,
  root: string,
  message: RuntimeSessionDetail["messages"][number],
  index: number,
): DebugStreamEvent | null {
  const rawJson = rawJsonFromRuntimeMessage(message);
  if (!rawJson && !message.text.trim()) {
    return null;
  }

  return {
    id: `debug:${detail.id}:history:${index}`,
    sessionId: detail.id,
    root,
    eventType: debugEventTypeForRuntimeMessage(message),
    receivedAt: detail.updated_at_ms + index,
    payload: {
      historical: true,
      text: message.text,
      event_type: message.event_type ?? null,
      raw_json: rawJson ?? undefined,
    },
  };
}

function extractToolUsesFromRawJson(value: unknown): Record<string, unknown>[] {
  const rawJson = isRecord(value) ? value : null;
  if (!rawJson) {
    return [];
  }

  const directTool = rawJson.tool;
  if (isRecord(directTool)) {
    return [directTool];
  }

  const message = rawJson.message;
  const content = isRecord(message) ? message.content : rawJson.content;
  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) && block.type === "tool_use",
  );
}

function toolName(tool: Record<string, unknown>): string {
  const name = tool.name;
  return typeof name === "string" && name.trim() ? name : "Tool";
}

function commandFromToolUse(tool: Record<string, unknown>): string | null {
  const input = isRecord(tool.input) ? tool.input : null;
  const candidates = [
    input?.command,
    input?.cmd,
    input?.script,
    tool.command,
    tool.cmd,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function summarizeToolUse(tool: Record<string, unknown>): string {
  const command = commandFromToolUse(tool);
  if (command) {
    return `${toolName(tool)}: ${command}`;
  }
  const input = isRecord(tool.input) ? tool.input : null;
  const description = input
    ? JSON.stringify(input).slice(0, 180)
    : JSON.stringify(tool).slice(0, 180);
  return `${toolName(tool)}: ${description}`;
}

function isToolResultEvent(event: DebugStreamEvent): boolean {
  const rawJson = rawJsonFromDebugEvent(event);
  return (
    event.eventType === "tool_result" ||
    rawJson?.type === "tool_result" ||
    rawJson?.type === "tool"
  );
}

type AssistantProcessTimelineItem =
  | {
      id: string;
      kind: "text";
      title: string;
      detail: string;
      receivedAt: number;
    }
  | {
      id: string;
      kind: "tool_call";
      title: string;
      detail: string;
      tool: Record<string, unknown>;
      receivedAt: number;
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
      kind: "permission";
      title: string;
      detail: string;
      receivedAt: number;
    };

function truncateProcessDetail(value: string, limit = 900): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}…`;
}

function textFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!isRecord(block)) {
        return "";
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function textFromProcessEvent(event: DebugStreamEvent): string {
  const directText = event.payload.text;
  if (typeof directText === "string" && directText.trim()) {
    return directText.trim();
  }

  const directMessage = event.payload.message;
  if (typeof directMessage === "string" && directMessage.trim()) {
    return directMessage.trim();
  }

  const rawJson = rawJsonFromDebugEvent(event);
  if (!rawJson) {
    return "";
  }

  const rawMessage = rawJson.message;
  if (typeof rawMessage === "string" && rawMessage.trim()) {
    return rawMessage.trim();
  }
  if (isRecord(rawMessage)) {
    const contentText = textFromContentBlocks(rawMessage.content);
    if (contentText) {
      return contentText;
    }
  }

  const rawContentText = textFromContentBlocks(rawJson.content);
  if (rawContentText) {
    return rawContentText;
  }

  return "";
}

function summarizeToolResultEvent(event: DebugStreamEvent): string {
  const rawJson = rawJsonFromDebugEvent(event);
  const candidates = [
    rawJson?.content,
    rawJson?.result,
    rawJson?.output,
    rawJson?.text,
    event.payload.text,
    event.payload.message,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return truncateProcessDetail(candidate, 1200);
    }
    if (Array.isArray(candidate)) {
      const text = candidate
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (isRecord(item)) {
            if (typeof item.text === "string") {
              return item.text;
            }
            if (typeof item.content === "string") {
              return item.content;
            }
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (text.trim()) {
        return truncateProcessDetail(text, 1200);
      }
    }
    if (isRecord(candidate)) {
      return truncateProcessDetail(JSON.stringify(candidate, null, 2), 1200);
    }
  }

  return truncateProcessDetail(JSON.stringify(event.payload, null, 2), 1200);
}

function isPermissionEvent(event: DebugStreamEvent): boolean {
  const rawJson = rawJsonFromDebugEvent(event);
  const rawType = typeof rawJson?.type === "string" ? rawJson.type : "";
  return (
    event.eventType.includes("permission") ||
    event.eventType === "control_request" ||
    event.eventType === "control_response" ||
    rawType.includes("permission") ||
    rawType === "control_request" ||
    rawType === "control_response"
  );
}

function summarizePermissionEvent(event: DebugStreamEvent): string {
  const rawJson = rawJsonFromDebugEvent(event);
  const request = isRecord(rawJson?.request) ? rawJson.request : null;
  const response = isRecord(rawJson?.response) ? rawJson.response : null;
  const toolNameCandidate =
    request?.tool_name ?? request?.toolName ?? rawJson?.tool_name ?? rawJson?.toolName;
  const behavior =
    response?.behavior ??
    (isRecord(response?.response) ? response.response.behavior : undefined) ??
    rawJson?.behavior;
  const parts = [
    typeof toolNameCandidate === "string" ? toolNameCandidate : null,
    typeof behavior === "string" ? behavior : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : truncateProcessDetail(JSON.stringify(event.payload, null, 2), 500);
}

function toolUsesFromProcessEvent(event: DebugStreamEvent): Record<string, unknown>[] {
  const rawJson = rawJsonFromDebugEvent(event) ?? event.payload;
  const extracted = extractToolUsesFromRawJson(rawJson);
  if (extracted.length > 0) {
    return extracted;
  }
  if (event.eventType !== "tool_call") {
    return [];
  }
  const raw = rawJsonFromDebugEvent(event);
  if (isRecord(raw?.tool)) {
    return [raw.tool];
  }
  if (isRecord(raw)) {
    return [raw];
  }
  return [];
}

function assistantTurnDetails(
  item: Extract<StreamItem, { kind: "message" }>,
  bundle: AssistantMessageDebugBundle | null,
) {
  const fallbackProgressLines = (item.progressText ?? "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const timeline: AssistantProcessTimelineItem[] = [];
  const seenTools = new Set<string>();
  const toolUses: Record<string, unknown>[] = [];
  const toolResults: DebugStreamEvent[] = [];

  for (const [index, event] of (bundle?.events ?? []).entries()) {
    const baseId = `${event.id}:process:${index}`;
    const tools = toolUsesFromProcessEvent(event);
    if (tools.length > 0) {
      for (const [toolIndex, tool] of tools.entries()) {
        const key =
          (typeof tool.id === "string" && tool.id.trim()) || summarizeToolUse(tool);
        if (!seenTools.has(key)) {
          seenTools.add(key);
          toolUses.push(tool);
          timeline.push({
            id: `${baseId}:tool:${toolIndex}`,
            kind: "tool_call",
            title: toolName(tool),
            detail: summarizeToolUse(tool),
            tool,
            receivedAt: event.receivedAt,
          });
        }
      }
      continue;
    }

    if (isToolResultEvent(event)) {
      toolResults.push(event);
      timeline.push({
        id: `${baseId}:tool-result`,
        kind: "tool_result",
        title: "Tool result",
        detail: summarizeToolResultEvent(event),
        receivedAt: event.receivedAt,
      });
      continue;
    }

    if (isPermissionEvent(event)) {
      timeline.push({
        id: `${baseId}:permission`,
        kind: "permission",
        title: event.eventType.includes("approved") || event.eventType.includes("response")
          ? "Permission response"
          : "Permission request",
        detail: summarizePermissionEvent(event),
        receivedAt: event.receivedAt,
      });
      continue;
    }

    if (event.eventType === "turn_text" || event.eventType === "assistant_tool_use") {
      const processText = textFromProcessEvent(event);
      if (processText) {
        timeline.push({
          id: `${baseId}:text`,
          kind: "text",
          title: "Assistant",
          detail: truncateProcessDetail(processText, 1600),
          receivedAt: event.receivedAt,
        });
      }
    }
  }

  if (timeline.length === 0) {
    for (const [index, line] of fallbackProgressLines.entries()) {
      timeline.push({
        id: `${item.id}:fallback-progress:${index}`,
        kind: "text",
        title: "Assistant",
        detail: line,
        receivedAt: bundle?.startedAt ?? 0,
      });
    }
  }

  const commandUses = toolUses.filter((tool) => commandFromToolUse(tool));
  const progressLines = timeline
    .filter((entry): entry is Extract<AssistantProcessTimelineItem, { kind: "text" }> => entry.kind === "text")
    .map((entry) => entry.detail)
    .filter(Boolean);

  return {
    timeline,
    progressLines,
    toolUses,
    commandUses,
    toolResults,
    eventCount: bundle?.events.length ?? 0,
  };
}

function compactCountLabel(count: number, singular: string, plural = `${singular}s`) {
  if (count === 0) {
    return `0 ${plural}`;
  }
  return `${count} ${count === 1 ? singular : plural}`;
}

function runtimeSessionToArtifacts(
  detail: RuntimeSessionDetail,
  root: string,
): RuntimeSessionArtifacts {
  const items: StreamItem[] = [];
  const bundles: Record<string, AssistantMessageDebugBundle> = {};
  let currentUserText: string | undefined;
  let currentUserTransportText: string | undefined;
  let currentUserFileReferences: LocalFileReferenceSummary[] = [];
  let pendingTurnEvents: DebugStreamEvent[] = [];
  let pendingAssistant:
    | {
        id: string;
        text: string;
        progressText?: string;
        events: DebugStreamEvent[];
        startedAt: number;
        updatedAt: number;
      }
    | null = null;

  function flushPendingAssistant() {
    if (!pendingAssistant) {
      pendingTurnEvents = [];
      return;
    }

    const text = pendingAssistant.text.trim();
    if (text) {
      const progressText = pendingAssistant.progressText?.trim();
      items.push({
        id: pendingAssistant.id,
        kind: "message",
        role: "assistant",
        text,
        links: extractPreviewLinks(text),
        progressText:
          progressText && progressText !== text ? progressText : undefined,
        status: "complete",
      });
      bundles[pendingAssistant.id] = {
        messageId: pendingAssistant.id,
        sessionId: detail.id,
        root,
        userMessage: currentUserText,
        transportMessage: currentUserTransportText,
        fileReferences: currentUserFileReferences.length > 0 ? currentUserFileReferences : undefined,
        displayText: text,
        startedAt: pendingAssistant.startedAt,
        updatedAt: pendingAssistant.updatedAt,
        completed: true,
        events: pendingAssistant.events.slice(-300),
      };
    }

    pendingAssistant = null;
    pendingTurnEvents = [];
  }

  for (const [index, message] of detail.messages.entries()) {
    const text = message.text.trim();
    const debugEvent = createHistoricalDebugEvent(detail, root, message, index);

    if (isRuntimeRealUserMessage(message)) {
      flushPendingAssistant();
      if (debugEvent) {
        pendingTurnEvents = [debugEvent];
      }
      if (text) {
        const displayText = displayPromptText(text);
        const fileReferenceSummaries = localFileReferencesFromPromptText(text);
        currentUserText = displayText;
        currentUserTransportText = text;
        currentUserFileReferences = fileReferenceSummaries;
        items.push({
          id: message.id,
          kind: "message",
          role: "user",
          text: displayText,
          links: [],
          fileReferences: fileReferenceSummaries.length > 0 ? fileReferenceSummaries : undefined,
        });
      }
      continue;
    }

    if (message.role === "user") {
      if (debugEvent) {
        if (pendingAssistant) {
          pendingAssistant.events = [...pendingAssistant.events, debugEvent].slice(-300);
          pendingAssistant.updatedAt = debugEvent.receivedAt;
        } else {
          pendingTurnEvents = [...pendingTurnEvents, debugEvent].slice(-300);
        }
      }
      continue;
    }

    if (message.role === "assistant") {
      const eventBatch = [
        ...pendingTurnEvents,
        ...(debugEvent ? [debugEvent] : []),
      ];
      pendingTurnEvents = [];

      if (!pendingAssistant) {
        pendingAssistant = {
          id: message.id,
          text,
          events: eventBatch,
          startedAt: eventBatch[0]?.receivedAt ?? detail.updated_at_ms + index,
          updatedAt: eventBatch.length > 0 ? eventBatch[eventBatch.length - 1].receivedAt : detail.updated_at_ms + index,
        };
        continue;
      }

      if (text) {
        pendingAssistant.progressText = mergeProgressText(
          pendingAssistant.progressText,
          pendingAssistant.text,
        );
        pendingAssistant.id = message.id;
        pendingAssistant.text = text;
      }
      pendingAssistant.events = [
        ...pendingAssistant.events,
        ...eventBatch,
      ].slice(-300);
      pendingAssistant.updatedAt =
        eventBatch.length > 0 ? eventBatch[eventBatch.length - 1].receivedAt : pendingAssistant.updatedAt;
      continue;
    }

    if (debugEvent) {
      if (pendingAssistant) {
        pendingAssistant.events = [...pendingAssistant.events, debugEvent].slice(-300);
        pendingAssistant.updatedAt = debugEvent.receivedAt;
      } else {
        pendingTurnEvents = [...pendingTurnEvents, debugEvent].slice(-300);
      }
    }
  }

  flushPendingAssistant();
  return { items, bundles };
}

function runtimeSessionToStream(detail: RuntimeSessionDetail): StreamItem[] {
  return runtimeSessionToArtifacts(detail, detail.workspace_root ?? "").items;
}

function consumeLeadingStructuredOutput(
  text: string,
  baseId: string,
): { items: StreamItem[]; rest: string } {
  const items: StreamItem[] = [];
  let rest = text.trim();
  const patterns: Array<{
    subtype: Extract<StreamItem, { kind: "system" }>["subtype"];
    title: string;
    regex: RegExp;
  }> = [
    {
      subtype: "session_switch",
      title: "Session switched",
      regex: /^Session switched\n(?:  .+\n?){3}/,
    },
    {
      subtype: "session_clear",
      title: "Session cleared",
      regex: /^Session cleared\n(?:  .+\n?){5,6}/,
    },
    {
      subtype: "permissions",
      title: "Permissions updated",
      regex: /^Permissions updated\n(?:  .+\n?){4}/,
    },
    {
      subtype: "model",
      title: "Model updated",
      regex: /^Model updated\n(?:  .+\n?){4}/,
    },
    {
      subtype: "cost",
      title: "Cost",
      regex: /^Cost\n(?:  .+\n?){5}/,
    },
    {
      subtype: "compact_notice",
      title: "Context compacted",
      regex: /^\[auto-compacted: removed \d+ messages\]/,
    },
  ];

  let matched = true;
  while (matched) {
    matched = false;
    for (const pattern of patterns) {
      const match = rest.match(pattern.regex);
      if (!match) {
        continue;
      }
      const detail = match[0].trim();
      items.push({
        id: `${baseId}:system:${items.length}`,
        kind: "system",
        subtype: pattern.subtype,
        title: pattern.title,
        detail,
      });
      rest = rest.slice(match[0].length).trimStart();
      matched = true;
      break;
    }
  }

  return { items, rest };
}

function extractArtifactItems(text: string, baseId: string): StreamItem[] {
  const items: StreamItem[] = [];

  const diffMatch = text.match(/(?:^|\n)(diff --git[\s\S]+)$/);
  if (diffMatch) {
    items.push({
      id: `${baseId}:artifact:diff`,
      kind: "artifact",
      title: "Diff",
      artifactKind: "diff",
      preview: diffMatch[1].trim(),
    });
  }

  const tableMatch = text.match(
    /((?:^\|.+\|\n)+^\|?(?:\s*:?-+:?\s*\|)+\s*$[\s\S]*?)(?:\n\n|$)/m,
  );
  if (tableMatch) {
    items.push({
      id: `${baseId}:artifact:table`,
      kind: "artifact",
      title: "Table",
      artifactKind: "table",
      preview: tableMatch[1].trim(),
    });
  }

  const links = extractPreviewLinks(text);
  for (const [index, link] of links.entries()) {
    items.push({
      id: `${baseId}:artifact:link:${index}`,
      kind: "artifact",
      title: link.label,
      artifactKind: "link",
      preview: link.path,
      path: link.path,
    });
  }

  return items;
}

function formatAgentMetadata(response: AgentTurnResponse): string {
  const chunks = [];
  if (response.model) {
    chunks.push(`model ${response.model}`);
  }
  if (typeof response.iterations === "number") {
    chunks.push(`${response.iterations} iterations`);
  }
  if (response.usage) {
    const input = response.usage.input_tokens ?? 0;
    const output = response.usage.output_tokens ?? 0;
    chunks.push(`${input} input / ${output} output tokens`);
  }
  if (response.estimated_cost) {
    chunks.push(response.estimated_cost);
  }
  return chunks.join(" · ");
}

function responseToStreamItems(
  response: AgentTurnResponse,
  baseId: string,
): StreamItem[] {
  const metadata = formatAgentMetadata(response);
  const { items: systemItems, rest } = consumeLeadingStructuredOutput(
    response.message,
    baseId,
  );
  const content = rest.trim();
  const links = extractPreviewLinks(content);
  const artifactItems = extractArtifactItems(content, baseId);
  const items: StreamItem[] = [...systemItems];

  if (content) {
    items.push({
      id: `${baseId}:message`,
      kind: "message",
      role: "assistant",
      text: [content, metadata].filter(Boolean).join("\n\n"),
      links,
    });
  } else if (metadata) {
    items.push({
      id: `${baseId}:message`,
      kind: "message",
      role: "assistant",
      text: metadata,
    });
  }

  return [...items, ...artifactItems];
}


function isPermissionEventName(eventType: string): boolean {
  const normalized = eventType.toLowerCase();
  return (
    normalized === "control_request" ||
    normalized === "control_response" ||
    normalized === "permission_request" ||
    normalized === "permission_response" ||
    normalized === "permission_required" ||
    normalized === "permission_approved" ||
    normalized === "permission_denied" ||
    normalized.includes("permission")
  );
}

function isPermissionLikeStreamItem(item: StreamItem): boolean {
  const text =
    item.kind === "message"
      ? `${item.role}\n${item.text}`
      : item.kind === "system"
        ? `${item.subtype}\n${item.title}\n${item.detail}`
        : "";
  const normalized = text.toLowerCase();
  return (
    normalized.includes("permission required") ||
    normalized.includes("permission approved") ||
    normalized.includes("permission denied") ||
    normalized.includes("permission approval required") ||
    normalized.includes("需要授权") ||
    normalized.includes("已允许") ||
    normalized.includes("已拒绝") ||
    normalized.includes("permission_request") ||
    normalized.includes("permission_response")
  );
}

function permissionInputPreview(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }
  const record = input as Record<string, unknown>;
  const candidates = [
    record.command,
    record.cmd,
    record.file_path,
    record.filePath,
    record.path,
    record.pattern,
    record.query,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return truncateProcessDetail(candidate, 900);
    }
  }
  try {
    return truncateProcessDetail(JSON.stringify(input, null, 2), 900);
  } catch {
    return "";
  }
}

function permissionToolNameFromEvent(event: AgentReplStreamEvent): string {
  const rawJson = isRecord(event.payload.raw_json) ? event.payload.raw_json : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  const candidate =
    event.payload.toolName ??
    event.payload.tool_name ??
    request.toolName ??
    request.tool_name ??
    (isRecord(request.request) ? request.request.toolName ?? request.request.tool_name : undefined);
  return typeof candidate === "string" && candidate.trim() ? candidate : "tool";
}

function permissionRequestIdFromEvent(event: AgentReplStreamEvent): string {
  const rawJson = isRecord(event.payload.raw_json) ? event.payload.raw_json : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  const candidate =
    event.payload.requestId ??
    event.payload.request_id ??
    rawJson.request_id ??
    request.request_id;
  return typeof candidate === "string" ? candidate : "";
}

function permissionInputFromEvent(event: AgentReplStreamEvent): unknown {
  const rawJson = isRecord(event.payload.raw_json) ? event.payload.raw_json : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  return event.payload.input ?? request.input ?? (isRecord(request.request) ? request.request.input : undefined);
}

function payloadText(event: AgentReplStreamEvent): string {
  const text = event.payload.text;
  if (typeof text === "string") {
    return text;
  }
  const message = event.payload.message;
  if (typeof message === "string") {
    return message;
  }
  return "";
}

const pendingAssistantText = "Waiting for JSON REPL events...";

function lastMessageIndexByRole(
  items: StreamItem[],
  role: "user" | "assistant",
): number {
  const reverseIndex = [...items]
    .reverse()
    .findIndex((item) => item.kind === "message" && item.role === role);
  return reverseIndex < 0 ? -1 : items.length - 1 - reverseIndex;
}

function currentTurnAssistantMessageIndex(items: StreamItem[]): number {
  const lastUserIndex = lastMessageIndexByRole(items, "user");

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== "message") {
      continue;
    }
    if (item.role === "user") {
      break;
    }
    if (item.role === "assistant" && index > lastUserIndex) {
      return index;
    }
  }

  return -1;
}

function mergeProgressText(existing: string | undefined, nextText: string): string {
  const next = nextText.trim();
  if (!next) {
    return existing?.trim() ?? "";
  }
  const current = existing?.trim();
  if (!current || current === pendingAssistantText) {
    return next;
  }
  if (current.endsWith(next)) {
    return current;
  }
  return `${current}\n\n${next}`;
}

function upsertCurrentTurnProgressMessage(
  items: StreamItem[],
  sessionId: string,
  text: string,
): StreamItem[] {
  const progressText = text.trim();
  if (!progressText) {
    return items;
  }

  const currentAssistantIndex = currentTurnAssistantMessageIndex(items);
  if (currentAssistantIndex >= 0) {
    return items.map((item, itemIndex) => {
      if (itemIndex !== currentAssistantIndex || item.kind !== "message") {
        return item;
      }
      const mergedProgress = mergeProgressText(
        item.progressText ?? (item.text === pendingAssistantText ? undefined : item.text),
        progressText,
      );
      return {
        ...item,
        text:
          item.status === "streaming" || item.text === pendingAssistantText
            ? pendingAssistantText
            : item.text,
        links: item.links,
        progressText: mergedProgress,
        status: "streaming",
      };
    });
  }

  return [
    ...items,
    {
      id: `assistant-stream:${sessionId}:${Date.now()}`,
      kind: "message",
      role: "assistant",
      text: pendingAssistantText,
      progressText,
      status: "streaming",
    },
  ];
}

function completeCurrentTurnAssistantMessage(
  items: StreamItem[],
  sessionId: string,
  text: string,
): StreamItem[] {
  const finalText = text.trim();
  if (!finalText) {
    return items;
  }

  const currentAssistantIndex = currentTurnAssistantMessageIndex(items);
  if (currentAssistantIndex >= 0) {
    return items.map((item, itemIndex) => {
      if (itemIndex !== currentAssistantIndex || item.kind !== "message") {
        return item;
      }
      const progressText = item.progressText?.trim();
      return {
        ...item,
        text: finalText,
        links: extractPreviewLinks(finalText),
        progressText:
          progressText && progressText !== finalText ? progressText : undefined,
        status: "complete",
      };
    });
  }

  return [
    ...items,
    {
      id: `assistant-result:${sessionId}:${Date.now()}`,
      kind: "message",
      role: "assistant",
      text: finalText,
      links: extractPreviewLinks(finalText),
      status: "complete",
    },
  ];
}

function assistantMessageTextForProgress(
  item: Extract<StreamItem, { kind: "message" }>,
): string {
  return item.text === pendingAssistantText ? "" : item.text.trim();
}

function collapseAssistantTurns(items: StreamItem[]): StreamItem[] {
  const collapsed: StreamItem[] = [];

  for (const item of items) {
    if (item.kind !== "message" || item.role !== "assistant") {
      collapsed.push(item);
      continue;
    }

    const existingIndex = currentTurnAssistantMessageIndex(collapsed);
    if (existingIndex < 0) {
      collapsed.push(item);
      continue;
    }

    const existing = collapsed[existingIndex];
    if (existing.kind !== "message" || existing.role !== "assistant") {
      collapsed.push(item);
      continue;
    }

    const existingFinalText = assistantMessageTextForProgress(existing);
    const incomingFinalText = assistantMessageTextForProgress(item);
    let progressText = existing.progressText;

    if (existingFinalText && incomingFinalText && existingFinalText !== incomingFinalText) {
      progressText = mergeProgressText(progressText, existingFinalText);
    }
    if (item.progressText) {
      progressText = mergeProgressText(progressText, item.progressText);
    }

    const nextText = incomingFinalText || existing.text;
    const normalizedProgress = progressText?.trim();

    collapsed[existingIndex] = {
      ...existing,
      text: nextText,
      links: incomingFinalText ? extractPreviewLinks(incomingFinalText) : existing.links,
      progressText:
        normalizedProgress && normalizedProgress !== nextText
          ? normalizedProgress
          : undefined,
      status: item.status ?? existing.status,
    };
  }

  return collapsed;
}

function streamEventToItems(
  items: StreamItem[],
  event: AgentReplStreamEvent,
): StreamItem[] {
  if (isPermissionEventName(event.eventType)) {
    return items;
  }
  const baseId = `repl:${event.sessionId}:${Date.now()}`;
  switch (event.eventType) {
    case "raw_json":
    case "process_status":
      return items;
    case "startup":
      return items;
    case "turn_text":
      return upsertCurrentTurnProgressMessage(
        items,
        event.sessionId,
        payloadText(event),
      );
    case "tool_call":
    case "tool_result":
      // Tool and command details are attached to the current assistant turn's
      // folded process panel via the per-message debug bundle. Rendering them
      // as separate stream items makes one model turn look like many answers.
      return items;
    case "turn_complete": {
      const finalText = payloadText(event);
      return finalText
        ? completeCurrentTurnAssistantMessage(items, event.sessionId, finalText)
        : items;
    }
    case "process_exit":
      return items;
    case "stderr":
    case "error":
      return [
        ...items,
        {
          id: baseId,
          kind: "system",
          subtype: "error",
          title: event.eventType === "stderr" ? "Runtime log" : "Turn failed",
          detail: payloadText(event) || JSON.stringify(event.payload),
        },
      ];
    default:
      return items;
  }
}

export function App() {
  const [projects, setProjects] = useState<ProjectFolder[]>([]);
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [sessionStreams, setSessionStreams] = useState<
    Record<string, StreamItem[]>
  >({});
  const [sessionDebugEvents, setSessionDebugEvents] = useState<
    Record<string, DebugStreamEvent[]>
  >({});
  const [assistantDebugBundles, setAssistantDebugBundles] = useState<
    Record<string, AssistantMessageDebugBundle>
  >(() => loadAssistantDebugBundles());
  const [copiedDebugMessageId, setCopiedDebugMessageId] = useState<string | null>(
    null,
  );
  const [openAssistantDebugMessageId, setOpenAssistantDebugMessageId] =
    useState<string | null>(null);
  const [openProcessMessageIds, setOpenProcessMessageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const assistantDebugClickTimer = useRef<number | null>(null);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [hiddenSessions, setHiddenSessions] = useState<HiddenSession[]>(() =>
    loadHiddenSessions(),
  );
  const [openSessionMenu, setOpenSessionMenu] = useState<{
    root: string;
    sessionId: string;
  } | null>(null);
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const promptHighlightRef = useRef<HTMLDivElement | null>(null);
  const [fileReferences, setFileReferences] = useState<LocalFileReference[]>([]);
  const [fileMention, setFileMention] = useState<FileMentionState>({
    active: false,
    query: "",
    start: 0,
    end: 0,
  });
  const [fileSuggestions, setFileSuggestions] = useState<WorkspaceFileReference[]>([]);
  const [fileSuggestionIndex, setFileSuggestionIndex] = useState(0);
  const [isSearchingFiles, setIsSearchingFiles] = useState(false);
  const [slashCommandMenu, setSlashCommandMenu] = useState<SlashCommandMenuState>({
    active: false,
    level: "root",
    query: "",
    start: 0,
    end: 0,
    selectedIndex: 0,
    skills: [],
    commands: [],
    isLoadingSkills: false,
  });
  const [isResolvingFileReferences, setIsResolvingFileReferences] = useState(false);
  const [permissionState, setPermissionState] =
    useState<AgentPermissionState | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AppView>("workspace");
  const [isRunningTurn, setIsRunningTurn] = useState(false);
  const [isInterruptingTurn, setIsInterruptingTurn] = useState(false);
  const [pendingPermissions, setPendingPermissions] = useState<
    Array<{
      root: string;
      sessionId: string;
      messageId: string;
      requestId: string;
      prompt: string;
      toolName?: string;
      input?: unknown;
      rawJson?: unknown;
    }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [chatModelOptions, setChatModelOptions] = useState<string[]>([
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ]);
  const [selectedChatModel, setSelectedChatModel] =
    useState<string>("deepseek-v4-flash");

  const promptImeStateRef = useRef({
    isComposing: false,
    blockSubmitUntil: 0,
  });

  const pendingPermission = activeSessionId
    ? (pendingPermissions.find((permission) => permission.sessionId === activeSessionId) ?? null)
    : null;

  const activePreview =
    previewTabs.find((tab) => tab.id === activePreviewId) ??
    previewTabs[0] ??
    null;
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;
  const streamItems = activeSessionId
    ? collapseAssistantTurns(sessionStreams[activeSessionId] ?? [])
    : [];
  const debugEvents = activeSessionId
    ? (sessionDebugEvents[activeSessionId] ?? [])
    : [];
  const canSendPrompt = Boolean(
    (prompt.trim() || fileReferences.length > 0) &&
    activeProject &&
    activeSessionId &&
    !isRunningTurn &&
    !pendingPermission &&
    !isResolvingFileReferences,
  );

  function enqueuePendingPermission(permission: (typeof pendingPermissions)[number]) {
    if (!permission.requestId) {
      return;
    }

    setPendingPermissions((current) => {
      const existingIndex = current.findIndex(
        (item) =>
          item.sessionId === permission.sessionId &&
          item.requestId === permission.requestId,
      );

      if (existingIndex >= 0) {
        const next = current.slice();
        next[existingIndex] = permission;
        return next;
      }

      return [...current, permission];
    });
  }

  function removePendingPermission(sessionId: string, requestId: string) {
    setPendingPermissions((current) =>
      current.filter(
        (permission) =>
          permission.sessionId !== sessionId ||
          permission.requestId !== requestId,
      ),
    );
  }

  function clearPendingPermissionsForSession(sessionId: string) {
    setPendingPermissions((current) =>
      current.filter((permission) => permission.sessionId !== sessionId),
    );
  }
  const promptSkillToken = useMemo(() => extractPromptSkillToken(prompt), [prompt]);
  const slashRootOptions = useMemo(() => {
    const query = slashCommandMenu.query.trim().toLowerCase();
    if (!query) return slashRootItems;
    return slashRootItems.filter((item) =>
      `${item.label} ${item.description} ${item.id}`.toLowerCase().includes(query),
    );
  }, [slashCommandMenu.query]);
  const filterCapabilityItems = (items: AgentReplCapabilityItem[]) => {
    const query = slashCommandMenu.query.trim().toLowerCase();
    return items.filter((item) => {
      if (!query) return true;
      return [item.name, item.slash, item.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  };
  const slashSkillOptions = useMemo(
    () => filterCapabilityItems(slashCommandMenu.skills),
    [slashCommandMenu.query, slashCommandMenu.skills],
  );
  const slashCommandOptions = useMemo(
    () => filterCapabilityItems(slashCommandMenu.commands),
    [slashCommandMenu.query, slashCommandMenu.commands],
  );
  const slashLeafOptions = slashCommandMenu.level === "commands" ? slashCommandOptions : slashSkillOptions;
  const slashLeafTitle = slashCommandMenu.level === "commands" ? "Commands" : "Skills";
  const slashLeafDescription =
    slashCommandMenu.level === "commands" ? "选择后插入 /command" : "选择后插入 /skill-name";
  const slashLeafEmptyText =
    slashCommandMenu.level === "commands" ? "没有可用 command" : "没有可用 skill";

  const activeSessionTitle = useMemo(() => {
    for (const folder of projects) {
      const session = folder.sessions.find(
        (candidate) => candidate.id === activeSessionId,
      );
      if (session) {
        return session.title;
      }
    }
    return "未选择会话";
  }, [activeSessionId, projects]);

  useEffect(() => {
    window.localStorage.setItem(
      hiddenSessionsStorageKey,
      JSON.stringify(uniqueHiddenSessions(hiddenSessions)),
    );
  }, [hiddenSessions]);

  useEffect(() => {
    persistAssistantDebugBundles(assistantDebugBundles);
  }, [assistantDebugBundles]);

  useEffect(() => {
    let cancelled = false;
    getAgentPermissionState()
      .then((state) => {
        if (!cancelled) {
          setPermissionState(state);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadWorkspaceRegistry()
      .then(async (registry) => {
        const loadedProjects = await Promise.all(
          registry.workspaces.map(async (workspace) => {
            const sessions = await listRuntimeSessions(workspace.root);
            return {
              id: projectIdFromRoot(workspace.root),
              name: workspace.name,
              root: workspace.root,
              sessions: sessionsFromRuntimeSummaries(
                workspace.root,
                sessions,
                hiddenSessions,
              ),
            } satisfies ProjectFolder;
          }),
        );
        if (cancelled) {
          return;
        }
        setProjects(loadedProjects);
        const firstProject = loadedProjects[0] ?? null;
        const firstSessionId = firstProject?.sessions[0]?.id ?? null;
        if (firstProject && firstSessionId) {
          setExpandedFolders(new Set([firstProject.id]));
          setActiveProjectId(firstProject.id);
          setActiveSessionId(firstSessionId);
          setSessionStreams((streams) => ({
            ...streams,
            [firstSessionId]:
              streams[firstSessionId] ??
              welcomeStream(
                firstProject.name,
                firstProject.sessions[0]?.title ?? "会话",
              ),
          }));
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadModelSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        const deepseek = settings.models.find(
          (model) => model.provider === "deepseek",
        );
        const options = (deepseek?.supportModels ?? []).filter(Boolean);
        if (options.length > 0) {
          setChatModelOptions(options);
          setSelectedChatModel(
            options.includes("deepseek-v4-flash")
              ? "deepseek-v4-flash"
              : options[0],
          );
        } else {
          setChatModelOptions(["deepseek-v4-flash", "deepseek-v4-pro"]);
          setSelectedChatModel("deepseek-v4-flash");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChatModelOptions(["deepseek-v4-flash", "deepseek-v4-pro"]);
          setSelectedChatModel("deepseek-v4-flash");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);



  // Load slash commands and skills from the current runtime process.
  useEffect(() => {
    if (
      !slashCommandMenu.active ||
      (slashCommandMenu.level !== "skills" && slashCommandMenu.level !== "commands") ||
      !activeProject ||
      !activeSessionId
    ) {
      return;
    }

    let cancelled = false;
    setSlashCommandMenu((current) => ({ ...current, isLoadingSkills: true, error: undefined }));

    ensureAgentReplProcess(activeProject.root, activeSessionId, selectedChatModel, permissionState?.permissionMode ?? "workspace-write")
      .then((state) => getAgentReplCapabilities(activeProject.root, state.sessionId || activeSessionId))
      .then((capabilities) => {
        if (cancelled) return;
        setSlashCommandMenu((current) => ({
          ...current,
          commands: capabilities.commands ?? [],
          skills: capabilities.skills ?? [],
          selectedIndex: 0,
          isLoadingSkills: false,
        }));
      })
      .catch((reason) => {
        if (cancelled) return;
        setSlashCommandMenu((current) => ({
          ...current,
          commands: [],
          skills: [],
          selectedIndex: 0,
          isLoadingSkills: false,
          error: String(reason),
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    slashCommandMenu.active,
    slashCommandMenu.level,
    activeProject?.root,
    activeSessionId,
    selectedChatModel,
  ]);

  useEffect(() => {
    if (!fileMention.active || !activeProject) {
      setFileSuggestions([]);
      setFileSuggestionIndex(0);
      setIsSearchingFiles(false);
      return;
    }

    let cancelled = false;
    setIsSearchingFiles(true);
    const timer = window.setTimeout(() => {
      searchWorkspaceFiles(activeProject.root, fileMention.query, 12)
        .then((results) => {
          if (cancelled) {
            return;
          }
          setFileSuggestions(results);
          setFileSuggestionIndex(0);
        })
        .catch((reason) => {
          if (!cancelled) {
            setError(`Search workspace files failed: ${String(reason)}`);
            setFileSuggestions([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsSearchingFiles(false);
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeProject, fileMention.active, fileMention.query]);

  function toggleFolder(folderId: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

  function updateSessionStream(
    sessionId: string,
    updater: (items: StreamItem[]) => StreamItem[],
  ) {
    setSessionStreams((streams) => ({
      ...streams,
      [sessionId]: collapseAssistantTurns(updater(streams[sessionId] ?? [])),
    }));
  }

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenAgentReplEvents((event) => {
      const realSessionId =
        event.eventType === "turn_complete"
          ? realSessionIdFromEvent(event)
          : null;

      const debugEntry = createDebugEvent(event);
      setSessionDebugEvents((events) => appendDebugEvent(events, debugEntry));
      setAssistantDebugBundles((bundles) =>
        updateAssistantDebugBundleForEvent(bundles, event, debugEntry),
      );
      updateSessionStream(event.sessionId, (items) =>
        streamEventToItems(items, event),
      );

      if (event.eventType === "permission_request" || event.eventType === "control_request") {
        const toolName = permissionToolNameFromEvent(event);
        const requestId = permissionRequestIdFromEvent(event);
        const input = permissionInputFromEvent(event);
        const promptText = String(
          event.payload.prompt ?? `${toolName} requests permission`,
        );

        enqueuePendingPermission({
          root: event.root,
          sessionId: event.sessionId,
          messageId: `permission:${event.sessionId}:${requestId || Date.now()}`,
          requestId,
          prompt: promptText,
          toolName,
          input,
          rawJson: event.payload.raw_json ?? event.payload,
        });
        setIsRunningTurn(false);
      }

      if (
        event.eventType === "startup" ||
        event.eventType === "process_status"
      ) {
        const pid =
          typeof event.payload.pid === "number" ? event.payload.pid : undefined;
        const running =
          event.eventType === "startup" ? true : event.payload.running === true;
        setProjects((folders) =>
          folders.map((folder) => ({
            ...folder,
            sessions: folder.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    processStatus: running ? "active" : "stopped",
                    processPid: running ? pid : undefined,
                  }
                : session,
            ),
          })),
        );
      }

      if (realSessionId && realSessionId !== event.sessionId) {
        setSessionStreams((streams) => {
          const oldItems = streams[event.sessionId] ?? [];
          const existingNewItems = streams[realSessionId] ?? [];
          const { [event.sessionId]: _removed, ...rest } = streams;

          return {
            ...rest,
            [realSessionId]:
              existingNewItems.length > 0 ? existingNewItems : oldItems,
          };
        });
        setSessionDebugEvents((events) =>
          rekeyDebugEvents(events, event.sessionId, realSessionId),
        );
        setAssistantDebugBundles((bundles) =>
          rekeyAssistantDebugBundles(bundles, event.sessionId, realSessionId),
        );

        const pid =
          typeof event.payload.pid === "number" ? event.payload.pid : undefined;
        setProjects((folders) =>
          folders.map((folder) => {
            const sessions = folder.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    id: realSessionId,
                    isPending: false,
                    processStatus: "active" as const,
                    processPid: pid ?? session.processPid,
                  }
                : session,
            );
            return {
              ...folder,
              sessions: dedupeSessions(sessions),
            };
          }),
        );

        setActiveSessionId((current) =>
          current === event.sessionId ? realSessionId : current,
        );
      }

      if (
        event.eventType === "turn_complete" ||
        event.eventType === "error" ||
        event.eventType === "interrupt" ||
        event.eventType === "process_exit"
      ) {
        setIsRunningTurn(false);
        clearPendingPermissionsForSession(event.sessionId);
      }

      if (event.eventType === "process_exit") {
        setProjects((folders) =>
          folders.map((folder) => ({
            ...folder,
            sessions: folder.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    processStatus: "stopped",
                    processPid: undefined,
                  }
                : session,
            ),
          })),
        );
      }

      if (event.eventType === "stderr") {
        const detail = String(
          event.payload?.text ?? event.payload?.message ?? "",
        ).toLowerCase();
        if (detail.includes("repl process stdout closed")) {
          setProjects((folders) =>
            folders.map((folder) => ({
              ...folder,
              sessions: folder.sessions.map((session) =>
                session.id === event.sessionId
                  ? {
                      ...session,
                      processStatus: "stopped",
                      processPid: undefined,
                    }
                  : session,
              ),
            })),
          );
        }
        if (
          detail.includes("error") ||
          detail.includes("failed") ||
          detail.includes("missing_credentials")
        ) {
          setIsRunningTurn(false);
          clearPendingPermissionsForSession(event.sessionId);
        }
      }
    })
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((reason) => setError(String(reason)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function selectSession(project: ProjectFolder, sessionId: string) {
    console.log("[debug-session] selectSession called", {
      projectId: project.id,
      projectRoot: project.root,
      sessionId,
    });
    const sessionTitle =
      project.sessions.find((session) => session.id === sessionId)?.title ??
      "会话";
    setActiveView("workspace");
    setActiveProjectId(project.id);
    setActiveSessionId(sessionId);
    setSessionStreams((streams) => ({
      ...streams,
      [sessionId]:
        streams[sessionId] ?? welcomeStream(project.name, sessionTitle),
    }));

    if (!isNewSessionId(sessionId)) {
      getAgentReplProcessStatus(project.root, sessionId)
        .then((status) => {
          setProjects((folders) =>
            folders.map((folder) =>
              folder.id === project.id
                ? {
                    ...folder,
                    sessions: folder.sessions.map((session) =>
                      session.id === sessionId
                        ? {
                            ...session,
                            processStatus: status.running
                              ? "active"
                              : "stopped",
                            processPid: status.pid ?? undefined,
                          }
                        : session,
                    ),
                  }
                : folder,
            ),
          );
        })
        .catch((reason) => setError(String(reason)));
    }
  }

  useEffect(() => {
    if (
      !activeProject ||
      !activeSessionId ||
      isRunningTurn ||
      pendingPermission?.sessionId === activeSessionId
    ) {
      return;
    }
    const activeSession = activeProject.sessions.find(
      (session) => session.id === activeSessionId,
    );
    if (activeSession?.isPending) {
      return;
    }
    let cancelled = false;
    loadTypedRuntimeSession(activeProject.root, activeSessionId)
      .then((detail) => {
        if (cancelled) {
          return;
        }
        const artifacts = runtimeSessionToArtifacts(detail, activeProject.root);
        setAssistantDebugBundles((bundles) => ({
          ...bundles,
          ...artifacts.bundles,
        }));
        setSessionStreams((streams) => {
          const existingItems = streams[activeSessionId] ?? [];

          // Do not overwrite a live in-memory conversation after a turn completes.
          // The in-memory stream keeps stable message IDs for per-answer Debug and
          // already collapses Claude Code progress messages into one assistant
          // bubble. Disk jsonl reloads are used only when opening a session that
          // has not been rendered in this UI instance yet.
          if (existingItems.length > 0) {
            return streams;
          }

          return {
            ...streams,
            [activeSessionId]:
              detail.messages.length > 0
                ? collapseAssistantTurns(artifacts.items)
                : welcomeStream(activeProject.name, activeSessionTitle),
          };
        });
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeProject,
    activeSessionId,
    activeSessionTitle,
    isRunningTurn,
    pendingPermission,
  ]);

  async function handleAddProject() {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Add project folder",
      });
      if (typeof selected !== "string") {
        return;
      }

      const workspace = await openWorkspace(selected);
      await addWorkspaceRegistryEntry(workspace.root);
      const projectId = projectIdFromRoot(workspace.root);
      const existingSessions = await listRuntimeSessions(workspace.root);
      const initialSessions = sessionsFromRuntimeSummaries(
        workspace.root,
        existingSessions,
        hiddenSessions,
      );
      const firstSessionId = initialSessions[0]?.id ?? null;
      if (!firstSessionId) {
        throw new Error("failed to initialize runtime session");
      }
      const nextProject: ProjectFolder = {
        id: projectId,
        name: workspace.name || `文件夹${projects.length + 1}`,
        root: workspace.root,
        sessions: initialSessions,
      };

      setProjects((currentProjects) => {
        const existing = currentProjects.find(
          (project) => project.id === projectId,
        );
        if (existing) {
          return currentProjects;
        }
        return [...currentProjects, nextProject];
      });
      setExpandedFolders((folders) => new Set(folders).add(projectId));
      setActiveView("workspace");
      setActiveProjectId(projectId);
      setActiveSessionId(firstSessionId);
      setSessionStreams((streams) => ({
        ...streams,
        [firstSessionId]:
          streams[firstSessionId] ??
          welcomeStream(
            nextProject.name,
            nextProject.sessions[0]?.title ?? "新会话",
          ),
      }));
      setPreviewTabs([]);
      setActivePreviewId(null);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  function handleCreateSession(project: ProjectFolder) {
    const pendingSession = createPendingSession();
    setProjects((currentProjects) =>
      currentProjects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              sessions: [...candidate.sessions, pendingSession],
            }
          : candidate,
      ),
    );
    setExpandedFolders((folders) => new Set(folders).add(project.id));
    setActiveView("workspace");
    setActiveProjectId(project.id);
    setActiveSessionId(pendingSession.id);
    setSessionStreams((streams) => ({
      ...streams,
      [pendingSession.id]: welcomeStream(project.name, pendingSession.title),
    }));
    setPreviewTabs([]);
    setActivePreviewId(null);
    setError(null);
  }


  async function killSessionProcessBestEffort(root: string, sessionId: string) {
    try {
      await killAgentReplProcess(root, sessionId);
    } catch (reason) {
      console.warn("Failed to kill session process", { root, sessionId, reason });
    }

    setProjects((folders) =>
      folders.map((folder) =>
        folder.root === root
          ? {
              ...folder,
              sessions: folder.sessions.map((candidate) =>
                candidate.id === sessionId
                  ? {
                      ...candidate,
                      processStatus: "stopped",
                      processPid: undefined,
                    }
                  : candidate,
              ),
            }
          : folder,
      ),
    );
  }

  async function handleHideSession(project: ProjectFolder, session: ProjectSession) {
    await killSessionProcessBestEffort(project.root, session.id);
    const hiddenRecord: HiddenSession = {
      root: project.root,
      projectName: project.name,
      sessionId: session.id,
      title: session.title || session.id,
      hiddenAt: Date.now(),
    };
    const remainingSessions = project.sessions.filter(
      (candidate) => candidate.id !== session.id,
    );
    const fallbackSession = remainingSessions[0] ?? createPendingSession();
    const nextSessions =
      remainingSessions.length > 0 ? remainingSessions : [fallbackSession];

    setHiddenSessions((current) =>
      uniqueHiddenSessions([
        hiddenRecord,
        ...current.filter(
          (item) =>
            sessionKey(item.root, item.sessionId) !==
            sessionKey(project.root, session.id),
        ),
      ]),
    );
    setProjects((currentProjects) =>
      currentProjects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              sessions: nextSessions,
            }
          : candidate,
      ),
    );
    setOpenSessionMenu(null);

    if (activeSessionId === session.id) {
      setActiveProjectId(project.id);
      setActiveSessionId(fallbackSession.id);
      setSessionStreams((streams) => ({
        ...streams,
        [fallbackSession.id]:
          streams[fallbackSession.id] ??
          welcomeStream(project.name, fallbackSession.title),
      }));
    }
  }

  async function handleRestoreHiddenSession(hiddenSession: HiddenSession) {
    setHiddenSessions((current) =>
      current.filter(
        (item) =>
          sessionKey(item.root, item.sessionId) !==
          sessionKey(hiddenSession.root, hiddenSession.sessionId),
      ),
    );

    const project = projects.find(
      (candidate) => candidate.root === hiddenSession.root,
    );
    if (!project) {
      return;
    }

    let restoredTitle = hiddenSession.title || hiddenSession.sessionId;
    try {
      const runtimeSessions = await listRuntimeSessions(hiddenSession.root);
      const runtimeSession = runtimeSessions.find(
        (session) => session.id === hiddenSession.sessionId,
      );
      if (runtimeSession?.title) {
        restoredTitle = runtimeSession.title;
      }
    } catch {
      // Restoring visibility should still work even if the jsonl list cannot be refreshed immediately.
    }

    const restoredSession: ProjectSession = {
      id: hiddenSession.sessionId,
      title: restoredTitle,
      isPending: isNewSessionId(hiddenSession.sessionId),
      processStatus: "stopped",
    };

    setProjects((currentProjects) =>
      currentProjects.map((candidate) => {
        if (candidate.id !== project.id) {
          return candidate;
        }
        if (
          candidate.sessions.some(
            (session) => session.id === hiddenSession.sessionId,
          )
        ) {
          return candidate;
        }
        return {
          ...candidate,
          sessions: dedupeSessions([restoredSession, ...candidate.sessions]),
        };
      }),
    );
    setExpandedFolders((folders) => new Set(folders).add(project.id));
    setActiveView("workspace");
    setActiveProjectId(project.id);
    setActiveSessionId(hiddenSession.sessionId);
    setSessionStreams((streams) => ({
      ...streams,
      [hiddenSession.sessionId]:
        streams[hiddenSession.sessionId] ??
        welcomeStream(project.name, restoredTitle),
    }));
  }

  function upsertPreviewTab(tab: PreviewTab) {
    setPreviewTabs((tabs) => {
      const nextTabs = tabs.filter((candidate) => candidate.id !== tab.id);
      return [...nextTabs, tab];
    });
    setActivePreviewId(tab.id);
  }

  function closePreviewTab(id: string) {
    setPreviewTabs((tabs) => {
      const nextTabs = tabs.filter((tab) => tab.id !== id);
      if (activePreviewId === id) {
        setActivePreviewId(nextTabs[nextTabs.length - 1]?.id ?? null);
      }
      return nextTabs;
    });
  }

  async function handleOpenPreviewLink(link: StreamLink) {
    if (!activeProject) {
      setError("Add a project folder first.");
      return;
    }

    if (link.kind === "pdf" || link.kind === "image") {
      upsertPreviewTab({
        id: `reference:${link.path}`,
        kind: "reference",
        title: link.label,
        link,
      });
      return;
    }


    if (shouldReadAsLocalReference(link)) {
      try {
        const file = await readLocalReferenceFile(activeProject.root, link.path);
        upsertPreviewTab({
          id: `local-reference:${file.path}`,
          kind: "file",
          title: file.path,
          file,
          diff: { path: file.path, diff: "", is_empty: true },
        });
      } catch (reason) {
        setError(`Read referenced file failed: ${String(reason)}`);
      }
      return;
    }

    try {
      const [file, diff] = await Promise.all([
        readWorkspaceFile(activeProject.root, link.path),
        readGitDiff(activeProject.root, link.path),
      ]);
      upsertPreviewTab({
        id: `file:${file.path}`,
        kind: "file",
        title: file.path,
        file,
        diff,
      });
    } catch (reason) {
      setError(String(reason));
    }
  }

  function assistantDebugPayload(
    item: Extract<StreamItem, { kind: "message" }>,
    action: "view" | "copy",
  ) {
    const bundle = assistantDebugBundles[item.id];
    const details = assistantTurnDetails(item, bundle ?? null);
    return {
      kind: "agent-ui.assistant-message-debug",
      action,
      generatedAt: new Date().toISOString(),
      sessionId: bundle?.sessionId ?? activeSessionId,
      root: bundle?.root ?? activeProject?.root ?? null,
      messageId: item.id,
      userMessage: bundle?.userMessage ?? null,
      transportMessage: bundle?.transportMessage ?? null,
      referencedFiles: bundle?.fileReferences ?? item.fileReferences ?? null,
      displayedMessage: item.text,
      displayedProgressText: item.progressText ?? null,
      displayStatus: item.status ?? null,
      summary: {
        progressLineCount: details.progressLines.length,
        commandCount: details.commandUses.length,
        toolUseCount: details.toolUses.length,
        toolResultCount: details.toolResults.length,
        eventCount: details.eventCount,
      },
      commands: details.commandUses.map((tool) => ({
        name: toolName(tool),
        command: commandFromToolUse(tool),
        raw: tool,
      })),
      toolUses: details.toolUses.map((tool) => ({
        name: toolName(tool),
        summary: summarizeToolUse(tool),
        raw: tool,
      })),
      bundleDisplayText: bundle?.displayText ?? null,
      completed: bundle?.completed ?? null,
      eventCount: bundle?.events.length ?? 0,
      events: (bundle?.events ?? []).map((event) => ({
        eventType: event.eventType,
        receivedAt: new Date(event.receivedAt).toISOString(),
        payload: event.payload,
      })),
    };
  }

  function handleToggleAssistantProcess(messageId: string) {
    setOpenProcessMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  function handleViewAssistantDebug(messageId: string) {
    if (assistantDebugClickTimer.current !== null) {
      window.clearTimeout(assistantDebugClickTimer.current);
    }

    assistantDebugClickTimer.current = window.setTimeout(() => {
      setOpenAssistantDebugMessageId((current) =>
        current === messageId ? null : messageId,
      );
      assistantDebugClickTimer.current = null;
    }, 220);
  }

  async function handleCopyAssistantDebug(
    item: Extract<StreamItem, { kind: "message" }>,
  ) {
    if (assistantDebugClickTimer.current !== null) {
      window.clearTimeout(assistantDebugClickTimer.current);
      assistantDebugClickTimer.current = null;
    }

    try {
      await copyTextToClipboard(
        JSON.stringify(assistantDebugPayload(item, "copy"), null, 2),
      );
      setCopiedDebugMessageId(item.id);
      setCopyToast("已复制本条 AI 回复的 Debug JSON");
      window.setTimeout(() => {
        setCopiedDebugMessageId((current) =>
          current === item.id ? null : current,
        );
        setCopyToast(null);
      }, 1600);
    } catch (reason) {
      setError(`Copy debug JSON failed: ${String(reason)}`);
    }
  }

  function updateFileMentionFromInput(value: string, cursor: number) {
    setFileMention(detectFileMention(value, cursor));
  }

  function updateSlashCommandMenuFromInput(value: string, cursor: number) {
    const fileState = detectFileMention(value, cursor);
    if (fileState.active) {
      setSlashCommandMenu((current) => ({ ...current, active: false }));
      return;
    }

    const slashState = detectSlashCommandMenu(value, cursor);
    if (!slashState.active) {
      setSlashCommandMenu((current) => ({ ...current, active: false }));
      return;
    }

    setSlashCommandMenu((current) => ({
      ...current,
      active: true,
      level: current.active && current.start === slashState.start ? current.level : "root",
      query: slashState.query,
      start: slashState.start,
      end: slashState.end,
      selectedIndex: current.active && current.start === slashState.start ? current.selectedIndex : 0,
    }));
  }

  function handlePromptChange(value: string, cursor: number) {
    setPrompt(value);
    updateFileMentionFromInput(value, cursor);
    updateSlashCommandMenuFromInput(value, cursor);
  }

  function closeFileSuggestions() {
    setFileMention((current) => ({
      ...current,
      active: false,
      query: "",
    }));
    setFileSuggestions([]);
    setFileSuggestionIndex(0);
  }

  function closeSlashCommandMenu() {
    setSlashCommandMenu((current) => ({
      ...current,
      active: false,
      level: "root",
      query: "",
      selectedIndex: 0,
      error: undefined,
    }));
  }

  function selectSlashRootItem(item: SlashRootItem) {
    if (item.disabled) return;
    if (item.id === "skills" || item.id === "commands") {
      setSlashCommandMenu((current) => ({
        ...current,
        level: item.id,
        query: "",
        selectedIndex: 0,
      }));
    }
  }

  function selectSlashItem(item: AgentReplCapabilityItem) {
    const insertion = `${item.slash || `/${item.name}`} `;
    const nextPrompt = `${prompt.slice(0, slashCommandMenu.start)}${insertion}${prompt.slice(slashCommandMenu.end)}`;
    const nextCursor = slashCommandMenu.start + insertion.length;
    setPrompt(nextPrompt);
    closeSlashCommandMenu();
    closeFileSuggestions();
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }


  function addFileReference(reference: WorkspaceFileReference) {
    setFileReferences((current) => {
      if (current.some((item) => item.path === reference.path)) {
        return current;
      }
      return [...current, { ...reference, addedAt: Date.now() }];
    });
  }

  function removeFileReference(path: string) {
    setFileReferences((current) =>
      current.filter((reference) => reference.path !== path),
    );
  }

  function selectFileSuggestion(reference: WorkspaceFileReference) {
    const mention = fileMention;
    const referenceLabel = reference.name || localFileReferenceName(reference.path);
    const insertion = `@${referenceLabel} `;
    const nextPrompt = `${prompt.slice(0, mention.start)}${insertion}${prompt.slice(mention.end)}`;
    const nextCursor = mention.start + insertion.length;

    setPrompt(nextPrompt);
    addFileReference(reference);
    closeFileSuggestions();

    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  async function submitPrompt() {
    const trimmed = prompt.trim();
    if (
      (!trimmed && fileReferences.length === 0) ||
      !activeProject ||
      !activeSessionId ||
      isRunningTurn ||
      pendingPermission ||
      isResolvingFileReferences
    ) {
      return;
    }

    const referencedFiles = fileReferences;
    const displayPrompt =
      trimmed ||
      `请阅读这些引用文件：${referencedFiles.map((reference) => `@${reference.path}`).join(", ")}`;
    const pendingId = `assistant-pending-${Date.now()}`;
    const targetSessionId = activeSessionId;
    let inputForClaude = displayPrompt;
    let injectedFileReferences: LocalFileReferenceSummary[] = [];

    setIsResolvingFileReferences(true);
    try {
      const referencePayload = await buildPromptWithLocalFileReferences(
        activeProject.root,
        displayPrompt,
        referencedFiles,
      );
      inputForClaude = referencePayload.prompt;
      injectedFileReferences = referencePayload.fileReferences;
    } catch (reason) {
      setError(`Read referenced files failed: ${String(reason)}`);
      setIsResolvingFileReferences(false);

      return;
    }
    setIsResolvingFileReferences(false);

    setAssistantDebugBundles((bundles) => ({
      ...bundles,
      [pendingId]: {
        messageId: pendingId,
        sessionId: targetSessionId,
        root: activeProject.root,
        userMessage: displayPrompt,
        transportMessage: inputForClaude,
        fileReferences: injectedFileReferences.length > 0 ? injectedFileReferences : undefined,
        displayText: pendingAssistantText,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        completed: false,
        events: [],
      },
    }));

    if (
      activeProject.sessions.find((session) => session.id === targetSessionId)
        ?.isPending
    ) {
      const nextTitle = truncateSessionTitle(displayPrompt);
      setProjects((folders) =>
        folders.map((folder) =>
          folder.id === activeProject.id
            ? {
                ...folder,
                sessions: folder.sessions.map((session) =>
                  session.id === targetSessionId
                    ? { ...session, title: nextTitle }
                    : session,
                ),
              }
            : folder,
        ),
      );
    }
    updateSessionStream(targetSessionId, (items) => [
      ...items,
      {
        id: `user-${Date.now()}`,
        kind: "message",
        role: "user",
        text: displayPrompt,
        links: [],
        fileReferences: injectedFileReferences.length > 0 ? injectedFileReferences : undefined,
      },
      {
        id: pendingId,
        kind: "message",
        role: "assistant",
        text: pendingAssistantText,
        status: "streaming",
      },
    ]);
    setPrompt("");
    setFileReferences([]);
    closeFileSuggestions();
    setIsRunningTurn(true);
    setError(null);

    ensureAgentReplProcess(
      activeProject.root,
      targetSessionId,
      selectedChatModel,
      permissionState?.permissionMode ?? "workspace-write",
    )
      .then(() =>
        sendAgentReplInput(activeProject.root, targetSessionId, inputForClaude),
      )
      .catch((reason) => {
        setError(String(reason));
        clearPendingPermissionsForSession(targetSessionId);
        updateSessionStream(targetSessionId, (items) =>
          items.map((item) =>
            item.id === pendingId && item.kind === "message"
              ? {
                  ...item,
                  text: `Agent turn failed: ${String(reason)}`,
                  status: "complete",
                }
              : item,
          ),
        );
        setIsRunningTurn(false);
      });
  }

  function handlePermissionDecision(approved: boolean) {
    if (!pendingPermission) {
      return;
    }
    const target = pendingPermission;
    setError(null);
    removePendingPermission(target.sessionId, target.requestId);
    setCopyToast(`${approved ? "已允许" : "已拒绝"} ${target.toolName ?? "tool"}`);
    window.setTimeout(() => setCopyToast(null), 1600);
    setIsRunningTurn(true);
    respondAgentPermission(
      target.root,
      target.sessionId,
      target.requestId,
      approved,
    ).catch((reason) => {
      setError(String(reason));
      enqueuePendingPermission(target);
      setIsRunningTurn(false);
    });
  }

  function handleInterruptTurn() {
    if ((!isRunningTurn && !pendingPermission) || isInterruptingTurn) {
      return;
    }
    setIsInterruptingTurn(true);
    interruptAgentTurn(activeProject?.root ?? "", activeSessionId ?? "")
      .catch((reason) => {
        setError(String(reason));
      })
      .finally(() => {
        if (activeSessionId) {
          clearPendingPermissionsForSession(activeSessionId);
        }
        setIsInterruptingTurn(false);
      });
  }

  function handlePermissionModeChange(nextMode: PermissionMode) {
    if (!activeProject) {
      return;
    }
    setAgentPermissionMode(activeProject.root, nextMode)
      .then((state) => {
        setPermissionState(state);
      })
      .catch((reason) => {
        setError(String(reason));
      });
  }

  function markPromptImeActive(blockMs = 350) {
    promptImeStateRef.current.blockSubmitUntil = Math.max(
      promptImeStateRef.current.blockSubmitUntil,
      performance.now() + blockMs,
    );
  }

  function isPromptSubmitBlockedByIme() {
    return (
      promptImeStateRef.current.isComposing ||
      performance.now() < promptImeStateRef.current.blockSubmitUntil
    );
  }

  function isPromptImeKeyEvent(event: KeyboardEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
      isComposing?: boolean;
      keyCode?: number;
      which?: number;
    };

    return (
      promptImeStateRef.current.isComposing ||
      nativeEvent.isComposing === true ||
      nativeEvent.keyCode === 229 ||
      nativeEvent.which === 229 ||
      event.key === "Process"
    );
  }

  function handlePromptSubmit(event: FormEvent) {
    event.preventDefault();

    if (isPromptSubmitBlockedByIme()) {
      return;
    }

    submitPrompt();
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const isPlainEnter =
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey;

    if (isPlainEnter) {
      if (isPromptImeKeyEvent(event)) {
        return;
      }

      if (isPromptSubmitBlockedByIme()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (slashCommandMenu.active) {
      const options = slashCommandMenu.level === "root" ? slashRootOptions : slashLeafOptions;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashCommandMenu((current) => ({
          ...current,
          selectedIndex: Math.min(current.selectedIndex + 1, Math.max(options.length - 1, 0)),
        }));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashCommandMenu((current) => ({ ...current, selectedIndex: Math.max(current.selectedIndex - 1, 0) }));
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        if (options.length > 0) {
          event.preventDefault();
          const selected = options[Math.min(slashCommandMenu.selectedIndex, options.length - 1)];
          if (slashCommandMenu.level === "root") selectSlashRootItem(selected as SlashRootItem);
          else selectSlashItem(selected as AgentReplCapabilityItem);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlashCommandMenu();
        return;
      }
    }
    if (fileMention.active && fileSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFileSuggestionIndex((current) =>
          Math.min(current + 1, fileSuggestions.length - 1),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setFileSuggestionIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        selectFileSuggestion(fileSuggestions[fileSuggestionIndex] ?? fileSuggestions[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeFileSuggestions();
        return;
      }
    }

    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    submitPrompt();
  }

  return (
    <main
      className={`app-shell ${activeView === "settings" || activeView === "skills" ? "settings-mode" : activePreview ? "has-preview" : ""}`}
    >
      <aside className="side-panel" aria-label="Project and skills">
        <div className="brand-block">
          <div className="brand-mark">A</div>
          <div>
            <div className="brand-title">InterpressAI</div>
            <div className="brand-version">workspace</div>
          </div>
        </div>

        <section className="workspace-nav">
          <div
            className={`workspace-active ${activeView === "workspace" ? "active" : ""}`}
          >
            <button
              className="workspace-select"
              type="button"
              onClick={() => {
                setActiveView("workspace");
                setPreviewTabs([]);
                setActivePreviewId(null);
              }}
            >
              <span className="nav-icon plain" aria-hidden="true">▣</span>
              <span className="nav-label">项目</span>
            </button>
            <button
              className="project-add"
              type="button"
              onClick={handleAddProject}
              title="Add project folder"
            >
              +
            </button>
          </div>

          <div className="workspace-tree">
            {projects.map((folder) => {
              const isExpanded = expandedFolders.has(folder.id);
              return (
                <div key={folder.id}>
                  <button
                    className="tree-project"
                    type="button"
                    onClick={() => toggleFolder(folder.id)}
                  >
                    <span className="nav-icon small plain" aria-hidden="true">
                      {isExpanded ? "▾" : "▸"}
                    </span>
                    <span className="tree-label">{folder.name}</span>
                    <span className="tree-chevron plain" aria-hidden="true">
                      {isExpanded ? "⌄" : "›"}
                    </span>
                  </button>
                  {isExpanded ? (
                    <div className="tree-branch">
                      {folder.sessions.map((session) => {
                        const isMenuOpen =
                          openSessionMenu?.root === folder.root &&
                          openSessionMenu.sessionId === session.id;
                        const isActiveSession = activeSessionId === session.id;
                        const statusTitle =
                          session.processStatus === "active"
                            ? `running${session.processPid ? ` · pid ${session.processPid}` : ""}`
                            : "not running";
                        return (
                          <div
                            key={session.id}
                            className={`tree-session-row ${isActiveSession ? "active" : ""}`}
                          >
                            <button
                              className="tree-session-main"
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                console.log("[debug-session] tree-session-main clicked", {
                                  folderId: folder.id,
                                  folderRoot: folder.root,
                                  sessionId: session.id,
                                  title: session.title,
                                });
                                selectSession(folder, session.id);
                              }}
                            >
                              <span
                                className={`session-status-dot ${session.processStatus === "active" ? "active" : "stopped"}`}
                                title={statusTitle}
                                aria-label={statusTitle}
                              />
                              <span
                                className="tree-label"
                                title={session.title}
                              >
                                {session.title}
                              </span>
                            </button>
                            <button
                              className="session-menu-button"
                              type="button"
                              aria-label={`Open menu for ${session.title}`}
                              aria-expanded={isMenuOpen}
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpenSessionMenu((current) =>
                                  current?.root === folder.root &&
                                  current.sessionId === session.id
                                    ? null
                                    : {
                                        root: folder.root,
                                        sessionId: session.id,
                                      },
                                );
                              }}
                            >
                              ...
                            </button>
                            {isMenuOpen ? (
                              <div className="session-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void handleHideSession(folder, session);
                                  }}
                                >
                                  删除
                                </button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                      <button
                        className="tree-session create"
                        type="button"
                        onClick={() => handleCreateSession(folder)}
                      >
                        <span className="nav-icon tiny plain" aria-hidden="true">+</span>
                        <span className="tree-label">新建会话</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {projects.length === 0 ? (
              <div className="sidebar-empty">点击 + 添加项目文件夹</div>
            ) : null}
          </div>

          <button
            className={`skills-nav ${activeView === "skills" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("skills");
              setPreviewTabs([]);
              setActivePreviewId(null);
            }}
          >
            <span className="nav-icon plain" aria-hidden="true">✦</span>
            <span>Skills</span>
          </button>
        </section>

        <div className="sidebar-footer">
          <button className="sidebar-action" type="button" disabled>
            <span className="nav-icon small plain" aria-hidden="true">⌘</span>
            <span>Terminal(todo)</span>
          </button>
          <button
            className={`sidebar-action ${activeView === "settings" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("settings");
              setPreviewTabs([]);
              setActivePreviewId(null);
            }}
          >
            <span className="nav-icon small plain" aria-hidden="true">⚙</span>
            <span>Settings</span>
          </button>
        </div>
      </aside>

      {activeView === "skills" ? (
        <SkillsView activeProject={activeProject} />
      ) : activeView === "settings" ? (
        <SettingsView
          hiddenSessions={hiddenSessions}
          onRestoreSession={handleRestoreHiddenSession}
        />
      ) : (
        <section className="exploration-panel" aria-label="Exploration stream">
          <header className="workspace-header">
            <div className="session-title-area">
              <div className="session-title">
                <span className="header-icon" aria-hidden="true">
                  chat
                </span>
                <h1>{activeSessionTitle}</h1>
              </div>
              <button
                className={`debug-toggle ${isDebugOpen ? "active" : ""}`}
                type="button"
                onClick={() => setIsDebugOpen((value) => !value)}
                disabled={!activeSessionId}
              >
                Debug JSON <span>{debugEvents.length}</span>
              </button>
            </div>
            <input
              className="session-search"
              placeholder="Search session content..."
              aria-label="Search session content"
            />
          </header>

          {copyToast ? (
            <div className="copy-toast" role="status">
              {copyToast}
            </div>
          ) : null}

          {activeSessionId && isDebugOpen ? (
            <section className="debug-panel" aria-label="Debug JSON events">
              {debugEvents.length === 0 ? (
                <div className="debug-empty">
                  No stream-json events received yet.
                </div>
              ) : (
                debugEvents.map((event) => (
                  <article className="debug-event" key={event.id}>
                    <header>
                      <strong>{event.eventType}</strong>
                      <span>{formatDebugTime(event.receivedAt)}</span>
                    </header>
                    <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                  </article>
                ))
              )}
            </section>
          ) : null}

          {error ? <div className="error-banner">{error}</div> : null}

          <div className="stream">
            {!activeSessionId ? (
              <div className="empty-chat-state">
                <strong>未选择会话</strong>
                <span>请先在左侧添加项目文件夹，然后创建或选择一个会话。</span>
              </div>
            ) : null}
            {activeSessionId
              ? streamItems.map((item) => {
                  if (item.kind === "message") {
                    if (item.role !== "assistant" && item.role !== "user") {
                      return null;
                    }
                    const assistantDebugBundle =
                      item.role === "assistant"
                        ? assistantDebugBundles[item.id]
                        : null;
                    const isAssistantDebugOpen =
                      item.role === "assistant" &&
                      openAssistantDebugMessageId === item.id;
                    const assistantDebugJson = isAssistantDebugOpen
                      ? JSON.stringify(assistantDebugPayload(item, "view"), null, 2)
                      : "";
                    const assistantDetails =
                      item.role === "assistant"
                        ? assistantTurnDetails(item, assistantDebugBundle)
                        : null;
                    const isProcessOpen =
                      item.role === "assistant" && openProcessMessageIds.has(item.id);
                    const hasProcessDetails = Boolean(
                      assistantDetails &&
                        (assistantDetails.progressLines.length > 0 ||
                          assistantDetails.toolUses.length > 0 ||
                          assistantDetails.toolResults.length > 0 ||
                          assistantDetails.eventCount > 0 ||
                          item.status === "streaming"),
                    );
                    const assistantDisplayText =
                      item.role === "assistant" &&
                      item.status === "streaming" &&
                      item.text === pendingAssistantText
                        ? "正在等待最终回答…"
                        : item.text;
                    const messageDisplayText =
                      item.role === "user" ? displayPromptText(item.text) : assistantDisplayText;
                    const userFileReferences =
                      item.role === "user"
                        ? item.fileReferences?.length
                          ? item.fileReferences
                          : localFileReferencesFromPromptText(item.text)
                        : [];
                    return (
                      <article
                        className={`stream-message ${item.role}`}
                        key={item.id}
                      >
                        <div className="message-avatar" aria-hidden="true">
                          {item.role === "user" ? "person" : "spark"}
                        </div>
                        <div className="message-body">
                          <div className="stream-label-row">
                            <div className="stream-label">
                              {displayRole(item.role)}
                            </div>
                            {item.role === "assistant" ? (
                              <button
                                className={`message-debug-button ${copiedDebugMessageId === item.id ? "copied" : ""} ${isAssistantDebugOpen ? "active" : ""}`}
                                type="button"
                                onClick={() => handleViewAssistantDebug(item.id)}
                                onDoubleClick={() => handleCopyAssistantDebug(item)}
                                title="单击查看本条 Debug，双击复制 Debug JSON"
                              >
                                {copiedDebugMessageId === item.id
                                  ? "已复制"
                                  : `Debug${assistantDebugBundle?.events.length ? ` ${assistantDebugBundle.events.length}` : ""}`}
                              </button>
                            ) : null}
                          </div>
                          {item.role === "assistant" &&
                          assistantDetails &&
                          hasProcessDetails ? (
                            <div className="message-process-section">
                              <button
                                className="message-process-toggle"
                                type="button"
                                onClick={() => handleToggleAssistantProcess(item.id)}
                              >
                                <span>{isProcessOpen ? "过程 ˅" : "过程 >>"}</span>
                                <small>
                                  {compactCountLabel(
                                    assistantDetails.progressLines.length,
                                    "行过程",
                                    "行过程",
                                  )}
                                  {" · "}
                                  {compactCountLabel(
                                    assistantDetails.commandUses.length,
                                    "command",
                                  )}
                                  {" · "}
                                  {compactCountLabel(
                                    assistantDetails.toolUses.length,
                                    "tool call",
                                  )}
                                  {" · "}
                                  {compactCountLabel(
                                    assistantDetails.toolResults.length,
                                    "tool result",
                                  )}
                                  {" · "}
                                  {compactCountLabel(
                                    assistantDetails.eventCount,
                                    "debug event",
                                  )}
                                </small>
                              </button>
                              {isProcessOpen ? (
                                <div className="message-process-detail">
                                  {assistantDetails.timeline.length > 0 ? (
                                    <section>
                                      <div className="message-section-label">时间线</div>
                                      <ol className="message-process-timeline">
                                        {assistantDetails.timeline.map((entry) => (
                                          <li
                                            className={`process-timeline-item ${entry.kind}`}
                                            key={entry.id}
                                          >
                                            <div className="process-timeline-marker" aria-hidden="true" />
                                            <div className="process-timeline-content">
                                              <div className="process-timeline-title-row">
                                                <strong>{entry.title}</strong>
                                                <span>{formatDebugTime(entry.receivedAt)}</span>
                                              </div>
                                              {entry.kind === "tool_call" ? (
                                                <code>{entry.detail}</code>
                                              ) : entry.kind === "tool_result" ? (
                                                <pre>{entry.detail}</pre>
                                              ) : entry.kind === "permission" ? (
                                                <p>{entry.detail}</p>
                                              ) : (
                                                <pre>{entry.detail}</pre>
                                              )}
                                            </div>
                                          </li>
                                        ))}
                                      </ol>
                                    </section>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          <div
                            className={`message-bubble ${
                              item.role === "assistant" && item.status === "streaming"
                                ? "streaming"
                                : ""
                            }`}
                          >
                            {item.role === "assistant" ? (
                              <div className="message-section-label">
                                {item.status === "streaming" ? "等待最终回答" : "最终回答"}
                              </div>
                            ) : null}
                            <RichMarkdownMessage content={messageDisplayText} />
                            {item.role === "user" && userFileReferences.length > 0 ? (
                              <div className="message-file-references" aria-label="Referenced files sent to Claude Code">
                                {userFileReferences.map((reference) => (
                                  <button
                                    className={`message-file-reference-chip ${reference.failed ? "failed" : ""}`}
                                    key={reference.path}
                                    title={reference.path}
                                    type="button"
                                    onClick={() => void handleOpenPreviewLink(localFileReferenceSummaryToStreamLink(reference))}
                                    disabled={Boolean(reference.failed)}
                                  >
                                    <span className="message-file-reference-icon" aria-hidden="true">@</span>
                                    <span className="message-file-reference-name">
                                      {reference.name || localFileReferenceName(reference.path)}
                                    </span>
                                    <span className="message-file-reference-meta">
                                      {reference.failed
                                        ? "读取失败"
                                        : `${formatFileSize(reference.size_bytes)} · 注入 ${formatFileSize(reference.injected_bytes)}`}
                                      {reference.truncated ? " · 已截断" : ""}
                                    </span>
                                    <span className="message-file-reference-open">右侧预览</span>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            <MessageImagePreviews root={activeProject?.root ?? ""} links={item.links} onOpen={handleOpenPreviewLink} />
                            {item.links?.length ? (
                              <div className="message-links local-reference-links">
                                {item.links.map((link) => (
                                  <button
                                    key={link.id}
                                    type="button"
                                    onClick={() => handleOpenPreviewLink(link)}
                                  >
                                    <span>{link.kind}</span>
                                    <strong>{link.label}</strong>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          {isAssistantDebugOpen ? (
                            <div className="message-debug-panel">
                              <div className="message-debug-panel-header">
                                <span>
                                  本条 AI 回复 Debug
                                  {assistantDebugBundle?.events.length
                                    ? ` · ${assistantDebugBundle.events.length} events`
                                    : " · 0 events"}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleCopyAssistantDebug(item)}
                                >
                                  复制
                                </button>
                              </div>
                              <pre>{assistantDebugJson}</pre>
                            </div>
                          ) : null}
                        </div>
                      </article>
                    );
                  }

                  if (item.kind === "system") {
                    return (
                      <article
                        className={`system-event ${item.subtype}`}
                        key={item.id}
                      >
                        <div className="stream-label">{item.title}</div>
                        <pre>{item.detail}</pre>
                      </article>
                    );
                  }

                  if (item.kind === "tool") {
                    return (
                      <article
                        className={`tool-event ${item.status}`}
                        key={item.id}
                      >
                        <div className="stream-label">{item.title}</div>
                        <p>{item.detail}</p>
                      </article>
                    );
                  }

                  const artifactPath = item.path;

                  return (
                    <article className="artifact-event" key={item.id}>
                      <div className="stream-label">{item.artifactKind}</div>
                      <h2>{item.title}</h2>
                      {item.artifactKind === "table" ? (
                        <MarkdownTablePreview content={item.preview} />
                      ) : item.artifactKind === "diff" ? (
                        <pre className="diff-view">{item.preview}</pre>
                      ) : (
                        <p>{item.preview}</p>
                      )}
                      {artifactPath ? (
                        <div className="message-links local-reference-links">
                          <button
                            type="button"
                            onClick={() =>
                              handleOpenPreviewLink({
                                id: `artifact:${artifactPath}`,
                                label: item.title,
                                kind:
                                  item.artifactKind === "markdown"
                                    ? "markdown"
                                    : item.artifactKind === "file"
                                      ? "file"
                                      : "report",
                                path: artifactPath,
                              })
                            }
                          >
                            <span>{item.artifactKind}</span>
                            <strong>Open preview</strong>
                          </button>
                        </div>
                      ) : null}
                    </article>
                  );
                })
              : null}
          </div>

          <form className="prompt-box" onSubmit={handlePromptSubmit}>
            <div className="prompt-frame">
              {pendingPermission &&
              activeSessionId === pendingPermission.sessionId ? (
                <div className="permission-request">
                  <div className="permission-request-header">
                    <strong>需要授权</strong>
                    <span>{pendingPermission.toolName ?? "tool"}</span>
                  </div>
                  <p>{pendingPermission.prompt}</p>
                  <details className="permission-request-details">
                    <summary>查看请求详情</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          requestId: pendingPermission.requestId,
                          toolName: pendingPermission.toolName,
                          input: pendingPermission.input,
                          rawJson: pendingPermission.rawJson,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                  <div className="permission-request-actions">
                    <button
                      type="button"
                      className="permission-allow-button"
                      onClick={() => handlePermissionDecision(true)}
                      disabled={!pendingPermission}
                    >
                      允许
                    </button>
                    <button
                      type="button"
                      className="permission-deny-button"
                      onClick={() => handlePermissionDecision(false)}
                      disabled={!pendingPermission}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              ) : null}
              {fileReferences.length > 0 ? (
                <div className="file-reference-tray" aria-label="Referenced files">
                  {fileReferences.map((reference) => (
                    <span className="file-reference-chip" key={reference.path}>
                      <button
                        className="file-reference-chip-preview"
                        type="button"
                        title={`在右侧预览 ${reference.path}`}
                        onClick={() => void handleOpenPreviewLink(localReferenceToStreamLink(reference))}
                      >
                        <span className="file-reference-chip-icon" aria-hidden="true">
                          @
                        </span>
                        <span className="file-reference-chip-text" title={reference.path}>
                          {reference.name || localFileReferenceName(reference.path)}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${reference.path}`}
                        onClick={() => removeFileReference(reference.path)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="prompt-input-wrap">
                <div
                  ref={promptHighlightRef}
                  className="prompt-highlight-layer"
                  aria-hidden="true"
                >
                  {renderPromptHighlightedText(prompt)}
                </div>
                <textarea
                  ref={textareaRef}
                  aria-label="Agent prompt"
                  value={prompt}
                  onChange={(event) =>
                    handlePromptChange(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                    )
                  }
                  onCompositionStart={() => {
                    promptImeStateRef.current.isComposing = true;
                    markPromptImeActive(1000);
                  }}
                  onCompositionUpdate={() => {
                    promptImeStateRef.current.isComposing = true;
                    markPromptImeActive(1000);
                  }}
                  onCompositionEnd={() => {
                    promptImeStateRef.current.isComposing = false;
                    markPromptImeActive(350);
                  }}
                  onBeforeInput={(event) => {
                    const nativeEvent = event.nativeEvent as Event & {
                      isComposing?: boolean;
                      inputType?: string;
                    };

                    if (
                      nativeEvent.isComposing === true ||
                      nativeEvent.inputType === "insertCompositionText"
                    ) {
                      markPromptImeActive(1000);
                    }
                  }}
                  onInput={(event) => {
                    const nativeEvent = event.nativeEvent as Event & {
                      isComposing?: boolean;
                      inputType?: string;
                    };

                    if (
                      nativeEvent.isComposing !== true &&
                      nativeEvent.inputType !== "insertCompositionText"
                    ) {
                      promptImeStateRef.current.isComposing = false;
                    }
                  }}
                  onClick={(event) => {
                    const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
                    updateFileMentionFromInput(event.currentTarget.value, cursor);
                    updateSlashCommandMenuFromInput(event.currentTarget.value, cursor);
                  }}
                  onKeyUp={(event) => {
                    const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
                    updateFileMentionFromInput(event.currentTarget.value, cursor);
                    updateSlashCommandMenuFromInput(event.currentTarget.value, cursor);
                  }}
                  onKeyDown={handlePromptKeyDown}
                  onScroll={(event) => {
                    if (promptHighlightRef.current) {
                      promptHighlightRef.current.scrollTop = event.currentTarget.scrollTop;
                      promptHighlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
                    }
                  }}
                  placeholder={
                    activeProject
                      ? "Type a message, use @ to reference workspace files..."
                      : "Add a project folder before starting a conversation..."
                  }
                  disabled={!activeProject || !activeSessionId || isRunningTurn || isResolvingFileReferences}
                />
                {fileMention.active ? (
                  <div className="file-mention-menu" role="listbox">
                    <div className="file-mention-menu-header">
                      <span>@ 文件引用</span>
                      <small>输入路径或文件名，Enter/Tab 选择</small>
                    </div>
                    {isSearchingFiles ? (
                      <div className="file-mention-empty">搜索文件中…</div>
                    ) : fileSuggestions.length > 0 ? (
                      fileSuggestions.map((reference, index) => (
                        <button
                          key={reference.path}
                          type="button"
                          role="option"
                          aria-selected={index === fileSuggestionIndex}
                          className={`file-mention-option ${index === fileSuggestionIndex ? "active" : ""}`}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            selectFileSuggestion(reference);
                          }}
                        >
                          <span className="file-mention-name">{reference.name}</span>
                          <span className="file-mention-path">{reference.path}</span>
                          <span className="file-mention-meta">
                            {formatFileSize(reference.size_bytes)}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="file-mention-empty">未找到匹配文件</div>
                    )}
                  </div>
                ) : null}
                {slashCommandMenu.active ? (
                  <div className="slash-command-menu" role="listbox">
                    <div className="slash-command-menu-header">
                      {slashCommandMenu.level === "root" ? (
                        <>
                          <span>/ 功能菜单</span>
                          <small>选择能力类型，Enter/Tab 进入</small>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              setSlashCommandMenu((current) => ({ ...current, level: "root", selectedIndex: 0 }));
                            }}
                          >
                            ←
                          </button>
                          <span>{slashLeafTitle}</span>
                          <small>{slashLeafDescription}</small>
                        </>
                      )}
                    </div>
                    {slashCommandMenu.level === "root" ? (
                      slashRootOptions.map((item, index) => (
                        <button
                          key={item.id}
                          type="button"
                          role="option"
                          aria-selected={index === slashCommandMenu.selectedIndex}
                          className={`slash-command-option ${index === slashCommandMenu.selectedIndex ? "active" : ""}`}
                          disabled={item.disabled}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            selectSlashRootItem(item);
                          }}
                        >
                          <span className="slash-command-icon" aria-hidden="true">{item.id === "skills" ? "✦" : "›"}</span>
                          <span><strong>{item.label}</strong><small>{item.description}</small></span>
                        </button>
                      ))
                    ) : slashCommandMenu.isLoadingSkills ? (
                      <div className="slash-command-empty">加载 {slashLeafTitle.toLowerCase()} 中…</div>
                    ) : slashCommandMenu.error ? (
                      <div className="slash-command-empty">加载失败：{slashCommandMenu.error}</div>
                    ) : slashLeafOptions.length > 0 ? (
                      slashLeafOptions.map((skill, index) => (
                        <button
                          key={skill.slash || skill.name}
                          type="button"
                          role="option"
                          aria-selected={index === slashCommandMenu.selectedIndex}
                          className={`slash-command-option skill ${index === slashCommandMenu.selectedIndex ? "active" : ""}`}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            selectSlashItem(skill);
                          }}
                        >
                          <span className="slash-command-icon skill" aria-hidden="true">/</span>
                          <span><strong>{skill.slash || `/${skill.name}`}</strong><small>{skill.description || "No description"}</small></span>
                          <em>{skill.kind === "skill" ? "Skill" : "Command"}</em>
                        </button>
                      ))
                    ) : (
                      <div className="slash-command-empty">{slashLeafEmptyText}</div>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="prompt-actions">
                <label className="permission-chip">
                  <span aria-hidden="true">lock</span>
                  <select
                    value={permissionState?.currentMode ?? "read-only"}
                    onChange={(event) =>
                      handlePermissionModeChange(
                        event.target.value as PermissionMode,
                      )
                    }
                    disabled={!activeProject}
                  >
                    {(
                      permissionState?.availableModes ?? [
                        "read-only",
                        "workspace-write",
                        "danger-full-access",
                      ]
                    ).map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="permission-chip">
                  <span aria-hidden="true">model</span>
                  <select
                    value={selectedChatModel}
                    onChange={(event) =>
                      setSelectedChatModel(event.target.value)
                    }
                    disabled={
                      !activeProject || !activeSessionId || isRunningTurn
                    }
                  >
                    {chatModelOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="prompt-tools">
                  <button type="button" disabled title="Attach file">
                    upload(todo)
                  </button>
                </div>
                {isRunningTurn || pendingPermission ? (
                  <button
                    className="send-button stop"
                    type="button"
                    onClick={handleInterruptTurn}
                    disabled={isInterruptingTurn}
                  >
                    {isInterruptingTurn ? "STOPPING" : "STOP"}
                  </button>
                ) : null}
                <button
                  className="send-button"
                  type="submit"
                  disabled={!canSendPrompt}
                >
                  {isResolvingFileReferences ? "READING" : isRunningTurn ? "RUNNING" : "SEND"}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {activeView === "workspace" && activePreview ? (
        <aside className="detail-panel" aria-label="Preview panel">
          <header className="preview-tabs">
            <div className="preview-tab-strip">
              {previewTabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`preview-tab ${tab.id === activePreview.id ? "active" : ""}`}
                >
                  <button
                    className="preview-tab-label"
                    type="button"
                    onClick={() => setActivePreviewId(tab.id)}
                  >
                    <span>{tab.kind}</span>
                    <strong>{tab.title}</strong>
                  </button>
                  <button
                    className="tab-close"
                    type="button"
                    onClick={() => closePreviewTab(tab.id)}
                    aria-label={`Close ${tab.title}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="preview-actions">
              <button type="button" title="Fullscreen">
                □
              </button>
              <button
                type="button"
                title="Close preview"
                onClick={() => setPreviewTabs([])}
              >
                ×
              </button>
            </div>
          </header>

          {activePreview.kind === "file" ? (
            <section className="file-workbench">
              <div className="detail-header">
                <div>
                  <div className="eyebrow">Open File</div>
                  <h2>{activePreview.file.path}</h2>
                </div>
                <span className="count-label">read-only</span>
              </div>
              <div className="file-view">
                <div className="file-meta">
                  <span>{activePreview.file.path}</span>
                  <span>
                    {activePreview.file.total_lines} lines ·{" "}
                    {activePreview.file.size_bytes} bytes ·{" "}
                    {activePreview.file.language}
                  </span>
                </div>
                {isCsvFilePath(activePreview.file.path, activePreview.file.language) ? (
                  <CsvDataPreview file={activePreview.file} />
                ) : isHtmlFilePath(activePreview.file.path, activePreview.file.language) ? (
                  <HtmlRichPreview
                    content={activePreview.file.content}
                    title={activePreview.file.path}
                  />
                ) : isMarkdownFile(activePreview.file.path) ? (
                  <MarkdownPreview content={activePreview.file.content} />
                ) : (
                  <CodePreview content={activePreview.file.content} />
                )}
              </div>
              <div className="section-heading diff-heading">
                <span>Git Diff</span>
                <span className="count-label">
                  {activePreview.diff?.is_empty ? "empty" : "changed"}
                </span>
              </div>
              <pre className="diff-view">
                {activePreview.diff?.diff || "No diff loaded."}
              </pre>
            </section>
          ) : (
            <ReferencePanel link={activePreview.link} root={activeProject?.root ?? ""} />
          )}
        </aside>
      ) : null}
    </main>
  );
}


type SkillsViewProps = {
  activeProject?: ProjectFolder;
};

type SkillViewMode = "grid" | "list";

function skillDateLabel(timestamp?: number): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function skillCapabilityLabel(skill: SkillSummary): string[] {
  if (skill.capabilities && skill.capabilities.length > 0) {
    return skill.capabilities;
  }
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    return skill.allowedTools.slice(0, 4);
  }
  return ["Prompt Skill"];
}

function skillIdentity(skill: SkillSummary): string {
  return skill.id ?? `${skill.source?.kind ?? skill.origin?.id ?? "unknown"}:${skill.name}`;
}

function SkillsView({ activeProject }: SkillsViewProps) {
  const [report, setReport] = useState<SkillsReport | null>(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<SkillViewMode>("grid");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading installed skills...");

  useEffect(() => {
    if (!activeProject) {
      setReport(null);
      setSelectedSkillId(null);
      setStatus("Add or select a project to inspect project and user skills.");
      return;
    }

    let cancelled = false;
    setStatus("Loading installed skills...");
    listSkills(activeProject.root)
      .then((nextReport) => {
        if (cancelled) {
          return;
        }
        setReport(nextReport);
        setSelectedSkillId((current) => {
          if (current && nextReport.skills.some((skill) => skillIdentity(skill) === current)) {
            return current;
          }
          return nextReport.skills[0] ? skillIdentity(nextReport.skills[0]) : null;
        });
        setStatus(
          nextReport.skills.length > 0
            ? "Installed skills loaded."
            : "No installed project or user skills found.",
        );
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }
        setReport(null);
        setSelectedSkillId(null);
        setStatus(`Failed to load skills: ${String(reason)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [activeProject?.root]);

  const skills = report?.skills ?? [];
  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return skills;
    }
    return skills.filter((skill) => {
      const searchable = [
        skill.name,
        skill.description,
        skill.whenToUse,
        skill.version,
        skill.context,
        skill.agent,
        skill.model,
        ...(skill.allowedTools ?? []),
        ...(skill.capabilities ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(normalized);
    });
  }, [skills, query]);

  const selectedSkill =
    filteredSkills.find((skill) => skillIdentity(skill) === selectedSkillId) ??
    filteredSkills[0] ??
    skills.find((skill) => skillIdentity(skill) === selectedSkillId) ??
    null;

  const total = report?.summary?.total ?? skills.length;
  const active = report?.summary?.active ?? skills.filter((skill) => skill.enabled !== false).length;
  const shadowed = report?.summary?.shadowed ?? 0;
  const sources = report?.sources ?? [];

  return (
    <section className="skills-installed-view" aria-label="Installed skills">
      <div className="skills-admin-topbar">
        <strong>Enterprise Control</strong>
        <nav aria-label="Skills breadcrumb">
          <span>Skills</span>
          <span>›</span>
          <b>Installed</b>
        </nav>
        <div className="skills-admin-icons" aria-hidden="true">
          <span>⌁</span>
          <span>?</span>
          <span>◎</span>
        </div>
      </div>
      <header className="skills-installed-hero">
        <div>
          <div className="skills-breadcrumb">Skills / Installed</div>
          <h1>Installed Skills</h1>
          <p>
            Manage skills discovered from the active workspace and <code>~/.claude/skills</code>. This view uses the
            local Tauri API and does not require a remote hub.
          </p>
        </div>
        <div className="skills-hero-actions">
          <button type="button" disabled>
            Import Skill
          </button>
          <button type="button" className="primary" disabled>
            New Skill
          </button>
        </div>
      </header>

      <div className="skills-stat-row" aria-label="Skill summary">
        <article>
          <span>Total</span>
          <strong>{total}</strong>
        </article>
        <article>
          <span>Active</span>
          <strong>{active}</strong>
        </article>
        <article>
          <span>Shadowed</span>
          <strong>{shadowed}</strong>
        </article>
      </div>

      {sources.length > 0 ? (
        <div className="skills-sources-row" aria-label="Skill scan paths">
          {sources.map((source) => (
            <article key={source.kind} className={source.exists ? "" : "missing"}>
              <span>{source.label}</span>
              <code>{source.path}</code>
              <small>{source.exists ? `${source.count} skills` : "directory missing"}</small>
            </article>
          ))}
        </div>
      ) : null}

      <div className="skills-toolbar">
        <label className="skills-search">
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search installed skills..."
          />
        </label>
        <div className="skills-view-toggle" role="group" aria-label="View mode">
          <button
            type="button"
            className={viewMode === "grid" ? "active" : ""}
            onClick={() => setViewMode("grid")}
          >
            Grid
          </button>
          <button
            type="button"
            className={viewMode === "list" ? "active" : ""}
            onClick={() => setViewMode("list")}
          >
            List
          </button>
        </div>
      </div>

      <div className="skills-installed-layout">
        <section
          className={`skills-card-list ${viewMode === "list" ? "list" : "grid"}`}
          aria-label="Skill list"
        >
          {filteredSkills.map((skill) => {
            const capabilities = skillCapabilityLabel(skill);
            const id = skillIdentity(skill);
            const isSelected = selectedSkill ? skillIdentity(selectedSkill) === id : false;
            return (
              <button
                key={id}
                type="button"
                className={`skill-card ${isSelected ? "selected" : ""}`}
                onClick={() => setSelectedSkillId(id)}
              >
                <span className="skill-card-topline">
                  <span className="skill-card-icon" aria-hidden="true">
                    ✦
                  </span>
                  <span className="skill-card-source">
                    {skill.source?.label ?? skill.origin?.label ?? "Project"}
                  </span>
                </span>
                <strong>{skill.name}</strong>
                <p>{skill.description || "No description in SKILL.md frontmatter."}</p>
                <span className="skill-card-tags">
                  {capabilities.slice(0, 3).map((capability) => (
                    <small key={capability}>{capability}</small>
                  ))}
                </span>
                <span className="skill-card-meta">
                  <span>{skill.version ? `v${skill.version}` : "No version"}</span>
                  <span>{formatFileSize(skill.sizeBytes)}</span>
                </span>
                {skill.enabled === false ? <span className="skill-card-warning">Shadowed</span> : null}
              </button>
            );
          })}
          {filteredSkills.length === 0 ? (
            <div className="skills-empty-state">
              <strong>No skills found</strong>
              <p>{status}</p>
            </div>
          ) : null}
        </section>

        <aside className="skill-detail-panel" aria-label="Skill detail">
          {selectedSkill ? (
            <>
              <div className="skill-detail-header">
                <div className="skill-detail-icon" aria-hidden="true">
                  ✦
                </div>
                <div>
                  <div className="skills-breadcrumb">Skill Detail</div>
                  <h2>{selectedSkill.name}</h2>
                  <p>{selectedSkill.description || "No description provided."}</p>
                </div>
              </div>

              <div className="skill-detail-actions">
                <button type="button" disabled>
                  Settings
                </button>
                <button type="button" disabled>
                  Uninstall
                </button>
              </div>

              <section className="skill-detail-section">
                <h3>Capabilities</h3>
                <div className="skill-chip-list">
                  {skillCapabilityLabel(selectedSkill).map((capability) => (
                    <span key={capability}>{capability}</span>
                  ))}
                </div>
              </section>

              <section className="skill-detail-section">
                <h3>Metadata</h3>
                <dl className="skill-meta-grid">
                  <div>
                    <dt>Version</dt>
                    <dd>{selectedSkill.version || "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Installed</dt>
                    <dd>{skillDateLabel(selectedSkill.installedAtMs)}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{formatFileSize(selectedSkill.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt>Context</dt>
                    <dd>{selectedSkill.context || "inline"}</dd>
                  </div>
                  <div>
                    <dt>Agent</dt>
                    <dd>{selectedSkill.agent || "Default"}</dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd>{selectedSkill.model || "Default"}</dd>
                  </div>
                </dl>
              </section>

              <section className="skill-detail-section">
                <h3>When to use</h3>
                <p>{selectedSkill.whenToUse || "No when_to_use guidance found."}</p>
              </section>

              <section className="skill-detail-section">
                <h3>Allowed tools</h3>
                {selectedSkill.allowedTools && selectedSkill.allowedTools.length > 0 ? (
                  <div className="skill-tool-list">
                    {selectedSkill.allowedTools.map((tool) => (
                      <code key={tool}>{tool}</code>
                    ))}
                  </div>
                ) : (
                  <p>No allowed-tools declared.</p>
                )}
              </section>

              <section className="skill-detail-section">
                <h3>Local path</h3>
                <code className="skill-path-code">{selectedSkill.path || selectedSkill.skillRoot || "Unknown"}</code>
              </section>

              {selectedSkill.validation && selectedSkill.validation.length > 0 ? (
                <section className="skill-detail-section warning">
                  <h3>Validation</h3>
                  <ul>
                    {selectedSkill.validation.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : (
            <div className="skills-empty-state detail">
              <strong>No skill selected</strong>
              <p>{status}</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function SettingsView({ hiddenSessions, onRestoreSession }: SettingsViewProps) {
  const [savedSettings, setSavedSettings] = useState<ModelSettings | null>(
    null,
  );
  const [draftSettings, setDraftSettings] = useState<ModelSettings | null>(
    null,
  );
  const [selectedModelId, setSelectedModelId] = useState<string>("deepseek-v3");
  const [status, setStatus] = useState<string>("Loading model settings...");
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("models");

  useEffect(() => {
    let cancelled = false;
    loadModelSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        setSavedSettings(settings);
        setDraftSettings(settings);
        setSelectedModelId(settings.activeModelId);
        setStatus("Model settings loaded.");
      })
      .catch((reason) => {
        if (!cancelled) {
          setStatus(`Failed to load model settings: ${String(reason)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeModel =
    draftSettings?.models.find((model) => model.id === selectedModelId) ??
    draftSettings?.models[0] ??
    null;
  const hasUnsavedChanges = Boolean(
    savedSettings &&
    draftSettings &&
    JSON.stringify(savedSettings) !== JSON.stringify(draftSettings),
  );

  function selectModel(id: string) {
    setSelectedModelId(id);
    setDraftSettings((settings) =>
      settings ? { ...settings, activeModelId: id } : settings,
    );
    setStatus(
      "Active model changed. Save changes to apply it to future turns.",
    );
  }

  function updateSelectedModel(
    updater: (model: ModelEndpointConfig) => ModelEndpointConfig,
  ) {
    setDraftSettings((settings) => {
      if (!settings) {
        return settings;
      }
      return {
        ...settings,
        models: settings.models.map((model) =>
          model.id === selectedModelId ? updater(model) : model,
        ),
      };
    });
  }

  async function handleSaveSettings() {
    if (!draftSettings || isSaving) {
      return;
    }
    setIsSaving(true);
    setStatus("Saving model settings...");
    try {
      const saved = await saveModelSettings(draftSettings);
      setSavedSettings(saved);
      setDraftSettings(saved);
      setSelectedModelId(saved.activeModelId);
      setStatus(
        "Saved. Future agent turns will use the active model configuration.",
      );
    } catch (reason) {
      setStatus(`Save failed: ${String(reason)}`);
    } finally {
      setIsSaving(false);
    }
  }

  function handleDiscardSettings() {
    if (!savedSettings) {
      return;
    }
    setDraftSettings(savedSettings);
    setSelectedModelId(savedSettings.activeModelId);
    setStatus("Discarded unsaved settings.");
  }

  async function handleTestConnection() {
    if (!draftSettings || isTesting) {
      return;
    }
    setIsTesting(true);
    setStatus("Testing active model connection...");
    try {
      const result = await testModelConnection(draftSettings);
      setStatus(
        result.ok
          ? `${result.message} (${result.model})`
          : `${result.message}${result.stderr ? `: ${result.stderr}` : ""}`,
      );
    } catch (reason) {
      setStatus(`Connection test failed: ${String(reason)}`);
    } finally {
      setIsTesting(false);
    }
  }

  const modelCards = draftSettings?.models ?? [];

  return (
    <section className="settings-view" aria-label="System settings">
      <header className="settings-topbar">
        <div className="settings-title-row">
          <strong>System Settings</strong>
          <nav aria-label="Settings sections">
            <button
              className={settingsSection === "models" ? "active" : ""}
              type="button"
              onClick={() => setSettingsSection("models")}
            >
              Models
            </button>
            <button type="button" disabled>
              <span className="settings-svg-icon" aria-hidden="true">
  <svg viewBox="0 0 24 24" focusable="false">
    <path d="M17.5 18H8a4 4 0 1 1 .9-7.9A5.5 5.5 0 0 1 19 12.7 2.7 2.7 0 0 1 17.5 18Z" />
  </svg>
</span>
              
              Environments
            </button>
            <button
              className={settingsSection === "sessions" ? "active" : ""}
              type="button"
              onClick={() => setSettingsSection("sessions")}
            >
              Sessions
            </button>
          </nav>
        </div>
        <div className="settings-toolbar">
          <input
            aria-label="Search parameters"
            placeholder="Search parameters..."
          />
          <button type="button" aria-label="Notifications">
            bell
          </button>
          <button type="button" aria-label="Help">
            help
          </button>
          <button type="button" aria-label="Account">
            user
          </button>
        </div>
      </header>

      <div className="settings-body">
        <aside className="settings-groups" aria-label="Configuration groups">
          <div className="settings-group-heading">CONFIGURATION GROUPS</div>

          <button
            type="button"
            className={settingsSection === "models" ? "active" : ""}
            onClick={() => setSettingsSection("models")}
          >
            <span className="settings-svg-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <rect x="5" y="5" width="14" height="14" rx="3" />
                <path d="M9 9h6v6H9z" />
                <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
              </svg>
            </span>
            <strong>Models</strong>
          </button>

          <button type="button" disabled>
            <span className="settings-svg-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M17.5 18H8a4 4 0 1 1 .9-7.9A5.5 5.5 0 0 1 19 12.7 2.7 2.7 0 0 1 17.5 18Z" />
              </svg>
            </span>
            <strong>Environments</strong>
          </button>

          <button
            type="button"
            className={settingsSection === "sessions" ? "active" : ""}
            onClick={() => setSettingsSection("sessions")}
          >
            <span className="settings-svg-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M4 12a8 8 0 1 0 2.35-5.65" />
                <path d="M4 5v5h5" />
                <path d="M12 8v5l3 2" />
              </svg>
            </span>
            <strong>Sessions</strong>
          </button>

          <button type="button" disabled>
            <span className="settings-svg-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M12 3l7 3v5.5c0 4.2-2.8 7.8-7 9.5-4.2-1.7-7-5.3-7-9.5V6l7-3Z" />
                <path d="M9.5 12.5l1.7 1.7 3.8-4.2" />
              </svg>
            </span>
            <strong>Security &amp; Auth</strong>
          </button>

          <button type="button" disabled>
            <span className="settings-svg-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M4 19V5" />
                <path d="M4 19h17" />
                <path d="M8 16v-5" />
                <path d="M13 16V8" />
                <path d="M18 16v-8" />
              </svg>
            </span>
            <strong>Usage Analytics</strong>
          </button>
        </aside>

        <section className="settings-content" aria-label="Models configuration">
          <div className="settings-content-inner">
            {settingsSection === "sessions" ? (
              <SessionsSettingsPanel
                hiddenSessions={hiddenSessions}
                onRestoreSession={onRestoreSession}
              />
            ) : (
              <>
                <header className="settings-heading">
                  <h2>Models configuration</h2>
                  <p>
                    Manage large language model endpoints, API credentials, and
                    performance parameters.
                  </p>
                </header>

                <div className="model-grid">
                  {modelCards.map((model) => {
                    const isActive = draftSettings?.activeModelId === model.id;
                    return (
                      <button
                        key={model.id}
                        className={`model-card ${isActive ? "active" : "muted"}`}
                        type="button"
                        onClick={() => selectModel(model.id)}
                      >
                        <div className="model-card-top">
                          <span className="model-icon">{model.provider}</span>
                          {isActive ? (
                            <span className="model-badge">Active</span>
                          ) : null}
                        </div>
                        <strong>{model.name}</strong>
                        <small>{model.model}</small>
                      </button>
                    );
                  })}
                </div>

                <section className="settings-card">
                  <header className="settings-card-header">
                    <div className="settings-card-title">
                      <span className="ds-logo">
                        {activeModel?.provider.slice(0, 2).toUpperCase() ??
                          "--"}
                      </span>
                      <div>
                        <h3>
                          {activeModel
                            ? `${activeModel.name} Configuration`
                            : "Model Configuration"}
                        </h3>
                        <p>
                          {hasUnsavedChanges
                            ? "Unsaved changes"
                            : "Saved configuration"}
                        </p>
                      </div>
                    </div>
                    <span className="operational-badge">
                      {activeModel?.enabled ? "Operational" : "Disabled"}
                    </span>
                  </header>

                  <div className="settings-form">
                    <section className="settings-row">
                      <div>
                        <h4>API Credentials</h4>
                        <p>
                          Secure access keys for the selected model provider
                          endpoint.
                        </p>
                      </div>
                      <div className="settings-fields">
                        <div>
                          <span>Support Models</span>
                          {activeModel?.provider === "deepseek" ? (
                            <p>
                              1. {activeModel?.supportModels?.[0] ?? "-"}
                              <br />
                              2. {activeModel?.supportModels?.[1] ?? "-"}
                            </p>
                          ) : (
                            <p>
                              Current:{" "}
                              <strong>{activeModel?.model ?? "-"}</strong>
                            </p>
                          )}
                        </div>
                        <label>
                          <span>Base URL</span>
                          <input
                            type="text"
                            value={activeModel?.baseUrl ?? ""}
                            onChange={(event) =>
                              updateSelectedModel((model) => ({
                                ...model,
                                baseUrl: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>API Key</span>
                          <div className="secret-field">
                            <input
                              type={showApiKey ? "text" : "password"}
                              value={activeModel?.apiKey ?? ""}
                              placeholder="Paste API key..."
                              onChange={(event) =>
                                updateSelectedModel((model) => ({
                                  ...model,
                                  apiKey: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              aria-label="Show API key"
                              onClick={() => setShowApiKey((value) => !value)}
                            >
                              {showApiKey ? "hide" : "show"}
                            </button>
                          </div>
                        </label>
                        <label>
                          <span>Organization ID (Optional)</span>
                          <input
                            type="text"
                            value={activeModel?.organizationId ?? ""}
                            placeholder="Optional"
                            onChange={(event) =>
                              updateSelectedModel((model) => ({
                                ...model,
                                organizationId: event.target.value || null,
                              }))
                            }
                          />
                        </label>
                      </div>
                    </section>

                    <section className="settings-row">
                      <div>
                        <h4>Advanced Parameters</h4>
                        <p>
                          Control the deterministic nature and context limits of
                          the inference engine.
                        </p>
                      </div>
                      <div className="settings-fields two-column">
                        <label>
                          <span>Max Tokens</span>
                          <div className="token-field">
                            <input
                              type="number"
                              min="1"
                              value={activeModel?.maxTokens ?? 4096}
                              onChange={(event) =>
                                updateSelectedModel((model) => ({
                                  ...model,
                                  maxTokens: Math.max(
                                    1,
                                    Number(event.target.value) || 1,
                                  ),
                                }))
                              }
                            />
                            <em>TOK</em>
                          </div>
                        </label>
                        <label>
                          <span>Temperature</span>
                          <input
                            className="temperature-range"
                            max="2"
                            min="0"
                            step="0.1"
                            type="range"
                            value={activeModel?.temperature ?? 0.7}
                            onChange={(event) =>
                              updateSelectedModel((model) => ({
                                ...model,
                                temperature: Number(event.target.value),
                              }))
                            }
                          />
                          <div className="range-labels">
                            <small>0.0</small>
                            <small>
                              Current: {activeModel?.temperature ?? 0.7}
                            </small>
                            <small>2.0</small>
                          </div>
                        </label>
                      </div>
                    </section>

                    <section className="settings-row">
                      <div>
                        <h4>Performance Graph</h4>
                        <p>Inference latency over the last 24 hours.</p>
                      </div>
                      <div
                        className="performance-graph"
                        aria-label="Performance graph placeholder"
                      >
                        <div className="graph-bars">
                          {Array.from({ length: 24 }, (_, index) => (
                            <span
                              key={index}
                              style={{ height: `${24 + ((index * 19) % 72)}%` }}
                            />
                          ))}
                        </div>
                        <svg
                          viewBox="0 0 480 120"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                        >
                          <polyline points="0,88 45,74 90,52 135,92 180,80 225,58 270,48 315,82 360,70 405,54 480,66" />
                        </svg>
                      </div>
                    </section>
                  </div>

                  <footer className="settings-actions">
                    <button
                      className="test-button"
                      type="button"
                      onClick={handleTestConnection}
                      disabled={!activeModel || isTesting}
                    >
                      {isTesting ? "Testing..." : "Test Connection"}
                    </button>
                    <div>
                      <button
                        className="discard-button"
                        type="button"
                        onClick={handleDiscardSettings}
                        disabled={!hasUnsavedChanges || isSaving}
                      >
                        Discard
                      </button>
                      <button
                        className="save-button"
                        type="button"
                        onClick={handleSaveSettings}
                        disabled={!hasUnsavedChanges || isSaving}
                      >
                        {isSaving ? "Saving..." : "Save Changes"}
                      </button>
                    </div>
                  </footer>
                </section>

                <section className="settings-help">
                  <div>
                    <span aria-hidden="true">i</span>
                    <div>
                      <strong>Need help configuring DeepSeek?</strong>
                      <p>{status}</p>
                    </div>
                  </div>
                  <button type="button">Read Docs -&gt;</button>
                </section>
              </>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function SessionsSettingsPanel({
  hiddenSessions,
  onRestoreSession,
}: SettingsViewProps) {
  return (
    <>
      <header className="settings-heading">
        <h2>Sessions</h2>
        <p>
          Deleted sessions are hidden only inside agent-ui. Claude Code jsonl
          files remain untouched and can be restored here.
        </p>
      </header>

      <section className="settings-card sessions-settings-card">
        <header className="settings-card-header">
          <div className="settings-card-title">
            <span className="ds-logo">JS</span>
            <div>
              <h3>Hidden sessions</h3>
              <p>
                {hiddenSessions.length} session
                {hiddenSessions.length === 1 ? "" : "s"} hidden from the
                sidebar.
              </p>
            </div>
          </div>
        </header>

        <div className="hidden-session-list">
          {hiddenSessions.length === 0 ? (
            <div className="hidden-session-empty">No hidden sessions.</div>
          ) : (
            hiddenSessions.map((session) => (
              <article
                className="hidden-session-row"
                key={sessionKey(session.root, session.sessionId)}
              >
                <div>
                  <strong>{session.title || session.sessionId}</strong>
                  <p>
                    {session.projectName} · {session.sessionId}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void onRestoreSession(session)}
                >
                  Restore
                </button>
              </article>
            ))
          )}
        </div>
      </section>
    </>
  );
}


function formatPreviewBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

const INLINE_IMAGE_PREVIEW_BYTES = 768 * 1024;

function MessageImagePreviews({
  root,
  links,
  onOpen,
}: {
  root: string;
  links?: StreamLink[];
  onOpen: (link: StreamLink) => void | Promise<void>;
}) {
  const imageLinks = (links ?? []).filter((link) => link.kind === "image");
  if (imageLinks.length === 0) {
    return null;
  }

  return (
    <div className="message-image-preview-grid">
      {imageLinks.map((link) => (
        <MessageImagePreviewItem key={link.id} root={root} link={link} onOpen={onOpen} />
      ))}
    </div>
  );
}

function MessageImagePreviewItem({
  root,
  link,
  onOpen,
}: {
  root: string;
  link: StreamLink;
  onOpen: (link: StreamLink) => void | Promise<void>;
}) {
  const [metadata, setMetadata] = useState<LocalImageMetadata | null>(null);
  const [preview, setPreview] = useState<LocalImagePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMetadata(null);
    setPreview(null);
    setError(null);

    if (!root) {
      setError("没有可用的 workspace root，无法读取本地图片。");
      return () => {
        cancelled = true;
      };
    }

    readLocalImageMetadata(root, link.path)
      .then(async (nextMetadata) => {
        if (cancelled) {
          return;
        }
        setMetadata(nextMetadata);

        if (nextMetadata.sizeBytes <= INLINE_IMAGE_PREVIEW_BYTES) {
          const nextPreview = await readLocalImagePreview(root, link.path);
          if (!cancelled) {
            setPreview(nextPreview);
          }
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [root, link.path]);

  if (preview) {
    return <InlineImagePreview link={link} preview={preview} onOpen={onOpen} />;
  }

  return <ImageArtifactCard link={link} metadata={metadata} error={error} onOpen={onOpen} />;
}

function InlineImagePreview({
  link,
  preview,
  onOpen,
}: {
  link: StreamLink;
  preview: LocalImagePreview;
  onOpen: (link: StreamLink) => void | Promise<void>;
}) {
  return (
    <button
      className="message-inline-image-preview"
      type="button"
      onClick={() => void onOpen(link)}
      title="点击在右侧查看大图"
    >
      <img alt={link.label} src={preview.dataUrl} />
      <span className="message-inline-image-meta">
        <strong>{link.label}</strong>
        <small>{formatPreviewBytes(preview.sizeBytes)} · 点击右侧预览</small>
      </span>
    </button>
  );
}

function ImageArtifactCard({
  link,
  metadata,
  error,
  onOpen,
}: {
  link: StreamLink;
  metadata?: LocalImageMetadata | null;
  error?: string | null;
  onOpen: (link: StreamLink) => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopyPath(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    await navigator.clipboard?.writeText(link.path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  const metadataSizeBytes = typeof metadata?.sizeBytes === "number"
    ? metadata.sizeBytes
    : typeof metadata?.size_bytes === "number"
      ? metadata.size_bytes
      : undefined;
  const sizeLabel = typeof metadataSizeBytes === "number" ? formatPreviewBytes(metadataSizeBytes) : error ? "预览信息读取失败" : "读取中…";
  const isLarge = typeof metadataSizeBytes === "number" ? metadataSizeBytes > INLINE_IMAGE_PREVIEW_BYTES : false;

  return (
    <div className="message-image-artifact-card">
      <button
        className="message-image-artifact-main"
        type="button"
        onClick={() => void onOpen(link)}
        title="点击在右侧预览图片"
      >
        <span className="image-artifact-icon" aria-hidden="true">▧</span>
        <span className="image-artifact-copy">
          <strong>{link.label}</strong>
          <small>{sizeLabel}{isLarge ? " · 大图右侧预览" : ""}</small>
          <small>{link.path}</small>
        </span>
        <span className="image-artifact-open">右侧预览</span>
      </button>
      <button
        className="image-artifact-copy-button"
        type="button"
        onClick={(event) => void handleCopyPath(event)}
      >
        {copied ? "已复制" : "复制路径"}
      </button>
    </div>
  );
}

function ReferencePanel({ link, root }: { link: StreamLink; root: string }) {
  if (link.kind === "image") {
    return <ImageReferencePanel link={link} root={root} />;
  }

  const label = link.kind === "pdf" ? "PDF Preview(todo)" : "Preview(todo)";
  return (
    <section className="reference-workbench">
      <div className="detail-header">
        <div>
          <div className="eyebrow">{link.kind}</div>
          <h2>{link.label}</h2>
        </div>
        <span className="count-label">preview</span>
      </div>

      <div className="reference-card">
        <strong>{link.path}</strong>
        <p>{label}</p>
      </div>
    </section>
  );
}

function ImageReferencePanel({ link, root }: { link: StreamLink; root: string }) {
  const [preview, setPreview] = useState<LocalImagePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);

    if (!root) {
      setError("没有可用的 workspace root，无法读取本地图片。");
      return () => {
        cancelled = true;
      };
    }

    readLocalImagePreview(root, link.path)
      .then((nextPreview) => {
        if (!cancelled) {
          setPreview(nextPreview);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [root, link.path]);

  async function handleCopyPath() {
    await navigator.clipboard?.writeText(preview?.path ?? link.path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <section className="reference-workbench image-reference-workbench">
      <div className="detail-header image-reference-header">
        <div>
          <div className="eyebrow">Image Artifact</div>
          <h2>{link.label}</h2>
        </div>
        <div className="image-reference-actions">
          {preview ? (
            <span className="count-label">
              {preview.mimeType} · {formatPreviewBytes(preview.sizeBytes)}
            </span>
          ) : null}
          <button type="button" onClick={() => void handleCopyPath()}>
            {copied ? "已复制" : "复制路径"}
          </button>
        </div>
      </div>

      <div className="image-reference-path" title={preview?.path ?? link.path}>
        {preview?.path ?? link.path}
      </div>

      <div className="image-reference-stage">
        {preview ? (
          <img alt={link.label} src={preview.dataUrl} />
        ) : error ? (
          <div className="image-reference-placeholder failed">
            <strong>图片预览失败</strong>
            <p>{error}</p>
          </div>
        ) : (
          <div className="image-reference-placeholder">
            <strong>正在加载图片…</strong>
            <p>大图不会塞进聊天流，会在右侧预览面板渲染。</p>
          </div>
        )}
      </div>
    </section>
  );
}


function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

function parseCsvPreview(content: string, maxRows = 120, maxColumns = 28): {
  header: string[];
  rows: string[][];
  totalRowsInContent: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
} {
  const allLines = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const parsedRows = allLines.map(parseCsvLine);
  const widest = parsedRows.reduce((max, row) => Math.max(max, row.length), 0);
  const truncatedColumns = widest > maxColumns;
  const width = Math.min(widest, maxColumns);
  const headerSource = parsedRows[0] ?? [];
  const header = Array.from({ length: width }, (_, index) => {
    const value = headerSource[index]?.trim();
    return value || `Column ${index + 1}`;
  });
  const bodySource = parsedRows.slice(1, maxRows + 1);
  const rows = bodySource.map((row) =>
    Array.from({ length: width }, (_, index) => row[index] ?? ""),
  );
  return {
    header,
    rows,
    totalRowsInContent: Math.max(0, parsedRows.length - 1),
    truncatedRows: parsedRows.length - 1 > maxRows,
    truncatedColumns,
  };
}


function isHtmlFilePath(path: string, language?: string) {
  const lowerPath = path.toLowerCase();
  const lowerLanguage = language?.toLowerCase() ?? "";
  return (
    lowerLanguage === "html" ||
    lowerLanguage === "htm" ||
    lowerPath.endsWith(".html") ||
    lowerPath.endsWith(".htm")
  );
}

function CsvDataPreview({ file }: { file: FileView }) {
  const preview = useMemo(() => parseCsvPreview(file.content), [file.content]);
  const [copied, setCopied] = useState(false);

  async function handleCopyPath() {
    await navigator.clipboard?.writeText(file.path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="csv-data-preview">
      <div className="csv-data-toolbar">
        <div>
          <strong>CSV 数据预览</strong>
          <span>
            {formatFileSize(file.size_bytes)} · {file.total_lines} lines · 预览 {preview.rows.length} / {preview.totalRowsInContent} rows
            {preview.truncatedColumns ? " · 列已截断" : ""}
          </span>
        </div>
        <button type="button" onClick={() => void handleCopyPath()}>
          {copied ? "已复制路径" : "复制路径"}
        </button>
      </div>
      {(preview.truncatedRows || preview.truncatedColumns) ? (
        <div className="csv-data-notice">
          为避免卡顿，右侧面板只预览前 120 行、前 28 列。完整内容仍按引用规则发送给 Claude Code，超出注入上限时会截断。
        </div>
      ) : null}
      <div className="csv-data-table-wrap">
        <table className="csv-data-table">
          <thead>
            <tr>
              {preview.header.map((column, index) => (
                <th key={`${column}-${index}`}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, columnIndex) => (
                  <td key={`${rowIndex}-${columnIndex}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function HtmlRichPreview({
  content,
  title,
}: {
  content: string;
  title?: string;
}) {
  return (
    <div className="html-rich-preview">
      <iframe
        title={title ?? "HTML preview"}
        sandbox="allow-scripts"
        srcDoc={content}
      />
    </div>
  );
}

function CodePreview({ content }: { content: string }) {
  return (
    <div className="code-preview">
      <div className="line-gutter" aria-hidden="true">
        {lineNumberPreview(content).map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
      <pre>{content}</pre>
    </div>
  );
}


type RichMarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; language: string; code: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "quote"; text: string };

function parseMarkdownTable(lines: string[], startIndex: number): {
  block?: RichMarkdownBlock;
  nextIndex: number;
} {
  const separator = lines[startIndex + 1];
  if (!lines[startIndex]?.trim().startsWith("|") || !separator?.trim().startsWith("|")) {
    return { nextIndex: startIndex };
  }

  const separatorCells = separator
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

  if (!separatorCells.length || !separatorCells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    return { nextIndex: startIndex };
  }

  const rows: string[][] = [];
  let index = startIndex;
  while (index < lines.length && lines[index].trim().startsWith("|")) {
    const line = lines[index].trim();
    rows.push(
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
    index += 1;
  }

  const [header, , ...bodyRows] = rows;
  if (!header || bodyRows.length === 0) {
    return { nextIndex: startIndex };
  }

  return {
    block: { kind: "table", header, rows: bodyRows },
    nextIndex: index,
  };
}

function splitRichMarkdown(content: string): RichMarkdownBlock[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: RichMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fenceMatch = trimmed.match(/^```\s*([\w.+-]*)\s*$/);
    if (fenceMatch) {
      const language = fenceMatch[1] || "text";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ kind: "code", language, code: codeLines.join("\n") });
      continue;
    }

    const table = parseMarkdownTable(lines, index);
    if (table.block) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        level: headingMatch[1].length as 1 | 2 | 3,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quoteLines.join("\n") });
      continue;
    }

    if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      const ordered = /^\d+[.)]\s+/.test(trimmed);
      const items: string[] = [];
      const itemPattern = ordered ? /^\d+[.)]\s+/ : /^[-*]\s+/;
      while (index < lines.length && itemPattern.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(itemPattern, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (
        !next ||
        next.startsWith("```") ||
        next.startsWith("|") ||
        /^#{1,3}\s+/.test(next) ||
        /^>\s?/.test(next) ||
        /^[-*]\s+/.test(next) ||
        /^\d+[.)]\s+/.test(next)
      ) {
        break;
      }
      paragraphLines.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function renderRichInline(text: string, keyPrefix: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    const key = `${keyPrefix}:${index}`;
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code className="rich-inline-code" key={key}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    return <span key={key}>{part}</span>;
  });
}

function isFileAccessNotice(content: string): boolean {
  return (
    /无法直接读取|outside|之外|cannot directly read|permission|权限/i.test(content) &&
    /文件|path|workspace|工作目录|cwd|目录/i.test(content)
  );
}

function RichMarkdownMessage({
  content,
  compact = false,
}: {
  content: string;
  compact?: boolean;
}) {
  const blocks = splitRichMarkdown(content);
  const className = `rich-markdown-message${compact ? " compact" : ""}${
    isFileAccessNotice(content) ? " file-access-notice" : ""
  }`;

  return (
    <div className={className}>
      {isFileAccessNotice(content) ? (
        <div className="rich-notice-banner">
          <span aria-hidden="true">!</span>
          <strong>文件访问提示</strong>
        </div>
      ) : null}
      {blocks.map((block, index) => {
        const key = `rich:${index}`;
        if (block.kind === "heading") {
          const Heading = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
          return <Heading key={key}>{renderRichInline(block.text, key)}</Heading>;
        }
        if (block.kind === "paragraph") {
          return <p key={key}>{renderRichInline(block.text, key)}</p>;
        }
        if (block.kind === "quote") {
          return <blockquote key={key}>{renderRichInline(block.text, key)}</blockquote>;
        }
        if (block.kind === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag className="rich-list" key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}:${itemIndex}`}>{renderRichInline(item, `${key}:${itemIndex}`)}</li>
              ))}
            </ListTag>
          );
        }
        if (block.kind === "code") {
          return (
            <div className="rich-code-block" key={key}>
              <div className="rich-code-header">
                <span>{block.language || "text"}</span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(block.code)}
                >
                  复制
                </button>
              </div>
              <pre>{block.code}</pre>
            </div>
          );
        }
        if (block.kind === "table") {
          return (
            <div className="rich-table-wrap" key={key}>
              <table>
                <thead>
                  <tr>
                    {block.header.map((cell, cellIndex) => (
                      <th key={`${key}:h:${cellIndex}`}>{renderRichInline(cell, `${key}:h:${cellIndex}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`${key}:r:${rowIndex}`}>
                      {block.header.map((_, cellIndex) => (
                        <td key={`${key}:r:${rowIndex}:${cellIndex}`}>
                          {renderRichInline(row[cellIndex] ?? "", `${key}:r:${rowIndex}:${cellIndex}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="markdown-preview">
      {lines.map((line, index) => {
        if (line.startsWith("### ")) {
          return <h3 key={index}>{line.slice(4)}</h3>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={index}>{line.slice(3)}</h2>;
        }
        if (line.startsWith("# ")) {
          return <h1 key={index}>{line.slice(2)}</h1>;
        }
        if (line.startsWith("- ")) {
          return (
            <p className="markdown-list" key={index}>
              {line}
            </p>
          );
        }
        if (!line.trim()) {
          return <div className="markdown-space" key={index} />;
        }
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}

function MarkdownTablePreview({ content }: { content: string }) {
  const rows = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.some((cell) => cell.length > 0));

  if (rows.length < 2) {
    return <p>{content}</p>;
  }

  const [header, ...rest] = rows.filter(
    (cells) =>
      !cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, ""))),
  );

  return (
    <div className="table-preview">
      <table>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={`${cell}-${index}`}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rest.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
