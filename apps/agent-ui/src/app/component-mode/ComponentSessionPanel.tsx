import {useEffect, useState} from "react";
import type {Component, ComponentSession} from "../../types";
import {createComponentSession, deleteComponentSession, listComponentSessions} from "./api";
import {confirm, message} from "@tauri-apps/plugin-dialog";

export type ComponentSessionPanelProps = {
  component: Component;
  onOpenCode: (workspaceRoot: string, sessionId: string) => void;
};

export function ComponentSessionPanel({component, onOpenCode}: ComponentSessionPanelProps) {
  const [sessions, setSessions] = useState<ComponentSession[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await listComponentSessions(component.id);
      setSessions(result);
    } catch (error) {
      console.error("[component-session-panel] failed to list sessions", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [component.id]);

  const handleCreate = async () => {
    try {
      const session = await createComponentSession(component.id, "New session");
      onOpenCode(component.workspaceRoot, session.sessionId);
      await refresh();
    } catch (error) {
      console.error("[component-session-panel] failed to create session", error);
      await message(String(error), {kind: "error", title: "Create session failed"});
    }
  };

  const handleDelete = async (sessionId: string) => {
    const ok = await confirm("Delete this session association?", {title: "Delete session"});
    if (!ok) return;
    try {
      await deleteComponentSession(sessionId);
      await refresh();
    } catch (error) {
      console.error("[component-session-panel] failed to delete session", error);
      await message(String(error), {kind: "error", title: "Delete session failed"});
    }
  };

  return (
    <div className="component-session-panel">
      <h3>{component.name}</h3>
      <p className="component-session-path">{component.entryPoint}</p>
      <div className="component-session-actions">
        <button type="button" onClick={handleCreate}>
          + New session
        </button>
      </div>
      {loading && <p>Loading sessions...</p>}
      {!loading && sessions.length === 0 && (
        <p className="component-session-empty">No sessions yet. Create one to edit in Code mode.</p>
      )}
      <ul className="component-session-list">
        {sessions.map((session) => (
          <li key={session.id} className="component-session-item">
            <button
              type="button"
              className="component-session-link"
              onClick={() => onOpenCode(component.workspaceRoot, session.sessionId)}
            >
              {session.title || session.sessionId}
            </button>
            <button
              type="button"
              className="component-session-delete"
              onClick={() => handleDelete(session.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
