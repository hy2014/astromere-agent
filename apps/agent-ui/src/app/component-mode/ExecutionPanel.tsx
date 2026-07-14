import {useEffect, useState} from "react";
import type {DagExecution, ExecutionLog, NodeExecution} from "../../types";
import {
  getExecutionLogs,
  getNodeExecutions,
  listExecutions,
} from "./api";

export type ExecutionPanelProps = {
  dagId: string | null;
  runSignal?: number;
};

type SnapshotNode = {
  id: string;
  component_id?: string;
  config?: {
    name?: string;
    gitUrl?: string;
    gitBranch?: string;
    entryPoint?: string;
    params?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

function statusLabel(status: string): string {
  switch (status) {
    case "success":
      return "成功";
    case "failed":
      return "失败";
    case "running":
      return "运行中";
    case "preparing":
      return "准备中";
    case "cancelled":
      return "已取消";
    case "skipped":
      return "已跳过";
    case "submit":
      return "已提交";
    case "accepted":
      return "已接收";
    case "pending":
      return "等待中";
    default:
      return status;
  }
}

export function ExecutionPanel({dagId, runSignal = 0}: ExecutionPanelProps) {
  const [executions, setExecutions] = useState<DagExecution[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [nodeExecutions, setNodeExecutions] = useState<NodeExecution[]>([]);
  const [snapshotNodes, setSnapshotNodes] = useState<SnapshotNode[] | null>(null);

  const refresh = async () => {
    if (!dagId) return;
    try {
      const result = await listExecutions(dagId);
      setExecutions(result);
    } catch (error) {
      console.error("[execution-panel] failed to list executions", error);
    }
  };

  useEffect(() => {
    void refresh();
  }, [dagId]);

  // The "Run DAG" button lives in the DAG toolbar (a DAG-level action). After a
  // run it bumps `runSignal` so this history list — which is shown in a node's
  // tab — refreshes to include the new execution.
  useEffect(() => {
    if (runSignal > 0) void refresh();
  }, [runSignal]);

  useEffect(() => {
    if (!selectedExecutionId) {
      setLogs([]);
      setNodeExecutions([]);
      setSnapshotNodes(null);
      return;
    }
    getExecutionLogs(selectedExecutionId)
      .then(setLogs)
      .catch((error) => console.error("[execution-panel] failed to load logs", error));
    getNodeExecutions(selectedExecutionId)
      .then((nodes) =>
        setNodeExecutions(
          [...nodes].sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0)),
        ),
      )
      .catch((error) =>
        console.error("[execution-panel] failed to load node executions", error),
      );
  }, [selectedExecutionId]);

  const handleSelectExecution = (execution: DagExecution) => {
    setSelectedExecutionId(execution.id);
    if (execution.snapshot) {
      try {
        const parsed = JSON.parse(execution.snapshot) as {nodes?: SnapshotNode[]};
        setSnapshotNodes(parsed.nodes ?? []);
      } catch {
        setSnapshotNodes(null);
      }
    } else {
      setSnapshotNodes(null);
    }
  };

  const selected = executions.find((e) => e.id === selectedExecutionId) ?? null;

  // node id（UUID）→ 可读名称。快照里带组件名（build_snapshot 注入的
  // config.name），对历史执行也生效；无快照时回退到原 UUID。
  const nodeNameOf = (id: string): string => {
    const snap = snapshotNodes?.find((n) => n.id === id);
    return snap?.config?.name || id;
  };

  return (
    <div className="execution-panel">
      <div className="execution-panel-header">
        <h3>执行历史</h3>
      </div>
      <div className="execution-list">
        {executions.length === 0 ? (
          <p className="execution-empty">No executions yet.</p>
        ) : (
          executions.map((execution) => (
            <div
              key={execution.id}
              className={`execution-item ${execution.id === selectedExecutionId ? "active" : ""}`}
              onClick={() => handleSelectExecution(execution)}
            >
              <span className={`execution-status execution-status--${execution.status}`}>
                {statusLabel(execution.status)}
              </span>
              <span className="execution-time">
                {execution.startedAtMs
                  ? new Date(execution.startedAtMs).toLocaleTimeString()
                  : "pending"}
              </span>
            </div>
          ))
        )}
      </div>

      {selected && (
        <div className="execution-detail">
          <div className="execution-detail-head">
            <span>本次运行状态</span>
            <span className={`execution-status execution-status--${selected.status}`}>
              {statusLabel(selected.status)}
            </span>
          </div>

          <div className="execution-nodes">
            <div className="execution-nodes-title">各节点状态</div>
            {nodeExecutions.length === 0 ? (
              <p className="execution-empty">暂无节点执行记录。</p>
            ) : (
              nodeExecutions.map((ne) => (
                <div key={ne.id} className="execution-node-row">
                  <span className="execution-node-name">{nodeNameOf(ne.nodeId)}</span>
                  <span className="execution-node-id">{ne.nodeId}</span>
                  <span className={`execution-status execution-status--${ne.status}`}>
                    {statusLabel(ne.status)}
                  </span>
                  {ne.error && <span className="execution-node-error">{ne.error}</span>}
                </div>
              ))
            )}
          </div>

          {snapshotNodes && snapshotNodes.length > 0 && (
            <details className="execution-snapshot">
              <summary>运行时的配置快照（当时的 DAG 配置）</summary>
              <div className="execution-snapshot-body">
                {snapshotNodes.map((n) => (
                  <div key={n.id} className="snapshot-node">
                    <div className="snapshot-node-name">
                      {n.config?.name || n.id}
                      <span className="snapshot-node-id">{n.id}</span>
                    </div>
                    <div className="snapshot-node-meta">
                      <span>Git: {n.config?.gitUrl || "—"}</span>
                      <span>分支: {n.config?.gitBranch || "—"}</span>
                      <span>入口: {n.config?.entryPoint || "—"}</span>
                    </div>
                    {n.config?.params && Object.keys(n.config.params).length > 0 && (
                      <div className="snapshot-node-args">
                        {Object.entries(n.config.params).map(([k, v]) => (
                          <span key={k} className="snapshot-arg">
                            {k}={String(v)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <div className="execution-logs">
        {logs.length === 0 ? (
          <p className="execution-empty">Select an execution to view logs.</p>
        ) : (
          logs.map((log) => (
            <div
              key={log.id ?? `${log.timestampMs}-${log.message}`}
              className={`execution-log execution-log--${log.level}`}
            >
              <span className="execution-log-level">{log.level}</span>
              {log.nodeId && <span className="execution-log-node">{nodeNameOf(log.nodeId)}</span>}
              <span className="execution-log-message">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
