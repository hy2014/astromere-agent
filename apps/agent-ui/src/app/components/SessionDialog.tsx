import type {FormEvent, KeyboardEvent} from "react";
import type {
  AgentContextUsage,
  AgentPermissionState,
  StreamItem,
  StreamLink,
  WorkspaceFileReference,
} from "../../types";
import type {
  AssistantMessageDebugBundle,
  FileMentionState,
  LocalFileReference,
  PreviewTab,
  ProjectFolder,
  SlashCommandMenuState,
  SlashRootItem,
} from "../types";
import type {BundleUsageSnapshot} from "../../tauri";
import type {AgentReplCapabilityItem} from "../../runtime";
import {PreviewPanel} from "./PreviewPanel";
import {PromptInputArea} from "./PromptInputArea";
import {MessagesStream, renderPromptHighlightedText} from "./messages-stream";
import {assistantTurnDetails, compactCountLabel} from "../debug-utils";
import {formatDebugTime} from "../file-utils";
// ─── SessionDialog ──────────────────────────────────────────────────────

export interface SessionDialogProps {
  // Session
  activeSessionTitle: string;
  activeSessionId: string | null;
  isDebugOpen: boolean;
  onToggleSessionUsage: () => void;
  onSetIsDebugOpen: (open: boolean) => void;
  sessionUsageSnapshotsForSession: (
      usageByKey: Record<string, BundleUsageSnapshot>,
      sessionId: string | null,
  ) => BundleUsageSnapshot[];
  streamUsageByBundleKey: Record<string, BundleUsageSnapshot>;

  // MessagesStream props
  streamItems: StreamItem[];
  assistantDebugBundles: Record<string, AssistantMessageDebugBundle>;
  openAssistantUsageMessageId: string | null;
  openAssistantDebugMessageId: string | null;
  openProcessMessageIds: Set<string>;
  copiedDebugMessageId: string | null;
  copyToast: string | null;
  error: string | null;
  activeProject: ProjectFolder | null;
  isRunningTurn: boolean;
  isInterruptingTurn: boolean;
  forkingMessageId: string | null;
  pendingPermission: {
    root: string;
    sessionId: string;
    messageId: string;
    requestId: string;
    toolName?: string;
    prompt: string;
    input?: unknown;
  } | null;
  isResolvingFileReferences: boolean;
  onViewAssistantDebug: (messageId: string) => void;
  onCopyAssistantDebug: (item: Extract<StreamItem, { kind: "message" }>) => void;
  onViewAssistantUsage: (messageId: string) => void;
  onToggleAssistantProcess: (messageId: string) => void;
  onOpenPreviewLink: (link: StreamLink) => void;
  onSetOpenAssistantUsageMessageId: (id: string | null) => void;
  onForkFromMessage: (item: Extract<StreamItem, { kind: "message" }>) => void;
  assistantDebugPayload: (
      item: Extract<StreamItem, { kind: "message" }>,
      action: "view" | "copy",
  ) => Record<string, unknown>;

  // PromptInputArea props
  prompt: string;
  onPromptChange: (value: string, cursor: number) => void;
  onPromptKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent) => void;
  canSendPrompt: boolean;
  onInterruptTurn: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  promptHighlightRef: React.RefObject<HTMLDivElement | null>;
  promptImeStateRef: React.MutableRefObject<{
    isComposing: boolean;
    blockSubmitUntil: number;
  }>;
  markPromptImeActive: (ms?: number) => void;
  fileReferences: LocalFileReference[];
  onRemoveFileReference: (path: string) => void;
  fileMention: FileMentionState;
  fileSuggestions: WorkspaceFileReference[];
  fileSuggestionIndex: number;
  isSearchingFiles: boolean;
  onSelectFileSuggestion: (reference: WorkspaceFileReference) => void;
  onUpdateFileMentionFromInput: (value: string, cursor: number) => void;
  onUpdateSlashCommandMenuFromInput: (value: string, cursor: number) => void;
  slashCommandMenu: SlashCommandMenuState;
  slashRootOptions: SlashRootItem[];
  slashLeafOptions: AgentReplCapabilityItem[];
  slashLeafTitle: string;
  slashLeafDescription: string;
  slashLeafEmptyText: string;
  onSetSlashCommandMenu: (
      updater: (current: SlashCommandMenuState) => SlashCommandMenuState,
  ) => void;
  onSelectSlashRootItem: (item: SlashRootItem) => void;
  onSelectSlashItem: (item: AgentReplCapabilityItem) => void;
  onPermissionAllow: () => void;
  onPermissionDeny: () => void;
  onPermissionModeChange: (mode: string) => void;
  permissionState: AgentPermissionState | null;
  selectedChatModel: string;
  chatModelOptions: string[];
  onChatModelChange: (model: string) => void;
  contextUsageError: string | null;
  activeContextUsage: AgentContextUsage | null;
  contextUsageLabel: (usage: AgentContextUsage | null | undefined) => string;

  // PreviewPanel props
  previewTabs: PreviewTab[];
  activePreview: PreviewTab | null;
  onSetActivePreviewId: (id: string | null) => void;
  onClosePreviewTab: (id: string) => void;
  onCloseAllPreviews: () => void;
}

export function SessionDialog({
                                activeSessionTitle,
                                activeSessionId,
                                isDebugOpen,
                                onToggleSessionUsage,
                                onSetIsDebugOpen,
                                sessionUsageSnapshotsForSession,
                                streamUsageByBundleKey,
                                streamItems,
                                assistantDebugBundles,
                                openAssistantUsageMessageId,
                                openAssistantDebugMessageId,
                                openProcessMessageIds,
                                copiedDebugMessageId,
                                copyToast,
                                error,
                                activeProject,
                                isRunningTurn,
                                isInterruptingTurn,
                                forkingMessageId,
                                pendingPermission,
                                isResolvingFileReferences,
                                onViewAssistantDebug,
                                onCopyAssistantDebug,
                                onViewAssistantUsage,
                                onToggleAssistantProcess,
                                onOpenPreviewLink,
                                onSetOpenAssistantUsageMessageId,
                                onForkFromMessage,
                                assistantDebugPayload,
                                prompt,
                                onPromptChange,
                                onPromptKeyDown,
                                onSubmit,
                                canSendPrompt,
                                onInterruptTurn,
                                textareaRef,
                                promptHighlightRef,
                                promptImeStateRef,
                                markPromptImeActive,
                                fileReferences,
                                onRemoveFileReference,
                                fileMention,
                                fileSuggestions,
                                fileSuggestionIndex,
                                isSearchingFiles,
                                onSelectFileSuggestion,
                                onUpdateFileMentionFromInput,
                                onUpdateSlashCommandMenuFromInput,
                                slashCommandMenu,
                                slashRootOptions,
                                slashLeafOptions,
                                slashLeafTitle,
                                slashLeafDescription,
                                slashLeafEmptyText,
                                onSetSlashCommandMenu,
                                onSelectSlashRootItem,
                                onSelectSlashItem,
                                onPermissionAllow,
                                onPermissionDeny,
                                onPermissionModeChange,
                                permissionState,
                                selectedChatModel,
                                chatModelOptions,
                                onChatModelChange,
                                contextUsageError,
                                activeContextUsage,
                                contextUsageLabel,
                                previewTabs,
                                activePreview,
                                onSetActivePreviewId,
                                onClosePreviewTab,
                                onCloseAllPreviews,
                              }: SessionDialogProps) {
  const getDebugToggleClassName = (state: Record<string, never>, props: { isDebugOpen: boolean }) =>
      props.isDebugOpen ? "debug-toggle active" : "debug-toggle";
  const debugToggleClassName = getDebugToggleClassName({}, {isDebugOpen})

  return (
      <>
        <section className="exploration-panel" aria-label="Exploration stream">
          <header className="workspace-header">
            <div className="session-title-area">
              <div className="session-title">
              <span className="header-icon" aria-hidden="true">
                chat
              </span>
                <h1>{activeSessionTitle}</h1>
              </div>
              <button
                  className={debugToggleClassName}
                  type="button"
                  onClick={onToggleSessionUsage}
                  disabled={!activeSessionId}
              >
                Usage <span>{sessionUsageSnapshotsForSession(streamUsageByBundleKey, activeSessionId).length}</span>
              </button>
            </div>
            <input
                className="session-search"
                placeholder="Search session content..."
                aria-label="Search session content"
            />
          </header>

          <MessagesStream
              streamItems={streamItems}
              activeSessionId={activeSessionId}
              assistantDebugBundles={assistantDebugBundles}
              streamUsageByBundleKey={streamUsageByBundleKey}
              openAssistantUsageMessageId={openAssistantUsageMessageId}
              openAssistantDebugMessageId={openAssistantDebugMessageId}
              openProcessMessageIds={openProcessMessageIds}
              isDebugOpen={isDebugOpen}
              copiedDebugMessageId={copiedDebugMessageId}
              copyToast={copyToast}
              error={error}
              activeProject={activeProject}
              isRunningTurn={isRunningTurn}
              forkingMessageId={forkingMessageId}
              pendingPermission={pendingPermission}
              isResolvingFileReferences={isResolvingFileReferences}
              onToggleSessionUsage={onToggleSessionUsage}
              onViewAssistantDebug={onViewAssistantDebug}
              onCopyAssistantDebug={onCopyAssistantDebug}
              onViewAssistantUsage={onViewAssistantUsage}
              onToggleAssistantProcess={onToggleAssistantProcess}
              onOpenPreviewLink={onOpenPreviewLink}
              onSetOpenAssistantUsageMessageId={onSetOpenAssistantUsageMessageId}
              onSetIsDebugOpen={onSetIsDebugOpen}
              onForkFromMessage={onForkFromMessage}
              assistantDebugPayload={assistantDebugPayload}
          />

          <PromptInputArea
              activeProject={!!activeProject}
              activeSessionId={activeSessionId}
              isRunningTurn={isRunningTurn}
              pendingPermission={pendingPermission}
              isInterruptingTurn={isInterruptingTurn}
              isResolvingFileReferences={isResolvingFileReferences}
              permissionState={permissionState}
              onPermissionModeChange={onPermissionModeChange}
              selectedChatModel={selectedChatModel}
              chatModelOptions={chatModelOptions}
              onChatModelChange={onChatModelChange}
              contextUsageError={contextUsageError}
              activeContextUsage={activeContextUsage}
              contextUsageLabel={contextUsageLabel}
              prompt={prompt}
              onPromptChange={onPromptChange}
              onPromptKeyDown={onPromptKeyDown}
              onSubmit={onSubmit}
              canSendPrompt={canSendPrompt}
              onInterruptTurn={onInterruptTurn}
              textareaRef={textareaRef as React.RefObject<HTMLTextAreaElement>}
              promptHighlightRef={promptHighlightRef as React.RefObject<HTMLDivElement>}
              renderPromptHighlightedText={renderPromptHighlightedText}
              promptImeStateRef={promptImeStateRef}
              markPromptImeActive={markPromptImeActive}
              fileReferences={fileReferences}
              onRemoveFileReference={onRemoveFileReference}
              onOpenPreviewLink={onOpenPreviewLink}
              fileMention={fileMention}
              fileSuggestions={fileSuggestions}
              fileSuggestionIndex={fileSuggestionIndex}
              isSearchingFiles={isSearchingFiles}
              onSelectFileSuggestion={onSelectFileSuggestion}
              onUpdateFileMentionFromInput={onUpdateFileMentionFromInput}
              onUpdateSlashCommandMenuFromInput={onUpdateSlashCommandMenuFromInput}
              slashCommandMenu={slashCommandMenu}
              slashRootOptions={slashRootOptions}
              slashLeafOptions={slashLeafOptions}
              slashLeafTitle={slashLeafTitle}
              slashLeafDescription={slashLeafDescription}
              slashLeafEmptyText={slashLeafEmptyText}
              onSetSlashCommandMenu={onSetSlashCommandMenu}
              onSelectSlashRootItem={onSelectSlashRootItem}
              onSelectSlashItem={onSelectSlashItem}
              onPermissionAllow={onPermissionAllow}
              onPermissionDeny={onPermissionDeny}
          />
        </section>

        {(() => {
          // 确定当前显示的过程消息
          const processMessageId =
              openProcessMessageIds.size > 0
                  ? streamItems.find(
                  (s): s is Extract<StreamItem, { kind: "message" }> =>
                      s.kind === "message" &&
                      s.role === "assistant" &&
                      openProcessMessageIds.has(s.id),
              )?.id ?? null
                  : null;
          const processItem =
              processMessageId
                  ? streamItems.find(
                  (s): s is Extract<StreamItem, { kind: "message" }> =>
                      s.kind === "message" && s.role === "assistant" && s.id === processMessageId,
              ) ?? null
                  : null;
          const processDetails =
              processItem
                  ? assistantTurnDetails(processItem, assistantDebugBundles[processItem.id] ?? null)
                  : null;
          const showProcess = Boolean(processDetails && processDetails.timeline.length > 0);
          const hasDetailContent = showProcess && Boolean(processDetails);
          const showPreview = Boolean(activeProject && activePreview);

          if (!showPreview && !showProcess) return null;

          return (
              <aside className="detail-panel" aria-label="Detail panel">
                <div className="detail-content-base" style={{ display: showPreview && !showProcess ? undefined : 'none' }}>
                  {(activePreview) && (
                      <PreviewPanel
                          activePreview={activePreview}
                          previewTabs={previewTabs}
                          activeProject={activeProject}
                          onSetActivePreviewId={onSetActivePreviewId}
                          onClosePreviewTab={onClosePreviewTab}
                          onCloseAllPreviews={onCloseAllPreviews}
                          onOpenPreviewLink={onOpenPreviewLink}
                      />
                  )}
                </div>
                {(hasDetailContent) && (() => {
                  const pd = processDetails!;
                  return (
                    <div className="detail-content-overlay">
                      <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'flex', justifyContent: 'flex-end', padding: '4px 8px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                        <button
                            type="button"
                            onClick={() => onToggleAssistantProcess(processMessageId!)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#64748b', lineHeight: 1, padding: '2px 8px', borderRadius: 4 }}
                            aria-label="Close process panel"
                            onMouseOver={e => (e.currentTarget.style.background = '#e2e8f0')}
                            onMouseOut={e => (e.currentTarget.style.background = 'none')}
                        >
                          ×
                        </button>
                      </div>
                      <section className="file-workbench">
                        <div className="detail-header">
                          <div>
                            <div className="eyebrow">Assistant Process</div>
                            <h2>过程详情</h2>
                          </div>
                          <span className="count-label">
                      {compactCountLabel(pd.progressLines.length, "行过程", "行过程")}
                            {" · "}
                            {compactCountLabel(pd.commandUses.length, "command")}
                            {" · "}
                            {compactCountLabel(pd.toolUses.length, "tool call")}
                            {" · "}
                            {compactCountLabel(pd.toolResults.length, "tool result")}
                            {" · "}
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
                                    {entry.kind === "tool_call" ? (
                                        <code>{entry.detail}</code>
                                    ) : entry.kind === "tool_result" ? (
                                        <pre>{entry.detail}</pre>
                                    ) : entry.kind === "permission" ? (
                                        <p>{entry.detail}</p>
                                    ) : (
                                        <pre>{entry.detail}</pre>
                                    )}
                                  </div>
                                </li>
                            ))}
                          </ol>
                        </div>
                      </section>
                    </div>
                )})()}
              </aside>
          );
        })()}
      </>
  );
}
