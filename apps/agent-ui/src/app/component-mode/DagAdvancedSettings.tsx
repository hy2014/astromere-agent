import {useEffect, useState} from "react";
import {
  fetchDwSettings,
  loadDagServer,
  putDwSettings,
  saveDagServer,
  testDagServerHealth,
} from "./api";
import {createRemoteProfileInput} from "../../runtime/profiles";
import type {DwSettings} from "../../types";

type Props = {
  // Called after the user switched to a (health-verified) different server so
  // the parent can drop the stale connected state and reload everything.
  onServerChanged: () => void;
};

type SettingsTab = "server" | "dw";

const TAB_META: {key: SettingsTab; label: string; hint: string}[] = [
  {key: "server", label: "服务器连接", hint: "DAG 模式的执行服务器（本机侧配置）"},
  {key: "dw", label: "DW 数据仓库", hint: "组件输出落库根目录（服务器侧配置）"},
];

// Advanced settings view for dag mode, rendered INSIDE the component-mode
// center area (left function menu stays visible; the parent toolbar owns the
// back button and title).
//
// Layout: left tab nav + content panel. Each tab is a standalone settings
// panel; add future server-side configs (which are fetched from the connected
// dag server over HTTP, like /dw/settings) as new tabs here.
export function DagAdvancedSettings({onServerChanged}: Props) {
  const [tab, setTab] = useState<SettingsTab>("server");

  // ── server tab state ────────────────────────────────────────────────
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("");
  const [currentBaseUrl, setCurrentBaseUrl] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  // ── dw tab state ────────────────────────────────────────────────────
  const [dwSaved, setDwSaved] = useState<DwSettings | null>(null);
  const [dwDraft, setDwDraft] = useState<DwSettings | null>(null);
  const [dwStatus, setDwStatus] = useState<string | null>(null);
  const [dwSaving, setDwSaving] = useState(false);

  const parseBaseUrl = (baseUrl: string | undefined): {ip: string; port: string} | null => {
    const m = baseUrl?.match(/^https?:\/\/([^/:]+?)(?::(\d+))?\/?$/);
    if (!m) return null;
    return {ip: m[1], port: m[2] ?? "7421"};
  };

  useEffect(() => {
    const profile = loadDagServer();
    setCurrentBaseUrl(profile?.baseUrl ?? null);
    const parsed = parseBaseUrl(profile?.baseUrl);
    if (parsed) {
      setIp(parsed.ip);
      setPort(parsed.port);
    }
    void loadDw();
  }, []);

  async function loadDw(): Promise<void> {
    setDwStatus("正在从服务器加载 DW 配置…");
    try {
      const settings = await fetchDwSettings();
      setDwSaved(settings);
      setDwDraft(settings);
      setDwStatus("");
    } catch (reason) {
      setDwSaved(null);
      setDwDraft(null);
      setDwStatus(`DW 配置加载失败：${String(reason)}`);
    }
  }

  // Build a profile from the form fields and probe it, without persisting.
  async function probe(): Promise<boolean> {
    const trimmedIp = ip.trim();
    const trimmedPort = port.trim();
    if (!trimmedIp || !trimmedPort) {
      setServerError("请填写服务器 IP 地址和端口号");
      return false;
    }
    if (!/^\d{1,5}$/.test(trimmedPort)) {
      setServerError("端口号必须是数字");
      return false;
    }
    const portNum = Number(trimmedPort);
    if (portNum < 1 || portNum > 65535) {
      setServerError("端口号需在 1–65535 之间");
      return false;
    }
    setServerError(null);
    setProbing(true);
    setServerStatus(null);
    try {
      const baseUrl = `http://${trimmedIp}:${trimmedPort}`;
      const health = await testDagServerHealth(createRemoteProfileInput({name: baseUrl, baseUrl}));
      setProbing(false);
      if (health.ok) return true;
      setServerError(health.message || "无法连接到该地址，请确认服务器已启动且端口正确");
      return false;
    } catch (reason) {
      setProbing(false);
      setServerError(String(reason));
      return false;
    }
  }

  async function handleTestServer() {
    if (await probe()) {
      setServerStatus("连接正常 ✓");
    }
  }

  async function handleSaveServer() {
    if (!(await probe())) return;
    const baseUrl = `http://${ip.trim()}:${port.trim()}`;
    saveDagServer({name: baseUrl, baseUrl});
    setCurrentBaseUrl(baseUrl);
    setServerStatus("已保存。组件与 DAG 列表将自动从新服务器重新加载。");
    onServerChanged();
    // Server (possibly a new machine) changed — reload server-side settings.
    void loadDw();
  }

  const dwDirty = Boolean(
    dwSaved && dwDraft && JSON.stringify(dwSaved) !== JSON.stringify(dwDraft),
  );

  async function handleDwSave() {
    if (!dwDraft || dwSaving) return;
    setDwSaving(true);
    try {
      const saved = await putDwSettings(dwDraft);
      setDwSaved(saved);
      setDwDraft(saved);
      // New executions freeze the saved dw_root into their snapshot at submit
      // time; running executions keep the value they were submitted with.
      setDwStatus("已保存。新提交的 DAG 执行将使用此 dw_root。");
    } catch (reason) {
      setDwStatus(`保存失败：${String(reason)}`);
    } finally {
      setDwSaving(false);
    }
  }

  function discardDw() {
    if (!dwSaved) return;
    setDwDraft(dwSaved);
    setDwStatus("已放弃未保存的修改。");
  }

  const renderServerPanel = (): JSX.Element => (
    <section className="dag-settings-panel">
      <header className="dag-settings-panel-header">
        <h3>服务器连接</h3>
        <p>
          DAG 模式的组件注册、DAG 执行、数据预览都发生在远程服务器上。
          当前地址：<code>{currentBaseUrl ?? "未连接"}</code>
        </p>
      </header>

      <div className="dag-settings-form">
        <div className="dag-settings-field-row">
          <label className="dag-connect-label" htmlFor="dag-settings-ip">服务器 IP</label>
          <input
            id="dag-settings-ip"
            className="dag-connect-input"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="例如 127.0.0.1"
            disabled={probing}
          />
        </div>

        <div className="dag-settings-field-row">
          <label className="dag-connect-label" htmlFor="dag-settings-port">端口</label>
          <input
            id="dag-settings-port"
            className="dag-connect-input"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="7421"
            disabled={probing}
          />
        </div>
      </div>

      {serverError && <div className="dag-connect-error">{serverError}</div>}

      <div className="dag-settings-actions">
        <button type="button" className="dag-connect-cancel" onClick={handleTestServer} disabled={probing}>
          {probing ? "检测中…" : "测试连接"}
        </button>
        <button type="button" className="dag-connect-submit dag-settings-primary" onClick={handleSaveServer} disabled={probing}>
          {probing ? "保存中…" : "保存并切换"}
        </button>
      </div>

      {serverStatus && <p className="dag-connect-status">{serverStatus}</p>}
    </section>
  );

  const renderDwPanel = (): JSX.Element => (
    <section className="dag-settings-panel">
      <header className="dag-settings-panel-header">
        <h3>DW 数据仓库</h3>
        <p>
          节点配置中开启"注册到DW"并选择输出端口后，该端口的数据文件在执行时直接写入{" "}
          <code>{`{dw_root}/{表名}/`}</code>
          。该路径位于服务器（worker 所在机器）上；保存后新提交的执行在提交时冻结此值。
        </p>
      </header>

      <div className="dag-settings-form">
        <div className="dag-settings-field-row">
          <label className="dag-connect-label" htmlFor="dag-settings-dw-root">dw_root</label>
          <input
            id="dag-settings-dw-root"
            className="dag-connect-input"
            value={dwDraft?.dwRoot ?? ""}
            placeholder="/opt/agent-ui/dw"
            onChange={(e) => setDwDraft({dwRoot: (e.target as HTMLInputElement).value})}
          />
        </div>
      </div>

      <div className="dag-settings-actions">
        <button type="button" className="dag-connect-cancel" onClick={discardDw} disabled={!dwDirty || dwSaving}>
          放弃修改
        </button>
        <button type="button" className="dag-connect-submit dag-settings-primary" onClick={handleDwSave} disabled={!dwDirty || dwSaving}>
          {dwSaving ? "保存中…" : "保存 DW 配置"}
        </button>
      </div>

      {dwStatus && <p className="dag-connect-status">{dwStatus}</p>}
    </section>
  );

  return (
    <div className="dag-settings-view">
      <nav className="dag-settings-nav" aria-label="设置分组">
        {TAB_META.map(({key, label, hint}) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
            title={hint}
          >
            <strong>{label}</strong>
            <span>{hint}</span>
          </button>
        ))}
      </nav>

      <section className="dag-settings-content">
        {tab === "server" ? renderServerPanel() : renderDwPanel()}
      </section>
    </div>
  );
}
