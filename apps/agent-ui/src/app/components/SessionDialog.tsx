/* @checkFns detail-panel */
import {useState, useEffect, useMemo, useCallback} from "react";
import type {
  AgentPermissionState,
  StreamItem,
  StreamLink,
  LocalFileReferenceSummary,
} from "../../types";
import type {AssistantMessageDebugBundle, LocalFileReference, PreviewTab, ProjectFolder, DebugStreamEvent} from "../types";
import type {BundleUsageSnapshot} from "../../tauri";
import {render, renderView} from "../../core/dep";
import {PreviewPanelView} from "./PreviewPanel";
import {PromptInputAreaView} from "./PromptInputArea";
import {MessagesStreamView, renderPromptHighlightedText} from "./messages-stream";
import {assistantTurnDetails, assistantTurnTimeline, compactCountLabel, runtimeSessionToArtifacts} from "../debug-utils";
import {formatDebugTime} from "../file-utils";
import {SessionUsageDashboardView} from "./usage-components";
import {
  ensureAgentReplProcess,
  sendAgentReplInput,
  interruptAgentTurn,
  respondAgentPermission,
  readLocalReferenceFile,
  loadTypedRuntimeSession,
} from "../../runtime";
import {welcomeStream} from "../session";
import {
  onStreamEvent,
  startStreamEventListener,
  getSessionData,
  addCallback,
} from "../../hooks/stream-event-bus";
import {realSessionIdFromEvent, streamEventToItems, collapseAssistantTurns, resolveRuntimeBundleEvent, createDebugEvent, applyRuntimeDebugEventToBundle} from "../stream-processor";
import {
  permissionToolNameFromEvent,
  permissionRequestIdFromEvent,
  permissionInputFromEvent,
} from "../file-utils";
import {queryItemList} from "../stream-handlers/message-detail";

// ─── Props interface ─────────────────────────────────────────────────────

export interface SessionDialogProps {
  activeSessionId: string | null;
  activeProject: ProjectFolder | null;
  projects: ProjectFolder[];
  setProjects: (updater: (folders: ProjectFolder[]) => ProjectFolder[]) => void;
  onSelectSession: (project: ProjectFolder, sessionId: string) => void;
  error: string | null;
  setError: (error: string | null) => void;
  activeSessionTitle: string;
  permissionState: AgentPermissionState | null;
  onPermissionModeChange: (mode: string) => void;
  previewTabs: PreviewTab[];
  activePreview: PreviewTab | null;
  onSetActivePreviewId: (id: string | null) => void;
  onClosePreviewTab: (id: string) => void;
  onCloseAllPreviews: () => void;
  onOpenPreviewLink: (link: StreamLink) => void;
  chatModelOptions: string[];
  selectedChatModel: string;
  onChatModelChange: (model: string) => void;
  onForkFromMessage: (item: Extract<StreamItem, { kind: "message" }>) => void;
}

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

// ─── WriteState (session loading effect 专用，不要扩展) ───────────────────

const WriteState: {
  setSessionStreams: (updater: (streams: Record<string, StreamItem[]>) => Record<string, StreamItem[]>) => void;
  setAssistantDebugBundles: (updater: (bundles: Record<string, AssistantMessageDebugBundle>) => Record<string, AssistantMessageDebugBundle>) => void;
  setTurnStatus: (updater: "idle" | "running" | "interrupt" | "ctrl_block" | ((prev: "idle" | "running" | "interrupt" | "ctrl_block") => "idle" | "running" | "interrupt" | "ctrl_block")) => void;
  setPendingPermissions: (updater: any) => void;
  setIsResolvingFileReferences: (value: boolean) => void;
  setForkingMessageId: (id: string | null) => void;
  setDisplayDetailBundleId: (updater: string | null | ((current: string | null) => string | null)) => void;
} = {} as any;

// ─── File-level functions ────────────────────────────────────────────────

function computeShowPreview(activeProject: ProjectFolder | null, activePreview: PreviewTab | null): boolean {
  return activeProject !== null && activePreview !== null;
}

function computeActiveStreamItems(sessionStreams: Record<string, StreamItem[]>, activeSessionId: string | null): StreamItem[] {
  return activeSessionId ? (sessionStreams[activeSessionId] ?? []) : [];
}


function computeProcessData(
  streamItems: StreamItem[],
  assistantDebugBundles: Record<string, AssistantMessageDebugBundle>,
  displayDetailBundleId: string | null,
): { processDetails: ReturnType<typeof assistantTurnDetails> | null; showProcess: boolean } {
  if (!displayDetailBundleId) return { processDetails: null, showProcess: false };
  const item = streamItems.find(
    (s): s is Extract<StreamItem, { kind: "message" }> =>
      s.kind === "message" && s.role === "assistant" && s.id === displayDetailBundleId,
  );
  if (!item) return { processDetails: null, showProcess: false };
  const details = assistantTurnDetails(item, assistantDebugBundles[displayDetailBundleId] ?? null);
  return { processDetails: details, showProcess: Boolean(details?.timeline.length) };
}

function getStreamItemsFromState(sessionStreams: Record<string, StreamItem[]>, sessionId: string): StreamItem[] {
  return sessionStreams[sessionId] ?? [];
}

// ─── Handle functions (file-level, use WriteState) ──────────────────────

function onToggleAssistantProcess(messageId: string): void {
  WriteState.setDisplayDetailBundleId((current: string | null) => (current === messageId ? null : messageId));
}

// ─── Effect extraction functions (file-level, use WriteState for state) ──

function setupStreamEventEffect(): () => void {
  startStreamEventListener();
  return onStreamEvent((event) => {
    const debugEntry = createDebugEvent(event);
    const realSessionId = event.eventType === "turn_complete" ? realSessionIdFromEvent(event) : null;

    // Stream items + bundle tracking: compute bundleId from latest sessionStreams
    let resolvedRef: any = null;
    // Use setState with updater to get latest streams
    WriteState.setSessionStreams((streams) => {
      const currentItems = streams[event.sessionId] ?? [];
      const currentBundleId = (() => {
        for (let i = currentItems.length - 1; i >= 0; i--) {
          const s = currentItems[i];
          if (s.kind === "message" && s.role === "assistant" && s.status !== "complete") {
            return s.id;
          }
        }
        return null;
      })();
      const resolved = resolveRuntimeBundleEvent(event, { [event.sessionId]: currentBundleId });
      resolvedRef = resolved;
      const nextItems = collapseAssistantTurns(
        streamEventToItems(currentItems, resolved),
      );

      // Debug bundles update — 在 updater 内执行，与 setSessionStreams 在同一个 batch 中
      WriteState.setAssistantDebugBundles((bundles) =>
        applyRuntimeDebugEventToBundle(bundles, resolved, debugEntry),
      );

      return { ...streams, [event.sessionId]: nextItems };
    });

    // Real session redirect
    if (realSessionId && realSessionId !== event.sessionId) {
      WriteState.setSessionStreams((streams) => {
        const oldItems = streams[event.sessionId] ?? [];
        const existingNewItems = streams[realSessionId] ?? [];
        const { [event.sessionId]: _removed, ...rest } = streams;
        return { ...rest, [realSessionId]: existingNewItems.length > 0 ? existingNewItems : oldItems };
      });
    }
  });
}

function setupTurnPermissionEventEffect(
  setProjects: any,
): () => void {
  return onStreamEvent((event) => {
    if (event.eventType === "permission_request" || event.eventType === "control_request") {
      const tn = permissionToolNameFromEvent(event);
      const requestId = permissionRequestIdFromEvent(event);
      const permInput = permissionInputFromEvent(event);
      const promptText = String(event.payload.prompt ?? `${tn} requests permission`);
      const isQuestion = tn === "AskUserQuestion";
      let questions: any[] | undefined;
      if (isQuestion && permInput && typeof permInput === "object") {
        const raw = permInput as Record<string, unknown>;
        if (Array.isArray(raw.questions)) questions = raw.questions;
      }
      handleEnqueuePendingPermission({
        root: event.root, sessionId: event.sessionId,
        messageId: `permission:${event.sessionId}:${requestId || Date.now()}`,
        requestId, prompt: promptText, toolName: tn, input: permInput,
        rawJson: event.payload.raw_json ?? event.payload, isQuestion, questions,
      });
      WriteState.setTurnStatus("idle");
    }

    if (event.eventType === "startup" || event.eventType === "process_status") {
      const pid = typeof event.payload.pid === "number" ? event.payload.pid : undefined;
      const running = event.eventType === "startup" ? true : event.payload.running === true;
      setProjects((folders: ProjectFolder[]) => folders.map((f: ProjectFolder) => ({
        ...f, sessions: f.sessions.map((s: any) =>
          s.id === event.sessionId ? { ...s, processStatus: running ? ("active" as const) : ("stopped" as const), processPid: running ? pid : undefined } : s),
      })));
    }

    const realSessionId = event.eventType === "turn_complete" ? realSessionIdFromEvent(event) : null;
    if (realSessionId && realSessionId !== event.sessionId) {
      const pid = typeof event.payload.pid === "number" ? event.payload.pid : undefined;
      setProjects((folders: ProjectFolder[]) => folders.map((f: ProjectFolder) => {
        const sessions = f.sessions.map((s: any) =>
          s.id === event.sessionId ? { ...s, id: realSessionId, isPending: false, processStatus: "active" as const, processPid: pid ?? s.processPid } : s);
        return { ...f, sessions: sessions.filter((s: any, i: number, self: any[]) => self.findIndex((x: any) => x.id === s.id) === i) };
      }));
      // Note: turn_complete 处理（下方）会负责设置 turnStatus
    }

    if (event.eventType === "turn_complete" || event.eventType === "error" || event.eventType === "interrupt" || event.eventType === "process_exit") {
      WriteState.setTurnStatus("idle");
      handleClearPendingPermissionsForSession(event.sessionId);
    }

    if (event.eventType === "process_exit") {
      setProjects((folders: ProjectFolder[]) => folders.map((f: ProjectFolder) => ({
        ...f, sessions: f.sessions.map((s: any) =>
          s.id === event.sessionId ? { ...s, processStatus: "stopped" as const, processPid: undefined } : s),
      })));
    }

    if (event.eventType === "stderr") {
      const detail = String(event.payload?.text ?? event.payload?.message ?? "").toLowerCase();
      if (detail.includes("repl process stdout closed")) {
        setProjects((folders: ProjectFolder[]) => folders.map((f: ProjectFolder) => ({
          ...f, sessions: f.sessions.map((s: any) =>
            s.id === event.sessionId ? { ...s, processStatus: "stopped" as const, processPid: undefined } : s),
        })));
      }
      if (detail.includes("error") || detail.includes("failed") || detail.includes("missing_credentials")) {
        WriteState.setTurnStatus("idle");
        handleClearPendingPermissionsForSession(event.sessionId);
      }
    }
  });
}

function loadSessionEffect(
  activeRoot: string | undefined,
  activeSessionId: string,
  activeSessionTitle: string,
  activeProject: ProjectFolder | null,
  onSetError: (err: string | null) => void,
): () => void {
  // Guard: no session selected
  if (!activeRoot || !activeSessionId) return () => {};
  // Guard: pending session (not yet confirmed)
  const session = activeProject?.sessions.find((s) => s.id === activeSessionId);
  if (!session || session.isPending) return () => {};

  let cancelled = false;
  loadTypedRuntimeSession(activeRoot, activeSessionId)
    .then((detail) => {
      if (cancelled) return;
      const artifacts = runtimeSessionToArtifacts(detail, activeRoot!);
      WriteState.setAssistantDebugBundles((bundles) => ({ ...bundles, ...artifacts.bundles }));
      WriteState.setSessionStreams((streams) => {
        if ((streams[activeSessionId] ?? []).length > 0) return streams;
        return { ...streams, [activeSessionId]: detail.messages.length > 0 ? artifacts.items : welcomeStream(activeProject!.name, activeSessionTitle) };
      });
    })
    .catch((reason) => { if (!cancelled) onSetError(String(reason)); });
  return () => { cancelled = true; };
}

// ─── Inline helpers (merged from useAgentTurn) ────────────────────────────

function truncateSessionTitle(value: string): string {
  const maxLength = 80;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized || "新会话";
  }
  return `${normalized.slice(0, maxLength)}…`;
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
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function buildPromptWithLocalFileReferences(
  root: string,
  userPrompt: string,
  references: LocalFileReference[],
  maxRefFileBytes: number,
  maxRefTotalBytes: number,
): Promise<{
  prompt: string;
  fileReferences: LocalFileReferenceSummary[];
}> {
  const uniqueReferences = Array.from(
    new Map(
      references.map((reference) => [reference.path, reference]),
    ).values(),
  );
  if (uniqueReferences.length === 0) return { prompt: userPrompt, fileReferences: [] };
  const blocks: string[] = [];
  const fileSummaries: LocalFileReferenceSummary[] = [];
  let totalBytes = 0;
  for (const reference of uniqueReferences) {
    if (totalBytes >= maxRefTotalBytes) {
      blocks.push(`### ${reference.path}\nSkipped: total referenced file content limit reached.`);
      fileSummaries.push({ path: reference.path, name: reference.name || localFileReferenceName(reference.path), language: reference.extension ?? undefined, size_bytes: reference.size_bytes ?? null, injected_bytes: 0, truncated: true, failed: true, error: "total referenced file content limit reached" });
      continue;
    }
    try {
      const file = await readLocalReferenceFile(root, reference.path);
      const availableBytes = Math.max(0, maxRefTotalBytes - totalBytes);
      const maxBytes = Math.min(maxRefFileBytes, availableBytes);
      const encoded = new TextEncoder().encode(file.content);
      const truncated = encoded.length > maxBytes;
      const content = truncated ? new TextDecoder().decode(encoded.slice(0, maxBytes)) : file.content;
      const injectedBytes = Math.min(encoded.length, maxBytes);
      totalBytes += injectedBytes;
      fileSummaries.push({ path: file.path, name: localFileReferenceName(file.path), language: file.language || reference.extension || "text", total_lines: file.total_lines, size_bytes: file.size_bytes, injected_bytes: injectedBytes, truncated, failed: false });
      blocks.push([`### ${file.path}`, `- language: ${file.language || reference.extension || "text"}`, `- lines: ${file.total_lines}`, `- size: ${formatFileSize(file.size_bytes)}`, truncated ? `- note: content truncated to ${formatFileSize(maxBytes)} for this request` : null, "", `\`\`\`${languageFence(file.language, file.path)}`, sanitizeFenceContent(content), "```"].filter((line): line is string => line !== null).join("\n"));
    } catch (reason) {
      blocks.push(`### ${reference.path}\nFailed to read this referenced file: ${String(reason)}`);
      fileSummaries.push({ path: reference.path, name: reference.name || localFileReferenceName(reference.path), language: reference.extension ?? undefined, size_bytes: reference.size_bytes ?? null, injected_bytes: 0, truncated: false, failed: true, error: String(reason) });
    }
  }
  return { prompt: [userPrompt, "", "<agent-ui-local-file-references>", "The user referenced these local files with @. They may be inside or outside the current workspace. Treat them as read-only context snapshots for this turn. Use exact paths when citing or discussing them. If a file is truncated or failed to read, say so instead of guessing missing content.", "", blocks.join("\n\n"), "</agent-ui-local-file-references>"].filter(Boolean).join("\n"), fileReferences: fileSummaries };
}

// ─── Turn handler functions (file-level, use WriteState) ──────────────────

function handleForkFromMessageAction(
  item: Extract<StreamItem, { kind: "message" }>,
  onFork: (item: Extract<StreamItem, { kind: "message" }>) => void,
): void {
  WriteState.setForkingMessageId(item.id);
  // Fire-and-forget: onFork 是 async function（App.tsx 的 handleForkFromMessage），
  // 等异步操作完成后自动清除 forkingMessageId
  Promise.resolve(onFork(item))
    .catch(() => {})
    .finally(() => WriteState.setForkingMessageId(null));
}

function computePendingPermission(
  activeSessionId: string | null,
  pendingPermissions: PendingPermission[],
): PendingPermission | null {
  return activeSessionId
    ? (pendingPermissions.find(
        (p) => p.sessionId === activeSessionId,
      ) ?? null)
    : null;
}

function handleEnqueuePendingPermission(permission: PendingPermission): void {
  if (!permission.requestId) return;
  WriteState.setPendingPermissions((current: any) => {
    const existingIndex = current.findIndex(
      (item: any) => item.sessionId === permission.sessionId && item.requestId === permission.requestId,
    );
    if (existingIndex >= 0) {
      const next = current.slice();
      next[existingIndex] = permission;
      return next;
    }
    return [...current, permission];
  });
}

function handleRemovePendingPermission(sessionId: string, requestId: string): void {
  WriteState.setPendingPermissions((current: any) =>
    current.filter((p: any) => p.sessionId !== sessionId || p.requestId !== requestId),
  );
}

function handleClearPendingPermissionsForSession(sessionId: string): void {
  WriteState.setPendingPermissions((current: any) =>
    current.filter((p: any) => p.sessionId !== sessionId),
  );
}

async function handleSubmitPromptAction(
  input: { text: string; fileReferences: LocalFileReference[] },
  activeProject: ProjectFolder | null,
  activeSessionId: string | null,
  selectedChatModel: string,
  permissionState: AgentPermissionState | null,
  pendingPermissionsVal: PendingPermission[],
  turnStatusVal: "idle" | "running" | "interrupt" | "ctrl_block",
  isResolvingFileReferencesVal: boolean,
  forkingMessageIdVal: string | null,
  setProjectsFn: (updater: (folders: ProjectFolder[]) => ProjectFolder[]) => void,
  setErrorFn: (error: string | null) => void,
): Promise<void> {
  const pendingPermissionVal = computePendingPermission(activeSessionId, pendingPermissionsVal);
  const trimmed = input.text.trim();
  if (
    (!trimmed && input.fileReferences.length === 0) ||
    !activeProject ||
    !activeSessionId ||
    turnStatusVal !== "idle" ||
    pendingPermissionVal ||
    isResolvingFileReferencesVal ||
    forkingMessageIdVal
  ) {
    return;
  }

  const referencedFiles = input.fileReferences;
  const displayPrompt =
    trimmed ||
    `请阅读这些引用文件：${referencedFiles.map((reference) => `@${reference.path}`).join(", ")}`;
  const pendingId = `assistant-pending-${Date.now()}`;
  const targetSessionId = activeSessionId;
  let inputForClaude = displayPrompt;
  let injectedFileReferences: LocalFileReferenceSummary[] = [];

  const pendingAssistantText = "Assistant is thinking…";
  console.time('[submit] enter-to-sync');
  WriteState.setAssistantDebugBundles((bundles) => ({
    ...bundles,
    [pendingId]: {
      messageId: pendingId,
      modelCallIds: [],
      sessionId: targetSessionId,
      root: activeProject.root,
      userMessage: displayPrompt,
      transportMessage: inputForClaude,
      fileReferences: undefined,
      displayText: pendingAssistantText,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      completed: false,
      events: [],
    },
  }));
  console.time('[submit] sync: updateSessionStream + setTurnStatus');
  WriteState.setSessionStreams((streams) => ({
    ...streams,
    [targetSessionId]: collapseAssistantTurns([
      ...(streams[targetSessionId] ?? []),
      {
        id: `user-${Date.now()}`,
        kind: "message",
        role: "user",
        text: displayPrompt,
        links: [],
        fileReferences: undefined,
      },
      {
        id: pendingId,
        kind: "message",
        role: "assistant",
        text: pendingAssistantText,
        status: "streaming",
      },
    ]),
  }));
  WriteState.setTurnStatus("running");
  setErrorFn(null);
  console.timeEnd('[submit] sync: updateSessionStream + setTurnStatus');
  console.timeEnd('[submit] enter-to-sync');

  WriteState.setIsResolvingFileReferences(true);
  try {
    const referencePayload = await buildPromptWithLocalFileReferences(
      activeProject.root,
      displayPrompt,
      referencedFiles,
      49152,
      163840,
    );
    inputForClaude = referencePayload.prompt;
    injectedFileReferences = referencePayload.fileReferences;
  } catch (reason) {
    setErrorFn(`Read referenced files failed: ${String(reason)}`);
    WriteState.setIsResolvingFileReferences(false);
    WriteState.setSessionStreams((streams) => ({
      ...streams,
      [targetSessionId]: (streams[targetSessionId] ?? []).map((item) =>
        item.id === pendingId && item.kind === "message"
          ? { ...item, text: `Agent turn failed: ${String(reason)}`, status: "complete" }
          : item,
      ),
    }));
    WriteState.setTurnStatus("idle");
    return;
  }
  WriteState.setIsResolvingFileReferences(false);

  if (injectedFileReferences.length > 0) {
    WriteState.setAssistantDebugBundles((bundles) => {
      const existing = bundles[pendingId];
      if (!existing) return bundles;
      return {
        ...bundles,
        [pendingId]: { ...existing, fileReferences: injectedFileReferences },
      };
    });
    WriteState.setSessionStreams((streams) => ({
      ...streams,
      [targetSessionId]: (streams[targetSessionId] ?? []).map((item) =>
        item.id.startsWith("user-")
          ? { ...item, fileReferences: injectedFileReferences }
          : item,
      ),
    }));
  }

  if (
    activeProject.sessions.find(
      (session) => session.id === targetSessionId,
    )?.isPending
  ) {
    const nextTitle = truncateSessionTitle(displayPrompt);
    setProjectsFn((folders) =>
      folders.map((folder) =>
        folder.id === activeProject.id
          ? {
              ...folder,
              sessions: folder.sessions.map((session: any) =>
                session.id === targetSessionId
                  ? { ...session, title: nextTitle }
                  : session,
              ),
            }
          : folder,
      ),
    );
  }

  ensureAgentReplProcess(
    activeProject.root,
    targetSessionId,
    selectedChatModel,
    permissionState?.currentMode ?? "default",
  )
    .then((state: any) => {
      const sessionId = state.sessionId || targetSessionId;
      return sendAgentReplInput(
        activeProject.root,
        sessionId,
        inputForClaude,
      );
    })
    .catch((reason: any) => {
      setErrorFn(String(reason));
      handleClearPendingPermissionsForSession(targetSessionId);
      WriteState.setSessionStreams((streams) => ({
        ...streams,
        [targetSessionId]: (streams[targetSessionId] ?? []).map((item) =>
          item.id === pendingId && item.kind === "message"
            ? { ...item, text: `Agent turn failed: ${String(reason)}`, status: "complete" }
            : item,
        ),
      }));
      WriteState.setTurnStatus("idle");
    });
}

function handlePermissionDecisionAction(
  approved: boolean,
  answers: Record<string, string> | undefined,
  activeSessionId: string | null,
  pendingPermissionsVal: PendingPermission[],
  setErrorFn: (error: string | null) => void,
): void {
  const pendingPermissionVal = computePendingPermission(activeSessionId, pendingPermissionsVal);
  if (!pendingPermissionVal) return;
  const target = pendingPermissionVal;
  setErrorFn(null);
  handleRemovePendingPermission(target.sessionId, target.requestId);
  WriteState.setTurnStatus("running");
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
    setErrorFn(String(reason));
    handleEnqueuePendingPermission(target);
    WriteState.setTurnStatus("idle");
  });
}

function handleInterruptTurnAction(
  turnStatusVal: "idle" | "running" | "interrupt" | "ctrl_block",
  pendingPermissionsVal: PendingPermission[],
  activeSessionIdVal: string | null,
  activeProject: ProjectFolder | null,
  setErrorFn: (error: string | null) => void,
): void {
  const pendingPermissionVal = computePendingPermission(activeSessionIdVal, pendingPermissionsVal);
  if (turnStatusVal === "idle" || turnStatusVal === "interrupt") return;
  WriteState.setTurnStatus("interrupt");
  interruptAgentTurn(activeProject?.root ?? "", activeSessionIdVal ?? "")
    .catch((reason) => setErrorFn(String(reason)))
    .finally(() => {
      // 权限清理由 setupTurnPermissionEventEffect 中的 event bus handler
      // 在收到 interrupt 事件时自动完成（使用事件中的正确 sessionId）
      WriteState.setTurnStatus("idle");
    });
}

function handlePermissionAllow(
  answers: Record<string, string> | undefined,
  activeSessionId: string | null,
  pendingPermissions: PendingPermission[],
  setError: (err: string | null) => void,
): void {
  handlePermissionDecisionAction(true, answers, activeSessionId, pendingPermissions, setError);
}
function handlePermissionDeny(
  activeSessionId: string | null,
  pendingPermissions: PendingPermission[],
  setError: (err: string | null) => void,
): void {
  handlePermissionDecisionAction(false, undefined, activeSessionId, pendingPermissions, setError);
}

// ─── renderFn functions ──────────────────────────────────────────────────

function renderProcessTimeline(
  { displayDetailBundleId }:
    { displayDetailBundleId: string | null },
  { activeSessionId }: { activeSessionId: string | null },
  { onToggleAssistantProcess }: { onToggleAssistantProcess: (id: string) => void },
) {
  if (!displayDetailBundleId) return <></>;
  const sessionInfo = getSessionData<{ bundles: Record<string, string[]> }>(activeSessionId ?? "", "session-info");
  const messageIds = sessionInfo?.bundles?.[displayDetailBundleId] ?? [];
  const events = queryItemList(activeSessionId ?? "", messageIds);
  const pd = assistantTurnTimeline(events);
  return (
    <div className="detail-content-overlay">
      <div className="detail-content-overlay-topbar">
        <button type="button" onClick={() => onToggleAssistantProcess(displayDetailBundleId)} className="process-panel-close-btn" aria-label="Close process panel">×</button>
      </div>
      <section className="file-workbench">
        <div className="detail-header">
          <div>
            <div className="eyebrow">Assistant Process</div>
            <h2>过程详情</h2>
          </div>
          <span className="count-label">
            {compactCountLabel(pd.progressLines.length, "行过程", "行过程")}{" · "}
            {compactCountLabel(pd.commandUses.length, "command")}{" · "}
            {compactCountLabel(pd.toolUses.length, "tool call")}{" · "}
            {compactCountLabel(pd.toolResults.length, "tool result")}{" · "}
            {compactCountLabel(pd.eventCount, "debug event")}
          </span>
        </div>
        <div className="process-panel-timeline">
          <div className="message-section-label">时间线</div>
          <ol className="message-process-timeline">
            {pd.timeline.map((entry: any) => (
              <li className={`process-timeline-item ${entry.kind}`} key={entry.id}>
                <div className="process-timeline-marker" aria-hidden="true" />
                <div className="process-timeline-content">
                  <div className="process-timeline-title-row">
                    <strong>{entry.title}</strong>
                    <span>{formatDebugTime(entry.receivedAt)}</span>
                  </div>
                  {entry.kind === "tool_call" ? <code>{entry.detail}</code>
                    : entry.kind === "tool_result" ? <pre>{entry.detail}</pre>
                    : <pre>{entry.detail}</pre>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

function renderDetailPanel(
  { displayDetailBundleId }:
    { displayDetailBundleId: string | null },
  { activeSessionId, activeProject, activePreview, previewTabs }:
    { activeSessionId: string | null; activeProject: ProjectFolder | null; activePreview: PreviewTab | null; previewTabs: PreviewTab[] },
  { onToggleAssistantProcess, onSetActivePreviewId, onClosePreviewTab, onCloseAllPreviews, onOpenPreviewLink }:
    { onToggleAssistantProcess: (messageId: string) => void; onSetActivePreviewId: (id: string | null) => void; onClosePreviewTab: (id: string) => void; onCloseAllPreviews: () => void; onOpenPreviewLink: (link: StreamLink) => void },
) {
  const showPreview = computeShowPreview(activeProject, activePreview);
  const hasDetailContent = displayDetailBundleId !== null;
  if (!showPreview && !hasDetailContent) return <></>;
  return (
    <aside className="detail-panel" aria-label="Detail panel">
      <div className="detail-content-base" style={{ display: showPreview ? undefined : 'none' }}>
        {showPreview && activePreview && renderView({ fn: PreviewPanelView, props: {
          activePreview, previewTabs, activeProject,
          onSetActivePreviewId,
          onClosePreviewTab,
          onCloseAllPreviews,
          onOpenPreviewLink,
        }})}
      </div>
      {hasDetailContent && render({
        state: { displayDetailBundleId },
        props: { activeSessionId },
        fn: renderProcessTimeline,
        events: { onToggleAssistantProcess },
        memo: {},
      })}
    </aside>
  );
}

function renderSessionDialog(
  { sessionStreams, assistantDebugBundles, displayDetailBundleId, turnStatus, forkingMessageId, pendingPermissions, isResolvingFileReferences }:    { sessionStreams: Record<string, StreamItem[]>; assistantDebugBundles: Record<string, AssistantMessageDebugBundle>; displayDetailBundleId: string | null; turnStatus: "idle" | "running" | "interrupt" | "ctrl_block"; forkingMessageId: string | null; pendingPermissions: any[]; isResolvingFileReferences: boolean },
  { activeSessionId, activeProject, error, previewTabs, activePreview, permissionState, selectedChatModel, chatModelOptions }:
    { activeSessionId: string | null; activeProject: ProjectFolder | null; error: string | null; previewTabs: PreviewTab[]; activePreview: PreviewTab | null; permissionState: AgentPermissionState | null; selectedChatModel: string; chatModelOptions: string[] },
  { onToggleAssistantProcess, onOpenPreviewLink, onForkFromMessage, onSubmitPrompt, onInterruptTurn, onEventPermissionAllow: onPermissionAllow, onEventPermissionDeny: onPermissionDeny, onPermissionModeChange, onChatModelChange, onSetActivePreviewId, onClosePreviewTab, onCloseAllPreviews }:
    { onToggleAssistantProcess: (messageId: string) => void; onOpenPreviewLink: (link: StreamLink) => void; onForkFromMessage: any; onSubmitPrompt: (input: { text: string; fileReferences: any[] }) => void; onInterruptTurn: () => void; onEventPermissionAllow: (answers?: Record<string, string>) => void; onEventPermissionDeny: () => void; onPermissionModeChange: (mode: string) => void; onChatModelChange: (model: string) => void; onSetActivePreviewId: (id: string | null) => void; onClosePreviewTab: (id: string) => void; onCloseAllPreviews: () => void },
) {
  const streamItems = computeActiveStreamItems(sessionStreams, activeSessionId);
  const pendingPermission = computePendingPermission(activeSessionId, pendingPermissions);
  const messageStreamProps = { activeSessionId, activeProject, error, turnStatus, forkingMessageId, pendingPermission, isResolvingFileReferences, onOpenPreviewLink, onForkFromMessage, onToggleProcess: onToggleAssistantProcess, assistantDebugBundles };
  return (
    <>
      <section className="exploration-panel" aria-label="Exploration stream">
        {renderView({ fn: MessagesStreamView, props: messageStreamProps })}

        {renderView({ fn: PromptInputAreaView, props: {
          activeProject: activeProject?.root ?? null,
          activeSessionId,
          turnStatus,
          pendingPermissions,
          isResolvingFileReferences,
          permissionState,
          onPermissionModeChange,
          selectedChatModel,
          chatModelOptions,
          onChatModelChange,
          onSubmitPrompt,
          onInterruptTurn,
          onPermissionAllow,
          onPermissionDeny,
          onOpenPreviewLink,
        }})}
      </section>

      {render({
        state: { displayDetailBundleId },
        props: { activeSessionId, activeProject, activePreview, previewTabs },
        fn: renderDetailPanel,
        events: { onToggleAssistantProcess, onSetActivePreviewId, onClosePreviewTab, onCloseAllPreviews, onOpenPreviewLink },
        memo: {},
      })}
    </>
  );
}

// ─── View component ──────────────────────────────────────────────────────

export function SessionDialogView({
  activeSessionId, activeProject, projects, setProjects, onSelectSession,
  error, setError, activeSessionTitle, permissionState, onPermissionModeChange,
  previewTabs, activePreview, onSetActivePreviewId, onClosePreviewTab, onCloseAllPreviews,
  onOpenPreviewLink, chatModelOptions, selectedChatModel, onChatModelChange,
  onForkFromMessage,
}: SessionDialogProps) {
  // ── 共享 state ──
  const [turnStatus, setTurnStatus] = useState<"idle" | "running" | "interrupt" | "ctrl_block">("idle");
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [pendingPermissions, setPendingPermissions] = useState<any[]>([]);
  const [isResolvingFileReferences, setIsResolvingFileReferences] = useState(false);

  // ── 全部的实时数据（event bus 唯一消费者） ──
  const [sessionStreams, setSessionStreams] = useState<Record<string, StreamItem[]>>({});
  const [assistantDebugBundles, setAssistantDebugBundles] = useState<Record<string, AssistantMessageDebugBundle>>({});

  // Process 右侧面板
  const [displayDetailBundleId, setDisplayDetailBundleId] = useState<string | null>(null);

  // ── WriteState registrations ──
  WriteState.setTurnStatus = setTurnStatus;
  WriteState.setPendingPermissions = setPendingPermissions;
  WriteState.setIsResolvingFileReferences = setIsResolvingFileReferences;
  WriteState.setForkingMessageId = setForkingMessageId;
  WriteState.setSessionStreams = setSessionStreams;
  WriteState.setDisplayDetailBundleId = setDisplayDetailBundleId;
  WriteState.setAssistantDebugBundles = setAssistantDebugBundles;

  // ── Effects ──

  useEffect(() => setupStreamEventEffect(), []);

  useEffect(() => setupTurnPermissionEventEffect(setProjects), [setProjects]);

  // ── Event bus callback: turn-status ──
  useEffect(() => {
    return addCallback("session-status", (data, sessionId) => {
      if (sessionId !== activeSessionId) return;
      setTurnStatus(data as "idle" | "running" | "interrupt" | "ctrl_block");
    });
  }, [activeSessionId]);

  // ── Computed values & thin event callbacks ──

  const onEventEnqueuePendingPermission = useCallback(
    (permission: PendingPermission) => handleEnqueuePendingPermission(permission),
    [],
  );
  const onEventClearPendingPermissionsForSession = useCallback(
    (sessionId: string) => handleClearPendingPermissionsForSession(sessionId),
    [],
  );
  const onEventSubmitPrompt = useCallback(
    (input: { text: string; fileReferences: LocalFileReference[] }) =>
      handleSubmitPromptAction(
        input, activeProject, activeSessionId, selectedChatModel, permissionState,
        pendingPermissions, turnStatus, isResolvingFileReferences,
        forkingMessageId,
        setProjects, setError,
      ),
    [activeProject, activeSessionId, selectedChatModel, permissionState,
      pendingPermissions, turnStatus, isResolvingFileReferences,
      forkingMessageId, setProjects, setError],
  );
  const onEventPermissionDecision = useCallback(
    (approved: boolean, answers?: Record<string, string>) =>
      handlePermissionDecisionAction(
        approved, answers,
        activeSessionId, pendingPermissions, setError,
      ),
    [activeSessionId, pendingPermissions, setError],
  );
  const onEventInterruptTurn = useCallback(
    () => handleInterruptTurnAction(
      turnStatus, pendingPermissions, activeSessionId,
      activeProject, setError,
    ),
    [turnStatus, pendingPermissions, activeSessionId, activeProject, setError],
  );

  const onEventPermissionAllow = useCallback(
    (answers?: Record<string, string>) => handlePermissionAllow(answers, activeSessionId, pendingPermissions, setError),
    [activeSessionId, pendingPermissions, setError],
  );
  const onEventPermissionDeny = useCallback(
    () => handlePermissionDeny(activeSessionId, pendingPermissions, setError),
    [activeSessionId, pendingPermissions, setError],
  );

  // Fork 操作：file-level handleForkFromMessageAction 负责设置/清除 forkingMessageId
  const onEventForkFromMessage = useCallback(
    (item: Extract<StreamItem, { kind: "message" }>) =>
      handleForkFromMessageAction(item, onForkFromMessage),
    [onForkFromMessage],
  );
  // 覆写 prop 变量以匹配 events 简写命名约定
  onForkFromMessage = onEventForkFromMessage;

  // Session loading effect
  useEffect(() => {
    loadSessionEffect(activeProject?.root, activeSessionId ?? "", activeSessionTitle, activeProject, setError);
  }, [activeProject?.root, activeSessionId, activeSessionTitle, activeProject, setError]);

  // ── useMemo aliases for event shorthand naming ──
  const onSubmitPrompt = useMemo(() => onEventSubmitPrompt, [onEventSubmitPrompt]);
  const onInterruptTurn = useMemo(() => onEventInterruptTurn, [onEventInterruptTurn]);

  return render({
    state: {
      sessionStreams, assistantDebugBundles,
      displayDetailBundleId, turnStatus, forkingMessageId,
      pendingPermissions, isResolvingFileReferences,
    },
    props: {
      activeSessionId, activeProject, error, previewTabs, activePreview,
      permissionState, selectedChatModel, chatModelOptions,
    },
    fn: renderSessionDialog,
    events: {
      onToggleAssistantProcess,
      onOpenPreviewLink,
      onForkFromMessage,
      onSubmitPrompt,
      onInterruptTurn,
      onEventPermissionAllow,
      onEventPermissionDeny,
      onPermissionModeChange,
      onChatModelChange,
      onSetActivePreviewId,
      onClosePreviewTab,
      onCloseAllPreviews,
    },
    memo: {},
  });
}
