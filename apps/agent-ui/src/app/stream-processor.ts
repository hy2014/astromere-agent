import type {
  AgentReplStreamEvent,
  StreamItem,
} from "../types";
import type {
  DebugStreamEvent,
  AssistantMessageDebugBundle,
  FileMentionState,
  SlashCommandMenuState,
  ResolvedRuntimeBundleEvent,
} from "./types";
import {
  isRecord,
  addUniqueString,
  extractPreviewLinks,
  modelCallIdFromRawJson,
  isPermissionEventName,
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
