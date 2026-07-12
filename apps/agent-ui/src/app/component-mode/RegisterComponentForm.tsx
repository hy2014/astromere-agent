import {useState} from "react";
import type {Component, ConfigFieldBaseType, ConfigSchemaItem, PortDef, PortType} from "../../types";
import {
  assembleRegisterComponent,
  assembleUpdateComponent,
  buildSchemaType,
  canSubmitRegister,
  isListType,
  parseConfigSchema,
  portsToSchema,
  schemaToPorts,
  validateConfigSchemaDef,
  type RegisterComponentInput,
} from "./componentModel";

function makeUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type RegisterComponentFormProps = {
  onRegister: (component: Component) => void;
  onCancel: () => void;
  // When provided, the form opens in **edit mode**: it is pre-filled from this
  // component and submits via `onUpdate` (writing back to the same id), instead
  // of creating a new one. The kebab "修改" menu in the sidebar list opens it.
  editing?: Component;
  onUpdate?: (component: Component) => void;
  // When provided, the form opens in **view mode**: pre-filled from this
  // component, all fields read-only, no save action. The kebab "查看" menu in
  // the sidebar list opens it. Mutually exclusive with `editing`.
  viewing?: Component;
};

// Registers a *new* reusable component (or edits / views an existing one when
// `editing` / `viewing` is set). This form lives in the right-hand properties
// panel (opened via the "注册组件" button, or a component's kebab "修改" /
// "查看"), NOT inline inside the sidebar accordion. A created component is
// always `global: true` — that is what makes it appear in the sidebar list and
// be reusable across DAGs.
export function RegisterComponentForm({onRegister, onCancel, editing, onUpdate, viewing}: RegisterComponentFormProps) {
  // `viewing` and `editing` are mutually exclusive; derive a single pre-fill
  // source + a read-only flag so the JSX below stays uniform.
  const source = editing ?? viewing ?? null;
  const readOnly = !!viewing;

  const [name, setName] = useState(source ? source.name : "");
  const [description, setDescription] = useState(source ? source.description : "");
  const [gitUrl, setGitUrl] = useState(source ? source.gitUrl : "");
  const [gitBranch, setGitBranch] = useState(source ? source.gitBranch : "");
  const [gitRef, setGitRef] = useState(source ? source.gitRef : "");
  const [entryPoint, setEntryPoint] = useState(source ? source.entryPoint : "");
  const [configSchema, setConfigSchema] = useState<ConfigSchemaItem[]>(
    source ? parseConfigSchema(source.configSchema) : [],
  );
  const [inputPorts, setInputPorts] = useState<PortDef[]>(
    source ? schemaToPorts(source.inputSchema) : [],
  );
  const [outputPorts, setOutputPorts] = useState<PortDef[]>(
    source ? schemaToPorts(source.outputSchema) : [],
  );

  const input: RegisterComponentInput = {
    name,
    description,
    gitUrl,
    gitBranch,
    gitRef,
    entryPoint,
    configSchema,
    inputPorts,
    outputPorts,
  };
  const defErrors = validateConfigSchemaDef(configSchema);
  const canSubmit = canSubmitRegister(input) && Object.keys(defErrors).length === 0;

  function updateSchemaItem(index: number, patch: Partial<ConfigSchemaItem>) {
    setConfigSchema((prev) => prev.map((item, i) => (i === index ? {...item, ...patch} : item)));
  }

  function updateSchemaType(index: number, base: ConfigFieldBaseType | "list", element: ConfigFieldBaseType) {
    updateSchemaItem(index, {type: buildSchemaType(base, element)});
  }

  function updateSchemaEnum(index: number, raw: string) {
    const enumValues = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    updateSchemaItem(index, {enum: enumValues});
  }

  function addSchemaItem() {
    setConfigSchema((prev) => [...prev, {key: "", label: "", type: "string", required: false}]);
  }

  function removeSchemaItem(index: number) {
    setConfigSchema((prev) => prev.filter((_, i) => i !== index));
  }

  // ─── IO port editors (default type = "file") ─────────────────────────────
  function addPort(list: "inputs" | "outputs") {
    const setter = list === "inputs" ? setInputPorts : setOutputPorts;
    const prefix = list === "inputs" ? "in" : "out";
    setter((prev) => [...prev, {name: `${prefix}${prev.length + 1}`, type: "file"}]);
  }

  function updatePort(list: "inputs" | "outputs", index: number, patch: Partial<PortDef>) {
    const setter = list === "inputs" ? setInputPorts : setOutputPorts;
    setter((prev) => prev.map((item, i) => (i === index ? {...item, ...patch} : item)));
  }

  function removePort(list: "inputs" | "outputs", index: number) {
    const setter = list === "inputs" ? setInputPorts : setOutputPorts;
    setter((prev) => prev.filter((_, i) => i !== index));
  }

  function submit() {
    if (readOnly || !canSubmit) return;
    if (editing && onUpdate) {
      onUpdate(assembleUpdateComponent(input, editing, Date.now()));
    } else {
      onRegister(assembleRegisterComponent(input, makeUuid(), Date.now()));
    }
  }

  return (
    <div className="register-page">
      <h2>{readOnly ? "查看组件" : editing ? "修改组件" : "注册组件"}</h2>
      <p className="register-sub">
        {readOnly
          ? "以下为该组件的只读定义，如需改动请点击「修改」。"
          : editing
            ? "修改后保存到同一个组件，所有引用它的 DAG 自动跟随新定义。"
            : "填写 Git 信息与执行入口，注册后可在多个 DAG 中复用。"}
      </p>

      {/* In view mode the whole form is disabled; in edit/create mode it is live. */}
      <fieldset className="generic-form" disabled={readOnly}>
        <label className="generic-form-field">
          <span>组件名称</span>
          <input
            autoFocus
            value={name}
            placeholder="组件名称"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="generic-form-field">
          <span>描述</span>
          <input
            value={description}
            placeholder="可选"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <label className="generic-form-field">
          <span>Git 地址</span>
          <input
            value={gitUrl}
            placeholder="git@github.com:org/repo.git"
            onChange={(event) => setGitUrl(event.target.value)}
          />
        </label>

        <label className="generic-form-field">
          <span>分支</span>
          <input
            value={gitBranch}
            placeholder="master（留空默认 master）"
            onChange={(event) => setGitBranch(event.target.value)}
          />
        </label>

        <label className="generic-form-field">
          <span>Git Ref（可选，tag/分支）</span>
          <input
            value={gitRef}
            placeholder="如 v1.2.3"
            onChange={(event) => setGitRef(event.target.value)}
          />
        </label>

        <label className="generic-form-field">
          <span>执行入口 (entry point)</span>
          <input
            value={entryPoint}
            placeholder="run.py"
            onChange={(event) => setEntryPoint(event.target.value)}
          />
        </label>

        <div className="generic-form-schema-section">
          <div className="generic-form-porthead">
            <span>配置项声明 (config_schema)</span>
            {!readOnly && (
              <button type="button" className="generic-form-add" onClick={addSchemaItem}>
                + 参数
              </button>
            )}
          </div>
          {configSchema.length === 0 && (
            <p className="generic-form-empty">暂无声明；在此声明组件对外暴露的参数。</p>
          )}
          {configSchema.map((item, i) => {
            const listType = isListType(item.type) ? item.type : null;
            const base: ConfigFieldBaseType | "list" = listType
              ? "list"
              : (item.type as ConfigFieldBaseType);
            const element = listType ? listType.element : "string";
            return (
              <div className="generic-form-schemaitem" key={i}>
                <div className="generic-form-schemarow">
                  <input
                    className="generic-form-portname"
                    value={item.key}
                    placeholder="key（与 run.py 入参一致）"
                    onChange={(event) => updateSchemaItem(i, {key: event.target.value})}
                  />
                  <input
                    className="generic-form-portname"
                    value={item.label}
                    placeholder="展示名"
                    onChange={(event) => updateSchemaItem(i, {label: event.target.value})}
                  />
                  <select
                    value={base}
                    onChange={(event) =>
                      updateSchemaType(i, event.target.value as ConfigFieldBaseType | "list", element)
                    }
                  >
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                    <option value="enum">enum</option>
                    <option value="path">path</option>
                    <option value="date">date</option>
                    <option value="list">list</option>
                  </select>
                  {base === "list" && (
                    <select
                      value={element}
                      onChange={(event) =>
                        updateSchemaType(i, "list", event.target.value as ConfigFieldBaseType)
                      }
                      title="元素类型"
                    >
                      <option value="string">string</option>
                      <option value="number">number</option>
                      <option value="boolean">boolean</option>
                      <option value="enum">enum</option>
                      <option value="path">path</option>
                      <option value="date">date</option>
                    </select>
                  )}
                  <label className="generic-form-req" title="是否必填">
                    <input
                      type="checkbox"
                      checked={item.required}
                      onChange={(event) => updateSchemaItem(i, {required: event.target.checked})}
                    />
                    必填
                  </label>
                  {!readOnly && (
                    <button
                      type="button"
                      className="generic-form-del"
                      onClick={() => removeSchemaItem(i)}
                      aria-label="删除参数声明"
                    >
                      ×
                    </button>
                  )}
                </div>
                {base === "enum" && (
                  <input
                    className="generic-form-portname generic-form-enum"
                    value={(item.enum ?? []).join(", ")}
                    placeholder="枚举选项（逗号分隔）"
                    onChange={(event) => updateSchemaEnum(i, event.target.value)}
                  />
                )}
                <input
                  className="generic-form-portname"
                  value={item.description ?? ""}
                  placeholder="描述（可选）"
                  onChange={(event) =>
                    updateSchemaItem(i, {description: event.target.value || undefined})
                  }
                />
                {defErrors[i] && <p className="generic-form-schemaerr">{defErrors[i]}</p>}
              </div>
            );
          })}
        </div>

        <div className="generic-form-schema-section">
          <div className="generic-form-porthead">
            <span>输入</span>
            {!readOnly && (
              <button type="button" className="generic-form-add" onClick={() => addPort("inputs")}>
                + 输入
              </button>
            )}
          </div>
          {inputPorts.map((port, i) => (
            <div className="generic-form-portrow" key={i}>
              <input
                className="generic-form-portname"
                value={port.name}
                placeholder="名称"
                onChange={(event) => updatePort("inputs", i, {name: event.target.value})}
              />
              <select
                value={port.type}
                onChange={(event) => updatePort("inputs", i, {type: event.target.value as PortType})}
              >
                <option value="file">file</option>
                <option value="csv">csv</option>
                <option value="parquet">parquet</option>
              </select>
              {!readOnly && (
                <button
                  type="button"
                  className="generic-form-del"
                  onClick={() => removePort("inputs", i)}
                  aria-label="删除输入端口"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="generic-form-schema-section">
          <div className="generic-form-porthead">
            <span>输出</span>
            {!readOnly && (
              <button type="button" className="generic-form-add" onClick={() => addPort("outputs")}>
                + 输出
              </button>
            )}
          </div>
          {outputPorts.map((port, i) => (
            <div className="generic-form-portrow" key={i}>
              <input
                className="generic-form-portname"
                value={port.name}
                placeholder="名称"
                onChange={(event) => updatePort("outputs", i, {name: event.target.value})}
              />
              <select
                value={port.type}
                onChange={(event) => updatePort("outputs", i, {type: event.target.value as PortType})}
              >
                <option value="file">file</option>
                <option value="csv">csv</option>
                <option value="parquet">parquet</option>
              </select>
              {!readOnly && (
                <button
                  type="button"
                  className="generic-form-del"
                  onClick={() => removePort("outputs", i)}
                  aria-label="删除输出端口"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      </fieldset>

      <div className="properties-config-actions">
        <div className="fn-register-actions">
          <button type="button" className="fn-register-cancel" onClick={onCancel}>
            {readOnly ? "关闭" : "取消"}
          </button>
          {!readOnly && (
            <button
              type="button"
              className="fn-register-submit"
              disabled={!canSubmit}
              onClick={submit}
            >
              {editing ? "保存修改" : "注册"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
