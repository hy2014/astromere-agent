import type { AgentReplStreamEvent, StreamItem } from "../../types";
import {
  collapseAssistantTurns,
  resolveRuntimeBundleEvent,
  streamEventToItems,
} from "../stream-processor";

// ── Types ──────────────────────────────────────────────────────────────

export type SessionItemsData = {
  latestMessageId: string;
  items: StreamItem[];
};

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * 从当前 items 列表中推导当前正在流式输出的 assistant bundleId。
 * 找到最后一条 status === "streaming" 的 assistant 消息，其 id 即为 currentBundleId。
 * 如果没有 streaming 的 assistant 消息，返回 null。
 */
function currentBundleIdFromItems(items: StreamItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "message" && item.role === "assistant") {
      if (item.status === "streaming") return item.id;
      break; // 最后一条 assistant 已经 complete，说明没有正在流的
    }
    if (item.kind === "message" && item.role === "user") {
      break; // 遇到 user 消息还没遇到 assistant，说明没有正在流的
    }
  }
  return null;
}

// ── Handler ────────────────────────────────────────────────────────────

export function handleSessionItemsEvent(
  event: AgentReplStreamEvent,
  prevData: SessionItemsData | null,
): SessionItemsData | null {
  const prevItems = prevData?.items ?? [];

  // 从 prevItems 推导当前 bundleId，避免跨 handler 依赖
  const currentBundleId = currentBundleIdFromItems(prevItems);
  const bundleMap: Record<string, string | null> = {
    [event.sessionId]: currentBundleId,
  };

  // resolveRuntimeBundleEvent 会尝试从 event 解析 bundleId，
  // 如果当前没有 bundle 且事件是 bundle 开始事件，它会创建新 bundleId
  // 同时 bundleMap 会被原位修改（但 map 是临时新建的，无副作用）
  const resolved = resolveRuntimeBundleEvent(event, bundleMap);

  // streamEventToItems 使用 resolved 对象来：
  //   1. rekey：previousBundleId → bundleId（session ID 重定向时）
  //   2. turn_text → 追加 progressText
  //   3. turn_complete → 设置最终 text + status = "complete"
  //   4. error/stderr → 创建 system 类型的错误消息
  //   5. 不关心的事件 → 原样返回 items
  const newItems = collapseAssistantTurns(
    streamEventToItems(prevItems, resolved),
  );

  // 如果 items 没变化，返回 null 避免触发不必要的 callback
  if (newItems === prevItems) return null;

  const latestMessageId = resolved.modelCallId ?? resolved.bundleId ?? "";

  return {
    latestMessageId,
    items: newItems,
  };
}
