import { useEffect, useRef, useState, useCallback } from "react";
import type { RemoteProfile } from "../runtime";

interface TerminalTab {
  id: string;
  title: string;
  root: string;
}

interface Props {
  tabs: TerminalTab[];
  activeId: string | null;
  activeRemoteProfile: RemoteProfile | null;
  onClose: (id: string) => void;
  onSelect: (id: string) => void;
  onNewTab: () => void;
}

export function TerminalPanel({ tabs, activeId, activeRemoteProfile, onClose, onSelect, onNewTab }: Props) {
  if (tabs.length === 0) {
    return (
      <div className="terminal-empty">
        <p>No terminal open.</p>
        <button onClick={onNewTab}>Open terminal for current project</button>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-tab ${tab.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(tab.id)}
          >
            <span>{tab.title}</span>
            <button
              className="terminal-tab-close"
              onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="terminal-tab-add" onClick={onNewTab}>+</button>
      </div>
      <div className="terminal-body">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="terminal-instance"
            style={{ display: tab.id === activeId ? "block" : "none" }}
          >
            <TerminalInstance
              root={tab.root}
              remoteProfile={activeRemoteProfile}
              active={tab.id === activeId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function TerminalInstance({ root, remoteProfile, active }: { root: string; remoteProfile: RemoteProfile | null; active: boolean }) {
  if (remoteProfile) {
    return <RemoteTerminal root={root} remoteProfile={remoteProfile} active={active} />;
  }
  return <LocalTerminal root={root} active={active} />;
}

// ============ Local Terminal ============
function LocalTerminal({ root, active }: { root: string; active: boolean }) {
  const [lines, setLines] = useState<string[]>(["$ "]);
  const [input, setInput] = useState("");
  const outputRef = useRef<HTMLDivElement | null>(null);
  const termIdRef = useRef<string>("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    (async () => {
      try {
        const termId: string = await (window as any).__TAURI_INTERNALS__.invoke("pty_terminal_spawn", { root, cols: 80, rows: 24 });
        if (cancelled) return;
        termIdRef.current = termId;
        setLines(["$ "]);

        intervalRef.current = setInterval(async () => {
          try {
            const data: string | null = await (window as any).__TAURI_INTERNALS__.invoke("pty_terminal_read", { termId });
            if (data) {
              setLines((prev) => {
                const last = prev[prev.length - 1];
                const parts = data.split("\n");
                const next = [...prev.slice(0, -1), last + parts[0]];
                for (let i = 1; i < parts.length; i++) next.push(parts[i]);
                return next;
              });
            }
          } catch {}
        }, 100);
      } catch (e) {
        setLines((prev) => [...prev, `\x1b[31mFailed: ${e}\x1b[0m`]);
      }
    })();

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (termIdRef.current) {
        (window as any).__TAURI_INTERNALS__.invoke("pty_terminal_kill", { termId: termIdRef.current }).catch(() => {});
      }
    };
  }, [active, root]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines]);

  const sendInput = useCallback(() => {
    if (termIdRef.current) {
      (window as any).__TAURI_INTERNALS__.invoke("pty_terminal_input", { termId: termIdRef.current, data: input + "\n" });
      setLines((prev) => [...prev.slice(0, -1), prev[prev.length - 1] + input, ""]);
      setInput("");
    }
  }, [input]);

  return (
    <div className="terminal-instance-wrap" onClick={() => document.querySelector<HTMLInputElement>('.terminal-input')?.focus()}>
      <div className="terminal-output" ref={outputRef}>
        {lines.map((line, i) => (
          <pre key={i}>{line}</pre>
        ))}
      </div>
      <div className="terminal-input-line">
        <span className="terminal-prompt">$ </span>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendInput(); } }}
          className="terminal-input"
        />
      </div>
    </div>
  );
}

// ============ Remote Terminal ============
function RemoteTerminal({ root, remoteProfile, active }: { root: string; remoteProfile: RemoteProfile; active: boolean }) {
  const [lines, setLines] = useState<string[]>(["$ "]);
  const [input, setInput] = useState("");
  const outputRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!active) return;

    const proto = remoteProfile.baseUrl.startsWith("https") ? "wss" : "ws";
    const host = remoteProfile.baseUrl.replace(/^https?:\/\//, "");
    const ws = new WebSocket(`${proto}://${host}/terminal?root=${encodeURIComponent(root)}`);

    ws.onopen = () => setLines((prev) => [...prev, `\x1b[32mConnected\x1b[0m`]);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") {
        setLines((prev) => {
          const last = prev[prev.length - 1];
          const parts = (msg.data as string).split("\n");
          const next = [...prev.slice(0, -1), last + parts[0]];
          for (let i = 1; i < parts.length; i++) next.push(parts[i]);
          return next;
        });
      } else if (msg.type === "exit") {
        setLines((prev) => [...prev, `\n\x1b[33mExit: ${msg.code}\x1b[0m`]);
      }
    };
    ws.onclose = () => setLines((prev) => [...prev, "\x1b[31mDisconnected\x1b[0m"]);
    wsRef.current = ws;

    return () => { ws.close(); };
  }, [active, root, remoteProfile.baseUrl]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines]);

  const sendInput = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data: input + "\n" }));
      setLines((prev) => [...prev.slice(0, -1), prev[prev.length - 1] + input, ""]);
      setInput("");
    }
  }, [input]);

  return (
    <div className="terminal-instance-wrap">
      <div className="terminal-output" ref={outputRef}>
        {lines.map((line, i) => <pre key={i}>{line}</pre>)}
      </div>
      <div className="terminal-input-line">
        <span className="terminal-prompt">$ </span>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendInput(); } }}
          className="terminal-input"
        />
      </div>
    </div>
  );
}
