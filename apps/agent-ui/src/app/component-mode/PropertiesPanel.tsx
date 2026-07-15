import {useState} from "react";
import type {Component, DagNode} from "../../types";
import {GenericComponentForm} from "./GenericComponentForm";
import {InstanceConfigForm} from "./InstanceConfigForm";
import {SystemConfigForm} from "./SystemConfigForm";
import {NodeNameField} from "./NodeNameField";
import {ComponentSessionPanel} from "./ComponentSessionPanel";

type TabKey = "config" | "system" | "explore";

export type PropertiesPanelProps = {
  node: DagNode | null;
  component: Component | null;
  onUpdateNode: (node: DagNode) => void;
  onUpdateComponent: (component: Component) => void;
  onOpenCode: (workspaceRoot: string, sessionId: string) => void;
  onDeleteNode?: (nodeId: string) => void;
};

// Empty state for the 探索 tab when the selected node has no component
// sessions yet. Note the wording: *publishing* is about the DAG going live to
// the scheduler — not about publishing a component; component sessions are a
// separate concern (paused for now).
function ExploreEmpty() {
  return (
    <div className="explore-empty">
      <p className="explore-empty-title">该组件暂无 session 可探索</p>
      <p className="explore-empty-hint">
        组件的代码在经过运行 / 定时探索后才会最终确定；而「发布」发布的是
        DAG（上线交给 scheduler 调度），不是组件本身。先在「配置」中填写 Git
        地址与执行入口。
      </p>
    </div>
  );
}

export function PropertiesPanel({
  node,
  component,
  onUpdateNode,
  onUpdateComponent,
  onOpenCode,
  onDeleteNode,
}: PropertiesPanelProps) {
  const [tab, setTab] = useState<TabKey>("config");

  if (!node) {
    return (
      <div className="properties-section">
        <h3>属性</h3>
        <p>选择一个节点进行编辑。</p>
      </div>
    );
  }

  return (
    <div className="properties-panel">
      <div className="properties-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "config"}
          className={tab === "config" ? "active" : ""}
          onClick={() => setTab("config")}
        >
          配置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "explore"}
          className={tab === "explore" ? "active" : ""}
          onClick={() => setTab("explore")}
        >
          探索
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "system"}
          className={tab === "system" ? "active" : ""}
          onClick={() => setTab("system")}
        >
          系统配置
        </button>
      </div>
      <div className="properties-tab-body">
        {tab === "config" && (
          <div className="properties-config">
            <NodeNameField node={node} component={component} onChange={onUpdateNode} />
            {component ? (
              <>
                <GenericComponentForm component={component} onChange={onUpdateComponent} />
                {node && (
                  <InstanceConfigForm
                    key={node.id}
                    node={node}
                    component={component}
                    onChange={onUpdateNode}
                  />
                )}
              </>
            ) : (
              <p className="explore-empty-title">该节点未关联组件，无法编辑配置。</p>
            )}
            {onDeleteNode && (
              <div className="properties-config-actions">
                <button
                  type="button"
                  className="node-delete-btn"
                  onClick={() => onDeleteNode(node.id)}
                >
                  删除组件
                </button>
              </div>
            )}
          </div>
        )}
        {tab === "explore" &&
          (component ? (
            <ComponentSessionPanel component={component} onOpenCode={onOpenCode} />
          ) : (
            <ExploreEmpty />
          ))}
        {tab === "system" &&
          (component ? (
            <SystemConfigForm node={node} onChange={onUpdateNode} />
          ) : (
            <p className="explore-empty-title">该节点未关联组件，无法编辑系统配置。</p>
          ))}
      </div>
    </div>
  );
}
