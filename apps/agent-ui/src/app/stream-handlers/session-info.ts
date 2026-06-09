import type {AgentReplStreamEvent} from "../../types";
import {isRecord, modelCallIdFromRawJson} from "../file-utils";

// ── Types ──────────────────────────────────────────────────────────────

export type SessionInfoData = {
  currentBundleId: string | null;
  bundles: Record<string, string[]>;
};

// ── Helpers (对齐 stream-processor.ts) ─────────────────────────────────

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

function modelCallIdFromEvent(event: AgentReplStreamEvent): string | null {
  return modelCallIdFromRawJson(event.payload.raw_json);
}

// ── Handler ────────────────────────────────────────────────────────────

export function handleSessionInfoEvent(
  event: AgentReplStreamEvent,
  prevData: SessionInfoData | null,
): SessionInfoData | null {
  const prevBundleId = prevData?.currentBundleId ?? null;
  const prevBundles = prevData?.bundles ?? {};
  let changed = false;

  let bundleId = prevBundleId;
  const modelCallId = modelCallIdFromEvent(event);

  // 新 bundle 开始
  if (isAssistantBundleStartEvent(event) && modelCallId) {
    if (!bundleId || bundleId.startsWith("assistant-pending-")) {
      bundleId = modelCallId;
      changed = true;
    }
  }

  // bundle 完成
  const completesBundle = isBundleCompletionEvent(event);
  if (completesBundle) {
    bundleId = null;
    changed = true;
  }

  if (!changed) return null;

  return {
    currentBundleId: bundleId,
    bundles: prevBundles,
  };
}
