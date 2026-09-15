/* @checkFns dw-form-card */
import {useEffect, useState} from "react";
import type {DwSettings} from "../../types";
import {loadDwSettings, saveDwSettings} from "../../runtime";
import {render} from "../../core/dep";

// ─── WriteState ───────────────────────────────────────────────────────
const WriteState: {
  setSaved: (s: DwSettings | null) => void;
  setDraft: (s: DwSettings | null | ((prev: DwSettings | null) => DwSettings | null)) => void;
  setStatus: (s: string) => void;
  setIsSaving: (v: boolean) => void;
} = {} as any;

// ─── File-level business functions ────────────────────────────────────

async function loadSettings(getIsCancelled: () => boolean): Promise<void> {
  WriteState.setStatus("Loading DW settings...");
  try {
    const settings = await loadDwSettings();
    if (getIsCancelled()) return;
    WriteState.setSaved(settings);
    WriteState.setDraft(settings);
    WriteState.setStatus("DW settings loaded.");
  } catch (reason) {
    if (!getIsCancelled()) {
      WriteState.setStatus(`Failed to load DW settings: ${String(reason)}`);
    }
  }
}

const loadSettingsWithCleanup = (): (() => void) => {
  let cancelled = false;
  void loadSettings(() => cancelled);
  return () => { cancelled = true; };
};

function updateDwRoot(value: string): void {
  WriteState.setDraft((settings) => (settings ? {...settings, dwRoot: value} : settings));
}

async function handleSave(draft: DwSettings | null, isSaving: boolean): Promise<void> {
  if (!draft || isSaving) return;
  WriteState.setIsSaving(true);
  WriteState.setStatus("Saving DW settings...");
  try {
    const saved = await saveDwSettings(draft);
    WriteState.setSaved(saved);
    WriteState.setDraft(saved);
    // New executions freeze the saved dw_root into their snapshot; running
    // executions keep the value they were submitted with.
    WriteState.setStatus("Saved. New DAG executions will write DW outputs under this root.");
  } catch (reason) {
    WriteState.setStatus(`Save failed: ${String(reason)}`);
  } finally {
    WriteState.setIsSaving(false);
  }
}

function discard(saved: DwSettings | null): void {
  if (!saved) return;
  WriteState.setDraft(saved);
  WriteState.setStatus("Discarded unsaved settings.");
}

// ─── renderFn functions ───────────────────────────────────────────────

function renderDwFormCard(
  {saved, draft, isSaving, status}: {
    saved: DwSettings | null;
    draft: DwSettings | null;
    isSaving: boolean;
    status: string;
  },
  {}: Record<string, never>,
  {updateDwRoot, handleSave, discard}: {
    updateDwRoot: (value: string) => void;
    handleSave: (draft: DwSettings | null, isSaving: boolean) => Promise<void>;
    discard: (saved: DwSettings | null) => void;
  },
): JSX.Element {
  const hasUnsavedChanges = Boolean(
    saved && draft && JSON.stringify(saved) !== JSON.stringify(draft),
  );

  return (
    <section className="settings-card remote-settings-card dw-form-card">
      <header className="settings-card-header">
        <div className="settings-card-title">
          <h3>DW 根目录</h3>
          <p>
            注册到 DW 的组件输出会写入{" "}
            <code>{`{dw_root}/{表名}/`}</code>
            。该路径位于执行 worker 所在机器。
          </p>
        </div>
      </header>

      <div className="remote-profile-form">
        <label className="remote-field remote-field-url">
          <span>dw_root</span>
          <input
            value={draft?.dwRoot ?? ""}
            placeholder="/opt/agent-ui/dw"
            onChange={(e) => updateDwRoot((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <div className="remote-settings-actions">
        <button
          className="remote-button primary"
          type="button"
          onClick={() => handleSave(draft, isSaving)}
          disabled={!hasUnsavedChanges || isSaving}
        >
          {isSaving ? "Saving..." : "Save Changes"}
        </button>
        <button
          className="remote-button ghost"
          type="button"
          onClick={() => discard(saved)}
          disabled={!hasUnsavedChanges || isSaving}
        >
          Discard
        </button>
      </div>

      <p className="settings-status">{status}</p>
    </section>
  );
}

// ─── View component ───────────────────────────────────────────────────

export function DwSettingsPanelView() {
  const [saved, setSaved] = useState<DwSettings | null>(null);
  const [draft, setDraft] = useState<DwSettings | null>(null);
  const [status, setStatus] = useState<string>("Loading DW settings...");
  const [isSaving, setIsSaving] = useState(false);

  // WriteState registrations
  WriteState.setSaved = setSaved;
  WriteState.setDraft = setDraft;
  WriteState.setStatus = setStatus;
  WriteState.setIsSaving = setIsSaving;

  useEffect(() => loadSettingsWithCleanup(), []);

  return (
    <>
      <header className="settings-heading">
        <h2>数据仓库（DW）</h2>
        <p>
          配置 DW 根目录。节点配置面板中开启“注册到DW”并选择输出端口后，
          该端口的数据文件在执行时直接写入此目录下的对应表目录。
        </p>
      </header>

      {render({
        state: {saved, draft, isSaving, status},
        props: {},
        fn: renderDwFormCard,
        events: {updateDwRoot, handleSave, discard},
        memo: {},
      })}
    </>
  );
}
