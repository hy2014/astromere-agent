import type { AgentReplStreamEvent } from "../../types";
import type { DebugStreamEvent } from "../types";
import {
  createDebugEvent,
  modelCallIdFromEvent,
} from "../stream-processor";
import { getSessionData } from "../../hooks/stream-event-bus";

// ── Types ──────────────────────────────────────────────────────────────

export type MessageDetailData = {
  latestMessageId: string;
  items: DebugStreamEvent[];
};

// ── Handler ────────────────────────────────────────────────────────────

export function handleDetailEvent(
  event: AgentReplStreamEvent,
  prevData: MessageDetailData | null,
): MessageDetailData | null {
  const messageId = modelCallIdFromEvent(event);
  if (!messageId) return null;

  const debugEvent = createDebugEvent(event);

  return {
    latestMessageId: messageId,
    items: [...(prevData?.items ?? []), debugEvent],
  };
}

// ── Query ──────────────────────────────────────────────────────────────

export function queryItemList(
  sessionId: string,
  messageIds: string[],
): DebugStreamEvent[] {
  const data = getSessionData<MessageDetailData>(sessionId, "detail");
  if (!data) return [];

  const idSet = new Set(messageIds);
  return data.items.filter((event) => {
    const rawJson = event.payload?.raw_json as Record<string, unknown> | undefined;
    const msgId = (rawJson?.message as Record<string, unknown> | undefined)?.id;
    return typeof msgId === "string" && idSet.has(msgId);
  });
}
