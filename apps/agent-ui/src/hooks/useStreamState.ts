import { useEffect, useRef, useState, useCallback } from "react";
import type { ModelSettings, StreamItem, StreamLink, AgentContextUsage, AgentReplStreamEvent } from "../types";
import type {
  PreviewTab,
  DebugStreamEvent,
  AssistantMessageDebugBundle,
} from "../app/types";
import type { BundleUsageSnapshot } from "../tauri";
import {
  listenAgentReplEvents,
  loadModelSettings,
  getAgentContextUsage,
} from "../runtime";
import {
  saveBundleUsageSnapshot,
  loadBundleUsageSnapshotsForSession,
} from "../tauri";
import { isNewSessionId } from "../app/file-utils";

// --- Types shared between hooks ---

export type TurnEventHandlers = {
  setIsRunningTurn: (value: boolean | ((prev: boolean) => boolean)) => void;
  enqueuePendingPermission: (permission: {
    root: string;
    sessionId: string;
    messageId: string;
    requestId: string;
    prompt: string;
    toolName?: string;
    input?: unknown;
    rawJson?: unknown;
  }) => void;
  clearPendingPermissionsForSession: (sessionId: string) => void;
  setProjects: (
    updater: (
      folders: import("../app/types").ProjectFolder[],
    ) => import("../app/types").ProjectFolder[],
  ) => void;
};

// --- Pure functions (extracted from App.tsx, used only inside this hook) ---

function bundleUsageStorageKey(sessionId: string, bundleId: string): string {
  return `${sessionId}\n${bundleId}`;
}

function bundleUsageStatusFromEvent(
  event: AgentReplStreamEvent,
): BundleUsageSnapshot["status"] {
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

function createDebugEvent(
  event: AgentReplStreamEvent,
): DebugStreamEvent {
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

function appendDebugEvent(
  current: Record<string, DebugStreamEvent[]>,
  entry: DebugStreamEvent,
): Record<string, DebugStreamEvent[]> {
  const events = [...(current[entry.sessionId] ?? []), entry].slice(-600);
  return {
    ...current,
    [entry.sessionId]: events,
  };
}

function realSessionIdFromEvent(
  event: AgentReplStreamEvent,
): string | null {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function modelCallIdFromRawJson(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const message = value.message;
  if (!isRecord(message)) {
    return null;
  }
  const id = message.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function modelCallIdFromEvent(
  event: AgentReplStreamEvent,
): string | null {
  return modelCallIdFromRawJson(event.payload.raw_json);
}

function addUniqueString(
  items: string[],
  value: string | null | undefined,
): string[] {
  const trimmed = value?.trim();
  if (!trimmed || items.includes(trimmed)) {
    return items;
  }
  return [...items, trimmed];
}

function isAssistantBundleStartEvent(
  event: AgentReplStreamEvent,
): boolean {
  if (event.eventType !== "turn_text" && event.eventType !== "tool_call") {
    return false;
  }
  const rawJson = event.payload.raw_json;
  return (
    isRecord(rawJson) &&
    rawJson.type === "assistant" &&
    Boolean(modelCallIdFromRawJson(rawJson))
  );
}

function isBundleCompletionEvent(event: AgentReplStreamEvent): boolean {
  return (
    event.eventType === "turn_complete" ||
    event.eventType === "error" ||
    event.eventType === "interrupt" ||
    event.eventType === "process_exit"
  );
}

function rekeyDebugEvents(
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

function rekeyAssistantDebugBundles(
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

const terminalStopReasons = new Set([
  "tool_use",
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "pause_turn",
  "refusal",
]);

function usageNumericValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}

function usagePickNumber(
  usage: Record<string, unknown>,
  names: string[],
): number {
  for (const name of names) {
    const value = usageNumericValue(usage[name]);
    if (value > 0) {
      return value;
    }
  }
  return 0;
}

function usageTotalsFromUsage(
  usage: Record<string, unknown>,
): import("../tauri").BundleUsageTotals {
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

function addUsageTotals(
  left: import("../tauri").BundleUsageTotals,
  right: import("../tauri").BundleUsageTotals,
): import("../tauri").BundleUsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    totalInputTokens: left.totalInputTokens + right.totalInputTokens,
  };
}

function activeDeepSeekPricingModelName(
  settings: ModelSettings | null | undefined,
): string | null {
  const activeModel = settings?.models.find(
    (model) => model.id === settings.activeModelId,
  );
  const configured =
    activeModel?.model || activeModel?.supportModels?.[0] || null;
  return configured && configured.trim() ? configured.trim() : null;
}

function deepSeekPricingItemsForModel(
  settings: ModelSettings | null | undefined,
  model: string | null | undefined,
): Map<string, number> | null {
  const pricing = settings?.deepseekPricing;
  if (!pricing || !Array.isArray(pricing.models)) {
    return null;
  }

  const normalizedModel = (model || "").trim().toLowerCase();
  const configuredModel = (
    activeDeepSeekPricingModelName(settings) || ""
  ).trim().toLowerCase();
  const match =
    pricing.models.find(
      (candidate) => candidate.model.toLowerCase() === normalizedModel,
    ) ??
    pricing.models.find(
      (candidate) => candidate.model.toLowerCase() === configuredModel,
    ) ??
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

interface BundleUsageModelCost {
  modelCallId: string;
  model?: string | null;
  currency: string;
  costAmount?: number | null;
  costUsd?: number | null;
  reason?: string | null;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  outputTokens: number;
  cacheHitInputCost?: number | null;
  cacheMissInputCost?: number | null;
  outputCost?: number | null;
}

function calculateBundleUsageCostFromDeepSeekPricing(
  modelCallUsages: import("../tauri").ModelCallUsageSnapshot[],
  settings: ModelSettings | null | undefined,
): BundleUsageSnapshot["cost"] {
  const activeModel = settings?.models.find(
    (model) => model.id === settings.activeModelId,
  );
  if (
    !settings?.deepseekPricing ||
    (activeModel?.provider && activeModel.provider !== "deepseek")
  ) {
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
    const cacheMissInputTokens =
      totals.inputTokens + totals.cacheCreationInputTokens;
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
        reason: call.model
          ? `pricing_missing_for_${call.model}`
          : "pricing_missing_for_unknown_model",
        cacheHitInputTokens,
        cacheMissInputTokens,
        outputTokens,
      });
      continue;
    }

    const cacheHitInputCost = (cacheHitInputTokens * cacheHitPrice) / 1_000_000;
    const cacheMissInputCost =
      (cacheMissInputTokens * cacheMissPrice) / 1_000_000;
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
    } as BundleUsageSnapshot["cost"];
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
  } as BundleUsageSnapshot["cost"];
}

interface ModelCallUsageCandidate {
  modelCallId: string;
  model?: string | null;
  stopReason?: string | null;
  usage: Record<string, unknown>;
  eventIndex: number;
  terminal: boolean;
  completenessScore: number;
}

function usageCompletenessScore(usage: Record<string, unknown>): number {
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

function rawJsonFromDebugEvent(
  event: DebugStreamEvent,
): Record<string, unknown> | null {
  const rawJson = event.payload.raw_json;
  if (isRecord(rawJson)) {
    return rawJson;
  }
  return isRecord(event.payload) ? event.payload : null;
}

function modelCallUsageCandidateFromDebugEvent(
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

function selectBestModelCallUsageCandidate(
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

function calculateBundleUsageSnapshot(
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
    bundle.modelCallIds.length > 0
      ? bundle.modelCallIds
      : Array.from(grouped.keys());

  let totals: import("../tauri").BundleUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalInputTokens: 0,
  };
  const modelCallUsages: import("../tauri").ModelCallUsageSnapshot[] = [];

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
    cost: calculateBundleUsageCostFromDeepSeekPricing(
      modelCallUsages,
      modelSettings,
    ),
  };
}

const DEFAULT_CONTEXT_USAGE_AUTO_COMPACT_THRESHOLD = 256_000;

function contextUsageFromBundleSnapshot(
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
  const totalTokens = totalInput + lastTotals.outputTokens;

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
  const model =
    previous?.data?.model ?? lastModelCall.model ?? undefined;

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

function payloadText(event: AgentReplStreamEvent): string {
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

function extractPreviewLinks(_text: string): StreamLink[] {
  return [];
}

function isPermissionEventName(eventType: string): boolean {
  const normalized = eventType.toLowerCase();
  return (
    normalized === "control_request" ||
    normalized === "control_response" ||
    normalized === "permission_request" ||
    normalized === "permission_response" ||
    normalized === "permission_required" ||
    normalized === "permission_approved" ||
    normalized === "permission_denied" ||
    normalized.includes("permission")
  );
}

function permissionToolNameFromEvent(
  event: AgentReplStreamEvent,
): string {
  const rawJson = isRecord(event.payload.raw_json)
    ? event.payload.raw_json
    : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  const candidate =
    event.payload.toolName ??
    event.payload.tool_name ??
    request.toolName ??
    request.tool_name ??
    (isRecord(request.request)
      ? request.request.toolName ?? request.request.tool_name
      : undefined);
  return typeof candidate === "string" && candidate.trim() ? candidate : "tool";
}

function permissionRequestIdFromEvent(
  event: AgentReplStreamEvent,
): string {
  const rawJson = isRecord(event.payload.raw_json)
    ? event.payload.raw_json
    : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  const candidate =
    event.payload.requestId ??
    event.payload.request_id ??
    rawJson.request_id ??
    request.request_id;
  return typeof candidate === "string" ? candidate : "";
}

function permissionInputFromEvent(
  event: AgentReplStreamEvent,
): unknown {
  const rawJson = isRecord(event.payload.raw_json)
    ? event.payload.raw_json
    : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  return (
    event.payload.input ??
    request.input ??
    (isRecord(request.request) ? request.request.input : undefined)
  );
}

function rekeyAssistantBundle(
  current: Record<string, AssistantMessageDebugBundle>,
  previousBundleId: string | null,
  bundleId: string,
): Record<string, AssistantMessageDebugBundle> {
  if (
    !previousBundleId ||
    previousBundleId === bundleId ||
    !current[previousBundleId]
  ) {
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

function rekeyAssistantStreamItem(
  items: StreamItem[],
  previousBundleId: string | null,
  bundleId: string | null,
): StreamItem[] {
  if (!previousBundleId || !bundleId || previousBundleId === bundleId) {
    return items;
  }
  return items.map((item) =>
    item.kind === "message" && item.role === "assistant" &&
    item.id === previousBundleId
      ? { ...item, id: bundleId }
      : item,
  );
}

const pendingAssistantText = "Assistant is thinking…";

function mergeProgressText(
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

function currentTurnAssistantMessageIndex(items: StreamItem[]): number {
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

function collapseAssistantTurns(items: StreamItem[]): StreamItem[] {
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
        text:
          item.text && item.text !== pendingAssistantText
            ? item.text
            : previous.text,
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

function upsertCurrentTurnProgressMessage(
  items: StreamItem[],
  sessionId: string,
  text: string,
  bundleId: string | null | undefined,
): StreamItem[] {
  const canonicalBundleId = bundleId?.trim();
  if (!canonicalBundleId) {
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
        item.progressText ??
          (item.text === pendingAssistantText ? undefined : item.text),
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

function completeCurrentTurnAssistantMessage(
  items: StreamItem[],
  sessionId: string,
  text: string,
  bundleId: string | null | undefined,
): StreamItem[] {
  const canonicalBundleId = bundleId?.trim();
  if (!canonicalBundleId) {
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

function applyRuntimeDebugEventToBundle(
  current: Record<string, AssistantMessageDebugBundle>,
  resolved: ResolvedRuntimeBundleEvent,
  debugEvent: DebugStreamEvent,
): Record<string, AssistantMessageDebugBundle> {
  const { event, bundleId, previousBundleId, modelCallId, completesBundle } =
    resolved;
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
    modelCallIds: addUniqueString(
      existing?.modelCallIds ?? [bundleId],
      modelCallId,
    ),
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

function streamEventToItems(
  items: StreamItem[],
  resolved: ResolvedRuntimeBundleEvent,
): StreamItem[] {
  const event = resolved.event;
  if (isPermissionEventName(event.eventType)) {
    return items;
  }
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
        ? completeCurrentTurnAssistantMessage(
            bundleItems,
            event.sessionId,
            finalText,
            resolved.bundleId,
          )
        : bundleItems;
    }
    case "process_exit":
      return bundleItems;
    case "stderr":
    case "error":
      return [
        ...bundleItems,
        {
          id: `repl:${event.sessionId}:${Date.now()}`,
          kind: "system",
          subtype: "error",
          title:
            event.eventType === "stderr" ? "Runtime log" : "Turn failed",
          detail: payloadText(event) || JSON.stringify(event.payload),
        },
      ];
    default:
      return bundleItems;
  }
}

interface ResolvedRuntimeBundleEvent {
  event: AgentReplStreamEvent;
  bundleId: string | null;
  previousBundleId: string | null;
  modelCallId: string | null;
  createsBundle: boolean;
  completesBundle: boolean;
}

function resolveRuntimeBundleEvent(
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

function bundleUsageDecimalValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function bundleUsageCostAmount(
  snapshot: BundleUsageSnapshot | null | undefined,
): number | null {
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

function bundleUsageCurrency(
  snapshot: BundleUsageSnapshot | null | undefined,
): string {
  const value = snapshot as
    | (BundleUsageSnapshot & {
        cost?: { currency?: unknown };
        costCurrency?: unknown;
      })
    | null
    | undefined;

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

function bundleUsageButtonLabel(
  snapshot: BundleUsageSnapshot | null | undefined,
): string {
  if (!snapshot || snapshot.modelCallUsages.length === 0) {
    return "Usage";
  }
  const totalTokens =
    snapshot.usage.totalInputTokens + snapshot.usage.outputTokens;
  return totalTokens > 0 ? `Usage ${totalTokens}` : "Usage";
}

function bundleUsageTimeMs(snapshot: BundleUsageSnapshot): number {
  return (
    snapshot.startedAtMs ?? snapshot.completedAtMs ?? snapshot.updatedAtMs ?? 0
  );
}

function bundleUsageHitRate(
  snapshot: BundleUsageSnapshot | null | undefined,
): number | null {
  const usage = snapshot?.usage;
  if (!usage) {
    return null;
  }

  const totalInput =
    usage.totalInputTokens ||
    usage.inputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens;

  if (!totalInput || totalInput <= 0) {
    return null;
  }

  return usage.cacheReadInputTokens / totalInput;
}

function formatContextTokens(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "--";
  }
  if (value >= 1_000_000) {
    const text = (value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1);
    return `${text.replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(Math.round(value));
}

function contextUsageAutoCompactEnabledLabel(
  usage: AgentContextUsage | null | undefined,
): string {
  const value = usage?.data?.isAutoCompactEnabled;
  return typeof value === "boolean" ? String(value) : "--";
}

// ---- Hook ----

export function useStreamState() {
  const [sessionStreams, setSessionStreams] = useState<
    Record<string, StreamItem[]>
  >({});
  const [sessionDebugEvents, setSessionDebugEvents] = useState<
    Record<string, DebugStreamEvent[]>
  >({});
  const [assistantDebugBundles, setAssistantDebugBundles] = useState<
    Record<string, AssistantMessageDebugBundle>
  >({});
  const [streamUsageByBundleKey, setStreamUsageByBundleKey] = useState<
    Record<string, BundleUsageSnapshot>
  >({});
  const [copiedDebugMessageId, setCopiedDebugMessageId] =
    useState<string | null>(null);
  const [openAssistantDebugMessageId, setOpenAssistantDebugMessageId] =
    useState<string | null>(null);
  const [openAssistantUsageMessageId, setOpenAssistantUsageMessageId] =
    useState<string | null>(null);
  const [openProcessMessageIds, setOpenProcessMessageIds] = useState<
    Set<string>
  >(() => new Set());
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [sessionContextUsageById, setSessionContextUsageById] = useState<
    Record<string, AgentContextUsage>
  >({});
  const [contextUsageError, setContextUsageError] = useState<string | null>(
    null,
  );

  const usageCostModelSettingsRef = useRef<ModelSettings | null>(null);
  const currentBundleBySessionRef = useRef<Record<string, string | null>>({});
  const assistantDebugClickTimer = useRef<number | null>(null);

  // Side effect handlers registered by App (from useAgentTurn + useProjects)
  const turnHandlersRef = useRef<TurnEventHandlers | null>(null);

  const registerTurnHandlers = useCallback((handlers: TurnEventHandlers) => {
    turnHandlersRef.current = handlers;
  }, []);

  // Listen for agent repl events (mounted once)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenAgentReplEvents((event) => {
      const realSessionId =
        event.eventType === "turn_complete"
          ? realSessionIdFromEvent(event)
          : null;

      const debugEntry = createDebugEvent(event);
      const resolved = resolveRuntimeBundleEvent(
        event,
        currentBundleBySessionRef.current,
      );
      setSessionDebugEvents((events) =>
        appendDebugEvent(events, debugEntry),
      );
      setAssistantDebugBundles((bundles) => {
        const nextBundles = applyRuntimeDebugEventToBundle(
          bundles,
          resolved,
          debugEntry,
        );
        const bundle = resolved.bundleId
          ? nextBundles[resolved.bundleId]
          : null;
        if (bundle) {
          const snapshot = calculateBundleUsageSnapshot(
            bundle,
            bundleUsageStatusFromEvent(event),
            resolved.completesBundle ? debugEntry.receivedAt : null,
            usageCostModelSettingsRef.current,
          );
          setStreamUsageByBundleKey((current) => ({
            ...current,
            [bundleUsageStorageKey(snapshot.sessionId, snapshot.bundleId)]:
              snapshot,
          }));
          if (resolved.completesBundle) {
            const contextSessionId = realSessionId ?? snapshot.sessionId;
            const contextSnapshot =
              contextSessionId === snapshot.sessionId
                ? snapshot
                : { ...snapshot, sessionId: contextSessionId };
            setSessionContextUsageById((current) => {
              const usage = contextUsageFromBundleSnapshot(
                contextSnapshot,
                current[contextSessionId] ??
                  current[snapshot.sessionId] ??
                  null,
              );
              if (!usage) {
                return current;
              }
              return {
                ...current,
                [snapshot.sessionId]: usage,
                [contextSessionId]: usage,
              };
            });
            setContextUsageError(null);
            void saveBundleUsageSnapshot(snapshot).catch((reason) => {
              // silent
            });
          }
        }
        return nextBundles;
      });

      // Update stream items
      setSessionStreams((streams) => ({
        ...streams,
        [event.sessionId]: collapseAssistantTurns(
          streamEventToItems(streams[event.sessionId] ?? [], resolved),
        ),
      }));

      // Handle permission requests
      if (
        event.eventType === "permission_request" ||
        event.eventType === "control_request"
      ) {
        const toolName = permissionToolNameFromEvent(event);
        const requestId = permissionRequestIdFromEvent(event);
        const input = permissionInputFromEvent(event);
        const promptText = String(
          event.payload.prompt ?? `${toolName} requests permission`,
        );

        turnHandlersRef.current?.enqueuePendingPermission({
          root: event.root,
          sessionId: event.sessionId,
          messageId: `permission:${event.sessionId}:${requestId || Date.now()}`,
          requestId,
          prompt: promptText,
          toolName,
          input,
          rawJson: event.payload.raw_json ?? event.payload,
        });
        turnHandlersRef.current?.setIsRunningTurn(false);
      }

      // Handle startup / process_status
      if (
        event.eventType === "startup" ||
        event.eventType === "process_status"
      ) {
        const pid =
          typeof event.payload.pid === "number" ? event.payload.pid : undefined;
        const running =
          event.eventType === "startup"
            ? true
            : event.payload.running === true;
        turnHandlersRef.current?.setProjects((folders) =>
          folders.map((folder) => ({
            ...folder,
            sessions: folder.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    processStatus: running ? "active" : "stopped",
                    processPid: running ? pid : undefined,
                  }
                : session,
            ),
          })),
        );
      }

      // Handle session rekey (realSessionId)
      if (realSessionId && realSessionId !== event.sessionId) {
        setSessionStreams((streams) => {
          const oldItems = streams[event.sessionId] ?? [];
          const existingNewItems = streams[realSessionId] ?? [];
          const { [event.sessionId]: _removed, ...rest } = streams;

          return {
            ...rest,
            [realSessionId]:
              existingNewItems.length > 0 ? existingNewItems : oldItems,
          };
        });
        setSessionDebugEvents((events) =>
          rekeyDebugEvents(events, event.sessionId, realSessionId),
        );
        setAssistantDebugBundles((bundles) =>
          rekeyAssistantDebugBundles(
            bundles,
            event.sessionId,
            realSessionId,
          ),
        );
        setSessionContextUsageById((current) => {
          const existing = current[event.sessionId];
          if (!existing || current[realSessionId]) {
            return current;
          }
          const { [event.sessionId]: _oldContextUsage, ...rest } = current;
          return {
            ...rest,
            [realSessionId]: { ...existing, sessionId: realSessionId },
          };
        });

        const pid =
          typeof event.payload.pid === "number" ? event.payload.pid : undefined;
        turnHandlersRef.current?.setProjects((folders) =>
          folders.map((folder) => {
            const sessions = folder.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    id: realSessionId,
                    isPending: false,
                    processStatus: "active" as const,
                    processPid: pid ?? session.processPid,
                  }
                : session,
            );
            return {
              ...folder,
              sessions: sessions.filter(
                (session, index, self) =>
                  self.findIndex((s) => s.id === session.id) === index,
              ),
            };
          }),
        );

        turnHandlersRef.current?.setIsRunningTurn(true);
        // Also update activeSessionId (this is handled via App passing setActiveSessionId)
      }

      // Handle turn completion / error / interrupt / process_exit
      if (
        event.eventType === "turn_complete" ||
        event.eventType === "error" ||
        event.eventType === "interrupt" ||
        event.eventType === "process_exit"
      ) {
        turnHandlersRef.current?.setIsRunningTurn(false);
        turnHandlersRef.current?.clearPendingPermissionsForSession(
          event.sessionId,
        );
      }

      // Handle process_exit
      if (event.eventType === "process_exit") {
        turnHandlersRef.current?.setProjects((folders) =>
          folders.map((folder) => ({
            ...folder,
            sessions: folder.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    processStatus: "stopped",
                    processPid: undefined,
                  }
                : session,
            ),
          })),
        );
      }

      // Handle stderr
      if (event.eventType === "stderr") {
        const detail = String(
          event.payload?.text ?? event.payload?.message ?? "",
        ).toLowerCase();
        if (detail.includes("repl process stdout closed")) {
          turnHandlersRef.current?.setProjects((folders) =>
            folders.map((folder) => ({
              ...folder,
              sessions: folder.sessions.map((session) =>
                session.id === event.sessionId
                  ? {
                      ...session,
                      processStatus: "stopped",
                      processPid: undefined,
                    }
                  : session,
              ),
            })),
          );
        }
        if (
          detail.includes("error") ||
          detail.includes("failed") ||
          detail.includes("missing_credentials")
        ) {
          turnHandlersRef.current?.setIsRunningTurn(false);
          turnHandlersRef.current?.clearPendingPermissionsForSession(
            event.sessionId,
          );
        }
      }
    })
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((reason) => {
        // silent
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Load model settings for pricing
  useEffect(() => {
    let cancelled = false;
    loadModelSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        usageCostModelSettingsRef.current = settings;
      })
      .catch(() => {
        if (!cancelled) {
          usageCostModelSettingsRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Handlers ----

  const updateSessionStream = useCallback(
    (
      sessionId: string,
      updater: (items: StreamItem[]) => StreamItem[],
    ) => {
      setSessionStreams((streams) => ({
        ...streams,
        [sessionId]: collapseAssistantTurns(
          updater(streams[sessionId] ?? []),
        ),
      }));
    },
    [],
  );

  const refreshSessionContextUsage = useCallback(
    async (root: string, sessionId: string) => {
      if (!root || !sessionId || isNewSessionId(sessionId)) {
        return;
      }

      try {
        const usage = await getAgentContextUsage(root, sessionId);
        setContextUsageError(null);
        setSessionContextUsageById((current) => ({
          ...current,
          [sessionId]: usage,
          [usage.sessionId || sessionId]: usage,
        }));
      } catch (reason) {
        setContextUsageError(String(reason));
      }
    },
    [],
  );

  const assistantDebugPayload = useCallback(
    (
      item: Extract<StreamItem, { kind: "message" }>,
      action: "view" | "copy",
    ) => {
      const bundle = assistantDebugBundles[item.id];
      // Simplified — the full payload is kept in App.tsx if needed
      return {
        kind: "agent-ui.assistant-message-debug" as const,
        action,
        generatedAt: new Date().toISOString(),
        sessionId: bundle?.sessionId ?? null,
        messageId: item.id,
        displayedMessage: item.text,
        completed: bundle?.completed ?? null,
        eventCount: bundle?.events.length ?? 0,
      };
    },
    [assistantDebugBundles],
  );

  const handleToggleAssistantProcess = useCallback(
    (messageId: string) => {
      setOpenProcessMessageIds((current) => {
        const next = new Set(current);
        if (next.has(messageId)) {
          next.delete(messageId);
        } else {
          next.add(messageId);
        }
        return next;
      });
    },
    [],
  );

  const handleToggleSessionUsage = useCallback(() => {
    setIsDebugOpen((current) => !current);
  }, []);

  const handleViewAssistantUsage = useCallback(
    (bundleId: string) => {
      setOpenAssistantDebugMessageId(null);
      setIsDebugOpen(false);
      setOpenAssistantUsageMessageId(bundleId);
    },
    [],
  );

  const handleViewAssistantDebug = useCallback(
    (messageId: string) => {
      if (assistantDebugClickTimer.current !== null) {
        window.clearTimeout(assistantDebugClickTimer.current);
      }

      assistantDebugClickTimer.current = window.setTimeout(() => {
        setOpenAssistantDebugMessageId((current) =>
          current === messageId ? null : messageId,
        );
        assistantDebugClickTimer.current = null;
      }, 220);
    },
    [],
  );

  const handleCopyAssistantDebug = useCallback(
    async (item: Extract<StreamItem, { kind: "message" }>) => {
      if (assistantDebugClickTimer.current !== null) {
        window.clearTimeout(assistantDebugClickTimer.current);
        assistantDebugClickTimer.current = null;
      }

      try {
        const payload = assistantDebugPayload(item, "copy");
        await navigator.clipboard.writeText(
          JSON.stringify(payload, null, 2),
        );
        setCopiedDebugMessageId(item.id);
        setCopyToast("已复制本条 AI 回复的 Debug JSON");
        window.setTimeout(() => {
          setCopiedDebugMessageId((current) =>
            current === item.id ? null : current,
          );
          setCopyToast(null);
        }, 1600);
      } catch (reason) {
        // silent
      }
    },
    [assistantDebugPayload],
  );

  const [isDebugOpen, setIsDebugOpen] = useState(false);

  const contextUsageLabel = useCallback(
    (usage: AgentContextUsage | null | undefined): string => {
      const current = usage?.data
        ? formatContextTokens(usage.data.totalTokens)
        : "--";
      const threshold = formatContextTokens(
        usage?.data?.autoCompactThreshold ??
          DEFAULT_CONTEXT_USAGE_AUTO_COMPACT_THRESHOLD,
      );
      return `上下文：${current}/${threshold}(${contextUsageAutoCompactEnabledLabel(usage)})`;
    },
    [],
  );

  const bundleUsageButtonLabelCb = useCallback(
    (snapshot: BundleUsageSnapshot | null | undefined): string => {
      return bundleUsageButtonLabel(snapshot);
    },
    [],
  );

  const sessionUsageSnapshotsForSession = useCallback(
    (
      usageByKey: Record<string, BundleUsageSnapshot>,
      sessionId: string | null,
    ): BundleUsageSnapshot[] => {
      if (!sessionId) return [];
      return Object.values(usageByKey)
        .filter(
          (snapshot: BundleUsageSnapshot) => snapshot.sessionId === sessionId,
        )
        .sort(
          (
            left: BundleUsageSnapshot,
            right: BundleUsageSnapshot,
          ) => {
            const leftTime = bundleUsageTimeMs(left);
            const rightTime = bundleUsageTimeMs(right);
            if (leftTime !== rightTime) return leftTime - rightTime;
            return left.bundleId.localeCompare(right.bundleId);
          },
        );
    },
    [],
  );

  return {
    // States
    sessionStreams,
    sessionDebugEvents,
    assistantDebugBundles,
    streamUsageByBundleKey,
    sessionContextUsageById,
    contextUsageError,
    copiedDebugMessageId,
    openAssistantDebugMessageId,
    openAssistantUsageMessageId,
    openProcessMessageIds,
    copyToast,
    isDebugOpen,

    // Setters (exposed for App/useAgentTurn)
    setSessionStreams,
    setAssistantDebugBundles,
    setStreamUsageByBundleKey,
    setSessionContextUsageById,
    setContextUsageError,
    setCopiedDebugMessageId,
    setOpenAssistantDebugMessageId,
    setOpenAssistantUsageMessageId,
    setOpenProcessMessageIds,
    setCopyToast,
    setIsDebugOpen,

    // Refs
    usageCostModelSettingsRef,
    currentBundleBySessionRef,

    // Event side effect registration
    registerTurnHandlers,

    // Handlers
    updateSessionStream,
    refreshSessionContextUsage,
    contextUsageLabel,
    bundleUsageButtonLabel: bundleUsageButtonLabelCb,
    sessionUsageSnapshotsForSession,
    assistantDebugPayload,
    handleToggleAssistantProcess,
    handleToggleSessionUsage,
    handleViewAssistantUsage,
    handleViewAssistantDebug,
    handleCopyAssistantDebug,
  };
}
