import { useState, useCallback } from "react";
import type { StreamItem } from "../types";
import type {
  ProjectFolder,
  LocalFileReference,
} from "../app/types";
import type { WorkspaceFileReference } from "../types";
import type { BundleUsageSnapshot, BundleUsageTotals } from "../tauri";
import {
  ensureAgentReplProcess,
  sendAgentReplInput,
  forkAgentReplProcess,
  interruptAgentTurn,
  respondAgentPermission,
  loadTypedRuntimeSession,
  readLocalReferenceFile,
} from "../runtime";
import { runtimeSessionToArtifacts } from "../app/debug-utils";
import type { AgentPermissionState } from "../types";

// --- Types ---

export type PendingPermission = {
  root: string;
  sessionId: string;
  messageId: string;
  requestId: string;
  prompt: string;
  toolName?: string;
  input?: unknown;
  rawJson?: unknown;
  isQuestion?: boolean;
  questions?: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

interface AgentTurnDeps {
  activeProject: ProjectFolder | null;
  activeSessionId: string | null;
  selectedChatModel: string;
  permissionState: AgentPermissionState | null;
  prompt: string;
  fileReferences: LocalFileReference[];
  // Stream state callbacks
  updateSessionStream: (
    sessionId: string,
    updater: (items: StreamItem[]) => StreamItem[],
  ) => void;
  setAssistantDebugBundles: (
    updater: (
      bundles: Record<string, import("../app/types").AssistantMessageDebugBundle>,
    ) => Record<string, import("../app/types").AssistantMessageDebugBundle>,
  ) => void;
  refreshSessionContextUsage: (
    root: string,
    sessionId: string,
  ) => Promise<void>;
  currentBundleBySessionRef: React.MutableRefObject<
    Record<string, string | null>
  >;
  // Project mutation (from App level)
  setProjects: (
    updater: (folders: ProjectFolder[]) => ProjectFolder[],
  ) => void;
  setPrompt: (value: string) => void;
  setFileReferences: (updater: (current: LocalFileReference[]) => LocalFileReference[]) => void;
  closeFileSuggestions: () => void;
  setError: (error: string | null) => void;
}

// --- Inline helpers (from App.tsx, used only in this hook) ---

function truncateSessionTitle(value: string, maxLength = 80): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized || "新会话";
  }
  return `${normalized.slice(0, maxLength)}…`;
}

function createClaudeSessionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
    /[xy]/g,
    (char) => {
      const random = Math.floor(Math.random() * 16);
      const value = char === "x" ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    },
  );
}

function isNewSessionId(sessionId: string): boolean {
  return sessionId.startsWith("new-") || sessionId.startsWith("pending-");
}

async function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => resolve()),
    );
  });
}

async function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function loadTypedRuntimeSessionWithRetry(
  loadTypedRuntimeSessionFn: typeof loadTypedRuntimeSession,
  root: string,
  reference: string,
  attempts = 12,
): Promise<ReturnType<typeof loadTypedRuntimeSession>> {
  let lastError: unknown = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await loadTypedRuntimeSessionFn(root, reference);
    } catch (reason) {
      lastError = reason;
      await waitMs(150);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}

function localFileReferenceName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || normalized || "file";
}

function sanitizeFenceContent(content: string): string {
  return content.replace(/```/g, "`\u200b``");
}

function languageFence(language: string, path: string): string {
  const normalized = language.trim() || path.split(".").pop() || "text";
  return normalized.replace(/[^a-zA-Z0-9_-]/g, "") || "text";
}

function formatFileSize(bytes?: number | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const maxReferencedFileBytes = 48 * 1024;
const maxReferencedFilesTotalBytes = 160 * 1024;

async function buildPromptWithLocalFileReferences(
  readLocalReferenceFileFn: typeof readLocalReferenceFile,
  root: string,
  userPrompt: string,
  references: LocalFileReference[],
): Promise<{
  prompt: string;
  fileReferences: import("../types").LocalFileReferenceSummary[];
}> {
  const uniqueReferences = Array.from(
    new Map(
      references.map((reference) => [reference.path, reference]),
    ).values(),
  );

  if (uniqueReferences.length === 0) {
    return { prompt: userPrompt, fileReferences: [] };
  }

  const blocks: string[] = [];
  const fileSummaries: import("../types").LocalFileReferenceSummary[] = [];
  let totalBytes = 0;

  for (const reference of uniqueReferences) {
    if (totalBytes >= maxReferencedFilesTotalBytes) {
      blocks.push(
        `### ${reference.path}\nSkipped: total referenced file content limit reached.`,
      );
      fileSummaries.push({
        path: reference.path,
        name: reference.name || localFileReferenceName(reference.path),
        language: reference.extension ?? undefined,
        size_bytes: reference.size_bytes ?? null,
        injected_bytes: 0,
        truncated: true,
        failed: true,
        error: "total referenced file content limit reached",
      });
      continue;
    }

    try {
      const file = await readLocalReferenceFileFn(root, reference.path);
      const availableBytes = Math.max(
        0,
        maxReferencedFilesTotalBytes - totalBytes,
      );
      const maxBytes = Math.min(maxReferencedFileBytes, availableBytes);
      const encoded = new TextEncoder().encode(file.content);
      const truncated = encoded.length > maxBytes;
      const content = truncated
        ? new TextDecoder().decode(encoded.slice(0, maxBytes))
        : file.content;
      const injectedBytes = Math.min(encoded.length, maxBytes);
      totalBytes += injectedBytes;

      fileSummaries.push({
        path: file.path,
        name: localFileReferenceName(file.path),
        language: file.language || reference.extension || "text",
        total_lines: file.total_lines,
        size_bytes: file.size_bytes,
        injected_bytes: injectedBytes,
        truncated,
        failed: false,
      });

      blocks.push(
        [
          `### ${file.path}`,
          `- language: ${file.language || reference.extension || "text"}`,
          `- lines: ${file.total_lines}`,
          `- size: ${formatFileSize(file.size_bytes)}`,
          truncated
            ? `- note: content truncated to ${formatFileSize(maxBytes)} for this request`
            : null,
          "",
          `\`\`\`${languageFence(file.language, file.path)}`,
          sanitizeFenceContent(content),
          "```",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      );
    } catch (reason) {
      blocks.push(
        `### ${reference.path}\nFailed to read this referenced file: ${String(reason)}`,
      );
      fileSummaries.push({
        path: reference.path,
        name: reference.name || localFileReferenceName(reference.path),
        language: reference.extension ?? undefined,
        size_bytes: reference.size_bytes ?? null,
        injected_bytes: 0,
        truncated: false,
        failed: true,
        error: String(reason),
      });
    }
  }

  return {
    prompt: [
      userPrompt,
      "",
      "<agent-ui-local-file-references>",
      "The user referenced these local files with @. They may be inside or outside the current workspace. Treat them as read-only context snapshots for this turn. Use exact paths when citing or discussing them. If a file is truncated or failed to read, say so instead of guessing missing content.",
      "",
      blocks.join("\n\n"),
      "</agent-ui-local-file-references>",
    ]
      .filter(Boolean)
      .join("\n"),
    fileReferences: fileSummaries,
  };
}

// --- Hook ---

export function useAgentTurn(deps: AgentTurnDeps) {
  const {
    activeProject,
    activeSessionId,
    selectedChatModel,
    permissionState,
    prompt,
    fileReferences,
    updateSessionStream,
    setAssistantDebugBundles,
    refreshSessionContextUsage,
    currentBundleBySessionRef,
    setProjects,
    setPrompt,
    setFileReferences,
    closeFileSuggestions,
    setError,
  } = deps;

  const [isRunningTurn, setIsRunningTurn] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [isInterruptingTurn, setIsInterruptingTurn] = useState(false);
  const [pendingPermissions, setPendingPermissions] = useState<
    Array<PendingPermission>
  >([]);
  const [isResolvingFileReferences, setIsResolvingFileReferences] =
    useState(false);

  const pendingPermission = activeSessionId
    ? (pendingPermissions.find(
        (permission) => permission.sessionId === activeSessionId,
      ) ?? null)
    : null;

  const enqueuePendingPermission = useCallback(
    (permission: PendingPermission) => {
      if (!permission.requestId) {
        return;
      }

      setPendingPermissions((current) => {
        const existingIndex = current.findIndex(
          (item) =>
            item.sessionId === permission.sessionId &&
            item.requestId === permission.requestId,
        );

        if (existingIndex >= 0) {
          const next = current.slice();
          next[existingIndex] = permission;
          return next;
        }

        return [...current, permission];
      });
    },
    [],
  );

  const removePendingPermission = useCallback(
    (sessionId: string, requestId: string) => {
      setPendingPermissions((current) =>
        current.filter(
          (permission) =>
            permission.sessionId !== sessionId ||
            permission.requestId !== requestId,
        ),
      );
    },
    [],
  );

  const clearPendingPermissionsForSession = useCallback(
    (sessionId: string) => {
      setPendingPermissions((current) =>
        current.filter((permission) => permission.sessionId !== sessionId),
      );
    },
    [],
  );

  const submitPrompt = useCallback(async () => {
    const trimmed = prompt.trim();
    if (
      (!trimmed && fileReferences.length === 0) ||
      !activeProject ||
      !activeSessionId ||
      isRunningTurn ||
      pendingPermission ||
      isResolvingFileReferences
    ) {
      return;
    }

    const referencedFiles = fileReferences;
    const displayPrompt =
      trimmed ||
      `请阅读这些引用文件：${referencedFiles.map((reference) => `@${reference.path}`).join(", ")}`;
    const pendingId = `assistant-pending-${Date.now()}`;
    const targetSessionId = activeSessionId;
    currentBundleBySessionRef.current[targetSessionId] = pendingId;
    let inputForClaude = displayPrompt;
    let injectedFileReferences: import("../types").LocalFileReferenceSummary[] =
      [];

    setIsResolvingFileReferences(true);
    try {
      const referencePayload = await buildPromptWithLocalFileReferences(
        readLocalReferenceFile,
        activeProject.root,
        displayPrompt,
        referencedFiles,
      );
      inputForClaude = referencePayload.prompt;
      injectedFileReferences = referencePayload.fileReferences;
    } catch (reason) {
      setError(`Read referenced files failed: ${String(reason)}`);
      setIsResolvingFileReferences(false);
      return;
    }
    setIsResolvingFileReferences(false);

    const pendingAssistantText = "Assistant is thinking…";

    setAssistantDebugBundles((bundles) => ({
      ...bundles,
      [pendingId]: {
        messageId: pendingId,
        modelCallIds: [],
        sessionId: targetSessionId,
        root: activeProject.root,
        userMessage: displayPrompt,
        transportMessage: inputForClaude,
        fileReferences:
          injectedFileReferences.length > 0
            ? injectedFileReferences
            : undefined,
        displayText: pendingAssistantText,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        completed: false,
        events: [],
      },
    }));

    if (
      activeProject.sessions.find(
        (session) => session.id === targetSessionId,
      )?.isPending
    ) {
      const nextTitle = truncateSessionTitle(displayPrompt);
      setProjects((folders) =>
        folders.map((folder) =>
          folder.id === activeProject.id
            ? {
                ...folder,
                sessions: folder.sessions.map((session) =>
                  session.id === targetSessionId
                    ? { ...session, title: nextTitle }
                    : session,
                ),
              }
            : folder,
        ),
      );
    }

    updateSessionStream(targetSessionId, (items) => [
      ...items,
      {
        id: `user-${Date.now()}`,
        kind: "message",
        role: "user",
        text: displayPrompt,
        links: [],
        fileReferences:
          injectedFileReferences.length > 0
            ? injectedFileReferences
            : undefined,
      },
      {
        id: pendingId,
        kind: "message",
        role: "assistant",
        text: pendingAssistantText,
        status: "streaming",
      },
    ]);

    setPrompt("");
    setFileReferences(() => []);
    closeFileSuggestions();
    setIsRunningTurn(true);
    setError(null);

    ensureAgentReplProcess(
      activeProject.root,
      targetSessionId,
      selectedChatModel,
      permissionState?.currentMode ?? "default",
    )
      .then((state) =>
        sendAgentReplInput(
          activeProject.root,
          state.sessionId || targetSessionId,
          inputForClaude,
        ),
      )
      .catch((reason) => {
        setError(String(reason));
        clearPendingPermissionsForSession(targetSessionId);
        updateSessionStream(targetSessionId, (items) =>
          items.map((item) =>
            item.id === pendingId && item.kind === "message"
              ? {
                  ...item,
                  text: `Agent turn failed: ${String(reason)}`,
                  status: "complete",
                }
              : item,
          ),
        );
        setIsRunningTurn(false);
      });
  }, [
    prompt,
    fileReferences,
    activeProject,
    activeSessionId,
    selectedChatModel,
    permissionState,
    isRunningTurn,
    pendingPermission,
    isResolvingFileReferences,
    updateSessionStream,
    setAssistantDebugBundles,
    currentBundleBySessionRef,
    setProjects,
    setPrompt,
    setFileReferences,
    closeFileSuggestions,
    setError,
    clearPendingPermissionsForSession,
  ]);

  const handleForkFromMessage = useCallback(
    async (
      item: Extract<StreamItem, { kind: "message" }>,
    ) => {
      if (
        !activeProject ||
        !activeSessionId ||
        item.role !== "assistant" ||
        !item.checkpointUuid
      ) {
        setError(
          "This message cannot be used as a fork checkpoint because its jsonl uuid is missing.",
        );
        return;
      }

      try {
        setError(null);
        setForkingMessageId(item.id);
        await waitForNextPaint();
        const forkedProcess = await forkAgentReplProcess(
          activeProject.root,
          activeSessionId,
          item.checkpointUuid,
          selectedChatModel,
          permissionState?.currentMode ?? "default",
        );
        const forkedSessionId = forkedProcess.sessionId;
        const detail = await loadTypedRuntimeSessionWithRetry(
          loadTypedRuntimeSession,
          activeProject.root,
          forkedSessionId,
          80,
        );
        const artifacts = runtimeSessionToArtifacts(detail, activeProject.root);

        const forkedTitle =
          firstUserTitleFromStream(artifacts.items) ??
          `Fork · ${activeProject.sessions.find((s) => s.id === activeSessionId)?.title ?? ""}`;

        setProjects((folders) =>
          folders.map((folder) =>
            folder.id === activeProject.id
              ? {
                  ...folder,
                  sessions: dedupeSessions([
                    {
                      id: forkedSessionId,
                      title: forkedTitle,
                      processStatus: "active",
                      processPid: undefined,
                    },
                    ...folder.sessions,
                  ]),
                }
              : folder,
          ),
        );
        setAssistantDebugBundles((bundles) => ({
          ...bundles,
          ...artifacts.bundles,
        }));
        updateSessionStream(forkedSessionId, () =>
          collapseAssistantTurns(artifacts.items),
        );
        // Note: activeSessionId update is handled by App
        void refreshSessionContextUsage(
          activeProject.root,
          forkedSessionId,
        );
      } catch (reason) {
        setError(String(reason));
      } finally {
        setForkingMessageId(null);
      }
    },
    [
      activeProject,
      activeSessionId,
      selectedChatModel,
      permissionState,
      updateSessionStream,
      setAssistantDebugBundles,
      refreshSessionContextUsage,
      setProjects,
      setError,
    ],
  );

  const handlePermissionDecision = useCallback(
    (approved: boolean, answers?: Record<string, string>) => {
      if (!pendingPermission) {
        return;
      }
      const target = pendingPermission;
      setError(null);
      removePendingPermission(target.sessionId, target.requestId);
      setIsRunningTurn(true);
      const updatedInput =
        target.isQuestion && approved && answers && target.input
          ? { ...(target.input as Record<string, unknown>), answers }
          : undefined;
      respondAgentPermission(
        target.root,
        target.sessionId,
        target.requestId,
        approved,
        updatedInput,
      ).catch((reason) => {
        setError(String(reason));
        enqueuePendingPermission(target);
        setIsRunningTurn(false);
      });
    },
    [
      pendingPermission,
      removePendingPermission,
      enqueuePendingPermission,
      setError,
    ],
  );

  const handleInterruptTurn = useCallback(() => {
    if (
      (!isRunningTurn && !pendingPermission) ||
      isInterruptingTurn
    ) {
      return;
    }
    setIsInterruptingTurn(true);
    interruptAgentTurn(
      activeProject?.root ?? "",
      activeSessionId ?? "",
    )
      .catch((reason) => {
        setError(String(reason));
      })
      .finally(() => {
        if (activeSessionId) {
          clearPendingPermissionsForSession(activeSessionId);
        }
        setIsInterruptingTurn(false);
      });
  }, [
    isRunningTurn,
    pendingPermission,
    isInterruptingTurn,
    activeProject,
    activeSessionId,
    clearPendingPermissionsForSession,
    setError,
  ]);

  return {
    isRunningTurn,
    forkingMessageId,
    isInterruptingTurn,
    pendingPermissions,
    pendingPermission,
    isResolvingFileReferences,

    // Setters
    setIsRunningTurn,
    setPendingPermissions,
    setIsResolvingFileReferences,
    setForkingMessageId,

    // Handlers
    enqueuePendingPermission,
    removePendingPermission,
    clearPendingPermissionsForSession,
    submitPrompt,
    handleForkFromMessage,
    handlePermissionDecision,
    handleInterruptTurn,
  };
}

// --- Pure helper functions (forked from App.tsx, used only within this file) ---

function firstUserTitleFromStream(items: StreamItem[]): string | null {
  const userMessage = items.find(
    (item) => item.kind === "message" && item.role === "user",
  );
  return userMessage?.kind === "message"
    ? truncateSessionTitle(userMessage.text)
    : null;
}

function dedupeSessions(
  sessions: import("../app/types").ProjectSession[],
): import("../app/types").ProjectSession[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}

function collapseAssistantTurns(items: StreamItem[]): StreamItem[] {
  const collapsed: StreamItem[] = [];
  const pendingAssistantText = "Assistant is thinking…";

  for (const item of items) {
    const previous = collapsed[collapsed.length - 1];

    if (
      previous &&
      previous.kind === "message" &&
      previous.role === "assistant" &&
      item.kind === "message" &&
      item.role === "assistant"
    ) {
      const previousProgress = previous.progressText?.trim();
      const itemProgress = item.progressText?.trim();
      const mergedProgress =
        previousProgress || itemProgress
          ? mergeProgressText(previousProgress, itemProgress)
          : undefined;

      collapsed[collapsed.length - 1] = {
        ...previous,
        text:
          item.text && item.text !== pendingAssistantText
            ? item.text
            : previous.text,
        links: item.links?.length ? item.links : previous.links,
        progressText: mergedProgress,
        status:
          item.status === "complete" || previous.status === "complete"
            ? "complete"
            : previous.status ?? item.status,
      };
      continue;
    }

    collapsed.push(item);
  }

  return collapsed;
}

function mergeProgressText(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  const previousText = previous?.trim();
  const nextText = next?.trim();

  if (!previousText) return nextText || undefined;
  if (!nextText) return previousText;

  if (previousText === nextText) return previousText;
  if (nextText.startsWith(previousText)) return nextText;
  if (previousText.endsWith(nextText)) return previousText;

  return `${previousText}${nextText}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function modelCallIdFromRawJson(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const message = value.message;
  if (!isRecord(message)) {
    return null;
  }
  const id = message.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function addUniqueString(
  items: string[],
  value: string | null | undefined,
): string[] {
  const trimmed = value?.trim();
  if (!trimmed || items.includes(trimmed)) {
    return items;
  }
  return [...items, trimmed];
}
