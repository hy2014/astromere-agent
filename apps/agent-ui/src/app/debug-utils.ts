import type {LocalFileReferenceSummary, RuntimeSessionDetail, StreamItem,} from "../types";
import type {
  AssistantMessageDebugBundle,
  AssistantProcessTimelineItem,
  DebugStreamEvent,
  RuntimeSessionArtifacts,
} from "./types";
import {mergeProgressText} from "./stream-processor";
import {
  addUniqueString,
  commandEnvelopeDisplayText,
  displayPromptText,
  extractPreviewLinks,
  formatDateTimeNoLocale,
  isRecord,
  localFileReferencesFromPromptText,
  modelCallIdFromRawJson,
  rawJsonFromDebugEvent,
} from "./file-utils";

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

  // 优先使用 turn_complete 事件的时间戳（标记 assistant 回复真正完成）
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.eventType === "turn_complete") {
      return event.receivedAt;
    }
  }

  // 回退：找最后一个 turn_text / assistant_tool_use 事件
  let lastMatch: number | null = null;
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
    lastMatch = event.receivedAt;
  }

  return lastMatch;
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

  // 优先从 raw_json.timestamp 读取真实时间戳（JSONL 原始行里的 timestamp 字段）
  let receivedAt: number;
  const rawTimestamp = (message as any).raw_json?.timestamp;
  if (typeof rawTimestamp === "string" && !isNaN(new Date(rawTimestamp).getTime())) {
    receivedAt = new Date(rawTimestamp).getTime();
  } else {
    receivedAt = detail.updated_at_ms + index;
  }

  return {
    id: `debug:${detail.id}:history:${index}`,
    sessionId: detail.id,
    root,
    eventType: debugEventTypeForRuntimeMessage(message),
    receivedAt,
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

export function assistantTurnTimeline(
  events: DebugStreamEvent[],
): {
  timeline: AssistantProcessTimelineItem[];
  progressLines: string[];
  toolUses: Record<string, unknown>[];
  toolResults: DebugStreamEvent[];
  commandUses: Record<string, unknown>[];
  eventCount: number;
} {
  const timeline: AssistantProcessTimelineItem[] = [];
  const seenTools = new Set<string>();
  const toolUses: Record<string, unknown>[] = [];
  const toolResults: DebugStreamEvent[] = [];

  for (const [index, event] of events.entries()) {
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

  const commandUses = toolUses.filter((tool) => commandFromToolUse(tool));
  const progressLines = timeline
    .filter((entry): entry is Extract<AssistantProcessTimelineItem, { kind: "text" }> => entry.kind === "text")
    .map((entry) => entry.detail)
    .filter(Boolean);

  return {
    timeline,
    progressLines,
    toolUses,
    toolResults,
    commandUses,
    eventCount: events.length,
  };
}
