import type {AgentReplStreamEvent} from "../../types";
import {isRecord} from "../file-utils";

// ── Types ──────────────────────────────────────────────────────────────

export type SessionItemsData = {
  runningResponse: string;
};

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Extract the text content of the assistant message from raw_json.
 * Only blocks where content[].type === "text" are extracted; other types are skipped.
 */
function extractAssistantText(rawJson: unknown): string | null {
  if (!isRecord(rawJson)) return null;
  if (rawJson.type !== "assistant") return null;

  const message = rawJson.message;
  if (!isRecord(message)) return null;
  if (message.role !== "assistant") return null;

  const content = message.content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }

  return parts.length > 0 ? parts.join("") : null;
}

// ── Handler ────────────────────────────────────────────────────────────

export function handleSessionItemsEvent(
  event: AgentReplStreamEvent,
  prevData: SessionItemsData | null,
): SessionItemsData | null {
  // Only process turn_text events
  if (event.eventType !== "turn_text") return null;

  const text = extractAssistantText(event.payload.raw_json);
  if (text === null) return null;

  // Dedupe: if identical to the last value, don't trigger an update
  if (prevData?.runningResponse === text) return null;

  return { runningResponse: text };
}
