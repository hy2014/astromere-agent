import type {AgentReplStreamEvent} from "../../types";
import type {ModelCallUsage} from "../../runtime";
import {saveModelCallUsage} from "../../runtime";
import {loadModelSettings} from "../../runtime";
import {calculateBundleUsageCostFromDeepSeekPricing} from "../usage-cost";

// ── Types ──────────────────────────────────────────────────────────────

export type UsageData = {
  latestMessageId: string;
  records: Record<string, ModelCallUsage>;
};

// ── Pricing cache (same as before, fire-and-forget loaded once) ────────────

let pricingSettings: any = null;
loadModelSettings()
  .then((settings) => { pricingSettings = settings; })
  .catch(() => { pricingSettings = null; });

// ── Handler ────────────────────────────────────────────────────────────

export function handleUsageEvent(
  event: AgentReplStreamEvent,
  prevData: UsageData | null,
): UsageData | null {
  // Extract the assistant message from raw_json
  const rawJson = event.payload?.raw_json as Record<string, unknown> | undefined;
  if (!rawJson || rawJson.type !== "assistant") return null;

  const message = rawJson.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const messageId = message.id as string | undefined;
  if (!messageId) return null;

  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage) return null;

  // Calculate cost
  let costAmount: number | null = null;
  if (pricingSettings) {
    const cost = calculateBundleUsageCostFromDeepSeekPricing(
      [{
        modelCallId: messageId,
        model: (message.model as string) ?? null,
        stopReason: (message.stop_reason as string) ?? null,
        selectedReason: "raw_json",
        usage,
      }],
      pricingSettings as any,
    );
    costAmount = cost?.costAmount ?? null;
  }

  // Build the new record
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
    costAmount,
  };

  // diff: if tokens are unchanged, don't write to DB or update the store
  const prevRecord = prevData?.records?.[messageId];
  if (
    prevRecord &&
    prevRecord.inputTokens === newRecord.inputTokens &&
    prevRecord.outputTokens === newRecord.outputTokens &&
    prevRecord.cacheReadInputTokens === newRecord.cacheReadInputTokens &&
    prevRecord.cacheCreationInputTokens === newRecord.cacheCreationInputTokens
  ) {
    return null; // No change; the bus passes prevData to the callback
  }

  // Has changes -> write to DB -> update store
  saveModelCallUsage(newRecord);

  return {
    latestMessageId: messageId,
    records: { ...prevData?.records, [messageId]: newRecord },
  };
}
