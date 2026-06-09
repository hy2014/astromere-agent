import {useState, useMemo, useCallback} from "react";
import type {StreamItem, StreamLink} from "../../types";
import type {AssistantMessageDebugBundle} from "../types";
import type {BundleUsageSnapshot} from "../../tauri";
import {AssistantUsageMiniOverlayView} from "./assistant-usage-mini-overlay";
import {RichMarkdownMessage} from "./preview-components";
import {MessageImagePreviews} from "./image-reference-view";
import {debugStorageSource, debugStorageSourceCounts} from "../file-utils";
import {assistantTurnDetails, compactCountLabel, toolName, commandFromToolUse, summarizeToolUse} from "../debug-utils";
import {bundleUsageButtonLabel, bundleUsageStorageKey} from "../usage-cost";
import {pendingAssistantText} from "../stream-processor";


export interface AssistantMessageCardProps {
  item: Extract<StreamItem, { kind: "message" }>;
  assistantDebugBundle: AssistantMessageDebugBundle | null;
  assistantLiveUsage: BundleUsageSnapshot | null;
  streamUsageByBundleKey: Record<string, BundleUsageSnapshot> | null;
  projectRoot: string;
  turnStatus: "idle" | "running" | "interrupt" | "ctrl_block";
  forkingMessageId: string | null;
  pendingPermission: { sessionId?: string } | null;
  isResolvingFileReferences: boolean;

  onToggleProcess: (messageId: string) => void;
  onForkFromMessage: (item: Extract<StreamItem, { kind: "message" }>) => void;
  onOpenPreviewLink: (link: StreamLink) => void;
}

export function AssistantMessageCard({
  item,
  assistantDebugBundle,
  assistantLiveUsage,
  streamUsageByBundleKey = {} as Record<string, BundleUsageSnapshot>,
  projectRoot,
  turnStatus,
  forkingMessageId,
  pendingPermission,
  isResolvingFileReferences,
  onToggleProcess,
  onForkFromMessage,
  onOpenPreviewLink,
}: AssistantMessageCardProps) {
  // ── Local debug state (每个卡片自己管) ──
  const [isCopied, setIsCopied] = useState(false);
  // ── Local usage popover state ──
  const [isUsageOpen, setIsUsageOpen] = useState(false);

  const handleCopyDebug = useCallback(async () => {
    try {
      const bundle = assistantDebugBundle;
      const details = assistantTurnDetails(item, bundle ?? null);
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
        summary: {
          progressLineCount: details.progressLines.length,
          commandCount: details.commandUses.length,
          toolUseCount: details.toolUses.length,
          toolResultCount: details.toolResults.length,
          eventCount: details.eventCount,
        },
        debugSourceSummary: debugStorageSourceCounts(bundle?.events ?? []),
        commands: details.commandUses.map((t) => ({ name: toolName(t), command: commandFromToolUse(t), raw: t })),
        toolUses: details.toolUses.map((t) => ({ name: toolName(t), summary: summarizeToolUse(t), raw: t })),
        bundleDisplayText: bundle?.displayText ?? null,
        completed: bundle?.completed ?? null,
        eventCount: bundle?.events.length ?? 0,
        events: (bundle?.events ?? []).map((e) => ({
          eventType: e.eventType,
          receivedAt: new Date(e.receivedAt).toISOString(),
          debugStorageSource: debugStorageSource(e),
          payload: e.payload,
        })),
      };
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1600);
    } catch { /* silent */ }
  }, [item, assistantDebugBundle]);

  // ── Computed data ──
  const assistantDetails = useMemo(
    () => assistantTurnDetails(item, assistantDebugBundle ?? null),
    [item, assistantDebugBundle],
  );

  const hasProcessDetails =
    assistantDetails !== null &&
    (assistantDetails.progressLines.length > 0 ||
      assistantDetails.toolUses.length > 0 ||
      assistantDetails.toolResults.length > 0 ||
      assistantDetails.eventCount > 0 ||
      item.status === "streaming");

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
          debugEventCount={assistantDebugBundle?.events.length ?? 0}
          usageLabel={bundleUsageButtonLabel(assistantLiveUsage)}
          isForkDisabled={Boolean(
            !item.checkpointUuid || turnStatus !== "idle" ||
            Boolean(forkingMessageId) || pendingPermission || isResolvingFileReferences,
          )}
          forkLabel={forkingMessageId === item.id ? "Forking…" : "Fork"}
          onDebugCopy={handleCopyDebug}
          onUsageClick={() => setIsUsageOpen((v) => !v)}
          onForkClick={() => onForkFromMessage(item)}
        />

        {/* ═══ Usage overlay (本地管理) ═══ */}
        {isUsageOpen && (
          <AssistantUsageMiniOverlayView
            bundleId={item.id}
            snapshot={
              (streamUsageByBundleKey ?? {})[
                bundleUsageStorageKey("", item.id)
              ] ?? assistantLiveUsage ?? null
            }
            onClose={() => setIsUsageOpen(false)}
          />
        )}

        {/* ═══ ProcessView ═══ 过程折叠触发器 */}
        {hasProcessDetails && assistantDetails && (
          <ProcessView
            detail={assistantDetails}
            onToggle={() => onToggleProcess(item.id)}
          />
        )}

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
  debugEventCount: number;
  usageLabel: string;
  isForkDisabled: boolean;
  forkLabel: string;
  onDebugCopy: () => void;
  onUsageClick: () => void;
  onForkClick: () => void;
}

function Header({
  isCopied, debugEventCount, usageLabel,
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
        {isCopied ? "已复制" : `Debug${debugEventCount ? ` ${debugEventCount}` : ""}`}
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

// ═══ ProcessView sub-component ═══════════════════════════════════════

interface ProcessViewProps {
  detail: ReturnType<typeof assistantTurnDetails>;
  onToggle: () => void;
}

function ProcessView({ detail, onToggle }: ProcessViewProps) {
  if (!detail) return null;
  return (
    <div className="message-process-section">
      <button className="message-process-toggle" type="button" onClick={onToggle}>
        <span>过程 &gt;&gt;</span>
        <small>
          {compactCountLabel(detail.progressLines.length, "行过程", "行过程")}
          {" · "}
          {compactCountLabel(detail.commandUses.length, "command")}
          {" · "}
          {compactCountLabel(detail.toolUses.length, "tool call")}
          {" · "}
          {compactCountLabel(detail.toolResults.length, "tool result")}
          {" · "}
          {compactCountLabel(detail.eventCount, "debug event")}
        </small>
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
