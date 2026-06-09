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
import {setEventHandle} from "../hooks/stream-event-bus";
import {addCallback} from "../hooks/stream-event-bus";
import type {SessionMetadataEvent} from "./stream-handlers/session-metadata";
import {handleControlRequestEvent} from "./stream-handlers/control-request";
import {handleCompactingEvent} from "./stream-handlers/compacting";
import {handleContextUsageEvent} from "./stream-handlers/context-usage";
import {handleSessionStatusEvent} from "./stream-handlers/turn-status";
import {handleSessionMetadataEvent} from "./stream-handlers/session-metadata";
import {TerminalView} from "./Terminal";
import {RemoteTerminalPlaceholder} from "./RemoteTerminalPlaceholder";
import {SkillsView} from "./components/skills-view";
import {McpServersView} from "./components/mcp-servers-view";
import {SettingsView} from "./components/settings-view";
import {SessionDialogView} from "./components/SessionDialog";
import {WorkspaceTreeView} from "./components/workspace-tree";
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

    setEventHandle("control-request", handleControlRequestEvent);
    setEventHandle("compacting", handleCompactingEvent);
    setEventHandle("context-usage", handleContextUsageEvent);
    setEventHandle("session-status", handleSessionStatusEvent);
    setEventHandle("session-metadata", handleSessionMetadataEvent);
  }, []);

  // 订阅 session-metadata：更新 session 进程状态（会话列表显示用）
  useEffect(() => {
    return addCallback("session-metadata", (data, sessionId) => {
      const meta = data as SessionMetadataEvent;
      if (!meta.processStatus) return;
      setProjects((folders) =>
        folders.map((f) => ({
          ...f,
          sessions: f.sessions.map((s) =>
            s.id === sessionId
              ? { ...s, processStatus: meta.processStatus!, processPid: meta.processPid ?? s.processPid }
              : s
          ),
        })),
      );
    });
  }, []);

  const [projects, setProjects] = useState<ProjectFolder[]>([]);
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);

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



  function selectSession(project: ProjectFolder, sessionId: string) {
    // 如果当前 session 还有进程在运行，禁止切换
    const currentSession = activeProject?.sessions.find((s) => s.id === activeSessionId);
    if (currentSession?.processStatus === "active") {
      setError("当前会话正在运行中，请等待完成后再切换会话");
      return;
    }
    const sessionTitle =
      project.sessions.find((session) => session.id === sessionId)?.title ??
      "会话";
    // Stream initialization is handled by SessionDialogView
    setActiveView("workspace");
    setActiveProjectId(project.id);
    setActiveSessionId(sessionId);
  }

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
    setPreviewTabs([]);
    setActivePreviewId(null);
    setError(null);
  }

  async function handleForkSession(project: ProjectFolder, session: ProjectSession) {
    if (isNewSessionId(session.id)) {
      setError("这个会话还没有真实 session 文件，不能 Fork。请先发送一条消息生成会话。");
      return;
    }
    try {
      setError(null);
      const detail = await loadTypedRuntimeSessionWithRetry(project.root, session.id, 80);
      const artifacts = runtimeSessionToArtifacts(detail, project.root);
      const checkpointMessage = [...artifacts.items]
        .reverse()
        .find(
          (item): item is Extract<StreamItem, { kind: "message" }> =>
            item.kind === "message" && item.role === "assistant" && Boolean(item.checkpointUuid),
        );
      if (!checkpointMessage?.checkpointUuid) {
        setError("这个会话还没有可 fork 的 assistant checkpoint。");
        return;
      }
      const forkedProcess = await forkAgentReplProcess(
        project.root,
        session.id,
        checkpointMessage.checkpointUuid,
        selectedChatModel,
        permissionState?.currentMode ?? "default",
      );
      const forkedSessionId = forkedProcess.sessionId;
      const forkedDetail = await loadTypedRuntimeSessionWithRetry(project.root, forkedSessionId, 80);
      const forkedArtifacts = runtimeSessionToArtifacts(forkedDetail, project.root);
      const forkedTitle = firstUserTitleFromStream(forkedArtifacts.items) ?? `Fork · ${session.title}`;

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
      setActiveSessionId(forkedSessionId);
      setPreviewTabs([]);
      setActivePreviewId(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function handleForkFromMessage(item: Extract<StreamItem, { kind: "message" }>) {
    if (!activeProject || !activeSessionId) return;

    if (!item.checkpointUuid) {
      setError("这个会话还没有可 fork 的 assistant checkpoint。");
      return;
    }

    const session = activeProject.sessions.find((s) => s.id === activeSessionId);
    if (!session) return;

    try {
      setError(null);
      const forkedProcess = await forkAgentReplProcess(
        activeProject.root,
        session.id,
        item.checkpointUuid,
        selectedChatModel,
        permissionState?.currentMode ?? "default",
      );
      const forkedSessionId = forkedProcess.sessionId;
      const detail = await loadTypedRuntimeSessionWithRetry(activeProject.root, forkedSessionId, 80);
      const artifacts = runtimeSessionToArtifacts(detail, activeProject.root);
      const forkedTitle = firstUserTitleFromStream(artifacts.items) ?? `Fork · ${session.title}`;

      setProjects((currentProjects) =>
        currentProjects.map((candidate) =>
          candidate.id === activeProject.id
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
      setExpandedFolders((folders) => new Set(folders).add(activeProject.id));
      setActiveView("workspace");
      setActiveProjectId(activeProject.id);
      setActiveSessionId(forkedSessionId);
      setPreviewTabs([]);
      setActivePreviewId(null);
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
      className={`app-shell ${activeView === "settings" || activeView === "skills" ? "settings-mode" : ""}`}
    >
      <aside className="side-panel" aria-label="Project and skills">
        <WorkspaceTreeView
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
        <SessionDialogView
          activeSessionId={activeSessionId}
          activeProject={activeProject}
          activeSessionTitle={activeSessionTitle}
          projects={projects}
          setProjects={setProjects}
          onSelectSession={selectSession}
          error={error}
          setError={setError}
          permissionState={permissionState}
          onPermissionModeChange={(mode) => handlePermissionModeChange(mode as any)}
          previewTabs={previewTabs}
          activePreview={activePreview}
          onSetActivePreviewId={setActivePreviewId}
          onClosePreviewTab={closePreviewTab}
          onCloseAllPreviews={() => setPreviewTabs([])}
          onOpenPreviewLink={handleOpenPreviewLink}
          chatModelOptions={chatModelOptions}
          selectedChatModel={selectedChatModel}
          onChatModelChange={setSelectedChatModel}
          onForkFromMessage={handleForkFromMessage}
        />
      )}

    </main>
  );
}
