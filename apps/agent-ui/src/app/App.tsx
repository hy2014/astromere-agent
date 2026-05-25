import {
  open as openDialog } from "@tauri-apps/plugin-dialog";
import { FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState } from "react";
import {
  addWorkspaceRegistryEntry,
  ensureAgentReplProcess,
  forkAgentReplProcess,
  getAgentPermissionState,
  getAgentReplCapabilities,
  getAgentContextUsage,
  getAgentReplProcessStatus,
  getDefaultWorkspace,
  killAgentReplProcess,
  interruptAgentTurn,
  listSkills,
  listenAgentReplEvents,
  listRuntimeSessions,
  loadWorkspaceRegistry,
  loadTypedRuntimeSession,
  loadModelSettings,
  openWorkspace,
  readGitDiff,
  readLocalImageMetadata,
  readLocalImagePreview,
  readLocalReferenceFile,
  readWorkspaceFile,
  respondAgentPermission,
  searchWorkspaceFiles,
  saveModelSettings,
  sendAgentReplInput,
  setAgentPermissionMode,
  testModelConnection,
  clearActiveRemoteProfileId,
  createRemoteProfileInput,
  deleteRemoteProfile,
  getActiveRemoteProfileId,
  loadRemoteProfiles,
  setActiveRemoteProfileId,
  upsertRemoteProfile,
  useLocalRuntime,
  useRemoteRuntime,
  removeWorkspaceRegistryEntry,
  listProjectEntries,
  } from "../runtime";
import type { AgentReplCapabilityItem,
  RemoteProfile } from "../runtime";
import "./App.css";
import { TerminalView } from "./Terminal";
import { RemoteTerminalPlaceholder } from "./RemoteTerminalPlaceholder";
import { SkillsView } from "./components/skills-view";
import { McpServersView } from "./components/mcp-servers-view";
import { SettingsView } from "./components/settings-view";
import { AssistantUsageMiniOverlay, SessionUsageDashboard } from "./components/usage-components";
import { MessageImagePreviews } from "./components/image-reference-view";
import { RichMarkdownMessage, MarkdownTablePreview } from "./components/preview-components";
import { PreviewPanel } from "./components/PreviewPanel";
import { PromptInputArea } from "./components/PromptInputArea";
import { useStreamState } from "../hooks/useStreamState";
import { useAgentTurn } from "../hooks/useAgentTurn";
import { usePromptInput } from "../hooks/usePromptInput"
import {
  projectIdFromRoot,
  isNewSessionId,
  createPendingSession,
  sessionKey,
  loadHiddenSessions,
  uniqueHiddenSessions,
  sessionsFromRuntimeSummaries,
  dedupeSessions,
  truncateSessionTitle,
  firstUserTitleFromStream,
  welcomeStream,
  hiddenSessionsStorageKey,
} from "./session";
import type {
  AgentContextUsage,
  AgentPermissionState,
  AgentReplStreamEvent,
  FileView,
  GitDiff,
  LocalFileReferenceSummary,
  LocalImagePreview,
  ModelEndpointConfig,
  ModelSettings,
  PermissionMode,
  RuntimeSessionDetail,
  SkillSummary,
  SkillsReport,
  StreamItem,
  StreamLink,
  WorkspaceFileReference,
  } from "../types";
import {
  sqliteDatabaseInfo,
  saveBundleUsageSnapshot,
  loadBundleUsageSnapshotsForSession,
  type BundleUsageSnapshot,
  type BundleUsageTotals,
  type ModelCallUsageSnapshot,
} from "../tauri";
import { usageFormatValue } from "./usage-cost";
import type {
  PreviewTab,
  ProjectSession,
  ProjectFolder,
  HiddenSession,
  DebugStreamEvent,
  AssistantMessageDebugBundle,
  LocalFileReference,
  FileMentionState,
  SlashCommandMenuLevel,
  SlashCommandMenuState,
  SlashRootItem,
  AppView,
  SessionUsageIndicatorKey,
} from "./types";

// Types moved to ./types

const maxReferencedFileBytes = 48 * 1024;
const maxReferencedFilesTotalBytes = 160 * 1024;

const slashRootItems: SlashRootItem[] = [
  { id: "skills", label: "Skills", description: "Use a project or user skill" },
  { id: "commands", label: "Commands", description: "Built-in slash commands" },
  { id: "agents", label: "Agents", description: "Delegate to sub-agents, coming soon", disabled: true },
  { id: "workflows", label: "Workflows", description: "Run workflow templates, coming soon", disabled: true },
];

// AppView is imported from ./types

function getActiveRemoteProfileBaseUrl(): string | null {
  const profile = loadActiveRemoteProfileSnapshot();
  return profile?.baseUrl ?? null;
}

async function clientDebugLog(level: string, message: string, data?: any) {
  try {
    const baseUrl = getActiveRemoteProfileBaseUrl();
    if (!baseUrl) return;
    await fetch(`${baseUrl}/debug/log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level, message, data }),
    });
  } catch {
    // silent — logging should never break the app
  }
}

function loadActiveRemoteProfileSnapshot(): RemoteProfile | null {
  try {
    const activeProfileId = getActiveRemoteProfileId();
    if (!activeProfileId) return null;
    return loadRemoteProfiles().find((profile) => profile.id === activeProfileId) ?? null;
  } catch {
    return null;
  }
}

const previewablePathPattern =
  /(?:^|[\s([`"'])((?:(?:~|～)\/|\/|[A-Za-z0-9_.@-]+\/)[^\n`"'<>|]*?\.(?:ck|rs|ts|tsx|js|jsx|json|toml|md|markdown|txt|csv|pdf|png|jpg|jpeg|gif|webp|svg|html|css|py|go|java|kt|swift|c|cc|cpp|h|hpp|yaml|yml|sql|sh|zsh|fish|rb|php|vue|svelte))(?:$|[\s)\]，。,.!?;:'"`])/gi;

function cleanPreviewPath(path: string): string {
  return path
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^['\"]+|['\"]+$/g, "")
    .replace(/[),.;，。！？!?]+$/g, "")
    .replace(/^～\//, "~/");
}

function linkKindForPath(path: string): StreamLink["kind"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "pdf";
  }
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/.test(lower)) {
    return "image";
  }
  if (/\.(md|markdown)$/.test(lower)) {
    return "markdown";
  }
  return "file";
}

function extractPreviewLinks(text: string): StreamLink[] {
  const seen = new Set<string>();
  const links: StreamLink[] = [];
  for (const match of text.matchAll(previewablePathPattern)) {
    const path = cleanPreviewPath(match[1] ?? "");
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    const pathParts = path.split("/");
    links.push({
      id: `link:${path}`,
      label: pathParts[pathParts.length - 1] ?? path,
      kind: linkKindForPath(path),
      path,
    });
  }
  return links.slice(0, 8);
}

function displayRole(role: "user" | "assistant"): string {
  return role === "user" ? "You" : "AI Assistant";
}

function lineNumberPreview(content: string): number[] {
  return Array.from(
    { length: Math.min(content.split("\n").length, 200) },
    (_, index) => index + 1,
  );
}

function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function realSessionIdFromEvent(event: AgentReplStreamEvent): string | null {
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

function createDebugEvent(event: AgentReplStreamEvent): DebugStreamEvent {
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

type ResolvedRuntimeBundleEvent = {
  event: AgentReplStreamEvent;
  bundleId: string | null;
  previousBundleId: string | null;
  modelCallId: string | null;
  createsBundle: boolean;
  completesBundle: boolean;
};

function addUniqueString(items: string[], value: string | null | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed || items.includes(trimmed)) {
    return items;
  }
  return [...items, trimmed];
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

function modelCallIdFromEvent(event: AgentReplStreamEvent): string | null {
  return modelCallIdFromRawJson(event.payload.raw_json);
}

type ModelCallUsageCandidate = {
  modelCallId: string;
  model?: string | null;
  stopReason?: string | null;
  usage: Record<string, unknown>;
  eventIndex: number;
  terminal: boolean;
  completenessScore: number;
};

const terminalStopReasons = new Set([
  "tool_use",
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "pause_turn",
  "refusal",
]);

function bundleUsageStorageKey(sessionId: string, bundleId: string): string {
  return `${sessionId}\n${bundleId}`;
}

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

function usagePickNumber(usage: Record<string, unknown>, names: string[]): number {
  for (const name of names) {
    const value = usageNumericValue(usage[name]);
    if (value > 0) {
      return value;
    }
  }
  return 0;
}

function usageTotalsFromUsage(usage: Record<string, unknown>): BundleUsageTotals {
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

function addUsageTotals(left: BundleUsageTotals, right: BundleUsageTotals): BundleUsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    totalInputTokens: left.totalInputTokens + right.totalInputTokens,
  };
}

type BundleUsageModelCost = {
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
};

function activeDeepSeekPricingModelName(
  settings: ModelSettings | null | undefined,
): string | null {
  const activeModel = settings?.models.find((model) => model.id === settings.activeModelId);
  const configured = activeModel?.model || activeModel?.supportModels?.[0] || null;
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

function calculateBundleUsageCostFromDeepSeekPricing(
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

function bundleUsageStatusFromEvent(event: AgentReplStreamEvent): BundleUsageSnapshot["status"] {
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

function bundleUsageButtonLabel(snapshot: BundleUsageSnapshot | null | undefined): string {
  if (!snapshot || snapshot.modelCallUsages.length === 0) {
    return "Usage";
  }
  const totalTokens = snapshot.usage.totalInputTokens + snapshot.usage.outputTokens;
  return totalTokens > 0 ? `Usage ${totalTokens}` : "Usage";
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

function bundleUsageCostAmount(snapshot: BundleUsageSnapshot | null | undefined): number | null {
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

function bundleUsageCurrency(snapshot: BundleUsageSnapshot | null | undefined): string {
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

function formatBundleUsageCost(snapshot: BundleUsageSnapshot | null | undefined): string {
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

function bundleUsageHitRate(snapshot: BundleUsageSnapshot | null | undefined): number | null {
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

function formatBundleUsageHitRate(snapshot: BundleUsageSnapshot | null | undefined): string {
  const hitRate = bundleUsageHitRate(snapshot);
  return hitRate == null ? "unavailable" : `${(hitRate * 100).toFixed(2)}%`;
}

function isAssistantBundleStartEvent(event: AgentReplStreamEvent): boolean {
  if (event.eventType !== "turn_text" && event.eventType !== "tool_call") {
    return false;
  }
  const rawJson = event.payload.raw_json;
  return isRecord(rawJson) && rawJson.type === "assistant" && Boolean(modelCallIdFromRawJson(rawJson));
}

function isBundleCompletionEvent(event: AgentReplStreamEvent): boolean {
  return (
    event.eventType === "turn_complete" ||
    event.eventType === "error" ||
    event.eventType === "interrupt" ||
    event.eventType === "process_exit"
  );
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

function rekeyAssistantBundle(
  current: Record<string, AssistantMessageDebugBundle>,
  previousBundleId: string | null,
  bundleId: string,
): Record<string, AssistantMessageDebugBundle> {
  if (!previousBundleId || previousBundleId === bundleId || !current[previousBundleId]) {
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
        text: item.text && item.text !== pendingAssistantText ? item.text : previous.text,
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
    console.warn("[agent-ui][bundle] assistant live event has no resolved bundle id; skip transient assistant StreamItem", {
      sessionId,
    });
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
        item.progressText ?? (item.text === pendingAssistantText ? undefined : item.text),
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
    console.warn("[agent-ui][bundle] assistant complete event has no resolved bundle id; skip transient assistant StreamItem", {
      sessionId,
    });
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
  const { event, bundleId, previousBundleId, modelCallId, completesBundle } = resolved;
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
    modelCallIds: addUniqueString(existing?.modelCallIds ?? [bundleId], modelCallId),
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

function rekeyAssistantStreamItem(
  items: StreamItem[],
  previousBundleId: string | null,
  bundleId: string | null,
): StreamItem[] {
  if (!previousBundleId || !bundleId || previousBundleId === bundleId) {
    return items;
  }
  return items.map((item) =>
    item.kind === "message" && item.role === "assistant" && item.id === previousBundleId
      ? { ...item, id: bundleId }
      : item,
  );
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

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function loadTypedRuntimeSessionWithRetry(
  root: string,
  reference: string,
  attempts = 12,
): Promise<RuntimeSessionDetail> {
  let lastError: unknown = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await loadTypedRuntimeSession(root, reference);
    } catch (reason) {
      lastError = reason;
      await waitMs(150);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function detectFileMention(value: string, cursor: number): FileMentionState {
  const beforeCursor = value.slice(0, cursor);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex < 0) {
    return { active: false, query: "", start: cursor, end: cursor };
  }

  const previous = atIndex === 0 ? " " : beforeCursor[atIndex - 1] ?? " ";
  const query = beforeCursor.slice(atIndex + 1);
  const hasBoundary = atIndex === 0 || /[\s([{,，。；;：:]/.test(previous);
  const hasInvalidQuery = /[\n\r\t ]/.test(query) || query.length > 160;

  if (!hasBoundary || hasInvalidQuery) {
    return { active: false, query: "", start: cursor, end: cursor };
  }

  return {
    active: true,
    query,
    start: atIndex,
    end: cursor,
  };
}

function renderPromptHighlightedText(value: string) {
  const parts: Array<string | JSX.Element> = [];
  const tokenRegex = /(^|\s)(\/[A-Za-z0-9:_-]+|@(?:"[^"]+"|[^\s]+))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(value)) !== null) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    const tokenStart = match.index + prefix.length;
    const tokenEnd = tokenStart + token.length;

    if (tokenStart > lastIndex) {
      parts.push(value.slice(lastIndex, tokenStart));
    }

    const isSkill = token.startsWith("/");
    parts.push(
      <span
        key={`${tokenStart}-${token}`}
        className={isSkill ? "prompt-inline-skill-token" : "prompt-inline-file-token"}
      >
        {token}
      </span>,
    );

    lastIndex = tokenEnd;
  }

  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }

  return parts.length > 0 ? parts : "";
}

function detectSlashCommandMenu(
  value: string,
  cursor: number,
): Pick<SlashCommandMenuState, "active" | "query" | "start" | "end"> {
  const beforeCursor = value.slice(0, cursor);
  const slashIndex = beforeCursor.lastIndexOf("/");
  if (slashIndex < 0) {
    return { active: false, query: "", start: cursor, end: cursor };
  }

  const previous = slashIndex === 0 ? " " : beforeCursor[slashIndex - 1] ?? " ";
  const query = beforeCursor.slice(slashIndex + 1);
  const hasBoundary = slashIndex === 0 || /[\s([{,，。；;：:]/.test(previous);
  const hasInvalidQuery = /[\n\r\t ]/.test(query) || query.length > 80;

  if (!hasBoundary || hasInvalidQuery) {
    return { active: false, query: "", start: cursor, end: cursor };
  }

  return { active: true, query, start: slashIndex, end: cursor };
}

function extractPromptSkillToken(value: string): string | null {
  const match = value.trimStart().match(/^\/([A-Za-z0-9:_-]+)/);
  return match?.[1] ?? null;
}

function formatFileSize(bytes?: number | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sanitizeFenceContent(content: string): string {
  return content.replace(/```/g, "`\u200b``");
}

function languageFence(language: string, path: string): string {
  const normalized = language.trim() || path.split(".").pop() || "text";
  return normalized.replace(/[^a-zA-Z0-9_-]/g, "") || "text";
}

function localFileReferenceName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || normalized || "file";
}

const localFileReferenceBlockPattern =
  /\n*<agent-ui-local-file-references>[\s\S]*?<\/agent-ui-local-file-references>\s*/gi;

function stripLocalFileReferenceBlock(text: string): string {
  return text.replace(localFileReferenceBlockPattern, "").trim();
}

function commandEnvelopeDisplayText(text: string): string | null {
  const commandNameMatch = text.match(/<command-name>\s*([\s\S]*?)\s*<\/command-name>/i);
  const commandMessageMatch = text.match(/<command-message>\s*([\s\S]*?)\s*<\/command-message>/i);
  const commandArgsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/i);

  const rawCommand = (commandNameMatch?.[1] ?? commandMessageMatch?.[1] ?? "").trim();
  if (!rawCommand) {
    return null;
  }

  const commandName = rawCommand.startsWith("/") ? rawCommand : `/${rawCommand}`;
  const commandArgs = stripLocalFileReferenceBlock(commandArgsMatch?.[1] ?? "").trim();

  return [commandName, commandArgs].filter(Boolean).join(" ").trim();
}

function parseLocalFileReferenceSummaries(text: string): LocalFileReferenceSummary[] {
  const blockMatches = Array.from(
    text.matchAll(/<agent-ui-local-file-references>([\s\S]*?)<\/agent-ui-local-file-references>/gi),
  );
  if (blockMatches.length === 0) {
    return [];
  }

  const summaries: LocalFileReferenceSummary[] = [];
  const seen = new Set<string>();

  for (const blockMatch of blockMatches) {
    const block = blockMatch[1] ?? "";
    const parts = block.split(/\n(?=###\s+)/g);
    for (const part of parts) {
      const header = part.match(/^###\s+(.+)\s*$/m);
      if (!header) {
        continue;
      }
      const path = header[1].trim();
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);

      const language = part.match(/^-\s*language:\s*(.+)$/m)?.[1]?.trim();
      const linesValue = part.match(/^-\s*lines:\s*(\d+)/m)?.[1];
      const truncated = /content truncated/i.test(part);
      const failed = /failed to read|skipped:/i.test(part);

      summaries.push({
        path,
        name: localFileReferenceName(path),
        language,
        total_lines: linesValue ? Number(linesValue) : null,
        size_bytes: null,
        injected_bytes: null,
        truncated,
        failed,
        error: failed ? part.split("\n").slice(1, 3).join(" ").trim() : undefined,
      });
    }
  }

  return summaries;
}

function localFileReferencesFromPromptText(text: string): LocalFileReferenceSummary[] {
  return parseLocalFileReferenceSummaries(text);
}

function displayPromptText(text: string): string {
  return commandEnvelopeDisplayText(text) ?? (stripLocalFileReferenceBlock(text) || text.trim());
}

type LocalFileReferenceBuildResult = {
  prompt: string;
  fileReferences: LocalFileReferenceSummary[];
};

function isCsvFilePath(path?: string | null, language?: string | null): boolean {
  const normalizedPath = (path ?? "").trim().toLowerCase();
  const normalizedLanguage = (language ?? "").trim().toLowerCase();
  return normalizedLanguage === "csv" || normalizedPath.endsWith(".csv");
}

function isLocalReferenceLink(link: StreamLink): boolean {
  return link.id.startsWith("local-reference:");
}

function localReferenceToStreamLink(reference: LocalFileReference): StreamLink {
  const normalizedPath = reference.path;
  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  const label = reference.name || segments[segments.length - 1] || normalizedPath;
  return {
    id: `local-reference:${normalizedPath}`,
    label,
    kind: linkKindForPath(normalizedPath),
    path: normalizedPath,
  };
}

function localFileReferenceSummaryToStreamLink(reference: LocalFileReferenceSummary): StreamLink {
  const normalizedPath = reference.path;
  const label = reference.name || localFileReferenceName(normalizedPath);
  return {
    id: `local-reference:${normalizedPath}`,
    label,
    kind: linkKindForPath(normalizedPath),
    path: normalizedPath,
  };
}

function isAbsoluteOrHomeReferencePath(path: string): boolean {
  const normalized = path.trim();
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("～/")
  );
}

function shouldReadAsLocalReference(link: StreamLink): boolean {
  return isLocalReferenceLink(link) || isAbsoluteOrHomeReferencePath(link.path);
}

async function buildPromptWithLocalFileReferences(
  root: string,
  userPrompt: string,
  references: LocalFileReference[],
): Promise<LocalFileReferenceBuildResult> {
  const uniqueReferences = Array.from(
    new Map(references.map((reference) => [reference.path, reference])).values(),
  );

  if (uniqueReferences.length === 0) {
    return { prompt: userPrompt, fileReferences: [] };
  }

  const blocks: string[] = [];
  const fileSummaries: LocalFileReferenceSummary[] = [];
  let totalBytes = 0;

  for (const reference of uniqueReferences) {
    if (totalBytes >= maxReferencedFilesTotalBytes) {
      blocks.push(
        `### ${reference.path}\nSkipped: total referenced file content limit reached.`,
      );
      fileSummaries.push({
        path: reference.path,
        name: reference.name || localFileReferenceName(reference.path),
        language: reference.extension ?? undefined,
        size_bytes: reference.size_bytes ?? null,
        injected_bytes: 0,
        truncated: true,
        failed: true,
        error: "total referenced file content limit reached",
      });
      continue;
    }

    try {
      const file = await readLocalReferenceFile(root, reference.path);
      const availableBytes = Math.max(
        0,
        maxReferencedFilesTotalBytes - totalBytes,
      );
      const maxBytes = Math.min(maxReferencedFileBytes, availableBytes);
      const encoded = new TextEncoder().encode(file.content);
      const truncated = encoded.length > maxBytes;
      const content = truncated
        ? new TextDecoder().decode(encoded.slice(0, maxBytes))
        : file.content;
      const injectedBytes = Math.min(encoded.length, maxBytes);
      totalBytes += injectedBytes;

      fileSummaries.push({
        path: file.path,
        name: localFileReferenceName(file.path),
        language: file.language || reference.extension || "text",
        total_lines: file.total_lines,
        size_bytes: file.size_bytes,
        injected_bytes: injectedBytes,
        truncated,
        failed: false,
      });

      blocks.push(
        [
          `### ${file.path}`,
          `- language: ${file.language || reference.extension || "text"}`,
          `- lines: ${file.total_lines}`,
          `- size: ${formatFileSize(file.size_bytes)}`,
          truncated
            ? `- note: content truncated to ${formatFileSize(maxBytes)} for this request`
            : null,
          "",
          `\`\`\`${languageFence(file.language, file.path)}`,
          sanitizeFenceContent(content),
          "```",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      );
    } catch (reason) {
      blocks.push(
        `### ${reference.path}\nFailed to read this referenced file: ${String(reason)}`,
      );
      fileSummaries.push({
        path: reference.path,
        name: reference.name || localFileReferenceName(reference.path),
        language: reference.extension ?? undefined,
        size_bytes: reference.size_bytes ?? null,
        injected_bytes: 0,
        truncated: false,
        failed: true,
        error: String(reason),
      });
    }
  }

  return {
    prompt: [
      userPrompt,
      "",
      "<agent-ui-local-file-references>",
      "The user referenced these local files with @. They may be inside or outside the current workspace. Treat them as read-only context snapshots for this turn. Use exact paths when citing or discussing them. If a file is truncated or failed to read, say so instead of guessing missing content.",
      "",
      blocks.join("\n\n"),
      "</agent-ui-local-file-references>",
    ]
      .filter(Boolean)
      .join("\n"),
    fileReferences: fileSummaries,
  };
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

function formatDateTimeNoLocale(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    window.alert(`[datetime] invalid timestamp: ${String(timestampMs)}`);
    throw new Error(`[datetime] invalid timestamp: ${String(timestampMs)}`);
  }
  const date = new Date(timestampMs);
  const pad2 = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDebugTime(timestamp: number): string {
  return formatDateTimeNoLocale(timestamp);
}

function debugStorageSource(event: Pick<DebugStreamEvent, "debugStorageSource">): string {
  const source = event.debugStorageSource;
  if (typeof source !== "string" || !source.trim()) {
    const message = "ERROR: debug event missing required debugStorageSource/source. No fallback is allowed.";
    if (typeof window !== "undefined") {
      window.alert(message);
    }
    throw new Error(message);
  }
  return source.trim();
}

function debugStorageSourceCounts(
  events: Array<Pick<DebugStreamEvent, "debugStorageSource">>,
): Record<string, number> {
  return events.reduce<Record<string, number>>((counts, event) => {
    const source = debugStorageSource(event);
    counts[source] = (counts[source] ?? 0) + 1;
    return counts;
  }, {});
}

function debugStorageSourceSummary(
  events: Array<Pick<DebugStreamEvent, "debugStorageSource">>,
): string {
  const entries = Object.entries(debugStorageSourceCounts(events));
  if (entries.length === 0) {
    return "source: none";
  }
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, count]) => `${source}: ${count}`)
    .join(" · ");
}

type RuntimeSessionArtifacts = {
  items: StreamItem[];
  bundles: Record<string, AssistantMessageDebugBundle>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rawJsonFromRuntimeMessage(
  message: RuntimeSessionDetail["messages"][number],
): Record<string, unknown> | null {
  return isRecord(message.raw_json) ? message.raw_json : null;
}

function checkpointUuidFromRuntimeMessage(
  message: RuntimeSessionDetail["messages"][number],
): string | undefined {
  if (typeof message.uuid === "string" && message.uuid.trim()) {
    return message.uuid.trim();
  }
  const rawJson = rawJsonFromRuntimeMessage(message);
  const uuid = rawJson?.uuid;
  return typeof uuid === "string" && uuid.trim() ? uuid.trim() : undefined;
}

function rawJsonFromDebugEvent(event: DebugStreamEvent): Record<string, unknown> | null {
  const rawJson = event.payload.raw_json;
  if (isRecord(rawJson)) {
    return rawJson;
  }
  return isRecord(event.payload) ? event.payload : null;
}

function assistantOutputTimestampMsFromBundle(
  bundle: AssistantMessageDebugBundle | null | undefined,
): number | null {
  const events = bundle?.events ?? [];
  if (events.length === 0) {
    return null;
  }

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
    return event.receivedAt;
  }

  return null;
}

function assistantUsageOutputDateTimeFromBundle(
  bundle: AssistantMessageDebugBundle | null | undefined,
): string | null {
  const timestampMs = assistantOutputTimestampMsFromBundle(bundle);
  if (timestampMs === null) {
    return null;
  }
  return formatDateTimeNoLocale(timestampMs);
}

function assistantUsageButtonTitle(
  bundle: AssistantMessageDebugBundle | null | undefined,
): string {
  const outputDateTime = assistantUsageOutputDateTimeFromBundle(bundle);
  return outputDateTime ? `输出时间 ${outputDateTime}` : "查看 Usage";
}

function jsonContainsTypedBlock(value: unknown, expectedType: string): boolean {
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

function runtimeMessageRawType(
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

function looksLikeRealRuntimeUserText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || normalized.startsWith("[Request interrupted")) {
    return false;
  }

  // Claude Code persists slash commands as an XML-like command envelope, for
  // example `<command-name>/kline-chart</command-name>`. That is still the
  // user's turn and must split assistant turns during historical restore.
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

function isRuntimeRealUserMessage(
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

  // Claude Code stores tool results as `type: "user"` + `message.role: "user"`
  // with content blocks like `{ type: "tool_result" }`. Those are tool output,
  // not a new human turn, so they must not split one assistant answer into N bubbles.
  if (rawJson && jsonContainsTypedBlock(rawJson, "tool_result")) {
    return false;
  }

  return looksLikeRealRuntimeUserText(message.text);
}

function debugEventTypeForRuntimeMessage(
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

function createHistoricalDebugEvent(
  detail: RuntimeSessionDetail,
  root: string,
  message: RuntimeSessionDetail["messages"][number],
  index: number,
): DebugStreamEvent | null {
  const rawJson = rawJsonFromRuntimeMessage(message);
  if (!rawJson && !message.text.trim()) {
    return null;
  }

  return {
    id: `debug:${detail.id}:history:${index}`,
    sessionId: detail.id,
    root,
    eventType: debugEventTypeForRuntimeMessage(message),
    receivedAt: detail.updated_at_ms + index,
    debugStorageSource: "runtime",
    payload: {
      historical: true,
      text: message.text,
      event_type: message.event_type ?? null,
      raw_json: rawJson ?? undefined,
    },
  };
}

function extractToolUsesFromRawJson(value: unknown): Record<string, unknown>[] {
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

function toolName(tool: Record<string, unknown>): string {
  const name = tool.name;
  return typeof name === "string" && name.trim() ? name : "Tool";
}

function commandFromToolUse(tool: Record<string, unknown>): string | null {
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

function summarizeToolUse(tool: Record<string, unknown>): string {
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

function isToolResultEvent(event: DebugStreamEvent): boolean {
  const rawJson = rawJsonFromDebugEvent(event);
  return (
    event.eventType === "tool_result" ||
    rawJson?.type === "tool_result" ||
    rawJson?.type === "tool"
  );
}

type AssistantProcessTimelineItem =
  | {
      id: string;
      kind: "text";
      title: string;
      detail: string;
      receivedAt: number;
    }
  | {
      id: string;
      kind: "tool_call";
      title: string;
      detail: string;
      tool: Record<string, unknown>;
      receivedAt: number;
    }
  | {
      id: string;
      kind: "tool_result";
      title: string;
      detail: string;
      receivedAt: number;
    }
  | {
      id: string;
      kind: "permission";
      title: string;
      detail: string;
      receivedAt: number;
    };

function truncateProcessDetail(value: string, limit = 900): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}…`;
}

function textFromContentBlocks(content: unknown): string {
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

function textFromProcessEvent(event: DebugStreamEvent): string {
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

function summarizeToolResultEvent(event: DebugStreamEvent): string {
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

function isPermissionEvent(event: DebugStreamEvent): boolean {
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

function summarizePermissionEvent(event: DebugStreamEvent): string {
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

function toolUsesFromProcessEvent(event: DebugStreamEvent): Record<string, unknown>[] {
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

function assistantTurnDetails(
  item: Extract<StreamItem, { kind: "message" }>,
  bundle: AssistantMessageDebugBundle | null,
) {
  const fallbackProgressLines = (item.progressText ?? "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const timeline: AssistantProcessTimelineItem[] = [];
  const seenTools = new Set<string>();
  const toolUses: Record<string, unknown>[] = [];
  const toolResults: DebugStreamEvent[] = [];

  for (const [index, event] of (bundle?.events ?? []).entries()) {
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
      timeline.push({
        id: `${baseId}:permission`,
        kind: "permission",
        title: event.eventType.includes("approved") || event.eventType.includes("response")
          ? "Permission response"
          : "Permission request",
        detail: summarizePermissionEvent(event),
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

  if (timeline.length === 0) {
    for (const [index, line] of fallbackProgressLines.entries()) {
      timeline.push({
        id: `${item.id}:fallback-progress:${index}`,
        kind: "text",
        title: "Assistant",
        detail: line,
        receivedAt: bundle?.startedAt ?? 0,
      });
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
    commandUses,
    toolResults,
    eventCount: bundle?.events.length ?? 0,
  };
}

function compactCountLabel(count: number, singular: string, plural = `${singular}s`) {
  if (count === 0) {
    return `0 ${plural}`;
  }
  return `${count} ${count === 1 ? singular : plural}`;
}

function runtimeSessionToArtifacts(
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

function permissionToolNameFromEvent(event: AgentReplStreamEvent): string {
  const rawJson = isRecord(event.payload.raw_json) ? event.payload.raw_json : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  const candidate =
    event.payload.toolName ??
    event.payload.tool_name ??
    request.toolName ??
    request.tool_name ??
    (isRecord(request.request) ? request.request.toolName ?? request.request.tool_name : undefined);
  return typeof candidate === "string" && candidate.trim() ? candidate : "tool";
}

function permissionRequestIdFromEvent(event: AgentReplStreamEvent): string {
  const rawJson = isRecord(event.payload.raw_json) ? event.payload.raw_json : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  const candidate =
    event.payload.requestId ??
    event.payload.request_id ??
    rawJson.request_id ??
    request.request_id;
  return typeof candidate === "string" ? candidate : "";
}

function permissionInputFromEvent(event: AgentReplStreamEvent): unknown {
  const rawJson = isRecord(event.payload.raw_json) ? event.payload.raw_json : event.payload;
  const request = isRecord(rawJson.request) ? rawJson.request : rawJson;
  return event.payload.input ?? request.input ?? (isRecord(request.request) ? request.request.input : undefined);
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

function usageNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function streamEventToItems(
  items: StreamItem[],
  resolved: ResolvedRuntimeBundleEvent,
): StreamItem[] {
  const event = resolved.event;
  if (isPermissionEventName(event.eventType)) {
    return items;
  }
  const baseId = `repl:${event.sessionId}:${Date.now()}`;
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
        ? completeCurrentTurnAssistantMessage(bundleItems, event.sessionId, finalText, resolved.bundleId)
        : bundleItems;
    }
    case "process_exit":
      return bundleItems;
    case "stderr":
    case "error":
      return [
        ...bundleItems,
        {
          id: baseId,
          kind: "system",
          subtype: "error",
          title: event.eventType === "stderr" ? "Runtime log" : "Turn failed",
          detail: payloadText(event) || JSON.stringify(event.payload),
        },
      ];
    default:
      return bundleItems;
  }
}

const sessionUsageIndicatorOptions: Array<{
  key: SessionUsageIndicatorKey;
  label: string;
}> = [
  { key: "costAmount", label: "Cost" },
  { key: "totalInputTokens", label: "Total input" },
  { key: "inputTokens", label: "Input" },
  { key: "outputTokens", label: "Output" },
  { key: "cacheReadInputTokens", label: "Cache hit input" },
  { key: "cacheCreationInputTokens", label: "Cache create input" },
  { key: "hitRate", label: "Hit rate" },
  { key: "modelCallCount", label: "Model calls" },
];

function bundleUsageTimeMs(snapshot: BundleUsageSnapshot): number {
  return snapshot.startedAtMs ?? snapshot.completedAtMs ?? snapshot.updatedAtMs ?? 0;
}

function bundleUsageIndicatorValue(
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

function formatSessionUsageIndicatorValue(
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

function sessionUsageSnapshotsForSession(
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

function sessionUsageTotals(snapshots: BundleUsageSnapshot[]): BundleUsageTotals {
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

function sessionUsageHitRateFromTotals(totals: BundleUsageTotals): number | null {
  const totalInput =
    totals.totalInputTokens ||
    totals.inputTokens + totals.cacheReadInputTokens + totals.cacheCreationInputTokens;
  if (!totalInput || totalInput <= 0) return null;
  return totals.cacheReadInputTokens / totalInput;
}

function sessionUsageCostAmount(snapshots: BundleUsageSnapshot[]): number | null {
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

function sessionUsageCurrency(snapshots: BundleUsageSnapshot[]): string {
  for (const snapshot of snapshots) {
    const currency = bundleUsageCurrency(snapshot);
    if (currency) return currency;
  }
  return "CNY";
}

function sessionUsageModelCostByCallId(
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

function formatModelCallCost(
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

const DEFAULT_CONTEXT_USAGE_AUTO_COMPACT_THRESHOLD = 256_000;

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

function contextUsageAutoCompactEnabledLabel(usage: AgentContextUsage | null | undefined): string {
  const value = usage?.data?.isAutoCompactEnabled;
  return typeof value === "boolean" ? String(value) : "--";
}

function contextUsageLabel(usage: AgentContextUsage | null | undefined): string {
  const current = usage?.data ? formatContextTokens(usage.data.totalTokens) : "--";
  const threshold = formatContextTokens(
    usage?.data?.autoCompactThreshold ?? DEFAULT_CONTEXT_USAGE_AUTO_COMPACT_THRESHOLD,
  );
  return `上下文：${current}/${threshold}(${contextUsageAutoCompactEnabledLabel(usage)})`;
}

function contextUsageFromBundleSnapshot(
  snapshot: BundleUsageSnapshot,
  previous?: AgentContextUsage | null,
): AgentContextUsage | null {
  // patched: context length uses last model request input + output
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

export function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

export function App() {
  useEffect(() => {
    void sqliteDatabaseInfo()
      .then((info) => {
        console.info("[sqlite] database ready", info.path);
      })
      .catch((reason) => {
        console.warn("[sqlite] database init failed", reason);
      });
  }, []);

  const [projects, setProjects] = useState<ProjectFolder[]>([]);
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);

  const streamState = useStreamState();
  const {
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
    currentBundleBySessionRef,
    updateSessionStream,
    refreshSessionContextUsage,
    contextUsageLabel,
    bundleUsageButtonLabel: bundleUsageButtonLabelHook,
    sessionUsageSnapshotsForSession,
    handleToggleAssistantProcess,
    handleToggleSessionUsage,
    handleViewAssistantUsage,
    handleViewAssistantDebug,
    handleCopyAssistantDebug,
    registerTurnHandlers,
  } = streamState;

  const [hiddenSessions, setHiddenSessions] = useState<HiddenSession[]>(() =>
    loadHiddenSessions(),
  );
  const [openSessionMenu, setOpenSessionMenu] = useState<{
    root: string;
    sessionId: string;
  } | null>(null);
  const [remotePathPrompt, setRemotePathPrompt] = useState<string | null>(null);
  const remotePathPromptResolve = useRef<((value: string | null) => void) | null>(null);
  const [remotePathInput, setRemotePathInput] = useState("");
  const [remotePathSuggestions, setRemotePathSuggestions] = useState<string[]>([]);
  const [remotePathHighlightIndex, setRemotePathHighlightIndex] = useState(-1);
  const remotePathDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<{ root: string; x: number; y: number } | null>(null);
  const [permissionState, setPermissionState] =
    useState<AgentPermissionState | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AppView>("workspace");
  const [error, setError] = useState<string | null>(null);
  const [chatModelOptions, setChatModelOptions] = useState<string[]>([
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ]);
  const [selectedChatModel, setSelectedChatModel] =
    useState<string>("deepseek-v4-flash");

  const [activeRemoteProfile] = useState<RemoteProfile | null>(
    () => loadActiveRemoteProfileSnapshot(),
  );

  const runtimeBadgeTitle = activeRemoteProfile
    ? `Remote runtime: ${activeRemoteProfile.name} · ${activeRemoteProfile.baseUrl}`
    : "Local runtime";

  const activePreview =
    previewTabs.find((tab) => tab.id === activePreviewId) ??
    previewTabs[0] ??
    null;
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;

  const promptInput = usePromptInput({
    activeProject,
    activeSessionId,
    selectedChatModel,
    permissionMode: (permissionState?.currentMode ?? "default") as PermissionMode,
    onSubmitPrompt: () => agentTurn.submitPrompt(),
  });
  const {
    prompt,
    setPrompt,
    fileReferences,
    setFileReferences,
    handlePromptChange,
    handlePromptKeyDown,
    handlePromptSubmit,
    closeFileSuggestions,
    removeFileReference,
    markPromptImeActive,
    isResolvingFileReferences: promptIsResolving,
    canSendPrompt,
    textareaRef,
    promptHighlightRef,
    promptImeStateRef,
    fileMention,
    fileSuggestions,
    fileSuggestionIndex,
    isSearchingFiles,
    slashCommandMenu,
    slashRootOptions,
    slashLeafOptions,
    slashLeafTitle,
    slashLeafDescription,
    slashLeafEmptyText,
    onSetSlashCommandMenu,
    selectFileSuggestion,
    selectSlashRootItem,
    selectSlashItem,
    updateFileMentionFromInput,
    updateSlashCommandMenuFromInput,
  } = promptInput;

  const agentTurn = useAgentTurn({
    activeProject,
    activeSessionId,
    selectedChatModel,
    permissionState,
    prompt,
    fileReferences,
    updateSessionStream,
    setAssistantDebugBundles,
    refreshSessionContextUsage,
    currentBundleBySessionRef,
    setProjects,
    setPrompt,
    setFileReferences,
    closeFileSuggestions,
    setError,
  });

  // Register agentTurn handlers with streamState's event listener
  const turnHandlersRef = useRef(false);
  if (!turnHandlersRef.current) {
    registerTurnHandlers({
      setIsRunningTurn: agentTurn.setIsRunningTurn,
      enqueuePendingPermission: agentTurn.enqueuePendingPermission,
      clearPendingPermissionsForSession: agentTurn.clearPendingPermissionsForSession,
      setProjects,
    });
    turnHandlersRef.current = true;
  }

  const {
    isRunningTurn,
    forkingMessageId,
    isInterruptingTurn,
    pendingPermission,
    isResolvingFileReferences,
  } = agentTurn;
  const activeContextUsage = activeSessionId
    ? sessionContextUsageById[activeSessionId] ?? null
    : null;
  const streamItems = activeSessionId
    ? collapseAssistantTurns(sessionStreams[activeSessionId] ?? [])
    : [];
  const debugEvents = activeSessionId
    ? (sessionDebugEvents[activeSessionId] ?? [])
    : [];

  const activeSessionTitle = useMemo(() => {
    for (const folder of projects) {
      const session = folder.sessions.find(
        (candidate) => candidate.id === activeSessionId,
      );
      if (session) {
        return session.title;
      }
    }
    return "未选择会话";
  }, [activeSessionId, projects]);

  useEffect(() => {
    window.localStorage.setItem(
      hiddenSessionsStorageKey,
      JSON.stringify(uniqueHiddenSessions(hiddenSessions)),
    );
  }, [hiddenSessions]);

  useEffect(() => {
    let cancelled = false;
    getAgentPermissionState()
      .then((state) => {
        if (!cancelled) {
          setPermissionState(state);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await clientDebugLog("info", "initialLoad.start", { remoteMode: !!activeRemoteProfile });
      const registry = await loadWorkspaceRegistry();
      await clientDebugLog("info", "initialLoad.registry", { count: registry.workspaces.length });
      if (cancelled) return;

      // 如果注册表为空，尝试使用默认 workspace（当前目录）并注册它
      if (registry.workspaces.length === 0) {
        try {
          await clientDebugLog("info", "initialLoad.getDefaultWorkspace");
          const defaultWs = await getDefaultWorkspace();
          await clientDebugLog("info", "initialLoad.defaultWorkspace", { root: defaultWs.root, name: defaultWs.name });
          await addWorkspaceRegistryEntry(defaultWs.root);
          registry.workspaces = [{ root: defaultWs.root, name: defaultWs.name }];
        } catch (e) {
          await clientDebugLog("error", "initialLoad.defaultWorkspaceFailed", { error: String(e) });
          // 静默失败，让用户通过"+"手动添加
        }
      }

      const loadedProjects = await Promise.all(
        registry.workspaces.map(async (workspace) => {
          const sessions = await listRuntimeSessions(workspace.root);
          await clientDebugLog("info", "initialLoad.projectSessions", { root: workspace.root, sessionCount: sessions.length });
          return {
            id: projectIdFromRoot(workspace.root),
            name: workspace.name,
            root: workspace.root,
            sessions: sessionsFromRuntimeSummaries(
              workspace.root,
              sessions,
              hiddenSessions,
            ),
            worktreeSessions: [],
          } satisfies ProjectFolder;
        }),
      );
      if (cancelled) {
        return;
      }
      await clientDebugLog("info", "initialLoad.projectsLoaded", { count: loadedProjects.length });
      setProjects(loadedProjects);
      const firstProject = loadedProjects[0] ?? null;
      const firstSessionId = firstProject?.sessions[0]?.id ?? null;
      if (firstProject && firstSessionId) {
        setExpandedFolders(new Set([firstProject.id]));
        setActiveProjectId(firstProject.id);
        setActiveSessionId(firstSessionId);
        setSessionStreams((streams) => ({
          ...streams,
          [firstSessionId]:
            streams[firstSessionId] ??
            welcomeStream(
              firstProject.name,
              firstProject.sessions[0]?.title ?? "会话",
            ),
        }));
      }
    })().catch((reason) => {
      if (!cancelled) {
        clientDebugLog("error", "initialLoad.catch", { error: String(reason) });
        setError(String(reason));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadModelSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        const deepseek = settings.models.find(
          (model) => model.provider === "deepseek",
        );
        const options = (deepseek?.supportModels ?? []).filter(Boolean);
        if (options.length > 0) {
          setChatModelOptions(options);
          setSelectedChatModel(
            options.includes("deepseek-v4-flash")
              ? "deepseek-v4-flash"
              : options[0],
          );
        } else {
          setChatModelOptions(["deepseek-v4-flash", "deepseek-v4-pro"]);
          setSelectedChatModel("deepseek-v4-flash");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChatModelOptions(["deepseek-v4-flash", "deepseek-v4-pro"]);
          setSelectedChatModel("deepseek-v4-flash");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDeleteProject(root: string) {
    try {
      await removeWorkspaceRegistryEntry(root);
      setProjects((prev) => prev.filter((p) => p.root !== root));
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.forEach((id) => {
          if (id.includes(root)) next.delete(id);
        });
        return next;
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleFolder(folderId: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

    // updateSessionStream, refreshSessionContextUsage, and listenAgentReplEvents are now handled by useStreamState

  function selectSession(project: ProjectFolder, sessionId: string) {
    const sessionTitle =
      project.sessions.find((session) => session.id === sessionId)?.title ??
      "会话";
    setActiveView("workspace");
    setActiveProjectId(project.id);
    setActiveSessionId(sessionId);
    setSessionStreams((streams) => ({
      ...streams,
      [sessionId]:
        streams[sessionId] ?? welcomeStream(project.name, sessionTitle),
    }));

    if (!isNewSessionId(sessionId)) {
      getAgentReplProcessStatus(project.root, sessionId)
        .then((status) => {
          if (status.running) {
            void refreshSessionContextUsage(project.root, status.sessionId || sessionId);
          }
          setProjects((folders) =>
            folders.map((folder) =>
              folder.id === project.id
                ? {
                    ...folder,
                    sessions: folder.sessions.map((session) =>
                      session.id === sessionId
                        ? {
                            ...session,
                            processStatus: status.running
                              ? "active"
                              : "stopped",
                            processPid: status.pid ?? undefined,
                          }
                        : session,
                    ),
                  }
                : folder,
            ),
          );
        })
        .catch((reason) => setError(String(reason)));
    }
  }

  useEffect(() => {
    if (
      !activeProject ||
      !activeSessionId ||
      isRunningTurn ||
      pendingPermission?.sessionId === activeSessionId
    ) {
      return;
    }
    const activeSession = activeProject.sessions.find(
      (session) => session.id === activeSessionId,
    );
    if (activeSession?.isPending) {
      return;
    }
    let cancelled = false;
    loadTypedRuntimeSession(activeProject.root, activeSessionId)
      .then((detail) => {
        if (cancelled) {
          return;
        }
        const artifacts = runtimeSessionToArtifacts(detail, activeProject.root);

      void loadBundleUsageSnapshotsForSession(detail.id)
        .then((snapshots) => {
          setStreamUsageByBundleKey((current) => {
            const next = { ...current };
            for (const snapshot of snapshots) {
              next[bundleUsageStorageKey(snapshot.sessionId, snapshot.bundleId)] = snapshot;
            }
            return next;
          });
        })
        .catch((reason) => {
          console.warn("[bundle-usage] failed to hydrate history usage snapshots", {
            sessionId: detail.id,
            reason,
          });
        });
        setAssistantDebugBundles((bundles) => ({
          ...bundles,
          ...artifacts.bundles,
        }));
        setSessionStreams((streams) => {
          const existingItems = streams[activeSessionId] ?? [];

          // Do not overwrite a live in-memory conversation after a turn completes.
          // The in-memory stream keeps stable message IDs for per-answer Debug and
          // already collapses Claude Code progress messages into one assistant
          // bubble. Disk jsonl reloads are used only when opening a session that
          // has not been rendered in this UI instance yet.
          if (existingItems.length > 0) {
            return streams;
          }

          return {
            ...streams,
            [activeSessionId]:
              detail.messages.length > 0
                ? collapseAssistantTurns(artifacts.items)
                : welcomeStream(activeProject.name, activeSessionTitle),
          };
        });
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeProject,
    activeSessionId,
    activeSessionTitle,
    isRunningTurn,
    pendingPermission,
  ]);

  async function handleAddProject() {
    try {
      let selected: string | null;
      const remoteMode = !!activeRemoteProfile;

      await clientDebugLog("info", "handleAddProject.start", { remoteMode, activeProfile: activeRemoteProfile?.name ?? null });
      if (remoteMode) {
        // remote mode: 弹出自定义输入框让用户输入远程服务器路径，支持子目录自动补全
        selected = await new Promise<string | null>((resolve) => {
          remotePathPromptResolve.current = resolve;
          setRemotePathInput("");
          setRemotePathSuggestions([]);
          setRemotePathPrompt("Enter the remote project path (must exist on the remote server):");
        });
        await clientDebugLog("info", "handleAddProject.promptResult", { cancelled: selected === null, empty: selected != null && !selected.trim() });
        if (!selected || !selected.trim()) {
          setRemotePathPrompt(null);
          setRemotePathInput("");
          setRemotePathSuggestions([]);
          return;
        }
        selected = selected.trim();
        setRemotePathInput("");
        setRemotePathSuggestions([]);
        setRemotePathPrompt(null);
        await clientDebugLog("info", "handleAddProject.path", { selected });
      } else {
        // local mode: 使用 Tauri 本地目录选择器
        selected = await openDialog({
          directory: true,
          multiple: false,
          title: "Add project folder",
        });
        if (typeof selected !== "string") {
          await clientDebugLog("info", "handleAddProject.dialogCancelled", { selected });
          return;
        }
      }

      await clientDebugLog("info", "handleAddProject.openWorkspace", { selected });
      const workspace = await openWorkspace(selected);
      await clientDebugLog("info", "handleAddProject.openWorkspaceResult", { workspace });

      await clientDebugLog("info", "handleAddProject.addRegistryEntry", { root: workspace.root });
      await addWorkspaceRegistryEntry(workspace.root);

      const projectId = projectIdFromRoot(workspace.root);
      await clientDebugLog("info", "handleAddProject.listSessions", { root: workspace.root });
      const existingSessions = await listRuntimeSessions(workspace.root);
      await clientDebugLog("info", "handleAddProject.sessionsResult", { count: existingSessions.length });

      const initialSessions = sessionsFromRuntimeSummaries(
        workspace.root,
        existingSessions,
        hiddenSessions,
      );
      const firstSessionId = initialSessions[0]?.id ?? null;
      await clientDebugLog("info", "handleAddProject.initialSessions", {
        initialCount: initialSessions.length,
        firstSessionId,
        isPending: initialSessions[0]?.isPending ?? false,
      });
      if (!firstSessionId) {
        throw new Error("failed to initialize runtime session");
      }
      const nextProject: ProjectFolder = {
        id: projectId,
        name: workspace.name || `文件夹${projects.length + 1}`,
        root: workspace.root,
        sessions: initialSessions,
        worktreeSessions: [],
      };

      setProjects((currentProjects) => {
        const existing = currentProjects.find(
          (project) => project.id === projectId,
        );
        if (existing) {
          return currentProjects;
        }
        return [...currentProjects, nextProject];
      });
      setExpandedFolders((folders) => new Set(folders).add(projectId));
      setActiveView("workspace");
      setActiveProjectId(projectId);
      setActiveSessionId(firstSessionId);
      setSessionStreams((streams) => ({
        ...streams,
        [firstSessionId]:
          streams[firstSessionId] ??
          welcomeStream(
            nextProject.name,
            nextProject.sessions[0]?.title ?? "新会话",
          ),
      }));
      setPreviewTabs([]);
      setActivePreviewId(null);
      setError(null);
      await clientDebugLog("info", "handleAddProject.success", { projectId });
    } catch (reason) {
      await clientDebugLog("error", "handleAddProject.error", { error: String(reason) });
      setError(String(reason));
    }
  }

  function handleCreateSession(project: ProjectFolder) {
    const pendingSession = createPendingSession();
    setProjects((currentProjects) =>
      currentProjects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              sessions: [...candidate.sessions, pendingSession],
            }
          : candidate,
      ),
    );
    setExpandedFolders((folders) => new Set(folders).add(project.id));
    setActiveView("workspace");
    setActiveProjectId(project.id);
    setActiveSessionId(pendingSession.id);
    setSessionStreams((streams) => ({
      ...streams,
      [pendingSession.id]: welcomeStream(project.name, pendingSession.title),
    }));
    setPreviewTabs([]);
    setActivePreviewId(null);
    setError(null);
  }

  async function handleForkSession(project: ProjectFolder, session: ProjectSession) {
    if (isNewSessionId(session.id)) {
      setError("这个会话还没有真实 session 文件，不能 Fork。请先发送一条消息生成会话。");
      return;
    }

    const sourceItems = sessionStreams[session.id] ?? [];
    const checkpointMessage = [...sourceItems]
      .reverse()
      .find(
        (item): item is Extract<StreamItem, { kind: "message" }> =>
          item.kind === "message" && item.role === "assistant" && Boolean(item.checkpointUuid),
      );

    if (!checkpointMessage?.checkpointUuid) {
      setError("这个会话还没有可 fork 的 assistant checkpoint。");
      return;
    }

    try {
      setError(null);
      setOpenSessionMenu(null);
      const forkedProcess = await forkAgentReplProcess(
        project.root,
        session.id,
        checkpointMessage.checkpointUuid,
        selectedChatModel,
        permissionState?.currentMode ?? "default",
      );
      const forkedSessionId = forkedProcess.sessionId;
      const detail = await loadTypedRuntimeSessionWithRetry(project.root, forkedSessionId, 80);
      const artifacts = runtimeSessionToArtifacts(detail, project.root);
      const forkedTitle =
        firstUserTitleFromStream(artifacts.items) ?? `Fork · ${session.title}`;

      setProjects((currentProjects) =>
        currentProjects.map((candidate) =>
          candidate.id === project.id
            ? {
                ...candidate,
                sessions: dedupeSessions([
                  {
                    id: forkedSessionId,
                    title: forkedTitle,
                    processStatus: "active",
                    processPid: undefined,
                  },
                  ...candidate.sessions,
                ]),
              }
            : candidate,
        ),
      );
      setExpandedFolders((folders) => new Set(folders).add(project.id));
      setActiveView("workspace");
      setActiveProjectId(project.id);
      setAssistantDebugBundles((bundles) => ({
        ...bundles,
        ...artifacts.bundles,
      }));
      setSessionStreams((streams) => ({
        ...streams,
        [forkedSessionId]: collapseAssistantTurns(artifacts.items),
      }));
      setActiveSessionId(forkedSessionId);
      setPreviewTabs([]);
      setActivePreviewId(null);
      void refreshSessionContextUsage(project.root, forkedSessionId);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function killSessionProcessBestEffort(root: string, sessionId: string) {
    try {
      await killAgentReplProcess(root, sessionId);
    } catch (reason) {
      console.warn("Failed to kill session process", { root, sessionId, reason });
    }

    setProjects((folders) =>
      folders.map((folder) =>
        folder.root === root
          ? {
              ...folder,
              sessions: folder.sessions.map((candidate) =>
                candidate.id === sessionId
                  ? {
                      ...candidate,
                      processStatus: "stopped",
                      processPid: undefined,
                    }
                  : candidate,
              ),
            }
          : folder,
      ),
    );
  }

  async function handleHideSession(project: ProjectFolder, session: ProjectSession) {
    await killSessionProcessBestEffort(project.root, session.id);
    const hiddenRecord: HiddenSession = {
      root: project.root,
      projectName: project.name,
      sessionId: session.id,
      title: session.title || session.id,
      hiddenAt: Date.now(),
    };
    const remainingSessions = project.sessions.filter(
      (candidate) => candidate.id !== session.id,
    );
    const fallbackSession = remainingSessions[0] ?? createPendingSession();
    const nextSessions =
      remainingSessions.length > 0 ? remainingSessions : [fallbackSession];

    setHiddenSessions((current) =>
      uniqueHiddenSessions([
        hiddenRecord,
        ...current.filter(
          (item) =>
            sessionKey(item.root, item.sessionId) !==
            sessionKey(project.root, session.id),
        ),
      ]),
    );
    setProjects((currentProjects) =>
      currentProjects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              sessions: nextSessions,
            }
          : candidate,
      ),
    );
    setOpenSessionMenu(null);

    if (activeSessionId === session.id) {
      setActiveProjectId(project.id);
      setActiveSessionId(fallbackSession.id);
      setSessionStreams((streams) => ({
        ...streams,
        [fallbackSession.id]:
          streams[fallbackSession.id] ??
          welcomeStream(project.name, fallbackSession.title),
      }));
    }
  }

  async function handleRestoreHiddenSession(hiddenSession: HiddenSession) {
    setHiddenSessions((current) =>
      current.filter(
        (item) =>
          sessionKey(item.root, item.sessionId) !==
          sessionKey(hiddenSession.root, hiddenSession.sessionId),
      ),
    );

    const project = projects.find(
      (candidate) => candidate.root === hiddenSession.root,
    );
    if (!project) {
      return;
    }

    let restoredTitle = hiddenSession.title || hiddenSession.sessionId;
    try {
      const runtimeSessions = await listRuntimeSessions(hiddenSession.root);
      const runtimeSession = runtimeSessions.find(
        (session) => session.id === hiddenSession.sessionId,
      );
      if (runtimeSession?.title) {
        restoredTitle = runtimeSession.title;
      }
    } catch {
      // Restoring visibility should still work even if the jsonl list cannot be refreshed immediately.
    }

    const restoredSession: ProjectSession = {
      id: hiddenSession.sessionId,
      title: restoredTitle,
      isPending: isNewSessionId(hiddenSession.sessionId),
      processStatus: "stopped",
    };

    setProjects((currentProjects) =>
      currentProjects.map((candidate) => {
        if (candidate.id !== project.id) {
          return candidate;
        }
        if (
          candidate.sessions.some(
            (session) => session.id === hiddenSession.sessionId,
          )
        ) {
          return candidate;
        }
        return {
          ...candidate,
          sessions: dedupeSessions([restoredSession, ...candidate.sessions]),
        };
      }),
    );
    setExpandedFolders((folders) => new Set(folders).add(project.id));
    setActiveView("workspace");
    setActiveProjectId(project.id);
    setActiveSessionId(hiddenSession.sessionId);
    setSessionStreams((streams) => ({
      ...streams,
      [hiddenSession.sessionId]:
        streams[hiddenSession.sessionId] ??
        welcomeStream(project.name, restoredTitle),
    }));
  }

  function upsertPreviewTab(tab: PreviewTab) {
    setPreviewTabs((tabs) => {
      const nextTabs = tabs.filter((candidate) => candidate.id !== tab.id);
      return [...nextTabs, tab];
    });
    setActivePreviewId(tab.id);
  }

  function closePreviewTab(id: string) {
    setPreviewTabs((tabs) => {
      const nextTabs = tabs.filter((tab) => tab.id !== id);
      if (activePreviewId === id) {
        setActivePreviewId(nextTabs[nextTabs.length - 1]?.id ?? null);
      }
      return nextTabs;
    });
  }

  async function handleOpenPreviewLink(link: StreamLink) {
    if (!activeProject) {
      setError("Add a project folder first.");
      return;
    }

    if (link.kind === "pdf" || link.kind === "image") {
      upsertPreviewTab({
        id: `reference:${link.path}`,
        kind: "reference",
        title: link.label,
        link,
      });
      return;
    }

    if (shouldReadAsLocalReference(link)) {
      try {
        const file = await readLocalReferenceFile(activeProject.root, link.path);
        upsertPreviewTab({
          id: `local-reference:${file.path}`,
          kind: "file",
          title: file.path,
          file,
          diff: { path: file.path, diff: "", is_empty: true },
        });
      } catch (reason) {
        setError(`Read referenced file failed: ${String(reason)}`);
      }
      return;
    }

    try {
      const [file, diff] = await Promise.all([
        readWorkspaceFile(activeProject.root, link.path),
        readGitDiff(activeProject.root, link.path),
      ]);
      upsertPreviewTab({
        id: `file:${file.path}`,
        kind: "file",
        title: file.path,
        file,
        diff,
      });
    } catch (reason) {
      setError(String(reason));
    }
  }

  function assistantDebugPayload(
    item: Extract<StreamItem, { kind: "message" }>,
    action: "view" | "copy",
  ) {
    const bundle = assistantDebugBundles[item.id];
    const details = assistantTurnDetails(item, bundle ?? null);
    return {
      kind: "agent-ui.assistant-message-debug",
      action,
      generatedAt: new Date().toISOString(),
      sessionId: bundle?.sessionId ?? activeSessionId,
      root: bundle?.root ?? activeProject?.root ?? null,
      messageId: item.id,
      userMessage: bundle?.userMessage ?? null,
      transportMessage: bundle?.transportMessage ?? null,
      referencedFiles: bundle?.fileReferences ?? item.fileReferences ?? null,
      displayedMessage: item.text,
      displayedProgressText: item.progressText ?? null,
      displayStatus: item.status ?? null,
      summary: {
        progressLineCount: details.progressLines.length,
        commandCount: details.commandUses.length,
        toolUseCount: details.toolUses.length,
        toolResultCount: details.toolResults.length,
        eventCount: details.eventCount,
      },
      debugSourceSummary: debugStorageSourceCounts(bundle?.events ?? []),
      commands: details.commandUses.map((tool) => ({
        name: toolName(tool),
        command: commandFromToolUse(tool),
        raw: tool,
      })),
      toolUses: details.toolUses.map((tool) => ({
        name: toolName(tool),
        summary: summarizeToolUse(tool),
        raw: tool,
      })),
      bundleDisplayText: bundle?.displayText ?? null,
      completed: bundle?.completed ?? null,
      eventCount: bundle?.events.length ?? 0,
      events: (bundle?.events ?? []).map((event) => ({
        eventType: event.eventType,
        receivedAt: new Date(event.receivedAt).toISOString(),
        debugStorageSource: debugStorageSource(event),
        payload: event.payload,
      })),
    };
  }

  // handleToggleAssistantProcess, handleToggleSessionUsage, handleViewAssistantUsage,
  // handleViewAssistantDebug, handleCopyAssistantDebug are now handled by useStreamState

  function handlePermissionModeChange(nextMode: PermissionMode) {
    if (!activeProject) {
      return;
    }
    setAgentPermissionMode(activeProject.root, nextMode)
      .then((state) => {
        setPermissionState(state);
      })
      .catch((reason) => {
        setError(String(reason));
      });
  }

  return (
    <main
      className={`app-shell ${activeView === "settings" || activeView === "skills" ? "settings-mode" : activePreview ? "has-preview" : ""}`}
    >
      <aside className="side-panel" aria-label="Project and skills">
        <div className="brand-block">
          <div className="brand-mark">A</div>
          <div>
            <div className="brand-title">InterpressAI</div>
            <div className="brand-version">workspace</div>
          </div>
        </div>

        <section className="workspace-nav">
          {activeRemoteProfile ? (
            <div className="runtime-nav-card" title={runtimeBadgeTitle}>
              <span className="runtime-nav-dot" aria-hidden="true" />
              <span className="runtime-nav-copy">
                <span>Remote</span>
                <strong>Active runtime</strong>
              </span>
            </div>
          ) : null}
          <div
            className={`workspace-active ${activeView === "workspace" ? "active" : ""}`}
          >
            <button
              className="workspace-select"
              type="button"
              onClick={() => {
                setActiveView("workspace");
                setPreviewTabs([]);
                setActivePreviewId(null);
              }}
            >
              <span className="nav-icon plain" aria-hidden="true">▣</span>
              <span className="nav-label">项目</span>
            </button>
            <button
              className="project-add"
              type="button"
              onClick={handleAddProject}
              title="Add project folder"
            >
              +

          {remotePathPrompt !== null && (
            <div className="modal-overlay" onClick={() => { remotePathPromptResolve.current?.(null); setRemotePathPrompt(null); }}>
              <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <h3>Remote Project Path</h3>
                </div>
                <div className="modal-body">
                  <p>{remotePathPrompt}</p>
                  <div className="modal-input-wrap">
                    <input
                      autoFocus
                      className="modal-input"
                      value={remotePathInput}
                      onChange={async (e) => {
                        const value = e.target.value;
                        setRemotePathInput(value);
                        // 清空旧建议
                        setRemotePathSuggestions([]);
                        if (remotePathDebounce.current) clearTimeout(remotePathDebounce.current);
                        if (value.length > 0) {
                          remotePathDebounce.current = setTimeout(async () => {
                            try {
                              const entries = await listProjectEntries(value);
                              const dirs = entries.filter((entry: any) => entry.kind === "directory").map((d: any) => d.path);
                              setRemotePathSuggestions(dirs.slice(0, 8));
                            } catch {}
                          }, 300);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setRemotePathHighlightIndex((prev) =>
                            prev < remotePathSuggestions.length - 1 ? prev + 1 : prev
                          );
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setRemotePathHighlightIndex((prev) => (prev > 0 ? prev - 1 : -1));
                          return;
                        }
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (remotePathHighlightIndex >= 0 && remotePathHighlightIndex < remotePathSuggestions.length) {
                            const selected = remotePathSuggestions[remotePathHighlightIndex];
                            remotePathPromptResolve.current?.(selected);
                          } else {
                            const value = (e.target as HTMLInputElement).value;
                            remotePathPromptResolve.current?.(value);
                          }
                          setRemotePathPrompt(null);
                          setRemotePathInput("");
                          setRemotePathSuggestions([]);
                          setRemotePathHighlightIndex(-1);
                        }
                        if (e.key === "Escape") {
                          remotePathPromptResolve.current?.(null);
                          setRemotePathPrompt(null);
                          setRemotePathInput("");
                          setRemotePathSuggestions([]);
                          setRemotePathHighlightIndex(-1);
                        }
                      }}
                      placeholder="/home/user/project"
                    />
                    {remotePathSuggestions.length > 0 && (
                      <div className="modal-suggestions">
                        {remotePathSuggestions.map((s, i) => (
                          <button
                            key={s}
                            type="button"
                            className={`modal-suggestion-item ${i === remotePathHighlightIndex ? "highlighted" : ""}`}
                            onMouseEnter={() => setRemotePathHighlightIndex(i)}
                            onClick={() => {
                              remotePathPromptResolve.current?.(s);
                              setRemotePathPrompt(null);
                              setRemotePathInput("");
                              setRemotePathSuggestions([]);
                              setRemotePathHighlightIndex(-1);
                            }}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="modal-footer">
                  <button onClick={() => { remotePathPromptResolve.current?.(null); setRemotePathPrompt(null); }}>Cancel</button>
                </div>
              </div>
            </div>
          )}
            </button>
          </div>

          <div className="workspace-tree">
            {projects.map((folder) => {
              const isExpanded = expandedFolders.has(folder.id);
              return (
                <div key={folder.id}>
                  <button
                    className="tree-project"
                    type="button"
                    onClick={() => toggleFolder(folder.id)}
                    onContextMenu={(e) => { e.preventDefault(); setProjectContextMenu({ root: folder.root, x: e.clientX, y: e.clientY }); }}
                  >
                    <span className="nav-icon small plain" aria-hidden="true">
                      {isExpanded ? "▾" : "▸"}
                    </span>
                    <span className="tree-label">{folder.name}</span>
                    <span className="tree-chevron plain" aria-hidden="true">
                      {isExpanded ? "⌄" : "›"}
                    </span>
                  </button>
                  {isExpanded ? (
                    <div className="tree-branch">
                      {folder.sessions.map((session) => {
                        const isMenuOpen =
                          openSessionMenu?.root === folder.root &&
                          openSessionMenu.sessionId === session.id;
                        const isActiveSession = activeSessionId === session.id;
                        const statusTitle =
                          session.processStatus === "active"
                            ? `running${session.processPid ? ` · pid ${session.processPid}` : ""}`
                            : "not running";
                        return (
                          <div
                            key={session.id}
                            className={`tree-session-row ${isActiveSession ? "active" : ""}`}
                          >
                            <button
                              className="tree-session-main"
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                selectSession(folder, session.id);
                              }}
                            >
                              <span
                                className={`session-status-dot ${session.processStatus === "active" ? "active" : "stopped"}`}
                                title={statusTitle}
                                aria-label={statusTitle}
                              />
                              <span
                                className="tree-label"
                                title={session.title}
                              >
                                {session.title}
                              </span>
                            </button>
                            <button
                              className="session-menu-button"
                              type="button"
                              aria-label={`Open menu for ${session.title}`}
                              aria-expanded={isMenuOpen}
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpenSessionMenu((current) =>
                                  current?.root === folder.root &&
                                  current.sessionId === session.id
                                    ? null
                                    : {
                                        root: folder.root,
                                        sessionId: session.id,
                                      },
                                );
                              }}
                            >
                              ...
                            </button>
                            {isMenuOpen ? (
                              <div className="session-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void handleForkSession(folder, session);
                                  }}
                                >
                                  Fork
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void handleHideSession(folder, session);
                                  }}
                                >
                                  删除
                                </button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                      <button
                        className="tree-session create"
                        type="button"
                        onClick={() => handleCreateSession(folder)}
                      >
                        <span className="nav-icon tiny plain" aria-hidden="true">+</span>
                        <span className="tree-label">新建会话</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {projects.length === 0 ? (
              <div className="sidebar-empty">点击 + 添加项目文件夹</div>
            ) : null}
          {projectContextMenu && (
            <>
              <div className="context-menu-backdrop" onClick={() => setProjectContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setProjectContextMenu(null); }} />
              <div className="context-menu" style={{ position: 'fixed', left: projectContextMenu.x, top: projectContextMenu.y, zIndex: 1001 }}>
                <button
                  className="context-menu-item danger"
                  type="button"
                  onClick={() => {
                    const root = projectContextMenu.root;
                    setProjectContextMenu(null);
                    handleDeleteProject(root);
                  }}
                >
                  删除项目
                </button>
              </div>
            </>
          )}
          </div>

          <button
            className={`skills-nav ${activeView === "skills" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("skills");
              setPreviewTabs([]);
              setActivePreviewId(null);
            }}
          >
            <span className="nav-icon plain" aria-hidden="true">✦</span>
            <span>Skills</span>
          </button>

          <button
            className={`skills-nav ${activeView === "mcp" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("mcp");
              setActivePreviewId(null);
            }}
          >
            <span className="mcp-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" role="img">
                <path d="M7 7.5h10M7 12h10M7 16.5h10" />
                <rect x="4" y="4" width="16" height="16" rx="3.5" />
              </svg>
            </span>
            <span>MCP Servers</span>
          </button>
        </section>

        <div className="sidebar-footer">
          <button
            className={`sidebar-action ${activeView === "terminal" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("terminal");
              setPreviewTabs([]);
              setActivePreviewId(null);
            }}
          >
            <span className="nav-icon small plain" aria-hidden="true">⌘</span>
            <span>Terminal</span>
          </button>
          <button
            className={`sidebar-action ${activeView === "settings" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("settings");
              setPreviewTabs([]);
              setActivePreviewId(null);
            }}
          >
            <span className="nav-icon small plain" aria-hidden="true">⚙</span>
            <span>Settings</span>
          </button>
        </div>
      </aside>
      {activeView === "terminal" ? (
        activeRemoteProfile ? (
          <RemoteTerminalPlaceholder onClose={() => setActiveView("workspace")} />
        ) : (
          <TerminalView onClose={() => setActiveView("workspace")} />
        )
      ) : activeView === "skills" ? (
        <SkillsView activeProject={activeProject ?? undefined} />
      ) : activeView === "mcp" ? (
        <McpServersView />
      ) : activeView === "settings" ? (
        <SettingsView
          hiddenSessions={hiddenSessions}
          onRestoreSession={handleRestoreHiddenSession}
        />
      ) : (
        <section className="exploration-panel" aria-label="Exploration stream">
          <header className="workspace-header">
            <div className="session-title-area">
              <div className="session-title">
                <span className="header-icon" aria-hidden="true">
                  chat
                </span>
                <h1>{activeSessionTitle}</h1>
              </div>
              <button
                className={`debug-toggle ${isDebugOpen ? "active" : ""}`}
                type="button"
                onClick={handleToggleSessionUsage}
                disabled={!activeSessionId}
              >
                Usage <span>{sessionUsageSnapshotsForSession(streamUsageByBundleKey, activeSessionId).length}</span>
              </button>
            </div>
            <input
              className="session-search"
              placeholder="Search session content..."
              aria-label="Search session content"
            />
          </header>

          {copyToast ? (
            <div className="copy-toast" role="status">
              {copyToast}
            </div>
          ) : null}

          {openAssistantUsageMessageId && activeSessionId ? (
            <AssistantUsageMiniOverlay
              bundleId={openAssistantUsageMessageId}
              snapshot={
                streamUsageByBundleKey[
                  bundleUsageStorageKey(activeSessionId, openAssistantUsageMessageId)
                ] ?? null
              }
              onClose={() => setOpenAssistantUsageMessageId(null)}
            />
          ) : null}

          {activeSessionId && isDebugOpen ? (
            <div
              className="usage-overlay-backdrop"
              role="presentation"
              onClick={() => setIsDebugOpen(false)}
            >
              <section
                className="debug-panel usage-overlay-panel"
                aria-label="Usage metrics"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  className="usage-overlay-close"
                  type="button"
                  onClick={() => setIsDebugOpen(false)}
                  aria-label="Close usage panel"
                >
                  ×
                </button>
                <SessionUsageDashboard
                  activeSessionId={activeSessionId}
                  usageByKey={streamUsageByBundleKey}
                />
              </section>
            </div>
          ) : null}

          {error ? <div className="error-banner">{error}</div> : null}

          <div className="stream">
            {!activeSessionId ? (
              <div className="empty-chat-state">
                <strong>未选择会话</strong>
                <span>请先在左侧添加项目文件夹，然后创建或选择一个会话。</span>
              </div>
            ) : null}
            {activeSessionId
              ? streamItems.map((item) => {
                  if (item.kind === "message") {
                    if (item.role !== "assistant" && item.role !== "user") {
                      return null;
                    }
                    const assistantDebugBundle =
                      item.role === "assistant"
                        ? assistantDebugBundles[item.id]
                        : null;
                    const assistantLiveUsage =
                      item.role === "assistant"
                        ? streamUsageByBundleKey[bundleUsageStorageKey(activeSessionId, item.id)]
                        : null;
                    const isAssistantDebugOpen =
                      item.role === "assistant" &&
                      openAssistantDebugMessageId === item.id;
                    const assistantDebugJson = isAssistantDebugOpen
                      ? JSON.stringify(assistantDebugPayload(item, "view"), null, 2)
                      : "";
                    const assistantDetails =
                      item.role === "assistant"
                        ? assistantTurnDetails(item, assistantDebugBundle)
                        : null;
                    const isProcessOpen =
                      item.role === "assistant" && openProcessMessageIds.has(item.id);
                    const hasProcessDetails = Boolean(
                      assistantDetails &&
                        (assistantDetails.progressLines.length > 0 ||
                          assistantDetails.toolUses.length > 0 ||
                          assistantDetails.toolResults.length > 0 ||
                          assistantDetails.eventCount > 0 ||
                          item.status === "streaming"),
                    );
                    const assistantDisplayText =
                      item.role === "assistant" &&
                      item.status === "streaming" &&
                      item.text === pendingAssistantText
                        ? "正在等待最终回答…"
                        : item.text;
                    const messageDisplayText =
                      item.role === "user" ? displayPromptText(item.text) : assistantDisplayText;
                    const userFileReferences =
                      item.role === "user"
                        ? item.fileReferences?.length
                          ? item.fileReferences
                          : localFileReferencesFromPromptText(item.text)
                        : [];
                    return (
                      <article
                        className={`stream-message ${item.role}`}
                        key={item.id}
                      >
                        <div className="message-avatar" aria-hidden="true">
                          {item.role === "user" ? "person" : "spark"}
                        </div>
                        <div className="message-body">
                          <div className="stream-label-row">
                            <div className="stream-label">
                              {displayRole(item.role)}
                            </div>
                            {item.role === "assistant" ? (
                              <>
                              <button
                                className={`message-debug-button ${copiedDebugMessageId === item.id ? "copied" : ""} ${isAssistantDebugOpen ? "active" : ""}`}
                                type="button"
                                onClick={() => handleViewAssistantDebug(item.id)}
                                onDoubleClick={() => handleCopyAssistantDebug(item)}
                                title="单击查看本条 Debug，双击复制 Debug JSON"
                              >
                                {copiedDebugMessageId === item.id
                                  ? "已复制"
                                  : `Debug${assistantDebugBundle?.events.length ? ` ${assistantDebugBundle.events.length}` : ""}`}
                              </button>
                              <button
                                className="message-debug-button"
                                type="button"
                                onClick={() => handleViewAssistantUsage(item.id)}
                                title="查看 Usage"
                              >
                                <span>{bundleUsageButtonLabel(assistantLiveUsage)}</span>
                              </button>
                              <button
                                className="message-debug-button"
                                type="button"
                                onClick={() => agentTurn.handleForkFromMessage(item)}
                                disabled={Boolean(
                                  !item.checkpointUuid ||
                                  isRunningTurn ||
                                  Boolean(forkingMessageId) ||
                                  pendingPermission ||
                                  isResolvingFileReferences
                                )}
                                title={
                                  item.checkpointUuid
                                    ? "点击将从此消息位置fork一个新会话"
                                    : "这条消息缺少 jsonl uuid，不能作为 fork checkpoint"
                                }
                              >
                                {forkingMessageId === item.id ? (
                                  <>
                                    <span className="message-fork-spinner" aria-hidden="true" />
                                    <span>Forking…</span>
                                  </>
                                ) : (
                                  "Fork"
                                )}
                              </button>
                              {(() => {
                                const outputDateTime = assistantUsageOutputDateTimeFromBundle(assistantDebugBundle);
                                return outputDateTime ? (
                                  <span
                                    className="message-output-time"
                                    title={assistantUsageButtonTitle(assistantDebugBundle)}
                                  >
                                    {outputDateTime}
                                  </span>
                                ) : null;
                              })()}
                              </>
                            ) : null}
                          </div>
                          {item.role === "assistant" &&
                          assistantDetails &&
                          hasProcessDetails ? (
                            <div className="message-process-section">
                              <button
                                className="message-process-toggle"
                                type="button"
                                onClick={() => handleToggleAssistantProcess(item.id)}
                              >
                                <span>{isProcessOpen ? "过程 ˅" : "过程 >>"}</span>
                                <small>
                                  {compactCountLabel(
                                    assistantDetails.progressLines.length,
                                    "行过程",
                                    "行过程",
                                  )}
                                  {" · "}
                                  {compactCountLabel(
                                    assistantDetails.commandUses.length,
                                    "command",
                                  )}
                                  {" · "}
                                  {compactCountLabel(
                                    assistantDetails.toolUses.length,
                                    "tool call",
                                  )}
                                  {" · "}
                                  {compactCountLabel(
                                    assistantDetails.toolResults.length,
                                    "tool result",
                                  )}
                                  {" · "}
                                  {compactCountLabel(
                                    assistantDetails.eventCount,
                                    "debug event",
                                  )}
                                </small>
                              </button>
                              {isProcessOpen ? (
                                <div className="message-process-detail">
                                  {assistantDetails.timeline.length > 0 ? (
                                    <section>
                                      <div className="message-section-label">时间线</div>
                                      <ol className="message-process-timeline">
                                        {assistantDetails.timeline.map((entry) => (
                                          <li
                                            className={`process-timeline-item ${entry.kind}`}
                                            key={entry.id}
                                          >
                                            <div className="process-timeline-marker" aria-hidden="true" />
                                            <div className="process-timeline-content">
                                              <div className="process-timeline-title-row">
                                                <strong>{entry.title}</strong>
                                                <span>{formatDebugTime(entry.receivedAt)}</span>
                                              </div>
                                              {entry.kind === "tool_call" ? (
                                                <code>{entry.detail}</code>
                                              ) : entry.kind === "tool_result" ? (
                                                <pre>{entry.detail}</pre>
                                              ) : entry.kind === "permission" ? (
                                                <p>{entry.detail}</p>
                                              ) : (
                                                <pre>{entry.detail}</pre>
                                              )}
                                            </div>
                                          </li>
                                        ))}
                                      </ol>
                                    </section>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          <div
                            className={`message-bubble ${
                              item.role === "assistant" && item.status === "streaming"
                                ? "streaming"
                                : ""
                            }`}
                          >
                            {item.role === "assistant" ? (
                              <div className="message-section-label">
                                {item.status === "streaming" ? "等待最终回答" : "最终回答"}
                              </div>
                            ) : null}
                            <RichMarkdownMessage content={messageDisplayText} />
                            {item.role === "user" && userFileReferences.length > 0 ? (
                              <div className="message-file-references" aria-label="Referenced files sent to Claude Code">
                                {userFileReferences.map((reference) => (
                                  <button
                                    className={`message-file-reference-chip ${reference.failed ? "failed" : ""}`}
                                    key={reference.path}
                                    title={reference.path}
                                    type="button"
                                    onClick={() => void handleOpenPreviewLink(localFileReferenceSummaryToStreamLink(reference))}
                                    disabled={Boolean(reference.failed)}
                                  >
                                    <span className="message-file-reference-icon" aria-hidden="true">@</span>
                                    <span className="message-file-reference-name">
                                      {reference.name || localFileReferenceName(reference.path)}
                                    </span>
                                    <span className="message-file-reference-meta">
                                      {reference.failed
                                        ? "读取失败"
                                        : `${formatFileSize(reference.size_bytes)} · 注入 ${formatFileSize(reference.injected_bytes)}`}
                                      {reference.truncated ? " · 已截断" : ""}
                                    </span>
                                    <span className="message-file-reference-open">右侧预览</span>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            <MessageImagePreviews root={activeProject?.root ?? ""} links={item.links} onOpen={handleOpenPreviewLink} />
                            {item.links?.length ? (
                              <div className="message-links local-reference-links">
                                {item.links.map((link) => (
                                  <button
                                    key={link.id}
                                    type="button"
                                    onClick={() => handleOpenPreviewLink(link)}
                                  >
                                    <span>{link.kind}</span>
                                    <strong>{link.label}</strong>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          {isAssistantDebugOpen ? (
                            <div className="message-debug-panel">
                              <div className="message-debug-panel-header">
                                <span>
                                  本条 AI 回复 Debug
                                  {assistantDebugBundle?.events.length
                                    ? ` · ${assistantDebugBundle.events.length} events`
                                    : " · 0 events"}
                                  {assistantDebugBundle?.events.length
                                    ? ` · ${debugStorageSourceSummary(assistantDebugBundle.events)}`
                                    : ""}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleCopyAssistantDebug(item)}
                                >
                                  复制
                                </button>
                              </div>
                              <pre>{assistantDebugJson}</pre>
                            </div>
                          ) : null}
                        </div>
                      </article>
                    );
                  }

                  if (item.kind === "system") {
                    return (
                      <article
                        className={`system-event ${item.subtype}`}
                        key={item.id}
                      >
                        <div className="stream-label">{item.title}</div>
                        <pre>{item.detail}</pre>
                      </article>
                    );
                  }

                  if (item.kind === "tool") {
                    return (
                      <article
                        className={`tool-event ${item.status}`}
                        key={item.id}
                      >
                        <div className="stream-label">{item.title}</div>
                        <p>{item.detail}</p>
                      </article>
                    );
                  }

                  const artifactPath = item.path;

                  return (
                    <article className="artifact-event" key={item.id}>
                      <div className="stream-label">{item.artifactKind}</div>
                      <h2>{item.title}</h2>
                      {item.artifactKind === "table" ? (
                        <MarkdownTablePreview content={item.preview} />
                      ) : item.artifactKind === "diff" ? (
                        <pre className="diff-view">{item.preview}</pre>
                      ) : (
                        <p>{item.preview}</p>
                      )}
                      {artifactPath ? (
                        <div className="message-links local-reference-links">
                          <button
                            type="button"
                            onClick={() =>
                              handleOpenPreviewLink({
                                id: `artifact:${artifactPath}`,
                                label: item.title,
                                kind:
                                  item.artifactKind === "markdown"
                                    ? "markdown"
                                    : item.artifactKind === "file"
                                      ? "file"
                                      : "report",
                                path: artifactPath,
                              })
                            }
                          >
                            <span>{item.artifactKind}</span>
                            <strong>Open preview</strong>
                          </button>
                        </div>
                      ) : null}
                    </article>
                  );
                })
              : null}
          </div>

          <PromptInputArea
            activeProject={!!activeProject}
            activeSessionId={activeSessionId}
            isRunningTurn={isRunningTurn}
            pendingPermission={pendingPermission}
            isInterruptingTurn={isInterruptingTurn}
            isResolvingFileReferences={isResolvingFileReferences}
            permissionState={permissionState}
            onPermissionModeChange={(mode) => handlePermissionModeChange(mode as any)}
            selectedChatModel={selectedChatModel}
            chatModelOptions={chatModelOptions}
            onChatModelChange={setSelectedChatModel}
            contextUsageError={contextUsageError}
            activeContextUsage={activeContextUsage}
            contextUsageLabel={contextUsageLabel}
            prompt={prompt}
            onPromptChange={handlePromptChange}
            onPromptKeyDown={handlePromptKeyDown}
            onSubmit={handlePromptSubmit}
            canSendPrompt={canSendPrompt}
            onInterruptTurn={agentTurn.handleInterruptTurn}
            textareaRef={textareaRef as React.RefObject<HTMLTextAreaElement>}
            promptHighlightRef={promptHighlightRef as React.RefObject<HTMLDivElement>}
            renderPromptHighlightedText={renderPromptHighlightedText}
            promptImeStateRef={promptImeStateRef}
            markPromptImeActive={markPromptImeActive}
            fileReferences={fileReferences}
            onRemoveFileReference={removeFileReference}
            onOpenPreviewLink={handleOpenPreviewLink}
            fileMention={fileMention}
            fileSuggestions={fileSuggestions}
            fileSuggestionIndex={fileSuggestionIndex}
            isSearchingFiles={isSearchingFiles}
            onSelectFileSuggestion={selectFileSuggestion}
            onUpdateFileMentionFromInput={updateFileMentionFromInput}
            onUpdateSlashCommandMenuFromInput={updateSlashCommandMenuFromInput}
            slashCommandMenu={slashCommandMenu}
            slashRootOptions={slashRootOptions}
            slashLeafOptions={slashLeafOptions}
            slashLeafTitle={slashLeafTitle}
            slashLeafDescription={slashLeafDescription}
            slashLeafEmptyText={slashLeafEmptyText}
            onSetSlashCommandMenu={onSetSlashCommandMenu}
            onSelectSlashRootItem={selectSlashRootItem}
            onSelectSlashItem={selectSlashItem}
            onPermissionAllow={() => agentTurn.handlePermissionDecision(true)}
            onPermissionDeny={() => agentTurn.handlePermissionDecision(false)}
          />
        </section>
      )}

      {activeView === "workspace" && activePreview ? (
        <PreviewPanel
          activePreview={activePreview}
          previewTabs={previewTabs}
          activeProject={activeProject}
          onSetActivePreviewId={setActivePreviewId}
          onClosePreviewTab={closePreviewTab}
          onCloseAllPreviews={() => setPreviewTabs([])}
          onOpenPreviewLink={handleOpenPreviewLink}
        />
      ) : null}
    </main>
  );
}
