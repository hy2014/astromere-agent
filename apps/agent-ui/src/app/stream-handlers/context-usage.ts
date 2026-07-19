import type {AgentReplStreamEvent} from "../../types";

export type ContextUsageSignal = {
  refresh: boolean;
  lastRefresh: number;
  sessionId: string;
};

export function handleContextUsageEvent(
  event: AgentReplStreamEvent,
  prevData: unknown,
): ContextUsageSignal {
  const prev = prevData as ContextUsageSignal | null;
  // Non-target event → don't refresh; overwrite the store to avoid stale data lingering
  if (event.eventType !== "turn_complete" && event.eventType !== "startup") {
    return { refresh: false, lastRefresh: prev?.lastRefresh ?? 0, sessionId: "" };
  }

  const now = Date.now();
  // Debounce: don't refresh again within 3 seconds
  if (prev && now - prev.lastRefresh < 3000) {
    return { refresh: false, lastRefresh: prev.lastRefresh, sessionId: "" };
  }

  return { refresh: true, lastRefresh: now, sessionId: event.sessionId };
}
