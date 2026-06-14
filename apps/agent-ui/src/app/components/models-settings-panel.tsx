/* @checkFns models-settings-content */
import {useEffect, useState} from "react";
import type {ModelEndpointConfig, ModelSettings} from "../../types";
import {loadDeepseekPricing} from "../../runtime";
import {loadModelSettings, saveModelSettings, testModelConnection} from "../../runtime";
import {render} from "../../core/dep";

// ─── WriteState ─────────────────────────────────────────────────────────
const WriteState: {
  setSavedSettings: (s: ModelSettings | null) => void;
  setDraftSettings: (s: ModelSettings | null | ((prev: ModelSettings | null) => ModelSettings | null)) => void;
  setSelectedModelId: (s: string) => void;
  setStatus: (s: string) => void;
  setShowApiKey: (v: boolean | ((prev: boolean) => boolean)) => void;
  setIsSaving: (v: boolean) => void;
  setIsTesting: (v: boolean) => void;
} = {} as any;

// ─── File-level business functions ──────────────────────────────────────

async function loadSettings(getIsCancelled: () => boolean): Promise<void> {
  WriteState.setStatus("Loading model settings...");
  try {
    const settings = await loadModelSettings();
    if (getIsCancelled()) return;
    let finalSettings = settings;
    try {
      const pricing = await loadDeepseekPricing();
      if (pricing) {
        finalSettings = {...settings, deepseekPricing: pricing};
      }
    } catch {}
    if (getIsCancelled()) return;
    WriteState.setSavedSettings(finalSettings);
    WriteState.setDraftSettings(finalSettings);
    WriteState.setSelectedModelId(finalSettings.activeModelId);
    WriteState.setStatus("Model settings loaded.");
  } catch (reason) {
    if (!getIsCancelled()) {
      WriteState.setStatus(`Failed to load model settings: ${String(reason)}`);
    }
  }
}

const loadSettingsWithCleanup = (): (() => void) => {
  let cancelled = false;
  void loadSettings(() => cancelled);
  return () => { cancelled = true; };
};

function selectModel(id: string): void {
  WriteState.setSelectedModelId(id);
  WriteState.setDraftSettings((settings) =>
    settings ? {...settings, activeModelId: id} : settings,
  );
  WriteState.setStatus("Active model changed. Save changes to apply it to future turns.");
}

function updateSelectedModel(
  updater: (model: ModelEndpointConfig) => ModelEndpointConfig,
): void {
  WriteState.setDraftSettings((settings) => {
    if (!settings) return settings;
    const selectedModelId = settings.activeModelId;
    return {
      ...settings,
      models: settings.models.map((model) =>
        model.id === selectedModelId ? updater(model) : model,
      ),
    };
  });
}

async function handleSaveSettings(
  draftSettings: ModelSettings | null,
  isSaving: boolean,
): Promise<void> {
  if (!draftSettings || isSaving) return;
  WriteState.setIsSaving(true);
  WriteState.setStatus("Saving model settings...");
  try {
    const saved = await saveModelSettings(draftSettings);
    WriteState.setSavedSettings(saved);
    WriteState.setDraftSettings(saved);
    WriteState.setSelectedModelId(saved.activeModelId);
    WriteState.setStatus("Saved. Future agent turns will use the active model configuration.");
  } catch (reason) {
    WriteState.setStatus(`Save failed: ${String(reason)}`);
  } finally {
    WriteState.setIsSaving(false);
  }
}

function discardSettings(savedSettings: ModelSettings | null): void {
  if (!savedSettings) return;
  WriteState.setDraftSettings(savedSettings);
  WriteState.setSelectedModelId(savedSettings.activeModelId);
  WriteState.setStatus("Discarded unsaved settings.");
}

async function handleTestConnection(
  draftSettings: ModelSettings | null,
  isTesting: boolean,
): Promise<void> {
  if (!draftSettings || isTesting) return;
  WriteState.setIsTesting(true);
  WriteState.setStatus("Testing active model connection...");
  try {
    const result = await testModelConnection(draftSettings);
    WriteState.setStatus(
      result.ok
        ? `${result.message} (${result.model})`
        : `${result.message}${result.stderr ? `: ${result.stderr}` : ""}`,
    );
  } catch (reason) {
    WriteState.setStatus(`Connection test failed: ${String(reason)}`);
  } finally {
    WriteState.setIsTesting(false);
  }
}

function toggleShowApiKey(): void {
  WriteState.setShowApiKey((value) => !value);
}

// ─── renderFn functions ───────────────────────────────────────────────

function renderModelsSettingsPanel(
  {savedSettings, draftSettings, selectedModelId, showApiKey, isSaving, isTesting, status}: {
    savedSettings: ModelSettings | null;
    draftSettings: ModelSettings | null;
    selectedModelId: string;
    showApiKey: boolean;
    isSaving: boolean;
    isTesting: boolean;
    status: string;
  },
  {}: Record<string, never>,
  {selectModel, updateSelectedModel, handleSaveSettings, discardSettings, handleTestConnection, toggleShowApiKey}: {
    selectModel: (id: string) => void;
    updateSelectedModel: (updater: (model: ModelEndpointConfig) => ModelEndpointConfig) => void;
    handleSaveSettings: (draftSettings: ModelSettings | null, isSaving: boolean) => Promise<void>;
    discardSettings: (savedSettings: ModelSettings | null) => void;
    handleTestConnection: (draftSettings: ModelSettings | null, isTesting: boolean) => Promise<void>;
    toggleShowApiKey: () => void;
  },
): JSX.Element {
  const activeModel =
    draftSettings?.models.find((model) => model.id === selectedModelId) ??
    draftSettings?.models[0] ??
    null;
  const hasUnsavedChanges = Boolean(
    savedSettings &&
    draftSettings &&
    JSON.stringify(savedSettings) !== JSON.stringify(draftSettings),
  );

  return (
    <div className="models-settings-content">
      <header className="settings-heading">
        <h2>Models configuration</h2>
        <p>
          Manage large language model endpoints, API credentials, and
          performance parameters.
        </p>
      </header>

      <div className="model-grid">
        {draftSettings?.models.map((model) => {
          const isActive = selectedModelId === model.id;
          return (
            <button
              key={model.id}
              className={`model-card ${isActive ? "active" : "muted"}`}
              type="button"
              onClick={() => selectModel(model.id)}
            >
              <div className="model-card-top">
                <span className="model-icon">{model.provider}</span>
                {isActive ? <span className="model-badge">Active</span> : null}
              </div>
              <strong>{model.name}</strong>
              <small>{model.model}</small>
            </button>
          );
        })}
      </div>

      <section className="settings-card">
        <header className="settings-card-header">
          <div className="settings-card-title">
            <span className="ds-logo">
              {activeModel?.provider.slice(0, 2).toUpperCase() ?? "--"}
            </span>
            <div>
              <h3>
                {activeModel
                  ? `${activeModel.name} Configuration`
                  : "Model Configuration"}
              </h3>
              <p>
                {hasUnsavedChanges
                  ? "Unsaved changes"
                  : "Saved configuration"}
              </p>
            </div>
          </div>
          <span className="operational-badge">
            {activeModel?.enabled ? "Operational" : "Disabled"}
          </span>
        </header>

        <div className="settings-form">
          <section className="settings-row">
            <div>
              <h4>API Credentials</h4>
              <p>
                Secure access keys for the selected model provider
                endpoint.
              </p>
            </div>
            <div className="settings-fields">
              <div>
                <span>Support Models</span>
                {activeModel?.provider === "deepseek" ? (
                  <p>
                    1. {activeModel?.supportModels?.[0] ?? "-"}
                    <br />
                    2. {activeModel?.supportModels?.[1] ?? "-"}
                  </p>
                ) : (
                  <p>
                    Current:{" "}
                    <strong>{activeModel?.model ?? "-"}</strong>
                  </p>
                )}
              </div>
              <label>
                <span>Base URL</span>
                <input
                  type="text"
                  value={activeModel?.baseUrl ?? ""}
                  onChange={(event) =>
                    updateSelectedModel((model) => ({
                      ...model,
                      baseUrl: (event.target as HTMLInputElement).value,
                    }))
                  }
                />
              </label>
              <label>
                <span>API Key</span>
                <div className="secret-field">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={activeModel?.apiKey ?? ""}
                    placeholder="Paste API key..."
                    onChange={(event) =>
                      updateSelectedModel((model) => ({
                        ...model,
                        apiKey: (event.target as HTMLInputElement).value,
                      }))
                    }
                  />
                  <button
                    type="button"
                    aria-label="Show API key"
                    onClick={() => toggleShowApiKey()}
                  >
                    {showApiKey ? "hide" : "show"}
                  </button>
                </div>
              </label>
              <label>
                <span>Organization ID (Optional)</span>
                <input
                  type="text"
                  value={activeModel?.organizationId ?? ""}
                  placeholder="Optional"
                  onChange={(event) =>
                    updateSelectedModel((model) => ({
                      ...model,
                      organizationId: (event.target as HTMLInputElement).value || null,
                    }))
                  }
                />
              </label>
            </div>
          </section>

          <section className="settings-row">
            <div>
              <h4>Advanced Parameters</h4>
              <p>
                Control the deterministic nature and context limits of
                the inference engine.
              </p>
            </div>
            <div className="settings-fields two-column">
              <label>
                <span>Max Tokens</span>
                <div className="token-field">
                  <input
                    type="number"
                    min="1"
                    value={activeModel?.maxTokens ?? 4096}
                    onChange={(event) =>
                      updateSelectedModel((model) => ({
                        ...model,
                        maxTokens: Math.max(
                          1,
                          Number((event.target as HTMLInputElement).value) || 1,
                        ),
                      }))
                    }
                  />
                  <em>TOK</em>
                </div>
              </label>
              <label>
                <span>Temperature</span>
                <input
                  className="temperature-range"
                  max="2"
                  min="0"
                  step="0.1"
                  type="range"
                  value={activeModel?.temperature ?? 0.7}
                  onChange={(event) =>
                    updateSelectedModel((model) => ({
                      ...model,
                      temperature: Number((event.target as HTMLInputElement).value),
                    }))
                  }
                />
                <div className="range-labels">
                  <small>0.0</small>
                  <small>
                    Current: {activeModel?.temperature ?? 0.7}
                  </small>
                  <small>2.0</small>
                </div>
              </label>
            </div>
          </section>

          <section className="settings-row">
            <div>
              <h4>DeepSeek Pricing</h4>
              <p>Fetched from DeepSeek official Chinese pricing page and used for local RMB cost estimates.</p>
            </div>
            <div className="deepseek-pricing-card">
              <div className="deepseek-pricing-meta">
                <span>Source: {draftSettings?.deepseekPricing?.source}</span>
                <span>Fetched: {draftSettings?.deepseekPricing?.fetchedAt}</span>
              </div>
              {(draftSettings?.deepseekPricing?.models ?? []).length > 0 ? (
                <table className="deepseek-pricing-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Item</th>
                      <th>RMB / 1M tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(draftSettings!.deepseekPricing!.models).flatMap((model) =>
                      model.items.map((item) => (
                        <tr key={`${model.model}:${item.item}`}>
                          <td>{model.model}</td>
                          <td>{item.item}</td>
                          <td>¥{item.pricePerMTokens}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              ) : (
                <div className="deepseek-pricing-empty">
                  No DeepSeek pricing loaded yet. Run npm run pricing:deepseek or restart the desktop app.
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="settings-actions">
          <button
            className="test-button"
            type="button"
            onClick={() => handleTestConnection(draftSettings, isTesting)}
            disabled={!activeModel || isTesting}
          >
            {isTesting ? "Testing..." : "Test Connection"}
          </button>
          <div>
            <button
              className="discard-button"
              type="button"
              onClick={() => discardSettings(savedSettings)}
              disabled={!hasUnsavedChanges || isSaving}
            >
              Discard
            </button>
            <button
              className="save-button"
              type="button"
              onClick={() => handleSaveSettings(draftSettings, isSaving)}
              disabled={!hasUnsavedChanges || isSaving}
            >
              {isSaving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </footer>
      </section>

      <section className="settings-help">
        <div>
          <span aria-hidden="true">i</span>
          <div>
            <strong>Need help configuring DeepSeek?</strong>
            <p>{status}</p>
          </div>
        </div>
        <button type="button">Read Docs -&gt;</button>
      </section>
    </div>
  );
}

// ─── View component ───────────────────────────────────────────────────

export function ModelsSettingsPanelView() {
  const [savedSettings, setSavedSettings] = useState<ModelSettings | null>(null);
  const [draftSettings, setDraftSettings] = useState<ModelSettings | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string>("deepseek-v3");
  const [status, setStatus] = useState<string>("Loading model settings...");
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  // WriteState registrations
  WriteState.setSavedSettings = setSavedSettings;
  WriteState.setDraftSettings = setDraftSettings;
  WriteState.setSelectedModelId = setSelectedModelId;
  WriteState.setStatus = setStatus;
  WriteState.setShowApiKey = setShowApiKey;
  WriteState.setIsSaving = setIsSaving;
  WriteState.setIsTesting = setIsTesting;

  useEffect(() => loadSettingsWithCleanup(), []);

  return render({
    state: {savedSettings, draftSettings, selectedModelId, showApiKey, isSaving, isTesting, status},
    props: {},
    fn: renderModelsSettingsPanel,
    events: {selectModel, updateSelectedModel, handleSaveSettings, discardSettings, handleTestConnection, toggleShowApiKey},
    memo: {},
  });
}
