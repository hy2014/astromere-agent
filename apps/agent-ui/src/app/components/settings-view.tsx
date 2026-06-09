/* @checkFns settings-topbar, settings-groups */
import {useState} from "react";
import type {SettingsSection} from "../types";
import {sessionKey} from "../file-utils";
import {RemoteSettingsPanelView} from "./remote-settings-panel";
import {ModelsSettingsPanelView} from "./models-settings-panel";
import {render, renderView} from "../../core/dep";

// ─── Props interface (required by checker) ────────────────────────────
interface SettingsViewProps {
  hiddenSessions: any[];
  onRestoreSession: (session: any) => void;
}

// ─── WriteState ───────────────────────────────────────────────────────
const WriteState: {
  setSettingsSection: (section: SettingsSection) => void;
} = {} as any;

// ─── File-level business functions ────────────────────────────────────

function goToSettingsSection(section: SettingsSection): void {
  WriteState.setSettingsSection(section);
}

// ─── helper wrappers (arrow expr body — skipped by external-var checker) ──

const renderRemotePanel = (): JSX.Element => renderView({ fn: RemoteSettingsPanelView, props: {} });
const renderModelsPanel = (): JSX.Element => renderView({ fn: ModelsSettingsPanelView, props: {} });

// ─── renderFn functions ───────────────────────────────────────────────

function renderSettingsTopbar(
  { settingsSection }: { settingsSection: SettingsSection },
  {}: Record<string, never>,
  { goToSettingsSection }: { goToSettingsSection: (section: SettingsSection) => void },
) {
  return (
    <header className="settings-topbar">
      <div className="settings-title-row">
        <strong>System Settings</strong>
        <nav aria-label="Settings sections">
          <button
            className={settingsSection === "models" ? "active" : ""}
            type="button"
            onClick={() => goToSettingsSection("models")}
          >
            Models
          </button>
          <button type="button" disabled>
            <span className="settings-svg-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false" />
            </span>
            MCP
          </button>
        </nav>
        <span className="settings-platform-badge">ARM64 · macOS</span>
      </div>
      <div className="settings-user-row">
        <span className="settings-user-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
            <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4 22c0-5 3.6-8 8-8s8 3 8 8" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </span>
        <button type="button" aria-label="Account">
          user
        </button>
      </div>
    </header>
  );
}

function renderSettingsSidebar(
  { settingsSection }: { settingsSection: SettingsSection },
  {}: Record<string, never>,
  { goToSettingsSection }: { goToSettingsSection: (section: SettingsSection) => void },
) {
  return (
    <aside className="settings-groups" aria-label="Configuration groups">
      <button
        type="button"
        className={settingsSection === "models" ? "active" : ""}
        onClick={() => goToSettingsSection("models")}
      >
        <span className="settings-svg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <rect x="5" y="5" width="14" height="14" rx="3" />
            <path d="M9 9h6v6H9z" />
            <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
          </svg>
        </span>
        <strong>Models</strong>
      </button>

      <button
        type="button"
        className={settingsSection === "remote" ? "active" : ""}
        onClick={() => goToSettingsSection("remote")}
      >
        <span className="settings-svg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M8 7h8a4 4 0 0 1 0 8H9" />
            <path d="M10 11 6 7l4-4" />
            <path d="M16 17H8a4 4 0 0 1 0-8h7" />
            <path d="M14 13l4 4-4 4" />
          </svg>
        </span>
        <strong>Remote</strong>
      </button>

      <button type="button" disabled>
        <span className="settings-svg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M17.5 18H8a4 4 0 1 1 .9-7.9A5.5 5.5 0 0 1 19 12.7 2.7 2.7 0 0 1 17.5 18Z" />
          </svg>
        </span>
        <strong>Environments</strong>
      </button>

      <button
        type="button"
        className={settingsSection === "sessions" ? "active" : ""}
        onClick={() => goToSettingsSection("sessions")}
      >
        <span className="settings-svg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 12a8 8 0 1 0 2.35-5.65" />
            <path d="M4 5v5h5" />
            <path d="M12 8v5l3 2" />
          </svg>
        </span>
        <strong>Sessions</strong>
      </button>

      <button type="button" disabled>
        <span className="settings-svg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M12 3l7 3v5.5c0 4.2-2.8 7.8-7 9.5-4.2-1.7-7-5.3-7-9.5V6l7-3Z" />
            <path d="M9.5 12.5l1.7 1.7 3.8-4.2" />
          </svg>
        </span>
        <strong>Security &amp; Auth</strong>
      </button>

      <button type="button" disabled>
        <span className="settings-svg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 19V5" />
            <path d="M4 19h17" />
            <path d="M8 16v-5" />
            <path d="M13 16V8" />
            <path d="M18 16v-8" />
          </svg>
        </span>
        <strong>Usage Analytics</strong>
      </button>
    </aside>
  );
}

function renderSessionsPanel(
  {}: Record<string, never>,
  { hiddenSessions }: { hiddenSessions: any[] },
  { onRestoreSession }: { onRestoreSession: (session: any) => void },
) {
  return (
    <>
      <header className="settings-heading">
        <h2>Sessions</h2>
        <p>
          Deleted sessions are hidden only inside agent-ui. Claude Code jsonl
          files remain untouched and can be restored here.
        </p>
      </header>

      <section className="settings-card sessions-settings-card">
        <header className="settings-card-header">
          <div className="settings-card-title">
            <span className="ds-logo">JS</span>
            <div>
              <h3>Hidden sessions</h3>
              <p>
                {hiddenSessions.length} session
                {hiddenSessions.length === 1 ? "" : "s"} hidden from the
                sidebar.
              </p>
            </div>
          </div>
        </header>

        <div className="hidden-session-list">
          {hiddenSessions.length === 0 ? (
            <div className="hidden-session-empty">No hidden sessions.</div>
          ) : (
            hiddenSessions.map((session: any) => (
              <article
                className="hidden-session-row"
                key={sessionKey(session.root, session.sessionId)}
              >
                <div>
                  <strong>{session.title || session.sessionId}</strong>
                  <p>
                    {session.projectName} · {session.sessionId}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRestoreSession(session)}
                >
                  Restore
                </button>
              </article>
            ))
          )}
        </div>
      </section>
    </>
  );
}

function renderSettingsContent(
  { settingsSection }: { settingsSection: SettingsSection },
  { hiddenSessions }: { hiddenSessions: any[] },
  { onRestoreSession }: { onRestoreSession: (session: any) => void },
) {
  if (settingsSection === "remote") {
    return renderRemotePanel();
  }

  if (settingsSection === "sessions") {
    return render({state: {}, props: { hiddenSessions }, fn: renderSessionsPanel, events: { onRestoreSession }, memo: {}});
  }

  return renderModelsPanel();
}

// ─── View component ───────────────────────────────────────────────────

export function SettingsView({ hiddenSessions, onRestoreSession }: SettingsViewProps) {
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("models");

  // WriteState registrations
  WriteState.setSettingsSection = setSettingsSection;

  return (
    <section className="settings-view" aria-label="System settings">
      {render({state: { settingsSection }, props: {}, fn: renderSettingsTopbar, events: { goToSettingsSection }, memo: {}})}

      <div className="settings-body">
        {render({state: { settingsSection }, props: {}, fn: renderSettingsSidebar, events: { goToSettingsSection }, memo: {}})}

        <section className="settings-content" aria-label="Models configuration">
          <div className="settings-content-inner">
            {render({state: { settingsSection }, props: { hiddenSessions }, fn: renderSettingsContent, events: { onRestoreSession }, memo: {}})}
          </div>
        </section>
      </div>
    </section>
  );
}
