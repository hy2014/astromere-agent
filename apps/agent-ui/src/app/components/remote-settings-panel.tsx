import { useState } from "react";
import type { RemoteProfile } from "../../runtime";
import {
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

export function RemoteSettingsPanel() {
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
