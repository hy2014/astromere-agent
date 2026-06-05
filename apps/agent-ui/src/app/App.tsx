import {open as openDialog} from "@tauri-apps/plugin-dialog";
import {useEffect, useMemo, useRef, useState} from "react";
import type {RemoteProfile} from "../runtime";
import {
  addWorkspaceRegistryEntry,
  forkAgentReplProcess,
  getAgentPermissionState,
  getAgentReplProcessStatus,
  getDefaultWorkspace,
  killAgentReplProcess,
  listRuntimeSessions,
  loadModelSettings,
  loadTypedRuntimeSession,
  loadWorkspaceRegistry,
  openWorkspace,
  readGitDiff,
  readLocalReferenceFile,
  readWorkspaceFile,
  removeWorkspaceRegistryEntry,
  setAgentPermissionMode,
} from "../runtime";
import "../styles/mcp.css";
import "./App.css";
import {TerminalView} from "./Terminal";
import {RemoteTerminalPlaceholder} from "./RemoteTerminalPlaceholder";
import {SkillsView} from "./components/skills-view";
import {McpServersView} from "./components/mcp-servers-view";
import {SettingsView} from "./components/settings-view";
import {SessionDialog} from "./components/session";
import {WorkspaceTree} from "./components/workspace-tree";
import {useStreamState} from "../hooks/useStreamState";
import {useAgentTurn} from "../hooks/useAgentTurn";
import {usePromptInput} from "../hooks/usePromptInput"
import {
  createPendingSession,
  dedupeSessions,
  firstUserTitleFromStream,
  hiddenSessionsStorageKey,
  isNewSessionId,
  loadHiddenSessions,
  projectIdFromRoot,
  sessionKey,
  sessionsFromRuntimeSummaries,
  uniqueHiddenSessions,
  welcomeStream,
} from "./session";
import {
  clientDebugLog,
  debugStorageSource,
  debugStorageSourceCounts,
  loadActiveRemoteProfileSnapshot,
  loadTypedRuntimeSessionWithRetry,
  shouldReadAsLocalReference,
} from "./file-utils";
import {bundleUsageStorageKey,} from "./usage-cost";
import {collapseAssistantTurns,} from "./stream-processor";
import {
  assistantTurnDetails,
  commandFromToolUse,
  runtimeSessionToArtifacts,
  summarizeToolUse,
  toolName,
} from "./debug-utils";
import type {AgentPermissionState, AgentReplStreamEvent, PermissionMode, StreamItem, StreamLink,} from "../types";
import {loadBundleUsageSnapshotsForSession, sqliteDatabaseInfo,} from "../tauri";
import type {
  AppView,
  HiddenSession,
  PreviewTab,
  ProjectFolder,
  ProjectSession,
  SessionUsageIndicatorKey,
  SlashRootItem,
} from "./types";

// Types moved to ./types

const maxReferencedFileBytes = 48 * 1024;
const maxReferencedFilesTotalBytes = 160 * 1024;

const slashRootItems: SlashRootItem[] = [
  { id: "skills", label: "Skills", description: "Use a project or user skill" },
  { id: "commands", label: "Commands", description: "Built-in slash commands" },
  { id: "agents", label: "Agents", description: "Delegate to sub-agents, coming soon", disabled: true },
  { id: "workflows", label: "Workflows", description: "Run workflow templates, coming soon", disabled: true },
];

// AppView is imported from ./types

const previewablePathPattern =
  /(?:^|[\s([`"'])((?:(?:~|～)\/|\/|[A-Za-z0-9_.@-]+\/)[^\n`"'<>|]*?\.(?:ck|rs|ts|tsx|js|jsx|json|toml|md|markdown|txt|csv|pdf|png|jpg|jpeg|gif|webp|svg|html|css|py|go|java|kt|swift|c|cc|cpp|h|hpp|yaml|yml|sql|sh|zsh|fish|rb|php|vue|svelte))(?:$|[\s)\]，。,.!?;:'"`])/gi;

type ResolvedRuntimeBundleEvent = {
  event: AgentReplStreamEvent;
  bundleId: string | null;
  previousBundleId: string | null;
  modelCallId: string | null;
  createsBundle: boolean;
  completesBundle: boolean;
};

const terminalStopReasons = new Set([
  "tool_use",
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "pause_turn",
  "refusal",
]);


const sessionUsageIndicatorOptions: Array<{
  key: SessionUsageIndicatorKey;
  label: string;
}> = [
  { key: "costAmount", label: "Cost" },
  { key: "totalInputTokens", label: "Total input" },
  { key: "inputTokens", label: "Input" },
  { key: "outputTokens", label: "Output" },
  { key: "cacheReadInputTokens", label: "Cache hit input" },
  { key: "cacheCreationInputTokens", label: "Cache create input" },
  { key: "hitRate", label: "Hit rate" },
  { key: "modelCallCount", label: "Model calls" },
];

export function App() {
  useEffect(() => {
    void sqliteDatabaseInfo()
      .then((info) => {
        console.info("[sqlite] database ready", info.path);
      })
      .catch((reason) => {
        console.warn("[sqlite] database init failed", reason);
      });
  }, []);

  const [projects, setProjects] = useState<ProjectFolder[]>([]);
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);

  const streamState = useStreamState();
  const {
    sessionStreams,
    sessionDebugEvents,
    assistantDebugBundles,
    streamUsageByBundleKey,
    sessionContextUsageById,
    contextUsageError,
    isCompactingBySession,
    copiedDebugMessageId,
    openAssistantDebugMessageId,
    openAssistantUsageMessageId,
    openProcessMessageIds,
    copyToast,
    isDebugOpen,
    setSessionStreams,
    setAssistantDebugBundles,
    setStreamUsageByBundleKey,
    setSessionContextUsageById,
    setContextUsageError,
    setCopiedDebugMessageId,
    setOpenAssistantDebugMessageId,
    setOpenAssistantUsageMessageId,
    setOpenProcessMessageIds,
    setCopyToast,
    setIsDebugOpen,
    currentBundleBySessionRef,
    updateSessionStream,
    refreshSessionContextUsage,
    contextUsageLabel,
    bundleUsageButtonLabel: bundleUsageButtonLabelHook,
    sessionUsageSnapshotsForSession,
    handleToggleAssistantProcess,
    handleToggleSessionUsage,
    handleViewAssistantUsage,
    handleViewAssistantDebug,
    handleCopyAssistantDebug,
    registerTurnHandlers,
  } = streamState;

  const [hiddenSessions, setHiddenSessions] = useState<HiddenSession[]>(() =>
    loadHiddenSessions(),
  );
  const [remotePathPrompt, setRemotePathPrompt] = useState<string | null>(null);
  const remotePathPromptResolve = useRef<((value: string | null) => void) | null>(null);
  const [permissionState, setPermissionState] =
    useState<AgentPermissionState | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AppView>("workspace");
  const [error, setError] = useState<string | null>(null);
  const [chatModelOptions, setChatModelOptions] = useState<string[]>([
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ]);
  const [selectedChatModel, setSelectedChatModel] =
    useState<string>("deepseek-v4-flash");

  const [activeRemoteProfile] = useState<RemoteProfile | null>(
    () => loadActiveRemoteProfileSnapshot(),
  );

  const runtimeBadgeTitle = activeRemoteProfile
    ? `Remote runtime: ${activeRemoteProfile.name} · ${activeRemoteProfile.baseUrl}`
    : "Local runtime";

  const activePreview =
    previewTabs.find((tab) => tab.id === activePreviewId) ??
    previewTabs[0] ??
    null;
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;

  const promptInput = usePromptInput({
    activeProject,
    activeSessionId,
    selectedChatModel,
    permissionMode: (permissionState?.currentMode ?? "default") as PermissionMode,
    onSubmitPrompt: () => agentTurn.submitPrompt(),
  });
  const {
    prompt,
    setPrompt,
    fileReferences,
    setFileReferences,
    handlePromptChange,
    handlePromptKeyDown,
    handlePromptSubmit,
    closeFileSuggestions,
    removeFileReference,
    markPromptImeActive,
    isResolvingFileReferences: promptIsResolving,
    canSendPrompt,
    textareaRef,
    promptHighlightRef,
    promptImeStateRef,
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
    onSetSlashCommandMenu,
    selectFileSuggestion,
    selectSlashRootItem,
    selectSlashItem,
    updateFileMentionFromInput,
    updateSlashCommandMenuFromInput,
  } = promptInput;

  const agentTurn = useAgentTurn({
    activeProject,
    activeSessionId,
    selectedChatModel,
    permissionState,
    prompt,
    fileReferences,
    updateSessionStream,
    setAssistantDebugBundles,
    refreshSessionContextUsage,
    currentBundleBySessionRef,
    setProjects,
    setPrompt,
    setFileReferences,
    closeFileSuggestions,
    setError,
  });

  // Register agentTurn handlers with streamState's event listener
  const turnHandlersRef = useRef(false);
  if (!turnHandlersRef.current) {
    registerTurnHandlers({
      setIsRunningTurn: agentTurn.setIsRunningTurn,
      enqueuePendingPermission: agentTurn.enqueuePendingPermission,
      clearPendingPermissionsForSession: agentTurn.clearPendingPermissionsForSession,
      setProjects,
    });
    turnHandlersRef.current = true;
  }

  const {
    isRunningTurn,
    forkingMessageId,
    isInterruptingTurn,
    pendingPermission,
    isResolvingFileReferences,
  } = agentTurn;
  const activeContextUsage = activeSessionId
    ? sessionContextUsageById[activeSessionId] ?? null
    : null;
  const streamItems = activeSessionId
    ? collapseAssistantTurns(sessionStreams[activeSessionId] ?? [])
    : [];
  const debugEvents = activeSessionId
    ? (sessionDebugEvents[activeSessionId] ?? [])
    : [];

  const activeSessionTitle = useMemo(() => {
    for (const folder of projects) {
      const session = folder.sessions.find(
        (candidate) => candidate.id === activeSessionId,
      );
      if (session) {
        return session.title;
      }
    }
    return "未选择会话";
  }, [activeSessionId, projects]);

  useEffect(() => {
    window.localStorage.setItem(
      hiddenSessionsStorageKey,
      JSON.stringify(uniqueHiddenSessions(hiddenSessions)),
    );
  }, [hiddenSessions]);

  useEffect(() => {
    let cancelled = false;
    getAgentPermissionState()
      .then((state) => {
        if (!cancelled) {
          setPermissionState(state);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await clientDebugLog("info", "initialLoad.start", { remoteMode: !!activeRemoteProfile });
      const registry = await loadWorkspaceRegistry();
      await clientDebugLog("info", "initialLoad.registry", { count: registry.workspaces.length });
      if (cancelled) return;

      // 如果注册表为空，尝试使用默认 workspace（当前目录）并注册它
      if (registry.workspaces.length === 0) {
        try {
          await clientDebugLog("info", "initialLoad.getDefaultWorkspace");
          const defaultWs = await getDefaultWorkspace();
          await clientDebugLog("info", "initialLoad.defaultWorkspace", { root: defaultWs.root, name: defaultWs.name });
          await addWorkspaceRegistryEntry(defaultWs.root);
          registry.workspaces = [{ root: defaultWs.root, name: defaultWs.name }];
        } catch (e) {
          await clientDebugLog("error", "initialLoad.defaultWorkspaceFailed", { error: String(e) });
          // 静默失败，让用户通过"+"手动添加
        }
      }

      const loadedProjects = await Promise.all(
        registry.workspaces.map(async (workspace) => {
          const sessions = await listRuntimeSessions(workspace.root);
          await clientDebugLog("info", "initialLoad.projectSessions", { root: workspace.root, sessionCount: sessions.length });
          return {
            id: projectIdFromRoot(workspace.root),
            name: workspace.name,
            root: workspace.root,
            sessions: sessionsFromRuntimeSummaries(
              workspace.root,
              sessions,
              hiddenSessions,
            ),
            worktreeSessions: [],
          } satisfies ProjectFolder;
        }),
      );
      if (cancelled) {
        return;
      }
      await clientDebugLog("info", "initialLoad.projectsLoaded", { count: loadedProjects.length });
      setProjects(loadedProjects);
      const firstProject = loadedProjects[0] ?? null;
      const firstSessionId = firstProject?.sessions[0]?.id ?? null;
      if (firstProject && firstSessionId) {
        setExpandedFolders(new Set([firstProject.id]));
        setActiveProjectId(firstProject.id);
        setActiveSessionId(firstSessionId);
        setSessionStreams((streams) => ({
          ...streams,
          [firstSessionId]:
            streams[firstSessionId] ??
            welcomeStream(
              firstProject.name,
              firstProject.sessions[0]?.title ?? "会话",
            ),
        }));
      }
    })().catch((reason) => {
      if (!cancelled) {
        clientDebugLog("error", "initialLoad.catch", { error: String(reason) });
        setError(String(reason));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadModelSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        const deepseek = settings.models.find(
          (model) => model.provider === "deepseek",
        );
        const options = (deepseek?.supportModels ?? []).filter(Boolean);
        if (options.length > 0) {
          setChatModelOptions(options);
          setSelectedChatModel(
            options.includes("deepseek-v4-flash")
              ? "deepseek-v4-flash"
              : options[0],
          );
        } else {
          setChatModelOptions(["deepseek-v4-flash", "deepseek-v4-pro"]);
          setSelectedChatModel("deepseek-v4-flash");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChatModelOptions(["deepseek-v4-flash", "deepseek-v4-pro"]);
          setSelectedChatModel("deepseek-v4-flash");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDeleteProject(root: string) {
    try {
      await removeWorkspaceRegistryEntry(root);
      setProjects((prev) => prev.filter((p) => p.root !== root));
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.forEach((id) => {
          if (id.includes(root)) next.delete(id);
        });
        return next;
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleFolder(folderId: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

    // updateSessionStream, refreshSessionContextUsage, and listenAgentReplEvents are now handled by useStreamState

  function selectSession(project: ProjectFolder, sessionId: string) {
    const sessionTitle =
      project.sessions.find((session) => session.id === sessionId)?.title ??
      "会话";
    setActiveView("workspace");
    setActiveProjectId(project.id);
    setActiveSessionId(sessionId);
    setSessionStreams((streams) => ({
      ...streams,
      [sessionId]:
        streams[sessionId] ?? welcomeStream(project.name, sessionTitle),
    }));

    if (!isNewSessionId(sessionId)) {
      getAgentReplProcessStatus(project.root, sessionId)
        .then((status) => {
          if (status.running) {
            void refreshSessionContextUsage(project.root, status.sessionId || sessionId);
          }
          setProjects((folders) =>
            folders.map((folder) =>
              folder.id === project.id
                ? {
                    ...folder,
                    sessions: folder.sessions.map((session) =>
                      session.id === sessionId
                        ? {
                            ...session,
                            processStatus: status.running
                              ? "active"
                              : "stopped",
                            processPid: status.pid ?? undefined,
                          }
                        : session,
                    ),
                  }
                : folder,
            ),
          );
        })
        .catch((reason) => setError(String(reason)));
    }
  }

  useEffect(() => {
    if (
      !activeProject ||
      !activeSessionId ||
      isRunningTurn ||
      pendingPermission?.sessionId === activeSessionId
    ) {
      return;
    }
    const activeSession = activeProject.sessions.find(
      (session) => session.id === activeSessionId,
    );
    if (activeSession?.isPending) {
      return;
    }
    let cancelled = false;
    loadTypedRuntimeSession(activeProject.root, activeSessionId)
      .then((detail) => {
        if (cancelled) {
          return;
        }
        const artifacts = runtimeSessionToArtifacts(detail, activeProject.root);

      void loadBundleUsageSnapshotsForSession(detail.id)
        .then((snapshots) => {
          setStreamUsageByBundleKey((current) => {
            const next = { ...current };
            for (const snapshot of snapshots) {
              next[bundleUsageStorageKey(snapshot.sessionId, snapshot.bundleId)] = snapshot;
            }
            return next;
          });
        })
        .catch((reason) => {
          console.warn("[bundle-usage] failed to hydrate history usage snapshots", {
            sessionId: detail.id,
            reason,
          });
        });
        setAssistantDebugBundles((bundles) => ({
          ...bundles,
          ...artifacts.bundles,
        }));
        setSessionStreams((streams) => {
          const existingItems = streams[activeSessionId] ?? [];

          // Do not overwrite a live in-memory conversation after a turn completes.
          // The in-memory stream keeps stable message IDs for per-answer Debug and
          // already collapses Claude Code progress messages into one assistant
          // bubble. Disk jsonl reloads are used only when opening a session that
          // has not been rendered in this UI instance yet.
          if (existingItems.length > 0) {
            return streams;
          }

          return {
            ...streams,
            [activeSessionId]:
              detail.messages.length > 0
                ? collapseAssistantTurns(artifacts.items)
                : welcomeStream(activeProject.name, activeSessionTitle),
          };
        });
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeProject,
    activeSessionId,
    activeSessionTitle,
    isRunningTurn,
    pendingPermission,
  ]);

  async function handleAddProject() {
    try {
      let selected: string | null;
      const remoteMode = !!activeRemoteProfile;

      await clientDebugLog("info", "handleAddProject.start", { remoteMode, activeProfile: activeRemoteProfile?.name ?? null });
      if (remoteMode) {
        // remote mode: 弹出自定义输入框让用户输入远程服务器路径，支持子目录自动补全
        selected = await new Promise<string | null>((resolve) => {
          remotePathPromptResolve.current = resolve;
          setRemotePathPrompt("Enter the remote project path (must exist on the remote server):");
        });
        await clientDebugLog("info", "handleAddProject.promptResult", { cancelled: selected === null, empty: selected != null && !selected.trim() });
        if (!selected || !selected.trim()) {
          setRemotePathPrompt(null);
          return;
        }
        selected = selected.trim();
        setRemotePathPrompt(null);
        await clientDebugLog("info", "handleAddProject.path", { selected });
      } else {
        // local mode: 使用 Tauri 本地目录选择器
        selected = await openDialog({
          directory: true,
          multiple: false,
          title: "Add project folder",
        });
        if (typeof selected !== "string") {
          await clientDebugLog("info", "handleAddProject.dialogCancelled", { selected });
          return;
        }
      }

      await clientDebugLog("info", "handleAddProject.openWorkspace", { selected });
      const workspace = await openWorkspace(selected);
      await clientDebugLog("info", "handleAddProject.openWorkspaceResult", { workspace });

      await clientDebugLog("info", "handleAddProject.addRegistryEntry", { root: workspace.root });
      await addWorkspaceRegistryEntry(workspace.root);

      const projectId = projectIdFromRoot(workspace.root);
      await clientDebugLog("info", "handleAddProject.listSessions", { root: workspace.root });
      const existingSessions = await listRuntimeSessions(workspace.root);
      await clientDebugLog("info", "handleAddProject.sessionsResult", { count: existingSessions.length });

      const initialSessions = sessionsFromRuntimeSummaries(
        workspace.root,
        existingSessions,
        hiddenSessions,
      );
      const firstSessionId = initialSessions[0]?.id ?? null;
      await clientDebugLog("info", "handleAddProject.initialSessions", {
        initialCount: initialSessions.length,
        firstSessionId,
        isPending: initialSessions[0]?.isPending ?? false,
      });
      if (!firstSessionId) {
        throw new Error("failed to initialize runtime session");
      }
      const nextProject: ProjectFolder = {
        id: projectId,
        name: workspace.name || `文件夹${projects.length + 1}`,
        root: workspace.root,
        sessions: initialSessions,
        worktreeSessions: [],
      };

      setProjects((currentProjects) => {
        const existing = currentProjects.find(
          (project) => project.id === projectId,
        );
        if (existing) {
          return currentProjects;
        }
        return [...currentProjects, nextProject];
      });
      setExpandedFolders((folders) => new Set(folders).add(projectId));
      setActiveView("workspace");
      setActiveProjectId(projectId);
      setActiveSessionId(firstSessionId);
      setSessionStreams((streams) => ({
        ...streams,
        [firstSessionId]:
          streams[firstSessionId] ??
          welcomeStream(
            nextProject.name,
            nextProject.sessions[0]?.title ?? "新会话",
          ),
      }));
      setPreviewTabs([]);
      setActivePreviewId(null);
      setError(null);
      await clientDebugLog("info", "handleAddProject.success", { projectId });
    } catch (reason) {
      await clientDebugLog("error", "handleAddProject.error", { error: String(reason) });
      setError(String(reason));
    }
  }

  function handleCreateSession(project: ProjectFolder) {
    const pendingSession = createPendingSession();
    setProjects((currentProjects) =>
      currentProjects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              sessions: [...candidate.sessions, pendingSession],
            }
          : candidate,
      ),
    );
    setExpandedFolders((folders) => new Set(folders).add(project.id));
    setActiveView("workspace");
    setActiveProjectId(project.id);
    setActiveSessionId(pendingSession.id);
    setSessionStreams((streams) => ({
      ...streams,
      [pendingSession.id]: welcomeStream(project.name, pendingSession.title),
    }));
    setPreviewTabs([]);
    setActivePreviewId(null);
    setError(null);
  }

  async function handleForkSession(project: ProjectFolder, session: ProjectSession) {
    if (isNewSessionId(session.id)) {
      setError("这个会话还没有真实 session 文件，不能 Fork。请先发送一条消息生成会话。");
      return;
    }

    const sourceItems = sessionStreams[session.id] ?? [];
    const checkpointMessage = [...sourceItems]
      .reverse()
      .find(
        (item): item is Extract<StreamItem, { kind: "message" }> =>
          item.kind === "message" && item.role === "assistant" && Boolean(item.checkpointUuid),
      );

    if (!checkpointMessage?.checkpointUuid) {
      setError("这个会话还没有可 fork 的 assistant checkpoint。");
      return;
    }

    try {
      setError(null);
      const forkedProcess = await forkAgentReplProcess(
        project.root,
        session.id,
        checkpointMessage.checkpointUuid,
        selectedChatModel,
        permissionState?.currentMode ?? "default",
      );
      const forkedSessionId = forkedProcess.sessionId;
      const detail = await loadTypedRuntimeSessionWithRetry(project.root, forkedSessionId, 80);
      const artifacts = runtimeSessionToArtifacts(detail, project.root);
      const forkedTitle =
        firstUserTitleFromStream(artifacts.items) ?? `Fork · ${session.title}`;

      setProjects((currentProjects) =>
        currentProjects.map((candidate) =>
          candidate.id === project.id
            ? {
                ...candidate,
                sessions: dedupeSessions([
                  {
                    id: forkedSessionId,
                    title: forkedTitle,
                    processStatus: "active",
                    processPid: undefined,
                  },
                  ...candidate.sessions,
                ]),
              }
            : candidate,
        ),
      );
      setExpandedFolders((folders) => new Set(folders).add(project.id));
      setActiveView("workspace");
      setActiveProjectId(project.id);
      setAssistantDebugBundles((bundles) => ({
        ...bundles,
        ...artifacts.bundles,
      }));
      setSessionStreams((streams) => ({
        ...streams,
        [forkedSessionId]: collapseAssistantTurns(artifacts.items),
      }));
      setActiveSessionId(forkedSessionId);
      setPreviewTabs([]);
      setActivePreviewId(null);
      void refreshSessionContextUsage(project.root, forkedSessionId);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function killSessionProcessBestEffort(root: string, sessionId: string) {
    try {
      await killAgentReplProcess(root, sessionId);
    } catch (reason) {
      console.warn("Failed to kill session process", { root, sessionId, reason });
    }

    setProjects((folders) =>
      folders.map((folder) =>
        folder.root === root
          ? {
              ...folder,
              sessions: folder.sessions.map((candidate) =>
                candidate.id === sessionId
                  ? {
                      ...candidate,
                      processStatus: "stopped",
                      processPid: undefined,
                    }
                  : candidate,
              ),
            }
          : folder,
      ),
    );
  }

  async function handleHideSession(project: ProjectFolder, session: ProjectSession) {
    await killSessionProcessBestEffort(project.root, session.id);
    const hiddenRecord: HiddenSession = {
      root: project.root,
      projectName: project.name,
      sessionId: session.id,
      title: session.title || session.id,
      hiddenAt: Date.now(),
    };
    const remainingSessions = project.sessions.filter(
      (candidate) => candidate.id !== session.id,
    );
    const fallbackSession = remainingSessions[0] ?? createPendingSession();
    const nextSessions =
      remainingSessions.length > 0 ? remainingSessions : [fallbackSession];

    setHiddenSessions((current) =>
      uniqueHiddenSessions([
        hiddenRecord,
        ...current.filter(
          (item) =>
            sessionKey(item.root, item.sessionId) !==
            sessionKey(project.root, session.id),
        ),
      ]),
    );
    setProjects((currentProjects) =>
      currentProjects.map((candidate) =>
        candidate.id === project.id
          ? {
              ...candidate,
              sessions: nextSessions,
            }
          : candidate,
      ),
    );
    if (activeSessionId === session.id) {
      setActiveProjectId(project.id);
      setActiveSessionId(fallbackSession.id);
      setSessionStreams((streams) => ({
        ...streams,
        [fallbackSession.id]:
          streams[fallbackSession.id] ??
          welcomeStream(project.name, fallbackSession.title),
      }));
    }
  }

  async function handleRestoreHiddenSession(hiddenSession: HiddenSession) {
    setHiddenSessions((current) =>
      current.filter(
        (item) =>
          sessionKey(item.root, item.sessionId) !==
          sessionKey(hiddenSession.root, hiddenSession.sessionId),
      ),
    );

    const project = projects.find(
      (candidate) => candidate.root === hiddenSession.root,
    );
    if (!project) {
      return;
    }

    let restoredTitle = hiddenSession.title || hiddenSession.sessionId;
    try {
      const runtimeSessions = await listRuntimeSessions(hiddenSession.root);
      const runtimeSession = runtimeSessions.find(
        (session) => session.id === hiddenSession.sessionId,
      );
      if (runtimeSession?.title) {
        restoredTitle = runtimeSession.title;
      }
    } catch {
      // Restoring visibility should still work even if the jsonl list cannot be refreshed immediately.
    }

    const restoredSession: ProjectSession = {
      id: hiddenSession.sessionId,
      title: restoredTitle,
      isPending: isNewSessionId(hiddenSession.sessionId),
      processStatus: "stopped",
    };

    setProjects((currentProjects) =>
      currentProjects.map((candidate) => {
        if (candidate.id !== project.id) {
          return candidate;
        }
        if (
          candidate.sessions.some(
            (session) => session.id === hiddenSession.sessionId,
          )
        ) {
          return candidate;
        }
        return {
          ...candidate,
          sessions: dedupeSessions([restoredSession, ...candidate.sessions]),
        };
      }),
    );
    setExpandedFolders((folders) => new Set(folders).add(project.id));
    setActiveView("workspace");
    setActiveProjectId(project.id);
    setActiveSessionId(hiddenSession.sessionId);
    setSessionStreams((streams) => ({
      ...streams,
      [hiddenSession.sessionId]:
        streams[hiddenSession.sessionId] ??
        welcomeStream(project.name, restoredTitle),
    }));
  }

  function upsertPreviewTab(tab: PreviewTab) {
    setPreviewTabs((tabs) => {
      const nextTabs = tabs.filter((candidate) => candidate.id !== tab.id);
      return [...nextTabs, tab];
    });
    setActivePreviewId(tab.id);
  }

  function closePreviewTab(id: string) {
    setPreviewTabs((tabs) => {
      const nextTabs = tabs.filter((tab) => tab.id !== id);
      if (activePreviewId === id) {
        setActivePreviewId(nextTabs[nextTabs.length - 1]?.id ?? null);
      }
      return nextTabs;
    });
  }

  async function handleOpenPreviewLink(link: StreamLink) {
    setOpenProcessMessageIds(new Set());
    if (!activeProject) {
      setError("Add a project folder first.");
      return;
    }

    if (link.kind === "pdf" || link.kind === "image") {
      upsertPreviewTab({
        id: `reference:${link.path}`,
        kind: "reference",
        title: link.label,
        link,
      });
      return;
    }

    if (shouldReadAsLocalReference(link)) {
      try {
        const file = await readLocalReferenceFile(activeProject.root, link.path);
        upsertPreviewTab({
          id: `local-reference:${file.path}`,
          kind: "file",
          title: file.path,
          file,
          diff: { path: file.path, diff: "", is_empty: true },
        });
      } catch (reason) {
        setError(`Read referenced file failed: ${String(reason)}`);
      }
      return;
    }

    try {
      const [file, diff] = await Promise.all([
        readWorkspaceFile(activeProject.root, link.path),
        readGitDiff(activeProject.root, link.path),
      ]);
      upsertPreviewTab({
        id: `file:${file.path}`,
        kind: "file",
        title: file.path,
        file,
        diff,
      });
    } catch (reason) {
      setError(String(reason));
    }
  }

  function assistantDebugPayload(
    item: Extract<StreamItem, { kind: "message" }>,
    action: "view" | "copy",
  ) {
    const bundle = assistantDebugBundles[item.id];
    const details = assistantTurnDetails(item, bundle ?? null);
    return {
      kind: "agent-ui.assistant-message-debug",
      action,
      generatedAt: new Date().toISOString(),
      sessionId: bundle?.sessionId ?? activeSessionId,
      root: bundle?.root ?? activeProject?.root ?? null,
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
      commands: details.commandUses.map((tool) => ({
        name: toolName(tool),
        command: commandFromToolUse(tool),
        raw: tool,
      })),
      toolUses: details.toolUses.map((tool) => ({
        name: toolName(tool),
        summary: summarizeToolUse(tool),
        raw: tool,
      })),
      bundleDisplayText: bundle?.displayText ?? null,
      completed: bundle?.completed ?? null,
      eventCount: bundle?.events.length ?? 0,
      events: (bundle?.events ?? []).map((event) => ({
        eventType: event.eventType,
        receivedAt: new Date(event.receivedAt).toISOString(),
        debugStorageSource: debugStorageSource(event),
        payload: event.payload,
      })),
    };
  }

  // handleToggleAssistantProcess, handleToggleSessionUsage, handleViewAssistantUsage,
  // handleViewAssistantDebug, handleCopyAssistantDebug are now handled by useStreamState

  function handlePermissionModeChange(nextMode: PermissionMode) {
    if (!activeProject) {
      return;
    }
    setAgentPermissionMode(activeProject.root, nextMode)
      .then((state) => {
        setPermissionState(state);
      })
      .catch((reason) => {
        setError(String(reason));
      });
  }

  return (
    <main
      className={`app-shell ${activeView === "settings" || activeView === "skills" ? "settings-mode" : (activePreview || openProcessMessageIds.size > 0) ? "has-preview" : ""}`}
    >
      <aside className="side-panel" aria-label="Project and skills">
        <WorkspaceTree
          projects={projects}
          activeSessionId={activeSessionId}
          activeRemoteProfile={activeRemoteProfile}
          runtimeBadgeTitle={runtimeBadgeTitle}
          onAddProject={handleAddProject}
          onDeleteProject={handleDeleteProject}
          onSelectSession={selectSession}
          onCreateSession={handleCreateSession}
          onForkSession={handleForkSession}
          onHideSession={handleHideSession}
          expandedFolders={expandedFolders}
          onToggleFolder={toggleFolder}
          remotePathPrompt={remotePathPrompt}
          remotePathPromptResolve={remotePathPromptResolve}
          onSetRemotePathPrompt={setRemotePathPrompt}
        />

        <button
          className={`skills-nav ${activeView === "skills" ? "active" : ""}`}
          type="button"
          onClick={() => {
            setActiveView("skills");
            setPreviewTabs([]);
            setActivePreviewId(null);
          }}
        >
          <span className="nav-icon plain" aria-hidden="true">✦</span>
          <span>Skills</span>
        </button>

        <button
          className={`skills-nav ${activeView === "mcp" ? "active" : ""}`}
          type="button"
          onClick={() => {
            setActiveView("mcp");
            setActivePreviewId(null);
          }}
        >
          <span className="mcp-nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" role="img">
              <path d="M7 7.5h10M7 12h10M7 16.5h10" />
              <rect x="4" y="4" width="16" height="16" rx="3.5" />
            </svg>
          </span>
          <span>MCP Servers</span>
        </button>

        <div className="sidebar-footer">
          <button
            className={`sidebar-action ${activeView === "terminal" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("terminal");
              setPreviewTabs([]);
              setActivePreviewId(null);
            }}
          >
            <span className="nav-icon small plain" aria-hidden="true">⌘</span>
            <span>Terminal</span>
          </button>
          <button
            className={`sidebar-action ${activeView === "settings" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveView("settings");
              setPreviewTabs([]);
              setActivePreviewId(null);
            }}
          >
            <span className="nav-icon small plain" aria-hidden="true">⚙</span>
            <span>Settings</span>
          </button>
        </div>
      </aside>
      {activeView === "terminal" ? (
        activeRemoteProfile ? (
          <RemoteTerminalPlaceholder onClose={() => setActiveView("workspace")} />
        ) : (
          <TerminalView onClose={() => setActiveView("workspace")} />
        )
      ) : activeView === "skills" ? (
        <SkillsView activeProject={activeProject ?? undefined} />
      ) : activeView === "mcp" ? (
        <McpServersView />
      ) : activeView === "settings" ? (
        <SettingsView
          hiddenSessions={hiddenSessions}
          onRestoreSession={handleRestoreHiddenSession}
        />
      ) : (
        <SessionDialog
          activeSessionTitle={activeSessionTitle}
          activeSessionId={activeSessionId}
          isDebugOpen={isDebugOpen}
          onToggleSessionUsage={handleToggleSessionUsage}
          onSetIsDebugOpen={setIsDebugOpen}
          sessionUsageSnapshotsForSession={sessionUsageSnapshotsForSession}
          streamUsageByBundleKey={streamUsageByBundleKey}
          streamItems={streamItems}
          assistantDebugBundles={assistantDebugBundles}
          openAssistantUsageMessageId={openAssistantUsageMessageId}
          openAssistantDebugMessageId={openAssistantDebugMessageId}
          openProcessMessageIds={openProcessMessageIds}
          copiedDebugMessageId={copiedDebugMessageId}
          copyToast={copyToast}
          error={error}
          activeProject={activeProject}
          isRunningTurn={isRunningTurn}
          isInterruptingTurn={isInterruptingTurn}
          forkingMessageId={forkingMessageId}
          pendingPermission={pendingPermission}
          isResolvingFileReferences={isResolvingFileReferences}
          onViewAssistantDebug={handleViewAssistantDebug}
          onCopyAssistantDebug={handleCopyAssistantDebug}
          onViewAssistantUsage={handleViewAssistantUsage}
          onToggleAssistantProcess={handleToggleAssistantProcess}
          onOpenPreviewLink={handleOpenPreviewLink}
          onSetOpenAssistantUsageMessageId={setOpenAssistantUsageMessageId}
          onForkFromMessage={(item) => agentTurn.handleForkFromMessage(item)}
          assistantDebugPayload={assistantDebugPayload}
          prompt={prompt}
          onPromptChange={handlePromptChange}
          onPromptKeyDown={handlePromptKeyDown}
          onSubmit={handlePromptSubmit}
          canSendPrompt={canSendPrompt}
          onInterruptTurn={agentTurn.handleInterruptTurn}
          textareaRef={textareaRef as React.RefObject<HTMLTextAreaElement>}
          promptHighlightRef={promptHighlightRef as React.RefObject<HTMLDivElement>}
          promptImeStateRef={promptImeStateRef}
          markPromptImeActive={markPromptImeActive}
          fileReferences={fileReferences}
          onRemoveFileReference={removeFileReference}
          fileMention={fileMention}
          fileSuggestions={fileSuggestions}
          fileSuggestionIndex={fileSuggestionIndex}
          isSearchingFiles={isSearchingFiles}
          onSelectFileSuggestion={selectFileSuggestion}
          onUpdateFileMentionFromInput={updateFileMentionFromInput}
          onUpdateSlashCommandMenuFromInput={updateSlashCommandMenuFromInput}
          slashCommandMenu={slashCommandMenu}
          slashRootOptions={slashRootOptions}
          slashLeafOptions={slashLeafOptions}
          slashLeafTitle={slashLeafTitle}
          slashLeafDescription={slashLeafDescription}
          slashLeafEmptyText={slashLeafEmptyText}
          onSetSlashCommandMenu={onSetSlashCommandMenu}
          onSelectSlashRootItem={selectSlashRootItem}
          onSelectSlashItem={selectSlashItem}
          onPermissionAllow={(answers?: Record<string, string>) => agentTurn.handlePermissionDecision(true, answers)}
          onPermissionDeny={() => agentTurn.handlePermissionDecision(false)}
          onPermissionModeChange={(mode) => handlePermissionModeChange(mode as any)}
          permissionState={permissionState}
          selectedChatModel={selectedChatModel}
          chatModelOptions={chatModelOptions}
          onChatModelChange={setSelectedChatModel}
          contextUsageError={contextUsageError}
          activeContextUsage={activeContextUsage}
          contextUsageLabel={contextUsageLabel}
          isCompacting={!!(activeSessionId && isCompactingBySession[activeSessionId])}
          previewTabs={previewTabs}
          activePreview={activePreview}
          onSetActivePreviewId={setActivePreviewId}
          onClosePreviewTab={closePreviewTab}
          onCloseAllPreviews={() => setPreviewTabs([])}
        />
      )}

    </main>
  );
}
