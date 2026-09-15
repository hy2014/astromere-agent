import {useEffect, useRef, useState} from "react";
import type {Component, ConfigSchemaItem, DagNode, PortDef} from "../../types";
import {isListType, schemaToPorts, validateInstanceConfig} from "./componentModel";

export type InstanceConfigFormProps = {
  node: DagNode;
  component: Component;
  onChange: (node: DagNode) => void;
};

type InstanceValues = Record<string, unknown>;

type FreePair = {id: string; key: string; value: string};

// System-level knobs are stored with the `system.` prefix (see SystemConfigForm)
// and owned by the System Config tab; this tab only manages run parameters (no prefix).
const SYSTEM_PREFIX = "system.";
// DW registration knobs (`dw.enabled` / `dw.port` / `dw.table`) are owned by the
// "注册到DW" section below; the run-param editors must not touch them.
const DW_PREFIX = "dw.";
// Table-name whitelist enforced here (UX) and again by the runner (safety).
const DW_TABLE_RE = /^[A-Za-z0-9_-]+$/;

function pairsFromValues(values: InstanceValues): FreePair[] {
  return Object.entries(values).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value: String(value ?? ""),
  }));
}

function readParams(node: DagNode): InstanceValues {
  const config = node.config as Record<string, unknown> | undefined;
  const raw = config && config.params;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const all = raw as Record<string, unknown>;
    const out: InstanceValues = {};
    // Drop `system.*` and `dw.*` keys — those belong to other UI sections.
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(SYSTEM_PREFIX) && !k.startsWith(DW_PREFIX)) out[k] = v;
    }
    return out;
  }
  return {};
}

// Free-form key/value editor for components with no declared schema (e.g.
// non-global / generic components). Values are written to `node.config.params`.
function FreeFormParams({
  values,
  nodeId,
  onChange,
}: {
  values: InstanceValues;
  nodeId: string;
  onChange: (next: InstanceValues) => void;
}) {
  const [pairs, setPairs] = useState<FreePair[]>(() => pairsFromValues(values));

  // Re-sync only when a *different* node is selected (not on every keystroke,
  // which would steal focus).
  useEffect(() => {
    setPairs(pairsFromValues(values));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  function commit(next: FreePair[]) {
    setPairs(next);
    const out: InstanceValues = {};
    for (const p of next) {
      if (p.key.trim() !== "") out[p.key.trim()] = p.value;
    }
    onChange(out);
  }

  return (
    <div className="instance-freeform">
      {pairs.map((p) => (
        <div className="instance-freeform-row" key={p.id}>
          <input
            className="instance-input"
            value={p.key}
            placeholder="key"
            onChange={(e) =>
              commit(pairs.map((x) => (x.id === p.id ? {...x, key: e.target.value} : x)))
            }
          />
          <input
            className="instance-input"
            value={p.value}
            placeholder="value"
            onChange={(e) =>
              commit(pairs.map((x) => (x.id === p.id ? {...x, value: e.target.value} : x)))
            }
          />
          <button
            type="button"
            className="instance-freeform-del"
            aria-label="删除参数"
            onClick={() => commit(pairs.filter((x) => x.id !== p.id))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="generic-form-add"
        onClick={() => commit([...pairs, {id: crypto.randomUUID(), key: "", value: ""}])}
      >
        + 新增运行参数
      </button>
    </div>
  );
}

// Render the right control for a declared parameter, wired to the instance
// value map. `onChange` commits the new value for `item.key`.
function controlFor(
  item: ConfigSchemaItem,
  value: unknown,
  onChange: (next: unknown) => void,
) {
  const listType = isListType(item.type) ? item.type : null;
  const base = listType ? listType.element : (item.type as string);

  if (listType) {
    const text = Array.isArray(value) ? (value as unknown[]).join(", ") : "";
    return (
      <input
        className="instance-input"
        value={text}
        placeholder={`逗号分隔的 ${base} 列表`}
        onChange={(event) =>
          onChange(
            event.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s !== ""),
          )
        }
      />
    );
  }

  switch (base) {
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      );
    case "enum":
      return (
        <select
          className="instance-input"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">— 请选择 —</option>
          {(item.enum ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case "number":
      return (
        <input
          className="instance-input"
          type="number"
          value={value === "" || value === undefined || value === null ? "" : String(value)}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") return onChange("");
            const num = Number(raw);
            onChange(Number.isNaN(num) ? raw : num);
          }}
        />
      );
    case "date":
      return (
        <input
          className="instance-input"
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "path":
      return (
        <input
          className="instance-input"
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder="文件或目录路径"
          onChange={(event) => onChange(event.target.value)}
        />
      );
    default:
      return (
        <input
          className="instance-input"
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

// "注册到DW" section: registers one output port of this node into the data
// warehouse. Values live in `node.config.params` under the `dw.` prefix
// (`dw.enabled` / `dw.port` / `dw.table`) so they never mix with run params
// (a source node's params are forwarded verbatim to downstream inputs).
// Reads/writes the *freshest* node so run-param edits never get clobbered.
function DwSection({
  node,
  ports,
  onChange,
}: {
  node: DagNode;
  ports: PortDef[];
  onChange: (n: DagNode) => void;
}) {
  const nodeRef = useRef(node);
  nodeRef.current = node;

  function readDw(): {enabled: boolean; port: string; table: string} {
    const config = nodeRef.current.config as Record<string, unknown> | undefined;
    const params =
      config && config.params && typeof config.params === "object"
        ? (config.params as Record<string, unknown>)
        : {};
    return {
      enabled: params["dw.enabled"] === true,
      port: typeof params["dw.port"] === "string" ? (params["dw.port"] as string) : "",
      table: typeof params["dw.table"] === "string" ? (params["dw.table"] as string) : "",
    };
  }

  const [dw, setDw] = useState(readDw);

  // Re-sync when a *different* node is selected.
  useEffect(() => {
    setDw(readDw());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  function commit(patch: Partial<{enabled: boolean; port: string; table: string}>) {
    const next = {...dw, ...patch};
    setDw(next);
    const config =
      nodeRef.current.config && typeof nodeRef.current.config === "object"
        ? (nodeRef.current.config as Record<string, unknown>)
        : {};
    const existing =
      config.params && typeof config.params === "object"
        ? (config.params as Record<string, unknown>)
        : {};
    const updated: DagNode = {
      ...nodeRef.current,
      config: {
        params: {
          ...existing,
          "dw.enabled": next.enabled,
          "dw.port": next.port,
          "dw.table": next.table,
        },
      },
    };
    onChange(updated);
  }

  const tableErr =
    dw.enabled && dw.table.trim() !== "" && !DW_TABLE_RE.test(dw.table.trim())
      ? "表名仅允许字母、数字、下划线和连字符"
      : undefined;
  const portErr = dw.enabled && dw.port === "" ? "请选择要注册的输出端口" : undefined;
  const tableEmptyErr = dw.enabled && dw.table.trim() === "" ? "请填写表名" : undefined;
  const error = tableErr ?? portErr ?? tableEmptyErr;

  return (
    <div className="instance-config instance-dw">
      <h4>注册到DW</h4>
      <div className="instance-field">
        <label className="instance-label instance-dw-toggle">
          <input
            type="checkbox"
            checked={dw.enabled}
            onChange={(e) => commit({enabled: e.target.checked})}
          />
          <span>将输出端口写入数据仓库（{`{dw_root}/{表名}/`}）</span>
        </label>
      </div>
      {dw.enabled && (
        <>
          <div className="instance-field">
            <label className="instance-label">
              <span>输出端口</span>
              <span className="instance-desc">该端口的数据文件将直接写入 DW 表目录</span>
            </label>
            <select
              className="instance-input"
              value={dw.port}
              onChange={(e) => commit({port: e.target.value})}
            >
              <option value="">— 请选择 —</option>
              {ports.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.format ? ` (${p.format})` : ""}
                </option>
              ))}
            </select>
            {portErr && <p className="instance-error">{portErr}</p>}
          </div>
          <div className="instance-field">
            <label className="instance-label">
              <span>表名（dw_table）</span>
              <span className="instance-desc">仅字母/数字/下划线/连字符</span>
            </label>
            <input
              className="instance-input"
              type="text"
              value={dw.table}
              placeholder="例如 my_features"
              onChange={(e) => commit({table: e.target.value})}
            />
            {(tableErr ?? tableEmptyErr) && (
              <p className="instance-error">{tableErr ?? tableEmptyErr}</p>
            )}
          </div>
        </>
      )}
      {error && <p className="instance-gate-warning">DW 配置有误，运行或发布前请先修正。</p>}
    </div>
  );
}

// Renders the *instance* configuration form for a node: one control per
// declared parameter in the component's config_schema, with value stored in
// `node.config.params` (node-level, not the component definition). Validates
// required/type and surfaces inline errors. Components without a schema (e.g.
// non-global) get a free-form key/value editor instead.
export function InstanceConfigForm({node, component, onChange}: InstanceConfigFormProps) {
  const schema = component.configSchema ?? [];
  const [values, setValues] = useState<InstanceValues>(() => readParams(node));
  // DW-eligible ports: file (data) ports only — status ports carry no data.
  const dwPorts = schemaToPorts(component.outputSchema).filter((p) => p.type === "file");
  // Keep the latest node so a commit here never clobbers keys owned by the
  // System Config tab (e.g. `system.python_path`): when we re-read existing
  // params we use the freshest node, not the one captured at mount.
  const nodeRef = useRef(node);
  nodeRef.current = node;

  // Re-sync when a *different* node is selected (not on every keystroke).
  useEffect(() => {
    setValues(readParams(node));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const errors = validateInstanceConfig(schema, values);
  const hasErrors = Object.keys(errors).length > 0;

  function commit(next: InstanceValues) {
    setValues(next);
    const config =
      nodeRef.current.config && typeof nodeRef.current.config === "object"
        ? (nodeRef.current.config as Record<string, unknown>)
        : {};
    const existing =
      config.params && typeof config.params === "object"
        ? (config.params as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {};
    // Preserve system-level knobs (owned by the System Config tab, stored with
    // the `system.` prefix) and DW knobs (owned by the 注册到DW section, `dw.`
    // prefix) so this tab never clobbers them.
    for (const [k, v] of Object.entries(existing)) {
      if (k.startsWith(SYSTEM_PREFIX) || k.startsWith(DW_PREFIX)) out[k] = v;
    }
    // Preserve any other legacy run params this tab does not enumerate (the
    // structured schema view only lists declared keys; free-form mode already
    // includes them in `next`).
    for (const [k, v] of Object.entries(existing)) {
      if (
        !k.startsWith(SYSTEM_PREFIX) &&
        !k.startsWith(DW_PREFIX) &&
        !schema.some((s) => s.key === k) &&
        !(k in next)
      ) {
        out[k] = v;
      }
    }
    // Overlay the run-param values edited in this tab.
    Object.assign(out, next);
    const updated: DagNode = {
      ...nodeRef.current,
      // Persist the instance params. Any legacy git/IO/name keys that an older
      // build wrote into node.config are dropped here, keeping the live node
      // config a pure instance payload (source of truth for metadata is the
      // components table).
      config: {params: out},
    };
    onChange(updated);
  }

  function setField(key: string, next: unknown) {
    commit({...values, [key]: next});
  }

  if (schema.length === 0) {
    return (
      <div className="instance-config">
        <h4>运行参数</h4>
        <FreeFormParams values={values} nodeId={node.id} onChange={commit} />
        {dwPorts.length > 0 && (
          <DwSection node={node} ports={dwPorts} onChange={onChange} />
        )}
      </div>
    );
  }

  return (
    <div className="instance-config">
        <h4>运行参数</h4>
        {schema.map((item) => {
        const err = errors[item.key];
        return (
          <div className="instance-field" key={item.key}>
            <label className="instance-label">
              <span>
                {item.label || item.key}
                {item.required && <span className="instance-required"> *</span>}
              </span>
              {item.description && <span className="instance-desc">{item.description}</span>}
            </label>
            {controlFor(item, values[item.key], (next) => setField(item.key, next))}
            {err && <p className="instance-error">{err}</p>}
          </div>
        );
      })}
      {hasErrors && (
        <p className="instance-gate-warning">存在必填/类型错误，运行或发布前请先修正。</p>
      )}
      {dwPorts.length > 0 && <DwSection node={node} ports={dwPorts} onChange={onChange} />}
    </div>
  );
}
