import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { StreamLink, WorkspaceFileReference, PermissionMode } from "../types";
import type { AgentReplCapabilityItem } from "../runtime";
import { ensureAgentReplProcess, getAgentReplCapabilities, searchWorkspaceFiles } from "../runtime";
import type {
  LocalFileReference,
  FileMentionState,
  SlashCommandMenuState,
  SlashCommandMenuLevel,
  SlashRootItem,
} from "../app/types";
import { localFileReferenceName, extractPromptSkillToken, detectFileMention, detectSlashCommandMenu } from "../app/file-utils";
import { formatFileSize } from "../app/stream-processor";

export function renderPromptHighlightedText(value: string) {
  const parts: Array<string | JSX.Element> = [];
  const tokenRegex = /(^|\s)(\/[A-Za-z0-9:_-]+|@(?:"[^"]+"|[^\s]+))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(value)) !== null) {
    if (match.index > lastIndex) {
      parts.push(value.slice(lastIndex, match.index));
    }
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    if (prefix) {
      parts.push(prefix);
    }
    const isCommand = token.startsWith("/");
    parts.push(
      <mark
        key={match.index}
        className={`prompt-token-highlight ${isCommand ? "command" : "mention"}`}
      >
        {token}
      </mark>,
    );
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }

  return parts;
}

function localFileReferencesFromPromptText(text: string): { path: string; name: string }[] {
  const refs: { path: string; name: string }[] = [];
  const mentionRegex = /@(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    const name = match[1] ?? "";
    if (name) {
      refs.push({ path: name, name });
    }
  }
  return refs;
}

function displayPromptText(text: string): string {
  return text.replace(/@(\S+)/g, (_match, name) => `@${name}`);
}

// --- Hook ---

interface UsePromptInputOptions {
  activeProject: { root: string } | null;
  activeSessionId: string | null;
  selectedChatModel: string;
  permissionMode: PermissionMode;
  onSubmitPrompt: () => void;
  onOpenPreviewLink?: (link: StreamLink) => void;
}

interface UsePromptInputReturn {
  // State (needed by App / useAgentTurn)
  prompt: string;
  setPrompt: (value: string) => void;
  fileReferences: LocalFileReference[];
  setFileReferences: (
    value: LocalFileReference[] | ((prev: LocalFileReference[]) => LocalFileReference[]),
  ) => void;
  isResolvingFileReferences: boolean;
  setIsResolvingFileReferences: (value: boolean) => void;
  canSendPrompt: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  promptImeStateRef: React.MutableRefObject<{
    isComposing: boolean;
    blockSubmitUntil: number;
  }>;

  // Handlers for PromptInputArea
  handlePromptChange: (value: string, cursor: number) => void;
  handlePromptKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePromptSubmit: (event: FormEvent) => void;
  closeFileSuggestions: () => void;
  addFileReference: (reference: WorkspaceFileReference) => void;
  removeFileReference: (path: string) => void;
  selectFileSuggestion: (reference: WorkspaceFileReference) => void;
  updateFileMentionFromInput: (value: string, cursor: number) => void;
  updateSlashCommandMenuFromInput: (value: string, cursor: number) => void;
  selectSlashRootItem: (item: SlashRootItem) => void;
  selectSlashItem: (item: AgentReplCapabilityItem) => void;
  closeSlashCommandMenu: () => void;
  markPromptImeActive: (ms?: number) => void;
  isPromptSubmitBlockedByIme: () => boolean;
  isPromptImeKeyEvent: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;

  // Derived values for PromptInputArea
  fileMention: FileMentionState;
  fileSuggestions: WorkspaceFileReference[];
  fileSuggestionIndex: number;
  isSearchingFiles: boolean;
  slashCommandMenu: SlashCommandMenuState;
  slashRootOptions: SlashRootItem[];
  slashLeafOptions: AgentReplCapabilityItem[];
  slashLeafTitle: string;
  slashLeafDescription: string;
  slashLeafEmptyText: string;
  promptHighlightRef: React.RefObject<HTMLDivElement | null>;
  renderPromptHighlightedText: (value: string) => string | (string | JSX.Element)[];

  // Setter for slash command menu
  onSetSlashCommandMenu: (
    updater: (current: SlashCommandMenuState) => SlashCommandMenuState,
  ) => void;
}

export function usePromptInput({
  activeProject,
  activeSessionId,
  selectedChatModel,
  permissionMode,
  onSubmitPrompt,
}: UsePromptInputOptions): UsePromptInputReturn {
  const [prompt, setPrompt] = useState("");
  const [fileReferences, setFileReferences] = useState<LocalFileReference[]>([]);
  const [isResolvingFileReferences, setIsResolvingFileReferences] = useState(false);
  const [fileMention, setFileMention] = useState<FileMentionState>({
    active: false,
    query: "",
    start: 0,
    end: 0,
  });
  const [fileSuggestions, setFileSuggestions] = useState<WorkspaceFileReference[]>([]);
  const [fileSuggestionIndex, setFileSuggestionIndex] = useState(0);
  const [isSearchingFiles, setIsSearchingFiles] = useState(false);
  const [slashCommandMenu, setSlashCommandMenu] = useState<SlashCommandMenuState>({
    active: false,
    level: "root",
    query: "",
    start: 0,
    end: 0,
    selectedIndex: 0,
    skills: [],
    commands: [],
    isLoadingSkills: false,
  });

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const promptHighlightRef = useRef<HTMLDivElement | null>(null);
  const promptImeStateRef = useRef({
    isComposing: false,
    blockSubmitUntil: 0,
  });

  const canSendPrompt = Boolean(
    (prompt.trim() || fileReferences.length > 0),
  );

  // --- Load slash commands and skills ---
  useEffect(() => {
    if (
      !slashCommandMenu.active ||
      (slashCommandMenu.level !== "skills" && slashCommandMenu.level !== "commands") ||
      !activeProject ||
      !activeSessionId
    ) {
      return;
    }

    let cancelled = false;
    setSlashCommandMenu((current) => ({ ...current, isLoadingSkills: true, error: undefined }));

    ensureAgentReplProcess(activeProject.root, activeSessionId, selectedChatModel, permissionMode)
      .then((state) => getAgentReplCapabilities(activeProject.root, state.sessionId || activeSessionId))
      .then((capabilities) => {
        if (cancelled) return;
        setSlashCommandMenu((current) => ({
          ...current,
          commands: capabilities.commands ?? [],
          skills: capabilities.skills ?? [],
          selectedIndex: 0,
          isLoadingSkills: false,
        }));
      })
      .catch((reason) => {
        if (cancelled) return;
        setSlashCommandMenu((current) => ({
          ...current,
          commands: [],
          skills: [],
          selectedIndex: 0,
          isLoadingSkills: false,
          error: String(reason),
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [slashCommandMenu.active, slashCommandMenu.level, activeProject?.root, activeSessionId, selectedChatModel, permissionMode]);

  // --- Search files when file mention is active ---
  useEffect(() => {
    if (!fileMention.active || !activeProject) {
      setFileSuggestions([]);
      setFileSuggestionIndex(0);
      setIsSearchingFiles(false);
      return;
    }

    let cancelled = false;
    setIsSearchingFiles(true);
    const timer = window.setTimeout(() => {
      searchWorkspaceFiles(activeProject.root, fileMention.query, 12)
        .then((results) => {
          if (cancelled) {
            return;
          }
          setFileSuggestions(results);
          setFileSuggestionIndex(0);
        })
        .catch(() => {
          if (!cancelled) {
            setFileSuggestions([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsSearchingFiles(false);
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeProject, fileMention.active, fileMention.query]);

  // --- Derived slash command values ---
  const promptSkillToken = useMemo(() => extractPromptSkillToken(prompt), [prompt]);

  const slashRootOptions = useMemo(() => {
    const query = slashCommandMenu.query.trim().toLowerCase();
    if (!query) {
      return [
        { id: "skills", label: "Skills", description: "查看可用技能" },
        { id: "commands", label: "Commands", description: "查看可用命令" },
      ] as SlashRootItem[];
    }
    return [
      { id: "skills", label: "Skills", description: "查看可用技能" },
      { id: "commands", label: "Commands", description: "查看可用命令" },
    ].filter((item) =>
      `${item.label} ${item.description} ${item.id}`.toLowerCase().includes(query),
    ) as SlashRootItem[];
  }, [slashCommandMenu.query]);

  const filterCapabilityItems = useCallback(
    (items: AgentReplCapabilityItem[]) => {
      const query = slashCommandMenu.query.trim().toLowerCase();
      return items.filter((item) => {
        if (!query) return true;
        return [item.name, item.slash, item.description]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query);
      });
    },
    [slashCommandMenu.query],
  );

  const slashSkillOptions = useMemo(
    () => filterCapabilityItems(slashCommandMenu.skills),
    [slashCommandMenu.skills, filterCapabilityItems],
  );
  const slashCommandOptions = useMemo(
    () => filterCapabilityItems(slashCommandMenu.commands),
    [slashCommandMenu.commands, filterCapabilityItems],
  );
  const slashLeafOptions = slashCommandMenu.level === "commands" ? slashCommandOptions : slashSkillOptions;
  const slashLeafTitle = slashCommandMenu.level === "commands" ? "Commands" : "Skills";
  const slashLeafDescription =
    slashCommandMenu.level === "commands" ? "选择后插入 /command" : "选择后插入 /skill-name";
  const slashLeafEmptyText =
    slashCommandMenu.level === "commands" ? "没有可用 command" : "没有可用 skill";

  // --- Handlers ---

  const updateFileMentionFromInput = useCallback(
    (value: string, cursor: number) => {
      setFileMention(detectFileMention(value, cursor));
    },
    [],
  );

  const updateSlashCommandMenuFromInput = useCallback(
    (value: string, cursor: number) => {
      const fileState = detectFileMention(value, cursor);
      if (fileState.active) {
        setSlashCommandMenu((current) => ({ ...current, active: false }));
        return;
      }

      const slashState = detectSlashCommandMenu(value, cursor);
      if (!slashState.active) {
        setSlashCommandMenu((current) => ({ ...current, active: false }));
        return;
      }

      setSlashCommandMenu((current) => ({
        ...current,
        active: true,
        level:
          current.active && current.start === slashState.start
            ? current.level
            : "root",
        query: slashState.query,
        start: slashState.start,
        end: slashState.end,
        selectedIndex:
          current.active && current.start === slashState.start
            ? current.selectedIndex
            : 0,
      }));
    },
    [],
  );

  const handlePromptChange = useCallback(
    (value: string, cursor: number) => {
      setPrompt(value);
      updateFileMentionFromInput(value, cursor);
      updateSlashCommandMenuFromInput(value, cursor);
    },
    [updateFileMentionFromInput, updateSlashCommandMenuFromInput],
  );

  const closeFileSuggestions = useCallback(() => {
    setFileMention((current) => ({
      ...current,
      active: false,
      query: "",
    }));
    setFileSuggestions([]);
    setFileSuggestionIndex(0);
  }, []);

  const closeSlashCommandMenu = useCallback(() => {
    setSlashCommandMenu((current) => ({
      ...current,
      active: false,
      level: "root",
      query: "",
      selectedIndex: 0,
      error: undefined,
    }));
  }, []);

  const selectSlashRootItem = useCallback(
    (item: SlashRootItem) => {
      if (item.disabled) return;
      if (item.id === "skills" || item.id === "commands") {
        const level: SlashCommandMenuLevel = item.id;
        setSlashCommandMenu((current) => ({
          ...current,
          level,
          query: "",
          selectedIndex: 0,
        }));
      }
    },
    [],
  );

  const selectSlashItem = useCallback(
    (item: AgentReplCapabilityItem) => {
      const insertion = `${item.slash || `/${item.name}`} `;
      const nextPrompt = `${prompt.slice(0, slashCommandMenu.start)}${insertion}${prompt.slice(slashCommandMenu.end)}`;
      const nextCursor = slashCommandMenu.start + insertion.length;
      setPrompt(nextPrompt);
      closeSlashCommandMenu();
      closeFileSuggestions();
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [prompt, slashCommandMenu.start, slashCommandMenu.end, closeSlashCommandMenu, closeFileSuggestions],
  );

  const addFileReference = useCallback(
    (reference: WorkspaceFileReference) => {
      setFileReferences((current) => {
        if (current.some((item) => item.path === reference.path)) {
          return current;
        }
        return [...current, { ...reference, addedAt: Date.now() }];
      });
    },
    [],
  );

  const removeFileReference = useCallback((path: string) => {
    setFileReferences((current) =>
      current.filter((reference) => reference.path !== path),
    );
  }, []);

  const selectFileSuggestion = useCallback(
    (reference: WorkspaceFileReference) => {
      const mention = fileMention;
      const referenceLabel =
        reference.name || localFileReferenceName(reference.path);
      const insertion = `@${referenceLabel} `;
      const nextPrompt = `${prompt.slice(0, mention.start)}${insertion}${prompt.slice(mention.end)}`;
      const nextCursor = mention.start + insertion.length;

      setPrompt(nextPrompt);
      addFileReference(reference);
      closeFileSuggestions();

      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [fileMention, prompt, addFileReference, closeFileSuggestions],
  );

  const markPromptImeActive = useCallback((blockMs = 350) => {
    promptImeStateRef.current.blockSubmitUntil = Math.max(
      promptImeStateRef.current.blockSubmitUntil,
      performance.now() + blockMs,
    );
  }, []);

  const isPromptSubmitBlockedByIme = useCallback((): boolean => {
    return (
      promptImeStateRef.current.isComposing ||
      performance.now() < promptImeStateRef.current.blockSubmitUntil
    );
  }, []);

  const isPromptImeKeyEvent = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
        isComposing?: boolean;
        keyCode?: number;
        which?: number;
      };

      return (
        promptImeStateRef.current.isComposing ||
        nativeEvent.isComposing === true ||
        nativeEvent.keyCode === 229 ||
        nativeEvent.which === 229 ||
        event.key === "Process"
      );
    },
    [],
  );

  const handlePromptSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();

      if (isPromptSubmitBlockedByIme()) {
        return;
      }

      onSubmitPrompt();
    },
    [isPromptSubmitBlockedByIme, onSubmitPrompt],
  );

  const handlePromptKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const isPlainEnter =
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey;

      if (isPlainEnter) {
        if (isPromptImeKeyEvent(event)) {
          return;
        }

        if (isPromptSubmitBlockedByIme()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      if (slashCommandMenu.active) {
        const options =
          slashCommandMenu.level === "root"
            ? slashRootOptions
            : slashLeafOptions;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSlashCommandMenu((current) => ({
            ...current,
            selectedIndex: Math.min(
              current.selectedIndex + 1,
              Math.max(options.length - 1, 0),
            ),
          }));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSlashCommandMenu((current) => ({
            ...current,
            selectedIndex: Math.max(current.selectedIndex - 1, 0),
          }));
          return;
        }
        if (event.key === "Tab" || event.key === "Enter") {
          if (options.length > 0) {
            event.preventDefault();
            const selected =
              options[
                Math.min(
                  slashCommandMenu.selectedIndex,
                  options.length - 1,
                )
              ];
            if (slashCommandMenu.level === "root") {
              selectSlashRootItem(selected as SlashRootItem);
            } else {
              selectSlashItem(selected as AgentReplCapabilityItem);
            }
            return;
          }
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeSlashCommandMenu();
          return;
        }
      }

      if (fileMention.active && fileSuggestions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setFileSuggestionIndex((current) =>
            Math.min(current + 1, fileSuggestions.length - 1),
          );
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setFileSuggestionIndex((current) => Math.max(current - 1, 0));
          return;
        }
        if (event.key === "Tab" || event.key === "Enter") {
          event.preventDefault();
          selectFileSuggestion(
            fileSuggestions[fileSuggestionIndex] ?? fileSuggestions[0],
          );
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeFileSuggestions();
          return;
        }
      }

      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      event.preventDefault();
      onSubmitPrompt();
    },
    [
      slashCommandMenu,
      slashRootOptions,
      slashLeafOptions,
      fileMention,
      fileSuggestions,
      fileSuggestionIndex,
      isPromptImeKeyEvent,
      isPromptSubmitBlockedByIme,
      selectSlashRootItem,
      selectSlashItem,
      selectFileSuggestion,
      closeSlashCommandMenu,
      closeFileSuggestions,
      onSubmitPrompt,
    ],
  );

  return {
    // State needed by App
    prompt,
    setPrompt,
    fileReferences,
    setFileReferences,
    isResolvingFileReferences,
    setIsResolvingFileReferences,
    canSendPrompt,
    textareaRef,
    promptImeStateRef,

    // Handlers for PromptInputArea
    handlePromptChange,
    handlePromptKeyDown,
    handlePromptSubmit,
    closeFileSuggestions,
    addFileReference,
    removeFileReference,
    selectFileSuggestion,
    updateFileMentionFromInput,
    updateSlashCommandMenuFromInput,
    selectSlashRootItem,
    selectSlashItem,
    closeSlashCommandMenu,
    markPromptImeActive,
    isPromptSubmitBlockedByIme,
    isPromptImeKeyEvent,

    // Derived values for PromptInputArea
    fileMention,
    fileSuggestions,
    fileSuggestionIndex,
    isSearchingFiles,
    slashCommandMenu,
    slashRootOptions,
    slashLeafOptions,
    slashLeafTitle,
    slashLeafDescription,
    slashLeafEmptyText,
    promptHighlightRef,
    renderPromptHighlightedText,

    // Setter for slash command menu
    onSetSlashCommandMenu: setSlashCommandMenu,
  };
}
