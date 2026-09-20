import {useEffect, useState} from "react";
import {
  createDatabase,
  deleteDatabase,
  fetchDwSettings,
  listDatabases,
  loadDagServer,
  putDwSettings,
  saveDagServer,
  testDagServerHealth,
  testDatabase,
  updateDatabase,
} from "./api";
import {createRemoteProfileInput} from "../../runtime/profiles";
import type {DatabaseInfo, DatabaseTestResult, DwSettings} from "../../types";

type Props = {
  // Called after the user switched to a (health-verified) different server so
  // the parent can drop the stale connected state and reload everything.
  onServerChanged: () => void;
};

type SettingsTab = "server" | "dw" | "db";

const TAB_META: {key: SettingsTab; label: string; hint: string}[] = [
  {key: "server", label: "服务器连接", hint: "DAG 模式的执行服务器（本机侧配置）"},
  {key: "dw", label: "DW 数据仓库", hint: "组件输出落库根目录（服务器侧配置）"},
  {key: "db", label: "数据库", hint: "登记数据库连接，供写库组件引用（服务器侧配置）"},
];

// Form draft for the databases tab; port is a string until save.
type DbDraft = {
  name: string;
  host: string;
  port: string;
  dbname: string;
  user: string;
  password: string;
};

const emptyDbDraft = (): DbDraft => ({
  name: "",
  host: "",
  port: "5432",
  dbname: "",
  user: "",
  password: "",
});

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

  // ── db tab state ────────────────────────────────────────────────────
  // null dbList = still loading; dbDraft null = form closed.
  const [dbList, setDbList] = useState<DatabaseInfo[] | null>(null);
  const [dbStatus, setDbStatus] = useState<string | null>(null);
  const [dbDraft, setDbDraft] = useState<DbDraft | null>(null);
  const [dbEditingName, setDbEditingName] = useState<string | null>(null);
  const [dbSaving, setDbSaving] = useState(false);
  const [dbTestingName, setDbTestingName] = useState<string | null>(null);
  const [dbTestResults, setDbTestResults] = useState<Record<string, DatabaseTestResult>>({});

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
    void loadDatabases();
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
    void loadDatabases();
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

  // ── db tab logic ─────────────────────────────────────────────────────

  // On success only refresh the list; status is set by the calling action.
  async function loadDatabases(): Promise<void> {
    try {
      setDbList(await listDatabases());
    } catch (reason) {
      setDbList([]);
      setDbStatus(`数据库列表加载失败：${String(reason)}`);
    }
  }

  function startDbEdit(db: DatabaseInfo) {
    setDbEditingName(db.name);
    setDbDraft({
      name: db.name,
      host: db.host,
      port: String(db.port),
      dbname: db.dbname,
      user: db.user,
      password: "",
    });
  }

  function closeDbForm() {
    setDbDraft(null);
    setDbEditingName(null);
  }

  async function handleDbSave() {
    if (!dbDraft || dbSaving) return;
    const name = dbDraft.name.trim();
    const host = dbDraft.host.trim();
    const portStr = dbDraft.port.trim();
    const dbname = dbDraft.dbname.trim();
    const user = dbDraft.user.trim();
    if (!name || !host || !dbname || !user) {
      setDbStatus("名称、主机、数据库、用户名均为必填。");
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      setDbStatus("名称只能包含字母、数字、下划线、连字符。");
      return;
    }
    if (!/^\d{1,5}$/.test(portStr) || Number(portStr) < 1 || Number(portStr) > 65535) {
      setDbStatus("端口需在 1–65535 之间。");
      return;
    }
    const input = {name, host, port: Number(portStr), dbname, user, password: dbDraft.password};
    setDbSaving(true);
    try {
      if (dbEditingName) {
        await updateDatabase(dbEditingName, input);
        setDbStatus(`已更新数据库 ${name} 的登记。`);
      } else {
        await createDatabase(input);
        setDbStatus(`已登记数据库 ${name}，可点击列表中的“测试连接”验证。`);
      }
      closeDbForm();
      await loadDatabases();
    } catch (reason) {
      setDbStatus(`保存失败：${String(reason)}`);
    } finally {
      setDbSaving(false);
    }
  }

  async function handleDbDelete(name: string) {
    if (!window.confirm(`确定删除数据库 ${name} 的登记？`)) return;
    try {
      await deleteDatabase(name);
      setDbStatus(`已删除数据库 ${name} 的登记。`);
      await loadDatabases();
    } catch (reason) {
      setDbStatus(`删除失败：${String(reason)}`);
    }
  }

  async function handleDbTest(name: string) {
    if (dbTestingName) return;
    setDbTestingName(name);
    try {
      const result = await testDatabase(name);
      setDbTestResults((prev) => ({...prev, [name]: result}));
    } catch (reason) {
      setDbTestResults((prev) => ({...prev, [name]: {ok: false, message: String(reason)}}));
    } finally {
      setDbTestingName(null);
    }
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

  const renderDbPanel = (): JSX.Element => (
    <section className="dag-settings-panel">
      <header className="dag-settings-panel-header">
        <h3>数据库</h3>
        <p>
          登记数据库连接（地址、账号、密码保存在服务器上），供 update-table 等写库组件按名称引用。
          密码不会出现在节点配置或 DAG 定义里；编辑时密码留空表示沿用已保存的密码。
        </p>
      </header>

      {dbList === null ? (
        <p className="dag-connect-status">正在从服务器加载已登记的数据库…</p>
      ) : (
        <div className="dag-db-list">
          {dbList.length === 0 && <p className="dag-db-empty">尚未登记任何数据库</p>}
          {dbList.map((db) => (
            <div key={db.name} className="dag-db-row">
              <div className="dag-db-row-main">
                <strong>{db.name}</strong>
                <span className="dag-db-row-conn">{`${db.user}@${db.host}:${db.port}/${db.dbname}`}</span>
              </div>
              <div className="dag-db-row-actions">
                <button type="button" onClick={() => void handleDbTest(db.name)} disabled={dbTestingName !== null}>
                  {dbTestingName === db.name ? "测试中…" : "测试连接"}
                </button>
                <button type="button" onClick={() => startDbEdit(db)}>编辑</button>
                <button type="button" onClick={() => void handleDbDelete(db.name)}>删除</button>
              </div>
              {dbTestResults[db.name] && (
                <div className={dbTestResults[db.name].ok ? "dag-db-test-ok" : "dag-db-test-fail"}>
                  {dbTestResults[db.name].ok
                    ? "连接成功 ✓"
                    : `连接失败：${dbTestResults[db.name].message}`}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {dbDraft ? (
        <div className="dag-settings-form">
          <div className="dag-settings-field-row">
            <label className="dag-connect-label" htmlFor="dag-db-name">名称</label>
            <input
              id="dag-db-name"
              className="dag-connect-input"
              value={dbDraft.name}
              placeholder="例如 dw-main"
              disabled={dbEditingName !== null}
              onChange={(e) => setDbDraft({...dbDraft, name: e.target.value})}
            />
          </div>
          <div className="dag-settings-field-row">
            <label className="dag-connect-label" htmlFor="dag-db-host">主机</label>
            <input
              id="dag-db-host"
              className="dag-connect-input"
              value={dbDraft.host}
              placeholder="例如 192.168.1.50"
              onChange={(e) => setDbDraft({...dbDraft, host: e.target.value})}
            />
          </div>
          <div className="dag-settings-field-row">
            <label className="dag-connect-label" htmlFor="dag-db-port">端口</label>
            <input
              id="dag-db-port"
              className="dag-connect-input"
              value={dbDraft.port}
              placeholder="5432"
              onChange={(e) => setDbDraft({...dbDraft, port: e.target.value})}
            />
          </div>
          <div className="dag-settings-field-row">
            <label className="dag-connect-label" htmlFor="dag-db-name-only">数据库</label>
            <input
              id="dag-db-name-only"
              className="dag-connect-input"
              value={dbDraft.dbname}
              placeholder="目标数据库名"
              onChange={(e) => setDbDraft({...dbDraft, dbname: e.target.value})}
            />
          </div>
          <div className="dag-settings-field-row">
            <label className="dag-connect-label" htmlFor="dag-db-user">用户名</label>
            <input
              id="dag-db-user"
              className="dag-connect-input"
              value={dbDraft.user}
              onChange={(e) => setDbDraft({...dbDraft, user: e.target.value})}
            />
          </div>
          <div className="dag-settings-field-row">
            <label className="dag-connect-label" htmlFor="dag-db-password">密码</label>
            <input
              id="dag-db-password"
              type="password"
              className="dag-connect-input"
              value={dbDraft.password}
              placeholder={dbEditingName ? "留空表示沿用已保存的密码" : "数据库密码"}
              onChange={(e) => setDbDraft({...dbDraft, password: e.target.value})}
            />
          </div>
          <div className="dag-settings-actions">
            <button type="button" className="dag-connect-cancel" onClick={closeDbForm} disabled={dbSaving}>
              取消
            </button>
            <button type="button" className="dag-connect-submit dag-settings-primary" onClick={handleDbSave} disabled={dbSaving}>
              {dbSaving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      ) : (
        <div className="dag-settings-actions">
          <button type="button" className="dag-connect-submit dag-settings-primary" onClick={() => {setDbEditingName(null); setDbDraft(emptyDbDraft());}}>
            新增数据库
          </button>
        </div>
      )}

      {dbStatus && <p className="dag-connect-status">{dbStatus}</p>}
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
        {tab === "server" ? renderServerPanel() : tab === "dw" ? renderDwPanel() : renderDbPanel()}
      </section>
    </div>
  );
}
