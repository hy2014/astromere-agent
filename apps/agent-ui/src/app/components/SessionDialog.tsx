/* @checkFns detail-panel */
import {useState, useEffect, useMemo, useCallback} from "react";
import type {
  AgentPermissionState,
  StreamItem,
  StreamLink,
} from "../../types";
import type {LocalFileReference, PreviewTab, ProjectFolder, DebugStreamEvent} from "../types";
import {render, renderView} from "../../core/dep";
import {PreviewPanelView} from "./PreviewPanel";
import {PromptInputAreaView} from "./PromptInputArea";
import {MessagesStreamView} from "./messages-stream";
import {assistantTurnTimeline, compactCountLabel} from "../debug-utils";
import {formatDebugTime} from "../file-utils";
import {SessionUsageDashboardView} from "./usage-components";
import {
  ensureAgentReplProcess,
  sendAgentReplInput,
  interruptAgentTurn,
} from "../../runtime";
import {
  startStreamEventListener,
  getSessionData,
  addCallback,
} from "../../hooks/stream-event-bus";
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

// ─── WriteState (被 PromptInputArea 导入用于权限响应) ─────────────────

export const WriteState: {
  setTurnStatus: (updater: "idle" | "running" | "interrupt" | "ctrl_block" | "forking" | ((prev: "idle" | "running" | "interrupt" | "ctrl_block" | "forking") => "idle" | "running" | "interrupt" | "ctrl_block" | "forking")) => void;
  setDisplayDetailBundleId: (updater: string | null | ((current: string | null) => string | null)) => void;
} = {} as any;

// ─── PendingSubmit — 信号：通知 MessagesStreamView 添加 user + assistant pending items ──
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
  onSetTurnStatus: (status: "idle" | "running" | "interrupt" | "ctrl_block" | "forking") => void,
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

  // 通过 currentInput 信号通知 MessagesStreamView 追加 user + pending assistant items
  setCurrentInputFn({ key: Date.now(), displayPrompt });
  onSetTurnStatus("running");
  setErrorFn(null);
  console.timeEnd('[submit] sync: setCurrentInput + setTurnStatus');
  console.timeEnd('[submit] enter-to-sync');

  // Pending session 标题更新
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

  // 发到后端
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
      onSetTurnStatus("idle");
    });
}

function handleForkFromMessageAction(
  item: Extract<StreamItem, { kind: "message" }>,
  onFork: (item: Extract<StreamItem, { kind: "message" }>) => void,
): void {
  WriteState.setTurnStatus("forking");
  // Fire-and-forget: onFork 是 async function（App.tsx 的 handleForkFromMessage），
  // 等异步操作完成后自动清除 "forking" 状态
  Promise.resolve(onFork(item))
    .catch(() => {})
    .finally(() => WriteState.setTurnStatus("idle"));
}

function handleInterruptTurnAction(
  turnStatusVal: "idle" | "running" | "interrupt" | "ctrl_block" | "forking",
  activeSessionIdVal: string | null,
  activeProject: ProjectFolder | null,
  setErrorFn: (error: string | null) => void,
): void {
  if (turnStatusVal === "idle" || turnStatusVal === "interrupt") return;
  WriteState.setTurnStatus("interrupt");
  interruptAgentTurn(activeProject?.root ?? "", activeSessionIdVal ?? "")
    .catch((reason) => setErrorFn(String(reason)))
    .finally(() => {
      // turn 被中断后，bus 收到 interrupt 事件时会自动清空 pending permission
      WriteState.setTurnStatus("idle");
    });
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
  { displayDetailBundleId, turnStatus, currentInput }:    { displayDetailBundleId: string | null; turnStatus: "idle" | "running" | "interrupt" | "ctrl_block" | "forking"; currentInput: { key: number; displayPrompt: string } | null },
  { activeSessionId, activeProject, error, previewTabs, activePreview, permissionState, selectedChatModel, chatModelOptions }:
    { activeSessionId: string | null; activeProject: ProjectFolder | null; error: string | null; previewTabs: PreviewTab[]; activePreview: PreviewTab | null; permissionState: AgentPermissionState | null; selectedChatModel: string; chatModelOptions: string[] },
  { onToggleAssistantProcess, onOpenPreviewLink, onForkFromMessage, onSubmitPrompt, onInterruptTurn, onPermissionModeChange, onChatModelChange, onSetActivePreviewId, onClosePreviewTab, onCloseAllPreviews }:
    { onToggleAssistantProcess: (messageId: string) => void; onOpenPreviewLink: (link: StreamLink) => void; onForkFromMessage: any; onSubmitPrompt: (input: { text: string; fileReferences: any[] }) => void; onInterruptTurn: () => void; onPermissionModeChange: (mode: string) => void; onChatModelChange: (model: string) => void; onSetActivePreviewId: (id: string | null) => void; onClosePreviewTab: (id: string) => void; onCloseAllPreviews: () => void },
) {
  const messageStreamProps = {
    activeSessionId, activeProject, error, turnStatus,
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
          turnStatus,
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
  const [turnStatus, setTurnStatus] = useState<"idle" | "running" | "interrupt" | "ctrl_block" | "forking">("idle");
  const [currentInput, setCurrentInput] = useState<{ key: number; displayPrompt: string } | null>(null);

  // Process 右侧面板
  const [displayDetailBundleId, setDisplayDetailBundleId] = useState<string | null>(null);

  // ── WriteState registrations ──
  WriteState.setTurnStatus = setTurnStatus;
  WriteState.setDisplayDetailBundleId = setDisplayDetailBundleId;

  // ── Effects ──

  // 启动底层事件监听（新版 event handles 由 App.tsx 注册，这里只负责 start）
  useEffect(() => { startStreamEventListener(); }, []);

  // ── Event bus callback: turn-status ──
  useEffect(() => {
    return addCallback("session-status", (data, sessionId) => {
      if (sessionId !== activeSessionId) return;
      setTurnStatus(data as "idle" | "running" | "interrupt" | "ctrl_block" | "forking");
    });
  }, [activeSessionId]);

  // ── Computed values & thin event callbacks ──

  const onEventSubmitPrompt = useCallback(
    (input: { text: string; fileReferences: LocalFileReference[] }) =>
      handleSubmitPromptAction(
        input, activeProject, activeSessionId, selectedChatModel, permissionState,
        false, turnStatus,
        setProjects, setError,
        setCurrentInput, setTurnStatus,
      ),
    [activeProject, activeSessionId, selectedChatModel, permissionState,
      turnStatus, setProjects, setError],
  );
  const onEventInterruptTurn = useCallback(
    () => handleInterruptTurnAction(
      turnStatus, activeSessionId,
      activeProject, setError,
    ),
    [turnStatus, activeSessionId, activeProject, setError],
  );

  // Fork 操作：file-level handleForkFromMessageAction 负责设置/清除 "forking" turnStatus
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
      displayDetailBundleId, turnStatus, currentInput,
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
      onPermissionModeChange,
      onChatModelChange,
      onSetActivePreviewId,
      onClosePreviewTab,
      onCloseAllPreviews,
    },
    memo: {},
  });
}
