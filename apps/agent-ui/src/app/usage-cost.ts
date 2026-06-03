import type {AgentContextUsage, AgentReplStreamEvent, ModelSettings} from "../types";
import type {BundleUsageSnapshot, BundleUsageTotals, ModelCallUsageSnapshot} from "../tauri";
import type {
  AssistantMessageDebugBundle,
  BundleUsageModelCost,
  DebugStreamEvent,
  ModelCallUsageCandidate,
  SessionUsageIndicatorKey,
} from "./types";
import {formatContextTokens, isRecord, modelCallIdFromRawJson, rawJsonFromDebugEvent} from "./file-utils";
import {DEFAULT_CONTEXT_USAGE_AUTO_COMPACT_THRESHOLD} from "./constants";

// ── Constants ──────────────────────────────────────────────────────────

const terminalStopReasons = new Set([
  "tool_use",
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "pause_turn",
  "refusal",
]);

// ── Storage keys ───────────────────────────────────────────────────────

export function bundleUsageStorageKey(sessionId: string, bundleId: string): string {
  return `${sessionId}\n${bundleId}`;
}

// ── Number utilities ───────────────────────────────────────────────────

export function usageNumericValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}

export function usagePickNumber(usage: Record<string, unknown>, names: string[]): number {
  for (const name of names) {
    const value = usageNumericValue(usage[name]);
    if (value > 0) {
      return value;
    }
  }
  return 0;
}

export function usageTotalsFromUsage(usage: Record<string, unknown>): BundleUsageTotals {
  const inputTokens = usagePickNumber(usage, [
    "input_tokens",
    "inputTokens",
    "cache_miss_input_tokens",
    "cacheMissInputTokens",
    "prompt_cache_miss_tokens",
    "promptCacheMissTokens",
  ]);
  const outputTokens = usagePickNumber(usage, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
  ]);
  const cacheReadInputTokens = usagePickNumber(usage, [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "prompt_cache_hit_tokens",
    "promptCacheHitTokens",
    "cache_hit_input_tokens",
    "cacheHitInputTokens",
  ]);
  const cacheCreationInputTokens = usagePickNumber(usage, [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_write_input_tokens",
    "cacheWriteInputTokens",
  ]);
  const explicitTotalInput = usagePickNumber(usage, [
    "total_input_tokens",
    "totalInputTokens",
    "prompt_tokens",
    "promptTokens",
  ]);

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalInputTokens:
      explicitTotalInput > 0
        ? explicitTotalInput
        : inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
  };
}

export function addUsageTotals(left: BundleUsageTotals, right: BundleUsageTotals): BundleUsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    totalInputTokens: left.totalInputTokens + right.totalInputTokens,
  };
}

// ── DeepSeek pricing ───────────────────────────────────────────────────

export function activeDeepSeekPricingModelName(
  settings: ModelSettings | null | undefined,
): string | null {
  const activeModel = settings?.models.find((model) => model.id === settings.activeModelId);
  const configured = activeModel?.model || activeModel?.supportModels?.[0] || null;
  return configured && configured.trim() ? configured.trim() : null;
}

export function deepSeekPricingItemsForModel(
  settings: ModelSettings | null | undefined,
  model: string | null | undefined,
): Map<string, number> | null {
  const pricing = settings?.deepseekPricing;
  if (!pricing || !Array.isArray(pricing.models)) {
    return null;
  }

  const normalizedModel = (model || "").trim().toLowerCase();
  const configuredModel = (activeDeepSeekPricingModelName(settings) || "").trim().toLowerCase();
  const match =
    pricing.models.find((candidate) => candidate.model.toLowerCase() === normalizedModel) ??
    pricing.models.find((candidate) => candidate.model.toLowerCase() === configuredModel) ??
    null;

  if (!match) {
    return null;
  }

  return new Map(
    match.items
      .filter((item) => Number.isFinite(item.pricePerMTokens))
      .map((item) => [item.item, item.pricePerMTokens]),
  );
}

export function calculateBundleUsageCostFromDeepSeekPricing(
  modelCallUsages: ModelCallUsageSnapshot[],
  settings: ModelSettings | null | undefined,
): BundleUsageSnapshot["cost"] {
  const activeModel = settings?.models.find((model) => model.id === settings.activeModelId);
  if (!settings?.deepseekPricing || (activeModel?.provider && activeModel.provider !== "deepseek")) {
    return null;
  }

  const currency = settings.deepseekPricing.currency || "CNY";
  const unit = settings.deepseekPricing.unit || "CNY_PER_1M_TOKENS";
  const modelCosts: BundleUsageModelCost[] = [];
  let totalCostAmount = 0;
  let pricedCallCount = 0;

  for (const call of modelCallUsages) {
    const totals = usageTotalsFromUsage(call.usage);
    const prices = deepSeekPricingItemsForModel(settings, call.model);
    const cacheHitPrice = prices?.get("cache_hit_input");
    const cacheMissPrice = prices?.get("cache_miss_input");
    const outputPrice = prices?.get("output");

    const cacheHitInputTokens = totals.cacheReadInputTokens;
    const cacheMissInputTokens = totals.inputTokens + totals.cacheCreationInputTokens;
    const outputTokens = totals.outputTokens;

    if (
      typeof cacheHitPrice !== "number" ||
      !Number.isFinite(cacheHitPrice) ||
      typeof cacheMissPrice !== "number" ||
      !Number.isFinite(cacheMissPrice) ||
      typeof outputPrice !== "number" ||
      !Number.isFinite(outputPrice)
    ) {
      modelCosts.push({
        modelCallId: call.modelCallId,
        model: call.model,
        currency,
        costAmount: null,
        costUsd: null,
        reason: call.model ? `pricing_missing_for_${call.model}` : "pricing_missing_for_unknown_model",
        cacheHitInputTokens,
        cacheMissInputTokens,
        outputTokens,
      });
      continue;
    }

    const cacheHitInputCost = (cacheHitInputTokens * cacheHitPrice) / 1_000_000;
    const cacheMissInputCost = (cacheMissInputTokens * cacheMissPrice) / 1_000_000;
    const outputCost = (outputTokens * outputPrice) / 1_000_000;
    const costAmount = cacheHitInputCost + cacheMissInputCost + outputCost;

    totalCostAmount += costAmount;
    pricedCallCount += 1;
    modelCosts.push({
      modelCallId: call.modelCallId,
      model: call.model,
      currency,
      costAmount,
      costUsd: null,
      reason: null,
      cacheHitInputTokens,
      cacheMissInputTokens,
      outputTokens,
      cacheHitInputCost,
      cacheMissInputCost,
      outputCost,
    });
  }

  if (modelCallUsages.length === 0) {
    return null;
  }

  if (pricedCallCount === 0) {
    return {
      pricingMode: "deepseek_pricing",
      currency,
      unit,
      costAmount: null,
      costUsd: null,
      reason: modelCosts[0]?.reason ?? "pricing_unavailable",
      pricedAtMs: Date.now(),
      modelCosts,
    };
  }

  return {
    pricingMode: "deepseek_pricing",
    currency,
    unit,
    costAmount: totalCostAmount,
    costUsd: null,
    reason: null,
    pricedAtMs: Date.now(),
    modelCosts,
  };
}

// ── Usage completeness ─────────────────────────────────────────────────

export function usageCompletenessScore(usage: Record<string, unknown>): number {
  let numericKeyCount = 0;
  for (const value of Object.values(usage)) {
    if (usageNumericValue(value) > 0) {
      numericKeyCount += 1;
    }
  }
  const totals = usageTotalsFromUsage(usage);
  return (
    numericKeyCount * 1_000_000 +
    totals.inputTokens +
    totals.outputTokens +
    totals.cacheReadInputTokens +
    totals.cacheCreationInputTokens +
    totals.totalInputTokens
  );
}

// ── Model call usage candidates ────────────────────────────────────────

export function modelCallUsageCandidateFromDebugEvent(
  event: DebugStreamEvent,
  eventIndex: number,
): ModelCallUsageCandidate | null {
  const rawJson = rawJsonFromDebugEvent(event);
  if (!isRecord(rawJson) || rawJson.type !== "assistant") {
    return null;
  }

  const message = rawJson.message;
  if (!isRecord(message)) {
    return null;
  }

  const modelCallId = modelCallIdFromRawJson(rawJson);
  if (!modelCallId) {
    return null;
  }

  const usage = message.usage;
  if (!isRecord(usage)) {
    return null;
  }

  const stopReason =
    typeof message.stop_reason === "string" && message.stop_reason.trim()
      ? message.stop_reason.trim()
      : null;

  return {
    modelCallId,
    model: typeof message.model === "string" ? message.model : null,
    stopReason,
    usage: usage as Record<string, unknown>,
    eventIndex,
    terminal: Boolean(stopReason && terminalStopReasons.has(stopReason)),
    completenessScore: usageCompletenessScore(usage as Record<string, unknown>),
  };
}

export function selectBestModelCallUsageCandidate(
  candidates: ModelCallUsageCandidate[],
): ModelCallUsageCandidate {
  return candidates.reduce((best, candidate) => {
    const bestRank = [
      best.terminal ? 1 : 0,
      best.completenessScore,
      best.eventIndex,
    ];
    const candidateRank = [
      candidate.terminal ? 1 : 0,
      candidate.completenessScore,
      candidate.eventIndex,
    ];
    return candidateRank[0] > bestRank[0] ||
      (candidateRank[0] === bestRank[0] && candidateRank[1] > bestRank[1]) ||
      (candidateRank[0] === bestRank[0] &&
        candidateRank[1] === bestRank[1] &&
        candidateRank[2] > bestRank[2])
      ? candidate
      : best;
  });
}

// ── Bundle usage snapshot ──────────────────────────────────────────────

export function calculateBundleUsageSnapshot(
  bundle: AssistantMessageDebugBundle,
  status: BundleUsageSnapshot["status"],
  completedAtMs?: number | null,
  modelSettings?: ModelSettings | null,
): BundleUsageSnapshot {
  const grouped = new Map<string, ModelCallUsageCandidate[]>();

  for (const [eventIndex, event] of bundle.events.entries()) {
    const candidate = modelCallUsageCandidateFromDebugEvent(event, eventIndex);
    if (!candidate) {
      continue;
    }
    grouped.set(candidate.modelCallId, [
      ...(grouped.get(candidate.modelCallId) ?? []),
      candidate,
    ]);
  }

  const orderedModelCallIds =
    bundle.modelCallIds.length > 0 ? bundle.modelCallIds : Array.from(grouped.keys());

  let totals: BundleUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalInputTokens: 0,
  };
  const modelCallUsages: ModelCallUsageSnapshot[] = [];

  for (const modelCallId of orderedModelCallIds) {
    const candidates = grouped.get(modelCallId) ?? [];
    if (candidates.length === 0) {
      continue;
    }
    const best = selectBestModelCallUsageCandidate(candidates);
    totals = addUsageTotals(totals, usageTotalsFromUsage(best.usage));
    modelCallUsages.push({
      modelCallId,
      model: best.model,
      stopReason: best.stopReason,
      selectedReason: best.terminal ? "terminal" : "latest_non_terminal",
      usage: best.usage,
    });
  }

  return {
    sessionId: bundle.sessionId,
    bundleId: bundle.messageId,
    root: bundle.root,
    source: "stream",
    status,
    startedAtMs: bundle.startedAt,
    completedAtMs: completedAtMs ?? null,
    updatedAtMs: Date.now(),
    modelCallIds: orderedModelCallIds,
    modelCallUsages,
    usage: totals,
    cost: calculateBundleUsageCostFromDeepSeekPricing(modelCallUsages, modelSettings),
  };
}

// ── Bundle status ──────────────────────────────────────────────────────

export function bundleUsageStatusFromEvent(event: AgentReplStreamEvent): BundleUsageSnapshot["status"] {
  switch (event.eventType) {
    case "turn_complete":
      return "complete";
    case "interrupt":
      return "interrupted";
    case "error":
      return "error";
    case "process_exit":
      return "process_exit";
    default:
      return "streaming";
  }
}

// ── Bundle display utilities ───────────────────────────────────────────

export function bundleUsageButtonLabel(snapshot: BundleUsageSnapshot | null | undefined): string {
  if (!snapshot || snapshot.modelCallUsages.length === 0) {
    return "Usage";
  }
  const totalTokens = snapshot.usage.totalInputTokens + snapshot.usage.outputTokens;
  return totalTokens > 0 ? `Usage ${totalTokens}` : "Usage";
}

export function bundleUsageDecimalValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function bundleUsageCostAmount(snapshot: BundleUsageSnapshot | null | undefined): number | null {
  if (!snapshot) return null;
  const value = snapshot as BundleUsageSnapshot & {
    cost?: {
      costAmount?: unknown;
      costUsd?: unknown;
      cost_amount?: unknown;
    } | null;
    costAmount?: unknown;
    costUsd?: unknown;
    cost_amount?: unknown;
    cost_usd?: unknown;
  };

  const candidates = [
    value.cost?.costAmount,
    value.cost?.cost_amount,
    value.cost?.costUsd,
    value.costAmount,
    value.cost_amount,
    value.costUsd,
    value.cost_usd,
  ];

  for (const candidate of candidates) {
    const amount = bundleUsageDecimalValue(candidate);
    if (amount > 0) return amount;
  }

  return null;
}

export function bundleUsageCurrency(snapshot: BundleUsageSnapshot | null | undefined): string {
  const value = snapshot as (BundleUsageSnapshot & {
    cost?: { currency?: unknown };
    costCurrency?: unknown;
  }) | null | undefined;

  const nested = value?.cost?.currency;
  if (typeof nested === "string" && nested.trim()) {
    return nested.trim().toUpperCase();
  }

  const direct = value?.costCurrency;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim().toUpperCase();
  }

  return "CNY";
}

export function formatBundleUsageCost(snapshot: BundleUsageSnapshot | null | undefined): string {
  const amount = bundleUsageCostAmount(snapshot);
  if (amount == null) {
    return "unavailable";
  }

  const currency = bundleUsageCurrency(snapshot);
  const symbol =
    currency === "CNY" || currency === "RMB"
      ? "¥"
      : currency === "USD"
        ? "$"
        : `${currency} `;

  return `${symbol}${amount.toFixed(4)}`;
}

export function bundleUsageHitRate(snapshot: BundleUsageSnapshot | null | undefined): number | null {
  const usage = snapshot?.usage;
  if (!usage) {
    return null;
  }

  const totalInput =
    usage.totalInputTokens ||
    usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;

  if (!totalInput || totalInput <= 0) {
    return null;
  }

  return usage.cacheReadInputTokens / totalInput;
}

export function formatBundleUsageHitRate(snapshot: BundleUsageSnapshot | null | undefined): string {
  const hitRate = bundleUsageHitRate(snapshot);
  return hitRate == null ? "unavailable" : `${(hitRate * 100).toFixed(2)}%`;
}

export function bundleUsageTimeMs(snapshot: BundleUsageSnapshot): number {
  return snapshot.startedAtMs ?? snapshot.completedAtMs ?? snapshot.updatedAtMs ?? 0;
}

export function bundleUsageIndicatorValue(
  snapshot: BundleUsageSnapshot,
  indicator: SessionUsageIndicatorKey,
): number {
  switch (indicator) {
    case "costAmount":
      return bundleUsageCostAmount(snapshot) ?? 0;
    case "totalInputTokens":
      return snapshot.usage.totalInputTokens;
    case "inputTokens":
      return snapshot.usage.inputTokens;
    case "outputTokens":
      return snapshot.usage.outputTokens;
    case "cacheReadInputTokens":
      return snapshot.usage.cacheReadInputTokens;
    case "cacheCreationInputTokens":
      return snapshot.usage.cacheCreationInputTokens;
    case "hitRate":
      return bundleUsageHitRate(snapshot) ?? 0;
    case "modelCallCount":
      return snapshot.modelCallUsages.length;
    default:
      return 0;
  }
}

export function formatSessionUsageIndicatorValue(
  value: number,
  indicator: SessionUsageIndicatorKey,
  currency: string,
): string {
  if (indicator === "hitRate") {
    return `${(value * 100).toFixed(2)}%`;
  }
  if (indicator === "costAmount") {
    const symbol =
      currency === "CNY" || currency === "RMB"
        ? "¥"
        : currency === "USD"
          ? "$"
          : `${currency} `;
    return `${symbol}${value.toFixed(4)}`;
  }
  return usageFormatValue(value, indicator);
}

// ── Session usage ──────────────────────────────────────────────────────

export function sessionUsageSnapshotsForSession(
  usageByKey: Record<string, BundleUsageSnapshot>,
  sessionId: string | null,
): BundleUsageSnapshot[] {
  if (!sessionId) return [];
  return Object.values(usageByKey)
    .filter((snapshot: BundleUsageSnapshot) => snapshot.sessionId === sessionId)
    .sort((left: BundleUsageSnapshot, right: BundleUsageSnapshot) => {
      const leftTime = bundleUsageTimeMs(left);
      const rightTime = bundleUsageTimeMs(right);
      if (leftTime !== rightTime) return leftTime - rightTime;
      return left.bundleId.localeCompare(right.bundleId);
    });
}

export function sessionUsageTotals(snapshots: BundleUsageSnapshot[]): BundleUsageTotals {
  return snapshots.reduce<BundleUsageTotals>(
    (totals: BundleUsageTotals, snapshot: BundleUsageSnapshot) => ({
      inputTokens: totals.inputTokens + snapshot.usage.inputTokens,
      outputTokens: totals.outputTokens + snapshot.usage.outputTokens,
      cacheReadInputTokens:
        totals.cacheReadInputTokens + snapshot.usage.cacheReadInputTokens,
      cacheCreationInputTokens:
        totals.cacheCreationInputTokens + snapshot.usage.cacheCreationInputTokens,
      totalInputTokens: totals.totalInputTokens + snapshot.usage.totalInputTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalInputTokens: 0,
    },
  );
}

export function sessionUsageHitRateFromTotals(totals: BundleUsageTotals): number | null {
  const totalInput =
    totals.totalInputTokens ||
    totals.inputTokens + totals.cacheReadInputTokens + totals.cacheCreationInputTokens;
  if (!totalInput || totalInput <= 0) return null;
  return totals.cacheReadInputTokens / totalInput;
}

export function sessionUsageCostAmount(snapshots: BundleUsageSnapshot[]): number | null {
  let hasCost = false;
  let total = 0;

  for (const snapshot of snapshots) {
    const amount = bundleUsageCostAmount(snapshot);
    if (amount != null) {
      hasCost = true;
      total += amount;
    }
  }

  return hasCost ? total : null;
}

export function sessionUsageCurrency(snapshots: BundleUsageSnapshot[]): string {
  for (const snapshot of snapshots) {
    const currency = bundleUsageCurrency(snapshot);
    if (currency) return currency;
  }
  return "CNY";
}

// ── Model cost utilities ───────────────────────────────────────────────

export function sessionUsageModelCostByCallId(
  snapshot: BundleUsageSnapshot,
): Map<string, { costAmount?: unknown; costUsd?: unknown; currency?: unknown; reason?: unknown }> {
  const snapshotWithCost = snapshot as BundleUsageSnapshot & {
    cost?: { modelCosts?: unknown[] } | null;
  };
  const modelCosts = snapshotWithCost.cost?.modelCosts;
  const map = new Map<string, { costAmount?: unknown; costUsd?: unknown; currency?: unknown; reason?: unknown }>();

  if (!Array.isArray(modelCosts)) {
    return map;
  }

  for (const cost of modelCosts) {
    if (!isRecord(cost)) continue;
    const modelCallId = cost.modelCallId;
    if (typeof modelCallId !== "string" || !modelCallId.trim()) continue;
    map.set(modelCallId, cost as { costAmount?: unknown; costUsd?: unknown; currency?: unknown; reason?: unknown });
  }

  return map;
}

export function formatModelCallCost(
  cost:
    | { costAmount?: unknown; costUsd?: unknown; currency?: unknown; reason?: unknown }
    | undefined,
  fallbackCurrency: string,
): string {
  if (!cost) return "unavailable";

  const amount =
    bundleUsageDecimalValue(cost.costAmount) ||
    bundleUsageDecimalValue(cost.costUsd);
  if (!amount || amount <= 0) {
    return typeof cost.reason === "string" && cost.reason
      ? cost.reason
      : "unavailable";
  }

  const currency =
    typeof cost.currency === "string" && cost.currency.trim()
      ? cost.currency.trim().toUpperCase()
      : fallbackCurrency;

  const symbol =
    currency === "CNY" || currency === "RMB"
      ? "¥"
      : currency === "USD"
        ? "$"
        : `${currency} `;

  return `${symbol}${amount.toFixed(4)}`;
}

// ── Raw value display utilities ────────────────────────────────────────

export function usageNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function usageFormatValue(value: unknown, key: string): string {
  const number = usageNumberValue(value);
  if (number === null) return "\u2014";
  if (key === "input_hit_rate") return `${(number * 100).toFixed(2)}%`;
  if (key === "cost_usd") return `¥${number.toFixed(8)}`;
  return Math.round(number).toLocaleString();
}

export function usageShortId(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.length > 18 ? `${text.slice(0, 8)}\u2026${text.slice(-6)}` : text || "\u2014";
}

// ── Context usage ──────────────────────────────────────────────────────

export function contextUsageAutoCompactEnabledLabel(usage: AgentContextUsage | null | undefined): string {
  const value = usage?.data?.isAutoCompactEnabled;
  return typeof value === "boolean" ? String(value) : "--";
}

export function contextUsageLabel(usage: AgentContextUsage | null | undefined): string {
  const current = usage?.data ? formatContextTokens(usage.data.totalTokens) : "--";
  const maxTokens = usage?.data?.maxTokens ?? usage?.data?.rawMaxTokens ?? 0;
  const denominator = maxTokens > 0
    ? formatContextTokens(maxTokens)
    : formatContextTokens(DEFAULT_CONTEXT_USAGE_AUTO_COMPACT_THRESHOLD);
  return `上下文：${current}/${denominator}(${contextUsageAutoCompactEnabledLabel(usage)})`;
}

export function contextUsageFromBundleSnapshot(
  snapshot: BundleUsageSnapshot,
  previous?: AgentContextUsage | null,
): AgentContextUsage | null {
  const lastModelCall =
    snapshot.modelCallUsages.length > 0
      ? snapshot.modelCallUsages[snapshot.modelCallUsages.length - 1]
      : null;

  if (!lastModelCall) {
    return null;
  }

  const lastTotals = usageTotalsFromUsage(lastModelCall.usage);
  const totalInput =
    lastTotals.totalInputTokens ||
    lastTotals.inputTokens +
      lastTotals.cacheReadInputTokens +
      lastTotals.cacheCreationInputTokens;
  const totalTokens = totalInput;

  if (!totalTokens || totalTokens <= 0) {
    return null;
  }

  const maxTokens =
    previous?.data?.maxTokens ??
    previous?.data?.rawMaxTokens ??
    DEFAULT_CONTEXT_USAGE_AUTO_COMPACT_THRESHOLD;
  const autoCompactThreshold =
    previous?.data?.autoCompactThreshold ??
    DEFAULT_CONTEXT_USAGE_AUTO_COMPACT_THRESHOLD;
  const model = previous?.data?.model ?? lastModelCall.model ?? undefined;

  return {
    root: snapshot.root,
    sessionId: snapshot.sessionId,
    updatedAtMs: Date.now(),
    data: {
      totalTokens,
      maxTokens,
      rawMaxTokens: previous?.data?.rawMaxTokens ?? maxTokens,
      percentage: maxTokens > 0 ? totalTokens / maxTokens : undefined,
      model,
      autoCompactThreshold,
      isAutoCompactEnabled: previous?.data?.isAutoCompactEnabled,
      apiUsage: {
        input_tokens: lastTotals.inputTokens,
        output_tokens: lastTotals.outputTokens,
        cache_creation_input_tokens: lastTotals.cacheCreationInputTokens,
        cache_read_input_tokens: lastTotals.cacheReadInputTokens,
      },
    },
  };
}
