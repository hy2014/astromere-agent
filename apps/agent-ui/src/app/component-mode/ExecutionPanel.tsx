import {useCallback, useEffect, useState} from "react";
import type {DagExecution, ExecutionLog, NodeExecution, NodeLogFile} from "../../types";
import {getExecutionLogs, getNodeExecutions, getNodeLog, listExecutions} from "./api";

export type ExecutionPanelProps = {
  dagId: string | null;
  runSignal?: number;
  onClose?: () => void;
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

export function ExecutionPanel({dagId, runSignal = 0, onClose}: ExecutionPanelProps) {
  const [executions, setExecutions] = useState<DagExecution[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [nodeExecutions, setNodeExecutions] = useState<NodeExecution[]>([]);
  const [snapshotNodes, setSnapshotNodes] = useState<SnapshotNode[] | null>(null);
  // Per-node on-disk log (file source of truth) + paging + legacy fallback.
  const [selectedLogNodeId, setSelectedLogNodeId] = useState<string | null>(null);
  const [nodeLogFile, setNodeLogFile] = useState<NodeLogFile | null>(null);
  const [logOffset, setLogOffset] = useState(0);
  const [logLoading, setLogLoading] = useState(false);
  const [fallbackLogs, setFallbackLogs] = useState<ExecutionLog[] | null>(null);

  // Load the execution list and auto-select the most recent *non-terminal* run
  // when nothing is manually selected — so after clicking "运行 DAG" the live
  // log view appears automatically (IDEA/VSCode-style) without a click.
  const loadExecutions = useCallback(async () => {
    if (!dagId) return;
    try {
      const result = await listExecutions(dagId);
      setExecutions(result);
      setSelectedExecutionId((cur) => {
        if (cur) return cur;
        const running = result
          .filter((e) => !TERMINAL.has(e.status))
          .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0))[0];
        return running ? running.id : cur;
      });
    } catch (error) {
      console.error("[execution-panel] failed to list executions", error);
    }
  }, [dagId]);

  // Load per-node statuses (and the frozen config snapshot) for the selected run.
  const loadDetail = useCallback(async (execId: string | null) => {
    if (!execId) {
      setNodeExecutions([]);
      setSnapshotNodes(null);
      setSelectedLogNodeId(null);
      setNodeLogFile(null);
      setFallbackLogs(null);
      return;
    }
    try {
      const nodes = await getNodeExecutions(execId);
      const sorted = [...nodes].sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
      setNodeExecutions(sorted);
      // Default the log viewer to the first failed node (the one you usually
      // care about), else the first node. Only auto-pick when the user hasn't
      // already chosen one, so the 2s refresh doesn't yank their selection.
      const def =
        sorted.find((n) => n.status === "failed")?.nodeId ??
        sorted[0]?.nodeId ??
        null;
      setSelectedLogNodeId((cur) => cur ?? def);
      setLogOffset(0);
    } catch (error) {
      console.error("[execution-panel] failed to load run detail", error);
    }
  }, []);

  // Load a node's full on-disk log, paged. Falls back to the legacy DB-backed
  // (merged) logs when the file doesn't exist (runs before file-logging).
  const LOG_PAGE = 2000;
  const loadNodeLog = useCallback(
    async (execId: string, nodeId: string | null, offset: number) => {
      if (!nodeId) {
        setNodeLogFile(null);
        setFallbackLogs(null);
        return;
      }
      setLogLoading(true);
      try {
        const nf = await getNodeLog(execId, nodeId, offset, LOG_PAGE);
        setNodeLogFile(nf);
        setFallbackLogs(null);
      } catch {
        // File-based logging unavailable for this run → legacy DB logs.
        try {
          const rows = await getExecutionLogs(execId);
          setFallbackLogs(rows);
          setNodeLogFile(null);
        } catch {
          setFallbackLogs(null);
          setNodeLogFile(null);
        }
      } finally {
        setLogLoading(false);
      }
    },
    [],
  );

  // (Re)load the selected node's log whenever the run, node, or page changes.
  useEffect(() => {
    if (!selectedExecutionId || !selectedLogNodeId) return;
    void loadNodeLog(selectedExecutionId, selectedLogNodeId, logOffset);
  }, [selectedExecutionId, selectedLogNodeId, logOffset, loadNodeLog]);

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
    setSelectedLogNodeId(null);
    setLogOffset(0);
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
                      ? new Date(execution.startedAtMs).toLocaleTimeString()
                      : "pending"}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="execution-detail-col">
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
                      </div>
                      {ne.error && <div className="execution-node-error">{ne.error}</div>}
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

          <div className="execution-logs-header">
            <div className="execution-log-toolbar">
              <label className="execution-log-toolbar-label">节点日志</label>
              {nodeExecutions.length > 0 ? (
                <select
                  className="execution-log-node-select"
                  value={selectedLogNodeId ?? ""}
                  onChange={(e) => {
                    setSelectedLogNodeId(e.target.value || null);
                    setLogOffset(0);
                  }}
                >
                  {nodeExecutions.map((ne) => (
                    <option key={ne.nodeId} value={ne.nodeId}>
                      {nodeNameOf(ne.nodeId)}
                      {ne.status === "failed" ? "（失败）" : ""}
                    </option>
                  ))}
                </select>
              ) : null}
              {nodeLogFile && (
                <div className="execution-log-pager">
                  <button
                    type="button"
                    className="execution-log-page-btn"
                    disabled={logOffset === 0}
                    onClick={() => setLogOffset((o) => Math.max(0, o - LOG_PAGE))}
                  >
                    上一页
                  </button>
                  <span className="execution-log-page-info">
                    {nodeLogFile.offset + 1}–
                    {nodeLogFile.offset + nodeLogFile.lines.length} / 共 {nodeLogFile.total} 行
                  </span>
                  <button
                    type="button"
                    className="execution-log-page-btn"
                    disabled={logOffset + LOG_PAGE >= nodeLogFile.total}
                    onClick={() => setLogOffset((o) => o + LOG_PAGE)}
                  >
                    下一页
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="execution-logs">
            {logLoading ? (
              <p className="execution-empty">加载日志中…</p>
            ) : nodeLogFile ? (
              nodeLogFile.lines.length === 0 ? (
                <p className="execution-empty">该节点无日志输出。</p>
              ) : (
                nodeLogFile.lines.map((line, i) => (
                  <div key={i} className="execution-log-line">
                    <span className="execution-log-lineno">{nodeLogFile.offset + i + 1}</span>
                    <span className="execution-log-text">{line}</span>
                  </div>
                ))
              )
            ) : fallbackLogs ? (
              fallbackLogs.length === 0 ? (
                <p className="execution-empty">Select an execution to view logs.</p>
              ) : (
                fallbackLogs.map((log) => (
                  <div
                    key={log.id ?? `${log.timestampMs}-${log.message}`}
                    className={`execution-log execution-log--${log.level}`}
                  >
                    <span className="execution-log-level">{log.level}</span>
                    {log.nodeId && (
                      <span className="execution-log-node">{nodeNameOf(log.nodeId)}</span>
                    )}
                    <span className="execution-log-message">{log.message}</span>
                  </div>
                ))
              )
            ) : (
              <p className="execution-empty">Select an execution to view logs.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
