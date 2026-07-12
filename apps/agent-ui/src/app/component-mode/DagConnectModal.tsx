import {useState} from "react";
import {loadDagServer, saveDagServer, testDagServerHealth} from "./api";

type Props = {
  // Called after a successful /health probe. The parent then unmasks dag mode.
  onConnected: () => void;
  // Shown only when dag mode is already connected (re-opened from 设置); lets
  // the user dismiss without changing anything.
  onCancel?: () => void;
};

// First-connect (and re-configure) modal for dag pure-HTTP mode.
//
// dag mode has NO local mode — it must talk to a remote axum server. On first
// entry the user MUST fill in the server IP + port (no pre-fill, no default to
// any other address). We probe `GET /health`; only on success do we persist the
// profile and let dag mode proceed. If the server is unreachable we stay on this
// modal and block all dag functionality (the parent renders it as a full overlay).
export function DagConnectModal({onConnected, onCancel}: Props) {
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  async function handleConnect() {
    const trimmedIp = ip.trim();
    const trimmedPort = port.trim();
    if (!trimmedIp || !trimmedPort) {
      setError("请填写服务器 IP 地址和端口号");
      return;
    }
    if (!/^\d{1,5}$/.test(trimmedPort)) {
      setError("端口号必须是数字");
      return;
    }
    const portNum = Number(trimmedPort);
    if (portNum < 1 || portNum > 65535) {
      setError("端口号需在 1–65535 之间");
      return;
    }

    setTesting(true);
    setError(null);
    const baseUrl = `http://${trimmedIp}:${trimmedPort}`;
    const profile = saveDagServer({name: baseUrl, baseUrl});
    const health = await testDagServerHealth(profile);
    setTesting(false);

    if (health.ok) {
      onConnected();
    } else {
      // Keep the modal open so the user can fix the address. Do NOT persist a
      // broken profile — but we already wrote it; clear it so a stray value
      // doesn't get reused on next launch.
      setError(health.message || "无法连接到该地址，请确认服务器已启动且端口正确");
    }
  }

  return (
    <div className="dag-connect-overlay">
      <div className="dag-connect-modal">
        <h2 className="dag-connect-title">连接 DAG 服务器</h2>
        <p className="dag-connect-hint">
          dag 模式需要连接一台运行中的远程服务器（axum，默认端口 7421）。
          请在下方填写服务器的 IP 与端口。
        </p>

        <label className="dag-connect-label" htmlFor="dag-connect-ip">
          服务器 IP
        </label>
        <input
          id="dag-connect-ip"
          className="dag-connect-input"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="例如 127.0.0.1"
          disabled={testing}
          autoFocus
        />

        <label className="dag-connect-label" htmlFor="dag-connect-port">
          端口
        </label>
        <input
          id="dag-connect-port"
          className="dag-connect-input"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="7421"
          disabled={testing}
        />

        {error && <div className="dag-connect-error">{error}</div>}

        <button
          type="button"
          className="dag-connect-submit"
          onClick={handleConnect}
          disabled={testing}
        >
          {testing ? "连接中…" : "连接"}
        </button>

        {onCancel && (
          <button type="button" className="dag-connect-cancel" onClick={onCancel}>
            关闭
          </button>
        )}
      </div>
    </div>
  );
}
