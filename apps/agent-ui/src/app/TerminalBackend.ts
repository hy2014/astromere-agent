import {invoke} from "@tauri-apps/api/core";
import {listen, type UnlistenFn} from "@tauri-apps/api/event";

// ── Abstract interface ──
export interface ITerminalBackend {
  spawn(id: string): Promise<void>;
  write(id: string, data: string): Promise<void>;
  kill(id: string): Promise<void>;
  onData(id: string, cb: (data: string) => void): UnlistenFn;
}

// ── Local backend (Tauri invoke + event) ──
export function createLocalBackend(): ITerminalBackend {
  const listeners = new Map<string, UnlistenFn>();

  return {
    async spawn(id: string) {
      await invoke("terminal_spawn", { id });
    },
    async write(id: string, data: string) {
      await invoke("terminal_write", { id, data });
    },
    async kill(id: string) {
      await invoke("terminal_kill", { id });
      listeners.get(id)?.();
      listeners.delete(id);
    },
    onData(id: string, cb: (data: string) => void): UnlistenFn {
      // Clean up old listener if exists
      listeners.get(id)?.();
      const eventName = `terminal:data:${id}`;
      const p = listen<string>(eventName, (event) => {
        cb(event.payload);
      });
      // Store for cleanup
      const unlisten = () => { p.then((fn) => fn()); };
      listeners.set(id, unlisten as unknown as UnlistenFn);
      return unlisten as unknown as UnlistenFn;
    },
  };
}

// ── Remote backend (WebSocket) ──
export function createRemoteBackend(baseUrl: string): ITerminalBackend {
  const sockets = new Map<string, WebSocket>();

  return {
    async spawn(id: string) {
      const ws = new WebSocket(`${baseUrl}/pty?sessionId=${encodeURIComponent(id)}`);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket connection failed"));
      });

      sockets.set(id, ws);
    },
    async write(id: string, data: string) {
      const ws = sockets.get(id);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },
    async kill(id: string) {
      const ws = sockets.get(id);
      if (ws) {
        ws.close();
        sockets.delete(id);
      }
    },
    onData(id: string, cb: (data: string) => void): UnlistenFn {
      const ws = sockets.get(id);
      if (!ws) return () => {};

      const handler = (event: MessageEvent) => {
        if (typeof event.data === "string") {
          cb(event.data);
        } else if (event.data instanceof Blob) {
          event.data.text().then(cb);
        }
      };
      ws.addEventListener("message", handler);

      return () => {
        ws.removeEventListener("message", handler);
      };
    },
  };
}
