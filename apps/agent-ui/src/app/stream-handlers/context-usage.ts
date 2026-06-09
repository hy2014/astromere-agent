import type { AgentReplStreamEvent } from "../../types";

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
  // 非目标事件 → 不刷新，覆盖 store 避免老数据残留
  if (event.eventType !== "turn_complete" && event.eventType !== "startup") {
    return { refresh: false, lastRefresh: prev?.lastRefresh ?? 0, sessionId: "" };
  }

  const now = Date.now();
  // 防抖：3 秒内不再重复刷新
  if (prev && now - prev.lastRefresh < 3000) {
    return { refresh: false, lastRefresh: prev.lastRefresh, sessionId: "" };
  }

  return { refresh: true, lastRefresh: now, sessionId: event.sessionId };
}
