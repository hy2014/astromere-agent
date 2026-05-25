import type { StreamLink, LocalFileReferenceSummary, WorkspaceFileReference, StreamItem, AgentReplStreamEvent } from "../types";
import type { LocalFileReference, ProjectSession, DebugStreamEvent, AssistantMessageDebugBundle } from "./types";
import type { FileMentionState, SlashCommandMenuState } from "./types";
import type { RemoteProfile } from "../runtime";
import type { RuntimeSessionDetail } from "../types";
import {
  getActiveRemoteProfileId,
  loadRemoteProfiles,
  readLocalReferenceFile,
  loadTypedRuntimeSession,
} from "../runtime";

// ── Storage keys ──────────────────────────────────────────────────────────

export const hiddenSessionsStorageKey = "agent-ui.hiddenSessions.v1";

// ── Preview / link utilities ──────────────────────────────────────────────

export const previewablePathPattern =
  /(?:^|[\s([`"'])((?:(?:~|～)\/|\/|[A-Za-z0-9_.@-]+\/)[^\n`"'<>|]*?\.(?:ck|rs|ts|tsx|js|jsx|json|toml|md|markdown|txt|csv|pdf|png|jpg|jpeg|gif|webp|svg|html|css|py|go|java|kt|swift|c|cc|cpp|h|hpp|yaml|yml|sql|sh|zsh|fish|rb|php|vue|svelte))(?:$|[\s)\]，。,.!?;:'"`])/gi;

export function cleanPreviewPath(path: string): string {
  return path
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^['\"]+|['\"]+$/g, "")
    .replace(/[),.;，。！？!?]+$/g, "")
    .replace(/^～\//, "~/");
}

export function linkKindForPath(path: string): StreamLink["kind"] {
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

export function extractPreviewLinks(text: string): StreamLink[] {
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

// ── Role formatting ───────────────────────────────────────────────────────

export function displayRole(role: "user" | "assistant"): string {
  return role === "user" ? "You" : "AI Assistant";
}

// ── Line / file utilities ─────────────────────────────────────────────────

export function lineNumberPreview(content: string): number[] {
  return Array.from(
    { length: Math.min(content.split("\n").length, 200) },
    (_, index) => index + 1,
  );
}

export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

// ── Project / session utilities ───────────────────────────────────────────

export function projectIdFromRoot(root: string): string {
  return `project:${root}`;
}

export function isNewSessionId(sessionId: string): boolean {
  return sessionId.startsWith("new-") || sessionId.startsWith("pending-");
}

export function createClaudeSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function createPendingSession(): ProjectSession {
  return {
    id: createClaudeSessionId(),
    title: "新会话",
    isPending: true,
    processStatus: "stopped",
  };
}

export function sessionKey(root: string, sessionId: string): string {
  return `${root}\n${sessionId}`;
}

// ── Session title utilities ───────────────────────────────────────────────

export function truncateSessionTitle(value: string, maxLength = 80): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized || "新会话";
  }
  return `${normalized.slice(0, maxLength)}…`;
}

export function firstUserTitleFromStream(items: StreamItem[]): string | null {
  const userMessage = items.find(
    (item) => item.kind === "message" && item.role === "user",
  );
  return userMessage?.kind === "message"
    ? truncateSessionTitle(userMessage.text)
    : null;
}

// ── Array utilities ───────────────────────────────────────────────────────

export function addUniqueString(items: string[], value: string | null | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed || items.includes(trimmed)) {
    return items;
  }
  return [...items, trimmed];
}

// ── CSV detection ─────────────────────────────────────────────────────────

export function isCsvFilePath(path?: string | null, language?: string | null): boolean {
  const normalizedPath = (path ?? "").trim().toLowerCase();
  const normalizedLanguage = (language ?? "").trim().toLowerCase();
  return normalizedLanguage === "csv" || normalizedPath.endsWith(".csv");
}

// ── Local file reference utilities ────────────────────────────────────────

export function isLocalReferenceLink(link: StreamLink): boolean {
  return link.id.startsWith("local-reference:");
}

export function localReferenceToStreamLink(reference: LocalFileReference): StreamLink {
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

export function localFileReferenceName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || normalized || "file";
}

export function localFileReferenceSummaryToStreamLink(reference: LocalFileReferenceSummary): StreamLink {
  const normalizedPath = reference.path;
  const label = reference.name || localFileReferenceName(normalizedPath);
  return {
    id: `local-reference:${normalizedPath}`,
    label,
    kind: linkKindForPath(normalizedPath),
    path: normalizedPath,
  };
}

export function isAbsoluteOrHomeReferencePath(path: string): boolean {
  const normalized = path.trim();
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("～/")
  );
}

export function shouldReadAsLocalReference(link: StreamLink): boolean {
  return isLocalReferenceLink(link) || isAbsoluteOrHomeReferencePath(link.path);
}

// ── Prompt display utilities ──────────────────────────────────────────────

const localFileReferenceBlockPattern =
  /\n*<agent-ui-local-file-references>[\s\S]*?<\/agent-ui-local-file-references>\s*/gi;

export function stripLocalFileReferenceBlock(text: string): string {
  return text.replace(localFileReferenceBlockPattern, "").trim();
}

export function commandEnvelopeDisplayText(text: string): string | null {
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

export function displayPromptText(text: string): string {
  return commandEnvelopeDisplayText(text) ?? (stripLocalFileReferenceBlock(text) || text.trim());
}

// ── Type guard ────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// ── Number formatting ─────────────────────────────────────────────────────

export function formatPreviewBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatContextTokens(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "--";
  }
  if (value >= 1_000_000) {
    const text = (value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1);
    return `${text.replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(Math.round(value));
}

// ── Time utilities ────────────────────────────────────────────────────────

export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

export function formatDateTimeNoLocale(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    window.alert(`[datetime] invalid timestamp: ${String(timestampMs)}`);
    throw new Error(`[datetime] invalid timestamp: ${String(timestampMs)}`);
  }
  const date = new Date(timestampMs);
  const pad2 = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function formatDebugTime(timestamp: number): string {
  return formatDateTimeNoLocale(timestamp);
}

// ── Debug event utilities ──────────────────────────────────────────────

export function modelCallIdFromRawJson(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const message = value.message;
  if (!isRecord(message)) {
    return null;
  }
  const id = message.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function rawJsonFromDebugEvent(event: DebugStreamEvent): Record<string, unknown> | null {
  const rawJson = event.payload.raw_json;
  if (isRecord(rawJson)) {
    return rawJson;
  }
  return isRecord(event.payload) ? event.payload : null;
}

// ── Remote profile utilities ───────────────────────────────────────────

export function loadActiveRemoteProfileSnapshot(): RemoteProfile | null {
  try {
    const activeProfileId = getActiveRemoteProfileId();
    if (!activeProfileId) return null;
    return loadRemoteProfiles().find((profile) => profile.id === activeProfileId) ?? null;
  } catch {
    return null;
  }
}

function getActiveRemoteProfileBaseUrl(): string | null {
  const profile = loadActiveRemoteProfileSnapshot();
  return profile?.baseUrl ?? null;
}

export async function clientDebugLog(level: string, message: string, data?: unknown) {
  try {
    const baseUrl = getActiveRemoteProfileBaseUrl();
    if (!baseUrl) return;
    await fetch(`${baseUrl}/debug/log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level, message, data }),
    });
  } catch {
    // silent — logging should never break the app
  }
}

// ── Clipboard ──────────────────────────────────────────────────────────

export async function copyTextToClipboard(text: string): Promise<void> {
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

// ── Number / formatting utilities ─────────────────────────────────────

export function formatFileSize(bytes?: number | null): string {
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

export function sanitizeFenceContent(content: string): string {
  return content.replace(/```/g, "`\u200b``");
}

export function languageFence(language: string, path: string): string {
  const normalized = language.trim() || path.split(".").pop() || "text";
  return normalized.replace(/[^a-zA-Z0-9_-]/g, "") || "text";
}

// ── Fence / text utilities ──────────────────────────────────────────

export function extractPromptSkillToken(value: string): string | null {
  const match = value.trimStart().match(/^\/([A-Za-z0-9:_-]+)/);
  return match?.[1] ?? null;
}

// ── File mention / slash command detection ───────────────────────────

export function detectFileMention(value: string, cursor: number): FileMentionState {
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

export function detectSlashCommandMenu(
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

// ── File reference parsing ─────────────────────────────────────────────

export function parseLocalFileReferenceSummaries(text: string): LocalFileReferenceSummary[] {
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

export function localFileReferencesFromPromptText(text: string): LocalFileReferenceSummary[] {
  return parseLocalFileReferenceSummaries(text);
}

const maxReferencedFileBytes = 48 * 1024;
const maxReferencedFilesTotalBytes = 160 * 1024;

type LocalFileReferenceBuildResult = {
  prompt: string;
  fileReferences: LocalFileReferenceSummary[];
};

export async function buildPromptWithLocalFileReferences(
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

// ── Debug storage utilities ────────────────────────────────────────────

export function debugStorageSource(event: Pick<DebugStreamEvent, "debugStorageSource">): string {
  const source = event.debugStorageSource;
  if (typeof source !== "string" || !source.trim()) {
    const message = "ERROR: debug event missing required debugStorageSource/source. No fallback is allowed.";
    if (typeof window !== "undefined") {
      window.alert(message);
    }
    throw new Error(message);
  }
  return source.trim();
}

export function debugStorageSourceCounts(
  events: Array<Pick<DebugStreamEvent, "debugStorageSource">>,
): Record<string, number> {
  return events.reduce<Record<string, number>>((counts, event) => {
    const source = debugStorageSource(event);
    counts[source] = (counts[source] ?? 0) + 1;
    return counts;
  }, {});
}

export function debugStorageSourceSummary(
  events: Array<Pick<DebugStreamEvent, "debugStorageSource">>,
): string {
  const entries = Object.entries(debugStorageSourceCounts(events));
  if (entries.length === 0) {
    return "source: none";
  }
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, count]) => `${source}: ${count}`)
    .join(" · ");
}

// ── Permission utilities ───────────────────────────────────────────────

export function isPermissionEventName(eventType: string): boolean {
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

export function permissionToolNameFromEvent(event: AgentReplStreamEvent): string {
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

export function permissionRequestIdFromEvent(event: AgentReplStreamEvent): string {
  const rawJson = isRecord(event.payload.raw_json) ? event.payload.raw_json : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  const candidate =
    event.payload.requestId ??
    event.payload.request_id ??
    rawJson.request_id ??
    request.request_id;
  return typeof candidate === "string" ? candidate : "";
}

export function permissionInputFromEvent(event: AgentReplStreamEvent): unknown {
  const rawJson = isRecord(event.payload.raw_json) ? event.payload.raw_json : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  return event.payload.input ?? request.input ?? (isRecord(request.request) ? request.request.input : undefined);
}

// ── Bundle / assistant display utilities ───────────────────────────────

export function assistantOutputTimestampMsFromBundle(
  bundle: Pick<AssistantMessageDebugBundle, "events"> | null | undefined,
): number | null {
  const events = bundle?.events ?? [];
  if (events.length === 0) {
    return null;
  }

  for (const event of events) {
    if (event.eventType !== "turn_text" && event.eventType !== "assistant_tool_use") {
      continue;
    }
    const rawJson = rawJsonFromDebugEvent(event);
    const rawType = rawJson?.type;
    const payloadEventType = event.payload.event_type;
    if (rawType !== "assistant" && payloadEventType !== "assistant") {
      continue;
    }
    return event.receivedAt;
  }

  return null;
}

export function assistantUsageOutputDateTimeFromBundle(
  bundle: Pick<AssistantMessageDebugBundle, "events"> | null | undefined,
): string | null {
  const timestampMs = assistantOutputTimestampMsFromBundle(bundle);
  if (timestampMs === null) {
    return null;
  }
  return formatDateTimeNoLocale(timestampMs);
}

export function assistantUsageButtonTitle(
  bundle: Pick<AssistantMessageDebugBundle, "events"> | null | undefined,
): string {
  const outputDateTime = assistantUsageOutputDateTimeFromBundle(bundle);
  return outputDateTime ? `输出时间 ${outputDateTime}` : "查看 Usage";
}

// ── Runtime utilities ──────────────────────────────────────────────────

export async function loadTypedRuntimeSessionWithRetry(
  root: string,
  reference: string,
  attempts = 12,
): Promise<RuntimeSessionDetail> {
  let lastError: unknown = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await loadTypedRuntimeSession(root, reference);
    } catch (reason) {
      lastError = reason;
      await waitMs(150);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
