import {useEffect, useRef, useState} from "react";
import type {DagNode} from "../../types";

// System-level knobs are stored in `node.config.params` with this prefix
// (e.g. `system.python_path`). The System Config tab shows the key WITHOUT the
// prefix and re-adds it on save. This prefix is the hard boundary between
// system knobs (this tab) and run parameters (the Config tab) — it does NOT
// depend on the component's config_schema.
const SYSTEM_PREFIX = "system.";

export type SystemConfigFormProps = {
  node: DagNode;
  onChange: (node: DagNode) => void;
};

type SysPair = {id: string; key: string; value: string};

function readParams(node: DagNode): Record<string, unknown> {
  const config = node.config as Record<string, unknown> | undefined;
  const raw = config && config.params;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return {...(raw as Record<string, unknown>)};
  }
  return {};
}

// Only keys carrying the `system.` prefix belong here; display them stripped.
function pairsFrom(params: Record<string, unknown>): SysPair[] {
  return Object.entries(params)
    .filter(([k]) => k.startsWith(SYSTEM_PREFIX))
    .map(([k, value]) => ({
      id: crypto.randomUUID(),
      key: k.slice(SYSTEM_PREFIX.length),
      value: String(value ?? ""),
    }));
}

export function SystemConfigForm({node, onChange}: SystemConfigFormProps) {
  const [pairs, setPairs] = useState<SysPair[]>(() => pairsFrom(readParams(node)));
  // Keep the latest node so a commit in the Config tab (which owns run-param
  // keys) doesn't get clobbered when we re-read existing params here.
  const nodeRef = useRef(node);
  nodeRef.current = node;

  useEffect(() => {
    setPairs(pairsFrom(readParams(nodeRef.current)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  function commit(next: SysPair[]) {
    setPairs(next);
    const config =
      nodeRef.current.config && typeof nodeRef.current.config === "object"
        ? (nodeRef.current.config as Record<string, unknown>)
        : {};
    const existing =
      config.params && typeof config.params === "object"
        ? (config.params as Record<string, unknown>)
        : {};
    // Preserve run-param keys (owned by the Config tab) — they have no
    // `system.` prefix and must survive this commit untouched.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(existing)) {
      if (!k.startsWith(SYSTEM_PREFIX)) out[k] = v;
    }
    // Apply the system-config keys edited in this tab (re-prefixed).
    for (const p of next) {
      if (p.key.trim() !== "") out[SYSTEM_PREFIX + p.key.trim()] = p.value;
    }
    onChange({...nodeRef.current, config: {params: out}});
  }

  function update(p: SysPair, patch: Partial<SysPair>) {
    commit(pairs.map((x) => (x.id === p.id ? {...x, ...patch} : x)));
  }

  function remove(p: SysPair) {
    commit(pairs.filter((x) => x.id !== p.id));
  }

  function add() {
    commit([...pairs, {id: crypto.randomUUID(), key: "", value: ""}]);
  }

  return (
    <div className="system-config">
      <h4>系统配置</h4>
      {pairs.length === 0 && (
        <p className="system-config-empty">暂无系统配置，点击下方按钮新增。</p>
      )}
      {pairs.map((p) => (
        <div className="system-config-row" key={p.id}>
          <input
            className="instance-input"
            value={p.key}
            placeholder="key（如 python_path）"
            onChange={(e) => update(p, {key: e.target.value})}
          />
          <input
            className="instance-input"
            value={p.value}
            placeholder="value（如 ~/miniconda3/bin/python3.10）"
            onChange={(e) => update(p, {value: e.target.value})}
          />
          <button
            type="button"
            className="instance-freeform-del"
            aria-label="删除配置"
            onClick={() => remove(p)}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="generic-form-add" onClick={add}>
        + 新增系统配置
      </button>
    </div>
  );
}
