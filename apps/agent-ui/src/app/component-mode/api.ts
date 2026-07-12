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
// 连接配置存 webview localStorage（key `agent-ui.dagServer.v1`），复用
// code mode 的 RemoteProfile / testRemoteHealth / normalizeBaseUrl 机制。

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

// ─── 连接配置持久化 ──────────────────────────────────────────────────

export function loadDagServer(): RemoteProfile | null {
  const raw = window.localStorage.getItem(DAG_SERVER_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (typeof p?.id === "string" && typeof p?.name === "string" && typeof p?.baseUrl === "string") {
      return {
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        token: typeof p.token === "string" ? p.token.trim() || undefined : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function saveDagServer(input: { name: string; baseUrl: string; token?: string }): RemoteProfile {
  const profile = createRemoteProfileInput(input);
  window.localStorage.setItem(DAG_SERVER_KEY, JSON.stringify(profile));
  return profile;
}

export function clearDagServer(): void {
  window.localStorage.removeItem(DAG_SERVER_KEY);
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
