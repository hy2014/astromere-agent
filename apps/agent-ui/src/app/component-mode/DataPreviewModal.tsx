import {useCallback, useEffect, useRef, useState} from "react";
import {
  downloadNodeOutput,
  getNodeExecutions,
  listExecutions,
  previewNodeOutput,
  type DownloadHandle,
  type DownloadProgress,
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

type DownloadZoneProps = {
  downloading: boolean;
  progress: DownloadProgress | null;
  error: string | null;
  savedPath: string | null;
  canDownload: boolean;
  compact?: boolean;
  /** Independent copy-feedback state for the "复制路径" button. Pass `undefined` to hide it (e.g. browser mode where we only know the download folder name, not a real path). */
  copiedLocal?: boolean;
  onStart: () => void;
  onCancel: () => void;
  onCopySaved: (p: string) => void;
};

function DownloadZone({
  downloading,
  progress,
  error,
  savedPath,
  canDownload,
  compact,
  copiedLocal,
  onStart,
  onCancel,
  onCopySaved,
}: DownloadZoneProps) {
  // --- Downloading state: progress bar + cancel button ---
  if (downloading) {
    const percent = progress?.percent ?? null;
    const loaded = progress?.loaded ?? 0;
    const total = progress?.total ?? null;
    return (
      <div className={`data-preview-download-zone ${compact ? "compact" : ""}`}>
        <div className="data-preview-download-progress-wrap">
          <div className="data-preview-download-progress-bar">
            <div
              className="data-preview-download-progress-fill"
              style={{width: percent != null ? `${percent}%` : "0%"}}
            />
          </div>
          <span className="data-preview-download-percent">
            {percent != null
              ? `${percent}%`
              : formatBytes(loaded) + (total != null ? ` / ${formatBytes(total)}` : "")}
          </span>
        </div>
        <div className="data-preview-download-meta">
          {total != null
            ? `${formatBytes(loaded)} / ${formatBytes(total)}`
            : `已下载 ${formatBytes(loaded)}`}
        </div>
        <button
          type="button"
          className="data-preview-copy-btn"
          onClick={onCancel}
          title="取消下载"
        >
          ✕ 取消
        </button>
      </div>
    );
  }

  // --- Downloaded state: show where the file landed ---
  if (savedPath) {
    return (
      <div className={`data-preview-download-zone success ${compact ? "compact" : ""}`}>
        <span className="data-preview-download-success">✓ 已保存到</span>
        <span className="data-preview-download-savedpath" title={savedPath}>
          {savedPath}
        </span>
        {copiedLocal !== undefined && (
          <button
            type="button"
            className="data-preview-copy-btn"
            onClick={() => onCopySaved(savedPath)}
            title="复制保存路径"
          >
            {copiedLocal ? "✓ 已复制" : "复制路径"}
          </button>
        )}
      </div>
    );
  }

  // --- Idle state: big download button ---
  return (
    <div className={`data-preview-download-zone ${compact ? "compact" : ""}`}>
      {error && (
        <span className="data-preview-download-error" title={error}>
          ⚠ {error}
        </span>
      )}
      <button
        type="button"
        className="data-preview-copy-btn data-preview-download-btn"
        disabled={!canDownload}
        onClick={onStart}
        title="下载原始文件到本地"
      >
        ⬇ 下载
      </button>
    </div>
  );
}

export function DataPreviewModal({dagId, nodeId, nodeLabel, onClose}: DataPreviewModalProps) {
  const isTauri = typeof window !== "undefined" && "__TAURI__" in (window as any);
  const [outputKeys, setOutputKeys] = useState<string[]>([]);
  const [activeOutput, setActiveOutput] = useState<string | null>(null);
  const [preview, setPreview] = useState<OutputPreview | null>(null);
  const [cache, setCache] = useState<Record<string, OutputPreview>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noOutputs, setNoOutputs] = useState(false);
  const [executionId, setExecutionId] = useState<string | null>(null);
  // Two independent copy-feedback flags — two different buttons copy two
  // completely different things (remote server path vs local saved path).
  const [copiedRemote, setCopiedRemote] = useState(false);
  const [copiedLocal, setCopiedLocal] = useState(false);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }, []);

  const handleCopyRemotePath = useCallback(async (path: string) => {
    await copyText(path);
    setCopiedRemote(true);
    setTimeout(() => setCopiedRemote(false), 1500);
  }, [copyText]);

  const handleCopySavedPath = useCallback(async (path: string) => {
    await copyText(path);
    setCopiedLocal(true);
    setTimeout(() => setCopiedLocal(false), 1500);
  }, [copyText]);

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloadPath, setDownloadPath] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const downloadHandleRef = useRef<DownloadHandle | null>(null);

  const handleCancelDownload = useCallback(() => {
    downloadHandleRef.current?.abort();
    downloadHandleRef.current = null;
    setDownloading(false);
    setDownloadProgress(null);
  }, []);

  const handleDownload = useCallback(async (outputName: string) => {
    if (!executionId) return;
    setDownloadError(null);
    setDownloadPath(null);
    setDownloadProgress(null);
    setDownloading(true);
    try {
      const handle = downloadNodeOutput(executionId, nodeId, outputName);
      downloadHandleRef.current = handle;
      handle.onProgress(setDownloadProgress);
      const finalPath = await handle.promise;
      setDownloadPath(finalPath);
    } catch (e: any) {
      // User cancelled via Save-As dialog or AbortController — don't surface
      // as a red error, just reset state.
      if (e?.name === "AbortError" || /取消/.test(e?.message ?? "")) {
        // silent
      } else {
        setDownloadError(e?.message ?? "下载失败");
      }
    } finally {
      downloadHandleRef.current = null;
      setDownloading(false);
    }
  }, [executionId, nodeId]);

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
                <div className="data-preview-unsupported-wrap">
                  <pre className="data-preview-unsupported">{preview.unsupported}</pre>
                  <DownloadZone
                    downloading={downloading}
                    progress={downloadProgress}
                    error={downloadError}
                    savedPath={downloadPath}
                    canDownload={!!executionId}
                    copiedLocal={isTauri ? copiedLocal : undefined}
                    onStart={() => handleDownload(preview.outputName)}
                    onCancel={handleCancelDownload}
                    onCopySaved={handleCopySavedPath}
                  />
                </div>
              ) : preview && preview.columns.length > 0 ? (
                <>
                  <div className="data-preview-info-bar">
                    {preview.truncated && (
                      <span className="data-preview-truncated">
                        仅显示前 {preview.rows.length} 行
                        {preview.total != null && <>（共 {preview.total.toLocaleString()} 行）</>}
                      </span>
                    )}
                    <span className="data-preview-filepath" title={preview.filePath}>
                      📄 {preview.filePath}
                    </span>
                    <button
                      type="button"
                      className="data-preview-copy-btn"
                      onClick={() => handleCopyRemotePath(preview.filePath)}
                      title="复制远程服务器文件路径"
                    >
                      {copiedRemote ? "✓ 已复制" : "复制"}
                    </button>
                  </div>
                  <DownloadZone
                    downloading={downloading}
                    progress={downloadProgress}
                    error={downloadError}
                    savedPath={downloadPath}
                    canDownload={!!executionId}
                    copiedLocal={isTauri ? copiedLocal : undefined}
                    onStart={() => handleDownload(preview.outputName)}
                    onCancel={handleCancelDownload}
                    onCopySaved={handleCopySavedPath}
                    compact
                  />
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
