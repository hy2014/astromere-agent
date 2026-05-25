import type { StreamLink, LocalFileReferenceSummary, WorkspaceFileReference, StreamItem } from "../types";
import type { LocalFileReference, ProjectSession, DebugStreamEvent } from "./types";

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
