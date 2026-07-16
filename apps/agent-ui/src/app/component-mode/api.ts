// ─── DAG mode HTTP client ─────────────────────────────────────────────
//
// dag mode 是纯 HTTP 远程模式：
// 所有 dag/component/component-session/execution 请求都打到用户在「首连配置」
// 里填写的远程 server（axum，端口 7421，路由见 src-tauri/src/dag_api.rs）。
//
// 本文件是 tauri.ts 中 dag/component 那一组 IPC 包装的**等价 HTTP 替换**——
// 导出同名函数、同参数、同返回类型，调用方只需把 import 从 `../../tauri`
// 改成 `./api` 即可，业务代码零改动。
//
// 连接配置持久化到磁盘 `<AGENT_UI_HOME>/dag-mode/dagServer.json`
// （AGENT_UI_HOME 默认 ~/.agent-ui，可由环境变量覆盖），复用 code mode 的
// RemoteProfile / testRemoteHealth / normalizeBaseUrl 机制。
// 启动时从磁盘加载；若磁盘尚无配置但旧 localStorage 有，则自动迁移过去。

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
} from "../../types";

const DAG_SERVER_KEY = "agent-ui.dagServer.v1";

// ─── 连接配置持久化（磁盘：~/.agent-ui/dag-mode/dagServer.json）────────

// 内存缓存：启动后从磁盘加载，之后同步读取直接走缓存，写入时异步落盘。
let dagServerCache: RemoteProfile | null = null;
let dagServerLoaded = false;

/**
 * 启动时调用：从磁盘加载 DAG server 配置到内存缓存。
 * - 磁盘已有 → 直接采用；
 * - 磁盘无、旧 localStorage 有 → 迁移到磁盘并删除旧键；
 * - invoke 不可用（纯 web / 测试环境）→ 退化为直接读 localStorage。
 */
export async function initDagServerConfig(): Promise<void> {
  try {
    const fromDisk = (await invoke("load_dag_server")) as RemoteProfile | null;
    if (fromDisk && typeof fromDisk.id === "string" && typeof fromDisk.baseUrl === "string") {
      dagServerCache = fromDisk;
      dagServerLoaded = true;
      return;
    }
    // 迁移旧 localStorage 配置
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
    // invoke 不可用：退化读 localStorage
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
  // 异步落盘，失败静默（不影响本次连接）。
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

// ─── 内部请求助手 ────────────────────────────────────────────────────

function getDagProfile(): RemoteProfile {
  const p = loadDagServer();
  if (!p) {
    throw new Error("DAG 服务未连接：请在设置中填写远程服务器地址（IP + 端口）");
  }
  return p;
}

async function dagJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const profile = getDagProfile();
  // profile.baseUrl 在 save/load 时已被 createRemoteProfileInput / loadDagServer 归一化。
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

// 预览节点某输出端口的前 `limit` 行（默认 100）。文件在服务端磁盘，由 server 读取后返回。
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

// 纯 HTTP 模式暂无 SSE dag 事件订阅；保留签名返回 no-op 以兼容调用方。
export function listenDagEvents(
  _handler: (event: Record<string, unknown>) => void,
): Promise<() => void> {
  return Promise.resolve(() => {});
}
