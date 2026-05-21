import * as localRuntime from "./local";
import type { AgentReplStreamEvent } from "../types";

export type AgentRuntime = typeof localRuntime;

export type RemoteProfile = {
  id: string;
  name: string;
  baseUrl: string;
  token?: string;
};

export type RemoteHealthResult = {
  ok: boolean;
  baseUrl: string;
  status?: number;
  proxyVersion?: string;
  protocolVersion?: string;
  capabilities?: string[];
  message?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function remoteJson<T>(profile: RemoteProfile, path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
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
      typeof body?.message === "string"
        ? body.message
        : `Remote ${path} failed: ${response.status} ${response.statusText}`,
    );
  }

  return body as T;
}

export async function testRemoteHealth(profile: RemoteProfile): Promise<RemoteHealthResult> {
  const baseUrl = normalizeBaseUrl(profile.baseUrl);

  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(profile.token ? { Authorization: `Bearer ${profile.token}` } : {}),
      },
    });

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    return {
      ok: response.ok,
      baseUrl,
      status: response.status,
      proxyVersion: body?.proxyVersion,
      protocolVersion: body?.protocolVersion,
      capabilities: Array.isArray(body?.capabilities) ? body.capabilities : undefined,
      message: body?.message ?? response.statusText,
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createRemoteRuntime(profile: RemoteProfile): AgentRuntime {
  const runtime: Partial<AgentRuntime> = {};

  runtime.getDefaultWorkspace = async () =>
    remoteJson(profile, "/workspace/default");

  runtime.openWorkspace = async (path: string) =>
    remoteJson(profile, `/workspace/open${query({ path })}`);

  runtime.loadWorkspaceRegistry = async () =>
    remoteJson(profile, "/workspaces");

  runtime.addWorkspaceRegistryEntry = async (path: string) =>
    remoteJson(profile, "/workspaces", {
      method: "POST",
      body: JSON.stringify({ root: path }),
    });

  runtime.listProjectEntries = async (root: string) =>
    remoteJson(profile, `/workspace/entries${query({ root })}`);

  runtime.readWorkspaceFile = async (root: string, path: string) =>
    remoteJson(profile, `/workspace/file${query({ root, path })}`);

  runtime.readLocalReferenceFile = async (root: string, path: string) =>
    remoteJson(profile, `/workspace/file${query({ root, path, reference: 1 })}`);

  runtime.searchWorkspaceFiles = async (root: string, q: string, maxResults = 20) =>
    remoteJson(profile, `/workspace/search${query({ root, query: q, maxResults })}`);

  runtime.readLocalImagePreview = async (root: string, path: string) =>
    remoteJson(profile, `/workspace/image/preview${query({ root, path })}`);

  runtime.readLocalImageMetadata = async (root: string, path: string) =>
    remoteJson(profile, `/workspace/image/metadata${query({ root, path })}`);

  runtime.writeWorkspaceFile = async (root: string, path: string, content: string) =>
    remoteJson(profile, "/workspace/file", {
      method: "PUT",
      body: JSON.stringify({ root, path, content }),
    });

  runtime.editWorkspaceFile = async (
    root: string,
    path: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ) =>
    remoteJson(profile, "/workspace/file/edit", {
      method: "POST",
      body: JSON.stringify({ root, path, oldString, newString, replaceAll }),
    });

  runtime.globRuntimeSearch = async (root: string, pattern: string, path?: string) =>
    remoteJson(profile, "/runtime/glob", {
      method: "POST",
      body: JSON.stringify({ root, pattern, path }),
    });

  runtime.grepRuntimeSearch = async (root: string, request: any) =>
    remoteJson(profile, "/runtime/grep", {
      method: "POST",
      body: JSON.stringify({ root, request }),
    });

  runtime.executeRuntimeBash = async (root: string, request: any) =>
    remoteJson(profile, "/runtime/bash", {
      method: "POST",
      body: JSON.stringify({ root, request }),
    });

  runtime.listRuntimeSessions = async (root: string) =>
    remoteJson(profile, `/sessions${query({ root })}`);

  runtime.createRuntimeSession = async (root: string) =>
    remoteJson(profile, "/sessions", {
      method: "POST",
      body: JSON.stringify({ root }),
    });

  runtime.loadRuntimeSession = async (root: string, reference: string) =>
    remoteJson(profile, `/sessions/${encodeURIComponent(reference)}${query({ root })}`);

  runtime.loadTypedRuntimeSession =
    runtime.loadRuntimeSession as AgentRuntime["loadTypedRuntimeSession"];

  runtime.readGitDiff = async (root: string, path?: string) =>
    remoteJson(profile, `/git/diff${query({ root, path })}`);

  runtime.loadModelSettings = async () =>
    remoteJson(profile, "/models/settings");

  runtime.saveModelSettings = async (settings: any) =>
    remoteJson(profile, "/models/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });

  runtime.testModelConnection = async (settings: any) =>
    remoteJson(profile, "/models/test", {
      method: "POST",
      body: JSON.stringify(settings),
    });

  runtime.loadMcpSettings = async () =>
    remoteJson(profile, "/mcp/settings");

  runtime.saveMcpSettings = async (settings: any) =>
    remoteJson(profile, "/mcp/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });

  runtime.listSkills = async (root: string) =>
    remoteJson(profile, `/skills${query({ root })}`);

  runtime.installSkill = async (root: string, source: string) =>
    remoteJson(profile, "/skills", {
      method: "POST",
      body: JSON.stringify({ root, source }),
    });

  runtime.interruptAgentTurn = async (root: string, sessionId: string) =>
    remoteJson(profile, "/agent/interrupt", {
      method: "POST",
      body: JSON.stringify({ root, sessionId }),
    });

  runtime.getAgentReplProcessStatus = async (root: string, sessionId: string) =>
    remoteJson(profile, `/agent/status${query({ root, sessionId })}`);

  runtime.killAgentReplProcess = async (root: string, sessionId: string) =>
    remoteJson(profile, "/agent/kill", {
      method: "POST",
      body: JSON.stringify({ root, sessionId }),
    });

  runtime.getAgentPermissionState = async () =>
    remoteJson(profile, "/agent/permission-state");

  runtime.setAgentPermissionMode = async (root: string, mode: any) =>
    remoteJson(profile, "/agent/permission-mode", {
      method: "POST",
      body: JSON.stringify({ root, mode }),
    });

  runtime.respondAgentPermission = async (
    root: string,
    sessionId: string,
    requestId: string,
    approved: boolean,
  ) =>
    remoteJson(profile, "/agent/permission-response", {
      method: "POST",
      body: JSON.stringify({ root, sessionId, requestId, approved }),
    });

  runtime.ensureAgentReplProcess = async (
    root: string,
    sessionId: string,
    modelOverride?: string,
    permissionMode?: any,
  ) =>
    remoteJson(profile, "/agent/ensure", {
      method: "POST",
      body: JSON.stringify({ root, sessionId, modelOverride, permissionMode }),
    });

  runtime.forkAgentReplProcess = async (
    root: string,
    sourceSessionId: string,
    checkpointUuid: string,
    modelOverride?: string,
    permissionMode?: any,
  ) =>
    remoteJson(profile, "/agent/fork", {
      method: "POST",
      body: JSON.stringify({
        root,
        sourceSessionId,
        checkpointUuid,
        modelOverride,
        permissionMode,
      }),
    });

  runtime.getAgentReplCapabilities = async (root: string, sessionId: string) =>
    remoteJson(profile, `/agent/capabilities${query({ root, sessionId })}`);

  runtime.getAgentContextUsage = async (root: string, sessionId: string) =>
    remoteJson(profile, `/agent/context-usage${query({ root, sessionId })}`);

  runtime.sendAgentReplInput = async (root: string, sessionId: string, input: string) =>
    remoteJson(profile, "/agent/input", {
      method: "POST",
      body: JSON.stringify({ root, sessionId, input }),
    });

  runtime.listenAgentReplEvents = async (handler: (event: AgentReplStreamEvent) => void) => {
    const eventsUrl = `${normalizeBaseUrl(profile.baseUrl)}/events${query({
      token: profile.token,
    })}`;
    const source = new EventSource(eventsUrl);

    source.onmessage = (message) => {
      try {
        handler(JSON.parse(message.data) as AgentReplStreamEvent);
      } catch {
        handler({
          eventType: "stderr",
          payload: { text: message.data },
        } as unknown as AgentReplStreamEvent);
      }
    };

    return () => {
      source.close();
    };
  };

  runtime.runAgentTurn = async (root: string, sessionId: string, prompt: string) =>
    remoteJson(profile, "/agent/run-turn", {
      method: "POST",
      body: JSON.stringify({ root, sessionId, prompt }),
    });

  runtime.saveBundleUsageSnapshot = async (snapshot: any) =>
    remoteJson(profile, "/usage/bundle", {
      method: "POST",
      body: JSON.stringify(snapshot),
    });

  runtime.loadBundleUsageSnapshot = async (sessionId: string, bundleId: string) =>
    remoteJson(profile, `/usage/bundle/${encodeURIComponent(sessionId)}/${encodeURIComponent(bundleId)}`);

  runtime.loadBundleUsageSnapshotsForSession = async (sessionId: string) =>
    remoteJson(profile, `/usage/bundle/${encodeURIComponent(sessionId)}`);

  return runtime as AgentRuntime;
}
