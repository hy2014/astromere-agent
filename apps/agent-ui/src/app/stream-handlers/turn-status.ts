import type { AgentReplStreamEvent } from "../../types";

// ── Types ──────────────────────────────────────────────────────────────

export type TurnStatus = "idle" | "running" | "interrupt" | "ctrl_block" | "forking";

export type SessionStatusData = {
  turnStatus: TurnStatus;
};

// ── Handler ────────────────────────────────────────────────────────────

/**
 * session-status handler: 管理 turn 状态机。
 *
 * 状态流转：
 *   submit prompt ─────────→ "running"
 *                              ├── permission/control_request → "ctrl_block"
 *                              │     └── 用户确认 → "running"（UI 侧设）
 *                              ├── interrupt 事件 → "idle"
 *                              └── turn_complete / error → "idle"
 *   click STOP ─────────────→ "interrupt"（UI 侧设）
 *                              └── interrupt 事件 → "idle"
 *   click Fork ─────────────→ "forking"（UI 侧设，用户点击 Fork 按钮到新 session 创建完成之间）
 *                              └── fork 完成/失败 → "idle"
 *
 * handler 只处理流事件。UI 操作（submit/interrupt/fork/确认权限）由 View 层通过 WriteState 直接设置。
 */
export function handleSessionStatusEvent(
  event: AgentReplStreamEvent,
  prevData: unknown,
): SessionStatusData | null {
  const prev = prevData as SessionStatusData | null;
  const { eventType } = event;

  // permission_request / control_request → ctrl_block
  if (eventType === "permission_request" || eventType === "control_request") {
    if (prev?.turnStatus === "ctrl_block") return null;
    return { turnStatus: "ctrl_block" };
  }

  // turn_complete / error / interrupt / process_exit → idle
  if (
    eventType === "turn_complete" ||
    eventType === "error" ||
    eventType === "interrupt" ||
    eventType === "process_exit"
  ) {
    if (prev?.turnStatus === "idle") return null;
    return { turnStatus: "idle" };
  }

  // stderr with error/failed → idle
  if (eventType === "stderr") {
    const detail = String(event.payload?.text ?? event.payload?.message ?? "").toLowerCase();
    if (detail.includes("error") || detail.includes("failed") || detail.includes("missing_credentials")) {
      if (prev?.turnStatus === "idle") return null;
      return { turnStatus: "idle" };
    }
  }

  return null;
}
