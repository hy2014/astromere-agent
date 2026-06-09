import {useState, useRef, useEffect, useCallback, useMemo} from "react";
import type {AgentContextUsage, StreamLink, WorkspaceFileReference} from "../../types";
import {PermissionRequestView} from "./PermissionRequest";
import {AskQuestionCardView} from "./AskQuestionCard";
import {FileReferenceTrayView} from "./FileReferenceTray";
import {formatFileSize} from "../stream-processor";
import type {FileMentionState, LocalFileReference, SlashCommandMenuState, SlashRootItem,} from "../types";
import type {AgentReplCapabilityItem} from "../../runtime";
import {usePromptInput} from "../../hooks/usePromptInput";
import {onStreamEvent, startStreamEventListener} from "../../hooks/stream-event-bus";
import {getAgentContextUsage} from "../../runtime";
import {isNewSessionId} from "../file-utils";

interface AgentPermissionState {
  currentMode: string;
  availableModes: string[];
}

interface PromptInputAreaProps {
  // Session state
  activeProject: string | null;
  activeSessionId: string | null;
  turnStatus: "idle" | "running" | "interrupt" | "ctrl_block";
  pendingPermissions: any[];
  isResolvingFileReferences: boolean;

  // Permission state
  permissionState: AgentPermissionState | null;
  onPermissionModeChange: (mode: string) => void;

  // Model selection
  selectedChatModel: string;
  chatModelOptions: string[];
  onChatModelChange: (model: string) => void;

  // Callbacks from SessionDialogView
  onSubmitPrompt: (input: { text: string; fileReferences: LocalFileReference[] }) => void;
  onInterruptTurn: () => void;
  onPermissionAllow: (answers?: Record<string, string>) => void;
  onPermissionDeny: () => void;
  onOpenPreviewLink: (link: StreamLink) => void;
}

export function PromptInputAreaView(props: PromptInputAreaProps) {
  const {
    activeProject,
    activeSessionId,
    turnStatus,
    pendingPermissions,
    isResolvingFileReferences,
    permissionState,
    onPermissionModeChange,
    selectedChatModel,
    chatModelOptions,
    onChatModelChange,
    onSubmitPrompt,
    onInterruptTurn,
    onPermissionAllow,
    onPermissionDeny,
    onOpenPreviewLink,
  } = props;

  const pendingPermission = pendingPermissions.find((p) => p.sessionId === activeSessionId) ?? null;

  // ── Internal state ──
  const [prompt, setPrompt] = useState("");
  const [fileReferences, setFileReferences] = useState<LocalFileReference[]>([]);
  const [fileMention, setFileMention] = useState<FileMentionState>({
    active: false, query: "", start: 0, end: 0,
  });
  const [fileSuggestions, setFileSuggestions] = useState<WorkspaceFileReference[]>([]);
  const [fileSuggestionIndex, setFileSuggestionIndex] = useState(0);
  const [isSearchingFiles, setIsSearchingFiles] = useState(false);
  const [slashCommandMenu, setSlashCommandMenu] = useState<SlashCommandMenuState>({
    active: false, level: "root", query: "", start: 0, end: 0,
    selectedIndex: 0, skills: [], commands: [], isLoadingSkills: false,
  });

  // ── Context usage state (自管理：切换 session 时取，turn 完成时刷新) ──
  const [activeContextUsage, setActiveContextUsage] = useState<AgentContextUsage | null>(null);
  const [contextUsageError, setContextUsageError] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);

  // 切换 session 时拉取 context usage
  useEffect(() => {
    if (!activeSessionId || !activeProject || isNewSessionId(activeSessionId)) return;
    getAgentContextUsage(activeProject, activeSessionId)
      .then((usage) => {
        setContextUsageError(null);
        setActiveContextUsage(usage);
      })
      .catch((reason) => setContextUsageError(String(reason)));
  }, [activeSessionId, activeProject]);

  // 订阅 event bus：turn_complete/startup 刷新 + system 更新 compacting
  useEffect(() => {
    startStreamEventListener();
    return onStreamEvent((event) => {
      if (event.eventType === "turn_complete" || event.eventType === "startup") {
        const sid = event.sessionId;
        if (activeProject && sid && !isNewSessionId(sid)) {
          getAgentContextUsage(activeProject, sid)
            .then((usage) => {
              setContextUsageError(null);
              setActiveContextUsage(usage);
            })
            .catch((reason) => setContextUsageError(String(reason)));
        }
      }
      if (event.eventType === "system") {
        const payload = event.payload as Record<string, unknown>;
        if (payload.subtype === "status" && "status" in payload) {
          setIsCompacting(payload.status === "compacting");
        }
      }
    });
  }, [activeProject]);

  const contextUsageLabel = (usage: AgentContextUsage | null | undefined): string => {
    if (!usage) return "";
    const input = usage.data?.apiUsage?.input_tokens ?? 0;
    const total = usage.data?.totalTokens ?? "?";
    return `${input} / ${total}`;
  };

  // ── 用 ref 稳定回调，避免每次 keystroke 重建 onSubmitPrompt → handlePromptSubmit → handlePromptKeyDown ──
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const fileReferencesRef = useRef(fileReferences);
  fileReferencesRef.current = fileReferences;
  const onSubmitPromptRef = useRef(onSubmitPrompt);
  onSubmitPromptRef.current = onSubmitPrompt;

  const submitWithPrompt = useCallback(() => {
    console.time('[submit] total: 点击Send到UI展示');
    onSubmitPromptRef.current({ text: promptRef.current, fileReferences: fileReferencesRef.current });
    setPrompt("");
    setFileReferences([]);
    promptInputRef.current?.closeFileSuggestions();
  }, []);

  // ── 稳定对象引用，避免 usePromptInput 内 useEffect 无限循环 ──
  const activeProjectObj = useMemo(
    () => activeProject ? { root: activeProject } : null,
    [activeProject],
  );

  // ── Hook wiring ──
  const promptInput = usePromptInput({
    activeProject: activeProjectObj,
    activeSessionId,
    selectedChatModel,
    permissionMode: (permissionState?.currentMode ?? "default") as any,
    onSubmitPrompt: submitWithPrompt,
    prompt, setPrompt,
    fileReferences, setFileReferences,
    isResolvingFileReferences,
    setIsResolvingFileReferences: () => {},
    fileMention, setFileMention,
    fileSuggestions, setFileSuggestions,
    fileSuggestionIndex, setFileSuggestionIndex,
    isSearchingFiles, setIsSearchingFiles,
    slashCommandMenu, setSlashCommandMenu,
  });

  const promptInputRef = useRef(promptInput);
  promptInputRef.current = promptInput;

  // ── Derived values ──
  const canSendPrompt = Boolean(
    (prompt.trim() || fileReferences.length > 0),
  );

  return (
    <form className="prompt-box" onSubmit={promptInput.handlePromptSubmit}>
      <div className="prompt-frame">
        {pendingPermission && activeSessionId === pendingPermission.sessionId ? (
          pendingPermission.isQuestion ? (
            <AskQuestionCardView
              permission={pendingPermission}
              onConfirm={onPermissionAllow}
              onCancel={onPermissionDeny}
            />
          ) : (
            <PermissionRequestView
              permission={pendingPermission}
              onAllow={() => onPermissionAllow()}
              onDeny={onPermissionDeny}
            />
          )
        ) : null}
        <FileReferenceTrayView
          fileReferences={fileReferences}
          onOpenPreviewLink={onOpenPreviewLink}
          onRemoveReference={promptInput.removeFileReference}
        />
        <div className="prompt-input-wrap">
          <div
            ref={promptInput.promptHighlightRef as React.RefObject<HTMLDivElement>}
            className="prompt-highlight-layer"
            aria-hidden="true"
          >
            {promptInput.renderPromptHighlightedText(prompt)}
          </div>
          <textarea
            ref={promptInput.textareaRef as React.RefObject<HTMLTextAreaElement>}
            aria-label="Agent prompt"
            value={prompt}
            onChange={(event) =>
              promptInput.handlePromptChange(
                event.currentTarget.value,
                event.currentTarget.selectionStart ?? event.currentTarget.value.length,
              )
            }
            onCompositionStart={() => {
              promptInput.promptImeStateRef.current.isComposing = true;
              promptInput.markPromptImeActive(1000);
            }}
            onCompositionUpdate={() => {
              promptInput.promptImeStateRef.current.isComposing = true;
              promptInput.markPromptImeActive(1000);
            }}
            onCompositionEnd={() => {
              promptInput.promptImeStateRef.current.isComposing = false;
              promptInput.markPromptImeActive(350);
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
                promptInput.markPromptImeActive(1000);
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
                promptInput.promptImeStateRef.current.isComposing = false;
              }
            }}
            onClick={(event) => {
              const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
              promptInput.updateFileMentionFromInput(event.currentTarget.value, cursor);
              promptInput.updateSlashCommandMenuFromInput(event.currentTarget.value, cursor);
            }}
            onKeyUp={(event) => {
              const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
              promptInput.updateFileMentionFromInput(event.currentTarget.value, cursor);
              promptInput.updateSlashCommandMenuFromInput(event.currentTarget.value, cursor);
            }}
            onKeyDown={promptInput.handlePromptKeyDown}
            onScroll={(event) => {
              if (promptInput.promptHighlightRef.current) {
                promptInput.promptHighlightRef.current.scrollTop = event.currentTarget.scrollTop;
                promptInput.promptHighlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }
            }}
            placeholder={
              activeProject
                ? "Type a message, use @ to reference workspace files..."
                : "Add a project folder before starting a conversation..."
            }
            disabled={!activeProject || !activeSessionId || turnStatus !== "idle" || isResolvingFileReferences}
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
                      promptInput.selectFileSuggestion(reference);
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
                        promptInput.onSetSlashCommandMenu((current) => ({ ...current, level: "root", selectedIndex: 0 }));
                      }}
                    >
                      ←
                    </button>
                    <span>{promptInput.slashLeafTitle}</span>
                    <small>{promptInput.slashLeafDescription}</small>
                  </>
                )}
              </div>
              {slashCommandMenu.level === "root" ? (
                promptInput.slashRootOptions.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={index === slashCommandMenu.selectedIndex}
                    className={`slash-command-option ${index === slashCommandMenu.selectedIndex ? "active" : ""}`}
                    disabled={item.disabled}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      promptInput.selectSlashRootItem(item);
                    }}
                  >
                    <span className="slash-command-icon" aria-hidden="true">{item.id === "skills" ? "✦" : "›"}</span>
                    <span><strong>{item.label}</strong><small>{item.description}</small></span>
                  </button>
                ))
              ) : slashCommandMenu.isLoadingSkills ? (
                <div className="slash-command-empty">加载 {promptInput.slashLeafTitle.toLowerCase()} 中…</div>
              ) : slashCommandMenu.error ? (
                <div className="slash-command-empty">加载失败：{slashCommandMenu.error}</div>
              ) : promptInput.slashLeafOptions.length > 0 ? (
                promptInput.slashLeafOptions.map((skill, index) => (
                  <button
                    key={skill.slash || skill.name}
                    type="button"
                    role="option"
                    aria-selected={index === slashCommandMenu.selectedIndex}
                    className={`slash-command-option skill ${index === slashCommandMenu.selectedIndex ? "active" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      promptInput.selectSlashItem(skill);
                    }}
                  >
                    <span className="slash-command-icon skill" aria-hidden="true">/</span>
                    <span><strong>{skill.slash || `/${skill.name}`}</strong><small>{skill.description || "No description"}</small></span>
                    <em>{skill.kind === "skill" ? "Skill" : "Command"}</em>
                  </button>
                ))
              ) : (
                <div className="slash-command-empty">{promptInput.slashLeafEmptyText}</div>
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
                !activeProject || !activeSessionId || turnStatus !== "idle"
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
          {turnStatus !== "idle" || pendingPermission ? (
            <button
              className="send-button stop"
              type="button"
              onClick={onInterruptTurn}
              disabled={turnStatus === "interrupt"}
            >
              {turnStatus === "interrupt" ? "STOPPING" : "STOP"}
            </button>
          ) : null}
          <button
            className="send-button"
            type="submit"
            disabled={!canSendPrompt}
          >
            {isResolvingFileReferences ? "READING" : turnStatus !== "idle" ? "RUNNING" : "SEND"}
          </button>
        </div>
      </div>
    </form>
  );
}
