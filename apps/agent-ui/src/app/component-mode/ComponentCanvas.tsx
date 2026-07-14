import {useCallback, useEffect, useState} from "react";
import {
  addEdge,
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {Component, DagEdge, DagNode, PortDef} from "../../types";
import {createComponent} from "./api";
import {message} from "@tauri-apps/plugin-dialog";
import {COMPONENT_DRAG_KEY, GENERIC_DRAG_KEY, schemaToPorts} from "./componentModel";

export type ComponentCanvasProps = {
  dagId: string;
  nodes: DagNode[];
  edges: DagEdge[];
  components: Component[];
  onChange: (nodes: DagNode[], edges: DagEdge[]) => void;
  onSelectNode?: (nodeId: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  // 右键节点 → 预览该节点输出数据。label 为节点显示名（label || 组件名）。
  onPreviewNode?: (nodeId: string, label: string) => void;
  // Called after a *generic* component is created on drop, so the parent can
  // refresh its component list (enabling node→component lookup on selection).
  onComponentCreated?: (component: Component) => void;
};

type ComponentNodeData = {
  component: Component;
  dagNode: DagNode;
  broken?: boolean;
  onSelect?: (nodeId: string) => void;
};

// Placeholder used ONLY when a node's componentId cannot be resolved to a real
// `components` row. In steady state this should never happen — every canvas
// node is bound to a component. We keep a placeholder so the node is never lost,
// but `resolveComponentForNode` loudly logs a stack trace so the desync is
// debuggable instead of being hidden behind a silent "Unknown".
const UNRESOLVED_COMPONENT: Component = {
  id: "",
  name: "未解析组件",
  description: "",
  status: "draft",
  workspaceRoot: "",
  gitUrl: "",
  gitBranch: "",
  gitRef: "",
  entryPoint: "",
  inputSchema: {type: "object", properties: {}},
  outputSchema: {type: "object", properties: {}},
  tags: [],
  global: false,
  createdAtMs: 0,
  updatedAtMs: 0,
};

function resolveComponentForNode(
  node: DagNode,
  map: Map<string, Component>,
): {component: Component; broken: boolean} {
  const comp = map.get(node.componentId);
  if (comp) return {component: comp, broken: false};
  // Should be unreachable in steady state. Print a stack so the trigger is
  // visible in devtools rather than silently degrading to "Unknown".
  console.error(
    new Error(
      `[component-canvas] node "${node.id}" references component ` +
        `"${node.componentId}" which is absent from the components map. ` +
        `This is a desync (component row missing from store/DB), not a normal state.`,
    ),
  );
  return {
    component: {
      ...UNRESOLVED_COMPONENT,
      id: node.componentId ?? "MISSING",
      name: `未解析组件 ${node.componentId ? node.componentId.slice(0, 6) : ""}`.trim(),
    },
    broken: true,
  };
}

function ComponentNode({data}: {data: ComponentNodeData}) {
  const {component, dagNode, broken, onSelect} = data;
  const isGeneric = !component.global;

  // Render exactly one connection point per declared port (a component with N
  // inputs exposes N input dots to wire up). Handle ids are namespaced
  // (in:/out:) to stay unique even if an input and output share a name; edges
  // store these ids and round-trip unchanged. There is NO fallback handle: the
  // canvas is a faithful mirror of the component's schema, so 0 declared ports
  // ⇒ 0 dots, for both generic and registered components. To wire a generic
  // node, declare its ports first in the config tab (+ 输入 / + 输出); the dots
  // then appear.
  // Render one handle per declared port. A port's *kind* (file | status) drives
  // its look: status handles are hollow (see component-mode.css) and both show
  // the type on hover. schemaToPorts decodes {type:"status"} → status, else file.
  const inputPorts = schemaToPorts(component.inputSchema);
  const outputPorts = schemaToPorts(component.outputSchema);
  const portTitle = (p: PortDef) =>
    p.type === "status" ? "状态" : `文件${p.format ? `·${p.format}` : ""}`;
  const portClass = (p: PortDef) =>
    p.type === "status" ? "component-port component-port--status" : "component-port component-port--file";

  return (
    <div
      className={`component-node${isGeneric ? " component-node--generic" : ""}${broken ? " component-node--broken" : ""}`}
      onClick={() => onSelect?.(dagNode.id)}
      role="button"
      tabIndex={0}
    >
      {inputPorts.map((port, i) => (
        <Handle
          key={`in:${port.name}`}
          type="target"
          position={Position.Top}
          id={`in:${port.name}`}
          className={portClass(port)}
          title={`${port.name}（${portTitle(port)}）`}
          style={{left: `${((i + 1) / (inputPorts.length + 1)) * 100}%`}}
        />
      ))}
      <div className="component-node-header">
        <span className="component-node-type">{isGeneric ? "通" : "注"}</span>
        <span className="component-node-sep">｜</span>
        <span className="component-node-label">{dagNode.label || component.name}</span>
      </div>
      {broken && <div className="component-node-tag component-node-tag--broken">未解析</div>}
      {outputPorts.map((port, i) => (
        <Handle
          key={`out:${port.name}`}
          type="source"
          position={Position.Bottom}
          id={`out:${port.name}`}
          className={portClass(port)}
          title={`${port.name}（${portTitle(port)}）`}
          style={{left: `${((i + 1) / (outputPorts.length + 1)) * 100}%`}}
        />
      ))}
    </div>
  );
}

const nodeTypes = {
  component: ComponentNode,
};

function dagNodeToFlowNode(
  dagNode: DagNode,
  resolved: {component: Component; broken: boolean},
  onSelect?: (nodeId: string) => void,
): Node<ComponentNodeData> {
  return {
    id: dagNode.id,
    type: "component",
    position: {x: dagNode.position.x, y: dagNode.position.y},
    data: {
      component: resolved.component,
      broken: resolved.broken,
      dagNode,
      onSelect: () => onSelect?.(dagNode.id),
    },
  };
}

function dagEdgeToFlowEdge(dagEdge: DagEdge): Edge {
  return {
    id: dagEdge.id,
    source: dagEdge.sourceNodeId,
    target: dagEdge.targetNodeId,
    sourceHandle: dagEdge.sourceHandle,
    targetHandle: dagEdge.targetHandle,
  };
}

function flowNodeToDagNode(node: Node<ComponentNodeData>): DagNode {
  return {
    ...node.data.dagNode,
    position: {x: node.position.x, y: node.position.y},
  };
}

function flowEdgeToDagEdge(edge: Edge, dagId: string): DagEdge {
  return {
    id: edge.id,
    dagId,
    sourceNodeId: edge.source,
    targetNodeId: edge.target,
    sourceHandle: edge.sourceHandle ?? "output",
    targetHandle: edge.targetHandle ?? "input",
  };
}

function ComponentCanvasInner({
  dagId,
  nodes,
  edges,
  components,
  onChange,
  onSelectNode,
  onDeleteNode,
  onPreviewNode,
  onComponentCreated,
}: ComponentCanvasProps) {
  const componentMap = new Map(components.map((component) => [component.id, component]));
  // 节点右键菜单：绝对定位到鼠标处，点「预览数据」触发 onPreviewNode。
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
    label: string;
  } | null>(null);
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState(
    nodes.map((node) =>
      dagNodeToFlowNode(
        node,
        resolveComponentForNode(node, componentMap),
        onSelectNode,
      ),
    ),
  );
  const [flowEdges, setFlowEdges, onFlowEdgesChange] = useEdgesState(edges.map(dagEdgeToFlowEdge));
  const {screenToFlowPosition} = useReactFlow();

  // Topology rebuild: only when the node/edge set (or the click/delete
  // handlers) actually changes — NOT on every component-data refresh. Rebuilding
  // the whole array on `components` change was the bug: editing a component
  // (e.g. clicking "+ 输入") calls updateComponentStore → components changes →
  // this effect wiped React-Flow's node state and desynced the canvas, making
  // the node drop / fall back to "Unknown" (and briefly unresolving
  // selectedComponent → "该节点未关联组件").
  useEffect(() => {
    setFlowNodes(
      nodes.map((node) =>
        dagNodeToFlowNode(
          node,
          resolveComponentForNode(node, componentMap),
          onSelectNode,
        ),
      ),
    );
    setFlowEdges(edges.map(dagEdgeToFlowEdge));
  }, [nodes, edges, onSelectNode, onDeleteNode]);

  // Component-data sync: when the component list refreshes (e.g. after editing
  // a port in the config tab), merge the latest component into the EXISTING
  // flow nodes in place. This preserves node identity and positions, so a
  // component edit can never drop or "unknow" a canvas node.
  useEffect(() => {
    const map = new Map(components.map((c) => [c.id, c]));
    setFlowNodes((nds) =>
      nds.map((n) => {
        const comp = map.get(n.data.dagNode.componentId);
        if (!comp) return n;
        return {...n, data: {...n.data, component: comp}};
      }),
    );
  }, [components]);

  // Resolve a port's kind (file | status) from a node id + handle id. Handle ids
  // are namespaced "out:<port>" / "in:<port>"; strip the prefix to hit the bare
  // key in the component schema. Unknown ⇒ treat as "file" (permissive default).
  const portKindOf = useCallback(
    (nodeId: string | null, handle: string | null | undefined, dir: "source" | "target"): "file" | "status" => {
      if (!nodeId) return "file";
      const fn = flowNodes.find((n) => n.id === nodeId);
      const comp = fn?.data.component;
      if (!comp) return "file";
      const bare = (handle ?? "").replace(/^(out:|in:)/, "");
      const schema = dir === "source" ? comp.outputSchema : comp.inputSchema;
      const def = schema?.properties?.[bare];
      return def?.type === "status" ? "status" : "file";
    },
    [flowNodes],
  );

  // Enforce same-kind wiring: file→file and status→status only. Crossing a
  // control-flow port with a data port is rejected (see docs/component-mode.md).
  const isValidConnection = useCallback(
    (c: {source: string | null; target: string | null; sourceHandle?: string | null; targetHandle?: string | null}) => {
      const srcKind = portKindOf(c.source, c.sourceHandle, "source");
      const tgtKind = portKindOf(c.target, c.targetHandle, "target");
      return srcKind === tgtKind;
    },
    [portKindOf],
  );

  const onConnect = useCallback(
    (connection: Edge | {source: string | null; target: string | null; sourceHandle?: string | null; targetHandle?: string | null}) => {
      const edge = connection as Edge;
      setFlowEdges((eds) => {
        const next = addEdge(edge, eds);
        onChange(flowNodes.map(flowNodeToDagNode), next.map((e) => flowEdgeToDagEdge(e, dagId)));
        return next;
      });
    },
    [dagId, flowNodes, setFlowEdges, onChange],
  );

  // Short random suffix (e.g. "a3gf5") used to make generic component default
  // names distinct: every drag previously created a `components` row named the
  // literal "通用组件", so N dropped generics were indistinguishable on the
  // canvas (title = `label || name`) until manually renamed. We keep the
  // "通用组件" prefix (recognizable in the palette) and append a random tag.
  function randomSuffix(): string {
    return Math.random().toString(36).slice(2, 7);
  }

  // crypto.randomUUID can be unavailable in some webview/secure-context setups;
  // fall back to a time+rng based id so a drop never silently fails.
  function makeUuid(): string {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch {
      // fall through to fallback
    }
    return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      const position = screenToFlowPosition({x: event.clientX, y: event.clientY});
      try {
        // (1) Generic component (default path): dragging "通用组件" creates a
        // fresh, NON-SHARED component row on drop — no registration needed.
        const genericRaw = event.dataTransfer.getData(GENERIC_DRAG_KEY);
        if (genericRaw) {
          const now = Date.now();
          const newComponent: Component = {
            id: makeUuid(),
            name: `通用组件-${randomSuffix()}`,
            description: "",
            status: "draft",
            workspaceRoot: "",
            gitUrl: "",
            gitBranch: "",
            gitRef: "",
            entryPoint: "",
            inputSchema: {type: "object", properties: {}},
            outputSchema: {type: "object", properties: {}},
            // `config_schema` is a REQUIRED column on the backend `Component`
            // struct (serde has no default). Omitting it made axum reject the
            // POST with 422, so the generic drop silently failed. Empty array
            // = no declared params, matching the backend's NULL/empty contract.
            configSchema: [],
            tags: [],
            global: false,
            createdAtMs: now,
            updatedAtMs: now,
          };
          const created = await createComponent(newComponent);

          const dagNode: DagNode = {
            id: makeUuid(),
            dagId,
            componentId: created.id,
            label: "",
            position: {x: position.x, y: position.y},
            config: {
              params: {},
            },
          };

          const newNode = dagNodeToFlowNode(dagNode, {component: created, broken: false}, onSelectNode);
          const nextDagNodes = [...flowNodes.map(flowNodeToDagNode), dagNode];
          setFlowNodes((prev) => [...prev, newNode]);
          onChange(nextDagNodes, flowEdges.map((e) => flowEdgeToDagEdge(e, dagId)));
          onComponentCreated?.(created);
          onSelectNode?.(dagNode.id);
          return;
        }

        // (2) Registered component: drag references an existing `components` row
        // by id — no new component is created here. This is what enables
        // cross-DAG reuse: many DAG nodes can reference the same component_id.
        const componentId = event.dataTransfer.getData(COMPONENT_DRAG_KEY);
        if (!componentId) return;

        const component = componentMap.get(componentId);
        if (!component) return;

        const dagNode: DagNode = {
          id: makeUuid(),
          dagId,
          componentId,
          label: "",
          position: {x: position.x, y: position.y},
          config: {
            params: {},
          },
        };

        const newNode = dagNodeToFlowNode(dagNode, {component, broken: false}, onSelectNode);
        // Build the next DAG-node list from the current flow nodes, then commit
        // both the optimistic React-Flow update and the persisted change. Keeping
        // onChange OUTSIDE the setFlowNodes updater avoids double-firing under
        // React StrictMode.
        const nextDagNodes = [...flowNodes.map(flowNodeToDagNode), dagNode];
        setFlowNodes((prev) => [...prev, newNode]);
        onChange(nextDagNodes, flowEdges.map((e) => flowEdgeToDagEdge(e, dagId)));
        onSelectNode?.(dagNode.id);
      } catch (err) {
        // Previously this only console.error'd, so a failed drop produced zero
        // user-visible feedback (e.g. a 422 from the backend) and looked like
        // "dragging does nothing". Surface it so the failure is actionable.
        console.error("[component-canvas] onDrop failed", err);
        const msg = err instanceof Error ? err.message : String(err);
        message(`拖入组件失败：${msg}`, {kind: "error", title: "拖入失败"}).catch(() => {});
      }
    },
    [dagId, flowNodes, flowEdges, componentMap, setFlowNodes, onChange, screenToFlowPosition, onSelectNode, onComponentCreated],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onNodeDragStop = useCallback(() => {
    onChange(flowNodes.map(flowNodeToDagNode), flowEdges.map((e) => flowEdgeToDagEdge(e, dagId)));
  }, [dagId, flowNodes, flowEdges, onChange]);

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node<ComponentNodeData>) => {
      event.preventDefault();
      const label = node.data.dagNode.label || node.data.component.name || node.id;
      setMenu({x: event.clientX, y: event.clientY, nodeId: node.id, label});
    },
    [],
  );

  return (
    <>
      <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      onNodesChange={onFlowNodesChange}
      onEdgesChange={onFlowEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onNodeDragStop={onNodeDragStop}
      onNodeContextMenu={onNodeContextMenu}
      nodeTypes={nodeTypes}
      fitView
    >
      <Background gap={16} size={1} />
      <Controls />
    </ReactFlow>
    {menu && (
      <>
        <div className="node-context-overlay" onClick={() => setMenu(null)} />
        <div
          className="node-context-menu"
          style={{left: menu.x, top: menu.y}}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="node-context-item"
            onClick={() => {
              onPreviewNode?.(menu.nodeId, menu.label);
              setMenu(null);
            }}
          >
            预览数据
          </button>
        </div>
      </>
    )}
    </>
  );
}

export function ComponentCanvas(props: ComponentCanvasProps) {
  return (
    <ReactFlowProvider>
      <ComponentCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
