import {useRef, useEffect} from "react";
import type {StreamItem, StreamLink} from "../../types";
import type {AssistantMessageDebugBundle, ProjectFolder,} from "../types";
import type {BundleUsageSnapshot} from "../../tauri";
import {AssistantUsageMiniOverlayView, SessionUsageDashboard} from "./usage-components";
import {MessageImagePreviews} from "./image-reference-view";
import {MarkdownTablePreview, RichMarkdownMessage} from "./preview-components";
import {
    assistantUsageButtonTitle,
    assistantUsageOutputDateTimeFromBundle,
    debugStorageSourceSummary,
    displayPromptText,
    displayRole,
    formatFileSize,
    localFileReferenceName,
    localFileReferencesFromPromptText,
    localFileReferenceSummaryToStreamLink,
} from "../file-utils";
import {assistantTurnDetails, compactCountLabel,} from "../debug-utils";
import {pendingAssistantText,} from "../stream-processor";
import {bundleUsageButtonLabel, bundleUsageStorageKey,} from "../usage-cost";

function renderPromptHighlightedText(value: string) {
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

export interface MessagesStreamProps {
  streamItems: StreamItem[];
  activeSessionId: string | null;
  assistantDebugBundles: Record<string, AssistantMessageDebugBundle>;
  streamUsageByBundleKey: Record<string, BundleUsageSnapshot>;
  openAssistantUsageMessageId: string | null;
  openAssistantDebugMessageId: string | null;
  openProcessMessageIds: Set<string>;
  isDebugOpen: boolean;
  copiedDebugMessageId: string | null;
  copyToast: string | null;
  error: string | null;
  activeProject: ProjectFolder | null;
  isRunningTurn: boolean;
  forkingMessageId: string | null;
  pendingPermission: { sessionId?: string } | null;
  isResolvingFileReferences: boolean;

  onToggleSessionUsage: () => void;
  onViewAssistantDebug: (messageId: string) => void;
  onCopyAssistantDebug: (item: Extract<StreamItem, { kind: "message" }>) => void;
  onViewAssistantUsage: (messageId: string) => void;
  onToggleAssistantProcess: (messageId: string) => void;
  onOpenPreviewLink: (link: StreamLink) => void;
  onSetOpenAssistantUsageMessageId: (id: string | null) => void;
  onSetIsDebugOpen: (open: boolean) => void;
  onForkFromMessage: (item: Extract<StreamItem, { kind: "message" }>) => void;
  assistantDebugPayload: (
    item: Extract<StreamItem, { kind: "message" }>,
    action: "view" | "copy",
  ) => Record<string, unknown>;
}

export function MessagesStreamView({
  streamItems,
  activeSessionId,
  assistantDebugBundles,
  streamUsageByBundleKey,
  openAssistantUsageMessageId,
  openAssistantDebugMessageId,
  openProcessMessageIds,
  isDebugOpen,
  copiedDebugMessageId,
  copyToast,
  error,
  activeProject,
  isRunningTurn,
  forkingMessageId,
  pendingPermission,
  isResolvingFileReferences,
  onViewAssistantDebug,
  onCopyAssistantDebug,
  onViewAssistantUsage,
  onToggleAssistantProcess,
  onOpenPreviewLink,
  onSetOpenAssistantUsageMessageId,
  onSetIsDebugOpen,
  onForkFromMessage,
  assistantDebugPayload,
}: MessagesStreamProps) {
  const streamRef = useRef<HTMLDivElement | null>(null);

  // 切换 session、消息加载完成、或轮次结束时，自动滚动到最新（底部）
  // 流式响应进行中不干预，由流式渲染自行控制滚动
  useEffect(() => {
    if (!isRunningTurn && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [activeSessionId, streamItems.length, isRunningTurn]);
  return (
    <>
      {copyToast ? (
        <div className="copy-toast" role="status">
          {copyToast}
        </div>
      ) : null}

      {openAssistantUsageMessageId && activeSessionId ? (
        <AssistantUsageMiniOverlayView
          bundleId={openAssistantUsageMessageId}
          snapshot={
            streamUsageByBundleKey[
              bundleUsageStorageKey(activeSessionId, openAssistantUsageMessageId)
            ] ?? null
          }
          onClose={() => onSetOpenAssistantUsageMessageId(null)}
        />
      ) : null}

      {activeSessionId && isDebugOpen ? (
        <div
          className="usage-overlay-backdrop"
          role="presentation"
          onClick={() => onSetIsDebugOpen(false)}
        >
          <section
            className="debug-panel usage-overlay-panel"
            aria-label="Usage metrics"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="usage-overlay-close"
              type="button"
              onClick={() => onSetIsDebugOpen(false)}
              aria-label="Close usage panel"
            >
              ×
            </button>
            <SessionUsageDashboard
              activeSessionId={activeSessionId}
              usageByKey={streamUsageByBundleKey}
            />
          </section>
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="stream" ref={streamRef}>
        {!activeSessionId ? (
          <div className="empty-chat-state">
            <strong>未选择会话</strong>
            <span>请先在左侧添加项目文件夹，然后创建或选择一个会话。</span>
          </div>
        ) : null}
        {activeSessionId
          ? streamItems.map((item) => {
              if (item.kind === "message") {
                if (item.role !== "assistant" && item.role !== "user") {
                  return null;
                }
                const assistantDebugBundle =
                  item.role === "assistant"
                    ? assistantDebugBundles[item.id]
                    : null;
                const assistantLiveUsage =
                  item.role === "assistant"
                    ? streamUsageByBundleKey[bundleUsageStorageKey(activeSessionId, item.id)]
                    : null;
                const isAssistantDebugOpen =
                  item.role === "assistant" &&
                  openAssistantDebugMessageId === item.id;
                const assistantDebugJson = isAssistantDebugOpen
                  ? JSON.stringify(assistantDebugPayload(item, "view"), null, 2)
                  : "";
                const assistantDetails =
                  item.role === "assistant"
                    ? assistantTurnDetails(item, assistantDebugBundle)
                    : null;
                const isProcessOpen =
                  item.role === "assistant" && openProcessMessageIds.has(item.id);
                const hasProcessDetails = Boolean(
                  assistantDetails &&
                    (assistantDetails.progressLines.length > 0 ||
                      assistantDetails.toolUses.length > 0 ||
                      assistantDetails.toolResults.length > 0 ||
                      assistantDetails.eventCount > 0 ||
                      item.status === "streaming"),
                );
                const assistantDisplayText =
                  item.role === "assistant" &&
                  item.status === "streaming" &&
                  item.text === pendingAssistantText
                    ? "正在等待最终回答…"
                    : item.text;
                const messageDisplayText =
                  item.role === "user" ? displayPromptText(item.text) : assistantDisplayText;
                const userFileReferences =
                  item.role === "user"
                    ? item.fileReferences?.length
                      ? item.fileReferences
                      : localFileReferencesFromPromptText(item.text)
                    : [];
                return (
                  <article
                    className={`stream-message ${item.role}`}
                    key={item.id}
                  >
                    <div className="message-avatar" aria-hidden="true">
                      {item.role === "user" ? "person" : "spark"}
                    </div>
                    <div className="message-body">
                      <div className="stream-label-row">
                        <div className="stream-label">
                          {displayRole(item.role)}
                        </div>
                        {item.role === "assistant" ? (
                          <>
                          <button
                            className={`message-debug-button ${copiedDebugMessageId === item.id ? "copied" : ""} ${isAssistantDebugOpen ? "active" : ""}`}
                            type="button"
                            onClick={() => onViewAssistantDebug(item.id)}
                            onDoubleClick={() => onCopyAssistantDebug(item)}
                            title="单击查看本条 Debug，双击复制 Debug JSON"
                          >
                            {copiedDebugMessageId === item.id
                              ? "已复制"
                              : `Debug${assistantDebugBundle?.events.length ? ` ${assistantDebugBundle.events.length}` : ""}`}
                          </button>
                          <button
                            className="message-debug-button"
                            type="button"
                            onClick={() => onViewAssistantUsage(item.id)}
                            title="查看 Usage"
                          >
                            <span>{bundleUsageButtonLabel(assistantLiveUsage)}</span>
                          </button>
                          <button
                            className="message-debug-button"
                            type="button"
                            onClick={() => onForkFromMessage(item)}
                            disabled={Boolean(
                              !item.checkpointUuid ||
                              isRunningTurn ||
                              Boolean(forkingMessageId) ||
                              pendingPermission ||
                              isResolvingFileReferences
                            )}
                            title={
                              item.checkpointUuid
                                ? "点击将从此消息位置fork一个新会话"
                                : "这条消息缺少 jsonl uuid，不能作为 fork checkpoint"
                            }
                          >
                            {forkingMessageId === item.id ? (
                              <>
                                <span className="message-fork-spinner" aria-hidden="true" />
                                <span>Forking…</span>
                              </>
                            ) : (
                              "Fork"
                            )}
                          </button>
                          {(() => {
                            const outputDateTime = assistantUsageOutputDateTimeFromBundle(assistantDebugBundle);
                            return outputDateTime ? (
                              <span
                                className="message-output-time"
                                title={assistantUsageButtonTitle(assistantDebugBundle)}
                              >
                                {outputDateTime}
                              </span>
                            ) : null;
                          })()}
                          </>
                        ) : null}
                      </div>
                      {item.role === "assistant" &&
                      assistantDetails &&
                      hasProcessDetails ? (
                        <div className="message-process-section">
                          <button
                            className="message-process-toggle"
                            type="button"
                            onClick={() => onToggleAssistantProcess(item.id)}
                          >
                            <span>过程 &gt;&gt;</span>
                            <small>
                              {compactCountLabel(
                                assistantDetails.progressLines.length,
                                "行过程",
                                "行过程",
                              )}
                              {" · "}
                              {compactCountLabel(
                                assistantDetails.commandUses.length,
                                "command",
                              )}
                              {" · "}
                              {compactCountLabel(
                                assistantDetails.toolUses.length,
                                "tool call",
                              )}
                              {" · "}
                              {compactCountLabel(
                                assistantDetails.toolResults.length,
                                "tool result",
                              )}
                              {" · "}
                              {compactCountLabel(
                                assistantDetails.eventCount,
                                "debug event",
                              )}
                            </small>
                          </button>
                        </div>
                      ) : null}
                      <div
                        className={`message-bubble ${
                          item.role === "assistant" && item.status === "streaming"
                            ? "streaming"
                            : ""
                        }`}
                      >
                        {item.role === "assistant" ? (
                          <div className="message-section-label">
                            {item.status === "streaming" ? "等待最终回答" : "最终回答"}
                          </div>
                        ) : null}
                        <RichMarkdownMessage content={messageDisplayText} />
                        {item.role === "user" && userFileReferences.length > 0 ? (
                          <div className="message-file-references" aria-label="Referenced files sent to Claude Code">
                            {userFileReferences.map((reference) => (
                              <button
                                className={`message-file-reference-chip ${reference.failed ? "failed" : ""}`}
                                key={reference.path}
                                title={reference.path}
                                type="button"
                                onClick={() => void onOpenPreviewLink(localFileReferenceSummaryToStreamLink(reference))}
                                disabled={Boolean(reference.failed)}
                              >
                                <span className="message-file-reference-icon" aria-hidden="true">@</span>
                                <span className="message-file-reference-name">
                                  {reference.name || localFileReferenceName(reference.path)}
                                </span>
                                <span className="message-file-reference-meta">
                                  {reference.failed
                                    ? "读取失败"
                                    : `${formatFileSize(reference.size_bytes)} · 注入 ${formatFileSize(reference.injected_bytes)}`}
                                  {reference.truncated ? " · 已截断" : ""}
                                </span>
                                <span className="message-file-reference-open">右侧预览</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                        <MessageImagePreviews root={activeProject?.root ?? ""} links={item.links} onOpen={onOpenPreviewLink} />
                        {item.links?.length ? (
                          <div className="message-links local-reference-links">
                            {item.links.map((link) => (
                              <button
                                key={link.id}
                                type="button"
                                onClick={() => onOpenPreviewLink(link)}
                              >
                                <span>{link.kind}</span>
                                <strong>{link.label}</strong>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      {isAssistantDebugOpen ? (
                        <div className="message-debug-panel">
                          <div className="message-debug-panel-header">
                            <span>
                              本条 AI 回复 Debug
                              {assistantDebugBundle?.events.length
                                ? ` · ${assistantDebugBundle.events.length} events`
                                : " · 0 events"}
                              {assistantDebugBundle?.events.length
                                ? ` · ${debugStorageSourceSummary(assistantDebugBundle.events)}`
                                : ""}
                            </span>
                            <button
                              type="button"
                              onClick={() => onCopyAssistantDebug(item)}
                            >
                              复制
                            </button>
                          </div>
                          <pre>{assistantDebugJson}</pre>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              }

              if (item.kind === "system") {
                return (
                  <article
                    className={`system-event ${item.subtype}`}
                    key={item.id}
                  >
                    <div className="stream-label">{item.title}</div>
                    <pre>{item.detail}</pre>
                  </article>
                );
              }

              if (item.kind === "tool") {
                return (
                  <article
                    className={`tool-event ${item.status}`}
                    key={item.id}
                  >
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
                      <button
                        type="button"
                        onClick={() =>
                          onOpenPreviewLink({
                            id: `artifact:${artifactPath}`,
                            label: item.title,
                            kind:
                              item.artifactKind === "markdown"
                                ? "markdown"
                                : item.artifactKind === "file"
                                  ? "file"
                                  : "report",
                            path: artifactPath,
                          })
                        }
                      >
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

export { renderPromptHighlightedText };
