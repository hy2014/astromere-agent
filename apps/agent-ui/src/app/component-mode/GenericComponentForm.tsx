import {useEffect, useState} from "react";
import type {Component, GenericComponentConfig, PortDef} from "../../types";
import {componentToConfig, configToComponent} from "./componentModel";

export type GenericComponentFormProps = {
  component: Component;
  onChange: (component: Component) => void;
};

// Edits the *component* definition shown in a node's 配置 tab: name / git /
// branch / ref / IO ports / entry point. It does NOT edit the parameter schema
// (`config_schema`) — that is declared only at registration time in
// `RegisterComponentForm` (schema is a global/registered-component concept).
// Any existing `config_schema` on the component is passed through untouched, so
// editing a registered component's git/name here never wipes its declarations.
// Free-form instance parameters live in `node.config.params` (see
// `InstanceConfigForm`). Changes are persisted by the parent via `updateComponent`.
export function GenericComponentForm({component, onChange}: GenericComponentFormProps) {
  const [cfg, setCfg] = useState<GenericComponentConfig>(() => componentToConfig(component));

  // Re-sync local state when a *different* component is selected (not on every
  // keystroke — that would steal focus).
  useEffect(() => {
    setCfg(componentToConfig(component));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id]);

  function commit(nextCfg: GenericComponentConfig) {
    setCfg(nextCfg);
    onChange(configToComponent(component, nextCfg));
  }

  function updatePort(list: "inputs" | "outputs", index: number, patch: Partial<PortDef>) {
    const next = cfg[list].map((item, i) => (i === index ? {...item, ...patch} : item));
    commit({...cfg, [list]: next});
  }

  function addPort(list: "inputs" | "outputs") {
    const prefix = list === "inputs" ? "in" : "out";
    const next = [...cfg[list], {name: `${prefix}${cfg[list].length + 1}`, type: "file"}];
    commit({...cfg, [list]: next});
  }

  function removePort(list: "inputs" | "outputs", index: number) {
    commit({...cfg, [list]: cfg[list].filter((_, i) => i !== index)});
  }

  // Registered (global) components declare their IO in the registry
  // (input_schema / output_schema) — the canvas must NOT let the user
  // hand-draw ports there.
  // Only generic (global=false) components edit ports here.
  const canEditPorts = !component.global;
  // Registered (global) components are a shared, cross-DAG definition. Their
  // definition must NOT be editable from a node's 配置 tab (doing so would
  // write to the `components` table and silently change every DAG that
  // references it). So for global components the whole definition form is
  // read-only here — only the instance params (InstanceConfigForm → dag_nodes)
  // are editable. Ports already follow this rule via `canEditPorts`.
  const readOnly = component.global;

  return (
    <div className="generic-form properties-section">
      <h3>组件配置</h3>

      <label className="generic-form-field">
        <span>组件名称</span>
        <input
          value={cfg.name}
          placeholder="组件名称"
          disabled={readOnly}
          title={readOnly ? "已注册组件：定义不可在节点配置中修改" : undefined}
          onChange={(event) => commit({...cfg, name: event.target.value})}
        />
      </label>

      <label className="generic-form-field">
        <span>描述</span>
        <input
          value={component.description}
          placeholder="可选"
          disabled={readOnly}
          title={readOnly ? "已注册组件：定义不可在节点配置中修改" : undefined}
          onChange={(event) => onChange({...component, description: event.target.value})}
        />
      </label>

      <div className="generic-form-ports">
        <div className="generic-form-portcol">
          <div className="generic-form-porthead">
            <span>输入</span>
            {canEditPorts && (
              <button type="button" className="generic-form-add" onClick={() => addPort("inputs")}>
                + 输入
              </button>
            )}
          </div>
          {cfg.inputs.length === 0 && <p className="generic-form-empty">暂无</p>}
          {cfg.inputs.map((port, i) => (
            <div className="generic-form-portrow" key={i}>
              {canEditPorts ? (
                <>
                  <input
                    className="generic-form-portname"
                    value={port.name}
                    placeholder="名称"
                    onChange={(event) => updatePort("inputs", i, {name: event.target.value})}
                  />
                  <select
                    value={port.type}
                    title="端口类型"
                    onChange={(event) =>
                      updatePort("inputs", i, {
                        type: event.target.value as PortDef["type"],
                        format: event.target.value === "status" ? undefined : port.format,
                      })
                    }
                  >
                    <option value="file">文件</option>
                    <option value="status">状态</option>
                  </select>
                  {port.type !== "status" && (
                    <select
                      value={port.format ?? ""}
                      title="文件格式"
                      onChange={(event) =>
                        updatePort("inputs", i, {format: event.target.value || undefined})
                      }
                    >
                      <option value="">任意</option>
                      <option value="parquet">parquet</option>
                      <option value="csv">csv</option>
                      <option value="json">json</option>
                    </select>
                  )}
                  <button
                    type="button"
                    className="generic-form-del"
                    onClick={() => removePort("inputs", i)}
                    aria-label="删除输入"
                  >
                    ×
                  </button>
                </>
              ) : (
                <span className="generic-form-portreadonly">{port.name}</span>
              )}
            </div>
          ))}
        </div>

        <div className="generic-form-portcol">
          <div className="generic-form-porthead">
            <span>输出</span>
            {canEditPorts && (
              <button type="button" className="generic-form-add" onClick={() => addPort("outputs")}>
                + 输出
              </button>
            )}
          </div>
          {cfg.outputs.length === 0 && <p className="generic-form-empty">暂无</p>}
          {cfg.outputs.map((port, i) => (
            <div className="generic-form-portrow" key={i}>
              {canEditPorts ? (
                <>
                  <input
                    className="generic-form-portname"
                    value={port.name}
                    placeholder="名称"
                    onChange={(event) => updatePort("outputs", i, {name: event.target.value})}
                  />
                  <select
                    value={port.type}
                    title="端口类型"
                    onChange={(event) =>
                      updatePort("outputs", i, {
                        type: event.target.value as PortDef["type"],
                        format: event.target.value === "status" ? undefined : port.format,
                      })
                    }
                  >
                    <option value="file">文件</option>
                    <option value="status">状态</option>
                  </select>
                  {port.type !== "status" && (
                    <select
                      value={port.format ?? ""}
                      title="文件格式"
                      onChange={(event) =>
                        updatePort("outputs", i, {format: event.target.value || undefined})
                      }
                    >
                      <option value="">任意</option>
                      <option value="parquet">parquet</option>
                      <option value="csv">csv</option>
                      <option value="json">json</option>
                    </select>
                  )}
                  <button
                    type="button"
                    className="generic-form-del"
                    onClick={() => removePort("outputs", i)}
                    aria-label="删除输出"
                  >
                    ×
                  </button>
                </>
              ) : (
                <span className="generic-form-portreadonly">{port.name}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <label className="generic-form-field">
        <span>Git 地址</span>
        <input
          value={cfg.gitUrl}
          placeholder="git@github.com:org/repo.git"
          disabled={readOnly}
          title={readOnly ? "已注册组件：定义不可在节点配置中修改" : undefined}
          onChange={(event) => commit({...cfg, gitUrl: event.target.value})}
        />
      </label>

      <label className="generic-form-field">
        <span>分支</span>
        <input
          value={cfg.gitBranch}
          placeholder="master（留空默认 master）"
          disabled={readOnly}
          title={readOnly ? "已注册组件：定义不可在节点配置中修改" : undefined}
          onChange={(event) => commit({...cfg, gitBranch: event.target.value})}
        />
      </label>

      <label className="generic-form-field">
        <span>Git Ref（可选，tag/分支）</span>
        <input
          value={cfg.gitRef}
          placeholder="如 v1.2.3"
          disabled={readOnly}
          title={readOnly ? "已注册组件：定义不可在节点配置中修改" : undefined}
          onChange={(event) => commit({...cfg, gitRef: event.target.value})}
        />
      </label>

      <label className="generic-form-field">
        <span>执行入口 (entry point)</span>
        <input
          value={cfg.entryPoint}
          placeholder="run.py"
          disabled={readOnly}
          title={readOnly ? "已注册组件：定义不可在节点配置中修改" : undefined}
          onChange={(event) => commit({...cfg, entryPoint: event.target.value})}
        />
      </label>
    </div>
  );
}
