import {useEffect, useState} from "react";
import type {Component, ConfigSchemaItem, DagNode} from "../../types";
import {isListType, validateInstanceConfig} from "./componentModel";

export type InstanceConfigFormProps = {
  node: DagNode;
  component: Component;
  onChange: (node: DagNode) => void;
};

type InstanceValues = Record<string, unknown>;

type FreePair = {id: string; key: string; value: string};

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
    return {...(raw as InstanceValues)};
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

// Renders the *instance* configuration form for a node: one control per
// declared parameter in the component's config_schema, with value stored in
// `node.config.params` (node-level, not the component definition). Validates
// required/type and surfaces inline errors. Components without a schema (e.g.
// non-global) get a free-form key/value editor instead.
export function InstanceConfigForm({node, component, onChange}: InstanceConfigFormProps) {
  const schema = component.configSchema ?? [];
  const [values, setValues] = useState<InstanceValues>(() => readParams(node));

  // Re-sync when a *different* node is selected (not on every keystroke).
  useEffect(() => {
    setValues(readParams(node));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const errors = validateInstanceConfig(schema, values);
  const hasErrors = Object.keys(errors).length > 0;

  function commit(next: InstanceValues) {
    setValues(next);
    const config = (node.config && typeof node.config === "object" ? node.config : {}) as Record<
      string,
      unknown
    >;
    const updated: DagNode = {
      ...node,
      // Persist ONLY the instance params. Any legacy git/IO/name keys that an
      // older build wrote into node.config are dropped here, keeping the live
      // node config a pure instance payload (source of truth for metadata is
      // the components table).
      config: {params: next},
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
    </div>
  );
}
