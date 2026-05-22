import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  cpSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const port = Number(process.env.PORT ?? "7421");
const dataDir = process.env.AGENT_UI_REMOTE_HOME ?? join(homedir(), ".agent-ui-proxy-test");
const debugLogDir = process.env.AGENT_UI_DEBUG_LOG ?? join(dataDir, "debug-logs");
const workspaceRegistryPath = join(dataDir, "workspace-registry.json");
const modelSettingsPath = join(dataDir, "model-settings.json");
const mcpSettingsPath =
  process.env.ASTROMERE_MCP_CONFIG ?? join(homedir(), ".claude", "astromere", "mcp.json");

type WorkspaceState = { root: string; name: string };
type WorkspaceRegistry = { workspaces: WorkspaceState[] };
type ProjectEntry = { name: string; path: string; kind: "file" | "directory" };
type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan";

const ignoredDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".bun",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  "vendor",
]);

function ensureDataDir() {
  mkdirSync(dataDir, { recursive: true });
}

function debugLog(requestId: string, data: unknown) {
  ensureDataDir();
  mkdirSync(debugLogDir, { recursive: true });
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const logLine = `[${timestamp}] [${requestId}] ${JSON.stringify(data)}\n`;
  const logFile = join(debugLogDir, "proxy-debug.log");
  try {
    appendFileSync(logFile, logLine);
  } catch {
    // silent
  }
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
      ...(init.headers ?? {}),
    },
  });
}

function error(message: string, status = 400) {
  return json({ ok: false, message }, { status });
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function safeReadJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function canonicalWorkspaceRoot(root: string): string {
  const expanded = expandHome(root);
  const resolved = resolve(expanded);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`workspace root is not a directory: ${root}`);
  }
  return resolved;
}

function workspaceStateFromPath(path: string): WorkspaceState {
  const root = canonicalWorkspaceRoot(path);
  return { root, name: basename(root) || root };
}

function readWorkspaceRegistry(): WorkspaceRegistry {
  ensureDataDir();
  const parsed = safeReadJson<any>(workspaceRegistryPath, { workspaces: [] });
  const workspaces = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
  return {
    workspaces: workspaces
      .filter((item: any) => typeof item?.root === "string" && typeof item?.name === "string")
      .map((item: any) => ({ root: item.root, name: item.name })),
  };
}

function writeWorkspaceRegistry(registry: WorkspaceRegistry) {
  writeJson(workspaceRegistryPath, registry);
}

function resolveWorkspacePath(root: string, path: string): string {
  const rootPath = canonicalWorkspaceRoot(root);
  const resolved = resolve(rootPath, path || ".");
  const rel = relative(rootPath, resolved);
  if (rel.startsWith("..") || rel === ".." || rel.split(sep).includes("..")) {
    throw new Error("path escapes workspace root");
  }
  if (!existsSync(resolved)) {
    throw new Error(`path does not exist: ${path}`);
  }
  return resolved;
}

function resolveWorkspacePathAllowMissing(root: string, path: string): string {
  const rootPath = canonicalWorkspaceRoot(root);
  const resolved = resolve(rootPath, path);
  const parent = dirname(resolved);
  const rel = relative(rootPath, parent);
  if (rel.startsWith("..") || rel === ".." || rel.split(sep).includes("..")) {
    throw new Error("path escapes workspace root");
  }
  return resolved;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function normalizeRefPath(path: string): string {
  return path.trim().replace(/^@/, "").replace(/^～\//, "~/");
}

function resolveReferencePath(root: string, path: string): { resolved: string; display: string } {
  const raw = normalizeRefPath(path);
  const candidate = raw === "~" || raw.startsWith("~/") || raw.startsWith("/")
    ? resolve(expandHome(raw))
    : resolveWorkspacePath(root, raw);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new Error("referenced path is not a file");
  }
  return { resolved: candidate, display: raw.startsWith("/") || raw.startsWith("~") ? displayPath(candidate) : raw };
}

function languageForPath(path: string): string {
  const ext = extname(path).toLowerCase().replace(".", "");
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    rs: "rust",
    py: "python",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "shell",
    zsh: "shell",
    sql: "sql",
    css: "css",
    html: "html",
  };
  return map[ext] ?? ext ?? "text";
}

function fileView(display: string, resolved: string) {
  const content = readFileSync(resolved, "utf8");
  return {
    path: display,
    content,
    total_lines: content.length === 0 ? 0 : content.split(/\r?\n/).length,
    size_bytes: statSync(resolved).size,
    language: languageForPath(display),
  };
}

function imageMime(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function listProjectEntries(root: string): ProjectEntry[] {
  const rootPath = canonicalWorkspaceRoot(root);
  return readdirSync(rootPath)
    .filter((name) => ![".git", "node_modules", "dist", "target"].includes(name))
    .map((name) => {
      const full = join(rootPath, name);
      return {
        name,
        path: relative(rootPath, full).replaceAll("\\", "/"),
        kind: statSync(full).isDirectory() ? "directory" : "file",
      } satisfies ProjectEntry;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function walkFiles(root: string, current: string, out: string[], max = 20000) {
  if (out.length >= max) return;
  for (const name of readdirSync(current)) {
    if (ignoredDirs.has(name)) continue;
    const full = join(current, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(root, full, out, max);
    } else if (st.isFile()) {
      out.push(relative(root, full).replaceAll("\\", "/"));
    }
    if (out.length >= max) return;
  }
}

function searchWorkspaceFiles(root: string, query: string, maxResults = 20) {
  const rootPath = canonicalWorkspaceRoot(root);
  const normalizedQuery = query.trim().replace(/^@/, "").toLowerCase();

  if (normalizedQuery.startsWith("/") || normalizedQuery.startsWith("~/")) {
    const expanded = resolve(expandHome(normalizedQuery));
    if (existsSync(expanded) && statSync(expanded).isFile()) {
      return [{
        path: displayPath(expanded),
        name: basename(expanded),
        directory: displayPath(dirname(expanded)),
        extension: extname(expanded).replace(".", "") || null,
        size_bytes: statSync(expanded).size,
        modified_epoch_millis: Math.trunc(statSync(expanded).mtimeMs),
        score: 30000,
      }];
    }
  }

  const files: string[] = [];
  walkFiles(rootPath, rootPath, files);

  return files
    .map((path) => {
      const name = basename(path);
      const lower = path.toLowerCase();
      const score =
        !normalizedQuery ? 10000 - path.length :
        lower === normalizedQuery ? 20000 :
        basename(lower) === normalizedQuery ? 16000 :
        basename(lower).startsWith(normalizedQuery) ? 12000 :
        lower.includes(normalizedQuery) ? 5000 :
        0;
      if (score <= 0) return null;
      const full = join(rootPath, path);
      return {
        path,
        name,
        directory: dirname(path) === "." ? "." : dirname(path).replaceAll("\\", "/"),
        extension: extname(path).replace(".", "") || null,
        size_bytes: statSync(full).size,
        modified_epoch_millis: Math.trunc(statSync(full).mtimeMs),
        score,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, Math.min(maxResults, 50)));
}

function defaultModelSettings() {
  return {
    activeModelId: "deepseek",
    models: [
      {
        id: "deepseek",
        name: "DeepSeek",
        provider: "deepseek",
        model: "deepseek-chat",
        supportModels: ["deepseek-chat", "deepseek-reasoner"],
        apiKey: process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || "",
        baseUrl: process.env.DEEPSEEK_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic",
        organizationId: null,
        maxTokens: 4096,
        temperature: 0.2,
        enabled: true,
      },
      {
        id: "anthropic",
        name: "Anthropic",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        supportModels: [],
        apiKey: process.env.ANTHROPIC_API_KEY || "",
        baseUrl: process.env.ANTHROPIC_BASE_URL || "",
        organizationId: null,
        maxTokens: 4096,
        temperature: 0.2,
        enabled: true,
      },
    ],
  };
}

function readModelSettings() {
  return safeReadJson(modelSettingsPath, defaultModelSettings());
}

function defaultMcpSettings() {
  return { mcpServers: {} };
}

function readMcpSettingsFile() {
  return {
    path: mcpSettingsPath,
    settings: safeReadJson(mcpSettingsPath, defaultMcpSettings()),
  };
}

function parseFrontmatter(markdown: string): Record<string, string | string[]> {
  if (!markdown.startsWith("---")) return {};
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return {};
  const raw = markdown.slice(3, end).split(/\r?\n/);
  const result: Record<string, string | string[]> = {};
  let current: string | null = null;

  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const item = trimmed.match(/^-\s+(.+)$/) ?? trimmed.match(/^-\s+(.+)$/);
    if (item && current) {
      const existing = result[current];
      result[current] = Array.isArray(existing) ? [...existing, item[1]] : existing ? [String(existing), item[1]] : [item[1]];
      continue;
    }
    const kv = trimmed.match(/^([^:]+):(.*)$/);
    if (kv) {
      current = kv[1].trim().replaceAll("_", "-").toLowerCase();
      const value = kv[2].trim().replace(/^['"]|['"]$/g, "");
      result[current] = value;
    }
  }
  return result;
}

function fmString(fm: Record<string, string | string[]>, keys: string[]) {
  for (const key of keys) {
    const value = fm[key];
    if (Array.isArray(value)) return value.find(Boolean);
    if (value) return value;
  }
  return undefined;
}

function fmList(fm: Record<string, string | string[]>, keys: string[]) {
  const out: string[] = [];
  for (const key of keys) {
    const value = fm[key];
    if (Array.isArray(value)) out.push(...value.filter(Boolean));
    else if (value) out.push(value);
  }
  return [...new Set(out)];
}

function dirSize(path: string): number {
  try {
    return readdirSync(path).reduce((sum, name) => {
      const full = join(path, name);
      const st = statSync(full);
      return sum + (st.isDirectory() ? dirSize(full) : st.size);
    }, 0);
  } catch {
    return 0;
  }
}

function skillSummary(rootPath: string, skillDir: string, sourceKind: string, sourceLabel: string, sourceBase: string) {
  const skillMd = join(skillDir, "SKILL.md");
  const markdown = existsSync(skillMd) ? readFileSync(skillMd, "utf8") : "";
  const fm = parseFrontmatter(markdown);
  const directoryName = basename(skillDir);
  const name = fmString(fm, ["name"]) ?? directoryName;
  const allowedTools = fmList(fm, ["allowed-tools", "allowedTools"]);
  const relRoot = relative(rootPath, skillDir).replaceAll("\\", "/");
  const relPath = relative(rootPath, skillMd).replaceAll("\\", "/");
  return {
    id: `${sourceKind}:${name}`,
    name,
    description: fmString(fm, ["description"]),
    whenToUse: fmString(fm, ["when-to-use", "whenToUse"]),
    version: fmString(fm, ["version"]),
    path: relPath,
    skillRoot: relRoot,
    source: { kind: sourceKind, label: sourceLabel, path: sourceBase },
    origin: { id: sourceKind, label: sourceLabel },
    enabled: true,
    userInvocable: true,
    modelInvocable: true,
    context: fmString(fm, ["context"]) ?? "inline",
    agent: fmString(fm, ["agent"]),
    model: fmString(fm, ["model"]),
    effort: fmString(fm, ["effort"]),
    allowedTools,
    capabilities: allowedTools,
    paths: fmList(fm, ["paths"]),
    hooks: fmList(fm, ["hooks"]),
    sizeBytes: dirSize(skillDir),
    installedAtMs: existsSync(skillMd) ? Math.trunc(statSync(skillMd).mtimeMs) : null,
    validation: existsSync(skillMd) ? [] : ["Missing SKILL.md"],
    shadowedBy: [],
    shadowed_by: [],
  };
}

function listSkills(root: string) {
  const rootPath = canonicalWorkspaceRoot(root);
  const sources = [
    { kind: "project", label: "Project", path: join(rootPath, ".claude", "skills") },
    { kind: "user", label: "User", path: join(homedir(), ".claude", "skills") },
  ];

  const skills: any[] = [];
  const seen = new Map<string, string>();
  let shadowed = 0;

  for (const source of sources) {
    const entries = existsSync(source.path)
      ? readdirSync(source.path).map((name) => join(source.path, name)).filter((path) => statSync(path).isDirectory()).sort()
      : [];

    for (const dir of entries) {
      const skill = skillSummary(rootPath, dir, source.kind, source.label, source.path);
      const key = String(skill.name || "").toLowerCase();
      if (seen.has(key)) {
        skill.enabled = false;
        skill.shadowedBy = [seen.get(key)];
        skill.shadowed_by = [seen.get(key)];
        shadowed += 1;
      } else {
        seen.set(key, skill.id);
      }
      skills.push(skill);
    }
  }

  return {
    kind: "skills",
    action: "list",
    sources: sources.map((source) => ({
      kind: source.kind,
      label: source.label,
      path: source.path,
      exists: existsSync(source.path),
      count: existsSync(source.path) ? readdirSync(source.path).filter((name) => statSync(join(source.path, name)).isDirectory()).length : 0,
    })),
    summary: { total: skills.length, active: skills.length - shadowed, shadowed },
    skills,
  };
}

function runCommand(command: string[], cwd?: string, timeoutMs = 30000) {
  const proc = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    status: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function sanitizeClaudeProjectPath(path: string) {
  return path.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function claudeProjectSessionsDir(root: string) {
  return join(homedir(), ".claude", "projects", sanitizeClaudeProjectPath(resolve(root)));
}

function parsePossiblyNestedJson(value: any): any {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function textFromContentValue(value: any): string {
  if (value == null) return "";

  const nested = parsePossiblyNestedJson(value);
  if (nested !== value) return textFromContentValue(nested);

  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const normalized = parsePossiblyNestedJson(item);
        if (typeof normalized === "string") return normalized;
        if (typeof normalized?.text === "string") return normalized.text;
        if (typeof normalized?.content === "string") return textFromContentValue(normalized.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value?.text === "string") return value.text;
  if (typeof value?.content === "string") return textFromContentValue(value.content);
  if (typeof value?.result === "string") return value.result;

  return "";
}

function runtimeMessageFromJsonlLine(line: string, index: number) {
  let raw: any = null;
  try {
    raw = JSON.parse(line);
  } catch {
    raw = { type: "text", content: line };
  }

  raw = parsePossiblyNestedJson(raw);

  if (raw?.type === "queue-operation" && raw?.operation && raw.operation !== "enqueue") {
    return null;
  }

  const message = raw?.message && typeof raw.message === "object" ? raw.message : raw;
  const eventType = typeof raw?.type === "string" ? raw.type : "message";

  const role =
    raw?.type === "queue-operation"
      ? "system"
      : message?.role
        ?? (raw?.type === "assistant" ? "assistant"
          : raw?.type === "system" ? "system"
          : raw?.type === "tool" ? "tool"
          : "user");

  const text =
    textFromContentValue(message?.content)
    || textFromContentValue(raw?.content)
    || textFromContentValue(raw?.text)
    || textFromContentValue(raw?.result);

  if (!String(text).trim()) return null;

  const trimmed = String(text).trim();
  if (
    trimmed.startsWith('{"parentUuid"')
    || trimmed.startsWith('{"message"')
    || trimmed.includes('"entrypoint":"sdk-cli"')
  ) {
    return null;
  }

  return {
    id: `msg-${index}`,
    role,
    text,
    raw_json: raw,
    event_type: eventType,
  };
}

function firstUserTitleFromJsonl(content: string): string | null {
  const lines = content.split(/\r?\n/).filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const msg = runtimeMessageFromJsonlLine(lines[index], index);
    if (!msg) continue;
    if (msg.role === "user" || msg.event_type === "queue-operation") {
      const title = String(msg.text ?? "").trim().replace(/\s+/g, " ");
      if (title) return title.length > 80 ? `${title.slice(0, 77)}...` : title;
    }
  }

  return null;
}

function compatSkillsReport(report: any) {
  return {
    ...report,
    skills: (report?.skills ?? []).map((skill: any) => {
      const next = { ...skill };
      for (const key of ["agent", "effort", "model", "version", "whenToUse"]) {
        if (!(key in next) || next[key] === undefined) next[key] = null;
      }
      return next;
    }),
  };
}

function sessionTitle(sessionId: string, messageCount: number) {
  return messageCount > 0 ? `会话 ${sessionId.slice(0, 8)}` : "新会话";
}

function collectSessionFiles(dir: string, out: any[]) {
  if (!existsSync(dir)) return;

  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);

    if (st.isDirectory()) {
      collectSessionFiles(full, out);
      continue;
    }

    if (!name.endsWith(".jsonl")) continue;

    const content = readFileSync(full, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const id = basename(name, ".jsonl");
    const modifiedMs = Math.trunc(st.mtimeMs);

    out.push({
      id,
      title: firstUserTitleFromJsonl(content) ?? sessionTitle(id, lines.length),
      path: full,
      updated_at_ms: modifiedMs,
      modified_epoch_millis: modifiedMs,
      message_count: lines.length,
      parent_session_id: null,
      branch_name: null,
    });
  }
}

function listRuntimeSessions(root: string) {
  canonicalWorkspaceRoot(root);
  const sessions: any[] = [];
  collectSessionFiles(claudeProjectSessionsDir(root), sessions);
  return sessions.sort((a, b) => b.updated_at_ms - a.updated_at_ms);
}

function loadRuntimeSession(root: string, reference: string) {
  const rootPath = canonicalWorkspaceRoot(root);
  const sessions = listRuntimeSessions(rootPath);
  const found = sessions.find((session) => session.id === reference || session.path === reference);
  if (!found) throw new Error(`session not found: ${reference}`);

  const content = readFileSync(found.path, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  const messages = lines
    .map((line, index) => runtimeMessageFromJsonlLine(line, index))
    .filter(Boolean);

  return {
    id: found.id,
    path: found.path,
    title: found.title,
    version: 1,
    created_at_ms: found.modified_epoch_millis,
    updated_at_ms: found.updated_at_ms,
    message_count: messages.length,
    prompt_history_count: messages.filter((message: any) => message.role === "user").length,
    model: null,
    workspace_root: rootPath,
    has_compaction: false,
    messages,
    fork: null,
  };
}

type AgentProcessRecord = {
  root: string;
  sessionId: string;
  model: string;
  permissionMode: PermissionMode;
  pid: number | null;
  proc: any;
  stdin: any;
  closed: boolean;
  excludedSessionIds?: Set<string>;
};

type ControlWaiter = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const agentProcesses = new Map<string, AgentProcessRecord>();
const sessionAliases = new Map<string, string>();
const controlResponses = new Map<string, any>();
const controlWaiters = new Map<string, ControlWaiter>();
const eventClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function proxyRepoRoot() {
  return resolve(import.meta.dir, "../../..");
}

function processKey(root: string, sessionId: string) {
  return `${root}\n${sessionId}`;
}

function resolveSessionId(root: string, sessionId: string) {
  let current = sessionId;
  for (let i = 0; i < 10; i += 1) {
    const next = sessionAliases.get(processKey(root, current));
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function isExistingClaudeSessionId(sessionId: string) {
  if (sessionId.startsWith("new-") || sessionId.startsWith("pending-")) return false;
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sessionId);
}

function claudeSessionJsonlPath(root: string, sessionId: string) {
  return join(claudeProjectSessionsDir(root), `${sessionId}.jsonl`);
}

function claudeSessionFileExists(root: string, sessionId: string) {
  if (!isExistingClaudeSessionId(sessionId)) return false;
  return existsSync(claudeSessionJsonlPath(root, sessionId));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSessionJsonlCreated(root: string, sessionId: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const path = claudeSessionJsonlPath(root, sessionId);

  while (Date.now() < deadline) {
    if (existsSync(path)) return path;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for forked CLI process to create session file after ${timeoutMs / 1000}s: ${path}`);
}

function emitAgentEvent(event: any) {
  const encoded = textEncoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const controller of [...eventClients]) {
    try {
      controller.enqueue(encoded);
    } catch {
      eventClients.delete(controller);
    }
  }
}

function normalizePermissionMode(value: any): PermissionMode {
  if (
    value === "default"
    || value === "acceptEdits"
    || value === "bypassPermissions"
    || value === "dontAsk"
    || value === "plan"
  ) return value;
  return "default";
}

function activeModelConfig(settings: any) {
  const models = Array.isArray(settings?.models) ? settings.models : [];
  const activeId = settings?.activeModelId ?? settings?.active_model_id;
  return models.find((m: any) => m?.id === activeId && m?.enabled !== false)
    ?? models.find((m: any) => m?.enabled !== false)
    ?? null;
}

function resolveModelForProvider(config: any) {
  if (typeof config?.model === "string" && config.model.trim()) return config.model.trim();
  if (config?.provider === "deepseek") return "deepseek-chat";
  if (config?.provider === "openai") return "gpt-4o";
  if (config?.provider === "anthropic") return "claude-sonnet-4-5-20250929";
  return "default";
}

function applyModelEnv(env: Record<string, string>, config: any) {
  const model = resolveModelForProvider(config);
  const apiKey = String(config?.apiKey ?? config?.api_key ?? "");
  const baseUrl = String(config?.baseUrl ?? config?.base_url ?? "");

  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_API_KEY = apiKey;
  if (baseUrl.trim()) env.ANTHROPIC_BASE_URL = baseUrl;

  if (config?.provider === "deepseek") {
    env.DEEPSEEK_API_KEY = apiKey;
    if (baseUrl.trim()) env.DEEPSEEK_BASE_URL = baseUrl;
  }

  if (config?.provider === "openai") {
    env.OPENAI_API_KEY = apiKey;
    if (baseUrl.trim()) env.OPENAI_BASE_URL = baseUrl;
  }
}

function applyAgentUiEnv(env: Record<string, string>, root: string, sessionId: string) {
  const effectiveSessionId = sessionId.trim() || "default";
  const outputDir = join(root, ".agent-ui", effectiveSessionId);

  mkdirSync(outputDir, { recursive: true });

  env.ASTROMERE_AGENT_UI = "1";
  env.ASTROMERE_AGENT_UI_BRIDGE = "bun-stream-json";
  env.ASTROMERE_AGENT_UI_WORKSPACE_ROOT = root;
  env.ASTROMERE_AGENT_UI_SESSION_ID = effectiveSessionId;
  env.ASTROMERE_AGENT_UI_OUTPUT_DIR = outputDir;
  env.ASTROMERE_MCP_CONFIG = mcpSettingsPath;
}

function processStatus(root: string, sessionId: string) {
  const resolvedSessionId = resolveSessionId(root, sessionId);
  const proc = agentProcesses.get(processKey(root, resolvedSessionId));
  return {
    root,
    sessionId: proc?.sessionId ?? resolvedSessionId,
    running: Boolean(proc && !proc.closed),
    pid: proc?.pid ?? null,
  };
}

function findAgentProcess(root: string, sessionId: string) {
  const resolvedSessionId = resolveSessionId(root, sessionId);
  const exact = agentProcesses.get(processKey(root, resolvedSessionId));
  if (exact && !exact.closed) return exact;

  for (const proc of agentProcesses.values()) {
    if (proc.root === root && !proc.closed) return proc;
  }

  return null;
}

function rekeyAgentProcess(root: string, oldSessionId: string, newSessionId: string) {
  if (!newSessionId || oldSessionId === newSessionId) return;

  const resolvedOldSessionId = resolveSessionId(root, oldSessionId);
  sessionAliases.set(processKey(root, oldSessionId), newSessionId);
  sessionAliases.set(processKey(root, resolvedOldSessionId), newSessionId);

  const oldKey = processKey(root, resolvedOldSessionId);
  const proc = agentProcesses.get(oldKey);
  if (!proc) return;

  agentProcesses.delete(oldKey);
  proc.sessionId = newSessionId;
  agentProcesses.set(processKey(root, newSessionId), proc);
}

function controlResponseRequestId(value: any): string | null {
  const requestId =
    value?.request_id
    ?? value?.requestId
    ?? value?.response?.request_id
    ?? value?.response?.requestId
    ?? value?.response?.response?.request_id
    ?? value?.response?.response?.requestId;

  return typeof requestId === "string" && requestId.trim() ? requestId : null;
}

function rememberControlResponse(value: any) {
  if (value?.type !== "control_response") return;

  const requestId = controlResponseRequestId(value);
  if (!requestId) return;

  controlResponses.set(requestId, value);

  const waiter = controlWaiters.get(requestId);
  if (waiter) {
    clearTimeout(waiter.timeout);
    controlWaiters.delete(requestId);
    waiter.resolve(value);
  }
}

function waitForControlResponse(requestId: string, timeoutMs = 5000) {
  const existing = controlResponses.get(requestId);
  if (existing) {
    controlResponses.delete(requestId);
    return Promise.resolve(existing);
  }

  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      controlWaiters.delete(requestId);
      reject(new Error(`Timed out waiting for control response ${requestId}`));
    }, timeoutMs);

    controlWaiters.set(requestId, { resolve, reject, timeout });
  });
}

function capabilityItemFromValue(value: any, fallbackKind: string) {
  if (typeof value === "string") {
    const name = value.trim().replace(/^\/+/, "");
    if (!name) return null;
    return { name, slash: `/${name}`, kind: fallbackKind, description: null };
  }

  if (!value || typeof value !== "object") return null;

  const name = String(value.name ?? value.command ?? "").trim().replace(/^\/+/, "");
  if (!name) return null;

  return {
    name,
    slash: String(value.slash ?? `/${name}`),
    kind: String(value.kind ?? fallbackKind),
    description: typeof value.description === "string"
      ? value.description
      : typeof value.summary === "string"
        ? value.summary
        : null,
  };
}

function capabilityItemsFromValue(value: any, fallbackKind: string) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => capabilityItemFromValue(item, fallbackKind)).filter(Boolean);
}


function contextUsageFromControlResponse(root: string, sessionId: string, value: any) {
  const data = value?.response?.response ?? value?.response ?? {};
  return {
    root,
    sessionId,
    data,
    updatedAtMs: Date.now(),
  };
}

function capabilitiesFromControlResponse(root: string, sessionId: string, value: any) {
  const capabilities = value?.response?.capabilities ?? value?.response?.response?.capabilities ?? {};
  const commands = capabilityItemsFromValue(capabilities.commands, "command");
  const skills = capabilityItemsFromValue(capabilities.skills, "skill");
  const explicitSlashCommands = capabilityItemsFromValue(
    capabilities.slashCommands ?? capabilities.slash_commands,
    "command",
  );

  return {
    root,
    sessionId,
    commands,
    skills,
    slashCommands: explicitSlashCommands.length ? explicitSlashCommands : [...commands, ...skills],
    updatedAtMs: Date.now(),
  };
}

async function writeAgentLine(proc: AgentProcessRecord, value: any) {
  if (!proc.stdin || proc.closed) throw new Error("REPL process is not running");

  const line = typeof value === "string" ? value : JSON.stringify(value);
  proc.stdin.write(`${line}\n`);
  if (typeof proc.stdin.flush === "function") {
    await proc.stdin.flush();
  }
}

function sdkUserMessage(sessionId: string, input: string) {
  return {
    type: "user",
    session_id: sessionId,
    message: {
      role: "user",
      content: input,
    },
    parent_tool_use_id: null,
  };
}

function extractTextContent(value: any): string {
  const content =
    value?.message?.content
    ?? value?.content
    ?? value?.text
    ?? value?.result;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function extractToolUses(value: any): any[] {
  const content = value?.message?.content ?? value?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((item) => item?.type === "tool_use" || item?.type === "server_tool_use");
}

function emitRawJson(root: string, sessionId: string, raw: any) {
  emitAgentEvent({
    sessionId,
    root,
    eventType: "raw_json",
    payload: { raw_json: raw },
  });
}

function emitParsedAgentStdout(
  root: string,
  currentSessionId: string,
  raw: any,
  line: string,
  excludedSessionIds: Set<string> = new Set(),
) {
  rememberControlResponse(raw);

  if (raw?.type === "control_response") {
    return;
  }

  const nextSessionId = raw?.sessionId ?? raw?.session_id;
  if (typeof nextSessionId === "string" && nextSessionId.trim()) {
    const normalizedNextSessionId = nextSessionId.trim();
    if (!excludedSessionIds.has(normalizedNextSessionId)) {
      rekeyAgentProcess(root, currentSessionId, normalizedNextSessionId);
      currentSessionId = normalizedNextSessionId;
    }
  }

  emitRawJson(root, currentSessionId, raw);

  const requestId =
    raw?.request_id
    ?? raw?.requestId
    ?? raw?.request?.request_id
    ?? raw?.request?.requestId
    ?? raw?.response?.request_id
    ?? raw?.response?.requestId;

  const subtype = raw?.request?.subtype ?? raw?.subtype ?? raw?.type;
  const toolName =
    raw?.request?.tool_name
    ?? raw?.request?.toolName
    ?? raw?.tool_name
    ?? raw?.toolName
    ?? raw?.name
    ?? "tool";

  if (
    raw?.type === "permission_request"
    || (raw?.type === "control_request" && String(subtype).includes("permission"))
    || (raw?.type === "control_request" && raw?.request?.subtype === "can_use_tool")
  ) {
    emitAgentEvent({
      sessionId: currentSessionId,
      root,
      eventType: "permission_request",
      payload: {
        requestId,
        prompt: `${subtype ?? "permission"} requests permission to use ${toolName}`,
        toolName,
        raw,
      },
    });
    return;
  }

  if (raw?.type === "system") {
    emitAgentEvent({
      sessionId: currentSessionId,
      root,
      eventType: raw?.subtype === "init" ? "startup" : "system",
      payload: raw,
    });
    return;
  }

  if (raw?.type === "assistant") {
    for (const tool of extractToolUses(raw)) {
      emitAgentEvent({
        sessionId: currentSessionId,
        root,
        eventType: "tool_call",
        payload: { tool, raw_json: raw },
      });
    }

    const text = extractTextContent(raw);
    if (text) {
      emitAgentEvent({
        sessionId: currentSessionId,
        root,
        eventType: "turn_text",
        payload: { text, raw_json: raw },
      });
    }
    return;
  }

  if (raw?.type === "result") {
    const realSessionId = typeof raw?.session_id === "string" && raw.session_id.trim()
      ? raw.session_id.trim()
      : currentSessionId;
    emitAgentEvent({
      sessionId: currentSessionId,
      root,
      eventType: "turn_complete",
      payload: {
        ok: raw?.is_error === undefined ? true : !Boolean(raw.is_error),
        text: extractTextContent(raw),
        realSessionId,
        pid: null,
        raw_json: raw,
      },
    });
    return;
  }

  if (raw?.type === "user") {
    emitAgentEvent({
      sessionId: currentSessionId,
      root,
      eventType: "user",
      payload: raw,
    });
    return;
  }

  emitAgentEvent({
    sessionId: currentSessionId,
    root,
    eventType: "turn_text",
    payload: {
      text: extractTextContent(raw) || line,
      raw_json: raw,
    },
  });
}

async function readAgentStream(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
) {
  if (!stream) return;
  const reader = stream.getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += textDecoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  }

  if (buffer.trim()) onLine(buffer);
}

function watchAgentProcess(proc: AgentProcessRecord) {
  readAgentStream(proc.proc.stdout, (line) => {
    console.log(`[agent stdout] root=${proc.root} session=${proc.sessionId} ${line}`);
    try {
      emitParsedAgentStdout(
        proc.root,
        proc.sessionId,
        JSON.parse(line),
        line,
        proc.excludedSessionIds ?? new Set(),
      );
    } catch {
      emitAgentEvent({
        sessionId: proc.sessionId,
        root: proc.root,
        eventType: "stdout",
        payload: { text: line },
      });
    }
  }).catch((error) => {
    emitAgentEvent({
      sessionId: proc.sessionId,
      root: proc.root,
      eventType: "stderr",
      payload: { text: error instanceof Error ? error.message : String(error) },
    });
  });

  readAgentStream(proc.proc.stderr, (line) => {
    console.error(`[agent stderr] root=${proc.root} session=${proc.sessionId} ${line}`);
    emitAgentEvent({
      sessionId: proc.sessionId,
      root: proc.root,
      eventType: "stderr",
      payload: { text: line },
    });
  }).catch((error) => {
    emitAgentEvent({
      sessionId: proc.sessionId,
      root: proc.root,
      eventType: "stderr",
      payload: { text: error instanceof Error ? error.message : String(error) },
    });
  });

  proc.proc.exited.then((code: number) => {
    console.error(`[agent exited] root=${proc.root} session=${proc.sessionId} pid=${proc.pid} code=${code}`);
    proc.closed = true;
    agentProcesses.delete(processKey(proc.root, proc.sessionId));
    emitAgentEvent({
      sessionId: proc.sessionId,
      root: proc.root,
      eventType: "process_status",
      payload: {
        running: false,
        pid: proc.pid,
        code,
        reason: "process_exited",
      },
    });
  }).catch((error: unknown) => {
    proc.closed = true;
    agentProcesses.delete(processKey(proc.root, proc.sessionId));
    emitAgentEvent({
      sessionId: proc.sessionId,
      root: proc.root,
      eventType: "stderr",
      payload: { text: error instanceof Error ? error.message : String(error) },
    });
  });
}

function buildAgentEnv(root: string, sessionId: string, config: any) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }

  applyAgentUiEnv(env, root, sessionId);
  if (config) applyModelEnv(env, config);
  return env;
}

function buildAgentReplArgs(
  root: string,
  sessionId: string,
  model: string,
  permissionMode: PermissionMode,
) {
  const cli = join(proxyRepoRoot(), "src", "entrypoints", "cli.tsx");

  if (process.env.AGENT_UI_REPL_ARGS?.trim()) {
    return process.env.AGENT_UI_REPL_ARGS
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part
        .replaceAll("{cli}", cli)
        .replaceAll("{sessionId}", sessionId)
        .replaceAll("{permissionMode}", permissionMode)
        .replaceAll("{model}", model));
  }

  const args = [
    "run",
    cli,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--permission-mode",
    permissionMode,
    "--permission-prompt-tool",
    "stdio",
  ];

  if (claudeSessionFileExists(root, sessionId)) {
    args.push("--resume", sessionId);
  } else if (isExistingClaudeSessionId(sessionId)) {
    args.push("--session-id", sessionId);
  }

  if (model !== "default") {
    args.push("--model", model);
  }

  return args;
}

function startAgentProcess(
  root: string,
  sessionId: string,
  modelOverride?: string,
  permissionModeInput?: PermissionMode,
) {
  const rootPath = canonicalWorkspaceRoot(root);
  const settings = readModelSettings();
  const config = activeModelConfig(settings);
  const model = modelOverride?.trim() || (config ? resolveModelForProvider(config) : "default");
  const permissionMode = normalizePermissionMode(permissionModeInput);

  const args = buildAgentReplArgs(rootPath, sessionId, model, permissionMode);
  console.error(`[agent spawn] cwd=${rootPath}`);
  console.error(`[agent spawn] cmd=bun ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);

  const proc = Bun.spawn(["bun", ...args], {
    cwd: rootPath,
    env: buildAgentEnv(rootPath, sessionId, config),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const record: AgentProcessRecord = {
    root: rootPath,
    sessionId,
    model,
    permissionMode,
    pid: proc.pid ?? null,
    proc,
    stdin: proc.stdin ?? null,
    closed: false,
  };

  agentProcesses.set(processKey(rootPath, sessionId), record);
  watchAgentProcess(record);

  emitAgentEvent({
    sessionId,
    root: rootPath,
    eventType: "process_status",
    payload: {
      running: true,
      pid: record.pid,
      reason: "spawned",
    },
  });

  return record;
}

async function startForkAgentProcess(
  root: string,
  sourceSessionIdInput: string,
  checkpointUuidInput: string,
  modelOverride?: string,
  permissionModeInput?: PermissionMode,
) {
  const rootPath = canonicalWorkspaceRoot(root);
  const sourceSessionId = String(sourceSessionIdInput ?? "").trim();
  const checkpointUuid = String(checkpointUuidInput ?? "").trim();

  if (!sourceSessionId) {
    throw new Error("sourceSessionId is required");
  }
  if (!checkpointUuid) {
    throw new Error("checkpointUuid is required");
  }

  const sourceArgIsFile = existsSync(sourceSessionId) && statSync(sourceSessionId).isFile();
  if (!claudeSessionFileExists(rootPath, sourceSessionId) && !sourceArgIsFile) {
    throw new Error(`source session not found: ${sourceSessionId}`);
  }

  const settings = readModelSettings();
  const config = activeModelConfig(settings);
  const model = modelOverride?.trim() || (config ? resolveModelForProvider(config) : "default");
  const permissionMode = normalizePermissionMode(permissionModeInput);
  const forkedSessionId = crypto.randomUUID();
  const cli = join(proxyRepoRoot(), "src", "entrypoints", "cli.tsx");

  const args = [
    "run",
    cli,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--resume",
    sourceSessionId,
    "--resume-session-at",
    checkpointUuid,
    "--fork-session",
    "-desktop-mode",
    "--session-id",
    forkedSessionId,
    "--permission-mode",
    permissionMode,
    "--permission-prompt-tool",
    "stdio",
  ];

  if (model !== "default") {
    args.push("--model", model);
  }

  console.error(`[agent fork] cwd=${rootPath}`);
  console.error(`[agent fork] sourceSessionId=${sourceSessionId} forkedSessionId=${forkedSessionId} checkpointUuid=${checkpointUuid}`);
  console.error(`[agent fork] cmd=bun ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);

  const proc = Bun.spawn(["bun", ...args], {
    cwd: rootPath,
    env: buildAgentEnv(rootPath, forkedSessionId, config),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const record: AgentProcessRecord = {
    root: rootPath,
    sessionId: forkedSessionId,
    model,
    permissionMode,
    pid: proc.pid ?? null,
    proc,
    stdin: proc.stdin ?? null,
    closed: false,
    excludedSessionIds: new Set([sourceSessionId]),
  };

  agentProcesses.set(processKey(rootPath, forkedSessionId), record);
  watchAgentProcess(record);

  emitAgentEvent({
    sessionId: forkedSessionId,
    root: rootPath,
    eventType: "process_status",
    payload: {
      running: true,
      pid: record.pid,
      reason: "fork_spawned",
    },
  });

  try {
    const jsonlPath = await waitForSessionJsonlCreated(rootPath, forkedSessionId, 30000);
    console.error(`[agent fork] ready sessionId=${forkedSessionId} pid=${record.pid} jsonl=${jsonlPath}`);
  } catch (err) {
    console.error(`[agent fork] failed sessionId=${forkedSessionId} pid=${record.pid} error=${err instanceof Error ? err.message : String(err)}`);
    await stopAgentProcess(rootPath, forkedSessionId);
    throw err;
  }

  emitAgentEvent({
    sessionId: forkedSessionId,
    root: rootPath,
    eventType: "fork_created",
    payload: {
      sourceSessionId,
      checkpointUuid,
      pid: record.pid,
      model,
    },
  });

  emitAgentEvent({
    sessionId: forkedSessionId,
    root: rootPath,
    eventType: "process_status",
    payload: {
      running: true,
      pid: record.pid,
      reason: "forked",
    },
  });

  return record;
}

async function stopAgentProcess(root: string, sessionId: string) {
  const resolvedSessionId = resolveSessionId(root, sessionId);
  const key = processKey(root, resolvedSessionId);
  const proc = agentProcesses.get(key);

  if (!proc) {
    return {
      root,
      sessionId: resolvedSessionId,
      running: false,
      pid: null,
    };
  }

  agentProcesses.delete(key);
  proc.closed = true;

  try {
    if (typeof proc.stdin?.end === "function") {
      proc.stdin.end();
    } else if (typeof proc.stdin?.close === "function") {
      await proc.stdin.close();
    }
  } catch {}

  try {
    proc.proc.kill();
  } catch {}

  try {
    await Promise.race([
      proc.proc.exited,
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {}

  emitAgentEvent({
    sessionId,
    root,
    eventType: "process_status",
    payload: {
      running: false,
      pid: proc.pid,
      reason: "killed",
    },
  });

  return {
    root,
    sessionId,
    running: false,
    pid: proc.pid,
  };
}

function fallbackCapabilities(root: string, sessionId: string) {
  const report = listSkills(root);
  const skills = report.skills.map((skill: any) => ({
    name: skill.name,
    slash: `/${skill.name}`,
    kind: "skill",
    description: skill.description ?? null,
  }));
  return {
    root,
    sessionId,
    commands: [],
    skills,
    slashCommands: skills,
    updatedAtMs: Date.now(),
  };
}

function runAgentTurnOnce(root: string, sessionId: string, prompt: string) {
  const rootPath = canonicalWorkspaceRoot(root);
  const settings = readModelSettings();
  const config = activeModelConfig(settings);
  const model = config ? resolveModelForProvider(config) : "default";
  const cli = join(proxyRepoRoot(), "src", "entrypoints", "cli.tsx");

  const args = [
    "run",
    cli,
    "-p",
    prompt,
    "--output-format",
    "json",
  ];

  if (model !== "default") {
    args.push("--model", model);
  }

  const proc = Bun.spawnSync(["bun", ...args], {
    cwd: rootPath,
    env: buildAgentEnv(rootPath, sessionId, config),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = textDecoder.decode(proc.stdout);
  const stderr = textDecoder.decode(proc.stderr);
  let rawJson: any = null;

  try {
    rawJson = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {}

  const message =
    typeof rawJson?.message === "string" ? rawJson.message :
    typeof rawJson?.result === "string" ? rawJson.result :
    typeof rawJson?.content === "string" ? rawJson.content :
    stdout.trim() ? stdout :
    stderr;

  const estimatedCost =
    rawJson?.total_cost_usd
    ?? rawJson?.cost_usd
    ?? rawJson?.estimated_cost
    ?? rawJson?.estimatedCost
    ?? null;

  return {
    ok: proc.exitCode === 0,
    message,
    requires_confirmation: false,
    permission_prompt: null,
    model: config ? model : null,
    iterations: null,
    tool_uses: Array.isArray(rawJson?.tool_uses) ? rawJson.tool_uses : [],
    tool_results: Array.isArray(rawJson?.tool_results) ? rawJson.tool_results : [],
    usage: rawJson?.usage ?? null,
    estimated_cost: estimatedCost == null ? null : String(estimatedCost),
    raw_json: rawJson,
    stderr: stderr.trim() ? stderr : null,
  };
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requestId = `${request.method} ${url.pathname} ${Date.now().toString(36)}`;

  if (request.method === "OPTIONS") return json({ ok: true });

  if (url.pathname === "/health") {
    return json({
      ok: true,
      proxyVersion: "0.2.0-dev",
      protocolVersion: "2026-05-13",
      capabilities: [
        "health",
        "workspaces",
        "files",
        "workspace-files",
        "git",
        "runtime-tools",
        "tools",
        "sessions",
        "skills",
        "mcp",
        "models",
        "agent-http-surface",
        "agent-fork",
        "event-stream",
      ],
      dataDir,
      message: "dev remote proxy is running",
    });
  }

  if (url.pathname === "/events") {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        eventClients.add(controller);
        controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ eventType: "connected", payload: { ok: true } })}\n\n`));
      },
      cancel() {
        if (controllerRef) eventClients.delete(controllerRef);
        controllerRef = null;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "access-control-allow-origin": "*",
      },
    });
  }

  if (url.pathname === "/workspaces" && request.method === "GET") {
    return json(readWorkspaceRegistry());
  }

  if (url.pathname === "/workspaces" && request.method === "POST") {
    const body = await parseJsonBody<{ root?: string; name?: string }>(request);
    debugLog(requestId, { action: "addWorkspaceRegistryEntry", body });
    const ws = workspaceStateFromPath(String(body.root ?? ""));
    if (body.name?.trim()) ws.name = body.name.trim();
    const registry = readWorkspaceRegistry();
    if (!registry.workspaces.some((item) => item.root === ws.root)) {
      registry.workspaces.push(ws);
    }
    writeWorkspaceRegistry(registry);
    debugLog(requestId, { action: "addWorkspaceRegistryEntry.result", ws, registrySize: registry.workspaces.length });
    return json(registry);
  }

  if (url.pathname === "/workspace/default") {
    const first = readWorkspaceRegistry().workspaces[0];
    const result = first ?? workspaceStateFromPath(process.cwd());
    debugLog(requestId, { action: "getDefaultWorkspace", result });
    return json(result);
  }

  if (url.pathname === "/workspace/open") {
    const rawPath = String(url.searchParams.get("path") ?? "");
    debugLog(requestId, { action: "openWorkspace", input: rawPath });
    try {
      const result = workspaceStateFromPath(rawPath);
      debugLog(requestId, { action: "openWorkspace.result", result });
      return json(result);
    } catch (err) {
      debugLog(requestId, { action: "openWorkspace.error", error: String(err) });
      return error(String(err));
    }
  }

  if (url.pathname === "/workspace/entries" || url.pathname === "/workspace-files") {
    return json(listProjectEntries(String(url.searchParams.get("root") ?? "")));
  }

  if ((url.pathname === "/workspace/file" || url.pathname === "/workspace-files/read") && request.method === "GET") {
    const root = String(url.searchParams.get("root") ?? "");
    const path = String(url.searchParams.get("path") ?? "");
    const reference = url.searchParams.get("reference") === "1";
    if (reference) {
      const ref = resolveReferencePath(root, path);
      return json(fileView(ref.display, ref.resolved));
    }
    const resolved = resolveWorkspacePath(root, path);
    return json(fileView(path, resolved));
  }

  if ((url.pathname === "/workspace/file" || url.pathname === "/workspace-files/write") && request.method === "PUT") {
    const body = await parseJsonBody<{ root: string; path: string; content: string }>(request);
    const resolved = resolveWorkspacePathAllowMissing(body.root, body.path);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, body.content);
    return json(null);
  }

  if ((url.pathname === "/workspace/file/edit" || url.pathname === "/workspace-files/edit") && request.method === "POST") {
    const body = await parseJsonBody<{ root: string; path: string; oldString: string; newString: string; replaceAll?: boolean }>(request);
    const resolved = resolveWorkspacePath(body.root, body.path);
    const current = readFileSync(resolved, "utf8");
    const updated = body.replaceAll
      ? current.split(body.oldString).join(body.newString)
      : current.replace(body.oldString, body.newString);
    writeFileSync(resolved, updated);
    return json(null);
  }

  if (url.pathname === "/workspace/search" || url.pathname === "/workspace-files/search") {
    return json(searchWorkspaceFiles(
      String(url.searchParams.get("root") ?? ""),
      String(url.searchParams.get("query") ?? url.searchParams.get("q") ?? ""),
      Number(url.searchParams.get("maxResults") ?? "20"),
    ));
  }

  if (url.pathname === "/workspace/image/metadata" || url.pathname === "/workspace-files/image/metadata") {
    const ref = resolveReferencePath(String(url.searchParams.get("root") ?? ""), String(url.searchParams.get("path") ?? ""));
    return json({
      path: ref.display,
      mimeType: imageMime(ref.resolved),
      sizeBytes: statSync(ref.resolved).size,
    });
  }

  if (url.pathname === "/workspace/image/preview" || url.pathname === "/workspace-files/image/preview") {
    const ref = resolveReferencePath(String(url.searchParams.get("root") ?? ""), String(url.searchParams.get("path") ?? ""));
    const mimeType = imageMime(ref.resolved);
    const bytes = readFileSync(ref.resolved);
    return json({
      path: ref.display,
      mimeType,
      dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
      sizeBytes: statSync(ref.resolved).size,
    });
  }

  if ((url.pathname === "/runtime/glob" || url.pathname === "/tools/glob") && request.method === "POST") {
    const body = await parseJsonBody<{ root: string; pattern: string; path?: string }>(request);
    const base = body.path ? resolveWorkspacePath(body.root, body.path) : canonicalWorkspaceRoot(body.root);
    const output = runCommand(["find", base, "-name", body.pattern]);
    return json(output);
  }

  if ((url.pathname === "/runtime/grep" || url.pathname === "/tools/grep") && request.method === "POST") {
    const body = await parseJsonBody<{ root: string; request: any }>(request);
    const rootPath = canonicalWorkspaceRoot(body.root);
    const req = body.request ?? {};
    const base = req.path ? resolveWorkspacePath(body.root, req.path) : rootPath;
    const args = ["-R"];
    if (req.case_insensitive) args.push("-i");
    if (req.output_mode === "files_with_matches") args.push("-l");
    args.push(req.pattern ?? "");
    if (req.glob) args.push("--include", req.glob);
    args.push(base);
    const output = runCommand(["grep", ...args]);
    if (req.head_limit && output.stdout) {
      output.stdout = output.stdout.split(/\r?\n/).slice(0, req.head_limit).join("\n");
    }
    return json(output);
  }

  if ((url.pathname === "/runtime/bash" || url.pathname === "/tools/bash") && request.method === "POST") {
    const body = await parseJsonBody<{ root: string; request: { command: string; timeout_ms?: number } }>(request);
    return json(runCommand(["bash", "-lc", body.request.command], canonicalWorkspaceRoot(body.root), body.request.timeout_ms ?? 30000));
  }

  if (url.pathname === "/git/diff") {
    const root = String(url.searchParams.get("root") ?? "");
    const path = url.searchParams.get("path");
    const args = ["diff"];
    if (path) args.push("--", path);
    const output = runCommand(["git", ...args], canonicalWorkspaceRoot(root));
    return json({ path: path ?? null, diff: output.stdout, is_empty: output.stdout.length === 0 });
  }

  if ((url.pathname === "/models/settings" || url.pathname === "/model/settings") && request.method === "GET") {
    return json(readModelSettings());
  }

  if ((url.pathname === "/models/settings" || url.pathname === "/model/settings") && request.method === "PUT") {
    const settings = await parseJsonBody<any>(request);
    writeJson(modelSettingsPath, settings);
    return json(settings);
  }

  if ((url.pathname === "/models/test" || url.pathname === "/model/test") && request.method === "POST") {
    const settings = await parseJsonBody<any>(request);
    const active = settings.models?.find((m: any) => m.id === settings.activeModelId) ?? settings.models?.[0];
    return json({
      ok: true,
      message: "Remote proxy accepted model settings. Provider network test is not enabled in dev proxy.",
      model: active?.model ?? active?.id ?? "unknown",
      stderr: null,
    });
  }

  if (url.pathname === "/mcp/settings" && request.method === "GET") {
    return json(readMcpSettingsFile());
  }

  if (url.pathname === "/mcp/settings" && request.method === "PUT") {
    const settings = await parseJsonBody<any>(request);
    mkdirSync(dirname(mcpSettingsPath), { recursive: true });
    writeJson(mcpSettingsPath, settings);
    return json({ path: mcpSettingsPath, settings });
  }

  if (url.pathname === "/skills" && request.method === "GET") {
    return json(compatSkillsReport(listSkills(String(url.searchParams.get("root") ?? ""))));
  }

  if (url.pathname === "/skills" && request.method === "POST") {
    const body = await parseJsonBody<{ root: string; source: string }>(request);
    const rootPath = canonicalWorkspaceRoot(body.root);
    const source = resolve(expandHome(body.source));
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      return error(`skill source is not a directory: ${body.source}`);
    }
    const dest = join(rootPath, ".claude", "skills", basename(source));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(source, dest, { recursive: true });
    const report = listSkills(body.root);
    return json({ ...report, installed: report.skills.find((skill: any) => skill.skillRoot?.endsWith(basename(source))) });
  }

  if (url.pathname === "/sessions" && request.method === "GET") {
    const root = String(url.searchParams.get("root") ?? "");
    const sessions = listRuntimeSessions(root);
    debugLog(requestId, { action: "listRuntimeSessions", root, count: sessions.length });
    return json(sessions);
  }

  if (url.pathname === "/sessions" && request.method === "POST") {
    const body = await parseJsonBody<{ root: string }>(request);
    debugLog(requestId, { action: "createRuntimeSession", root: body.root });
    const rootPath = canonicalWorkspaceRoot(body.root);
    const id = crypto.randomUUID();
    const now = Date.now();
    const sessionsDir = claudeProjectSessionsDir(rootPath);
    const sessionPath = join(sessionsDir, `${id}.jsonl`);
    mkdirSync(sessionsDir, { recursive: true });
    if (!existsSync(sessionPath)) writeFileSync(sessionPath, "");
    debugLog(requestId, { action: "createRuntimeSession.result", id, path: sessionPath });
    return json({
      id,
      title: "新会话",
      path: sessionPath,
      updated_at_ms: now,
      modified_epoch_millis: now,
      message_count: 0,
      parent_session_id: null,
      branch_name: null,
    });
  }

  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch && request.method === "GET") {
    return json(loadRuntimeSession(String(url.searchParams.get("root") ?? ""), decodeURIComponent(sessionMatch[1])));
  }


  if (url.pathname === "/agent/status") {
    return json(processStatus(
      String(url.searchParams.get("root") ?? ""),
      String(url.searchParams.get("sessionId") ?? ""),
    ));
  }

  if (url.pathname === "/agent/permission-state") {
    return json({
      currentMode: "default",
      availableModes: ["default", "acceptEdits", "bypassPermissions", "dontAsk", "plan"],
    });
  }

  if (url.pathname === "/agent/permission-mode" && request.method === "POST") {
    const body = await parseJsonBody<{ mode: PermissionMode }>(request);
    return json({
      currentMode: normalizePermissionMode(body.mode),
      availableModes: ["default", "acceptEdits", "bypassPermissions", "dontAsk", "plan"],
    });
  }

  if (url.pathname === "/agent/capabilities") {
    const root = canonicalWorkspaceRoot(String(url.searchParams.get("root") ?? ""));
    const sessionId = String(url.searchParams.get("sessionId") ?? "");
    const proc = findAgentProcess(root, sessionId);

    if (!proc) {
      return json(fallbackCapabilities(root, sessionId));
    }

    const requestId = `agent-ui-capabilities-${Date.now()}`;
    controlResponses.delete(requestId);

    await writeAgentLine(proc, {
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "get_capabilities",
      },
    });

    try {
      const response = await waitForControlResponse(requestId, 5000);
      return json(capabilitiesFromControlResponse(root, proc.sessionId, response));
    } catch {
      return json(fallbackCapabilities(root, proc.sessionId));
    }
  }


  if (url.pathname === "/agent/context-usage") {
    const root = canonicalWorkspaceRoot(String(url.searchParams.get("root") ?? ""));
    const sessionId = String(url.searchParams.get("sessionId") ?? "");
    const proc = findAgentProcess(root, sessionId);

    if (!proc) {
      return error("REPL process is not running", 409);
    }

    const requestId = `agent-ui-context-${Date.now()}`;
    controlResponses.delete(requestId);

    await writeAgentLine(proc, {
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "get_context_usage",
      },
    });

    const response = await waitForControlResponse(requestId, 5000);
    return json(contextUsageFromControlResponse(root, proc.sessionId, response));
  }

  if (url.pathname === "/agent/ensure" && request.method === "POST") {
    const body = await parseJsonBody<{
      root: string;
      sessionId: string;
      modelOverride?: string;
      permissionMode?: PermissionMode;
    }>(request);

    const rootPath = canonicalWorkspaceRoot(body.root);
    const existing = findAgentProcess(rootPath, body.sessionId);
    if (existing) {
      return json({
        root: existing.root,
        sessionId: existing.sessionId,
        model: existing.model,
        permissionMode: existing.permissionMode,
      });
    }

    const proc = startAgentProcess(
      rootPath,
      body.sessionId,
      body.modelOverride,
      body.permissionMode,
    );

    return json({
      root: proc.root,
      sessionId: proc.sessionId,
      model: proc.model,
      permissionMode: proc.permissionMode,
    });
  }

  if (url.pathname === "/agent/fork" && request.method === "POST") {
    const body = await parseJsonBody<{
      root: string;
      sourceSessionId: string;
      checkpointUuid: string;
      modelOverride?: string;
      permissionMode?: PermissionMode;
    }>(request);

    const proc = await startForkAgentProcess(
      body.root,
      body.sourceSessionId,
      body.checkpointUuid,
      body.modelOverride,
      body.permissionMode,
    );

    return json({
      root: proc.root,
      sessionId: proc.sessionId,
      model: proc.model,
      permissionMode: proc.permissionMode,
    });
  }

  if (url.pathname === "/agent/input" && request.method === "POST") {
    const body = await parseJsonBody<{ root: string; sessionId: string; input: string }>(request);
    const root = canonicalWorkspaceRoot(body.root);
    const proc = findAgentProcess(root, body.sessionId);
    if (!proc) throw new Error("REPL process is not running");

    await writeAgentLine(proc, sdkUserMessage(proc.sessionId, body.input));
    return json({ accepted: true });
  }

  if (url.pathname === "/agent/interrupt" && request.method === "POST") {
    const body = await parseJsonBody<{ root: string; sessionId: string }>(request);
    const root = canonicalWorkspaceRoot(body.root);
    const proc = findAgentProcess(root, body.sessionId);

    if (!proc) {
      emitAgentEvent({
        sessionId: body.sessionId,
        root,
        eventType: "interrupt",
        payload: { ok: false, text: "No running process to interrupt" },
      });
      return json(false);
    }

    await writeAgentLine(proc, {
      type: "control_request",
      request_id: `agent-ui-interrupt-${Date.now()}`,
      request: {
        subtype: "interrupt",
      },
    });

    emitAgentEvent({
      sessionId: proc.sessionId,
      root,
      eventType: "interrupt",
      payload: { ok: true, text: "Interrupt signal sent" },
    });

    return json(true);
  }

  if (url.pathname === "/agent/kill" && request.method === "POST") {
    const body = await parseJsonBody<{ root: string; sessionId: string }>(request);
    return json(await stopAgentProcess(canonicalWorkspaceRoot(body.root), body.sessionId));
  }

  if (url.pathname === "/agent/permission-response" && request.method === "POST") {
    const body = await parseJsonBody<{
      root: string;
      sessionId: string;
      requestId: string;
      approved: boolean;
    }>(request);

    const root = canonicalWorkspaceRoot(body.root);
    const proc = findAgentProcess(root, body.sessionId);
    if (!proc) throw new Error("REPL process is not running for permission response");

    await writeAgentLine(proc, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: body.requestId,
        response: {
          behavior: body.approved ? "allow" : "deny",
          updatedInput: {},
        },
      },
    });

    return json({ accepted: true });
  }

  if (url.pathname === "/agent/run-turn" && request.method === "POST") {
    const body = await parseJsonBody<{ root: string; sessionId: string; prompt: string }>(request);
    return json(runAgentTurnOnce(body.root, body.sessionId, body.prompt));
  }


  if (url.pathname === "/debug/log" && request.method === "POST") {
    const body = await parseJsonBody<{ level: string; message: string; data?: any }>(request);
    debugLog(`client-${body.level}`, { message: body.message, data: body.data });
    return json({ ok: true });
  }

  debugLog(requestId, { action: "not_found", pathname: url.pathname });
  return error(`Not found: ${url.pathname}`, 404);
}

Bun.serve({
  port,
  fetch(request) {
    const requestId = `GLOBAL ${Date.now().toString(36)}`;
    return handle(request).catch((err) => {
      debugLog(requestId, { action: "unhandled_error", error: String(err) });
      return error(err instanceof Error ? err.message : String(err), 500);
    });
  },
});

console.log(`dev remote proxy listening on http://127.0.0.1:${port}`);
console.log(`remote data dir: ${dataDir}`);
console.log(`workspace registry: ${workspaceRegistryPath}`);
