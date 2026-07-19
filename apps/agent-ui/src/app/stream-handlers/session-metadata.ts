import type {AgentReplStreamEvent} from "../../types";

export type SessionMetadataEvent = {
  processStatus?: "active" | "stopped";
  processPid?: number;
};

export function handleSessionMetadataEvent(
  event: AgentReplStreamEvent,
  _prevData: unknown,
): SessionMetadataEvent {
  // startup / process_status → update process status and pid
  if (event.eventType === "startup" || event.eventType === "process_status") {
    const running = event.eventType === "startup" ? true : event.payload.running === true;
    return {
      processStatus: running ? "active" : "stopped",
      processPid: typeof event.payload.pid === "number" ? event.payload.pid : undefined,
    };
  }

  // process_exit → mark as stopped
  if (event.eventType === "process_exit") {
    return { processStatus: "stopped" };
  }

  // stderr "repl process stdout closed" → mark as stopped
  if (event.eventType === "stderr") {
    const detail = String(event.payload?.text ?? event.payload?.message ?? "").toLowerCase();
    if (detail.includes("repl process stdout closed")) {
      return { processStatus: "stopped" };
    }
  }

  // Other events → no change
  return {};
}
