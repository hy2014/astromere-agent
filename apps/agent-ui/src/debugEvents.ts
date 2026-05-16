import { loadDebugEventRows } from "./tauri";

export type DebugEventPayload = any;
export type PersistedDebugEventRow = any;

export async function loadDebugEventsFromSqlite(args: {
  sessionId?: string;
  assistantMessageId?: string;
  limit?: number;
}): Promise<any[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 2000, 10000));

  return loadDebugEventRows({
    assistantMessageId: args.assistantMessageId,
    sessionId: args.sessionId,
    limit,
  }) as Promise<any[]>;
}

