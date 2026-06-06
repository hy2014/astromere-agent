import { listenAgentReplEvents } from "../runtime";
import type { AgentReplStreamEvent } from "../types";

/**
 * 纯事件广播层。
 *
 * 对整个应用只调用一次 listenAgentReplEvents，所有组件通过 onStreamEvent
 * 订阅同一个事件流。
 */

type EventHandler = (event: AgentReplStreamEvent) => void;
const handlers = new Set<EventHandler>();

export function onStreamEvent(handler: EventHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

let started = false;
/** 启动底层 Tauri 事件监听（幂等）。应用初始化时调用一次即可。 */
export function startStreamEventListener(): void {
  if (started) return;
  started = true;
  listenAgentReplEvents((event) => {
    for (const handler of handlers) {
      handler(event);
    }
  }).catch(() => {
    // silent — listenAgentReplEvents failures are logged by Tauri layer
  });
}
