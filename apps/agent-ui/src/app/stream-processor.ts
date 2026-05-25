import type {
  AgentReplStreamEvent,
  StreamItem,
  LocalFileReferenceSummary,
  RuntimeSessionDetail,
} from "../types";
import type {
  DebugStreamEvent,
  AssistantMessageDebugBundle,
  FileMentionState,
  SlashCommandMenuState,
  ResolvedRuntimeBundleEvent,
  RuntimeSessionArtifacts,
  AssistantProcessTimelineItem,
} from "./types";
import {
  isRecord,
  addUniqueString,
  displayPromptText,
  commandEnvelopeDisplayText,
  extractPreviewLinks,
  localFileReferenceName,
  formatDateTimeNoLocale,
  rawJsonFromDebugEvent,
  modelCallIdFromRawJson,
} from "./file-utils";

// ─── Event utilities ────────────────────────────────────────────────────

export function realSessionIdFromEvent(event: AgentReplStreamEvent): string | null {
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

export function createDebugEvent(event: AgentReplStreamEvent): DebugStreamEvent {
  return {
    id: `debug:${event.sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    sessionId: event.sessionId,
    root: event.root,
    eventType: event.eventType,
    receivedAt: Date.now(),
    payload: event.payload,
    debugStorageSource: "runtime-memory",
  };
}

export function appendDebugEvent(
  current: Record<string, DebugStreamEvent[]>,
  entry: DebugStreamEvent,
): Record<string, DebugStreamEvent[]> {
  const events = [...(current[entry.sessionId] ?? []), entry].slice(-600);
  return {
    ...current,
    [entry.sessionId]: events,
  };
}

export function modelCallIdFromEvent(event: AgentReplStreamEvent): string | null {
  return modelCallIdFromRawJson(event.payload.raw_json);
}

export function isAssistantBundleStartEvent(event: AgentReplStreamEvent): boolean {
  if (event.eventType !== "turn_text" && event.eventType !== "tool_call") {
    return false;
  }
  const rawJson = event.payload.raw_json;
  return isRecord(rawJson) && rawJson.type === "assistant" && Boolean(modelCallIdFromRawJson(rawJson));
}

export function isBundleCompletionEvent(event: AgentReplStreamEvent): boolean {
  return (
    event.eventType === "turn_complete" ||
    event.eventType === "error" ||
    event.eventType === "interrupt" ||
    event.eventType === "process_exit"
  );
}

export function resolveRuntimeBundleEvent(
  event: AgentReplStreamEvent,
  currentBundleBySession: Record<string, string | null>,
): ResolvedRuntimeBundleEvent {
  const modelCallId = modelCallIdFromEvent(event);
  const previousBundleId = currentBundleBySession[event.sessionId] ?? null;
  let bundleId = previousBundleId;
  let createsBundle = false;

  if (isAssistantBundleStartEvent(event) && modelCallId) {
    if (!bundleId || bundleId.startsWith("assistant-pending-")) {
      bundleId = modelCallId;
      createsBundle = true;
      currentBundleBySession[event.sessionId] = bundleId;
    }
  }

  const completesBundle = isBundleCompletionEvent(event);
  if (completesBundle) {
    currentBundleBySession[event.sessionId] = null;
  }

  return {
    event,
    bundleId,
    previousBundleId: previousBundleId !== bundleId ? previousBundleId : null,
    modelCallId,
    createsBundle,
    completesBundle,
  };
}

export function rekeyAssistantBundle(
  current: Record<string, AssistantMessageDebugBundle>,
  previousBundleId: string | null,
  bundleId: string,
): Record<string, AssistantMessageDebugBundle> {
  if (!previousBundleId || previousBundleId === bundleId || !current[previousBundleId]) {
    return current;
  }

  const { [previousBundleId]: previous, ...rest } = current;
  return {
    ...rest,
    [bundleId]: {
      ...previous,
      messageId: bundleId,
      modelCallIds: addUniqueString(previous.modelCallIds ?? [], bundleId),
    },
  };
}

// ─── Assistant message progress ────────────────────────────────────────

export const pendingAssistantText = "Assistant is thinking…";

export function mergeProgressText(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  const previousText = previous?.trim();
  const nextText = next?.trim();

  if (!previousText) return nextText || undefined;
  if (!nextText) return previousText;

  if (previousText === nextText) return previousText;
  if (nextText.startsWith(previousText)) return nextText;
  if (previousText.endsWith(nextText)) return previousText;

  return `${previousText}${nextText}`;
}

export function currentTurnAssistantMessageIndex(items: StreamItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "message" && item.role === "assistant") {
      if (item.status === "streaming" || item.text === pendingAssistantText) {
        return index;
      }
      break;
    }
    if (item.kind === "message" && item.role === "user") {
      break;
    }
  }
  return -1;
}

export function collapseAssistantTurns(items: StreamItem[]): StreamItem[] {
  const collapsed: StreamItem[] = [];

  for (const item of items) {
    const previous = collapsed[collapsed.length - 1];

    if (
      previous &&
      previous.kind === "message" &&
      previous.role === "assistant" &&
      item.kind === "message" &&
      item.role === "assistant"
    ) {
      const previousProgress = previous.progressText?.trim();
      const itemProgress = item.progressText?.trim();
      const mergedProgress =
        previousProgress || itemProgress
          ? mergeProgressText(previousProgress, itemProgress)
          : undefined;

      collapsed[collapsed.length - 1] = {
        ...previous,
        text: item.text && item.text !== pendingAssistantText ? item.text : previous.text,
        links: item.links?.length ? item.links : previous.links,
        progressText: mergedProgress,
        status:
          item.status === "complete" || previous.status === "complete"
            ? "complete"
            : previous.status ?? item.status,
      };
      continue;
    }

    collapsed.push(item);
  }

  return collapsed;
}

export function upsertCurrentTurnProgressMessage(
  items: StreamItem[],
  sessionId: string,
  text: string,
  bundleId: string | null | undefined,
): StreamItem[] {
  const canonicalBundleId = bundleId?.trim();
  if (!canonicalBundleId) {
    console.warn("[agent-ui][bundle] assistant live event has no resolved bundle id; skip transient assistant StreamItem", {
      sessionId,
    });
    return items;
  }

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
      id: canonicalBundleId,
      kind: "message",
      role: "assistant",
      text: pendingAssistantText,
      progressText,
      status: "streaming",
    },
  ];
}

export function completeCurrentTurnAssistantMessage(
  items: StreamItem[],
  sessionId: string,
  text: string,
  bundleId: string | null | undefined,
): StreamItem[] {
  const canonicalBundleId = bundleId?.trim();
  if (!canonicalBundleId) {
    console.warn("[agent-ui][bundle] assistant complete event has no resolved bundle id; skip transient assistant StreamItem", {
      sessionId,
    });
    return items;
  }

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
      id: canonicalBundleId,
      kind: "message",
      role: "assistant",
      text: finalText,
      links: extractPreviewLinks(finalText),
      status: "complete",
    },
  ];
}

export function applyRuntimeDebugEventToBundle(
  current: Record<string, AssistantMessageDebugBundle>,
  resolved: ResolvedRuntimeBundleEvent,
  debugEvent: DebugStreamEvent,
): Record<string, AssistantMessageDebugBundle> {
  const { event, bundleId, previousBundleId, modelCallId, completesBundle } = resolved;
  if (!bundleId) {
    return current;
  }

  const rekeyed = rekeyAssistantBundle(current, previousBundleId, bundleId);
  const existing = rekeyed[bundleId];

  const text = payloadText(event);
  const displayText =
    event.eventType === "turn_complete" && text
      ? text
      : event.eventType === "turn_text" && text
        ? existing?.displayText && existing.displayText !== pendingAssistantText
          ? `${existing.displayText}${text}`
          : text
        : existing?.displayText ?? pendingAssistantText;

  const nextBundle: AssistantMessageDebugBundle = {
    messageId: bundleId,
    modelCallIds: addUniqueString(existing?.modelCallIds ?? [bundleId], modelCallId),
    sessionId: existing?.sessionId ?? event.sessionId,
    root: existing?.root ?? event.root,
    userMessage: existing?.userMessage,
    transportMessage: existing?.transportMessage,
    fileReferences: existing?.fileReferences,
    displayText,
    startedAt: existing?.startedAt ?? debugEvent.receivedAt,
    updatedAt: debugEvent.receivedAt,
    completed: existing?.completed === true || completesBundle,
    events: [...(existing?.events ?? []), debugEvent].slice(-300),
  };

  return {
    ...rekeyed,
    [bundleId]: nextBundle,
  };
}

export function rekeyAssistantStreamItem(
  items: StreamItem[],
  previousBundleId: string | null,
  bundleId: string | null,
): StreamItem[] {
  if (!previousBundleId || !bundleId || previousBundleId === bundleId) {
    return items;
  }
  return items.map((item) =>
    item.kind === "message" && item.role === "assistant" && item.id === previousBundleId
      ? { ...item, id: bundleId }
      : item,
  );
}

export function rekeyAssistantDebugBundles(
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

// ─── Mention / Slash command detection ─────────────────────────────────

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

export function extractPromptSkillToken(value: string): string | null {
  const match = value.trimStart().match(/^\/([A-Za-z0-9:_-]+)/);
  return match?.[1] ?? null;
}

// ─── Formatting utilities ──────────────────────────────────────────────

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

// ─── Local file reference parsing ──────────────────────────────────────

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

// ─── Debug event helpers ───────────────────────────────────────────────

export function rekeyDebugEvents(
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

export function welcomeStream(
  _projectName: string,
  _sessionTitle: string,
): StreamItem[] {
  return [];
}

// ─── Runtime message helpers ───────────────────────────────────────────

export function rawJsonFromRuntimeMessage(
  message: RuntimeSessionDetail["messages"][number],
): Record<string, unknown> | null {
  return isRecord(message.raw_json) ? message.raw_json : null;
}

export function checkpointUuidFromRuntimeMessage(
  message: RuntimeSessionDetail["messages"][number],
): string | undefined {
  if (typeof message.uuid === "string" && message.uuid.trim()) {
    return message.uuid.trim();
  }
  const rawJson = rawJsonFromRuntimeMessage(message);
  const uuid = rawJson?.uuid;
  return typeof uuid === "string" && uuid.trim() ? uuid.trim() : undefined;
}

export function assistantOutputTimestampMsFromBundle(
  bundle: AssistantMessageDebugBundle | null | undefined,
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
  bundle: AssistantMessageDebugBundle | null | undefined,
): string | null {
  const timestampMs = assistantOutputTimestampMsFromBundle(bundle);
  if (timestampMs === null) {
    return null;
  }
  return formatDateTimeNoLocale(timestampMs);
}

export function assistantUsageButtonTitle(
  bundle: AssistantMessageDebugBundle | null | undefined,
): string {
  const outputDateTime = assistantUsageOutputDateTimeFromBundle(bundle);
  return outputDateTime ? `输出时间 ${outputDateTime}` : "查看 Usage";
}

// ─── JSON/runtime type utilities ───────────────────────────────────────

export function jsonContainsTypedBlock(value: unknown, expectedType: string): boolean {
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

export function runtimeMessageRawType(
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

export function looksLikeRealRuntimeUserText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || normalized.startsWith("[Request interrupted")) {
    return false;
  }

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

export function isRuntimeRealUserMessage(
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

  if (rawJson && jsonContainsTypedBlock(rawJson, "tool_result")) {
    return false;
  }

  return looksLikeRealRuntimeUserText(message.text);
}

export function debugEventTypeForRuntimeMessage(
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

export function createHistoricalDebugEvent(
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
    debugStorageSource: "runtime",
    payload: {
      historical: true,
      text: message.text,
      event_type: message.event_type ?? null,
      raw_json: rawJson ?? undefined,
    },
  };
}

// ─── Tool / permission event utilities ─────────────────────────────────

export function extractToolUsesFromRawJson(value: unknown): Record<string, unknown>[] {
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

export function toolName(tool: Record<string, unknown>): string {
  const name = tool.name;
  return typeof name === "string" && name.trim() ? name : "Tool";
}

export function commandFromToolUse(tool: Record<string, unknown>): string | null {
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

export function summarizeToolUse(tool: Record<string, unknown>): string {
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

export function isToolResultEvent(event: DebugStreamEvent): boolean {
  const rawJson = rawJsonFromDebugEvent(event);
  return (
    event.eventType === "tool_result" ||
    rawJson?.type === "tool_result" ||
    rawJson?.type === "tool"
  );
}

export function truncateProcessDetail(value: string, limit = 900): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}…`;
}

export function textFromContentBlocks(content: unknown): string {
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

export function textFromProcessEvent(event: DebugStreamEvent): string {
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

export function summarizeToolResultEvent(event: DebugStreamEvent): string {
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

export function isPermissionEvent(event: DebugStreamEvent): boolean {
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

export function summarizePermissionEvent(event: DebugStreamEvent): string {
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

export function toolUsesFromProcessEvent(event: DebugStreamEvent): Record<string, unknown>[] {
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

export function assistantTurnDetails(
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
      const isApproved = event.eventType.includes("approved") || event.eventType.includes("response");
      timeline.push({
        id: `${baseId}:permission`,
        kind: "permission",
        title: isApproved
          ? "Permission response"
          : "Permission request",
        detail: summarizePermissionEvent(event),
        allowed: isApproved,
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

export function compactCountLabel(count: number, singular: string, plural = `${singular}s`) {
  if (count === 0) {
    return `0 ${plural}`;
  }
  return `${count} ${count === 1 ? singular : plural}`;
}

// ─── Runtime session history restoration ───────────────────────────────

export function runtimeSessionToArtifacts(
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
        modelCallIds: string[];
        events: DebugStreamEvent[];
        startedAt: number;
        updatedAt: number;
        checkpointUuid?: string;
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
        checkpointUuid: pendingAssistant.checkpointUuid,
      });
      bundles[pendingAssistant.id] = {
        messageId: pendingAssistant.id,
        modelCallIds: pendingAssistant.modelCallIds,
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
          checkpointUuid: checkpointUuidFromRuntimeMessage(message),
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

      const modelCallId = modelCallIdFromRawJson(rawJsonFromRuntimeMessage(message));
      const checkpointUuid = checkpointUuidFromRuntimeMessage(message);

      if (!pendingAssistant) {
        if (!modelCallId) {
          pendingTurnEvents = [...pendingTurnEvents, ...eventBatch].slice(-300);
          continue;
        }

        pendingAssistant = {
          id: modelCallId,
          text,
          modelCallIds: [modelCallId],
          events: eventBatch,
          startedAt: eventBatch[0]?.receivedAt ?? detail.updated_at_ms + index,
          updatedAt: eventBatch.length > 0 ? eventBatch[eventBatch.length - 1].receivedAt : detail.updated_at_ms + index,
          checkpointUuid,
        };
        continue;
      }

      pendingAssistant.modelCallIds = addUniqueString(
        pendingAssistant.modelCallIds,
        modelCallId,
      );
      if (checkpointUuid) {
        pendingAssistant.checkpointUuid = checkpointUuid;
      }

      if (text) {
        pendingAssistant.progressText = mergeProgressText(
          pendingAssistant.progressText,
          pendingAssistant.text,
        );
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

// ─── Permission / event name utilities ─────────────────────────────────

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

export function payloadText(event: AgentReplStreamEvent): string {
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

// ─── Stream event to items ─────────────────────────────────────────────

export function streamEventToItems(
  items: StreamItem[],
  resolved: ResolvedRuntimeBundleEvent,
): StreamItem[] {
  const event = resolved.event;
  if (isPermissionEventName(event.eventType)) {
    return items;
  }
  const baseId = `repl:${event.sessionId}:${Date.now()}`;
  const bundleItems = rekeyAssistantStreamItem(
    items,
    resolved.previousBundleId,
    resolved.bundleId,
  );

  switch (event.eventType) {
    case "raw_json":
    case "process_status":
      return bundleItems;
    case "startup":
      return bundleItems;
    case "turn_text":
      return upsertCurrentTurnProgressMessage(
        bundleItems,
        event.sessionId,
        payloadText(event),
        resolved.bundleId,
      );
    case "tool_call":
    case "tool_result":
      return bundleItems;
    case "turn_complete": {
      const finalText = payloadText(event);
      return finalText
        ? completeCurrentTurnAssistantMessage(bundleItems, event.sessionId, finalText, resolved.bundleId)
        : bundleItems;
    }
    case "process_exit":
      return bundleItems;
    case "stderr":
    case "error":
      return [
        ...bundleItems,
        {
          id: baseId,
          kind: "system",
          subtype: "error",
          title: event.eventType === "stderr" ? "Runtime log" : "Turn failed",
          detail: payloadText(event) || JSON.stringify(event.payload),
        },
      ];
    default:
      return bundleItems;
  }
}
