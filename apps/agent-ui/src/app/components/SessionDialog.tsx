/* @checkFns detail-panel */
import {useState, useRef, useEffect, useMemo, useCallback} from "react";
import type {
  AgentPermissionState,
  StreamItem,
  StreamLink,
  ModelSettings,
} from "../../types";
import type {AssistantMessageDebugBundle, LocalFileReference, PreviewTab, ProjectFolder, DebugStreamEvent} from "../types";
import type {BundleUsageSnapshot} from "../../tauri";
import {render, renderView} from "../../core/dep";
import {PreviewPanelView} from "./PreviewPanel";
import {PromptInputAreaView} from "./PromptInputArea";
import {MessagesStreamView, renderPromptHighlightedText} from "./messages-stream";
import {assistantTurnDetails, compactCountLabel, runtimeSessionToArtifacts} from "../debug-utils";
import {formatDebugTime} from "../file-utils";
import {SessionUsageDashboard} from "./usage-components";
import {useAgentTurn} from "../../hooks/useAgentTurn";
import {loadTypedRuntimeSession, loadBundleUsageSnapshotsForSession} from "../../runtime";
import {welcomeStream} from "../session";
import {bundleUsageStorageKey, bundleUsageStatusFromEvent, calculateBundleUsageSnapshot} from "../usage-cost";
import {
  onStreamEvent,
  startStreamEventListener,
} from "../../hooks/stream-event-bus";
import {realSessionIdFromEvent, streamEventToItems, collapseAssistantTurns, resolveRuntimeBundleEvent, createDebugEvent, applyRuntimeDebugEventToBundle} from "../stream-processor";
import {
  permissionToolNameFromEvent,
  permissionRequestIdFromEvent,
  permissionInputFromEvent,
} from "../file-utils";
import {saveBundleUsageSnapshot} from "../../tauri";
import {loadModelSettings} from "../../runtime";

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
  /** 通知父组件右侧详细面板（预览/过程）是否需要显示，用于控制 CSS Grid 第三列 */
  onDetailPanelActiveChange?: (active: boolean) => void;
}

// ─── WriteState (session loading effect 专用，不要扩展) ───────────────────

const WriteState: {
  setSessionStreams: (updater: (streams: Record<string, StreamItem[]>) => Record<string, StreamItem[]>) => void;
  setAssistantDebugBundles: (updater: (bundles: Record<string, AssistantMessageDebugBundle>) => Record<string, AssistantMessageDebugBundle>) => void;
  setStreamUsageByBundleKey: (updater: (usage: Record<string, BundleUsageSnapshot>) => Record<string, BundleUsageSnapshot>) => void;
  setIsRunningTurn: (updater: boolean | ((current: boolean) => boolean)) => void;
  setPendingPermissions: (updater: any[]) => void;
  setIsResolvingFileReferences: (value: boolean) => void;
  setForkingMessageId: (id: string | null) => void;
  setIsInterruptingTurn: (value: boolean) => void;
  handlePermissionAllow: () => void;
  handlePermissionDeny: () => void;
} = {} as any;

// ─── File-level functions ────────────────────────────────────────────────

function handlePermissionAllow() {
  WriteState.handlePermissionAllow();
}
function handlePermissionDeny() {
  WriteState.handlePermissionDeny();
}

interface ProcessDetailComputed {
  processMessageId: string | null;
  processDetails: ReturnType<typeof assistantTurnDetails> | null;
  showProcess: boolean;
  hasDetailContent: boolean;
}

function computeProcessDetails(
  streamItems: StreamItem[],
  assistantDebugBundles: Record<string, AssistantMessageDebugBundle>,
  openProcessMessageIds: Set<string>,
): ProcessDetailComputed {
  const processMessageId =
    openProcessMessageIds.size > 0
      ? streamItems.find(
          (s): s is Extract<StreamItem, { kind: "message" }> =>
            s.kind === "message" && s.role === "assistant" && openProcessMessageIds.has(s.id),
        )?.id ?? null
      : null;
  const processItem = processMessageId
    ? streamItems.find(
        (s): s is Extract<StreamItem, { kind: "message" }> =>
          s.kind === "message" && s.role === "assistant" && s.id === processMessageId,
      ) ?? null
    : null;
  const processDetails = processItem
    ? assistantTurnDetails(processItem, assistantDebugBundles[processItem.id] ?? null)
    : null;
  const showProcess = Boolean(processDetails && processDetails.timeline.length > 0);
  const hasDetailContent = showProcess && Boolean(processDetails);
  return { processMessageId, processDetails, showProcess, hasDetailContent };
}

function computeShowPreview(activeProject: ProjectFolder | null, activePreview: PreviewTab | null): boolean {
  return activeProject !== null && activePreview !== null;
}

function computeUsageCount(streamUsageByBundleKey: Record<string, BundleUsageSnapshot>, activeSessionId: string | null): number {
  if (!activeSessionId) return 0;
  return Object.values(streamUsageByBundleKey).filter((s) => s.sessionId === activeSessionId).length;
}

// ─── View-component wrappers ──

const renderMessagesStream = (p: any) => renderView({ fn: MessagesStreamView, props: p });
const renderPromptInput = (p: any) => renderView({ fn: PromptInputAreaView, props: p });
const renderPreviewPanel = (p: any) => renderView({ fn: PreviewPanelView, props: p });

// ─── renderFn functions ──────────────────────────────────────────────────

function renderSessionHeader(
  { sessionTitle, usageCount, sessionId }: { sessionTitle: string; usageCount: number; sessionId: string | null },
  {}: Record<string, never>,
  { onToggleSessionUsage }: { onToggleSessionUsage: () => void },
) {
  return (
    <header className="workspace-header">
      <div className="session-title-area">
        <div className="session-title">
          <span className="header-icon" aria-hidden="true">chat</span>
          <h1>{sessionTitle}</h1>
        </div>
        <button className="debug-toggle" type="button" onClick={onToggleSessionUsage} disabled={!sessionId}>
          Usage <span>{usageCount}</span>
        </button>
      </div>
      <input className="session-search" placeholder="Search session content..." aria-label="Search session content" />
    </header>
  );
}

function renderProcessTimeline(
  { processDetails, processMessageId }: { processDetails: NonNullable<ProcessDetailComputed["processDetails"]>; processMessageId: string },
  {}: Record<string, never>,
  { onToggleAssistantProcess }: { onToggleAssistantProcess: (id: string) => void },
) {
  const pd = processDetails;
  return (
    <div className="detail-content-overlay">
      <div className="detail-content-overlay-topbar">
        <button type="button" onClick={() => onToggleAssistantProcess(processMessageId)} className="process-panel-close-btn" aria-label="Close process panel">×</button>
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
            {pd.timeline.map((entry) => (
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
  { showProcess, processDetails, processMessageId, showPreview, activePreview }:
    { showProcess: boolean; processDetails: ReturnType<typeof assistantTurnDetails> | null; processMessageId: string | null; showPreview: boolean; activePreview: PreviewTab | null },
  { previewTabs, activeProject }: { previewTabs: PreviewTab[]; activeProject: ProjectFolder | null },
  { onToggleAssistantProcess }: { onToggleAssistantProcess: (messageId: string) => void },
  _ext?: { renderPreviewPanel: (p: any) => JSX.Element; renderProcessTimeline: (p: any, e: any, ev: any) => JSX.Element; previewEvents: { onSetActivePreviewId: (id: string | null) => void; onClosePreviewTab: (id: string) => void; onCloseAllPreviews: () => void; onOpenPreviewLink: (link: StreamLink) => void } },
) {
  const hasDetailContent = showProcess && Boolean(processDetails);
  if (!showPreview && !hasDetailContent) return <></>;
  const ext = _ext ?? { renderPreviewPanel: () => <></>, renderProcessTimeline: () => <></>, previewEvents: { onSetActivePreviewId: () => {}, onClosePreviewTab: () => {}, onCloseAllPreviews: () => {}, onOpenPreviewLink: () => {} } };
  return (
    <aside className="detail-panel" aria-label="Detail panel">
      <div className="detail-content-base" style={{ display: showPreview && !showProcess ? undefined : 'none' }}>
        {showPreview && activePreview && ext.renderPreviewPanel({
          activePreview, previewTabs, activeProject,
          onSetActivePreviewId: ext.previewEvents.onSetActivePreviewId,
          onClosePreviewTab: ext.previewEvents.onClosePreviewTab,
          onCloseAllPreviews: ext.previewEvents.onCloseAllPreviews,
          onOpenPreviewLink: ext.previewEvents.onOpenPreviewLink,
        })}
      </div>
      {hasDetailContent && processDetails && processMessageId && ext.renderProcessTimeline(
        { processDetails: processDetails as NonNullable<ProcessDetailComputed["processDetails"]>, processMessageId },
        {},
        { onToggleAssistantProcess },
      )}
    </aside>
  );
}

function renderSessionDialog(
  { streamItems, sessionTitle, usageCount, sessionId, showProcess, processDetails, processMessageId, showPreview, activePreview, isDebugOpen }:
    { streamItems: StreamItem[]; sessionTitle: string; usageCount: number; sessionId: string | null; showProcess: boolean; processDetails: ReturnType<typeof assistantTurnDetails> | null; processMessageId: string | null; showPreview: boolean; activePreview: PreviewTab | null; isDebugOpen: boolean },
  { activeSessionId, activeProject, isRunningTurn, isInterruptingTurn, forkingMessageId, pendingPermission, isResolvingFileReferences, error, previewTabs, permissionState, selectedChatModel, chatModelOptions, msvProps, sessionUsageData }:
    { activeSessionId: string | null; activeProject: ProjectFolder | null; isRunningTurn: boolean; isInterruptingTurn: boolean; forkingMessageId: string | null; pendingPermission: any; isResolvingFileReferences: boolean; error: string | null; previewTabs: PreviewTab[]; permissionState: AgentPermissionState | null; selectedChatModel: string; chatModelOptions: string[]; msvProps: { assistantDebugBundles: Record<string, AssistantMessageDebugBundle>; getUsageSnapshotByBundleId: (bundleId: string) => BundleUsageSnapshot | null; currentBundleUsageVersion: number }; sessionUsageData: Record<string, BundleUsageSnapshot> },
  { onToggleSessionUsage, onToggleAssistantProcess, onOpenPreviewLink, onForkFromMessage, onSubmitPrompt, onInterruptTurn, onPermissionAllow, onPermissionDeny, onPermissionModeChange, onChatModelChange, onSetActivePreviewId, onClosePreviewTab, onCloseAllPreviews }:
    { onToggleSessionUsage: () => void; onToggleAssistantProcess: (messageId: string) => void; onOpenPreviewLink: (link: StreamLink) => void; onForkFromMessage: any; onSubmitPrompt: (input: { text: string; fileReferences: any[] }) => void; onInterruptTurn: () => void; onPermissionAllow: () => void; onPermissionDeny: () => void; onPermissionModeChange: (mode: string) => void; onChatModelChange: (model: string) => void; onSetActivePreviewId: (id: string | null) => void; onClosePreviewTab: (id: string) => void; onCloseAllPreviews: () => void },
  _ext?: { renderMessagesStream: (p: any) => JSX.Element; renderPromptInput: (p: any) => JSX.Element; renderPreviewPanel: (p: any) => JSX.Element },
) {
  const ext = _ext ?? { renderMessagesStream: () => <></>, renderPromptInput: () => <></>, renderPreviewPanel: () => <></> };
  return (
    <>
      <section className="exploration-panel" aria-label="Exploration stream">
        {render({ state: { sessionTitle, usageCount, sessionId }, props: {}, fn: renderSessionHeader, events: { onToggleSessionUsage } })}

        {ext.renderMessagesStream({ activeSessionId, activeProject, error, isRunningTurn, forkingMessageId, pendingPermission, isResolvingFileReferences, onOpenPreviewLink, onForkFromMessage, onToggleProcess: onToggleAssistantProcess, getStreamItems: (sid: string) => streamItems, ...msvProps })}

        {activeSessionId && isDebugOpen && (
          <div className="usage-overlay-backdrop" role="presentation" onClick={onToggleSessionUsage}>
            <div className="usage-overlay-panel" onClick={(e) => e.stopPropagation()}>
              <div className="usage-overlay-header">
                <button type="button" className="usage-overlay-close" onClick={onToggleSessionUsage}>×</button>
              </div>
              <SessionUsageDashboard activeSessionId={activeSessionId} usageByKey={sessionUsageData} />
            </div>
          </div>
        )}

        {ext.renderPromptInput({
          activeProject: activeProject?.root ?? null,
          activeSessionId,
          isRunningTurn,
          pendingPermission,
          isInterruptingTurn,
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
        })}
      </section>

      {render({
        state: { showProcess, processDetails, processMessageId, showPreview, activePreview },
        props: { previewTabs, activeProject },
        fn: renderDetailPanel,
        events: { onToggleAssistantProcess },
        exts: {
          renderPreviewPanel: ext.renderPreviewPanel,
          renderProcessTimeline: (pa: any, pb: any, pe: any) => render({ state: pa, props: pb, fn: renderProcessTimeline, events: pe }),
          previewEvents: { onSetActivePreviewId, onClosePreviewTab, onCloseAllPreviews, onOpenPreviewLink },
        },
      })}
    </>
  );
}

// 模块级引用：MSV 注册 setAssistantDebugBundles，session loading + useAgentTurn 通过 WriteState 写入
const _setAssistantDebugBundlesRef = { current: (() => {}) as any };

// ─── View component ──────────────────────────────────────────────────────

export function SessionDialogView({
  activeSessionId, activeProject, projects, setProjects, onSelectSession,
  error, setError, activeSessionTitle, permissionState, onPermissionModeChange,
  previewTabs, activePreview, onSetActivePreviewId, onClosePreviewTab, onCloseAllPreviews,
  onOpenPreviewLink, chatModelOptions, selectedChatModel, onChatModelChange,
  onForkFromMessage, onDetailPanelActiveChange,
}: SessionDialogProps) {
  // ── 共享 state ──
  const [isRunningTurn, setIsRunningTurn] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [isInterruptingTurn, setIsInterruptingTurn] = useState(false);
  const [pendingPermissions, setPendingPermissions] = useState<any[]>([]);
  const [isResolvingFileReferences, setIsResolvingFileReferences] = useState(false);
  const [isDebugOpen, setIsDebugOpen] = useState(false);

  // ── 全部的实时数据（event bus 唯一消费者） ──
  const [sessionStreams, setSessionStreams] = useState<Record<string, StreamItem[]>>({});
  const [assistantDebugBundles, setAssistantDebugBundles] = useState<Record<string, AssistantMessageDebugBundle>>({});
  const [streamUsageByBundleKey, setStreamUsageByBundleKey] = useState<Record<string, BundleUsageSnapshot>>({});
  const [currentBundleUsageVersion, setCurrentBundleUsageVersion] = useState(0);
  const [currentSessionUsageVersion, setCurrentSessionUsageVersion] = useState(0);
  const usageCostModelSettingsRef = useRef<ModelSettings | null>(null);
  const currentBundleBySessionRef = useRef<Record<string, string | null>>({});

  // 注册到模块 ref（供 useAgentTurn 写入 pending bundle）
  _setAssistantDebugBundlesRef.current = setAssistantDebugBundles;

  // 加载 model settings
  useEffect(() => {
    let cancelled = false;
    loadModelSettings()
      .then((settings) => { if (!cancelled) usageCostModelSettingsRef.current = settings; })
      .catch(() => { if (!cancelled) usageCostModelSettingsRef.current = null; });
    return () => { cancelled = true; };
  }, []);

  const getUsageSnapshotByBundleId = useCallback(
    (bundleId: string) => streamUsageByBundleKey[bundleUsageStorageKey(activeSessionId ?? "", bundleId)] ?? null,
    [streamUsageByBundleKey, activeSessionId],
  );

  // ── 唯一事件订阅：stream items + debug bundles + usage save ──
  useEffect(() => {
    startStreamEventListener();
    return onStreamEvent((event) => {
      const resolved = resolveRuntimeBundleEvent(event, currentBundleBySessionRef.current);
      const debugEntry = createDebugEvent(event);
      const realSessionId = event.eventType === "turn_complete" ? realSessionIdFromEvent(event) : null;
      if (event.eventType === "turn_text" || event.eventType === "tool_call") {
        console.timeEnd('[submit] total: 点击Send到UI展示');
      }

      // 1. Stream items
      setSessionStreams((streams) => ({
        ...streams,
        [event.sessionId]: collapseAssistantTurns(
          streamEventToItems(streams[event.sessionId] ?? [], resolved),
        ),
      }));

      if (realSessionId && realSessionId !== event.sessionId) {
        setSessionStreams((streams) => {
          const oldItems = streams[event.sessionId] ?? [];
          const existingNewItems = streams[realSessionId] ?? [];
          const { [event.sessionId]: _removed, ...rest } = streams;
          return { ...rest, [realSessionId]: existingNewItems.length > 0 ? existingNewItems : oldItems };
        });
      }

      // 2. Debug bundles + usage calculation + save
      setAssistantDebugBundles((bundles) => {
        const nextBundles = applyRuntimeDebugEventToBundle(bundles, resolved, debugEntry);
        const bundle = resolved.bundleId ? nextBundles[resolved.bundleId] : null;
        if (bundle) {
          const snapshot = calculateBundleUsageSnapshot(
            bundle,
            bundleUsageStatusFromEvent(event),
            resolved.completesBundle ? debugEntry.receivedAt : null,
            usageCostModelSettingsRef.current,
          );
          setStreamUsageByBundleKey((current) => ({ ...current, [bundleUsageStorageKey(snapshot.sessionId, snapshot.bundleId)]: snapshot }));
          const nowMs = Date.now();
          const lastSaveKey = `__lastSaveMs_${snapshot.sessionId}_${snapshot.bundleId}`;
          const lastSaveMs = (window as any)[lastSaveKey] ?? 0;
          const shouldSave = resolved.completesBundle || nowMs - lastSaveMs > 5_000;
          if (shouldSave && snapshot.usage.inputTokens + snapshot.usage.outputTokens > 0) {
            (window as any)[lastSaveKey] = nowMs;
            void saveBundleUsageSnapshot(snapshot).catch((reason) => {
              console.error('[usage] saveBundleUsageSnapshot failed:', reason);
            });
            setCurrentBundleUsageVersion((v) => v + 1);
          }
        }
        return nextBundles;
      });

      // 3. turn 结束事件 → bump session version
      if (event.eventType === "turn_complete" || event.eventType === "error" || event.eventType === "interrupt" || event.eventType === "process_exit") {
        setCurrentSessionUsageVersion((v) => v + 1);
      }
    });
  }, []);

  const activeStreamItems: StreamItem[] = activeSessionId
    ? (sessionStreams[activeSessionId] ?? [])
    : [];

  // Process 右侧面板 — 主动跟踪当前展开的 process 消息
  const [activeProcessMessageId, setActiveProcessMessageId] = useState<string | null>(null);
  const handleToggleProcess = useCallback((messageId: string) => {
    setActiveProcessMessageId((current) => (current === messageId ? null : messageId));
  }, []);

  const getStreamItems = useCallback(
    (sessionId: string) => sessionStreams[sessionId] ?? [],
    [sessionStreams],
  );

  const usageCount = activeSessionId
    ? Object.values(streamUsageByBundleKey).filter((s) => s.sessionId === activeSessionId).length
    : 0;
  const showPreviewVal = computeShowPreview(activeProject, activePreview);

  // 右侧 Process 面板数据
  const processDetails = useMemo(() => {
    if (!activeProcessMessageId || !activeSessionId) return null;
    const items = sessionStreams[activeSessionId] ?? [];
    const item = items.find(
      (s): s is Extract<StreamItem, { kind: "message" }> =>
        s.kind === "message" && s.role === "assistant" && s.id === activeProcessMessageId,
    );
    if (!item) return null;
    return assistantTurnDetails(item, assistantDebugBundles[activeProcessMessageId] ?? null);
  }, [activeProcessMessageId, activeSessionId, sessionStreams, assistantDebugBundles]);

  const showProcess = Boolean(processDetails?.timeline.length);

  // 通知父组件是否需要右侧详细面板（控制 CSS Grid 第三列）
  useEffect(() => {
    onDetailPanelActiveChange?.(showPreviewVal || showProcess);
  }, [showPreviewVal, showProcess, onDetailPanelActiveChange]);

  // ── WriteState registrations (给 session loading effect 用) ──
  WriteState.setIsRunningTurn = setIsRunningTurn;
  WriteState.setPendingPermissions = setPendingPermissions;
  WriteState.setIsResolvingFileReferences = setIsResolvingFileReferences;
  WriteState.setForkingMessageId = setForkingMessageId;
  WriteState.setIsInterruptingTurn = setIsInterruptingTurn;
  WriteState.setSessionStreams = setSessionStreams;
  WriteState.setAssistantDebugBundles = _setAssistantDebugBundlesRef.current;

  // ── 事件订阅 (turn/permission/session 管理) ──
  useEffect(() => {
    startStreamEventListener();
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
        agentTurnRef.current?.enqueuePendingPermission({
          root: event.root, sessionId: event.sessionId,
          messageId: `permission:${event.sessionId}:${requestId || Date.now()}`,
          requestId, prompt: promptText, toolName: tn, input: permInput,
          rawJson: event.payload.raw_json ?? event.payload, isQuestion, questions,
        });
        setIsRunningTurn(false);
      }

      if (event.eventType === "startup" || event.eventType === "process_status") {
        const pid = typeof event.payload.pid === "number" ? event.payload.pid : undefined;
        const running = event.eventType === "startup" ? true : event.payload.running === true;
        setProjects((folders) => folders.map((f) => ({
          ...f, sessions: f.sessions.map((s) =>
            s.id === event.sessionId ? { ...s, processStatus: running ? "active" : "stopped" as const, processPid: running ? pid : undefined } : s),
        })));
      }

      const realSessionId = event.eventType === "turn_complete" ? realSessionIdFromEvent(event) : null;
      if (realSessionId && realSessionId !== event.sessionId) {
        const pid = typeof event.payload.pid === "number" ? event.payload.pid : undefined;
        setProjects((folders) => folders.map((f) => {
          const sessions = f.sessions.map((s) =>
            s.id === event.sessionId ? { ...s, id: realSessionId, isPending: false, processStatus: "active" as const, processPid: pid ?? s.processPid } : s);
          return { ...f, sessions: sessions.filter((s, i, self) => self.findIndex((x) => x.id === s.id) === i) };
        }));
        setIsRunningTurn(true);
      }

      if (event.eventType === "turn_complete" || event.eventType === "error" || event.eventType === "interrupt" || event.eventType === "process_exit") {
        setIsRunningTurn(false);
        agentTurnRef.current?.clearPendingPermissionsForSession(event.sessionId);
      }

      if (event.eventType === "process_exit") {
        setProjects((folders) => folders.map((f) => ({
          ...f, sessions: f.sessions.map((s) =>
            s.id === event.sessionId ? { ...s, processStatus: "stopped" as const, processPid: undefined } : s),
        })));
      }

      if (event.eventType === "stderr") {
        const detail = String(event.payload?.text ?? event.payload?.message ?? "").toLowerCase();
        if (detail.includes("repl process stdout closed")) {
          setProjects((folders) => folders.map((f) => ({
            ...f, sessions: f.sessions.map((s) =>
              s.id === event.sessionId ? { ...s, processStatus: "stopped" as const, processPid: undefined } : s),
          })));
        }
        if (detail.includes("error") || detail.includes("failed") || detail.includes("missing_credentials")) {
          setIsRunningTurn(false);
          agentTurnRef.current?.clearPendingPermissionsForSession(event.sessionId);
        }
      }
    });
  }, [setProjects]);

  // ── Hook wiring ──
  const agentTurn = useAgentTurn({
    activeProject, activeSessionId, selectedChatModel, permissionState,
    updateSessionStream: (sessionId: string, updater: (items: StreamItem[]) => StreamItem[]) => {
      setSessionStreams((streams) => ({
        ...streams,
        [sessionId]: collapseAssistantTurns(updater(streams[sessionId] ?? [])),
      }));
    },
    setAssistantDebugBundles: _setAssistantDebugBundlesRef.current,
    refreshSessionContextUsage: async () => {},
    currentBundleBySessionRef,
    setProjects, setError,
    isRunningTurn, setIsRunningTurn, forkingMessageId, setForkingMessageId,
    isInterruptingTurn, setIsInterruptingTurn, pendingPermissions, setPendingPermissions,
    isResolvingFileReferences, setIsResolvingFileReferences,
  });
  const agentTurnRef = useRef(agentTurn);
  agentTurnRef.current = agentTurn;

  WriteState.handlePermissionAllow = () => agentTurn.handlePermissionDecision(true);
  WriteState.handlePermissionDeny = () => agentTurn.handlePermissionDecision(false);

  // ── Session loading effect ──
  useEffect(() => {
    if (!activeProject || !activeSessionId || agentTurn.isRunningTurn || agentTurn.pendingPermission?.sessionId === activeSessionId) return;
    if (activeProject.sessions.find((s) => s.id === activeSessionId)?.isPending) return;
    let cancelled = false;
    loadTypedRuntimeSession(activeProject.root, activeSessionId)
      .then((detail) => {
        if (cancelled) return;
        const artifacts = runtimeSessionToArtifacts(detail, activeProject.root);
        loadBundleUsageSnapshotsForSession(detail.id)
          .then((snapshots) => {
            setStreamUsageByBundleKey((current) => {
              const next = { ...current };
              for (const snapshot of snapshots) next[bundleUsageStorageKey(snapshot.sessionId, snapshot.bundleId)] = snapshot;
              return next;
            });
            setCurrentSessionUsageVersion((v) => v + 1);
          })
          .catch((reason) => console.warn("[bundle-usage] failed to hydrate history usage snapshots", { sessionId: detail.id, reason }));
        setAssistantDebugBundles((bundles) => ({ ...bundles, ...artifacts.bundles }));
        setSessionStreams((streams) => {
          if ((streams[activeSessionId] ?? []).length > 0) return streams;
          return { ...streams, [activeSessionId]: detail.messages.length > 0 ? artifacts.items : welcomeStream(activeProject.name, activeSessionTitle) };
        });
      })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [activeProject?.root, activeSessionId, activeSessionTitle, agentTurn.isRunningTurn, agentTurn.pendingPermission]);

  // ── 计算型 handlers ──
  const onToggleSessionUsage = () => setIsDebugOpen((c) => !c);

  return render({
    state: {
      streamItems: activeStreamItems, sessionTitle: activeProject?.sessions.find((s) => s.id === activeSessionId)?.title ?? "",
      usageCount, sessionId: activeSessionId,
      showProcess, processDetails, processMessageId: activeProcessMessageId,
      showPreview: showPreviewVal, activePreview, isDebugOpen,
    },
    props: {
      activeSessionId, activeProject, isRunningTurn: agentTurn.isRunningTurn,
      isInterruptingTurn: agentTurn.isInterruptingTurn, forkingMessageId: agentTurn.forkingMessageId,
      pendingPermission: agentTurn.pendingPermission, isResolvingFileReferences: agentTurn.isResolvingFileReferences,
      error, previewTabs, permissionState, selectedChatModel, chatModelOptions,
      msvProps: { assistantDebugBundles, getUsageSnapshotByBundleId, currentBundleUsageVersion },
      sessionUsageData: streamUsageByBundleKey,
    },
    fn: renderSessionDialog,
    events: {
      onToggleSessionUsage,
      onToggleAssistantProcess: handleToggleProcess,
      onOpenPreviewLink,
      onForkFromMessage,
      onSubmitPrompt: (input: any) => agentTurnRef.current?.submitPrompt(input),
      onInterruptTurn: agentTurn.handleInterruptTurn,
      onPermissionAllow: handlePermissionAllow,
      onPermissionDeny: handlePermissionDeny,
      onPermissionModeChange,
      onChatModelChange,
      onSetActivePreviewId,
      onClosePreviewTab,
      onCloseAllPreviews,
    },
    exts: { renderMessagesStream, renderPromptInput, renderPreviewPanel },
  });
}
