import {useState, useCallback} from "react";
import type {StreamItem, StreamLink} from "../../types";
import type {AggregatedUsage} from "../usage-cost";
import {AssistantUsageMiniOverlayView} from "./assistant-usage-mini-overlay";
import {RichMarkdownMessage} from "./preview-components";
import {MessageImagePreviews} from "./image-reference-view";
import {pendingAssistantText} from "../stream-processor";
import {getSessionData} from "../../hooks/stream-event-bus";
import {loadModelCallUsages} from "../../tauri";
import {loadTypedRuntimeSession} from "../../runtime";
import {runtimeSessionToArtifacts} from "../debug-utils";
import {aggregateModelCallUsages} from "../usage-cost";


export interface AssistantMessageCardProps {
  item: Extract<StreamItem, { kind: "message" }>;
  sessionId: string;
  projectRoot: string;
  turnStatus: "idle" | "running" | "interrupt" | "ctrl_block" | "forking";
  pendingPermission: { sessionId?: string } | null;

  onToggleProcess: (messageId: string) => void;
  onForkFromMessage: (item: Extract<StreamItem, { kind: "message" }>) => void;
  onOpenPreviewLink: (link: StreamLink) => void;
}

export function AssistantMessageCard({
  item,
  sessionId,
  projectRoot,
  turnStatus,
  pendingPermission,
  onToggleProcess,
  onForkFromMessage,
  onOpenPreviewLink,
}: AssistantMessageCardProps) {
  // ── Local debug state (每个卡片自己管) ──
  const [isCopied, setIsCopied] = useState(false);
  // ── Local usage popover state ──
  const [usagePopup, setUsagePopup] = useState<AggregatedUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  const handleUsageClick = useCallback(async () => {
    if (usageLoading || !sessionId) return;
    setUsageLoading(true);
    try {
      const si = getSessionData<{ bundles: Record<string, string[]> }>(sessionId, "session-info");
      const messageIds = si?.bundles?.[item.id] ?? [];
      const usages = await loadModelCallUsages(messageIds, sessionId);
      setUsagePopup(aggregateModelCallUsages(usages));
    } catch {
      // silent
    } finally {
      setUsageLoading(false);
    }
  }, [sessionId, item.id, usageLoading]);

  const handleCopyDebug = useCallback(async () => {
    try {
      const detail = await loadTypedRuntimeSession(projectRoot, sessionId);
      const artifacts = runtimeSessionToArtifacts(detail, projectRoot);
      const bundle = artifacts.bundles[item.id];
      const payload = {
        kind: "agent-ui.assistant-message-debug",
        action: "copy",
        generatedAt: new Date().toISOString(),
        sessionId: bundle?.sessionId ?? null,
        root: bundle?.root ?? null,
        messageId: item.id,
        userMessage: bundle?.userMessage ?? null,
        transportMessage: bundle?.transportMessage ?? null,
        referencedFiles: bundle?.fileReferences ?? item.fileReferences ?? null,
        displayedMessage: item.text,
        displayedProgressText: item.progressText ?? null,
        displayStatus: item.status ?? null,
        bundleDisplayText: bundle?.displayText ?? null,
        completed: bundle?.completed ?? null,
        eventCount: bundle?.events.length ?? 0,
        events: (bundle?.events ?? []).map((e: any) => ({
          eventType: e.eventType,
          receivedAt: new Date(e.receivedAt).toISOString(),
          payload: e.payload,
        })),
      };
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1600);
    } catch { /* silent */ }
  }, [item, projectRoot, sessionId]);

  const displayText =
    item.status === "streaming" && item.text === pendingAssistantText
      ? "正在等待最终回答…"
      : item.text;

  return (
    <article className={`stream-message assistant${item.status === "streaming" ? " streaming" : ""}`}>
      <div className="message-avatar" aria-hidden="true">spark</div>
      <div className="message-body">

        {/* ═══ Header ═══ 操作栏，只触发不管理 */}
        <Header
          isCopied={isCopied}
          usageLabel={usageLoading ? "Loading…" : "Usage"}
          isForkDisabled={Boolean(
            !item.checkpointUuid || turnStatus !== "idle" ||
            pendingPermission,
          )}
          forkLabel={turnStatus === "forking" ? "Forking…" : "Fork"}
          onDebugCopy={handleCopyDebug}
          onUsageClick={handleUsageClick}
          onForkClick={() => onForkFromMessage(item)}
        />

        {/* ═══ Usage overlay (本地管理) ═══ */}
        {usagePopup && (
          <AssistantUsageMiniOverlayView
            bundleId={item.id}
            aggregated={usagePopup}
            onClose={() => setUsagePopup(null)}
          />
        )}

        {/* ═══ Process button ═══ 始终显示 */}
        <div className="message-process-section">
          <button
            className="message-process-toggle"
            type="button"
            onClick={() => onToggleProcess(item.id)}
          >
            <span>过程 &gt;&gt;</span>
          </button>
        </div>

        {/* ═══ Response ═══ 回复正文 */}
        <Response
          text={displayText}
          isStreaming={item.status === "streaming"}
          projectRoot={projectRoot}
          links={item.links}
          onOpenPreviewLink={onOpenPreviewLink}
        />

      </div>
    </article>
  );
}

// ═══ Header sub-component ═════════════════════════════════════════════

interface HeaderProps {
  isCopied: boolean;
  usageLabel: string;
  isForkDisabled: boolean;
  forkLabel: string;
  onDebugCopy: () => void;
  onUsageClick: () => void;
  onForkClick: () => void;
}

function Header({
  isCopied, usageLabel,
  isForkDisabled, forkLabel,
  onDebugCopy, onUsageClick, onForkClick,
}: HeaderProps) {
  return (
    <div className="stream-label-row">
      <div className="stream-label">Assistant</div>
      <button
        className={`message-debug-button ${isCopied ? "copied" : ""}`}
        type="button"
        onDoubleClick={onDebugCopy}
        title="双击复制 Debug JSON"
      >
        {isCopied ? "已复制" : "Debug"}
      </button>
      <button
        className="message-debug-button"
        type="button"
        onClick={onUsageClick}
        title="查看 Usage"
      >
        <span>{usageLabel}</span>
      </button>
      <button
        className="message-debug-button"
        type="button"
        onClick={onForkClick}
        disabled={isForkDisabled}
      >
        {forkLabel === "Forking…" ? (
          <>
            <span className="message-fork-spinner" aria-hidden="true" />
            <span>Forking…</span>
          </>
        ) : (
          "Fork"
        )}
      </button>
    </div>
  );
}

// ═══ Response sub-component ══════════════════════════════════════════

interface ResponseProps {
  text: string;
  isStreaming: boolean;
  projectRoot: string;
  links?: StreamLink[];
  onOpenPreviewLink: (link: StreamLink) => void;
}

function Response({ text, isStreaming, projectRoot, links, onOpenPreviewLink }: ResponseProps) {
  return (
    <div className={`message-bubble ${isStreaming ? "streaming" : ""}`}>
      <div className="message-section-label">
        {isStreaming ? "等待最终回答" : "最终回答"}
      </div>

      {/* 富文本正文 */}
      <RichMarkdownMessage content={text} />

      {/* 图片 */}
      <MessageImagePreviews root={projectRoot} links={links} onOpen={onOpenPreviewLink} />

      {/* FileReference 链接 / Artifact 入口 */}
      {links?.length ? (
        <div className="message-links local-reference-links">
          {links.map((link) => (
            <button key={link.id} type="button" onClick={() => onOpenPreviewLink(link)}>
              <span>{link.kind}</span>
              <strong>{link.label}</strong>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
