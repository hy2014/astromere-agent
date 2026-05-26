import { useEffect, useRef, useState, useCallback } from "react";
import type { ModelSettings, StreamItem, StreamLink, AgentContextUsage, AgentReplStreamEvent } from "../types";
import type {
  PreviewTab,
  DebugStreamEvent,
  AssistantMessageDebugBundle,
} from "../app/types";
import type { BundleUsageSnapshot } from "../tauri";
import {
  listenAgentReplEvents,
  loadModelSettings,
  getAgentContextUsage,
} from "../runtime";
import {
  saveBundleUsageSnapshot,
  loadBundleUsageSnapshotsForSession,
} from "../tauri";
import { isNewSessionId } from "../app/file-utils";
import {
  bundleUsageStorageKey,
  bundleUsageStatusFromEvent,
  bundleUsageDecimalValue,
  bundleUsageCostAmount,
  bundleUsageCurrency,
  bundleUsageButtonLabel,
  bundleUsageTimeMs,
  bundleUsageHitRate,
  usageNumericValue,
  usagePickNumber,
  usageTotalsFromUsage,
  addUsageTotals,
  activeDeepSeekPricingModelName,
  deepSeekPricingItemsForModel,
  calculateBundleUsageCostFromDeepSeekPricing,
  usageCompletenessScore,
  modelCallUsageCandidateFromDebugEvent,
  selectBestModelCallUsageCandidate,
  calculateBundleUsageSnapshot,
  contextUsageFromBundleSnapshot,
  contextUsageAutoCompactEnabledLabel,
  usageFormatValue,
} from "../app/usage-cost";
import { DEFAULT_CONTEXT_USAGE_AUTO_COMPACT_THRESHOLD } from "../app/constants";
import {
  createDebugEvent,
  appendDebugEvent,
  realSessionIdFromEvent,
  isAssistantBundleStartEvent,
  isBundleCompletionEvent,
  rekeyAssistantDebugBundles,
  rekeyAssistantBundle,
  rekeyAssistantStreamItem,
  mergeProgressText,
  currentTurnAssistantMessageIndex,
  collapseAssistantTurns,
  upsertCurrentTurnProgressMessage,
  completeCurrentTurnAssistantMessage,
  applyRuntimeDebugEventToBundle,
  streamEventToItems,
  resolveRuntimeBundleEvent,
  payloadText,
} from "../app/stream-processor";
import {
  rekeyDebugEvents,
  assistantTurnDetails,
  toolName,
  commandFromToolUse,
  summarizeToolUse,
  isToolResultEvent,
  isPermissionEvent,
  summarizePermissionEvent,
  textFromProcessEvent,
  extractToolUsesFromRawJson,
  truncateProcessDetail,
  summarizeToolResultEvent,
  toolUsesFromProcessEvent,
} from "../app/debug-utils";
import {
  isRecord,
  modelCallIdFromRawJson,
  addUniqueString,
  rawJsonFromDebugEvent,
  extractPreviewLinks,
  isPermissionEventName,
  permissionToolNameFromEvent,
  permissionRequestIdFromEvent,
  permissionInputFromEvent,
  formatContextTokens,
  debugStorageSource,
  debugStorageSourceCounts,
} from "../app/file-utils";

// --- Types shared between hooks ---

export type TurnEventHandlers = {
  setIsRunningTurn: (value: boolean | ((prev: boolean) => boolean)) => void;
  enqueuePendingPermission: (permission: {
    root: string;
    sessionId: string;
    messageId: string;
    requestId: string;
    prompt: string;
    toolName?: string;
    input?: unknown;
    rawJson?: unknown;
  }) => void;
  clearPendingPermissionsForSession: (sessionId: string) => void;
  setProjects: (
    updater: (
      folders: import("../app/types").ProjectFolder[],
    ) => import("../app/types").ProjectFolder[],
  ) => void;
};

// ---- Hook ----

export function useStreamState() {
  const [sessionStreams, setSessionStreams] = useState<
    Record<string, StreamItem[]>
  >({});
  const [sessionDebugEvents, setSessionDebugEvents] = useState<
    Record<string, DebugStreamEvent[]>
  >({});
  const [assistantDebugBundles, setAssistantDebugBundles] = useState<
    Record<string, AssistantMessageDebugBundle>
  >({});
  const [streamUsageByBundleKey, setStreamUsageByBundleKey] = useState<
    Record<string, BundleUsageSnapshot>
  >({});
  const [copiedDebugMessageId, setCopiedDebugMessageId] =
    useState<string | null>(null);
  const [openAssistantDebugMessageId, setOpenAssistantDebugMessageId] =
    useState<string | null>(null);
  const [openAssistantUsageMessageId, setOpenAssistantUsageMessageId] =
    useState<string | null>(null);
  const [openProcessMessageIds, setOpenProcessMessageIds] = useState<
    Set<string>
  >(() => new Set());
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [sessionContextUsageById, setSessionContextUsageById] = useState<
    Record<string, AgentContextUsage>
  >({});
  const [contextUsageError, setContextUsageError] = useState<string | null>(
    null,
  );

  const usageCostModelSettingsRef = useRef<ModelSettings | null>(null);
  const currentBundleBySessionRef = useRef<Record<string, string | null>>({});
  const assistantDebugClickTimer = useRef<number | null>(null);

  // Side effect handlers registered by App (from useAgentTurn + useProjects)
  const turnHandlersRef = useRef<TurnEventHandlers | null>(null);

  const registerTurnHandlers = useCallback((handlers: TurnEventHandlers) => {
    turnHandlersRef.current = handlers;
  }, []);

  // Listen for agent repl events (mounted once)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenAgentReplEvents((event) => {
      const realSessionId =
        event.eventType === "turn_complete"
          ? realSessionIdFromEvent(event)
          : null;

      const debugEntry = createDebugEvent(event);
      const resolved = resolveRuntimeBundleEvent(
        event,
        currentBundleBySessionRef.current,
      );
      setSessionDebugEvents((events) =>
        appendDebugEvent(events, debugEntry),
      );
      setAssistantDebugBundles((bundles) => {
        const nextBundles = applyRuntimeDebugEventToBundle(
          bundles,
          resolved,
          debugEntry,
        );
        const bundle = resolved.bundleId
          ? nextBundles[resolved.bundleId]
          : null;
        if (bundle) {
          const snapshot = calculateBundleUsageSnapshot(
            bundle,
            bundleUsageStatusFromEvent(event),
            resolved.completesBundle ? debugEntry.receivedAt : null,
            usageCostModelSettingsRef.current,
          );
          setStreamUsageByBundleKey((current) => ({
            ...current,
            [bundleUsageStorageKey(snapshot.sessionId, snapshot.bundleId)]:
              snapshot,
          }));
          if (resolved.completesBundle) {
            const contextSessionId = realSessionId ?? snapshot.sessionId;
            const contextSnapshot =
              contextSessionId === snapshot.sessionId
                ? snapshot
                : { ...snapshot, sessionId: contextSessionId };
            setSessionContextUsageById((current) => {
              const usage = contextUsageFromBundleSnapshot(
                contextSnapshot,
                current[contextSessionId] ??
                  current[snapshot.sessionId] ??
                  null,
              );
              if (!usage) {
                return current;
              }
              return {
                ...current,
                [snapshot.sessionId]: usage,
                [contextSessionId]: usage,
              };
            });
            setContextUsageError(null);
            void saveBundleUsageSnapshot(snapshot).catch((reason) => {
              // silent
            });
          }
        }
        return nextBundles;
      });

      // Update stream items
      setSessionStreams((streams) => ({
        ...streams,
        [event.sessionId]: collapseAssistantTurns(
          streamEventToItems(streams[event.sessionId] ?? [], resolved),
        ),
      }));

      // Handle permission requests
      if (
        event.eventType === "permission_request" ||
        event.eventType === "control_request"
      ) {
        const toolName = permissionToolNameFromEvent(event);
        const requestId = permissionRequestIdFromEvent(event);
        const input = permissionInputFromEvent(event);
        const promptText = String(
          event.payload.prompt ?? `${toolName} requests permission`,
        );

        turnHandlersRef.current?.enqueuePendingPermission({
          root: event.root,
          sessionId: event.sessionId,
          messageId: `permission:${event.sessionId}:${requestId || Date.now()}`,
          requestId,
          prompt: promptText,
          toolName,
          input,
          rawJson: event.payload.raw_json ?? event.payload,
        });
        turnHandlersRef.current?.setIsRunningTurn(false);
      }

      // Handle startup / process_status
      if (
        event.eventType === "startup" ||
        event.eventType === "process_status"
      ) {
        const pid =
          typeof event.payload.pid === "number" ? event.payload.pid : undefined;
        const running =
          event.eventType === "startup"
            ? true
            : event.payload.running === true;
        turnHandlersRef.current?.setProjects((folders) =>
          folders.map((folder) => ({
            ...folder,
            sessions: folder.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    processStatus: running ? "active" : "stopped",
                    processPid: running ? pid : undefined,
                  }
                : session,
            ),
          })),
        );
      }

      // Handle session rekey (realSessionId)
      if (realSessionId && realSessionId !== event.sessionId) {
        setSessionStreams((streams) => {
          const oldItems = streams[event.sessionId] ?? [];
          const existingNewItems = streams[realSessionId] ?? [];
          const { [event.sessionId]: _removed, ...rest } = streams;

          return {
            ...rest,
            [realSessionId]:
              existingNewItems.length > 0 ? existingNewItems : oldItems,
          };
        });
        setSessionDebugEvents((events) =>
          rekeyDebugEvents(events, event.sessionId, realSessionId),
        );
        setAssistantDebugBundles((bundles) =>
          rekeyAssistantDebugBundles(
            bundles,
            event.sessionId,
            realSessionId,
          ),
        );
        setSessionContextUsageById((current) => {
          const existing = current[event.sessionId];
          if (!existing || current[realSessionId]) {
            return current;
          }
          const { [event.sessionId]: _oldContextUsage, ...rest } = current;
          return {
            ...rest,
            [realSessionId]: { ...existing, sessionId: realSessionId },
          };
        });

        const pid =
          typeof event.payload.pid === "number" ? event.payload.pid : undefined;
        turnHandlersRef.current?.setProjects((folders) =>
          folders.map((folder) => {
            const sessions = folder.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    id: realSessionId,
                    isPending: false,
                    processStatus: "active" as const,
                    processPid: pid ?? session.processPid,
                  }
                : session,
            );
            return {
              ...folder,
              sessions: sessions.filter(
                (session, index, self) =>
                  self.findIndex((s) => s.id === session.id) === index,
              ),
            };
          }),
        );

        turnHandlersRef.current?.setIsRunningTurn(true);
        // Also update activeSessionId (this is handled via App passing setActiveSessionId)
      }

      // Handle turn completion / error / interrupt / process_exit
      if (
        event.eventType === "turn_complete" ||
        event.eventType === "error" ||
        event.eventType === "interrupt" ||
        event.eventType === "process_exit"
      ) {
        turnHandlersRef.current?.setIsRunningTurn(false);
        turnHandlersRef.current?.clearPendingPermissionsForSession(
          event.sessionId,
        );
      }

      // Handle process_exit
      if (event.eventType === "process_exit") {
        turnHandlersRef.current?.setProjects((folders) =>
          folders.map((folder) => ({
            ...folder,
            sessions: folder.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    processStatus: "stopped",
                    processPid: undefined,
                  }
                : session,
            ),
          })),
        );
      }

      // Handle stderr
      if (event.eventType === "stderr") {
        const detail = String(
          event.payload?.text ?? event.payload?.message ?? "",
        ).toLowerCase();
        if (detail.includes("repl process stdout closed")) {
          turnHandlersRef.current?.setProjects((folders) =>
            folders.map((folder) => ({
              ...folder,
              sessions: folder.sessions.map((session) =>
                session.id === event.sessionId
                  ? {
                      ...session,
                      processStatus: "stopped",
                      processPid: undefined,
                    }
                  : session,
              ),
            })),
          );
        }
        if (
          detail.includes("error") ||
          detail.includes("failed") ||
          detail.includes("missing_credentials")
        ) {
          turnHandlersRef.current?.setIsRunningTurn(false);
          turnHandlersRef.current?.clearPendingPermissionsForSession(
            event.sessionId,
          );
        }
      }
    })
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((reason) => {
        // silent
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Load model settings for pricing
  useEffect(() => {
    let cancelled = false;
    loadModelSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        usageCostModelSettingsRef.current = settings;
      })
      .catch(() => {
        if (!cancelled) {
          usageCostModelSettingsRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Handlers ----

  const updateSessionStream = useCallback(
    (
      sessionId: string,
      updater: (items: StreamItem[]) => StreamItem[],
    ) => {
      setSessionStreams((streams) => ({
        ...streams,
        [sessionId]: collapseAssistantTurns(
          updater(streams[sessionId] ?? []),
        ),
      }));
    },
    [],
  );

  const refreshSessionContextUsage = useCallback(
    async (root: string, sessionId: string) => {
      if (!root || !sessionId || isNewSessionId(sessionId)) {
        return;
      }

      try {
        const usage = await getAgentContextUsage(root, sessionId);
        setContextUsageError(null);
        setSessionContextUsageById((current) => ({
          ...current,
          [sessionId]: usage,
          [usage.sessionId || sessionId]: usage,
        }));
      } catch (reason) {
        setContextUsageError(String(reason));
      }
    },
    [],
  );

  const assistantDebugPayload = useCallback(
    (
      item: Extract<StreamItem, { kind: "message" }>,
      action: "view" | "copy",
    ) => {
      const bundle = assistantDebugBundles[item.id];
      // Simplified — the full payload is kept in App.tsx if needed
      return {
        kind: "agent-ui.assistant-message-debug" as const,
        action,
        generatedAt: new Date().toISOString(),
        sessionId: bundle?.sessionId ?? null,
        messageId: item.id,
        displayedMessage: item.text,
        completed: bundle?.completed ?? null,
        eventCount: bundle?.events.length ?? 0,
      };
    },
    [assistantDebugBundles],
  );

  const handleToggleAssistantProcess = useCallback(
    (messageId: string) => {
      setOpenProcessMessageIds((current) => {
        const next = new Set(current);
        if (next.has(messageId)) {
          next.delete(messageId);
        } else {
          next.add(messageId);
        }
        return next;
      });
    },
    [],
  );

  const handleToggleSessionUsage = useCallback(() => {
    setIsDebugOpen((current) => !current);
  }, []);

  const handleViewAssistantUsage = useCallback(
    (bundleId: string) => {
      setOpenAssistantDebugMessageId(null);
      setIsDebugOpen(false);
      setOpenAssistantUsageMessageId(bundleId);
    },
    [],
  );

  const handleViewAssistantDebug = useCallback(
    (messageId: string) => {
      if (assistantDebugClickTimer.current !== null) {
        window.clearTimeout(assistantDebugClickTimer.current);
      }

      assistantDebugClickTimer.current = window.setTimeout(() => {
        setOpenAssistantDebugMessageId((current) =>
          current === messageId ? null : messageId,
        );
        assistantDebugClickTimer.current = null;
      }, 220);
    },
    [],
  );

  const handleCopyAssistantDebug = useCallback(
    async (item: Extract<StreamItem, { kind: "message" }>) => {
      if (assistantDebugClickTimer.current !== null) {
        window.clearTimeout(assistantDebugClickTimer.current);
        assistantDebugClickTimer.current = null;
      }

      try {
        const bundle = assistantDebugBundles[item.id];
        const details = assistantTurnDetails(item, bundle ?? null);
        const payload = {
          kind: "agent-ui.assistant-message-debug",
          action: "copy",
          generatedAt: new Date().toISOString(),
          sessionId: bundle?.sessionId ?? null,
          root: bundle?.root ?? null,
          messageId: item.id,
          userMessage: bundle?.userMessage ?? null,
          transportMessage: bundle?.transportMessage ?? null,
          referencedFiles: bundle?.fileReferences ?? item.fileReferences ?? null,
          displayedMessage: item.text,
          displayedProgressText: item.progressText ?? null,
          displayStatus: item.status ?? null,
          summary: {
            progressLineCount: details.progressLines.length,
            commandCount: details.commandUses.length,
            toolUseCount: details.toolUses.length,
            toolResultCount: details.toolResults.length,
            eventCount: details.eventCount,
          },
          debugSourceSummary: debugStorageSourceCounts(bundle?.events ?? []),
          commands: details.commandUses.map((tool) => ({
            name: toolName(tool),
            command: commandFromToolUse(tool),
            raw: tool,
          })),
          toolUses: details.toolUses.map((tool) => ({
            name: toolName(tool),
            summary: summarizeToolUse(tool),
            raw: tool,
          })),
          bundleDisplayText: bundle?.displayText ?? null,
          completed: bundle?.completed ?? null,
          eventCount: bundle?.events.length ?? 0,
          events: (bundle?.events ?? []).map((event) => ({
            eventType: event.eventType,
            receivedAt: new Date(event.receivedAt).toISOString(),
            debugStorageSource: debugStorageSource(event),
            payload: event.payload,
          })),
        };
        await navigator.clipboard.writeText(
          JSON.stringify(payload, null, 2),
        );
        setCopiedDebugMessageId(item.id);
        setCopyToast("已复制本条 AI 回复的 Debug JSON");
        window.setTimeout(() => {
          setCopiedDebugMessageId((current) =>
            current === item.id ? null : current,
          );
          setCopyToast(null);
        }, 1600);
      } catch (reason) {
        // silent
      }
    },
    [assistantDebugBundles],
  );

  const [isDebugOpen, setIsDebugOpen] = useState(false);

  const contextUsageLabel = useCallback(
    (usage: AgentContextUsage | null | undefined): string => {
      const current = usage?.data
        ? formatContextTokens(usage.data.totalTokens)
        : "--";
      const threshold = formatContextTokens(
        usage?.data?.autoCompactThreshold ??
          DEFAULT_CONTEXT_USAGE_AUTO_COMPACT_THRESHOLD,
      );
      return `上下文：${current}/${threshold}(${contextUsageAutoCompactEnabledLabel(usage)})`;
    },
    [],
  );

  const bundleUsageButtonLabelCb = useCallback(
    (snapshot: BundleUsageSnapshot | null | undefined): string => {
      return bundleUsageButtonLabel(snapshot);
    },
    [],
  );

  const sessionUsageSnapshotsForSession = useCallback(
    (
      usageByKey: Record<string, BundleUsageSnapshot>,
      sessionId: string | null,
    ): BundleUsageSnapshot[] => {
      if (!sessionId) return [];
      return Object.values(usageByKey)
        .filter(
          (snapshot: BundleUsageSnapshot) => snapshot.sessionId === sessionId,
        )
        .sort(
          (
            left: BundleUsageSnapshot,
            right: BundleUsageSnapshot,
          ) => {
            const leftTime = bundleUsageTimeMs(left);
            const rightTime = bundleUsageTimeMs(right);
            if (leftTime !== rightTime) return leftTime - rightTime;
            return left.bundleId.localeCompare(right.bundleId);
          },
        );
    },
    [],
  );

  return {
    // States
    sessionStreams,
    sessionDebugEvents,
    assistantDebugBundles,
    streamUsageByBundleKey,
    sessionContextUsageById,
    contextUsageError,
    copiedDebugMessageId,
    openAssistantDebugMessageId,
    openAssistantUsageMessageId,
    openProcessMessageIds,
    copyToast,
    isDebugOpen,

    // Setters (exposed for App/useAgentTurn)
    setSessionStreams,
    setAssistantDebugBundles,
    setStreamUsageByBundleKey,
    setSessionContextUsageById,
    setContextUsageError,
    setCopiedDebugMessageId,
    setOpenAssistantDebugMessageId,
    setOpenAssistantUsageMessageId,
    setOpenProcessMessageIds,
    setCopyToast,
    setIsDebugOpen,

    // Refs
    usageCostModelSettingsRef,
    currentBundleBySessionRef,

    // Event side effect registration
    registerTurnHandlers,

    // Handlers
    updateSessionStream,
    refreshSessionContextUsage,
    contextUsageLabel,
    bundleUsageButtonLabel: bundleUsageButtonLabelCb,
    sessionUsageSnapshotsForSession,
    assistantDebugPayload,
    handleToggleAssistantProcess,
    handleToggleSessionUsage,
    handleViewAssistantUsage,
    handleViewAssistantDebug,
    handleCopyAssistantDebug,
  };
}
