import {useCallback, useEffect, useState} from "react";
import type {Component, Dag, DagDetail, DagEdge, DagExecution, DagNode} from "../../types";
import {
  createComponent,
  createDag,
  deleteComponent,
  deleteDag,
  deleteDagNode,
  getComponent,
  getDag,
  listComponents,
  listExecutions,
  listDags,
  loadDagServer,
  publishDag,
  runDag,
  testDagServerHealth,
  unpublishDag,
  updateComponent,
  updateDag,
} from "./api";
import {DagConnectModal} from "./DagConnectModal";
import {DagListView} from "./DagListView";
import {confirm, message} from "@tauri-apps/plugin-dialog";
import {
  addComponent,
  getComponents,
  removeComponent,
  setComponents as syncComponents,
  subscribe as subscribeComponents,
  updateComponent as updateComponentStore,
} from "../../stores/component-store";
import {validateInstanceConfig} from "./componentModel";
import {
  addDag,
  getActiveDagId,
  removeDag,
  setActiveDagId,
  setDags as syncDags,
  subscribe as subscribeDags,
  updateDag as updateDagStore,
} from "../../stores/dag-store";
import {ComponentCanvas} from "./ComponentCanvas";
import {ComponentFunctionList} from "./ComponentFunctionList";
import {DataPreviewModal} from "./DataPreviewModal";
import {PropertiesPanel} from "./PropertiesPanel";
import {ExecutionPanel} from "./ExecutionPanel";
import {RegisterComponentForm} from "./RegisterComponentForm";
import {ModeToggle} from "../ModeToggle";
import "../../styles/component-mode.css";

// Client-side mirror of the backend cron validation (5-field standard cron).
// The backend remains the source of truth; this only gives instant UI feedback.
function isCronItem(item: string, min: number, max: number): boolean {
  if (!item) return false;
  let base = item;
  let step: string | null = null;
  const slash = item.split("/");
  if (slash.length === 2) {
    base = slash[0];
    step = slash[1];
  } else if (slash.length !== 1) {
    return false;
  }
  if (step !== null && !/^\d+$/.test(step)) return false;

  let ok = false;
  if (base === "*") {
    ok = true;
  } else {
    const dash = base.split("-");
    if (dash.length === 2) {
      const a = Number(dash[0]);
      const b = Number(dash[1]);
      ok = Number.isInteger(a) && Number.isInteger(b) && a <= b && a >= min && b <= max;
    } else if (dash.length === 1) {
      const v = Number(base);
      ok = Number.isInteger(v) && v >= min && v <= max;
    }
  }
  if (!ok) return false;
  if (step !== null) {
    const s = Number(step);
    return Number.isInteger(s) && s >= 1;
  }
  return true;
}

function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return fields.every((field, i) =>
    field.split(",").every((item) => isCronItem(item, ranges[i][0], ranges[i][1])),
  );
}

export type ComponentModeViewProps = {
  onSwitchToCode: () => void;
  onOpenCode: (workspaceRoot: string, sessionId: string) => void;
};

export function ComponentModeView({onSwitchToCode, onOpenCode}: ComponentModeViewProps) {
  const [components, setComponents] = useState<Component[]>([]);
  // True once the first `listComponents()` has resolved (success OR failure).
  // The canvas is gated on this so it never paints with an empty `components`
  // array — which previously made every node fall back to "Unknown" for a frame.
  const [componentsLoaded, setComponentsLoaded] = useState(false);
  const [dags, setDags] = useState<Dag[]>([]);
  const [activeDagId, setLocalActiveDagId] = useState<string | null>(getActiveDagId());
  const [activeDagDetail, setActiveDagDetail] = useState<DagDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [publishCron, setPublishCron] = useState("");
  // Transient success toast (e.g. after a component update). Auto-dismisses.
  const [successToast, setSuccessToast] = useState<string | null>(null);
  // When true, the right-hand panel shows the "register new component" form
  // instead of the per-node PropertiesPanel.
  const [registering, setRegistering] = useState(false);
  // The component being edited via the sidebar kebab "edit" menu (null = creating new).
  // Reuses the same RegisterComponentForm in edit mode.
  const [editingComponent, setEditingComponent] = useState<Component | null>(null);
  // The component being viewed read-only via the sidebar kebab "view" menu (null =
  // not viewing). Reuses the same RegisterComponentForm in view mode.
  const [viewingComponent, setViewingComponent] = useState<Component | null>(null);
  // Running a DAG is a DAG-level action (lives in the top toolbar, not the
  // per-node "execution history" tab). The button is bound to the *real* execution
  // lifecycle: while the latest execution for this DAG is non-terminal the
  // button is disabled ("submitted, running…"); it re-enables only once the run
  // reaches a terminal state. `runSignal` bumps after each run so the history
  // list refreshes even though it sits in a node tab.
  const [latestExec, setLatestExec] = useState<DagExecution | null>(null);
  const [runSignal, setRunSignal] = useState(0);

  // ── dag pure-HTTP connection gating ───────────────────────────────
  // dag mode has no local mode; it must connect to a remote server to work.
  // When connected=false the whole page is covered by the connection overlay
  // and all dag features are unavailable. showConnect re-opens the modal from
  // "Settings" to re-edit the server address.
  const [connected, setConnected] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  // Toggle for the right-hand "Execution History" view: opened via the top
  // toolbar's "Execution History" button; auto-closes when a node is selected.
  const [showExecHistory, setShowExecHistory] = useState(false);
  // Node output-data preview: set when the right-click menu's "Preview Data"
  // is clicked; when null the modal is not rendered.
  const [previewNode, setPreviewNode] = useState<{nodeId: string; label: string} | null>(null);
  // Center view in dag mode: "list" = published-DAG catalog table (the default
  // landing when entering dag mode), "detail" = the selected DAG's canvas.
  // Clicking "enter" in the table (or a DAG in the sidebar) switches to detail.
  const [centerView, setCenterView] = useState<"list" | "detail">("list");

  // Success toast auto-dismisses.
  useEffect(() => {
    if (!successToast) return;
    const timer = setTimeout(() => setSuccessToast(null), 2500);
    return () => clearTimeout(timer);
  }, [successToast]);

  // On mount: if a config exists, probe health; only proceed if it responds;
  // otherwise show the connect modal.
  useEffect(() => {
    const profile = loadDagServer();
    if (!profile) {
      setConnected(false);
      setShowConnect(true);
      return;
    }
    let cancelled = false;
    void testDagServerHealth(profile).then((health) => {
      if (cancelled) return;
      if (health.ok) {
        setConnected(true);
        setShowConnect(false);
      } else {
        setConnected(false);
        setShowConnect(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the latest execution status so the "Run DAG" button tracks the real
  // run lifecycle. Cheap for a single active DAG; only setState when the
  // (id, status) actually changes to avoid a re-render every tick.
  useEffect(() => {
    if (!connected || !activeDagId) {
      setLatestExec(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await listExecutions(activeDagId);
        if (cancelled) return;
        const latest = list
          .slice()
          .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0))[0] ?? null;
        setLatestExec((prev) =>
          prev?.id === latest?.id && prev?.status === latest?.status ? prev : latest,
        );
      } catch (error) {
        console.error("[dag-mode] failed to poll executions", error);
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeDagId, connected]);

  // A run is "in progress" while the latest execution has not reached a
  // terminal state. Terminal = success / failed / cancelled.
  const runInProgress =
    latestExec != null &&
    latestExec.status !== "success" &&
    latestExec.status !== "failed" &&
    latestExec.status !== "cancelled";

  const runStatusLabel = (status: string): string => {
    switch (status) {
      case "success": return "成功";
      case "failed": return "失败";
      case "running": return "运行中";
      case "preparing": return "准备中";
      case "cancelled": return "已取消";
      case "submit": return "已提交";
      case "accepted": return "已接收";
      case "pending": return "等待中";
      default: return status;
    }
  };

  useEffect(() => {
    setPublishCron(activeDagDetail?.cron ?? "");
  }, [activeDagDetail]);

  useEffect(() => {
    return subscribeComponents((next) => setComponents(next));
  }, []);

  useEffect(() => {
    return subscribeDags(({dags: next, activeDagId: nextActiveId}) => {
      setDags(next);
      setLocalActiveDagId(nextActiveId);
    });
  }, []);

  const refreshComponents = useCallback(async () => {
    try {
      const result = await listComponents();
      // Write into the store, NOT just local state. The store is the single
      // source of truth: the subscribeComponents callback pushes
      // store.components down to local state on every emit(). If we only set
      // local state here, the store stays empty and a later removeComponent()
      // emit() overwrites the list with [] — which is why deleting a component
      // emptied the whole list. Mirror the refreshDags()/syncDags() pattern.
      syncComponents(result);
    } catch (error) {
      console.error("[dag-mode] failed to list components", error);
    } finally {
      // Mark loaded even on failure: we still want to render the canvas (so a
      // missing component surfaces via the stack-trace path in ComponentCanvas)
      // rather than hanging on a spinner forever.
      setComponentsLoaded(true);
    }
  }, []);

  const refreshDags = useCallback(async () => {
    try {
      const result = await listDags();
      // Write into the store, NOT just local state. The store is the single
      // source of truth: the subscribeDags callback pushes store.dags down to
      // local state on every emit(). If we only set local state here, the store
      // stays empty and the next setActiveDagId()/addDag()/removeDag() emit()
      // overwrites the list with [] — which is why clicking a DAG emptied it.
      syncDags(result);
    } catch (error) {
      console.error("[dag-mode] failed to list dags", error);
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    void refreshComponents();
    void refreshDags();
  }, [refreshComponents, refreshDags, connected]);

  useEffect(() => {
    if (!connected || !activeDagId) {
      setActiveDagDetail(null);
      return;
    }
    getDag(activeDagId)
      .then((detail) => {
        setActiveDagDetail(detail);
      })
      .catch((error) => console.error("[dag-mode] failed to get dag", error));
  }, [activeDagId, connected]);

  const handleSelectDag = useCallback((dagId: string) => {
    setActiveDagId(dagId);
    setLocalActiveDagId(dagId);
    setCenterView("detail");
  }, []);

  // Enter a published DAG from the catalog table → open its detail canvas.
  const handleEnterDag = useCallback((dagId: string) => {
    setActiveDagId(dagId);
    setLocalActiveDagId(dagId);
    setCenterView("detail");
  }, []);

  const handleCreateDag = useCallback(
    async (name: string) => {
      try {
        const dag = await createDag(name);
        addDag(dag);
        setActiveDagId(dag.id);
        setLocalActiveDagId(dag.id);
        setCenterView("detail");
        setActiveDagDetail({...dag, nodes: [], edges: []});
      } catch (error) {
        console.error("[dag-mode] failed to create dag", error);
        await message(String(error), {kind: "error", title: "Create DAG failed"});
      }
    },
    [],
  );

  const handleChangeDag = useCallback(
    async (nodes: DagNode[], edges: DagEdge[]) => {
      if (!activeDagDetail) return;
      const updatedDag: Dag = {
        id: activeDagDetail.id,
        name: activeDagDetail.name,
        description: activeDagDetail.description,
        status: activeDagDetail.status,
        executionOrder: activeDagDetail.executionOrder,
        cron: activeDagDetail.cron,
        createdAtMs: activeDagDetail.createdAtMs,
        updatedAtMs: Date.now(),
      };
      // Optimistic update: reflect the dropped/edited nodes & edges in
      // activeDagDetail *before* the async updateDag round-trip. Without this,
      // on the first render right after a drop the new node is still absent
      // from activeDagDetail.nodes, so selectedNode (and therefore its
      // component) can't be resolved — the right panel flashes
      // "the node has no associated component, so its config can't be edited." until updateDag's callback lands.
      setActiveDagDetail((prev) =>
        prev ? {...prev, nodes, edges, updatedAtMs: updatedDag.updatedAtMs} : null,
      );
      try {
        await updateDag(updatedDag, nodes, edges);
      } catch (error) {
        console.error("[dag-mode] failed to update dag", error);
      }
    },
    [activeDagDetail],
  );

  const handlePublishDag = useCallback(async (dagId: string, cron?: string) => {
    const err = instanceValidationError();
    if (err) {
      await message(err, {kind: "error", title: "实例配置未通过校验"});
      return;
    }
    try {
      const dag = await publishDag(dagId, cron);
      updateDagStore(dag);
      if (activeDagDetail?.id === dag.id) {
        setActiveDagDetail((prev) => (prev ? {...prev, status: dag.status, executionOrder: dag.executionOrder, cron: dag.cron} : null));
      }
    } catch (error) {
      console.error("[dag-mode] failed to publish dag", error);
      await message(String(error), {kind: "error", title: "Publish failed"});
    }
  }, [activeDagDetail]);

  const handleDeleteDag = useCallback(async (dagId: string) => {
    const ok = await confirm("Delete this DAG?", {title: "Delete DAG"});
    if (!ok) return;
    try {
      await deleteDag(dagId);
      removeDag(dagId);
      if (activeDagId === dagId) {
        setActiveDagDetail(null);
      }
    } catch (error) {
      console.error("[dag-mode] failed to delete dag", error);
    }
  }, [activeDagId]);

  // Gate run/publish on the instance configuration matching each node's
  // component schema (required params present + types valid). Returns the first
  // error message, or null if everything is valid.
  const instanceValidationError = useCallback((): string | null => {
    if (!activeDagDetail) return null;
    for (const node of activeDagDetail.nodes) {
      if (!node.componentId) continue;
      const comp = components.find((c) => c.id === node.componentId);
      if (!comp || !comp.configSchema || comp.configSchema.length === 0) continue;
      const config = node.config as Record<string, unknown> | undefined;
      const params =
        config && config.params && typeof config.params === "object"
          ? (config.params as Record<string, unknown>)
          : {};
      const errors = validateInstanceConfig(comp.configSchema, params);
      const keys = Object.keys(errors);
      if (keys.length > 0) {
        const details = keys.map((k) => `${k}: ${errors[k]}`).join("；");
        return `节点「${node.label || node.id}」（${comp.name}）实例配置有误：${details}`;
      }
    }
    return null;
  }, [activeDagDetail, components]);

  const handleRunDag = useCallback(async () => {
    if (!activeDagId || runInProgress) return;
    const err = instanceValidationError();
    if (err) {
      await message(err, {kind: "error", title: "实例配置未通过校验"});
      return;
    }
    try {
      const exec = await runDag(activeDagId);
      // Disable the button immediately (don't wait for the next poll tick).
      setLatestExec(exec);
      setRunSignal((s) => s + 1);
    } catch (error) {
      console.error("[dag-mode] failed to run dag", error);
      await message(String(error), {kind: "error", title: "Run failed"});
    }
  }, [activeDagId, runInProgress, instanceValidationError]);

  const handleUnpublishDag = useCallback(async (dagId: string) => {
    const ok = await confirm("下线该 DAG？将把状态改回草稿（cron 保留，可再次发布）。", {
      title: "下线 DAG",
    });
    if (!ok) return;
    try {
      const dag = await unpublishDag(dagId);
      updateDagStore(dag);
      if (activeDagDetail?.id === dag.id) {
        setActiveDagDetail((prev) =>
          prev ? {...prev, status: dag.status, executionOrder: dag.executionOrder, cron: dag.cron} : null,
        );
      }
    } catch (error) {
      console.error("[dag-mode] failed to unpublish dag", error);
      await message(String(error), {kind: "error", title: "下线失败"});
    }
  }, [activeDagDetail]);

  const handleSelectNode = useCallback(
    async (nodeId: string) => {
      setSelectedNodeId(nodeId);
      // Self-heal: if the selected node is bound to a component that isn't in
      // the in-memory store yet (the DB has it, but the store was never seeded
      // for this node), fetch it so the config panel resolves instead of
      // dead-ending on "the node has no associated component, so its config can't be edited.".
      const node = activeDagDetail?.nodes.find((n) => n.id === nodeId);
      if (!node?.componentId) return;
      // Read the store directly (not the React `components` state) so this
      // callback stays stable and doesn't re-trigger the canvas topology rebuild
      // on every component edit.
      if (getComponents().some((c) => c.id === node.componentId)) return;
      try {
        const comp = await getComponent(node.componentId);
        addComponent(comp);
      } catch {
        // Component missing in DB — leave unresolved; the panel shows the
        // dead-end only as a last resort (dropping a generic node always
        // creates + stores a component, so this is rare).
      }
    },
    [activeDagDetail, components],
  );

  const handleDeleteNode = useCallback(
    async (nodeId: string) => {
      if (!activeDagDetail) return;
      const ok = await confirm("删除该组件节点？关联的组件（若无其它节点引用）也会被删除。", {
        title: "删除组件",
      });
      if (!ok) return;
      try {
        await deleteDagNode(activeDagDetail.id, nodeId);
        if (selectedNodeId === nodeId) setSelectedNodeId(null);
        const detail = await getDag(activeDagDetail.id);
        setActiveDagDetail(detail);
      } catch (error) {
        console.error("[dag-mode] failed to delete node", error);
        await message(String(error), {kind: "error", title: "删除失败"});
      }
    },
    [activeDagDetail, selectedNodeId],
  );

  const handleDeleteComponent = useCallback(
    async (component: Component) => {
      const ok = await confirm(`删除组件「${component.name}」？此操作不可恢复。`, {
        title: "删除组件",
      });
      if (!ok) return;
      try {
        await deleteComponent(component.id);
        removeComponent(component.id);
        // Drop any open edit/view panel bound to the now-deleted component so
        // the right panel doesn't keep showing a stale, unresolvable form.
        if (editingComponent?.id === component.id) setEditingComponent(null);
        if (viewingComponent?.id === component.id) setViewingComponent(null);
      } catch (error) {
        console.error("[dag-mode] failed to delete component", error);
        await message(String(error), {kind: "error", title: "删除失败"});
      }
    },
    [editingComponent, viewingComponent],
  );

  const handleUpdateNode = useCallback(
    (updated: DagNode) => {
      if (!activeDagDetail) return;
      const nodes = activeDagDetail.nodes.map((n) => (n.id === updated.id ? updated : n));
      setActiveDagDetail((prev) => (prev ? {...prev, nodes} : null));
      void handleChangeDag(nodes, activeDagDetail.edges);
    },
    [activeDagDetail, handleChangeDag],
  );

  // Register = write a new row into the `components` table. The sidebar list
  // and canvas component-map are fed by the component store, so we upsert there
  // after persisting to the DB.
  const handleRegisterComponent = useCallback(
    async (component: Component) => {
      try {
        const created = await createComponent(component);
        addComponent(created);
        setRegistering(false);
        setEditingComponent(null);
      } catch (error) {
        console.error("[dag-mode] failed to register component", error);
        await message(String(error), {kind: "error", title: "注册组件失败"});
      }
    },
    [],
  );

  // Open the edit-mode form for an existing registered component (sidebar
  // kebab "edit"). Reuses RegisterComponentForm; submit calls updateComponent,
  // preserving the component_id so canvas references stay intact.
  const handleEditComponent = useCallback((component: Component) => {
    setEditingComponent(component);
    setRegistering(true);
  }, []);

  // Open the read-only view for an existing registered component (sidebar
  // kebab "view"). Reuses RegisterComponentForm in view mode.
  const handleViewComponent = useCallback((component: Component) => {
    setViewingComponent(component);
  }, []);

  const handleCancelRegister = useCallback(() => {
    setRegistering(false);
    setEditingComponent(null);
    setViewingComponent(null);
  }, []);

  // Edit-mode submit: persist the update (same component_id) and close the form.
  const handleUpdateRegistered = useCallback(
    async (component: Component) => {
      try {
        const updated = await updateComponent(component);
        updateComponentStore(updated);
        setRegistering(false);
        setEditingComponent(null);
        setSuccessToast(`「${updated.name}」修改成功`);
      } catch (error) {
        console.error("[dag-mode] failed to update component", error);
        await message(String(error), {kind: "error", title: "修改组件失败"});
      }
    },
    [],
  );

  // The configuration truth-source is the component: editing the form persists
  // to the `components` table and refreshes the store (cross-DAG reuse).
  const handleUpdateComponent = useCallback(async (component: Component) => {
    try {
      const updated = await updateComponent(component);
      updateComponentStore(updated);
    } catch (error) {
      console.error("[dag-mode] failed to update component", error);
    }
  }, []);

  // After a generic component is created on canvas drop, add it to the store so
  // the component list (and node→component lookup on selection) stays in sync.
  const handleComponentCreated = useCallback((component: Component) => {
    addComponent(component);
  }, []);

  // Resolve the currently selected node and (if it is bound to a real
  // component) the component itself. Every node is bound to a component, so a
  // null `selectedComponent` only happens transiently while the store is still
  // loading (handled by the self-heal in handleSelectNode).
  const selectedNode = activeDagDetail?.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedComponent = selectedNode?.componentId
    ? components.find((c) => c.id === selectedNode.componentId) ?? null
    : null;

  return (
    <div
      className={
        registering || viewingComponent
          ? "component-mode-shell registering"
          : "component-mode-shell"
      }
    >
      {successToast && (
        <div
          style={{
            position: "fixed",
            top: 18,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 80,
            border: "1px solid #bbf7d0",
            borderRadius: 999,
            padding: "8px 14px",
            background: "#f0fdf4",
            color: "#166534",
            fontSize: 13,
            fontWeight: 750,
            boxShadow: "0 12px 30px rgba(15, 23, 42, 0.16)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{fontSize: 14, lineHeight: 1}}>✓</span>
          {successToast}
        </div>
      )}
      <aside className="component-mode-sidebar">
        <div className="component-mode-mode">
          <ModeToggle
            mode="dag"
            onChange={(next) => {
              if (next === "code") onSwitchToCode();
            }}
          />
        </div>
        <div className="component-mode-brand">
          <span className="component-mode-logo">Claw</span>
        </div>
        <ComponentFunctionList
          components={components}
          dags={dags}
          activeDagId={activeDagId}
          onSelectDag={handleSelectDag}
          onCreateDag={handleCreateDag}
          onUnpublishDag={handleUnpublishDag}
          onDeleteDag={handleDeleteDag}
          onStartRegister={() => setRegistering(true)}
          onEditComponent={handleEditComponent}
          onViewComponent={handleViewComponent}
          onDeleteComponent={handleDeleteComponent}
          onOpenServerSettings={() => setShowConnect(true)}
        />
      </aside>
      <main className="component-mode-main">
        <header className="component-mode-toolbar">
          {centerView === "list" ? (
            <span className="component-mode-dag">DAG 列表</span>
          ) : activeDagDetail ? (
            <div className="dag-toolbar">
              <div className="dag-toolbar-left">
                <button
                  type="button"
                  className="dag-back-btn"
                  onClick={() => setCenterView("list")}
                >
                  ← DAG 列表
                </button>
                <span className="component-mode-dag">{activeDagDetail.name}</span>
              </div>
              <button
                type="button"
                className={`dag-history-btn${showExecHistory ? " active" : ""}`}
                aria-pressed={showExecHistory}
                onClick={() => setShowExecHistory((v) => !v)}
              >
                执行历史
              </button>
              <div className="dag-publish-area">
                <button
                  type="button"
                  className="dag-run-btn"
                  disabled={runInProgress}
                  onClick={() => handleRunDag()}
                >
                  {runInProgress ? "已提交，执行中…" : "运行 DAG"}
                </button>
                {latestExec && (
                  <span className={`dag-run-status dag-run-status--${latestExec.status}`}>
                    {runStatusLabel(latestExec.status)}
                  </span>
                )}
                {activeDagDetail.status === "published" ? (
                  <>
                    <span className="dag-badge dag-badge--published">已发布</span>
                    {activeDagDetail.cron ? (
                      <span className="dag-list-cron" title="Cron schedule">
                        {activeDagDetail.cron}
                      </span>
                    ) : (
                      <span className="dag-cron-none">无 cron</span>
                    )}
                  </>
                ) : (
                  (() => {
                    const cronTrim = publishCron.trim();
                    const cronInvalid = cronTrim !== "" && !isValidCron(cronTrim);
                    const canPublish = cronTrim !== "" && !cronInvalid;
                    return (
                      <>
                        <input
                          type="text"
                          className={`dag-cron-input${cronInvalid ? " dag-cron-input--invalid" : ""}`}
                          placeholder="cron（必填，如 */5 * * * *）"
                          value={publishCron}
                          onChange={(event) => setPublishCron(event.target.value)}
                        />
                        {cronInvalid && (
                          <span className="dag-cron-error">cron 格式非法</span>
                        )}
                        <button
                          type="button"
                          className="dag-publish-btn"
                          disabled={!canPublish}
                          title={canPublish ? "发布 DAG" : "请填写合法的 cron 表达式"}
                          onClick={() => handlePublishDag(activeDagDetail.id, cronTrim)}
                        >
                          发布
                        </button>
                      </>
                    );
                  })()
                )}
              </div>
            </div>
          ) : (
            <span className="component-mode-dag">No DAG selected</span>
          )}
        </header>
        <div className="component-mode-canvas">
          {centerView === "list" ? (
            <DagListView dags={dags} onEnter={handleEnterDag} />
          ) : activeDagDetail ? (
            componentsLoaded ? (
              <ComponentCanvas
                dagId={activeDagDetail.id}
                nodes={activeDagDetail.nodes}
                edges={activeDagDetail.edges}
                components={components}
                onChange={handleChangeDag}
                onSelectNode={handleSelectNode}
                onDeleteNode={handleDeleteNode}
                onPreviewNode={(nodeId, label) => setPreviewNode({nodeId, label})}
                onComponentCreated={handleComponentCreated}
              />
            ) : (
              <p>加载画布中…</p>
            )
          ) : (
            <p>Select or create a DAG to start.</p>
          )}
        </div>
      </main>
      <aside className="component-mode-properties">
        {registering || viewingComponent ? (
          <RegisterComponentForm
            key={editingComponent?.id ?? viewingComponent?.id ?? "new"}
            editing={editingComponent ?? undefined}
            viewing={viewingComponent ?? undefined}
            existingComponents={components}
            onRegister={handleRegisterComponent}
            onUpdate={handleUpdateRegistered}
            onCancel={handleCancelRegister}
          />
        ) : (
          <PropertiesPanel
            node={selectedNode}
            component={selectedComponent}
            onUpdateNode={handleUpdateNode}
            onUpdateComponent={handleUpdateComponent}
            onOpenCode={onOpenCode}
            onDeleteNode={handleDeleteNode}
          />
        )}
      </aside>
      {showExecHistory && (
        <div className="component-mode-exec-dock">
          <ExecutionPanel
            dagId={activeDagId}
            runSignal={runSignal}
            onClose={() => setShowExecHistory(false)}
          />
        </div>
      )}
      {!connected || showConnect ? (
        <DagConnectModal
          onConnected={() => {
            setConnected(true);
            setShowConnect(false);
          }}
          onCancel={connected ? () => setShowConnect(false) : undefined}
        />
      ) : null}
      {previewNode && (
        <DataPreviewModal
          dagId={activeDagId ?? ""}
          nodeId={previewNode.nodeId}
          nodeLabel={previewNode.label}
          onClose={() => setPreviewNode(null)}
        />
      )}
    </div>
  );
}
