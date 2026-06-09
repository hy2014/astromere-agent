import type { AgentReplStreamEvent } from "../../types";
import type { ModelCallUsage } from "../../tauri";
import { saveModelCallUsage } from "../../tauri";

// ── Types ──────────────────────────────────────────────────────────────

export type UsageData = {
  latestMessageId: string;
  records: Record<string, ModelCallUsage>;
};

// ── Handler ────────────────────────────────────────────────────────────

export function handleUsageEvent(
  event: AgentReplStreamEvent,
  prevData: UsageData | null,
): UsageData | null {
  // 从 raw_json 提取 assistant 消息
  const rawJson = event.payload?.raw_json as Record<string, unknown> | undefined;
  if (!rawJson || rawJson.type !== "assistant") return null;

  const message = rawJson.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const messageId = message.id as string | undefined;
  if (!messageId) return null;

  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage) return null;

  // 构建新的 record
  const newRecord: ModelCallUsage = {
    modelCallId: messageId,
    sessionId: event.sessionId,
    root: event.root,
    model: (message.model as string) ?? null,
    stopReason: (message.stop_reason as string) ?? null,
    inputTokens: (usage.input_tokens as number) ?? 0,
    outputTokens: (usage.output_tokens as number) ?? 0,
    cacheReadInputTokens: (usage.cache_read_input_tokens as number) ?? 0,
    cacheCreationInputTokens: (usage.cache_creation_input_tokens as number) ?? 0,
    updatedAtMs: Date.now(),
    source: "stream",
  };

  // diff：token 没变化就不写 DB、不更新 store
  const prevRecord = prevData?.records?.[messageId];
  if (
    prevRecord &&
    prevRecord.inputTokens === newRecord.inputTokens &&
    prevRecord.outputTokens === newRecord.outputTokens &&
    prevRecord.cacheReadInputTokens === newRecord.cacheReadInputTokens &&
    prevRecord.cacheCreationInputTokens === newRecord.cacheCreationInputTokens
  ) {
    return null; // 无变更，bus 会传递 prevData 给 callback
  }

  // 有变更 -> 写 DB -> 更新 store
  saveModelCallUsage(newRecord);

  return {
    latestMessageId: messageId,
    records: { ...prevData?.records, [messageId]: newRecord },
  };
}
