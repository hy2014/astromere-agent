import type { HiddenSession, ProjectSession } from "./types";
import { hiddenSessionsStorageKey, createPendingSession, sessionKey } from "./file-utils";
import { getActiveRemoteProfileId, loadRemoteProfiles } from "../runtime";

export function getActiveRemoteProfileBaseUrl(): string | null {
  const profile = loadActiveRemoteProfileSnapshot();
  return profile?.baseUrl ?? null;
}

export async function clientDebugLog(level: string, message: string, data?: any) {
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

export function loadActiveRemoteProfileSnapshot(): import("../runtime").RemoteProfile | null {
  try {
    const activeProfileId = getActiveRemoteProfileId();
    if (!activeProfileId) return null;
    return loadRemoteProfiles().find((profile) => profile.id === activeProfileId) ?? null;
  } catch {
    return null;
  }
}

export function loadHiddenSessions(): HiddenSession[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const value = window.localStorage.getItem(hiddenSessionsStorageKey);
    if (!value) {
      return [];
    }
    const parsed = JSON.parse(value) as HiddenSession[];
    return Array.isArray(parsed)
      ? parsed.filter(
          (item) =>
            typeof item?.root === "string" &&
            typeof item?.sessionId === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function uniqueHiddenSessions(sessions: HiddenSession[]): HiddenSession[] {
  const seen = new Set<string>();
  const unique: HiddenSession[] = [];
  for (const session of sessions) {
    const key = sessionKey(session.root, session.sessionId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(session);
  }
  return unique;
}

export function isHiddenSession(
  hiddenSessions: HiddenSession[],
  root: string,
  sessionId: string,
): boolean {
  const key = sessionKey(root, sessionId);
  return hiddenSessions.some(
    (session) => sessionKey(session.root, session.sessionId) === key,
  );
}

export function sessionsFromRuntimeSummaries(
  root: string,
  sessions: Array<{ id: string; title?: string }>,
  hiddenSessions: HiddenSession[],
): { sessions: ProjectSession[]; worktreeSessions: ProjectSession[] } {
  const visibleSessions = sessions.filter(
    (session) => !isHiddenSession(hiddenSessions, root, session.id),
  );

  console.log("[sessionsFromRuntimeSummaries]", JSON.stringify({ root, sessions: visibleSessions.map(s => ({ id: s.id, title: s.title })) }));

  return {
    sessions: visibleSessions.length > 0
      ? visibleSessions.map((session, index) => ({
          id: session.id,
          title: session.title || `会话${index + 1}`,
          processStatus: "stopped" as const,
        }))
      : [createPendingSession()],
    worktreeSessions: [] as ProjectSession[],
  };
}

export function dedupeSessions(sessions: ProjectSession[]): ProjectSession[] {
  const seen = new Set<string>();
  const result: ProjectSession[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) {
      continue;
    }
    seen.add(session.id);
    result.push(session);
  }
  return result;
}
