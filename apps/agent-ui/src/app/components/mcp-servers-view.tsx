import {useEffect, useMemo, useState} from "react";
import type {McpEnvDraftRow, McpServerDraftRow} from "../types";
import type {McpSettings} from "../../types";
import {loadMcpSettings, saveMcpSettings} from "../../runtime";

// ─── Pure helpers ──────────────────────────────────────────────────────

function createMcpDraftId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseMcpArgsText(argsText: string): string[] {
  return argsText
    .split(/\r?\n/)
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function stringifyMcpArgs(args: unknown): string {
  if (!Array.isArray(args)) return "";
  return args
    .map((arg) => String(arg))
    .filter(Boolean)
    .join("\n");
}

function parseMcpEnvRows(env: unknown): McpEnvDraftRow[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  return Object.entries(env as Record<string, unknown>).map(([key, value]) => ({
    id: createMcpDraftId("env"),
    key,
    value: String(value ?? ""),
  }));
}

function mcpDraftRowsFromSettings(settings: unknown): McpServerDraftRow[] {
  const root =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  const servers =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : {};

  return Object.entries(servers).map(([name, rawServer]) => {
    const server =
      rawServer && typeof rawServer === "object" && !Array.isArray(rawServer)
        ? (rawServer as Record<string, unknown>)
        : {};

    return {
      id: createMcpDraftId("server"),
      name,
      type: typeof server.type === "string" ? server.type : "stdio",
      command: typeof server.command === "string" ? server.command : "",
      argsText: stringifyMcpArgs(server.args),
      envRows: parseMcpEnvRows(server.env),
    };
  });
}

function mcpSettingsFromDraftRows(rows: McpServerDraftRow[]): McpSettings {
  const mcpServers: McpSettings["mcpServers"] = {};

  for (const row of rows) {
    const name = row.name.trim();
    const command = row.command.trim();
    if (!name || !command) continue;

    const args = parseMcpArgsText(row.argsText);
    const envEntries = row.envRows
      .map((item) => [item.key.trim(), item.value] as const)
      .filter(([key]) => Boolean(key));

    const server: McpSettings["mcpServers"][string] = { command, tools: [] };
    if (row.type && row.type !== "stdio") server.type = row.type;
    if (args.length > 0) server.args = args;
    if (envEntries.length > 0) server.env = Object.fromEntries(envEntries);

    mcpServers[name] = server;
  }

  return { mcpServers };
}

function stringifyStableMcpSettings(settings: unknown): string {
  return JSON.stringify(settings ?? { mcpServers: {} }, null, 2);
}

function summarizeMcpRows(rows: McpServerDraftRow[]) {
  const validServers = rows.filter((row) => row.name.trim() && row.command.trim());
  return {
    servers: validServers.length,
    args: validServers.reduce((total, row) => total + parseMcpArgsText(row.argsText).length, 0),
    env: validServers.reduce(
      (total, row) => total + row.envRows.filter((env) => env.key.trim()).length,
      0,
    ),
  };
}

// ─── McpServersView component ─────────────────────────────────────────

export function McpServersView() {
  const [configPath, setConfigPath] = useState("");
  const [rows, setRows] = useState<McpServerDraftRow[]>([]);
  const [savedText, setSavedText] = useState(() => stringifyStableMcpSettings({ mcpServers: {} }));
  const [status, setStatus] = useState("Loading MCP servers...");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const draftSettings = useMemo(() => mcpSettingsFromDraftRows(rows), [rows]);
  const draftText = useMemo(() => stringifyStableMcpSettings(draftSettings), [draftSettings]);
  const summary = useMemo(() => summarizeMcpRows(rows), [rows]);
  const hasUnsavedChanges = draftText !== savedText;

  const validationMessage = useMemo(() => {
    const seen = new Set<string>();

    for (const row of rows) {
      const name = row.name.trim();
      const command = row.command.trim();
      const hasDraftContent = Boolean(
        name || command || row.argsText.trim() || row.envRows.some((env) => env.key.trim() || env.value.trim()),
      );

      if (!hasDraftContent) continue;
      if (!name) return "Server name is required.";
      if (!command) return `Command is required for server "${name}".`;
      if (seen.has(name)) return `Duplicate MCP server name: ${name}`;
      seen.add(name);
    }

    return "";
  }, [rows]);

  async function reloadMcpSettings() {
    setIsLoading(true);
    setStatus("Loading MCP servers...");

    try {
      const loaded = await loadMcpSettings();
      const settings = loaded.settings ?? { mcpServers: {} };
      const nextRows = mcpDraftRowsFromSettings(settings);
      const normalized = mcpSettingsFromDraftRows(nextRows);
      const nextText = stringifyStableMcpSettings(normalized);

      setConfigPath(loaded.path ?? "");
      setRows(nextRows);
      setSavedText(nextText);
      setStatus("Loaded MCP server startup config. Tools are discovered from the MCP server at runtime.");
    } catch (reason) {
      setStatus(`Load failed: ${String(reason)}`);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void reloadMcpSettings();
  }, []);

  function handleAddServer() {
    setRows((current) => [
      ...current,
      {
        id: createMcpDraftId("server"),
        name: "",
        type: "stdio",
        command: "",
        argsText: "",
        envRows: [],
      },
    ]);
  }

  function handleAddExampleServer() {
    setRows((current) => [
      ...current,
      {
        id: createMcpDraftId("server"),
        name: "my-server",
        type: "stdio",
        command: "python",
        argsText: "path/to/mcp_server.py",
        envRows: [
          { id: createMcpDraftId("env"), key: "PG_HOST", value: "localhost" },
          { id: createMcpDraftId("env"), key: "PG_PORT", value: "5432" },
        ],
      },
    ]);
  }

  function updateServerRow(id: string, patch: Partial<McpServerDraftRow>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeServerRow(id: string) {
    setRows((current) => current.filter((row) => row.id !== id));
  }

  function addEnvRow(serverId: string) {
    setRows((current) =>
      current.map((row) =>
        row.id === serverId
          ? {
              ...row,
              envRows: [...row.envRows, { id: createMcpDraftId("env"), key: "", value: "" }],
            }
          : row,
      ),
    );
  }

  function updateEnvRow(serverId: string, envId: string, patch: Partial<McpEnvDraftRow>) {
    setRows((current) =>
      current.map((row) =>
        row.id === serverId
          ? {
              ...row,
              envRows: row.envRows.map((env) => (env.id === envId ? { ...env, ...patch } : env)),
            }
          : row,
      ),
    );
  }

  function removeEnvRow(serverId: string, envId: string) {
    setRows((current) =>
      current.map((row) =>
        row.id === serverId ? { ...row, envRows: row.envRows.filter((env) => env.id !== envId) } : row,
      ),
    );
  }

  async function handleSaveMcpSettings() {
    if (validationMessage) {
      setStatus(validationMessage);
      return;
    }

    setIsSaving(true);
    setStatus("Saving MCP servers...");

    try {
      const saved = await saveMcpSettings(draftSettings);
      const settings = saved.settings ?? draftSettings;
      const nextRows = mcpDraftRowsFromSettings(settings);
      const normalized = mcpSettingsFromDraftRows(nextRows);
      const nextText = stringifyStableMcpSettings(normalized);

      setConfigPath(saved.path ?? configPath);
      setRows(nextRows);
      setSavedText(nextText);
      setStatus("Saved. New sessions will use this MCP config. Restart existing sessions to apply it.");
    } catch (reason) {
      setStatus(`Save failed: ${String(reason)}`);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="mcp-clean-view" aria-label="MCP servers">
      <header className="mcp-clean-topbar">
        <div>
          <strong>MCP Servers</strong>
          <span>{hasUnsavedChanges ? "Unsaved changes" : "Saved"}</span>
        </div>
        <nav aria-label="MCP actions">
          <button type="button" onClick={reloadMcpSettings} disabled={isLoading || isSaving}>
            {isLoading ? "Reloading..." : "Reload"}
          </button>
          <button type="button" onClick={handleAddServer}>Add Server</button>
        </nav>
      </header>

      <main className="mcp-clean-page">
        <section className="mcp-clean-hero">
          <div>
            <p className="mcp-clean-kicker">Local MCP config</p>
            <h1>MCP Servers</h1>
            <p>
              Configure local MCP server startup commands. Tools are discovered from the server at runtime,
              so this page only edits <code>command</code>, <code>args</code> and <code>env</code>.
            </p>
          </div>
          <div className="mcp-clean-path" title={configPath || "~/.claude/astromere/mcp.json"}>
            {configPath || "~/.claude/astromere/mcp.json"}
          </div>
        </section>

        <section className="mcp-clean-stats" aria-label="MCP summary">
          <article>
            <span>Servers</span>
            <strong>{summary.servers}</strong>
            <p>Configured startup entries</p>
          </article>
          <article>
            <span>Args</span>
            <strong>{summary.args}</strong>
            <p>One argument per line</p>
          </article>
          <article>
            <span>Env Vars</span>
            <strong>{summary.env}</strong>
            <p>Injected when server starts</p>
          </article>
        </section>

        <section className="mcp-clean-panel">
          <header className="mcp-clean-panel-header">
            <div>
              <h2>Server startup entries</h2>
              <p>Matches the standard <code>{`{ mcpServers: { name: { command, args, env } } }`}</code> shape.</p>
            </div>
            <button className="mcp-clean-primary" type="button" onClick={handleAddServer}>Add Server</button>
          </header>

          <div className="mcp-clean-list">
            {rows.length === 0 ? (
              <section className="mcp-clean-empty">
                <h3>No MCP servers configured</h3>
                <p>Add a server manually, or insert the Python/Postgres example.</p>
                <div>
                  <button className="mcp-clean-primary" type="button" onClick={handleAddServer}>Add Server</button>
                  <button className="mcp-clean-secondary" type="button" onClick={handleAddExampleServer}>Add Example</button>
                </div>
              </section>
            ) : (
              <div className="mcp-clean-table">
                <div className="mcp-clean-table-header">
                  <span>Name</span>
                  <span>Type</span>
                  <span>Command</span>
                  <span>Status</span>
                  <span>Actions</span>
                </div>
                {rows.map((row) => (
                  <div className={`mcp-clean-table-row${editingId === row.id ? " expanded" : ""}`} key={row.id}>
                    <span className="mcp-clean-table-name">{row.name.trim() || "Untitled"}</span>
                    <span className="mcp-clean-table-type">{row.type || "stdio"}</span>
                    <span className="mcp-clean-table-command">{row.command.trim() || "—"}</span>
                    <span className={`mcp-clean-table-status${row.name.trim() && row.command.trim() ? " valid" : ""}`}>
                      {row.name.trim() && row.command.trim() ? "ready" : "draft"}
                    </span>
                    <span className="mcp-clean-table-actions">
                      <button
                        type="button"
                        className="mcp-clean-secondary"
                        onClick={() => setEditingId(editingId === row.id ? null : row.id)}
                      >
                        {editingId === row.id ? "Close" : "Edit"}
                      </button>
                      <button className="mcp-clean-danger" type="button" onClick={() => { removeServerRow(row.id); if (editingId === row.id) setEditingId(null); }}>
                        Remove
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {editingId && (() => {
              const row = rows.find((r) => r.id === editingId);
              if (!row) return null;
              return (
                <article className="mcp-clean-card mcp-clean-edit-card" key={`edit-${row.id}`}>
                  <header className="mcp-clean-card-head">
                    <div>
                      <span>Edit Server</span>
                      <h3>{row.name.trim() || "Untitled server"}</h3>
                    </div>
                    <button className="mcp-clean-secondary" type="button" onClick={() => setEditingId(null)}>
                      Done
                    </button>
                  </header>

                  <div className="mcp-clean-basic-grid">
                    <label>
                      <span>Server name</span>
                      <input
                        value={row.name}
                        placeholder="my-server"
                        onChange={(event) => updateServerRow(row.id, { name: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Type</span>
                      <select
                        value={row.type}
                        onChange={(event) => updateServerRow(row.id, { type: event.target.value })}
                      >
                        <option value="stdio">stdio (recommended)</option>
                        <option value="http">http</option>
                      </select>
                    </label>
                    <label>
                      <span>Command</span>
                      <input
                        value={row.command}
                        placeholder="python / npx / node"
                        onChange={(event) => updateServerRow(row.id, { command: event.target.value })}
                      />
                    </label>
                  </div>

                  <div className="mcp-clean-detail-grid">
                    <label>
                      <span>Args, one per line</span>
                      <textarea
                        value={row.argsText}
                        placeholder={"path/to/mcp_server.py\n--flag\nvalue"}
                        onChange={(event) => updateServerRow(row.id, { argsText: event.target.value })}
                        spellCheck={false}
                      />
                    </label>

                    <section className="mcp-clean-env-box" aria-label="Environment variables">
                      <header>
                        <span>Env</span>
                        <button className="mcp-clean-secondary" type="button" onClick={() => addEnvRow(row.id)}>
                          Add Env
                        </button>
                      </header>

                      {row.envRows.length === 0 ? <p>No environment variables.</p> : null}

                      <div className="mcp-clean-env-list">
                        {row.envRows.map((env) => (
                          <div className="mcp-clean-env-row" key={env.id}>
                            <input
                              value={env.key}
                              placeholder="PG_HOST"
                              onChange={(event) => updateEnvRow(row.id, env.id, { key: event.target.value })}
                            />
                            <input
                              value={env.value}
                              placeholder="localhost"
                              onChange={(event) => updateEnvRow(row.id, env.id, { value: event.target.value })}
                            />
                            <button
                              className="mcp-clean-icon-button"
                              type="button"
                              onClick={() => removeEnvRow(row.id, env.id)}
                              aria-label="Remove environment variable"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                </article>
              );
            })()}
          </div>

          <footer className="mcp-clean-actions">
            <p>{validationMessage || status}</p>
            <div>
              <button className="mcp-clean-secondary" type="button" onClick={reloadMcpSettings} disabled={isLoading || isSaving}>
                Discard
              </button>
              <button
                className="mcp-clean-primary"
                type="button"
                onClick={handleSaveMcpSettings}
                disabled={!hasUnsavedChanges || isSaving || Boolean(validationMessage)}
                title={validationMessage || undefined}
              >
                {isSaving ? "Saving..." : "Save MCP Servers"}
              </button>
            </div>
          </footer>
        </section>
      </main>
    </section>
  );
}
