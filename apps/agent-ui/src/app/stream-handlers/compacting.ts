import type { AgentReplStreamEvent } from "../../types";

export function handleCompactingEvent(
  event: AgentReplStreamEvent,
  _prevData: unknown,
): boolean {
  if (event.eventType !== "system") return false;
  const payload = event.payload as Record<string, unknown>;
  if (payload.subtype !== "status" || !("status" in payload)) return false;
  return payload.status === "compacting";
}
