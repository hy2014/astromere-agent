import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type {
  StreamItem,
  StreamLink,
  AgentPermissionState,
  AgentContextUsage,
} from "../../types";
import type {
  AssistantMessageDebugBundle,
  ProjectFolder,
  PreviewTab,
  LocalFileReference,
  FileMentionState,
  SlashCommandMenuState,
  SlashRootItem,
  SessionUsageIndicatorKey,
} from "../types";
import type { WorkspaceFileReference } from "../../types";
import type { BundleUsageSnapshot } from "../../tauri";
import type { AgentReplCapabilityItem } from "../../runtime";
import type { ProjectSession } from "../types";
import { PreviewPanel } from "./PreviewPanel";
import { PromptInputArea } from "./PromptInputArea";
import { MessagesStream, renderPromptHighlightedText } from "./messages-stream";

// ─── SessionList ────────────────────────────────────────────────────────

export interface SessionListProps {
  project: ProjectFolder;
  activeSessionId: string | null;
  onSelectSession: (project: ProjectFolder, sessionId: string) => void;
  onCreateSession: (project: ProjectFolder) => void;
  onForkSession: (project: ProjectFolder, session: ProjectSession) => void;
  onHideSession: (project: ProjectFolder, session: ProjectSession) => void;
}

export function SessionList({
  project,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onForkSession,
  onHideSession,
}: SessionListProps) {
  const [openSessionMenu, setOpenSessionMenu] = useState<{
    root: string;
    sessionId: string;
  } | null>(null);

  return (
    <div className="tree-branch">
      {project.sessions.map((session) => {
        const isMenuOpen =
          openSessionMenu?.root === project.root &&
          openSessionMenu.sessionId === session.id;
        const isActiveSession = activeSessionId === session.id;
        const statusTitle =
          session.processStatus === "active"
            ? `running${session.processPid ? ` · pid ${session.processPid}` : ""}`
            : "not running";
        return (
          <div
            key={session.id}
            className={`tree-session-row ${isActiveSession ? "active" : ""}`}
          >
            <button
              className="tree-session-main"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelectSession(project, session.id);
              }}
            >
              <span
                className={`session-status-dot ${session.processStatus === "active" ? "active" : "stopped"}`}
                title={statusTitle}
                aria-label={statusTitle}
              />
              <span
                className="tree-label"
                title={session.title}
              >
                {session.title}
              </span>
            </button>
            <button
              className="session-menu-button"
              type="button"
              aria-label={`Open menu for ${session.title}`}
              aria-expanded={isMenuOpen}
              onClick={(event) => {
                event.stopPropagation();
                setOpenSessionMenu((current) =>
                  current?.root === project.root &&
                  current.sessionId === session.id
                    ? null
                    : {
                        root: project.root,
                        sessionId: session.id,
                      },
                );
              }}
            >
              ...
            </button>
            {isMenuOpen ? (
              <div className="session-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onForkSession(project, session);
                  }}
                >
                  Fork
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onHideSession(project, session);
                  }}
                >
                  删除
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
      <button
        className="tree-session create"
        type="button"
        onClick={() => onCreateSession(project)}
      >
        <span className="nav-icon tiny plain" aria-hidden="true">+</span>
        <span className="tree-label">新建会话</span>
      </button>
    </div>
  );
}

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
              className={`debug-toggle ${isDebugOpen ? "active" : ""}`}
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

      {activeProject && activePreview ? (
        <PreviewPanel
          activePreview={activePreview}
          previewTabs={previewTabs}
          activeProject={activeProject}
          onSetActivePreviewId={onSetActivePreviewId}
          onClosePreviewTab={onClosePreviewTab}
          onCloseAllPreviews={onCloseAllPreviews}
          onOpenPreviewLink={onOpenPreviewLink}
        />
      ) : null}
    </>
  );
}
