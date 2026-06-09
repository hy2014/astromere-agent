import {useEffect, useRef, useState} from "react";
import type {StreamItem, StreamLink} from "../../types";
import {UserMessageCard} from "./UserMessageCard";
import {AssistantMessageCard} from "./AssistantMessageCard";
import {MarkdownTablePreview} from "./preview-components";
import {addCallback} from "../../hooks/stream-event-bus";
import {loadTypedRuntimeSession,} from "../../runtime";
import {runtimeSessionToArtifacts,} from "../debug-utils";
import {welcomeStream} from "../session";

// ─── WriteState（模块级单例）─────────────────────────────────────────
const WriteState: {
  setSessionStreamItems: (updater: StreamItem[] | ((prev: StreamItem[]) => StreamItem[])) => void;
} = {} as any;

// ─── Merge helper ──────────────────────────────────────────────────────
// handler 产出的 items（全是真实 ID）与 state 中的 items（可能含 pending 占位）合并。
// 合并规则：handler 的数据优先（真实 ID 覆盖 pending ID），新追加的项按顺序 append。

function mergeSessionItems(
  prev: StreamItem[],
  incoming: StreamItem[],
): StreamItem[] {
  const incomingMap = new Map(incoming.map((i) => [i.id, i]));
  const merged: StreamItem[] = [];

  for (const item of prev) {
    // pending 占位：找 incoming 里第一个不在 prevMap 中的 assistant 消息替换
    if (item.id.startsWith("assistant-pending-")) {
      const realItem = incoming.find(
        (i) =>
          i.kind === "message" &&
          i.role === "assistant" &&
          !incomingMap.has(i.id),
      );
      if (realItem) {
        merged.push(realItem);
        incomingMap.delete(realItem.id);
        continue;
      }
    }
    // 已有 ID 在 incoming 中 → 用 incoming 覆盖（更新）
    if (incomingMap.has(item.id)) {
      merged.push(incomingMap.get(item.id)!);
      incomingMap.delete(item.id);
    } else {
      merged.push(item);
    }
  }

  // 剩余的 incoming 项追加到末尾
  for (const item of incomingMap.values()) {
    merged.push(item);
  }

  return merged;
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
  turnStatus: "idle" | "running" | "interrupt" | "ctrl_block" | "forking";
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
  turnStatus,
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

  // ── 事件 bus callback ──
  useEffect(() => {
    const unsub = addCallback("session-items", (data, sessionId) => {
      if (sessionId !== activeSessionId) return;
      const incoming = (data as { items: StreamItem[] }).items;
      setSessionStreamItems((prev) => mergeSessionItems(prev, incoming));
    });
    return unsub;
  }, [activeSessionId]);

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
    if (turnStatus === "idle" && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [activeSessionId, sessionStreamItems.length, turnStatus]);

  // ── Render ──
  const projectRoot = activeProject?.root ?? "";

  return (
    <>
      {error ? <div className="error-banner">{error}</div> : null}

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
                      turnStatus={turnStatus}
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
    </>
  );
}
