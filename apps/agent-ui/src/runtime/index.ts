import * as localRuntime from "./local";
import { createRemoteRuntime, testRemoteHealth as testRemoteHealthImpl, type RemoteProfile } from "./remote";
import { getActiveRemoteProfileId as getActiveRemoteProfileIdImpl, loadRemoteProfiles as loadRemoteProfilesImpl } from "./profiles";

export type { AgentReplCapabilityItem, AgentReplCapabilities } from "../tauri";

export type AgentRuntime = typeof localRuntime;

function resolveInitialRuntime(): AgentRuntime {
  try {
    if (typeof window === "undefined") {
      return localRuntime;
    }

    const activeProfileId = getActiveRemoteProfileIdImpl();
    if (!activeProfileId) {
      return localRuntime;
    }

    const profile = loadRemoteProfilesImpl().find((item) => item.id === activeProfileId);
    return profile ? createRemoteRuntime(profile) : localRuntime;
  } catch {
    return localRuntime;
  }
}

let currentRuntime: AgentRuntime = resolveInitialRuntime();

export function getCurrentRuntime(): AgentRuntime {
  return currentRuntime;
}

// 后面接 RemoteRuntime 时会用到。
export function setCurrentRuntimeForDev(runtime: AgentRuntime): void {
  currentRuntime = runtime;
}

export function useLocalRuntime(): void {
  currentRuntime = localRuntime;
}

export function useRemoteRuntime(profile: RemoteProfile): void {
  currentRuntime = createRemoteRuntime(profile);
}

export function testRemoteHealth(profile: RemoteProfile) {
  return testRemoteHealthImpl(profile);
}

export type { RemoteProfile };

export const getDefaultWorkspace: AgentRuntime["getDefaultWorkspace"] = ((...args: Parameters<AgentRuntime["getDefaultWorkspace"]>) => getCurrentRuntime().getDefaultWorkspace(...args)) as AgentRuntime["getDefaultWorkspace"];
export const openWorkspace: AgentRuntime["openWorkspace"] = ((...args: Parameters<AgentRuntime["openWorkspace"]>) => getCurrentRuntime().openWorkspace(...args)) as AgentRuntime["openWorkspace"];
export const loadWorkspaceRegistry: AgentRuntime["loadWorkspaceRegistry"] = ((...args: Parameters<AgentRuntime["loadWorkspaceRegistry"]>) => getCurrentRuntime().loadWorkspaceRegistry(...args)) as AgentRuntime["loadWorkspaceRegistry"];
export const addWorkspaceRegistryEntry: AgentRuntime["addWorkspaceRegistryEntry"] = ((...args: Parameters<AgentRuntime["addWorkspaceRegistryEntry"]>) => getCurrentRuntime().addWorkspaceRegistryEntry(...args)) as AgentRuntime["addWorkspaceRegistryEntry"];
export const listProjectEntries: AgentRuntime["listProjectEntries"] = ((...args: Parameters<AgentRuntime["listProjectEntries"]>) => getCurrentRuntime().listProjectEntries(...args)) as AgentRuntime["listProjectEntries"];
export const loadMcpSettings: AgentRuntime["loadMcpSettings"] = ((...args: Parameters<AgentRuntime["loadMcpSettings"]>) => getCurrentRuntime().loadMcpSettings(...args)) as AgentRuntime["loadMcpSettings"];
export const saveMcpSettings: AgentRuntime["saveMcpSettings"] = ((...args: Parameters<AgentRuntime["saveMcpSettings"]>) => getCurrentRuntime().saveMcpSettings(...args)) as AgentRuntime["saveMcpSettings"];
export const listSkills: AgentRuntime["listSkills"] = ((...args: Parameters<AgentRuntime["listSkills"]>) => getCurrentRuntime().listSkills(...args)) as AgentRuntime["listSkills"];
export const installSkill: AgentRuntime["installSkill"] = ((...args: Parameters<AgentRuntime["installSkill"]>) => getCurrentRuntime().installSkill(...args)) as AgentRuntime["installSkill"];
export const readWorkspaceFile: AgentRuntime["readWorkspaceFile"] = ((...args: Parameters<AgentRuntime["readWorkspaceFile"]>) => getCurrentRuntime().readWorkspaceFile(...args)) as AgentRuntime["readWorkspaceFile"];
export const readLocalReferenceFile: AgentRuntime["readLocalReferenceFile"] = ((...args: Parameters<AgentRuntime["readLocalReferenceFile"]>) => getCurrentRuntime().readLocalReferenceFile(...args)) as AgentRuntime["readLocalReferenceFile"];
export const searchWorkspaceFiles: AgentRuntime["searchWorkspaceFiles"] = ((...args: Parameters<AgentRuntime["searchWorkspaceFiles"]>) => getCurrentRuntime().searchWorkspaceFiles(...args)) as AgentRuntime["searchWorkspaceFiles"];
export const readLocalImagePreview: AgentRuntime["readLocalImagePreview"] = ((...args: Parameters<AgentRuntime["readLocalImagePreview"]>) => getCurrentRuntime().readLocalImagePreview(...args)) as AgentRuntime["readLocalImagePreview"];
export const readLocalImageMetadata: AgentRuntime["readLocalImageMetadata"] = ((...args: Parameters<AgentRuntime["readLocalImageMetadata"]>) => getCurrentRuntime().readLocalImageMetadata(...args)) as AgentRuntime["readLocalImageMetadata"];
export const writeWorkspaceFile: AgentRuntime["writeWorkspaceFile"] = ((...args: Parameters<AgentRuntime["writeWorkspaceFile"]>) => getCurrentRuntime().writeWorkspaceFile(...args)) as AgentRuntime["writeWorkspaceFile"];
export const editWorkspaceFile: AgentRuntime["editWorkspaceFile"] = ((...args: Parameters<AgentRuntime["editWorkspaceFile"]>) => getCurrentRuntime().editWorkspaceFile(...args)) as AgentRuntime["editWorkspaceFile"];
export const globRuntimeSearch: AgentRuntime["globRuntimeSearch"] = ((...args: Parameters<AgentRuntime["globRuntimeSearch"]>) => getCurrentRuntime().globRuntimeSearch(...args)) as AgentRuntime["globRuntimeSearch"];
export const grepRuntimeSearch: AgentRuntime["grepRuntimeSearch"] = ((...args: Parameters<AgentRuntime["grepRuntimeSearch"]>) => getCurrentRuntime().grepRuntimeSearch(...args)) as AgentRuntime["grepRuntimeSearch"];
export const executeRuntimeBash: AgentRuntime["executeRuntimeBash"] = ((...args: Parameters<AgentRuntime["executeRuntimeBash"]>) => getCurrentRuntime().executeRuntimeBash(...args)) as AgentRuntime["executeRuntimeBash"];
export const listRuntimeSessions: AgentRuntime["listRuntimeSessions"] = ((...args: Parameters<AgentRuntime["listRuntimeSessions"]>) => getCurrentRuntime().listRuntimeSessions(...args)) as AgentRuntime["listRuntimeSessions"];
export const createRuntimeSession: AgentRuntime["createRuntimeSession"] = ((...args: Parameters<AgentRuntime["createRuntimeSession"]>) => getCurrentRuntime().createRuntimeSession(...args)) as AgentRuntime["createRuntimeSession"];
export const createForkRuntimeSession: AgentRuntime["createForkRuntimeSession"] = ((...args: Parameters<AgentRuntime["createForkRuntimeSession"]>) => getCurrentRuntime().createForkRuntimeSession(...args)) as AgentRuntime["createForkRuntimeSession"];
export const loadRuntimeSession: AgentRuntime["loadRuntimeSession"] = ((...args: Parameters<AgentRuntime["loadRuntimeSession"]>) => getCurrentRuntime().loadRuntimeSession(...args)) as AgentRuntime["loadRuntimeSession"];
export const loadTypedRuntimeSession: AgentRuntime["loadTypedRuntimeSession"] = ((...args: Parameters<AgentRuntime["loadTypedRuntimeSession"]>) => getCurrentRuntime().loadTypedRuntimeSession(...args)) as AgentRuntime["loadTypedRuntimeSession"];
export const readGitDiff: AgentRuntime["readGitDiff"] = ((...args: Parameters<AgentRuntime["readGitDiff"]>) => getCurrentRuntime().readGitDiff(...args)) as AgentRuntime["readGitDiff"];
export const loadModelSettings: AgentRuntime["loadModelSettings"] = ((...args: Parameters<AgentRuntime["loadModelSettings"]>) => getCurrentRuntime().loadModelSettings(...args)) as AgentRuntime["loadModelSettings"];
export const saveModelSettings: AgentRuntime["saveModelSettings"] = ((...args: Parameters<AgentRuntime["saveModelSettings"]>) => getCurrentRuntime().saveModelSettings(...args)) as AgentRuntime["saveModelSettings"];
export const testModelConnection: AgentRuntime["testModelConnection"] = ((...args: Parameters<AgentRuntime["testModelConnection"]>) => getCurrentRuntime().testModelConnection(...args)) as AgentRuntime["testModelConnection"];
export const interruptAgentTurn: AgentRuntime["interruptAgentTurn"] = ((...args: Parameters<AgentRuntime["interruptAgentTurn"]>) => getCurrentRuntime().interruptAgentTurn(...args)) as AgentRuntime["interruptAgentTurn"];
export const getAgentReplProcessStatus: AgentRuntime["getAgentReplProcessStatus"] = ((...args: Parameters<AgentRuntime["getAgentReplProcessStatus"]>) => getCurrentRuntime().getAgentReplProcessStatus(...args)) as AgentRuntime["getAgentReplProcessStatus"];
export const killAgentReplProcess: AgentRuntime["killAgentReplProcess"] = ((...args: Parameters<AgentRuntime["killAgentReplProcess"]>) => getCurrentRuntime().killAgentReplProcess(...args)) as AgentRuntime["killAgentReplProcess"];
export const getAgentPermissionState: AgentRuntime["getAgentPermissionState"] = ((...args: Parameters<AgentRuntime["getAgentPermissionState"]>) => getCurrentRuntime().getAgentPermissionState(...args)) as AgentRuntime["getAgentPermissionState"];
export const setAgentPermissionMode: AgentRuntime["setAgentPermissionMode"] = ((...args: Parameters<AgentRuntime["setAgentPermissionMode"]>) => getCurrentRuntime().setAgentPermissionMode(...args)) as AgentRuntime["setAgentPermissionMode"];
export const respondAgentPermission: AgentRuntime["respondAgentPermission"] = ((...args: Parameters<AgentRuntime["respondAgentPermission"]>) => getCurrentRuntime().respondAgentPermission(...args)) as AgentRuntime["respondAgentPermission"];
export const ensureAgentReplProcess: AgentRuntime["ensureAgentReplProcess"] = ((...args: Parameters<AgentRuntime["ensureAgentReplProcess"]>) => getCurrentRuntime().ensureAgentReplProcess(...args)) as AgentRuntime["ensureAgentReplProcess"];
export const forkAgentReplProcess: AgentRuntime["forkAgentReplProcess"] = ((...args: Parameters<AgentRuntime["forkAgentReplProcess"]>) => getCurrentRuntime().forkAgentReplProcess(...args)) as AgentRuntime["forkAgentReplProcess"];
export const getAgentReplCapabilities: AgentRuntime["getAgentReplCapabilities"] = ((...args: Parameters<AgentRuntime["getAgentReplCapabilities"]>) => getCurrentRuntime().getAgentReplCapabilities(...args)) as AgentRuntime["getAgentReplCapabilities"];
export const sendAgentReplInput: AgentRuntime["sendAgentReplInput"] = ((...args: Parameters<AgentRuntime["sendAgentReplInput"]>) => getCurrentRuntime().sendAgentReplInput(...args)) as AgentRuntime["sendAgentReplInput"];
export const listenAgentReplEvents: AgentRuntime["listenAgentReplEvents"] = ((...args: Parameters<AgentRuntime["listenAgentReplEvents"]>) => getCurrentRuntime().listenAgentReplEvents(...args)) as AgentRuntime["listenAgentReplEvents"];
export const runAgentTurn: AgentRuntime["runAgentTurn"] = ((...args: Parameters<AgentRuntime["runAgentTurn"]>) => getCurrentRuntime().runAgentTurn(...args)) as AgentRuntime["runAgentTurn"];

export {
  loadRemoteProfiles,
  saveRemoteProfiles,
  upsertRemoteProfile,
  deleteRemoteProfile,
  getActiveRemoteProfileId,
  setActiveRemoteProfileId,
  clearActiveRemoteProfileId,
  createRemoteProfileInput,
} from "./profiles";
