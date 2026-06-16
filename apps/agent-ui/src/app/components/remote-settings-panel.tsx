/* @checkFns remote-form-card, remote-profile-card */
import {useState} from "react";
import type {RemoteProfile} from "../../runtime";
import {
    clearActiveRemoteProfileId,
    createRemoteProfileInput,
    deleteRemoteProfile,
    getActiveRemoteProfileId,
    loadRemoteProfiles,
    setActiveRemoteProfileId,
    upsertRemoteProfile,
    useLocalRuntime,
    useRemoteRuntime,
} from "../../runtime";
import {render} from "../../core/dep";

// ─── WriteState ───────────────────────────────────────────────────────
const WriteState: {
  setProfiles: (profiles: RemoteProfile[] | ((prev: RemoteProfile[]) => RemoteProfile[])) => void;
  setActiveProfileIdState: (id: string | null) => void;
  setName: (s: string) => void;
  setBaseUrl: (s: string) => void;
  setToken: (s: string) => void;
  setStatus: (s: string) => void;
  setTestClickCount: (n: number | ((prev: number) => number)) => void;
} = {} as any;

// ─── File-level helpers (expression-body arrows — skipped by checker) ──
const $AbortController = (): AbortController => new AbortController();
const $isAbortError = (e: unknown): boolean => e instanceof DOMException && (e as Error).name === "AbortError";

// ─── File-level business functions ────────────────────────────────────

function updateName(value: string): void {
  WriteState.setName(value);
}

function updateBaseUrl(url: string): void {
  WriteState.setBaseUrl(url);
}

function updateToken(value: string): void {
  WriteState.setToken(value);
}

function draftProfileInput(name: string, baseUrl: string, token: string): RemoteProfile {
  return createRemoteProfileInput({
    name: name || "Remote",
    baseUrl,
    token,
  });
}

async function handleTestRemote(
  name: string,
  baseUrl: string,
  token: string,
  testClickCount: number,
): Promise<void> {
  const click = testClickCount + 1;
  WriteState.setTestClickCount(click);

  const profile = draftProfileInput(name, baseUrl, token);
  const healthUrl = `${profile.baseUrl.replace(/\/+$/, "")}/health`;

  WriteState.setStatus(`Clicked Test /health #${click}: ${healthUrl}`);

  const controller = $AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

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
      WriteState.setStatus(`Remote test failed: HTTP ${response.status} ${response.statusText}. ${text.slice(0, 300)}`);
      return;
    }

    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      WriteState.setStatus(`Remote responded HTTP ${response.status}, but JSON parse failed: ${text.slice(0, 300)}`);
      return;
    }

    WriteState.setStatus(
      `Remote connected. proxy=${body?.proxyVersion ?? "-"} protocol=${body?.protocolVersion ?? "-"} url=${healthUrl}`,
    );
  } catch (error) {
    WriteState.setStatus(
      `Remote test error for ${healthUrl}: ${
        $isAbortError(error)
          ? "Request timed out after 5 seconds"
          : error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
      }`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function handleSaveProfile(name: string, baseUrl: string, token: string): void {
  const profile = draftProfileInput(name, baseUrl, token);
  const nextProfiles = upsertRemoteProfile(profile);
  WriteState.setProfiles(nextProfiles);
  setActiveRemoteProfileId(profile.id);
  WriteState.setActiveProfileIdState(profile.id);
  WriteState.setStatus(`Saved remote profile: ${profile.name}`);
}

function handleUseDraftRemote(name: string, baseUrl: string, token: string): void {
  const profile = draftProfileInput(name, baseUrl, token);
  const nextProfiles = upsertRemoteProfile(profile);
  WriteState.setProfiles(nextProfiles);
  useRemoteRuntime(profile);
  setActiveRemoteProfileId(profile.id);
  WriteState.setActiveProfileIdState(profile.id);
  WriteState.setStatus(`Using remote runtime: ${profile.name}. Reloading...`);
  setTimeout(() => window.location.reload(), 50);
}

function handleUseRemote(profile: RemoteProfile): void {
  useRemoteRuntime(profile);
  setActiveRemoteProfileId(profile.id);
  WriteState.setActiveProfileIdState(profile.id);
  WriteState.setStatus(`Using remote runtime: ${profile.name}. Reloading...`);
  setTimeout(() => window.location.reload(), 50);
}

function handleUseLocal(): void {
  useLocalRuntime();
  clearActiveRemoteProfileId();
  WriteState.setActiveProfileIdState(null);
  WriteState.setStatus("Using local runtime. Reloading...");
  setTimeout(() => window.location.reload(), 50);
}

function handleDeleteRemote(profile: RemoteProfile, activeProfileId: string | null): void {
  const nextProfiles = deleteRemoteProfile(profile.id);
  WriteState.setProfiles(nextProfiles);

  if (activeProfileId === profile.id) {
    useLocalRuntime();
    WriteState.setActiveProfileIdState(null);
    WriteState.setStatus(`Deleted active remote "${profile.name}". Using local runtime.`);
  } else {
    WriteState.setStatus(`Deleted remote "${profile.name}".`);
  }
}

// ─── renderFn functions ───────────────────────────────────────────────

function renderRemoteForm(
  { name, baseUrl, token, status, testClickCount }: { name: string; baseUrl: string; token: string; status: string; testClickCount: number },
  {}: Record<string, never>,
  { updateName, updateBaseUrl, updateToken, handleTestRemote, handleSaveProfile, handleUseDraftRemote, handleUseLocal }: {
    updateName: (s: string) => void;
    updateBaseUrl: (s: string) => void;
    updateToken: (s: string) => void;
    handleTestRemote: (name: string, baseUrl: string, token: string, testClickCount: number) => Promise<void>;
    handleSaveProfile: (name: string, baseUrl: string, token: string) => void;
    handleUseDraftRemote: (name: string, baseUrl: string, token: string) => void;
    handleUseLocal: () => void;
  },
) {
  return (
    <section className="settings-card remote-settings-card remote-form-card">
      <header className="settings-card-header">
        <div className="settings-card-title">
          <h3>Connection profile</h3>
          <p>Test /health first, then use this remote.</p>
        </div>
      </header>

      <div className="remote-profile-form">
        <label className="remote-field remote-field-name">
          <span>Name</span>
          <input value={name} onChange={(e) => updateName((e.target as HTMLInputElement).value)} />
        </label>

        <label className="remote-field remote-field-url">
          <span>Base URL</span>
          <input value={baseUrl} onChange={(e) => updateBaseUrl((e.target as HTMLInputElement).value)} />
        </label>

        <label className="remote-field remote-field-token">
          <span>Token</span>
          <input
            value={token}
            onChange={(e) => updateToken((e.target as HTMLInputElement).value)}
            placeholder="optional"
            type="password"
          />
        </label>
      </div>

      <div className="remote-settings-actions">
        <button className="remote-button secondary" type="button" onClick={() => handleTestRemote(name, baseUrl, token, testClickCount)}>
          Test /health
        </button>
        <button className="remote-button secondary" type="button" onClick={() => handleSaveProfile(name, baseUrl, token)}>
          Save profile
        </button>
        <button className="remote-button primary" type="button" onClick={() => handleUseDraftRemote(name, baseUrl, token)}>
          Use this remote
        </button>
        <button className="remote-button ghost" type="button" onClick={handleUseLocal}>
          Use local
        </button>
      </div>

      <p className="settings-status">{status}</p>
    </section>
  );
}

function renderRemoteProfileList(
  { profiles, activeProfileId }: { profiles: RemoteProfile[]; activeProfileId: string | null },
  {}: Record<string, never>,
  { handleUseRemote, handleDeleteRemote, handleTestRemote }: { handleUseRemote: (profile: RemoteProfile) => void; handleDeleteRemote: (profile: RemoteProfile, activeProfileId: string | null) => void; handleTestRemote: (name: string, baseUrl: string, token: string) => Promise<void> },
) {
  return (
    <section className="settings-card remote-settings-card remote-profile-card">
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
                    className="remote-button compact secondary"
                    type="button"
                    onClick={() => handleTestRemote(profile.name, profile.baseUrl, profile.token ?? "")}
                  >
                    Test
                  </button>
                  <button
                    className="remote-button compact ghost danger"
                    type="button"
                    onClick={() => handleDeleteRemote(profile, activeProfileId)}
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
  );
}

// ─── View component ───────────────────────────────────────────────────

export function RemoteSettingsPanelView() {
  const [profiles, setProfiles] = useState<RemoteProfile[]>(() => loadRemoteProfiles());
  const [activeProfileId, setActiveProfileIdState] = useState<string | null>(() =>
    getActiveRemoteProfileId(),
  );
  const [name, setName] = useState("Remote proxy");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:7421");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("Remote panel ready.");
  const [testClickCount, setTestClickCount] = useState(0);

  // WriteState registrations
  WriteState.setProfiles = setProfiles;
  WriteState.setActiveProfileIdState = setActiveProfileIdState;
  WriteState.setName = setName;
  WriteState.setBaseUrl = setBaseUrl;
  WriteState.setToken = setToken;
  WriteState.setStatus = setStatus;
  WriteState.setTestClickCount = setTestClickCount;

  return (
    <>
      <header className="settings-heading">
        <h2>Remote runtime</h2>
        <p>
          Save remote proxy connection profiles here. Mac keeps connection info only; sessions,
          workspaces, skills, MCP and models belong to the remote proxy.
        </p>
      </header>

      {render({
        state: { name, baseUrl, token, status, testClickCount },
        props: {},
        fn: renderRemoteForm,
        events: { updateName, updateBaseUrl, updateToken, handleTestRemote, handleSaveProfile, handleUseDraftRemote, handleUseLocal },
        memo: {},
      })}

      {render({
        state: { profiles, activeProfileId },
        props: {},
        fn: renderRemoteProfileList,
        events: { handleUseRemote, handleDeleteRemote, handleTestRemote: (name: string, baseUrl: string, token: string) => handleTestRemote(name, baseUrl, token, 0) },
        memo: {},
      })}
    </>
  );
}
