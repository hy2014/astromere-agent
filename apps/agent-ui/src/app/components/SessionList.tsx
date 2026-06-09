/* @checkFns tree-branch */
import {useState} from "react";
import type {ProjectFolder, ProjectSession,} from "../types";
import {render} from "../../core/dep";

// ─── SessionList ────────────────────────────────────────────────────────

export interface SessionListProps {
  project: ProjectFolder;
  activeSessionId: string | null;
  onSelectSession: (project: ProjectFolder, sessionId: string) => void;
  onCreateSession: (project: ProjectFolder) => void;
  onForkSession: (project: ProjectFolder, session: ProjectSession) => void;
  onHideSession: (project: ProjectFolder, session: ProjectSession) => void;
}

// ─── WriteState ─────────────────────────────────────────────────────────
const WriteState: {
  setOpenSessionMenu: (menu: { root: string; sessionId: string } | ((prev: { root: string; sessionId: string } | null) => { root: string; sessionId: string } | null)) => void;
} = {} as any;

// ─── File-level business functions ──────────────────────────────────────

function selectSessionWithStop(
  e: any,
  project: ProjectFolder,
  sessionId: string,
  onSelectSession: (project: ProjectFolder, sessionId: string) => void,
): void {
  e.stopPropagation();
  onSelectSession(project, sessionId);
}

function onToggleMenu(
  e: any,
  projectRoot: string,
  sessionId: string,
): void {
  e.stopPropagation();
  WriteState.setOpenSessionMenu(
    (current: { root: string; sessionId: string } | null) =>
      current?.root === projectRoot && current.sessionId === sessionId
        ? null
        : { root: projectRoot, sessionId },
  );
}

function forkSessionWithStop(
  e: any,
  project: ProjectFolder,
  session: ProjectSession,
  onForkSession: (project: ProjectFolder, session: ProjectSession) => void,
): void {
  e.stopPropagation();
  onForkSession(project, session);
}

function hideSessionWithStop(
  e: any,
  project: ProjectFolder,
  session: ProjectSession,
  onHideSession: (project: ProjectFolder, session: ProjectSession) => void,
): void {
  e.stopPropagation();
  onHideSession(project, session);
}

function createSessionWithStop(
  e: any,
  project: ProjectFolder,
  onCreateSession: (project: ProjectFolder) => void,
): void {
  e.stopPropagation();
  onCreateSession(project);
}

// ─── renderFn functions ───────────────────────────────────────────────

function renderSessionList(
  {openSessionMenu}: { openSessionMenu: { root: string; sessionId: string } | null },
  {project, activeSessionId, onSelectSession, onForkSession, onHideSession, onCreateSession}: { project: ProjectFolder; activeSessionId: string | null; onSelectSession: (project: ProjectFolder, sessionId: string) => void; onForkSession: (project: ProjectFolder, session: ProjectSession) => void; onHideSession: (project: ProjectFolder, session: ProjectSession) => void; onCreateSession: (project: ProjectFolder) => void },
  {selectSessionWithStop, onToggleMenu, forkSessionWithStop, hideSessionWithStop, createSessionWithStop}: {
    selectSessionWithStop: (e: any, project: ProjectFolder, sessionId: string, onSelectSession: (project: ProjectFolder, sessionId: string) => void) => void;
    onToggleMenu: (e: any, projectRoot: string, sessionId: string) => void;
    forkSessionWithStop: (e: any, project: ProjectFolder, session: ProjectSession, onForkSession: (project: ProjectFolder, session: ProjectSession) => void) => void;
    hideSessionWithStop: (e: any, project: ProjectFolder, session: ProjectSession, onHideSession: (project: ProjectFolder, session: ProjectSession) => void) => void;
    createSessionWithStop: (e: any, project: ProjectFolder, onCreateSession: (project: ProjectFolder) => void) => void;
  },
): JSX.Element {
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
              onClick={(e) => selectSessionWithStop(e, project, session.id, onSelectSession)}
            >
              <span
                className={`session-status-dot ${session.processStatus === "active" ? "active" : "stopped"}`}
                title={statusTitle}
                aria-label={statusTitle}
              />
              <span className="tree-label" title={session.title}>
                {session.title}
              </span>
            </button>
            <button
              className="session-menu-button"
              type="button"
              aria-label={`Open menu for ${session.title}`}
              aria-expanded={isMenuOpen}
              onClick={(e) => onToggleMenu(e, project.root, session.id)}
            >
              ...
            </button>
            {isMenuOpen ? (
              <div className="session-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => forkSessionWithStop(e, project, session, onForkSession)}
                >
                  Fork
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => hideSessionWithStop(e, project, session, onHideSession)}
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
        onClick={(e) => createSessionWithStop(e, project, onCreateSession)}
      >
        <span className="nav-icon tiny plain" aria-hidden="true">+</span>
        <span className="tree-label">新建会话</span>
      </button>
    </div>
  );
}

// ─── View component ───────────────────────────────────────────────────

export function SessionListView({
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

  // WriteState registrations
  WriteState.setOpenSessionMenu = setOpenSessionMenu;

  return render({
    state: {openSessionMenu},
    props: {project, activeSessionId, onSelectSession, onForkSession, onHideSession, onCreateSession},
    fn: renderSessionList,
    events: {selectSessionWithStop, onToggleMenu, forkSessionWithStop, hideSessionWithStop, createSessionWithStop},
    memo: {},
  });
}
