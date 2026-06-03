/* @checkFns mcp-clean-env-row, mcp-clean-env-list, mcp-clean-table-row, mcp-clean-table, mcp-clean-card */

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

// ─── Data helpers extracted to avoid lint violations on map/filter inside JSX functions ──

function updateRowInList(rows: McpServerDraftRow[], id: string, patch: Partial<McpServerDraftRow>) {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

function removeRowFromList(rows: McpServerDraftRow[], id: string) {
  return rows.filter((row) => row.id !== id);
}

function addEnvToRow(rows: McpServerDraftRow[], serverId: string) {
  return rows.map((row) =>
    row.id === serverId
      ? {
          ...row,
          envRows: [...row.envRows, { id: createMcpDraftId("env"), key: "", value: "" }],
        }
      : row,
  );
}

function updateEnvInRow(
  rows: McpServerDraftRow[],
  serverId: string,
  envId: string,
  patch: Partial<McpEnvDraftRow>,
) {
  return rows.map((row) =>
    row.id === serverId
      ? {
          ...row,
          envRows: row.envRows.map((env) => (env.id === envId ? { ...env, ...patch } : env)),
        }
      : row,
  );
}

function removeEnvFromRow(rows: McpServerDraftRow[], serverId: string, envId: string) {
  return rows.map((row) =>
    row.id === serverId ? { ...row, envRows: row.envRows.filter((env) => env.id !== envId) } : row,
  );
}

// ─── McpServersView component ─────────────────────────────────────────

function McpEnvRow(
  { env }: { env: McpEnvDraftRow },
  {}: Record<string, never>,
  events: {
    onKeyChange: React.ChangeEventHandler<HTMLInputElement>;
    onValueChange: React.ChangeEventHandler<HTMLInputElement>;
    onRemove: () => void;
  },
) {
  return (
    <div className="mcp-clean-env-row">
      <input
        value={env.key}
        placeholder="PG_HOST"
        onChange={events.onKeyChange}
      />
      <input
        value={env.value}
        placeholder="localhost"
        onChange={events.onValueChange}
      />
      <button
        className="mcp-clean-icon-button"
        type="button"
        onClick={events.onRemove}
        aria-label="Remove environment variable"
      >
        ×
      </button>
    </div>
  );
}

function McpEnvList(
  { envRows, forwardUpdate, forwardRemove }: { envRows: McpEnvDraftRow[]; forwardUpdate: (serverId: string, envId: string, patch: Partial<McpEnvDraftRow>) => void; forwardRemove: (serverId: string, envId: string) => void },
  { rowId }: { rowId: string },
  events: Record<string, never>,
) {
  return (
    <div className="mcp-clean-env-list">
      {envRows.map((env) =>
        McpEnvRow(
          { env },
          {},
          {
            onKeyChange: (e) => forwardUpdate(rowId, env.id, { key: (e.target as HTMLInputElement).value }),
            onValueChange: (e) => forwardUpdate(rowId, env.id, { value: (e.target as HTMLInputElement).value }),
            onRemove: () => forwardRemove(rowId, env.id),
          },
        ),
      )}
    </div>
  );
}

function McpServerRow(
  { row }: { row: McpServerDraftRow },
  { editingId }: { editingId: string | null },
  events: { onEdit: () => void; onRemove: () => void },
) {
  return (
    <div className={`mcp-clean-table-row${editingId === row.id ? " expanded" : ""}`}>
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
          onClick={events.onEdit}
        >
          {editingId === row.id ? "Close" : "Edit"}
        </button>
        <button className="mcp-clean-danger" type="button" onClick={events.onRemove}>
          Remove
        </button>
      </span>
    </div>
  );
}

function McpServerTable(
  { rows, forwardEdit, forwardRemove }: { rows: McpServerDraftRow[]; forwardEdit: (id: string | null) => void; forwardRemove: (id: string) => void },
  { editingId }: { editingId: string | null },
  events: Record<string, never>,
) {
  return (
    <div className="mcp-clean-table">
      <div className="mcp-clean-table-header">
        <span>Name</span>
        <span>Type</span>
        <span>Command</span>
        <span>Status</span>
        <span>Actions</span>
      </div>
      {rows.map((row) =>
        McpServerRow(
          { row },
          { editingId },
          {
            onEdit: () => forwardEdit(editingId === row.id ? null : row.id),
            onRemove: () => { forwardRemove(row.id); if (editingId === row.id) forwardEdit(null); },
          },
        ),
      )}
    </div>
  );
}

function McpEditCard(
  { row, envForwardUpdate, envForwardRemove }: { row: McpServerDraftRow; envForwardUpdate: (serverId: string, envId: string, patch: Partial<McpEnvDraftRow>) => void; envForwardRemove: (serverId: string, envId: string) => void },
  {}: Record<string, never>,
  events: {
    onDone: () => void;
    onChangeName: React.ChangeEventHandler<HTMLInputElement>;
    onChangeType: React.ChangeEventHandler<HTMLSelectElement>;
    onChangeCommand: React.ChangeEventHandler<HTMLInputElement>;
    onChangeArgs: React.ChangeEventHandler<HTMLTextAreaElement>;
    onAddEnv: () => void;
  },
) {
  return (
    <article className="mcp-clean-card mcp-clean-edit-card">
      <header className="mcp-clean-card-head">
        <div>
          <span>Edit Server</span>
          <h3>{row.name.trim() || "Untitled server"}</h3>
        </div>
        <button className="mcp-clean-secondary" type="button" onClick={events.onDone}>
          Done
        </button>
      </header>

      <div className="mcp-clean-basic-grid">
        <label>
          <span>Server name</span>
          <input
            value={row.name}
            placeholder="my-server"
            onChange={events.onChangeName}
          />
        </label>
        <label>
          <span>Type</span>
          <select
            value={row.type}
            onChange={events.onChangeType}
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
            onChange={events.onChangeCommand}
          />
        </label>
      </div>

      <div className="mcp-clean-detail-grid">
        <label>
          <span>Args, one per line</span>
          <textarea
            value={row.argsText}
            placeholder={"path/to/mcp_server.py\n--flag\nvalue"}
            onChange={events.onChangeArgs}
            spellCheck={false}
          />
        </label>

        <section className="mcp-clean-env-box" aria-label="Environment variables">
          <header>
            <span>Env</span>
            <button className="mcp-clean-secondary" type="button" onClick={events.onAddEnv}>
              Add Env
            </button>
          </header>

          {row.envRows.length === 0 ? <p>No environment variables.</p> : null}

          {McpEnvList({ envRows: row.envRows, forwardUpdate: envForwardUpdate, forwardRemove: envForwardRemove }, { rowId: row.id }, {})}
        </section>
      </div>
    </article>
  );
}

function computeValidationMessage(rows: McpServerDraftRow[]): string {
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
}

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

  const validationMessage = useMemo(() => computeValidationMessage(rows), [rows]);

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
    setRows((current) => updateRowInList(current, id, patch));
  }

  function removeServerRow(id: string) {
    setRows((current) => removeRowFromList(current, id));
  }

  function addEnvRow(serverId: string) {
    setRows((current) => addEnvToRow(current, serverId));
  }

  function updateEnvRow(serverId: string, envId: string, patch: Partial<McpEnvDraftRow>) {
    setRows((current) => updateEnvInRow(current, serverId, envId, patch));
  }

  function removeEnvRow(serverId: string, envId: string) {
    setRows((current) => removeEnvFromRow(current, serverId, envId));
  }

  const handleSaveMcpSettings = () => doSaveMcpSettings(
    validationMessage, draftSettings, configPath,
    setStatus, setIsSaving, setConfigPath, setRows, setSavedText,
  );

  return (
    <section className="mcp-clean-view" aria-label="MCP servers">
      <header className="mcp-clean-topbar">
        <div>
          <strong>MCP Servers</strong>
          <McpServersViewSavedIndicator hasUnsavedChanges={hasUnsavedChanges} />
        </div>
        <McpServersViewTopbarNav isLoading={isLoading} isSaving={isSaving} onReload={reloadMcpSettings} onAddServer={handleAddServer} />
      </header>

      <main className="mcp-clean-page">
        <McpServersViewHero configPath={configPath} />

        <McpServersViewStats summary={summary} />

        <section className="mcp-clean-panel">
          <header className="mcp-clean-panel-header">
            <div>
              <h2>Server startup entries</h2>
              <p>Matches the standard <code>{`{ mcpServers: { name: { command, args, env } } }`}</code> shape.</p>
            </div>
            <button className="mcp-clean-primary" type="button" onClick={handleAddServer}>Add Server</button>
          </header>

          <div className="mcp-clean-list">
            <McpServersViewServerList
              rows={rows}
              editingId={editingId}
              setEditingId={setEditingId}
              removeServerRow={removeServerRow}
              onAddServer={handleAddServer}
              onAddExample={handleAddExampleServer}
            />

            <McpServersViewEditCard
              rows={rows}
              editingId={editingId}
              setEditingId={setEditingId}
              updateServerRow={updateServerRow}
              addEnvRow={addEnvRow}
              updateEnvRow={updateEnvRow}
              removeEnvRow={removeEnvRow}
            />
          </div>

          <footer className="mcp-clean-actions">
            <McpServersViewFooter
              validationMessage={validationMessage}
              status={status}
              isLoading={isLoading}
              isSaving={isSaving}
              hasUnsavedChanges={hasUnsavedChanges}
              onReload={reloadMcpSettings}
              onSave={handleSaveMcpSettings}
            />
          </footer>
        </section>
      </main>
    </section>
  );
}

function McpServersViewSavedIndicator({ hasUnsavedChanges }: { hasUnsavedChanges: boolean }) {
  return <span>{hasUnsavedChanges ? "Unsaved changes" : "Saved"}</span>;
}

function McpServersViewTopbarNav({ isLoading, isSaving, onReload, onAddServer }: { isLoading: boolean; isSaving: boolean; onReload: () => void; onAddServer: () => void }) {
  return (
    <nav aria-label="MCP actions">
      <button type="button" onClick={onReload} disabled={isLoading || isSaving}>
        {isLoading ? "Reloading..." : "Reload"}
      </button>
      <button type="button" onClick={onAddServer}>Add Server</button>
    </nav>
  );
}

function McpServersViewHero({ configPath }: { configPath: string }) {
  return (
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
  );
}

function McpServersViewStats({ summary }: { summary: ReturnType<typeof summarizeMcpRows> }) {
  return (
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
  );
}

function McpServersViewServerList({ rows, editingId, setEditingId, removeServerRow, onAddServer, onAddExample }: {
  rows: McpServerDraftRow[];
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  removeServerRow: (id: string) => void;
  onAddServer: () => void;
  onAddExample: () => void;
}) {
  if (rows.length === 0) {
    return <McpServersViewEmpty onAddServer={onAddServer} onAddExample={onAddExample} />;
  }
  return McpServerTable({ rows, forwardEdit: setEditingId, forwardRemove: removeServerRow }, { editingId }, {});
}

function McpServersViewEmpty({ onAddServer, onAddExample }: { onAddServer: () => void; onAddExample: () => void }) {
  return (
    <section className="mcp-clean-empty">
      <h3>No MCP servers configured</h3>
      <p>Add a server manually, or insert the Python/Postgres example.</p>
      <div>
        <button className="mcp-clean-primary" type="button" onClick={onAddServer}>Add Server</button>
        <button className="mcp-clean-secondary" type="button" onClick={onAddExample}>Add Example</button>
      </div>
    </section>
  );
}

function McpServersViewEditCard({ rows, editingId, setEditingId, updateServerRow, addEnvRow, updateEnvRow, removeEnvRow }: {
  rows: McpServerDraftRow[];
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  updateServerRow: (id: string, patch: Partial<McpServerDraftRow>) => void;
  addEnvRow: (serverId: string) => void;
  updateEnvRow: (serverId: string, envId: string, patch: Partial<McpEnvDraftRow>) => void;
  removeEnvRow: (serverId: string, envId: string) => void;
}) {
  if (!editingId) return null;
  const row = rows.find((r) => r.id === editingId);
  if (!row) return null;
  return McpEditCard(
    { row, envForwardUpdate: updateEnvRow, envForwardRemove: removeEnvRow },
    {},
    {
      onDone: () => setEditingId(null),
      onChangeName: (e) => updateServerRow(row.id, { name: (e.target as HTMLInputElement).value }),
      onChangeType: (e) => updateServerRow(row.id, { type: (e.target as HTMLSelectElement).value }),
      onChangeCommand: (e) => updateServerRow(row.id, { command: (e.target as HTMLInputElement).value }),
      onChangeArgs: (e) => updateServerRow(row.id, { argsText: (e.target as HTMLTextAreaElement).value }),
      onAddEnv: () => addEnvRow(row.id),
    },
  );
}

function McpServersViewFooter({ validationMessage, status, isLoading, isSaving, hasUnsavedChanges, onReload, onSave }: {
  validationMessage: string;
  status: string;
  isLoading: boolean;
  isSaving: boolean;
  hasUnsavedChanges: boolean;
  onReload: () => void;
  onSave: () => void;
}) {
  return (
    <>
      <p>{validationMessage || status}</p>
      <div>
        <button className="mcp-clean-secondary" type="button" onClick={onReload} disabled={isLoading || isSaving}>
          Discard
        </button>
        <button
          className="mcp-clean-primary"
          type="button"
          onClick={onSave}
          disabled={!hasUnsavedChanges || isSaving || Boolean(validationMessage)}
          title={validationMessage || undefined}
        >
          {isSaving ? "Saving..." : "Save MCP Servers"}
        </button>
      </div>
    </>
  );
}

async function doSaveMcpSettings(
  validationMessage: string,
  draftSettings: McpSettings,
  configPath: string,
  setStatus: (s: string) => void,
  setIsSaving: (v: boolean) => void,
  setConfigPath: (p: string) => void,
  setRows: (r: McpServerDraftRow[]) => void,
  setSavedText: (t: string) => void,
): Promise<void> {
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
