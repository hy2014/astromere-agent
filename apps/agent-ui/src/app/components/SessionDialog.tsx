/* @checkFns detail-panel */
import {useCallback, useEffect, useMemo, useState} from "react";
import type {AgentPermissionState, StreamItem, StreamLink,} from "../../types";
import type {DebugStreamEvent} from "../types";
import type {LocalFileReference, PreviewTab, ProjectFolder} from "../types";
import {render, renderView} from "../../core/dep";
import {loadTypedRuntimeSession} from "../../runtime";
import {runtimeSessionToArtifacts} from "../debug-utils";
import {PreviewPanelView} from "./PreviewPanel";
import {PromptInputAreaView} from "./PromptInputArea";
import {MessagesStreamView} from "./messages-stream";
import {assistantTurnTimeline, compactCountLabel} from "../debug-utils";
import {formatDebugTime} from "../file-utils";
import {ensureAgentReplProcess, interruptAgentTurn, sendAgentReplInput,} from "../../runtime";
import {addCallback, startStreamEventListener,} from "../../hooks/stream-event-bus";

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
  turnInfo: { current: "idle" | "running" | "interrupt" | "ctrl_block" | "forking"; prev: "idle" | "running" | "interrupt" | "ctrl_block" | "forking" };
  setTurnInfo: (status: "idle" | "running" | "interrupt" | "ctrl_block" | "forking") => void;
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
  toolName: string;
  input: unknown;
  rawJson: unknown;
  isQuestion: boolean;
  questions?: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

// ─── WriteState (imported by PromptInputArea for permission responses) ──

export const WriteState: {
  setTurnInfo: (status: "idle" | "running" | "interrupt" | "ctrl_block" | "forking") => void;
  setDisplayDetailBundleId: (updater: string | null | ((current: string | null) => string | null)) => void;
  runningProcess: DebugStreamEvent[];
  setRunningProcess: (updater: DebugStreamEvent[] | ((prev: DebugStreamEvent[]) => DebugStreamEvent[])) => void;
} = {} as any;

// ─── PendingSubmit — signal: tells MessagesStreamView to add user + assistant pending items ──
export type PendingSubmit = {
  key: number;
  displayPrompt: string;
};

// ─── File-level functions ────────────────────────────────────────────────

function computeShowPreview(activeProject: ProjectFolder | null, activePreview: PreviewTab | null): boolean {
  return activeProject !== null && activePreview !== null;
}

// ─── Handle functions (file-level, use WriteState) ──────────────────────

function onToggleAssistantProcess(messageId: string): void {
  WriteState.setDisplayDetailBundleId((current: string | null) => (current === messageId ? null : messageId));
}

// ─── Effect extraction functions (file-level, use WriteState for state) ──

function loadSessionEffect(
  activeRoot: string | undefined,
  activeSessionId: string,
  activeSessionTitle: string,
  activeProject: ProjectFolder | null,
  onSetError: (err: string | null) => void,
): () => void {
  // No-op: history data is loaded by MessagesStreamView's own loadHistoryStreamItems
  return () => {};
}

// ─── Turn handler functions (file-level, use WriteState) ──────────────────

function truncateSessionTitle(value: string): string {
  const maxLength = 80;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized || "新会话";
  }
  return `${normalized.slice(0, maxLength)}…`;
}

async function handleSubmitPromptAction(
  input: { text: string; fileReferences: LocalFileReference[] },
  activeProject: ProjectFolder | null,
  activeSessionId: string | null,
  selectedChatModel: string,
  permissionState: AgentPermissionState | null,
  hasPendingPermission: boolean,
  turnStatusVal: "idle" | "running" | "interrupt" | "ctrl_block" | "forking",
  setProjectsFn: (updater: (folders: ProjectFolder[]) => ProjectFolder[]) => void,
  setErrorFn: (error: string | null) => void,
  setCurrentInputFn: (input: { key: number; displayPrompt: string }) => void,
  onSetTurnInfo: (status: "idle" | "running" | "interrupt" | "ctrl_block" | "forking") => void,
): Promise<void> {
  const trimmed = input.text.trim();
  if (
    (!trimmed && input.fileReferences.length === 0) ||
    !activeProject ||
    !activeSessionId ||
    turnStatusVal !== "idle" ||
    hasPendingPermission
  ) {
    return;
  }

  const displayPrompt =
    trimmed ||
    `请阅读这些引用文件：${input.fileReferences.map((reference) => `@${reference.path}`).join(", ")}`;
  const inputForClaude = displayPrompt;
  const targetSessionId = activeSessionId;

  console.time('[submit] enter-to-sync');
  console.time('[submit] sync: setCurrentInput + setTurnStatus');

  // Notify MessagesStreamView via the currentInput signal to append user + pending assistant items
  setCurrentInputFn({ key: Date.now(), displayPrompt });
  onSetTurnInfo("running");
  setErrorFn(null);
  console.timeEnd('[submit] sync: setCurrentInput + setTurnInfo');
  console.timeEnd('[submit] enter-to-sync');

  // Pending session title update
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

  // Send to the backend
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
      onSetTurnInfo("idle");
    });
}

function handleForkFromMessageAction(
  item: Extract<StreamItem, { kind: "message" }>,
  onFork: (item: Extract<StreamItem, { kind: "message" }>) => void,
): void {
  WriteState.setTurnInfo("forking");
  // Fire-and-forget: onFork is an async function (App.tsx's handleForkFromMessage),
  // the "forking" status is cleared automatically once the async operation completes
  Promise.resolve(onFork(item))
    .catch(() => {})
    .finally(() => WriteState.setTurnInfo("idle"));
}

function handleInterruptTurnAction(
  turnStatusVal: "idle" | "running" | "interrupt" | "ctrl_block" | "forking",
  activeSessionIdVal: string | null,
  activeProject: ProjectFolder | null,
  setErrorFn: (error: string | null) => void,
): void {
  if (turnStatusVal === "idle" || turnStatusVal === "interrupt") return;
  WriteState.setTurnInfo("interrupt");
  interruptAgentTurn(activeProject?.root ?? "", activeSessionIdVal ?? "")
    .catch((reason) => setErrorFn(String(reason)))
    .finally(() => {
      // After a turn is interrupted, the bus receives the interrupt event and auto-clears the pending permission
      WriteState.setTurnInfo("idle");
    });
}

// ─── renderFn functions ──────────────────────────────────────────────────

function renderProcessTimeline(
  { displayDetailBundleId }:
    { displayDetailBundleId: string | null },
  { activeSessionId, runningProcess }: { activeSessionId: string | null; runningProcess: DebugStreamEvent[] },
  { onToggleAssistantProcess }: { onToggleAssistantProcess: (id: string) => void },
) {
  if (!displayDetailBundleId) return <></>;
  const events = runningProcess;
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
  { activeSessionId, activeProject, activePreview, previewTabs, runningProcess }:
    { activeSessionId: string | null; activeProject: ProjectFolder | null; activePreview: PreviewTab | null; previewTabs: PreviewTab[]; runningProcess: DebugStreamEvent[] },
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
        props: { activeSessionId, runningProcess },
        fn: renderProcessTimeline,
        events: { onToggleAssistantProcess },
        memo: {},
      })}
    </aside>
  );
}

function renderSessionDialog(
  { displayDetailBundleId, turnInfo, currentInput, runningProcess }:    { displayDetailBundleId: string | null; turnInfo: { current: "idle" | "running" | "interrupt" | "ctrl_block" | "forking"; prev: "idle" | "running" | "interrupt" | "ctrl_block" | "forking" }; currentInput: { key: number; displayPrompt: string } | null; runningProcess: DebugStreamEvent[] },
  { activeSessionId, activeProject, error, previewTabs, activePreview, permissionState, selectedChatModel, chatModelOptions, setTurnInfo }:
    { activeSessionId: string | null; activeProject: ProjectFolder | null; error: string | null; previewTabs: PreviewTab[]; activePreview: PreviewTab | null; permissionState: AgentPermissionState | null; selectedChatModel: string; chatModelOptions: string[]; setTurnInfo: (status: "idle" | "running" | "interrupt" | "ctrl_block" | "forking") => void },
  { onToggleAssistantProcess, onOpenPreviewLink, onForkFromMessage, onSubmitPrompt, onInterruptTurn, onPermissionModeChange, onChatModelChange, onSetActivePreviewId, onClosePreviewTab, onCloseAllPreviews }:
    { onToggleAssistantProcess: (messageId: string) => void; onOpenPreviewLink: (link: StreamLink) => void; onForkFromMessage: any; onSubmitPrompt: (input: { text: string; fileReferences: any[] }) => void; onInterruptTurn: () => void; onPermissionModeChange: (mode: string) => void; onChatModelChange: (model: string) => void; onSetActivePreviewId: (id: string | null) => void; onClosePreviewTab: (id: string) => void; onCloseAllPreviews: () => void },
) {
  const messageStreamProps = {
    activeSessionId, activeProject, error, turnInfo,
    currentInput,
    pendingPermission: null,
    onOpenPreviewLink, onForkFromMessage,
    onToggleProcess: onToggleAssistantProcess,
  };
  return (
    <>
      <section className="exploration-panel" aria-label="Exploration stream">
        {renderView({ fn: MessagesStreamView, props: messageStreamProps })}

        {renderView({ fn: PromptInputAreaView, props: {
          activeProject: activeProject?.root ?? null,
          activeSessionId,
          turnInfo,
          setTurnInfo,
          permissionState,
          onPermissionModeChange,
          selectedChatModel,
          chatModelOptions,
          onChatModelChange,
          onSubmitPrompt,
          onInterruptTurn,
          onOpenPreviewLink,
        }})}
      </section>

      {render({
        state: { displayDetailBundleId },
        props: { activeSessionId, activeProject, activePreview, previewTabs, runningProcess },
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
  turnInfo, setTurnInfo,
}: SessionDialogProps) {
  // ── Shared state ──
  const [currentInput, setCurrentInput] = useState<{ key: number; displayPrompt: string } | null>(null);

  // Process right-side panel
  const [displayDetailBundleId, setDisplayDetailBundleId] = useState<string | null>(null);
  const [runningProcess, setRunningProcess] = useState<DebugStreamEvent[]>([]);

  // ── WriteState registrations ──
  WriteState.setTurnInfo = setTurnInfo;
  WriteState.setDisplayDetailBundleId = setDisplayDetailBundleId;
  WriteState.runningProcess = runningProcess;
  WriteState.setRunningProcess = setRunningProcess;

  // ── Effects ──

  // Start the underlying event listener (new event handles are registered by App.tsx; this only starts it)
  useEffect(() => { startStreamEventListener(); }, []);

  // ── Event bus callback: streaming process events ──
  useEffect(() => {
    const unsub = addCallback("detail", (data, sessionId) => {
      if (sessionId !== activeSessionId) return;
      if (!data) return;
      const d = data as { lastEvent?: DebugStreamEvent };
      if (!d.lastEvent) return;
      setRunningProcess((prev) => [...prev, d.lastEvent!]);
    });
    return unsub;
  }, [activeSessionId]);

  // Clear leftover process events when switching session
  useEffect(() => { setRunningProcess([]); }, [activeSessionId]);

  // Clear process events at the start of a new turn (only on idle→running; not cleared when returning to running after a permission block)
  useEffect(() => {
    if (turnInfo.prev === "idle" && turnInfo.current === "running") {
      setRunningProcess([]);
    }
  }, [turnInfo]);

  // Load events from JSONL when opening the process panel for historical messages
  useEffect(() => {
    if (!displayDetailBundleId || !activeProject?.root || !activeSessionId) return;
    if (runningProcess.length > 0) return; // already have streaming data, no need to load
    loadTypedRuntimeSession(activeProject.root, activeSessionId)
      .then((detail) => {
        const artifacts = runtimeSessionToArtifacts(detail, activeProject.root);
        const bundle = artifacts.bundles[displayDetailBundleId];
        if (bundle?.events?.length) setRunningProcess(bundle.events);
      })
      .catch(() => {}); // silent
  }, [displayDetailBundleId, activeProject?.root, activeSessionId, runningProcess.length]);

  // ── Computed values & thin event callbacks ──

  const onEventSubmitPrompt = useCallback(
    (input: { text: string; fileReferences: LocalFileReference[] }) =>
      handleSubmitPromptAction(
        input, activeProject, activeSessionId, selectedChatModel, permissionState,
        false, turnInfo.current,
        setProjects, setError,
        setCurrentInput, setTurnInfo,
      ),
    [activeProject, activeSessionId, selectedChatModel, permissionState,
      turnInfo, setProjects, setError],
  );
  const onEventInterruptTurn = useCallback(
    () => handleInterruptTurnAction(
      turnInfo.current, activeSessionId,
      activeProject, setError,
    ),
    [turnInfo, activeSessionId, activeProject, setError],
  );

  // Fork action: the file-level handleForkFromMessageAction sets/clears the "forking" turnStatus
  const onEventForkFromMessage = useCallback(
    (item: Extract<StreamItem, { kind: "message" }>) =>
      handleForkFromMessageAction(item, onForkFromMessage),
    [onForkFromMessage],
  );
  // Override the prop variable to match the events shorthand naming convention
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
      displayDetailBundleId, turnInfo, currentInput, runningProcess,
    },
    props: {
      activeSessionId, activeProject, error, previewTabs, activePreview,
      permissionState, selectedChatModel, chatModelOptions, setTurnInfo,
    },
    fn: renderSessionDialog,
    events: {
      onToggleAssistantProcess,
      onOpenPreviewLink,
      onForkFromMessage,
      onSubmitPrompt,
      onInterruptTurn,
      onPermissionModeChange,
      onChatModelChange,
      onSetActivePreviewId,
      onClosePreviewTab,
      onCloseAllPreviews,
    },
    memo: {},
  });
}
