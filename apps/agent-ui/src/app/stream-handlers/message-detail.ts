import type {AgentReplStreamEvent} from "../../types";
import type {DebugStreamEvent} from "../types";
import {createDebugEvent, modelCallIdFromEvent,} from "../stream-processor";

// ── Types ──────────────────────────────────────────────────────────────

export type MessageDetailData = {
  latestMessageId: string;
  lastEvent?: DebugStreamEvent;
  receivedTs: number;
};

// ── Handler ────────────────────────────────────────────────────────────

let _tsCounter = 0;

export function handleDetailEvent(
  event: AgentReplStreamEvent,
  _prevData: unknown,
): MessageDetailData | null {
  const messageId = modelCallIdFromEvent(event);
  if (!messageId) return null;

  // Only process events for assistant messages
  const rawJson = event.payload?.raw_json as Record<string, unknown> | undefined;
  if (!rawJson || (rawJson as any).type !== "assistant") return null;

  const debugEvent = createDebugEvent(event);

  return {
    latestMessageId: messageId,
    lastEvent: debugEvent,
    receivedTs: ++_tsCounter,
  };
}
