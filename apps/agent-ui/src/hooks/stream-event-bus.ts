import { listenAgentReplEvents } from "../runtime";
import type { AgentReplStreamEvent } from "../types";

/**
 * 纯事件广播层。
 *
 * 对整个应用只调用一次 listenAgentReplEvents。
 *
 * ── 数据流 ──
 *
 *   App.tsx:
 *     setEventHandle("session", handleSessionEvent)   // 每个 name 只能注册一次
 *     setEventHandle("usage", handleUsageEvent)
 *
 *   View mount:
 *     addCallback("session", (data) => ...)            // 多个 View 可注册多个 callback
 *     addCallback("session", (data) => ...)
 *
 *   Tauri 事件:
 *     dispatch(event)
 *       └─ for each name,
 *            handle(event) → { sessionId, data }
 *              ├─ data[name][sessionId] = data         ← 全局 store
 *              └─ for each callback of name:
 *                   callback(data)                     ← 通知 View
 */

// ── 旧版（逐步取消） ──

type EventHandler = (event: AgentReplStreamEvent) => void;
const oldHandlers = new Set<EventHandler>();

export function onStreamEvent(handler: EventHandler): () => void {
  oldHandlers.add(handler);
  return () => { oldHandlers.delete(handler); };
}

// ── 新版 ──

type EventHandle = (event: AgentReplStreamEvent, prevData: unknown) => unknown | null;
type EventCallback = (data: unknown, sessionId: string) => void;

/** 1 name → 1 handler（重复注册报错） */
const eventHandles: Record<string, EventHandle> = {};

/** 全局 store: data[name][sessionId] = handlerData */
const data: Record<string, Record<string, unknown>> = {};

/** 1 name → n callbacks */
const eventCallbacks: Record<string, Set<EventCallback>> = {};

/**
 * 注册一个命名事件处理器。
 * 同一个 name 只能注册一次，重复注册会 throw Error。
 * 通常在 App.tsx 中调用一次。
 */
export function setEventHandle(name: string, handle: EventHandle): void {
  if (eventHandles[name]) {
    throw new Error(`Event handle "${name}" already registered`);
  }
  eventHandles[name] = handle;
  data[name] = {};
}

/**
 * 注册一个命名回调。
 * 同一个 name 可以有多个 callback（不同 View 各自注册）。
 * 返回 unsubscribe 函数，可在 useEffect cleanup 中调用。
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
 * 获取某个 session 下指定 handler 的数据。
 * sessionId: 会话 ID
 * key: handler name（如 "usage"、"detail"）
 */
export function getSessionData<T = unknown>(sessionId: string, key: string): T | null {
  return (data[key]?.[sessionId] as T) ?? null;
}

let started = false;
/** 启动底层 Tauri 事件监听（幂等）。应用初始化时调用一次即可。 */
export function startStreamEventListener(): void {
  if (started) return;
  started = true;
  listenAgentReplEvents((event) => {
    // 旧版（逐步取消）
    for (const handler of oldHandlers) {
      handler(event);
    }

    // 新版：handle(event, prevData) → newData | null
    for (const [name, handle] of Object.entries(eventHandles)) {
      const sessionId = event.sessionId;
      const prevData = data[name]?.[sessionId];
      const newData = handle(event, prevData);

      let currentData: unknown;
      if (newData !== null) {
        data[name][sessionId] = newData;
        currentData = newData;
      } else {
        currentData = prevData;
      }

      const cbs = eventCallbacks[name];
      if (cbs) {
        for (const cb of cbs) {
          cb(currentData, sessionId);
        }
      }
    }
  }).catch(() => {
    // silent
  });
}
