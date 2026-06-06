import {useRef, useEffect} from "react";
import type {StreamItem, StreamLink} from "../../types";
import type {AssistantMessageDebugBundle} from "../types";
import type {BundleUsageSnapshot} from "../../tauri";
import {UserMessageCard} from "./UserMessageCard";
import {AssistantMessageCard} from "./AssistantMessageCard";
import {MarkdownTablePreview} from "./preview-components";

// ─── Exported utilities ─────────────────────────────────────────────

export function renderPromptHighlightedText(value: string) {
  const parts: Array<string | JSX.Element> = [];
  const tokenRegex = /(^|\s)(\/[A-Za-z0-9:_-]+|@(?:"[^"]+"|[^\s]+))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(value)) !== null) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    const tokenStart = match.index + prefix.length;
    const tokenEnd = tokenStart + token.length;

    if (tokenStart > lastIndex) {
      parts.push(value.slice(lastIndex, tokenStart));
    }

    const isSkill = token.startsWith("/");
    parts.push(
      <span
        key={`${tokenStart}-${token}`}
        className={isSkill ? "prompt-inline-skill-token" : "prompt-inline-file-token"}
      >
        {token}
      </span>,
    );

    lastIndex = tokenEnd;
  }

  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }

  return parts.length > 0 ? parts : "";
}

export function assistantDebugPayload(
  item: Extract<StreamItem, { kind: "message" }>,
  bundles: Record<string, AssistantMessageDebugBundle>,
  action: "view" | "copy",
): Record<string, unknown> {
  const bundle = bundles[item.id];
  return {
    kind: "agent-ui.assistant-message-debug" as const,
    action,
    generatedAt: new Date().toISOString(),
    sessionId: bundle?.sessionId ?? null,
    messageId: item.id,
    displayedMessage: item.text,
    completed: bundle?.completed ?? null,
    eventCount: bundle?.events.length ?? 0,
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
  isRunningTurn: boolean;
  forkingMessageId: string | null;
  pendingPermission: { sessionId?: string } | null;
  isResolvingFileReferences: boolean;
  getStreamItems: (sessionId: string) => StreamItem[];
  onToggleProcess: (messageId: string) => void;
  assistantDebugBundles: Record<string, AssistantMessageDebugBundle>;
  getUsageSnapshotByBundleId: (bundleId: string) => BundleUsageSnapshot | null;
  currentBundleUsageVersion: number;

  onOpenPreviewLink: (link: StreamLink) => void;
  onForkFromMessage: (item: Extract<StreamItem, { kind: "message" }>) => void;
}

// ─── Component ──────────────────────────────────────────────────────

export function MessagesStreamView({
  activeSessionId,
  activeProject,
  error,
  isRunningTurn,
  forkingMessageId,
  pendingPermission,
  isResolvingFileReferences,
  onOpenPreviewLink,
  onForkFromMessage,
  getStreamItems,
  onToggleProcess,
  assistantDebugBundles,
  getUsageSnapshotByBundleId,
  currentBundleUsageVersion,
}: MessagesStreamProps) {
  const streamRef = useRef<HTMLDivElement | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void currentBundleUsageVersion;

  // ── Auto-scroll ──
  const activeStreamItems = getStreamItems(activeSessionId ?? "");

  useEffect(() => {
    if (!isRunningTurn && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [activeSessionId, activeStreamItems.length, isRunningTurn]);

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
          ? activeStreamItems.map((item) => {
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
                      assistantDebugBundle={assistantDebugBundles[item.id] ?? null}
                      assistantLiveUsage={getUsageSnapshotByBundleId(item.id)}
                      streamUsageByBundleKey={null}
                      projectRoot={projectRoot}
                      isRunningTurn={isRunningTurn}
                      forkingMessageId={forkingMessageId}
                      pendingPermission={pendingPermission}
                      isResolvingFileReferences={isResolvingFileReferences}
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
