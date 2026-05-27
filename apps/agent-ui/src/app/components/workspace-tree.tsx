import {useRef, useState} from "react";
import type {RemoteProfile} from "../../runtime";
import {listProjectEntries} from "../../runtime";
import type {ProjectFolder, ProjectSession} from "../types";
import {SessionList} from "./session";

// ─── Types ───────────────────────────────────────────────────────────────

export interface WorkspaceTreeProps {
  projects: ProjectFolder[];
  activeSessionId: string | null;
  activeRemoteProfile: RemoteProfile | null;
  runtimeBadgeTitle: string;
  onAddProject: () => void;
  onDeleteProject: (root: string) => void;
  remotePathPrompt: string | null;
  remotePathPromptResolve: React.MutableRefObject<((value: string | null) => void) | null>;
  onSetRemotePathPrompt: (prompt: string | null) => void;
  onSelectSession: (project: ProjectFolder, sessionId: string) => void;
  onCreateSession: (project: ProjectFolder) => void;
  onForkSession: (project: ProjectFolder, session: ProjectSession) => void;
  onHideSession: (project: ProjectFolder, session: ProjectSession) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (folderId: string) => void;
}

// ─── WorkspaceTree ──────────────────────────────────────────────────────────

export function WorkspaceTree({
  projects,
  activeSessionId,
  activeRemoteProfile,
  runtimeBadgeTitle,
  onAddProject,
  onDeleteProject,
  onSelectSession,
  onCreateSession,
  onForkSession,
  onHideSession,
  remotePathPrompt,
  remotePathPromptResolve,
  onSetRemotePathPrompt,
  expandedFolders,
  onToggleFolder,
}: WorkspaceTreeProps) {
  const [projectContextMenu, setProjectContextMenu] = useState<{
    root: string;
    x: number;
    y: number;
  } | null>(null);
  const [remotePathInput, setRemotePathInput] = useState("");
  const [remotePathSuggestions, setRemotePathSuggestions] = useState<string[]>([]);
  const [remotePathHighlightIndex, setRemotePathHighlightIndex] = useState(-1);
  const remotePathDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleDeleteWithCleanup(root: string) {
    onDeleteProject(root);
  }

  return (
    <>
      <div className="brand-block">
        <div className="brand-mark">A</div>
        <div>
          <div className="brand-title">InterpressAI</div>
          <div className="brand-version">workspace</div>
        </div>
      </div>

      <section className="workspace-nav">
        {activeRemoteProfile ? (
          <div className="runtime-nav-card" title={runtimeBadgeTitle}>
            <span className="runtime-nav-dot" aria-hidden="true" />
            <span className="runtime-nav-copy">
              <span>Remote</span>
              <strong>Active runtime</strong>
            </span>
          </div>
        ) : null}
        <div className="workspace-active active">
          <button
            className="workspace-select"
            type="button"
          >
            <span className="nav-icon plain" aria-hidden="true">▣</span>
            <span className="nav-label">项目</span>
          </button>
          <button
            className="project-add"
            type="button"
            onClick={onAddProject}
            title="Add project folder"
          >
            +

          {remotePathPrompt !== null && (
            <div className="modal-overlay" onClick={() => { remotePathPromptResolve.current?.(null); onSetRemotePathPrompt(null); }}>
              <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <h3>Remote Project Path</h3>
                </div>
                <div className="modal-body">
                  <p>{remotePathPrompt}</p>
                  <div className="modal-input-wrap">
                    <input
                      autoFocus
                      className="modal-input"
                      value={remotePathInput}
                      onChange={async (e) => {
                        const value = e.target.value;
                        setRemotePathInput(value);
                        setRemotePathSuggestions([]);
                        if (remotePathDebounce.current) clearTimeout(remotePathDebounce.current);
                        if (value.length > 0) {
                          remotePathDebounce.current = setTimeout(async () => {
                            try {
                              const entries = await listProjectEntries(value);
                              const dirs = entries.filter((entry: any) => entry.kind === "directory").map((d: any) => d.path);
                              setRemotePathSuggestions(dirs.slice(0, 8));
                            } catch {}
                          }, 300);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setRemotePathHighlightIndex((prev) =>
                            prev < remotePathSuggestions.length - 1 ? prev + 1 : prev
                          );
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setRemotePathHighlightIndex((prev) => (prev > 0 ? prev - 1 : -1));
                          return;
                        }
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (remotePathHighlightIndex >= 0 && remotePathHighlightIndex < remotePathSuggestions.length) {
                            const selected = remotePathSuggestions[remotePathHighlightIndex];
                            remotePathPromptResolve.current?.(selected);
                          } else {
                            const value = (e.target as HTMLInputElement).value;
                            remotePathPromptResolve.current?.(value);
                          }
                          onSetRemotePathPrompt(null);
                          setRemotePathInput("");
                          setRemotePathSuggestions([]);
                          setRemotePathHighlightIndex(-1);
                        }
                        if (e.key === "Escape") {
                          remotePathPromptResolve.current?.(null);
                          onSetRemotePathPrompt(null);
                          setRemotePathInput("");
                          setRemotePathSuggestions([]);
                          setRemotePathHighlightIndex(-1);
                        }
                      }}
                      placeholder="/home/user/project"
                    />
                    {remotePathSuggestions.length > 0 && (
                      <div className="modal-suggestions">
                        {remotePathSuggestions.map((s, i) => (
                          <button
                            key={s}
                            type="button"
                            className={`modal-suggestion-item ${i === remotePathHighlightIndex ? "highlighted" : ""}`}
                            onMouseEnter={() => setRemotePathHighlightIndex(i)}
                            onClick={() => {
                              remotePathPromptResolve.current?.(s);
                              onSetRemotePathPrompt(null);
                              setRemotePathInput("");
                              setRemotePathSuggestions([]);
                              setRemotePathHighlightIndex(-1);
                            }}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="modal-footer">
                  <button onClick={() => { remotePathPromptResolve.current?.(null); onSetRemotePathPrompt(null); }}>Cancel</button>
                </div>
              </div>
            </div>
          )}
          </button>
        </div>

        <div className="workspace-tree">
          {projects.map((folder) => {
            const isExpanded = expandedFolders.has(folder.id);
            return (
              <div key={folder.id}>
                <button
                  className="tree-project"
                  type="button"
                  onClick={() => onToggleFolder(folder.id)}
                  onContextMenu={(e) => { e.preventDefault(); setProjectContextMenu({ root: folder.root, x: e.clientX, y: e.clientY }); }}
                >
                  <span className="nav-icon small plain" aria-hidden="true">
                    {isExpanded ? "▾" : "▸"}
                  </span>
                  <span className="tree-label">{folder.name}</span>
                  <span className="tree-chevron plain" aria-hidden="true">
                    {isExpanded ? "⌄" : "›"}
                  </span>
                </button>
                {isExpanded ? (
                  <SessionList
                    project={folder}
                    activeSessionId={activeSessionId}
                    onSelectSession={onSelectSession}
                    onCreateSession={onCreateSession}
                    onForkSession={onForkSession}
                    onHideSession={onHideSession}
                  />
                ) : null}
              </div>
            );
          })}
          {projects.length === 0 ? (
            <div className="sidebar-empty">点击 + 添加项目文件夹</div>
          ) : null}
        {projectContextMenu && (
          <>
            <div className="context-menu-backdrop" onClick={() => setProjectContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setProjectContextMenu(null); }} />
            <div className="context-menu" style={{ position: 'fixed', left: projectContextMenu.x, top: projectContextMenu.y, zIndex: 1001 }}>
              <button
                className="context-menu-item danger"
                type="button"
                onClick={() => {
                  const root = projectContextMenu.root;
                  setProjectContextMenu(null);
                  handleDeleteWithCleanup(root);
                }}
              >
                删除项目
              </button>
            </div>
          </>
        )}
        </div>
      </section>
    </>
  );
}
