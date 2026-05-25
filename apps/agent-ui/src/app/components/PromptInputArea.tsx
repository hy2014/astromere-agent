import type { FormEvent } from "react";
import type { AgentContextUsage, StreamLink, WorkspaceFileReference } from "../../types";
import { PermissionRequest } from "./PermissionRequest";
import { FileReferenceTray } from "./FileReferenceTray";
import { formatFileSize } from "../stream-processor";
import type {
  LocalFileReference,
  FileMentionState,
  SlashCommandMenuState,
  SlashRootItem,
} from "../types";
import type { AgentReplCapabilityItem } from "../../runtime";

interface AgentPermissionState {
  currentMode: string;
  availableModes: string[];
}

interface PromptInputAreaProps {
  // Session state
  activeProject: boolean;
  activeSessionId: string | null;
  isRunningTurn: boolean;
  pendingPermission: {
    root: string;
    sessionId: string;
    messageId: string;
    requestId: string;
    toolName?: string;
    prompt: string;
    input?: unknown;
  } | null;
  isInterruptingTurn: boolean;
  isResolvingFileReferences: boolean;

  // Permission state
  permissionState: AgentPermissionState | null;
  onPermissionModeChange: (mode: string) => void;

  // Model selection
  selectedChatModel: string;
  chatModelOptions: string[];
  onChatModelChange: (model: string) => void;

  // Context usage
  contextUsageError: string | null;
  activeContextUsage: AgentContextUsage | null;
  contextUsageLabel: (usage: AgentContextUsage | null | undefined) => string;

  // Prompt input (managed by usePromptInput hook in App)
  prompt: string;
  onPromptChange: (value: string, cursor: number) => void;
  onPromptKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent) => void;
  canSendPrompt: boolean;
  onInterruptTurn: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  promptHighlightRef: React.RefObject<HTMLDivElement>;
  renderPromptHighlightedText: (value: string) => string | (string | JSX.Element)[];
  promptImeStateRef: { current: { isComposing: boolean; blockSubmitUntil: number } };
  markPromptImeActive: (ms?: number) => void;

  // File references
  fileReferences: LocalFileReference[];
  onRemoveFileReference: (path: string) => void;
  onOpenPreviewLink: (link: StreamLink) => void;

  // File mention
  fileMention: FileMentionState;
  fileSuggestions: WorkspaceFileReference[];
  fileSuggestionIndex: number;
  isSearchingFiles: boolean;
  onSelectFileSuggestion: (reference: WorkspaceFileReference) => void;
  onUpdateFileMentionFromInput: (value: string, cursor: number) => void;
  onUpdateSlashCommandMenuFromInput: (value: string, cursor: number) => void;

  // Slash command menu
  slashCommandMenu: SlashCommandMenuState;
  slashRootOptions: SlashRootItem[];
  slashLeafOptions: AgentReplCapabilityItem[];
  slashLeafTitle: string;
  slashLeafDescription: string;
  slashLeafEmptyText: string;
  onSetSlashCommandMenu: (updater: (current: SlashCommandMenuState) => SlashCommandMenuState) => void;
  onSelectSlashRootItem: (item: SlashRootItem) => void;
  onSelectSlashItem: (item: AgentReplCapabilityItem) => void;

  // Permission request
  onPermissionAllow: () => void;
  onPermissionDeny: () => void;
}

export function PromptInputArea(props: PromptInputAreaProps) {
  const {
    activeProject,
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
    contextUsageError,
    activeContextUsage,
    contextUsageLabel,
    prompt,
    onPromptChange,
    onPromptKeyDown,
    onSubmit,
    canSendPrompt,
    onInterruptTurn,
    textareaRef,
    promptHighlightRef,
    renderPromptHighlightedText,
    promptImeStateRef,
    markPromptImeActive,
    fileReferences,
    onRemoveFileReference,
    onOpenPreviewLink,
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
  } = props;

  return (
    <form className="prompt-box" onSubmit={onSubmit}>
      <div className="prompt-frame">
        {pendingPermission && activeSessionId === pendingPermission.sessionId ? (
          <PermissionRequest
            permission={pendingPermission}
            onAllow={onPermissionAllow}
            onDeny={onPermissionDeny}
          />
        ) : null}
        <FileReferenceTray
          fileReferences={fileReferences}
          onOpenPreviewLink={onOpenPreviewLink}
          onRemoveReference={onRemoveFileReference}
        />
        <div className="prompt-input-wrap">
          <div
            ref={promptHighlightRef as React.RefObject<HTMLDivElement>}
            className="prompt-highlight-layer"
            aria-hidden="true"
          >
            {renderPromptHighlightedText(prompt)}
          </div>
          <textarea
            ref={textareaRef as React.RefObject<HTMLTextAreaElement>}
            aria-label="Agent prompt"
            value={prompt}
            onChange={(event) =>
              onPromptChange(
                event.currentTarget.value,
                event.currentTarget.selectionStart ?? event.currentTarget.value.length,
              )
            }
            onCompositionStart={() => {
              promptImeStateRef.current.isComposing = true;
              markPromptImeActive(1000);
            }}
            onCompositionUpdate={() => {
              promptImeStateRef.current.isComposing = true;
              markPromptImeActive(1000);
            }}
            onCompositionEnd={() => {
              promptImeStateRef.current.isComposing = false;
              markPromptImeActive(350);
            }}
            onBeforeInput={(event) => {
              const nativeEvent = event.nativeEvent as Event & {
                isComposing?: boolean;
                inputType?: string;
              };

              if (
                nativeEvent.isComposing === true ||
                nativeEvent.inputType === "insertCompositionText"
              ) {
                markPromptImeActive(1000);
              }
            }}
            onInput={(event) => {
              const nativeEvent = event.nativeEvent as Event & {
                isComposing?: boolean;
                inputType?: string;
              };

              if (
                nativeEvent.isComposing !== true &&
                nativeEvent.inputType !== "insertCompositionText"
              ) {
                promptImeStateRef.current.isComposing = false;
              }
            }}
            onClick={(event) => {
              const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
              onUpdateFileMentionFromInput(event.currentTarget.value, cursor);
              onUpdateSlashCommandMenuFromInput(event.currentTarget.value, cursor);
            }}
            onKeyUp={(event) => {
              const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
              onUpdateFileMentionFromInput(event.currentTarget.value, cursor);
              onUpdateSlashCommandMenuFromInput(event.currentTarget.value, cursor);
            }}
            onKeyDown={onPromptKeyDown}
            onScroll={(event) => {
              if (promptHighlightRef.current) {
                promptHighlightRef.current.scrollTop = event.currentTarget.scrollTop;
                promptHighlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }
            }}
            placeholder={
              activeProject
                ? "Type a message, use @ to reference workspace files..."
                : "Add a project folder before starting a conversation..."
            }
            disabled={!activeProject || !activeSessionId || isRunningTurn || isResolvingFileReferences}
          />
          {fileMention.active ? (
            <div className="file-mention-menu" role="listbox">
              <div className="file-mention-menu-header">
                <span>@ 文件引用</span>
                <small>输入路径或文件名，Enter/Tab 选择</small>
              </div>
              {isSearchingFiles ? (
                <div className="file-mention-empty">搜索文件中…</div>
              ) : fileSuggestions.length > 0 ? (
                fileSuggestions.map((reference, index) => (
                  <button
                    key={reference.path}
                    type="button"
                    role="option"
                    aria-selected={index === fileSuggestionIndex}
                    className={`file-mention-option ${index === fileSuggestionIndex ? "active" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onSelectFileSuggestion(reference);
                    }}
                  >
                    <span className="file-mention-name">{reference.name}</span>
                    <span className="file-mention-path">{reference.path}</span>
                    <span className="file-mention-meta">
                      {formatFileSize(reference.size_bytes)}
                    </span>
                  </button>
                ))
              ) : (
                <div className="file-mention-empty">未找到匹配文件</div>
              )}
            </div>
          ) : null}
          {slashCommandMenu.active ? (
            <div className="slash-command-menu" role="listbox">
              <div className="slash-command-menu-header">
                {slashCommandMenu.level === "root" ? (
                  <>
                    <span>/ 功能菜单</span>
                    <small>选择能力类型，Enter/Tab 进入</small>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        onSetSlashCommandMenu((current) => ({ ...current, level: "root", selectedIndex: 0 }));
                      }}
                    >
                      ←
                    </button>
                    <span>{slashLeafTitle}</span>
                    <small>{slashLeafDescription}</small>
                  </>
                )}
              </div>
              {slashCommandMenu.level === "root" ? (
                slashRootOptions.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={index === slashCommandMenu.selectedIndex}
                    className={`slash-command-option ${index === slashCommandMenu.selectedIndex ? "active" : ""}`}
                    disabled={item.disabled}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onSelectSlashRootItem(item);
                    }}
                  >
                    <span className="slash-command-icon" aria-hidden="true">{item.id === "skills" ? "✦" : "›"}</span>
                    <span><strong>{item.label}</strong><small>{item.description}</small></span>
                  </button>
                ))
              ) : slashCommandMenu.isLoadingSkills ? (
                <div className="slash-command-empty">加载 {slashLeafTitle.toLowerCase()} 中…</div>
              ) : slashCommandMenu.error ? (
                <div className="slash-command-empty">加载失败：{slashCommandMenu.error}</div>
              ) : slashLeafOptions.length > 0 ? (
                slashLeafOptions.map((skill, index) => (
                  <button
                    key={skill.slash || skill.name}
                    type="button"
                    role="option"
                    aria-selected={index === slashCommandMenu.selectedIndex}
                    className={`slash-command-option skill ${index === slashCommandMenu.selectedIndex ? "active" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onSelectSlashItem(skill);
                    }}
                  >
                    <span className="slash-command-icon skill" aria-hidden="true">/</span>
                    <span><strong>{skill.slash || `/${skill.name}`}</strong><small>{skill.description || "No description"}</small></span>
                    <em>{skill.kind === "skill" ? "Skill" : "Command"}</em>
                  </button>
                ))
              ) : (
                <div className="slash-command-empty">{slashLeafEmptyText}</div>
              )}
            </div>
          ) : null}
        </div>
        <div className="prompt-actions">
          <label className="permission-chip">
            <span aria-hidden="true">lock</span>
            <select
              value={permissionState?.currentMode ?? "read-only"}
              onChange={(event) =>
                onPermissionModeChange(event.target.value)
              }
              disabled={!activeProject}
            >
              {(
                permissionState?.availableModes ?? [
                  "read-only",
                  "workspace-write",
                  "danger-full-access",
                ]
              ).map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
          <label className="permission-chip">
            <span aria-hidden="true">model</span>
            <select
              value={selectedChatModel}
              onChange={(event) =>
                onChatModelChange(event.target.value)
              }
              disabled={
                !activeProject || !activeSessionId || isRunningTurn
              }
            >
              {chatModelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>

          <span
            className="context-usage-chip"
            title={contextUsageError ?? activeContextUsage?.data?.model ?? "Context usage is available after the REPL has produced a response"}
          >
            {contextUsageLabel(activeContextUsage)}
          </span>
          <div className="prompt-tools">
            <button type="button" disabled title="Attach file">
              upload(todo)
            </button>
          </div>
          {isRunningTurn || pendingPermission ? (
            <button
              className="send-button stop"
              type="button"
              onClick={onInterruptTurn}
              disabled={isInterruptingTurn}
            >
              {isInterruptingTurn ? "STOPPING" : "STOP"}
            </button>
          ) : null}
          <button
            className="send-button"
            type="submit"
            disabled={!canSendPrompt}
          >
            {isResolvingFileReferences ? "READING" : isRunningTurn ? "RUNNING" : "SEND"}
          </button>
        </div>
      </div>
    </form>
  );
}
