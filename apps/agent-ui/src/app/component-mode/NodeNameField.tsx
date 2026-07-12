import {useEffect, useState} from "react";
import type {Component, DagNode} from "../../types";

export type NodeNameFieldProps = {
  node: DagNode;
  component: Component | null;
  onChange: (node: DagNode) => void;
};

// Instance-level display name editor. Writes ONLY `dag_nodes.label` (this
// single canvas node), never the shared `components` table. Empty label falls
// back to `component.name` on the canvas title (see ComponentCanvas).
export function NodeNameField({node, component, onChange}: NodeNameFieldProps) {
  const [label, setLabel] = useState<string>(node.label ?? "");

  // Re-sync only when a *different* node is selected (not on every keystroke,
  // which would steal focus).
  useEffect(() => {
    setLabel(node.label ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  function commit(next: string) {
    setLabel(next);
    onChange({...node, label: next});
  }

  return (
    <div className="node-name-field">
      <label className="node-name-label" htmlFor={`node-name-${node.id}`}>
        节点名称
      </label>
      <input
        id={`node-name-${node.id}`}
        className="node-name-input"
        value={label}
        placeholder={component?.name || "给这个节点起个名字"}
        onChange={(event) => commit(event.target.value)}
      />
      <p className="node-name-hint">留空则显示组件名</p>
    </div>
  );
}
