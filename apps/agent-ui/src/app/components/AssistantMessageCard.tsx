import {useCallback, useState} from "react";
import type {StreamItem, StreamLink} from "../../types";
import type {AggregatedUsage} from "../usage-cost";
import {aggregateModelCallUsages} from "../usage-cost";
import {AssistantUsageMiniOverlayView} from "./assistant-usage-mini-overlay";
import {RichMarkdownMessage} from "./preview-components";
import {MessageImagePreviews} from "./image-reference-view";
import {loadModelCallUsages} from "../../runtime";
import {loadTypedRuntimeSession} from "../../runtime";
import {runtimeSessionToArtifacts} from "../debug-utils";


export interface AssistantMessageCardProps {
  item: Extract<StreamItem, { kind: "message" }>;
  sessionId: string;
  projectRoot: string;
  turnInfo: { current: "idle" | "running" | "interrupt" | "ctrl_block" | "forking"; prev: "idle" | "running" | "interrupt" | "ctrl_block" | "forking" };
  runningResponse: string;

  onToggleProcess: (messageId: string) => void;
  onForkFromMessage: (item: Extract<StreamItem, { kind: "message" }>) => void;
  onOpenPreviewLink: (link: StreamLink) => void;
}

export function AssistantMessageCard({
  item,
  sessionId,
  projectRoot,
  turnInfo,
  runningResponse,
  onToggleProcess,
  onForkFromMessage,
  onOpenPreviewLink,
}: AssistantMessageCardProps) {
  // ── Local usage popover state ──
  const [usagePopup, setUsagePopup] = useState<AggregatedUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  const handleUsageClick = useCallback(async () => {
    if (usageLoading || !sessionId) return;
    setUsageLoading(true);
    try {
      const detail = await loadTypedRuntimeSession(projectRoot, sessionId);
      const artifacts = runtimeSessionToArtifacts(detail, projectRoot);
      const bundle = artifacts.bundles[item.id];
      const messageIds = bundle?.modelCallIds ?? [];
      const usages = await loadModelCallUsages(messageIds, sessionId);
      setUsagePopup(aggregateModelCallUsages(usages));
    } catch {
      // silent
    } finally {
      setUsageLoading(false);
    }
  }, [sessionId, item.id, projectRoot, usageLoading]);

  const displayText =
    item.status === "streaming"
      ? `Assistant is thinking…${runningResponse}`
      : item.text;

  return (
    <article className={`stream-message assistant${item.status === "streaming" ? " streaming" : ""}`}>
      <div className="message-avatar" aria-hidden="true">spark</div>
      <div className="message-body">

        {/* ═══ Header ═══ action bar: only triggers, does not manage */}
        <Header
          usageLabel={usageLoading ? "Loading…" : "Usage"}
          isForkDisabled={Boolean(
            !item.checkpointUuid || turnInfo.current !== "idle",
          )}
          forkLabel={turnInfo.current === "forking" ? "Forking…" : "Fork"}
          onUsageClick={handleUsageClick}
          onForkClick={() => onForkFromMessage(item)}
        />

        {/* ═══ Usage overlay (locally managed) ═══ */}
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

        {/* ═══ Response ═══ reply body */}
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
  usageLabel: string;
  isForkDisabled: boolean;
  forkLabel: string;
  onUsageClick: () => void;
  onForkClick: () => void;
}

function Header({
  usageLabel,
  isForkDisabled, forkLabel,
  onUsageClick, onForkClick,
}: HeaderProps) {
  return (
    <div className="stream-label-row">
      <div className="stream-label">Assistant</div>
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

      {/* Rich text body */}
      <RichMarkdownMessage content={text} />

      {/* Images */}
      <MessageImagePreviews root={projectRoot} links={links} onOpen={onOpenPreviewLink} />

      {/* FileReference links / Artifact entry */}
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
