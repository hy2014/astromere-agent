import type { StreamItem } from "../types";
import type {
  ProjectSession,
  HiddenSession,
} from "./types";

export const hiddenSessionsStorageKey = "agent-ui.hiddenSessions.v1";

export function projectIdFromRoot(root: string): string {
  return `project:${root}`;
}

export function isNewSessionId(sessionId: string): boolean {
  return sessionId.startsWith("new-") || sessionId.startsWith("pending-");
}

export function createClaudeSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function createPendingSession(): ProjectSession {
  return {
    id: createClaudeSessionId(),
    title: "新会话",
    isPending: true,
    processStatus: "stopped",
  };
}

export function sessionKey(root: string, sessionId: string): string {
  return `${root}\n${sessionId}`;
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
): ProjectSession[] {
  const visibleSessions = sessions.filter(
    (session) => !isHiddenSession(hiddenSessions, root, session.id),
  );

  return visibleSessions.length > 0
    ? visibleSessions.map((session, index) => ({
        id: session.id,
        title: session.title || `会话${index + 1}`,
        processStatus: "stopped" as const,
      }))
    : [createPendingSession()];
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

export function truncateSessionTitle(value: string, maxLength = 80): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized || "新会话";
  }
  return `${normalized.slice(0, maxLength)}…`;
}

export function firstUserTitleFromStream(items: StreamItem[]): string | null {
  const userMessage = items.find(
    (item) => item.kind === "message" && item.role === "user",
  );
  return userMessage?.kind === "message"
    ? truncateSessionTitle(userMessage.text)
    : null;
}

export function welcomeStream(
  _projectName: string,
  _sessionTitle: string,
): StreamItem[] {
  return [];
}
