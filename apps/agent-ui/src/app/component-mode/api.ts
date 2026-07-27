// ─── DAG mode HTTP client ─────────────────────────────────────────────
//
// dag mode is a pure-HTTP remote mode:
// all dag/component/component-session/execution requests hit the remote server
// the user filled in the first-connect config (axum, port 7421; routes in
// src-tauri/src/dag_api.rs).
//
// This file is the HTTP equivalent of the dag/component IPC wrappers in
// tauri.ts — it exports functions with the same name, params, and return
// types, so callers only need to change the import from `../../tauri` to
// `./api`; no business-code changes required.
//
// Connection config is persisted to disk at
// `<AGENT_UI_HOME>/dag-mode/dagServer.json` (AGENT_UI_HOME defaults to
// ~/.agent-ui and can be overridden by an env var), reusing code mode's
// RemoteProfile / testRemoteHealth / normalizeBaseUrl mechanisms.
// Loaded from disk at startup; if no disk config exists but old localStorage
// does, it is migrated over automatically.

import { invoke } from "@tauri-apps/api/core";
import type { RemoteProfile } from "../../runtime/remote";
import { testRemoteHealth } from "../../runtime/remote";
import { createRemoteProfileInput } from "../../runtime/profiles";
import type {
  Component,
  ComponentSession,
  Dag,
  DagDetail,
  DagEdge,
  DagExecution,
  DagNode,
  ExecutionLog,
  NodeExecution,
  NodeLogFile,
} from "../../types";

const DAG_SERVER_KEY = "agent-ui.dagServer.v1";

// ─── Connection config persistence (disk: ~/.agent-ui/dag-mode/dagServer.json) ─

// In-memory cache: loaded from disk at startup; later synchronous reads hit the cache, writes are persisted async.
let dagServerCache: RemoteProfile | null = null;
let dagServerLoaded = false;

/**
 * Called at startup: loads the DAG server config from disk into the memory cache.
 * - Disk config present → use it directly;
 * - Disk absent but old localStorage present → migrate to disk and delete the old key;
 * - invoke unavailable (pure web / test env) → fall back to reading localStorage directly.
 */
export async function initDagServerConfig(): Promise<void> {
  try {
    const fromDisk = (await invoke("load_dag_server")) as RemoteProfile | null;
    if (fromDisk && typeof fromDisk.id === "string" && typeof fromDisk.baseUrl === "string") {
      dagServerCache = fromDisk;
      dagServerLoaded = true;
      return;
    }
    // Migrate legacy localStorage config
    const raw = window.localStorage.getItem(DAG_SERVER_KEY);
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (typeof p?.id === "string" && typeof p?.name === "string" && typeof p?.baseUrl === "string") {
          const profile: RemoteProfile = {
            id: p.id,
            name: p.name,
            baseUrl: p.baseUrl,
            token: typeof p.token === "string" ? p.token.trim() || undefined : undefined,
          };
          dagServerCache = profile;
          await invoke("save_dag_server", { profile }).catch(() => {});
          window.localStorage.removeItem(DAG_SERVER_KEY);
        }
      } catch {
        // ignore malformed legacy value
      }
    }
  } catch {
    // invoke unavailable: fall back to reading localStorage
    const raw = window.localStorage.getItem(DAG_SERVER_KEY);
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (typeof p?.id === "string" && typeof p?.baseUrl === "string") {
          dagServerCache = {
            id: p.id,
            name: p.name ?? p.baseUrl,
            baseUrl: p.baseUrl,
            token: typeof p.token === "string" ? p.token.trim() || undefined : undefined,
          };
        }
      } catch {
        // ignore
      }
    }
  } finally {
    dagServerLoaded = true;
  }
}

export function loadDagServer(): RemoteProfile | null {
  return dagServerCache;
}

export function saveDagServer(input: { name: string; baseUrl: string; token?: string }): RemoteProfile {
  const profile = createRemoteProfileInput(input);
  dagServerCache = profile;
  dagServerLoaded = true;
  // Persist async; fail silently (does not affect this connection).
  invoke("save_dag_server", { profile }).catch(() => {});
  return profile;
}

export function clearDagServer(): void {
  dagServerCache = null;
  invoke("clear_dag_server").catch(() => {});
}

export function testDagServerHealth(profile: RemoteProfile) {
  return testRemoteHealth(profile);
}

// ─── Internal request helper ─────────────────────────────────────────

function getDagProfile(): RemoteProfile {
  const p = loadDagServer();
  if (!p) {
    throw new Error("DAG 服务未连接：请在设置中填写远程服务器地址（IP + 端口）");
  }
  return p;
}

async function dagJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const profile = getDagProfile();
  // profile.baseUrl is normalized by createRemoteProfileInput / loadDagServer at save/load time.
  const baseUrl = profile.baseUrl;
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(profile.token ? { Authorization: `Bearer ${profile.token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `DAG 请求失败 (${response.status} ${response.statusText})`,
    );
  }

  return body as T;
}

// ─── Component / DAG platform HTTP wrappers ──────────────────────────

export function listComponents(): Promise<Component[]> {
  return dagJson<Component[]>("/api/components");
}

export function getComponent(componentId: string): Promise<Component> {
  return dagJson<Component>(`/api/components/${encodeURIComponent(componentId)}`);
}

export function updateComponent(component: Component): Promise<Component> {
  return dagJson<Component>(`/api/components/${encodeURIComponent(component.id)}`, {
    method: "PUT",
    body: JSON.stringify(component),
  });
}

export function createComponent(component: Component): Promise<Component> {
  return dagJson<Component>("/api/components", {
    method: "POST",
    body: JSON.stringify(component),
  });
}

export function deleteComponent(componentId: string): Promise<void> {
  return dagJson<void>(`/api/components/${encodeURIComponent(componentId)}`, {
    method: "DELETE",
  });
}

export function listComponentFiles(componentId: string): Promise<string[]> {
  return dagJson<string[]>(`/api/components/${encodeURIComponent(componentId)}/files`);
}

export function createComponentSession(
  componentId: string,
  title?: string,
): Promise<ComponentSession> {
  return dagJson<ComponentSession>("/api/component-sessions", {
    method: "POST",
    body: JSON.stringify({ componentId, title }),
  });
}

export function listComponentSessions(componentId: string): Promise<ComponentSession[]> {
  return dagJson<ComponentSession[]>(`/api/components/${encodeURIComponent(componentId)}/sessions`);
}

export function deleteComponentSession(sessionId: string): Promise<void> {
  return dagJson<void>(`/api/component-sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export function verifyComponent(componentId: string): Promise<string[]> {
  return dagJson<string[]>(`/api/components/${encodeURIComponent(componentId)}/verify`);
}

export function listDags(): Promise<Dag[]> {
  return dagJson<Dag[]>("/api/dags");
}

export function getDag(dagId: string): Promise<DagDetail> {
  return dagJson<DagDetail>(`/api/dags/${encodeURIComponent(dagId)}`);
}

export function createDag(name: string): Promise<Dag> {
  return dagJson<Dag>("/api/dags", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function updateDag(dag: Dag, nodes: DagNode[], edges: DagEdge[]): Promise<void> {
  return dagJson<void>(`/api/dags/${encodeURIComponent(dag.id)}`, {
    method: "PUT",
    body: JSON.stringify({ dag, nodes, edges }),
  });
}

export function deleteDag(dagId: string): Promise<void> {
  return dagJson<void>(`/api/dags/${encodeURIComponent(dagId)}`, {
    method: "DELETE",
  });
}

export function publishDag(dagId: string, cron?: string): Promise<Dag> {
  return dagJson<Dag>(`/api/dags/${encodeURIComponent(dagId)}/publish`, {
    method: "POST",
    body: JSON.stringify({ cron: cron ?? null }),
  });
}

export function unpublishDag(dagId: string): Promise<Dag> {
  return dagJson<Dag>(`/api/dags/${encodeURIComponent(dagId)}/unpublish`, {
    method: "POST",
  });
}

export function runDag(dagId: string): Promise<DagExecution> {
  return dagJson<DagExecution>(`/api/dags/${encodeURIComponent(dagId)}/run`, {
    method: "POST",
  });
}

export function getExecution(executionId: string): Promise<DagExecution> {
  return dagJson<DagExecution>(`/api/executions/${encodeURIComponent(executionId)}`);
}

export function listExecutions(dagId: string): Promise<DagExecution[]> {
  return dagJson<DagExecution[]>(`/api/dags/${encodeURIComponent(dagId)}/executions`);
}

export function cancelExecution(executionId: string): Promise<void> {
  return dagJson<void>(`/api/executions/${encodeURIComponent(executionId)}/cancel`, {
    method: "POST",
  });
}

export function getExecutionLogs(executionId: string): Promise<ExecutionLog[]> {
  return dagJson<ExecutionLog[]>(`/api/executions/${encodeURIComponent(executionId)}/logs`);
}

// Fetch a page of a node's on-disk log file (full, untruncated). Falls back to
// getExecutionLogs (DB) for runs from before file-based logging existed.
export function getNodeLog(
  executionId: string,
  nodeId: string,
  offset = 0,
  limit = 2000,
): Promise<NodeLogFile> {
  return dagJson<NodeLogFile>(
    `/api/executions/${encodeURIComponent(executionId)}/nodes/${encodeURIComponent(nodeId)}/log?offset=${offset}&limit=${limit}`,
  );
}

export function getNodeExecutions(executionId: string): Promise<NodeExecution[]> {
  return dagJson<NodeExecution[]>(`/api/executions/${encodeURIComponent(executionId)}/nodes`);
}

export type OutputPreview = {
  outputName: string;
  format: string;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  total: number | null;
  unsupported?: string | null;
};

// Preview the first `limit` rows (default 100) of a node's output port. Files
// live on the server's disk and are read and returned by the server.
export function previewNodeOutput(
  executionId: string,
  nodeId: string,
  outputName: string,
  limit = 100,
): Promise<OutputPreview> {
  return dagJson<OutputPreview>(
    `/api/executions/${encodeURIComponent(executionId)}/nodes/${encodeURIComponent(nodeId)}/outputs/${encodeURIComponent(outputName)}/preview?limit=${limit}`,
  );
}

export function deleteDagNode(dagId: string, nodeId: string): Promise<void> {
  return dagJson<void>(
    `/api/dags/${encodeURIComponent(dagId)}/nodes/${encodeURIComponent(nodeId)}`,
    { method: "DELETE" },
  );
}

// Pure-HTTP mode has no SSE dag event subscription yet; the signature is kept
// and returns a no-op for caller compatibility.
export function listenDagEvents(
  _handler: (event: Record<string, unknown>) => void,
): Promise<() => void> {
  return Promise.resolve(() => {});
}
