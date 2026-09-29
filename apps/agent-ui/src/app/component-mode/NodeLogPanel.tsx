import {useCallback, useEffect, useState} from "react";
import type {ExecutionLog, NodeLogFile} from "../../types";
import {getExecutionLogs, getNodeLog} from "./api";

/** 要看哪个节点、哪一次运行的日志。 */
export type NodeLogTarget = {
  executionId: string;
  nodeId: string;
  nodeName: string;
};

export type NodeLogPanelProps = {
  target: NodeLogTarget;
  onBack: () => void;
};

const LOG_PAGE = 2000;

/**
 * 节点运行日志：占据最右侧属性栏，由「各节点状态 → 详情 → 查看」进入。
 * 优先读落盘日志文件（分页），文件不存在时回落到 DB 日志（文件日志上线前的旧运行）。
 */
export function NodeLogPanel({target, onBack}: NodeLogPanelProps) {
  const [nodeLogFile, setNodeLogFile] = useState<NodeLogFile | null>(null);
  const [fallbackLogs, setFallbackLogs] = useState<ExecutionLog[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  // 换节点/换运行 → 回到第一页。
  useEffect(() => {
    setOffset(0);
  }, [target.executionId, target.nodeId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setNodeLogFile(await getNodeLog(target.executionId, target.nodeId, offset, LOG_PAGE));
      setFallbackLogs(null);
    } catch {
      // 落盘日志读不到 → 回落到 DB 日志。
      try {
        setFallbackLogs(await getExecutionLogs(target.executionId));
        setNodeLogFile(null);
      } catch {
        setFallbackLogs(null);
        setNodeLogFile(null);
      }
    } finally {
      setLoading(false);
    }
  }, [target.executionId, target.nodeId, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="node-log-panel">
      <div className="node-log-panel-header">
        <button type="button" className="node-log-panel-back" onClick={onBack} title="返回属性面板">
          ← 返回
        </button>
        <span className="node-log-panel-title" title={target.nodeName}>
          {target.nodeName}
        </span>
      </div>

      <div className="node-log-panel-toolbar">
        {nodeLogFile && nodeLogFile.total > LOG_PAGE ? (
          <>
            <select
              className="execution-log-page-select"
              value={Math.floor(offset / LOG_PAGE)}
              onChange={(e) => setOffset(Number(e.target.value) * LOG_PAGE)}
            >
              {Array.from(
                {length: Math.ceil(nodeLogFile.total / LOG_PAGE)},
                (_, i) => (
                  <option key={i} value={i}>
                    第 {i + 1} 页
                  </option>
                ),
              )}
            </select>
            <span className="execution-log-page-info">
              {nodeLogFile.offset + 1}–{nodeLogFile.offset + nodeLogFile.lines.length} / 共{" "}
              {nodeLogFile.total} 行
            </span>
          </>
        ) : nodeLogFile ? (
          <span className="execution-log-page-info">共 {nodeLogFile.total} 行</span>
        ) : null}
      </div>

      <div className="execution-logs">
        {loading ? (
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
            <p className="execution-empty">该节点无日志输出。</p>
          ) : (
            fallbackLogs.map((log) => (
              <div
                key={log.id ?? `${log.timestampMs}-${log.message}`}
                className={`execution-log execution-log--${log.level}`}
              >
                <span className="execution-log-level">{log.level}</span>
                <span className="execution-log-message">{log.message}</span>
              </div>
            ))
          )
        ) : (
          <p className="execution-empty">该节点无日志输出。</p>
        )}
      </div>
    </div>
  );
}
