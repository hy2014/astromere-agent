import type {AgentReplStreamEvent} from "../../types";

// ── Types ──────────────────────────────────────────────────────────────

export type TurnStatus = "idle" | "running" | "interrupt" | "ctrl_block" | "forking";

export type SessionStatusData = {
  turnStatus: TurnStatus;
};

// ── Handler ────────────────────────────────────────────────────────────

/**
 * session-status handler: manages the turn state machine.
 *
 * State transitions:
 *   submit prompt ─────────→ "running"
 *                              ├── permission/control_request → "ctrl_block"
 *                              │     └── user confirms → "running" (set on UI side)
 *                              ├── interrupt event → "idle"
 *                              └── turn_complete / error → "idle"
 *   click STOP ─────────────→ "interrupt" (set on UI side)
 *                              └── interrupt event → "idle"
 *   click Fork ─────────────→ "forking" (set on UI side, between the user clicking Fork and the new session finishing creation)
 *                              └── fork completes/fails → "idle"
 *
 * The handler only processes stream events. UI actions (submit/interrupt/fork/confirm permission)
 * are set directly by the View layer via WriteState.
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

  // turn_complete / error / interrupt / process_exit → always idle
  // Don't check prev, because prev may be polluted by stale data left by unrelated events (e.g. startup)
  if (
    eventType === "turn_complete" ||
    eventType === "error" ||
    eventType === "interrupt" ||
    eventType === "process_exit"
  ) {
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
