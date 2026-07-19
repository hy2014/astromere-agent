import {useCallback, useEffect, useState} from "react";
import {
  getNodeExecutions,
  listExecutions,
  previewNodeOutput,
  type OutputPreview,
} from "./api";
import type {NodeExecution} from "../../types";

export type DataPreviewModalProps = {
  dagId: string;
  nodeId: string;
  nodeLabel: string;
  onClose: () => void;
};

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * Node output-data preview modal:
 *  - Automatically locates the execution that most recently produced this
 *    node's outputs (iterates listExecutions DESC).
 *  - Top tab = each output port name; clicking a tab lazily loads the first
 *    100 rows of that output.
 *  - Table columns = column names, rows = values per column.
 */
export function DataPreviewModal({dagId, nodeId, nodeLabel, onClose}: DataPreviewModalProps) {
  const [outputKeys, setOutputKeys] = useState<string[]>([]);
  const [activeOutput, setActiveOutput] = useState<string | null>(null);
  const [preview, setPreview] = useState<OutputPreview | null>(null);
  const [cache, setCache] = useState<Record<string, OutputPreview>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noOutputs, setNoOutputs] = useState(false);
  const [executionId, setExecutionId] = useState<string | null>(null);

  // Locate the execution that most recently produced this node's outputs
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setOutputKeys([]);
      setActiveOutput(null);
      setPreview(null);
      setCache({});
      setError(null);
      setNoOutputs(false);
      setExecutionId(null);
      try {
        const executions = await listExecutions(dagId);
        for (const exec of executions) {
          const nes: NodeExecution[] = await getNodeExecutions(exec.id);
          const ne = nes.find(
            (n) => n.nodeId === nodeId && n.outputs && Object.keys(n.outputs).length > 0,
          );
          if (ne) {
            if (cancelled) return;
            const keys = Object.keys(ne.outputs as Record<string, unknown>);
            setExecutionId(exec.id);
            setOutputKeys(keys);
            setActiveOutput(keys[0] ?? null);
            return;
          }
        }
        if (!cancelled) setNoOutputs(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dagId, nodeId]);

  const loadPreview = useCallback(
    async (outputName: string) => {
      if (!executionId) return;
      if (cache[outputName]) {
        setPreview(cache[outputName]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const p = await previewNodeOutput(executionId, nodeId, outputName, 100);
        setCache((c) => ({...c, [outputName]: p}));
        setPreview(p);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPreview(null);
      } finally {
        setLoading(false);
      }
    },
    [executionId, nodeId, cache],
  );

  useEffect(() => {
    if (activeOutput) void loadPreview(activeOutput);
  }, [activeOutput, loadPreview]);

  return (
    <div className="data-preview-overlay" onClick={onClose}>
      <div className="data-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="data-preview-header">
          <span className="data-preview-title">数据预览 · {nodeLabel}</span>
          <button type="button" className="data-preview-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        {noOutputs ? (
          <div className="data-preview-empty">该节点暂无输出，请先成功运行此 DAG。</div>
        ) : outputKeys.length === 0 && loading ? (
          <div className="data-preview-empty">定位输出中…</div>
        ) : outputKeys.length === 0 ? (
          <div className="data-preview-empty">该节点执行未产生任何输出端口。</div>
        ) : (
          <>
            <div className="data-preview-tabs">
              {outputKeys.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`data-preview-tab ${k === activeOutput ? "active" : ""}`}
                  onClick={() => setActiveOutput(k)}
                >
                  {k}
                </button>
              ))}
            </div>
            <div className="data-preview-body">
              {loading ? (
                <div className="data-preview-empty">加载中…</div>
              ) : error ? (
                <div className="data-preview-error">{error}</div>
              ) : preview?.unsupported ? (
                <pre className="data-preview-unsupported">{preview.unsupported}</pre>
              ) : preview && preview.columns.length > 0 ? (
                <>
                  {preview.truncated && (
                    <div className="data-preview-truncated">仅显示前 100 行</div>
                  )}
                  <div className="data-preview-table-wrap">
                    <table className="data-preview-table">
                      <thead>
                        <tr>
                          {preview.columns.map((c) => (
                            <th key={c}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row, i) => (
                          <tr key={i}>
                            {preview.columns.map((c, ci) => (
                              <td key={c}>{formatCell(row[ci])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="data-preview-empty">该输出没有可预览的数据。</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
