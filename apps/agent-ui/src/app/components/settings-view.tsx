import { useState, useEffect } from "react";
import type { ModelEndpointConfig, ModelSettings } from "../../types";
import type { RemoteProfile } from "../../runtime";
import type { SettingsViewProps, SettingsSection } from "../types";
import { sessionKey } from "../file-utils";
import { loadDeepseekPricing } from "../../tauri";
import {
  loadModelSettings,
  saveModelSettings,
  testModelConnection,
  loadRemoteProfiles,
  getActiveRemoteProfileId,
  createRemoteProfileInput,
  useRemoteRuntime,
  useLocalRuntime,
  clearActiveRemoteProfileId,
  deleteRemoteProfile,
  upsertRemoteProfile,
  setActiveRemoteProfileId,
} from "../../runtime";

// ─── RemoteSettingsPanel ───────────────────────────────────────────────

function RemoteSettingsPanel() {
  const [profiles, setProfiles] = useState<RemoteProfile[]>(() => loadRemoteProfiles());
  const [activeProfileId, setActiveProfileIdState] = useState<string | null>(() =>
    getActiveRemoteProfileId(),
  );
  const [name, setName] = useState("Remote proxy");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:7421");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("Remote panel ready.");
  const [testClickCount, setTestClickCount] = useState(0);

  function draftProfile(): RemoteProfile {
    return createRemoteProfileInput({
      name: name || "Remote",
      baseUrl,
      token,
    });
  }

  async function handleTestRemote() {
    const click = testClickCount + 1;
    setTestClickCount(click);

    const profile = draftProfile();
    const healthUrl = `${profile.baseUrl.replace(/\/+$/, "")}/health`;

    // 这行必须立刻显示；如果它不显示，说明按钮点击事件本身没有触发。
    setStatus(`Clicked Test /health #${click}: ${healthUrl}`);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(profile.token ? { Authorization: `Bearer ${profile.token}` } : {}),
        },
      });

      const text = await response.text();

      if (!response.ok) {
        setStatus(`Remote test failed: HTTP ${response.status} ${response.statusText}. ${text.slice(0, 300)}`);
        return;
      }

      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {
        setStatus(`Remote responded HTTP ${response.status}, but JSON parse failed: ${text.slice(0, 300)}`);
        return;
      }

      setStatus(
        `Remote connected. proxy=${body?.proxyVersion ?? "-"} protocol=${body?.protocolVersion ?? "-"} url=${healthUrl}`,
      );
    } catch (error) {
      setStatus(
        `Remote test error for ${healthUrl}: ${
          error instanceof DOMException && error.name === "AbortError"
            ? "Request timed out after 5 seconds"
            : error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error)
        }`,
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function handleSaveProfile() {
    const profile = draftProfile();
    const nextProfiles = upsertRemoteProfile(profile);
    setProfiles(nextProfiles);
    setActiveRemoteProfileId(profile.id);
    setActiveProfileIdState(profile.id);
    setStatus(`Saved remote profile: ${profile.name}`);
  }

  function handleUseDraftRemote() {
    const profile = draftProfile();
    const nextProfiles = upsertRemoteProfile(profile);
    setProfiles(nextProfiles);
    useRemoteRuntime(profile);
    setActiveRemoteProfileId(profile.id);
    setActiveProfileIdState(profile.id);
    setStatus(`Using remote runtime: ${profile.name}. Reloading...`);
    window.setTimeout(() => window.location.reload(), 50);
  }

  function handleUseRemote(profile: RemoteProfile) {
    useRemoteRuntime(profile);
    setActiveRemoteProfileId(profile.id);
    setActiveProfileIdState(profile.id);
    setStatus(`Using remote runtime: ${profile.name}. Reloading...`);
    window.setTimeout(() => window.location.reload(), 50);
  }

  function handleUseLocal() {
    useLocalRuntime();
    clearActiveRemoteProfileId();
    setActiveProfileIdState(null);
    setStatus("Using local runtime. Reloading...");
    window.setTimeout(() => window.location.reload(), 50);
  }

  function handleDeleteRemote(profile: RemoteProfile) {
    const nextProfiles = deleteRemoteProfile(profile.id);
    setProfiles(nextProfiles);

    if (activeProfileId === profile.id) {
      useLocalRuntime();
      setActiveProfileIdState(null);
      setStatus(`Deleted active remote "${profile.name}". Using local runtime.`);
    } else {
      setStatus(`Deleted remote "${profile.name}".`);
    }
  }

  return (
    <>
      <header className="settings-heading">
        <h2>Remote runtime</h2>
        <p>
          Save remote proxy connection profiles here. Mac keeps connection info only; sessions,
          workspaces, skills, MCP and models belong to the remote proxy.
        </p>
      </header>

      <section className="settings-card remote-settings-card">
        <header className="settings-card-header">
          <div className="settings-card-title">
            <h3>Connection profile</h3>
            <p>Test /health first, then use this remote.</p>
          </div>
        </header>

        <div className="remote-profile-form">
          <label className="remote-field remote-field-name">
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <label className="remote-field remote-field-url">
            <span>Base URL</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>

          <label className="remote-field remote-field-token">
            <span>Token</span>
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="optional"
              type="password"
            />
          </label>
        </div>

        <div className="remote-settings-actions">
          <button className="remote-button secondary" type="button" onClick={handleTestRemote}>
            Test /health
          </button>
          <button className="remote-button secondary" type="button" onClick={handleSaveProfile}>
            Save profile
          </button>
          <button className="remote-button primary" type="button" onClick={handleUseDraftRemote}>
            Use this remote
          </button>
          <button className="remote-button ghost" type="button" onClick={handleUseLocal}>
            Use local
          </button>
        </div>

        <p className="settings-status">{status}</p>
      </section>

      <section className="settings-card remote-settings-card">
        <header className="settings-card-header">
          <div className="settings-card-title">
            <h3>Saved remotes</h3>
            <p>Profiles are deduped by name. Same URL with different names is allowed.</p>
          </div>
        </header>

        {profiles.length === 0 ? (
          <div className="hidden-session-empty">No remote profiles saved.</div>
        ) : (
          <div className="remote-profile-list">
            {profiles.map((profile) => {
              const isActive = activeProfileId === profile.id;
              return (
                <article className={`remote-profile-row ${isActive ? "active" : ""}`} key={profile.id}>
                  <div className="remote-profile-main">
                    <div className="remote-profile-title-row">
                      <strong>{profile.name}</strong>
                      <span className={`remote-profile-status ${isActive ? "active" : ""}`}>
                        {isActive ? "Active" : "Saved"}
                      </span>
                    </div>
                    <span className="remote-profile-url">{profile.baseUrl}</span>
                  </div>
                  <div className="remote-profile-actions">
                    <button
                      className="remote-button compact primary"
                      type="button"
                      onClick={() => handleUseRemote(profile)}
                      disabled={isActive}
                    >
                      {isActive ? "In use" : "Use"}
                    </button>
                    <button
                      className="remote-button compact ghost danger"
                      type="button"
                      onClick={() => handleDeleteRemote(profile)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

// ─── SessionsSettingsPanel ─────────────────────────────────────────────

function SessionsSettingsPanel({
  hiddenSessions,
  onRestoreSession,
}: SettingsViewProps) {
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
            hiddenSessions.map((session) => (
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
                  onClick={() => void onRestoreSession(session)}
                >
                  Restore
                </button>
              </article>
            ))
          )}
        </div>
      </section></>
  );
}

// ─── SettingsView ──────────────────────────────────────────────────────

export function SettingsView({ hiddenSessions, onRestoreSession }: SettingsViewProps) {
  const [savedSettings, setSavedSettings] = useState<ModelSettings | null>(
    null,
  );
  const [draftSettings, setDraftSettings] = useState<ModelSettings | null>(
    null,
  );
  const [selectedModelId, setSelectedModelId] = useState<string>("deepseek-v3");
  const [status, setStatus] = useState<string>("Loading model settings...");
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("models");

  useEffect(() => {
    let cancelled = false;
    loadModelSettings()
      .then(async (settings) => {
        if (cancelled) {
          return;
        }
        try {
          const pricing = await loadDeepseekPricing();
          if (pricing) {
            settings = { ...settings, deepseekPricing: pricing };
          }
        } catch {}
        setSavedSettings(settings);
        setDraftSettings(settings);
        setSelectedModelId(settings.activeModelId);
        setStatus("Model settings loaded.");
      })
      .catch((reason) => {
        if (!cancelled) {
          setStatus(`Failed to load model settings: ${String(reason)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeModel =
    draftSettings?.models.find((model) => model.id === selectedModelId) ??
    draftSettings?.models[0] ??
    null;
  const hasUnsavedChanges = Boolean(
    savedSettings &&
    draftSettings &&
    JSON.stringify(savedSettings) !== JSON.stringify(draftSettings),
  );

  function selectModel(id: string) {
    setSelectedModelId(id);
    setDraftSettings((settings) =>
      settings ? { ...settings, activeModelId: id } : settings,
    );
    setStatus(
      "Active model changed. Save changes to apply it to future turns.",
    );
  }

  function updateSelectedModel(
    updater: (model: ModelEndpointConfig) => ModelEndpointConfig,
  ) {
    setDraftSettings((settings) => {
      if (!settings) {
        return settings;
      }
      return {
        ...settings,
        models: settings.models.map((model) =>
          model.id === selectedModelId ? updater(model) : model,
        ),
      };
    });
  }

  async function handleSaveSettings() {
    if (!draftSettings || isSaving) {
      return;
    }
    setIsSaving(true);
    setStatus("Saving model settings...");
    try {
      const saved = await saveModelSettings(draftSettings);
      setSavedSettings(saved);
      setDraftSettings(saved);
      setSelectedModelId(saved.activeModelId);
      setStatus(
        "Saved. Future agent turns will use the active model configuration.",
      );
    } catch (reason) {
      setStatus(`Save failed: ${String(reason)}`);
    } finally {
      setIsSaving(false);
    }
  }

  function handleDiscardSettings() {
    if (!savedSettings) {
      return;
    }
    setDraftSettings(savedSettings);
    setSelectedModelId(savedSettings.activeModelId);
    setStatus("Discarded unsaved settings.");
  }

  async function handleTestConnection() {
    if (!draftSettings || isTesting) {
      return;
    }
    setIsTesting(true);
    setStatus("Testing active model connection...");
    try {
      const result = await testModelConnection(draftSettings);
      setStatus(
        result.ok
          ? `${result.message} (${result.model})`
          : `${result.message}${result.stderr ? `: ${result.stderr}` : ""}`,
      );
    } catch (reason) {
      setStatus(`Connection test failed: ${String(reason)}`);
    } finally {
      setIsTesting(false);
    }
  }

  const modelCards = draftSettings?.models ?? [];

  return (
    <section className="settings-view" aria-label="System settings">
      <header className="settings-topbar">
        <div className="settings-title-row">
          <strong>System Settings</strong>
          <nav aria-label="Settings sections">
            <button
              className={settingsSection === "models" ? "active" : ""}
              type="button"
              onClick={() => setSettingsSection("models")}
            >
              Models
            </button>
            <button type="button" disabled>
              <span className="settings-svg-icon" aria-hidden="true">
  <svg viewBox="0 0 24 24" focusable="false">

              </svg>
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

      <div className="settings-body">
        <aside className="settings-groups" aria-label="Configuration groups">
          <button
            type="button"
            className={settingsSection === "models" ? "active" : ""}
            onClick={() => setSettingsSection("models")}
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
            onClick={() => setSettingsSection("remote")}
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
            onClick={() => setSettingsSection("sessions")}
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

        <section className="settings-content" aria-label="Models configuration">
          <div className="settings-content-inner">
            {settingsSection === "remote" ? (
              <RemoteSettingsPanel />
            ) : settingsSection === "sessions" ? (
              <SessionsSettingsPanel
                hiddenSessions={hiddenSessions}
                onRestoreSession={onRestoreSession}
              />
            ) : (
              <>
                <header className="settings-heading">
                  <h2>Models configuration</h2>
                  <p>
                    Manage large language model endpoints, API credentials, and
                    performance parameters.
                  </p>
                </header>

                <div className="model-grid">
                  {modelCards.map((model) => {
                    const isActive = draftSettings?.activeModelId === model.id;
                    return (
                      <button
                        key={model.id}
                        className={`model-card ${isActive ? "active" : "muted"}`}
                        type="button"
                        onClick={() => selectModel(model.id)}
                      >
                        <div className="model-card-top">
                          <span className="model-icon">{model.provider}</span>
                          {isActive ? (
                            <span className="model-badge">Active</span>
                          ) : null}
                        </div>
                        <strong>{model.name}</strong>
                        <small>{model.model}</small>
                      </button>
                    );
                  })}
                </div>

                <section className="settings-card">
                  <header className="settings-card-header">
                    <div className="settings-card-title">
                      <span className="ds-logo">
                        {activeModel?.provider.slice(0, 2).toUpperCase() ??
                          "--"}
                      </span>
                      <div>
                        <h3>
                          {activeModel
                            ? `${activeModel.name} Configuration`
                            : "Model Configuration"}
                        </h3>
                        <p>
                          {hasUnsavedChanges
                            ? "Unsaved changes"
                            : "Saved configuration"}
                        </p>
                      </div>
                    </div>
                    <span className="operational-badge">
                      {activeModel?.enabled ? "Operational" : "Disabled"}
                    </span>
                  </header>

                  <div className="settings-form">
                    <section className="settings-row">
                      <div>
                        <h4>API Credentials</h4>
                        <p>
                          Secure access keys for the selected model provider
                          endpoint.
                        </p>
                      </div>
                      <div className="settings-fields">
                        <div>
                          <span>Support Models</span>
                          {activeModel?.provider === "deepseek" ? (
                            <p>
                              1. {activeModel?.supportModels?.[0] ?? "-"}
                              <br />
                              2. {activeModel?.supportModels?.[1] ?? "-"}
                            </p>
                          ) : (
                            <p>
                              Current:{" "}
                              <strong>{activeModel?.model ?? "-"}</strong>
                            </p>
                          )}
                        </div>
                        <label>
                          <span>Base URL</span>
                          <input
                            type="text"
                            value={activeModel?.baseUrl ?? ""}
                            onChange={(event) =>
                              updateSelectedModel((model) => ({
                                ...model,
                                baseUrl: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>API Key</span>
                          <div className="secret-field">
                            <input
                              type={showApiKey ? "text" : "password"}
                              value={activeModel?.apiKey ?? ""}
                              placeholder="Paste API key..."
                              onChange={(event) =>
                                updateSelectedModel((model) => ({
                                  ...model,
                                  apiKey: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              aria-label="Show API key"
                              onClick={() => setShowApiKey((value) => !value)}
                            >
                              {showApiKey ? "hide" : "show"}
                            </button>
                          </div>
                        </label>
                        <label>
                          <span>Organization ID (Optional)</span>
                          <input
                            type="text"
                            value={activeModel?.organizationId ?? ""}
                            placeholder="Optional"
                            onChange={(event) =>
                              updateSelectedModel((model) => ({
                                ...model,
                                organizationId: event.target.value || null,
                              }))
                            }
                          />
                        </label>
                      </div>
                    </section>

                    <section className="settings-row">
                      <div>
                        <h4>Advanced Parameters</h4>
                        <p>
                          Control the deterministic nature and context limits of
                          the inference engine.
                        </p>
                      </div>
                      <div className="settings-fields two-column">
                        <label>
                          <span>Max Tokens</span>
                          <div className="token-field">
                            <input
                              type="number"
                              min="1"
                              value={activeModel?.maxTokens ?? 4096}
                              onChange={(event) =>
                                updateSelectedModel((model) => ({
                                  ...model,
                                  maxTokens: Math.max(
                                    1,
                                    Number(event.target.value) || 1,
                                  ),
                                }))
                              }
                            />
                            <em>TOK</em>
                          </div>
                        </label>
                        <label>
                          <span>Temperature</span>
                          <input
                            className="temperature-range"
                            max="2"
                            min="0"
                            step="0.1"
                            type="range"
                            value={activeModel?.temperature ?? 0.7}
                            onChange={(event) =>
                              updateSelectedModel((model) => ({
                                ...model,
                                temperature: Number(event.target.value),
                              }))
                            }
                          />
                          <div className="range-labels">
                            <small>0.0</small>
                            <small>
                              Current: {activeModel?.temperature ?? 0.7}
                            </small>
                            <small>2.0</small>
                          </div>
                        </label>
                      </div>
                    </section>

                    <section className="settings-row">
                      <div>
                        <h4>DeepSeek Pricing</h4>
                        <p>Fetched from DeepSeek official Chinese pricing page and used for local RMB cost estimates.</p>
                      </div>
                      <div className="deepseek-pricing-card">
                        <div className="deepseek-pricing-meta">
                          <span>Source: {draftSettings?.deepseekPricing?.source}</span>
                          <span>Fetched: {draftSettings?.deepseekPricing?.fetchedAt}</span>
                        </div>
                        {(draftSettings?.deepseekPricing?.models ?? []).length > 0 ? (
                          <table className="deepseek-pricing-table">
                            <thead>
                              <tr>
                                <th>Model</th>
                                <th>Item</th>
                                <th>RMB / 1M tokens</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(draftSettings?.deepseekPricing?.models ?? []).flatMap((model) =>
                                model.items.map((item) => (
                                  <tr key={`${model.model}:${item.item}`}>
                                    <td>{model.model}</td>
                                    <td>{item.item}</td>
                                    <td>¥{item.pricePerMTokens}</td>
                                  </tr>
                                )),
                              )}
                            </tbody>
                          </table>
                        ) : (
                          <div className="deepseek-pricing-empty">
                            No DeepSeek pricing loaded yet. Run npm run pricing:deepseek or restart the desktop app.
                          </div>
                        )}
                      </div>
                    </section>
                  </div>

                  <footer className="settings-actions">
                    <button
                      className="test-button"
                      type="button"
                      onClick={handleTestConnection}
                      disabled={!activeModel || isTesting}
                    >
                      {isTesting ? "Testing..." : "Test Connection"}
                    </button>
                    <div>
                      <button
                        className="discard-button"
                        type="button"
                        onClick={handleDiscardSettings}
                        disabled={!hasUnsavedChanges || isSaving}
                      >
                        Discard
                      </button>
                      <button
                        className="save-button"
                        type="button"
                        onClick={handleSaveSettings}
                        disabled={!hasUnsavedChanges || isSaving}
                      >
                        {isSaving ? "Saving..." : "Save Changes"}
                      </button>
                    </div>
                  </footer>
                </section>

                <section className="settings-help">
                  <div>
                    <span aria-hidden="true">i</span>
                    <div>
                      <strong>Need help configuring DeepSeek?</strong>
                      <p>{status}</p>
                    </div>
                  </div>
                  <button type="button">Read Docs -&gt;</button>
                </section>
              </>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
