import {useCallback, useEffect, useRef, useState} from "react";
import type {StreamItem, StreamLink} from "../../types";
import type {BundleUsageSnapshot, BundleUsageTotals, ModelCallUsage, ModelCallUsageSnapshot} from "../../runtime";
import {UserMessageCard} from "./UserMessageCard";
import {AssistantMessageCard} from "./AssistantMessageCard";
import {MarkdownTablePreview} from "./preview-components";
import {SessionUsageDashboardView} from "./usage-dashboard";
import {addCallback} from "../../hooks/stream-event-bus";
import {bundleUsageStorageKey} from "../usage-cost";
import {loadModelCallUsages} from "../../runtime";
import {loadTypedRuntimeSession,} from "../../runtime";
import {runtimeSessionToArtifacts,} from "../debug-utils";
import {welcomeStream} from "../session";

// ─── WriteState（模块级单例）─────────────────────────────────────────
const WriteState: {
  setSessionStreamItems: (updater: StreamItem[] | ((prev: StreamItem[]) => StreamItem[])) => void;
} = {} as any;

// ─── Props ──────────────────────────────────────────────────────────

// ─── Adapter: ModelCallUsage[] → BundleUsageSnapshot ─────────────────

function buildBundleSnapshot(
  bundleId: string,
  sessionId: string,
  root: string,
  usages: ModelCallUsage[],
): BundleUsageSnapshot {
  let startedAtMs: number | null = null;
  let updatedAtMs: number | null = null;
  let totalCost: number | null = null;
  let hasCost = false;

  const modelCallIds: string[] = [];
  const modelCallUsages: ModelCallUsageSnapshot[] = usages.map((u) => {
    modelCallIds.push(u.modelCallId);
    if (u.startedAtMs != null && (startedAtMs == null || u.startedAtMs < startedAtMs)) {
      startedAtMs = u.startedAtMs;
    }
    if (u.updatedAtMs != null && (updatedAtMs == null || u.updatedAtMs > updatedAtMs)) {
      updatedAtMs = u.updatedAtMs;
    }
    if (u.costAmount != null) {
      totalCost = (totalCost ?? 0) + u.costAmount;
      hasCost = true;
    }
    return {
      modelCallId: u.modelCallId,
      model: u.model,
      stopReason: u.stopReason,
      startedAtMs: u.startedAtMs,
      usage: {
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        cache_read_input_tokens: u.cacheReadInputTokens,
        cache_creation_input_tokens: u.cacheCreationInputTokens,
      },
    };
  });

  const totals: BundleUsageTotals = {
    inputTokens: usages.reduce((s, u) => s + u.inputTokens, 0),
    outputTokens: usages.reduce((s, u) => s + u.outputTokens, 0),
    cacheReadInputTokens: usages.reduce((s, u) => s + u.cacheReadInputTokens, 0),
    cacheCreationInputTokens: usages.reduce((s, u) => s + u.cacheCreationInputTokens, 0),
    totalInputTokens: usages.reduce((s, u) => s + u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0),
  };

  const cost = hasCost
    ? {
        costAmount: totalCost,
        currency: "CNY",
        modelCosts: usages.map((u) => ({ modelCallId: u.modelCallId, costAmount: u.costAmount })),
      }
    : null;

  return {
    bundleId,
    sessionId,
    root,
    source: "history_load",
    status: "completed",
    startedAtMs,
    completedAtMs: updatedAtMs,
    updatedAtMs: updatedAtMs ?? 0,
    modelCallIds,
    modelCallUsages,
    usage: totals,
    cost,
  };
}

// ─── Props ──────────────────────────────────────────────────────────

export interface MessagesStreamProps {
  activeSessionId: string | null;
  activeProject: {
    root: string;
    name: string;
    sessions: Array<{ id: string; title: string }>;
  } | null;
  error: string | null;
  turnInfo: { current: "idle" | "running" | "interrupt" | "ctrl_block" | "forking"; prev: "idle" | "running" | "interrupt" | "ctrl_block" | "forking" };
  currentInput: { key: number; displayPrompt: string } | null;
  onToggleProcess: (messageId: string) => void;

  onOpenPreviewLink: (link: StreamLink) => void;
  onForkFromMessage: (item: Extract<StreamItem, { kind: "message" }>) => void;
}

// ─── File-level function: 从 Rust 后端加载历史消息 ─────────────────────

function loadHistoryStreamItems(
  root: string,
  sessionId: string,
  projectName: string,
  sessionTitle: string,
  onItems: (items: StreamItem[]) => void,
  onError: (err: string) => void,
): () => void {
  let cancelled = false;
  loadTypedRuntimeSession(root, sessionId)
    .then((detail) => {
      if (cancelled) return;
      const artifacts = runtimeSessionToArtifacts(detail, root);
      const items = detail.messages.length > 0
        ? artifacts.items
        : welcomeStream(projectName, sessionTitle);
      onItems(items);
    })
    .catch((reason) => {
      if (!cancelled) onError(String(reason));
    });
  return () => { cancelled = true; };
}

// ─── Component ──────────────────────────────────────────────────────

export function MessagesStreamView({
  activeSessionId,
  activeProject,
  error,
  turnInfo,
  currentInput,
  onOpenPreviewLink,
  onForkFromMessage,
  onToggleProcess,
}: MessagesStreamProps) {
  const streamRef = useRef<HTMLDivElement | null>(null);

  // ── 内部 state（event bus callback + 离线加载共用） ──
  const [sessionStreamItems, setSessionStreamItems] = useState<StreamItem[]>(() => []);
  // 注册 setter 供 WriteState 写入
  WriteState.setSessionStreamItems = setSessionStreamItems;

  const projectRoot = activeProject?.root ?? "";

  // ── 流式响应文本（运行时实时更新，turn 完成时清空） ──
  const [runningResponse, setRunningResponse] = useState("");

  // ── Session Usage overlay state ──
  const [showSessionUsage, setShowSessionUsage] = useState(false);
  const [sessionUsageLoading, setSessionUsageLoading] = useState(false);
  const [streamUsageByBundleKey, setStreamUsageByBundleKey] = useState<Record<string, BundleUsageSnapshot>>({});

  const handleSessionUsageClick = useCallback(async () => {
    if (sessionUsageLoading || !activeSessionId) return;
    setSessionUsageLoading(true);
    try {
      // 从 session JSONL 加载 bundle 数据（始终可靠，历史/流式都支持）
      const detail = await loadTypedRuntimeSession(projectRoot, activeSessionId);
      const artifacts = runtimeSessionToArtifacts(detail, projectRoot);
      
      // 只取当前 stream items 中存在的 assistant bundle
      const assistantIds = new Set(
        sessionStreamItems
          .filter(
            (item): item is Extract<StreamItem, { kind: "message" }> =>
              item.kind === "message" && item.role === "assistant" && !item.id.startsWith("assistant-pending-"),
          )
          .map((item) => item.id),
      );
      
      const bundleSnapshotMap: Record<string, BundleUsageSnapshot> = {};
      for (const [bundleId, bundle] of Object.entries(artifacts.bundles)) {
        if (!assistantIds.has(bundleId)) continue;
        const messageIds = bundle.modelCallIds;
        if (messageIds.length === 0) continue;
        const usages = await loadModelCallUsages(messageIds, activeSessionId);
        bundleSnapshotMap[bundleUsageStorageKey(activeSessionId, bundleId)] = buildBundleSnapshot(bundleId, activeSessionId, projectRoot, usages);
      }
      
      setStreamUsageByBundleKey(bundleSnapshotMap);
      setShowSessionUsage(true);
    } catch {
      // silent
    } finally {
      setSessionUsageLoading(false);
    }
  }, [activeSessionId, sessionStreamItems, sessionUsageLoading, projectRoot]);

  // ── 消费 currentInput：SessionDialog 提交后通知我们追加 user + pending items ──
  useEffect(() => {
    if (!currentInput) return;
    const pendingId = `assistant-pending-${Date.now()}`;
    setSessionStreamItems((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        kind: "message",
        role: "user",
        text: currentInput.displayPrompt,
        links: [],
        fileReferences: undefined,
      },
      {
        id: pendingId,
        kind: "message",
        role: "assistant",
        text: "Assistant is thinking…",
        status: "streaming",
      },
    ]);
  }, [currentInput]);

  // ── 事件 bus callback：提取流式文本 ──
  useEffect(() => {
    const unsub = addCallback("session-items", (data, sessionId) => {
      if (sessionId !== activeSessionId) return;
      if (!data) return;
      const d = data as { runningResponse: string };
      setRunningResponse(d.runningResponse);
    });
    return unsub;
  }, [activeSessionId]);

  // 切换 session 时清空残留的流式文本
  useEffect(() => { setRunningResponse(""); }, [activeSessionId]);

  // ── turn 完成时：从 JSONL 重新加载完整会话 ──
  useEffect(() => {
    if (turnInfo.prev !== "idle" && turnInfo.current === "idle" && runningResponse) {
      setRunningResponse("");
      if (!activeSessionId || !activeProject?.root) return;
      const session = activeProject.sessions.find((s) => s.id === activeSessionId);
      const sessionTitle = session?.title ?? "会话";
      loadHistoryStreamItems(
        activeProject.root,
        activeSessionId,
        activeProject.name,
        sessionTitle,
        (items) => setSessionStreamItems(items),
        (err) => console.error("[messages-stream] reload history failed:", err),
      );
    }
  }, [turnInfo, activeSessionId, activeProject?.root, runningResponse]);

  // ── 从 Rust 后端加载历史消息 ──
  useEffect(() => {
    if (!activeSessionId || !activeProject?.root) return;
    const session = activeProject.sessions.find((s) => s.id === activeSessionId);
    const sessionTitle = session?.title ?? "会话";
    return loadHistoryStreamItems(
      activeProject.root,
      activeSessionId,
      activeProject.name,
      sessionTitle,
      (items) => setSessionStreamItems(items),
      (err) => console.error("[messages-stream] load history failed:", err),
    );
  }, [activeSessionId, activeProject?.root]);

  // ── Auto-scroll ──
  // 使用 sessionStreamItems 确保 callback 更新的数据也能触发滚动
  useEffect(() => {
    if (turnInfo.current === "idle" && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [activeSessionId, sessionStreamItems.length, turnInfo]);

  // ── Render ──
  const sessionTitle =
    activeProject?.sessions.find((s) => s.id === activeSessionId)?.title ?? "";

  return (
    <>
      {error ? <div className="error-banner">{error}</div> : null}

      {activeSessionId ? (
        <header className="workspace-header">
          <div className="session-title-area">
            <div className="session-title">
              <span className="header-icon" aria-hidden="true">chat</span>
              <h1>{sessionTitle}</h1>
            </div>
            <button
              className="debug-toggle"
              type="button"
              onClick={handleSessionUsageClick}
              disabled={sessionUsageLoading}
            >
              Usage{sessionUsageLoading ? "…" : ""}
            </button>
          </div>
        </header>
      ) : null}

      <div className="stream" ref={streamRef}>
        {!activeSessionId ? (
          <div className="empty-chat-state">
            <strong>未选择会话</strong>
            <span>请先在左侧添加项目文件夹，然后创建或选择一个会话。</span>
          </div>
        ) : null}

        {activeSessionId
          ? sessionStreamItems.map((item) => {
              if (item.kind === "message") {
                if (item.role === "user") {
                  return (
                    <UserMessageCard
                      key={item.id}
                      item={item}
                      projectRoot={projectRoot}
                      onOpenPreviewLink={onOpenPreviewLink}
                    />
                  );
                }
                if (item.role === "assistant") {
                  return (
                    <AssistantMessageCard
                      key={item.id}
                      item={item}
                      sessionId={activeSessionId ?? ""}
                      projectRoot={projectRoot}
                      turnInfo={turnInfo}
                      runningResponse={runningResponse}
                      onToggleProcess={onToggleProcess}
                      onForkFromMessage={onForkFromMessage}
                      onOpenPreviewLink={onOpenPreviewLink}
                    />
                  );
                }
                return null;
              }

              if (item.kind === "system") {
                return (
                  <article className={`system-event ${item.subtype}`} key={item.id}>
                    <div className="stream-label">{item.title}</div>
                    <pre>{item.detail}</pre>
                  </article>
                );
              }

              if (item.kind === "tool") {
                return (
                  <article className={`tool-event ${item.status}`} key={item.id}>
                    <div className="stream-label">{item.title}</div>
                    <p>{item.detail}</p>
                  </article>
                );
              }

              const artifactPath = item.path;
              return (
                <article className="artifact-event" key={item.id}>
                  <div className="stream-label">{item.artifactKind}</div>
                  <h2>{item.title}</h2>
                  {item.artifactKind === "table" ? (
                    <MarkdownTablePreview content={item.preview} />
                  ) : item.artifactKind === "diff" ? (
                    <pre className="diff-view">{item.preview}</pre>
                  ) : (
                    <p>{item.preview}</p>
                  )}
                  {artifactPath ? (
                    <div className="message-links local-reference-links">
                      <button type="button" onClick={() =>
                        onOpenPreviewLink({
                          id: `artifact:${artifactPath}`,
                          label: item.title,
                          kind: item.artifactKind === "markdown" ? "markdown" : "report",
                          path: artifactPath,
                        })
                      }>
                        <span>{item.artifactKind}</span>
                        <strong>Open preview</strong>
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })
          : null}
      </div>

      {showSessionUsage ? (
        <div className="usage-overlay-backdrop" role="presentation" onClick={() => setShowSessionUsage(false)}>
          <div className="usage-overlay-panel" onClick={(e) => e.stopPropagation()}>
            <button
              className="usage-overlay-close"
              type="button"
              onClick={() => setShowSessionUsage(false)}
              aria-label="Close session usage"
            >
              ×
            </button>
            <SessionUsageDashboardView
              activeSessionId={activeSessionId}
              streamUsageByBundleKey={streamUsageByBundleKey}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
