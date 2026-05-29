import {useState} from "react";
import type {
  ProjectFolder,
  ProjectSession,
} from "../types";

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

          const handleSelectSession = (event: React.MouseEvent) => {
            event.stopPropagation();
            onSelectSession(project, session.id);
          };

          const handleToggleMenu = (event: React.MouseEvent) => {
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
          };

          const handleForkSession = (event: React.MouseEvent) => {
            event.stopPropagation();
            void onForkSession(project, session);
          };

          const handleHideSession = (event: React.MouseEvent) => {
            event.stopPropagation();
            void onHideSession(project, session);
          };

          return (
              <div
                  key={session.id}
                  className={`tree-session-row ${isActiveSession ? "active" : ""}`}
              >
                <button
                    className="tree-session-main"
                    type="button"
                    onClick={handleSelectSession}
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
                    onClick={handleToggleMenu}
                >
                  ...
                </button>
                {isMenuOpen ? (
                    <div className="session-menu" role="menu">
                      <button
                          type="button"
                          role="menuitem"
                          onClick={handleForkSession}
                      >
                        Fork
                      </button>
                      <button
                          type="button"
                          role="menuitem"
                          onClick={handleHideSession}
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
