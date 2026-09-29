import {useCallback, useEffect, useRef, useState} from "react";
import type {DagExecution, NodeExecution} from "../../types";
import {formatDateTimeNoLocale} from "../file-utils";
import {
  downloadNodeLog,
  getNodeExecutions,
  listExecutions,
  type DownloadHandle,
} from "./api";
import type {NodeLogTarget} from "./NodeLogPanel";

export type ExecutionPanelProps = {
  dagId: string | null;
  runSignal?: number;
  onClose?: () => void;
  /** 「各节点状态 → 详情 → 查看」：把该节点的日志交给最右侧属性栏显示。 */
  onViewNodeLog: (target: NodeLogTarget) => void;
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

// Terminal states: a run that has reached one of these will not change again,
// so it does not need live polling and is not auto-selected.
const TERMINAL = new Set<string>(["success", "failed", "cancelled"]);

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

export function ExecutionPanel({dagId, runSignal = 0, onClose, onViewNodeLog}: ExecutionPanelProps) {
  const [executions, setExecutions] = useState<DagExecution[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [nodeExecutions, setNodeExecutions] = useState<NodeExecution[]>([]);
  const [snapshotNodes, setSnapshotNodes] = useState<SnapshotNode[] | null>(null);
  // selectedExecutionId 的镜像，供 2s 轮询回调读取（避免闭包过期，
  // 也保持轮询 effect 的依赖稳定、interval 不被重置）。
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedExecutionId;
  }, [selectedExecutionId]);

  // 各节点状态里「详情」下拉：展开哪个节点（同时只开一个）。
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  // 日志下载的进度反馈，只针对当前展开的那个节点。
  const [logDownload, setLogDownload] = useState<
    {nodeId: string; busy: boolean; savedPath?: string; error?: string} | null
  >(null);
  const logDownloadHandleRef = useRef<DownloadHandle | null>(null);

  const handleDownloadLog = useCallback(
    async (nodeId: string) => {
      if (!selectedExecutionId) return;
      setLogDownload({nodeId, busy: true});
      try {
        const handle = downloadNodeLog(selectedExecutionId, nodeId);
        logDownloadHandleRef.current = handle;
        setLogDownload({nodeId, busy: false, savedPath: await handle.promise});
      } catch (e: any) {
        setLogDownload({nodeId, busy: false, error: e?.message ?? "下载失败"});
      } finally {
        logDownloadHandleRef.current = null;
      }
    },
    [selectedExecutionId],
  );

  // 「查看」= 让最右侧属性栏显示这个节点的日志。
  const handleViewLog = (nodeId: string) => {
    if (!selectedExecutionId) return;
    onViewNodeLog({executionId: selectedExecutionId, nodeId, nodeName: nodeNameOf(nodeId)});
  };

  // Load the execution list and auto-select the most recent *non-terminal* run
  // when nothing is manually selected — so after clicking "运行 DAG" the live
  // node statuses appear automatically without a click.
  const loadExecutions = useCallback(async () => {
    if (!dagId) return;
    try {
      const result = await listExecutions(dagId);
      setExecutions(result);
      // Auto-select the most recent non-terminal run when nothing is manually selected.
      if (!selectedIdRef.current) {
        const running = result
          .filter((e) => !TERMINAL.has(e.status))
          .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0))[0];
        if (running) {
          setSelectedExecutionId(running.id);
        }
      }
    } catch (error) {
      console.error("[execution-panel] failed to list executions", error);
    }
  }, [dagId]);

  // Load per-node statuses (and the frozen config snapshot) for the selected run.
  const loadDetail = useCallback(async (execId: string | null) => {
    if (!execId) {
      setNodeExecutions([]);
      setSnapshotNodes(null);
      return;
    }
    try {
      const nodes = await getNodeExecutions(execId);
      const sorted = [...nodes].sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
      setNodeExecutions(sorted);
    } catch (error) {
      console.error("[execution-panel] failed to load run detail", error);
    }
  }, []);

  // Auto-refresh the execution list every 2s while the panel is mounted (the
  // bottom dock is only rendered when open, so polling stops when closed).
  // `runSignal` forces an immediate refresh the moment a new run is submitted.
  useEffect(() => {
    void loadExecutions();
    const timer = setInterval(() => void loadExecutions(), 2000);
    return () => clearInterval(timer);
  }, [loadExecutions, runSignal]);

  // Auto-refresh the selected run's logs + node statuses every 2s.
  useEffect(() => {
    if (!selectedExecutionId) return;
    void loadDetail(selectedExecutionId);
    const timer = setInterval(() => void loadDetail(selectedExecutionId), 2000);
    return () => clearInterval(timer);
  }, [selectedExecutionId, loadDetail]);

  const selectExecution = (execution: DagExecution) => {
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

  // node id (UUID) → human-readable name. The snapshot carries the component
  // name (config.name injected by build_snapshot), also for historical runs;
  // falls back to the raw UUID when there is no snapshot.
  const nodeNameOf = (id: string): string => {
    const snap = snapshotNodes?.find((n) => n.id === id);
    return snap?.config?.name || id;
  };

  // Failed nodes that actually recorded an error — used for the top-level
  // "why it failed" banner. Capped + scrollable in CSS so a huge Ray error
  // never eats the log view below it.
  const failedWithErr =
    selected && selected.status === "failed"
      ? nodeExecutions.filter((ne) => ne.status === "failed" && ne.error)
      : [];

  return (
    <div className="execution-panel">
      <div className="execution-panel-header">
        <h3>执行历史</h3>
        <div className="execution-panel-header-actions">
          <span className="execution-auto-refresh">
            <span className="execution-auto-refresh-dot" />
            自动刷新中
          </span>
          {onClose && (
            <button
              type="button"
              className="execution-close-btn"
              onClick={onClose}
              aria-label="关闭执行历史"
              title="关闭"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="execution-body">
        <div className="execution-list-col">
          <div className="execution-list-title">历史运行</div>
          <div className="execution-list">
            {executions.length === 0 ? (
              <p className="execution-empty">No executions yet.</p>
            ) : (
              executions.map((execution) => (
                <div
                  key={execution.id}
                  className={`execution-item ${execution.id === selectedExecutionId ? "active" : ""}`}
                  onClick={() => selectExecution(execution)}
                >
                  <span className={`execution-status execution-status--${execution.status}`}>
                    {statusLabel(execution.status)}
                  </span>
                  <span className="execution-time">
                    {execution.startedAtMs
                      ? formatDateTimeNoLocale(execution.startedAtMs)
                      : "pending"}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="execution-detail-col">
          {!selected && (
            <p className="execution-empty">Select an execution to view details.</p>
          )}
          {selected && (
            <div className="execution-detail">
              <div className="execution-detail-head">
                <span>本次运行状态</span>
                <span className={`execution-status execution-status--${selected.status}`}>
                  {statusLabel(selected.status)}
                </span>
              </div>

              {/* Run-level failure reason — surfaced at the top, not buried in a
                  tiny inline node row. Capped + scrollable so it can't push the
                  log view out of the dock. */}
              {selected.status === "failed" && (
                <div className="execution-failure-banner">
                  {failedWithErr.length === 0 ? (
                    <span>
                      运行失败，但各节点未记录具体错误（可展开下方日志 / 配置快照排查）。
                    </span>
                  ) : failedWithErr.length === 1 ? (
                    <>
                      <strong>失败原因：</strong>
                      <span className="execution-failure-reason">
                        {failedWithErr[0].error}
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>失败原因（{failedWithErr.length} 个节点）：</strong>
                      <ul className="execution-failure-list">
                        {failedWithErr.map((ne) => (
                          <li key={ne.id}>
                            <span className="execution-failure-node">
                              {nodeNameOf(ne.nodeId)}
                            </span>
                            ：{ne.error}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}

              <div className="execution-nodes">
                <div className="execution-nodes-title">各节点状态</div>
                {nodeExecutions.length === 0 ? (
                  <p className="execution-empty">暂无节点执行记录。</p>
                ) : (
                  nodeExecutions.map((ne) => (
                    <div key={ne.id} className="execution-node-block">
                      <div className="execution-node-row">
                        <span className="execution-node-name">{nodeNameOf(ne.nodeId)}</span>
                        <span className="execution-node-id">{ne.nodeId}</span>
                        <span className={`execution-status execution-status--${ne.status}`}>
                          {statusLabel(ne.status)}
                        </span>
                        <button
                          type="button"
                          className="execution-node-detail-toggle"
                          onClick={() =>
                            setDetailNodeId((cur) => (cur === ne.nodeId ? null : ne.nodeId))
                          }
                          title="日志路径与下载"
                        >
                          详情 {detailNodeId === ne.nodeId ? "▴" : "▾"}
                        </button>
                      </div>
                      {ne.error && <div className="execution-node-error">{ne.error}</div>}
                      {detailNodeId === ne.nodeId && (
                        <div className="execution-node-detail">
                          <div className="execution-node-detail-path" title={ne.logPath ?? ""}>
                            {ne.logPath ?? "本次运行没有落盘日志（文件日志上线前的旧运行）"}
                          </div>
                          <div className="execution-node-detail-actions">
                            <button
                              type="button"
                              className="execution-node-detail-link"
                              disabled={!ne.logPath || logDownload?.busy}
                              onClick={() => void handleDownloadLog(ne.nodeId)}
                              title="把完整日志下载到本地"
                            >
                              ⬇ 下载
                            </button>
                            <button
                              type="button"
                              className="execution-node-detail-link"
                              onClick={() => handleViewLog(ne.nodeId)}
                              title="跳转到该节点的运行日志"
                            >
                              查看
                            </button>
                            {logDownload?.nodeId === ne.nodeId && logDownload.savedPath && (
                              <span
                                className="execution-node-detail-saved"
                                title={logDownload.savedPath}
                              >
                                ✓ 已保存到 {logDownload.savedPath}
                              </span>
                            )}
                            {logDownload?.nodeId === ne.nodeId && logDownload.error && (
                              <span
                                className="execution-node-detail-error"
                                title={logDownload.error}
                              >
                                ⚠ {logDownload.error}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
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
        </div>
      </div>
    </div>
  );
}
