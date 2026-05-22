import React, { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { createLocalBackend, createRemoteBackend, type ITerminalBackend } from "./TerminalBackend";

interface TerminalTab {
  id: string;
  title: string;
  term: XTerm;
  unlisten: (() => void) | null;
}

interface TerminalRemoteProps {
  onClose: () => void;
  /** baseUrl of the remote proxy, e.g. "http://127.0.0.1:7421". If null, use local. */
  remoteBaseUrl: string | null;
}

export function TerminalRemoteView({ onClose, remoteBaseUrl }: TerminalRemoteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Map<string, TerminalTab>>(new Map());
  const backendRef = useRef<ITerminalBackend | null>(null);
  const [tabs, setTabs] = useState<{ id: string; title: string }[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const initializedRef = useRef(false);

  // Lazy-init backend once
  const getBackend = useCallback((): ITerminalBackend => {
    if (!backendRef.current) {
      backendRef.current = remoteBaseUrl
        ? createRemoteBackend(remoteBaseUrl)
        : createLocalBackend();
    }
    return backendRef.current;
  }, [remoteBaseUrl]);

  const createTerminal = useCallback(async () => {
    const backend = getBackend();
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const title = `Terminal ${tabs.length + 1}`;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#1a1b1e",
        foreground: "#e0e0e0",
        cursor: "#e0e0e0",
        selectionBackground: "#3a3d41",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    try {
      await backend.spawn(id);
    } catch (e) {
      console.error("[terminal] spawn failed:", e);
      term.write(`\r\n[Error: ${e}]\r\n`);
      return;
    }

    const unlisten = backend.onData(id, (data: string) => {
      term.write(data);
    });

    term.onData((data) => {
      backend.write(id, data).catch((e) =>
        console.error("[terminal] write error:", e)
      );
    });

    tabsRef.current.set(id, { id, title, term, unlisten });
    setTabs((prev) => [...prev, { id, title }]);
    setActiveTabId(id);
  }, [tabs.length, getBackend]);

  const closeTerminal = useCallback(
    async (id: string) => {
      const backend = getBackend();
      await backend.kill(id);
      const tab = tabsRef.current.get(id);
      if (tab) {
        tab.unlisten?.();
        tab.term.dispose();
        tabsRef.current.delete(id);
      }
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id && next.length > 0) {
          setActiveTabId(next[next.length - 1].id);
        } else if (next.length === 0) {
          setActiveTabId(null);
        }
        return next;
      });
    },
    [activeTabId, getBackend]
  );

  useEffect(() => {
    if (!activeTabId || !containerRef.current) return;
    const tab = tabsRef.current.get(activeTabId);
    if (!tab) return;
    const container = containerRef.current;
    container.innerHTML = "";
    tab.term.open(container);
    setTimeout(() => {
      try { fitAddonRef.current?.fit(); tab.term.focus(); } catch (_) {}
    }, 50);
    if (resizeObserverRef.current) resizeObserverRef.current.disconnect();
    resizeObserverRef.current = new ResizeObserver(() => {
      try { fitAddonRef.current?.fit(); } catch (_) {}
    });
    resizeObserverRef.current.observe(container);
    return () => { resizeObserverRef.current?.disconnect(); };
  }, [activeTabId]);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      createTerminal();
    }
    return () => {
      const backend = backendRef.current;
      tabsRef.current.forEach((tab) => {
        tab.unlisten?.();
        backend?.kill(tab.id).catch(() => {});
        tab.term.dispose();
      });
      tabsRef.current.clear();
    };
  }, []);

  return (
    <div className="terminal-view">
      <div className="terminal-tabs-bar">
        <div className="terminal-tabs">
          {tabs.map((tab) => (
            <div key={tab.id} className={`terminal-tab ${tab.id === activeTabId ? "active" : ""}`} onClick={() => setActiveTabId(tab.id)}>
              <span>{tab.title}</span>
              <button className="terminal-tab-close" onClick={(e) => { e.stopPropagation(); closeTerminal(tab.id); }}>×</button>
            </div>
          ))}
        </div>
        <button className="terminal-new-tab" onClick={createTerminal}>+</button>
      </div>
      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}
