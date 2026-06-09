import type { AgentReplStreamEvent } from "../../types";
import {
  permissionToolNameFromEvent,
  permissionRequestIdFromEvent,
  permissionInputFromEvent,
} from "../file-utils";

export type PendingPermission = {
  root: string;
  sessionId: string;
  messageId: string;
  requestId: string;
  prompt: string;
  toolName: string;
  input: unknown;
  rawJson: unknown;
  isQuestion: boolean;
  questions?: any[];
};

export type ControlRequestData = {
  permission: PendingPermission | null;
};

const CLEAR_EVENTS = new Set([
  "turn_complete",
  "error",
  "interrupt",
  "process_exit",
  "stderr",
]);

export function handleControlRequestEvent(
  event: AgentReplStreamEvent,
  _prevData: unknown,
): ControlRequestData | null {
  const prev = _prevData as ControlRequestData | null;
  // 清除权限：这些事件到来时，清空 pending permission
  if (CLEAR_EVENTS.has(event.eventType)) {
    const prevPerm = prev?.permission ?? null;
    return prevPerm === null ? null : { permission: null };
  }

  // 只处理 permission_request / control_request
  if (event.eventType !== "permission_request" && event.eventType !== "control_request") {
    return null;
  }

  const toolName = permissionToolNameFromEvent(event);
  const requestId = permissionRequestIdFromEvent(event);
  if (!requestId) return null;

  const permInput = permissionInputFromEvent(event);
  const promptText = String(event.payload.prompt ?? `${toolName} requests permission`);
  const isQuestion = toolName === "AskUserQuestion";
  let questions: any[] | undefined;
  if (isQuestion && permInput && typeof permInput === "object") {
    const raw = permInput as Record<string, unknown>;
    if (Array.isArray(raw.questions)) questions = raw.questions;
  }

  const permission: PendingPermission = {
    root: event.root,
    sessionId: event.sessionId,
    messageId: `permission:${event.sessionId}:${requestId}`,
    requestId,
    prompt: promptText,
    toolName,
    input: permInput,
    rawJson: event.payload.raw_json ?? event.payload,
    isQuestion,
    questions,
  };

  return { permission };
}
