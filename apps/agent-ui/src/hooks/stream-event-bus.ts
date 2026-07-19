import { listenAgentReplEvents } from "../runtime";
import type { AgentReplStreamEvent } from "../types";

/**
 * Pure event-broadcast layer.
 *
 * listenAgentReplEvents is called only once for the whole application.
 *
 * ── Data flow ──
 *
 *   App.tsx:
 *     setEventHandle("session", handleSessionEvent)   // each name can only be registered once
 *     setEventHandle("usage", handleUsageEvent)
 *
 *   View mount:
 *     addCallback("session", (data) => ...)            // multiple Views can register multiple callbacks
 *     addCallback("session", (data) => ...)
 *
 *   Tauri events:
 *     dispatch(event)
 *       └─ for each name,
 *            handle(event) → { sessionId, data }
 *              ├─ data[name][sessionId] = data         ← global store
 *              └─ for each callback of name:
 *                   callback(data)                     ← notify View
 */

type EventHandle = (event: AgentReplStreamEvent, prevData: unknown) => unknown | null;
type EventCallback = (data: unknown, sessionId: string) => void;

/** 1 name → 1 handler (duplicate registration throws) */
const eventHandles: Record<string, EventHandle> = {};

/** Global store: data[name][sessionId] = handlerData */
const data: Record<string, Record<string, unknown>> = {};
if (typeof window !== "undefined") (window as any).__eventBusData = data;

/** 1 name → n callbacks */
const eventCallbacks: Record<string, Set<EventCallback>> = {};

/**
 * Register a named event handler.
 * The same name can only be registered once; duplicate registration throws an Error.
 * Typically called once in App.tsx.
 */
export function setEventHandle(name: string, handle: EventHandle): void {
  if (eventHandles[name]) {
    console.warn(`Event handle "${name}" already registered — overwriting`);
  }
  eventHandles[name] = handle;
  data[name] ??= {};
}

/**
 * Register a named callback.
 * The same name can have multiple callbacks (each View registers its own).
 * Returns an unsubscribe function, callable in a useEffect cleanup.
 */
export function addCallback(name: string, callback: EventCallback): () => void {
  if (!eventCallbacks[name]) {
    eventCallbacks[name] = new Set();
  }
  eventCallbacks[name].add(callback);
  return () => {
    eventCallbacks[name]?.delete(callback);
  };
}

/**
 * Get the data for a given handler under a specific session.
 * sessionId: session ID
 * key: handler name (e.g. "usage", "detail")
 */
export function getSessionData<T = unknown>(sessionId: string, key: string): T | null {
  return (data[key]?.[sessionId] as T) ?? null;
}

let started = false;
/** Start the underlying Tauri event listener (idempotent). Call once during app initialization. */
export function startStreamEventListener(): void {
  if (started) return;
  started = true;
  listenAgentReplEvents((event) => {
    for (const [name, handle] of Object.entries(eventHandles)) {
      const sessionId = event.sessionId;
      const prevData = data[name]?.[sessionId];
      const newData = handle(event, prevData);

      if (newData !== null) {
        data[name][sessionId] = newData;

        const cbs = eventCallbacks[name];
        if (cbs) {
          for (const cb of cbs) {
            cb(newData, sessionId);
          }
        }
      }
    }
  }).catch(() => {
    // silent
  });
}
