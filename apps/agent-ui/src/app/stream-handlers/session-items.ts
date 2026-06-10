import type {AgentReplStreamEvent} from "../../types";
import {isRecord} from "../file-utils";

// ── Types ──────────────────────────────────────────────────────────────

export type SessionItemsData = {
  runningResponse: string;
};

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * 从 raw_json 中提取 assistant 消息的文本内容。
 * 只提取 content[].type === "text" 的块，其他类型跳过。
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
  // 只处理 turn_text 事件
  if (event.eventType !== "turn_text") return null;

  const text = extractAssistantText(event.payload.raw_json);
  if (text === null) return null;

  // 去重：跟上次一样就不触发更新
  if (prevData?.runningResponse === text) return null;

  return { runningResponse: text };
}
