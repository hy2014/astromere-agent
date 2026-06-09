/* @checkFns assistant-usage-mini-backdrop */
import type {BundleUsageSnapshot} from "../../tauri";
import {render} from "../../core/dep";
import {usageShortId, formatBundleUsageCost, formatBundleUsageHitRate, usageTotalsFromUsage, usageFormatValue} from "../usage-cost";

// ─── Props interface ─────────────────────────────────────────────────

interface AssistantUsageMiniOverlayProps {
  bundleId: string;
  snapshot: BundleUsageSnapshot | null;
  onClose: () => void;
}

// ─── File-level functions ────────────────────────────────────────────

function onStopPropagation(event: React.MouseEvent): void {
  event.stopPropagation();
}

// ─── Render function ─────────────────────────────────────────────────

function renderMiniOverlayContent(
  {}: Record<string, never>,
  { bundleId, snapshot }: { bundleId: string; snapshot: BundleUsageSnapshot | null },
  { onClose, onStopPropagation: _onStopPropagation }: { onClose: () => void; onStopPropagation: (e: React.MouseEvent) => void },
) {
  const usage = snapshot?.usage ?? null;
  const cost = formatBundleUsageCost(snapshot);

  return (
    <div className="assistant-usage-mini-backdrop" role="presentation" onClick={onClose}>
      <section
        className="assistant-usage-mini-panel"
        aria-label="Assistant usage"
        onClick={_onStopPropagation}
      >
        <button className="usage-overlay-close" type="button" onClick={onClose} aria-label="Close assistant usage">×</button>

        <header className="assistant-usage-mini-header">
          <strong>Assistant Usage</strong>
          <span>{usageShortId(bundleId)}</span>
        </header>

        {!snapshot ? (
          <div className="debug-empty">Usage snapshot missing for this assistant bundle.</div>
        ) : null}

        {snapshot && usage ? (
          <>
            <div className="usage-grid">
              {[
                ["totalInputTokens", "Total input", usage.totalInputTokens],
                ["inputTokens", "Input", usage.inputTokens],
                ["outputTokens", "Output", usage.outputTokens],
                ["cacheReadInputTokens", "Cache hit input", usage.cacheReadInputTokens],
                ["cacheCreationInputTokens", "Cache create input", usage.cacheCreationInputTokens],
                ["hitRate", "Hit rate", formatBundleUsageHitRate(snapshot)],
                ["modelCalls", "Model calls", snapshot.modelCallUsages.length],
                ["costAmount", "Cost", cost],
              ].map(([key, label, value]) => (
                <div className="usage-card" key={String(key)}>
                  <span>{label}</span>
                  <strong>{String(value ?? 0)}</strong>
                </div>
              ))}
            </div>

            <div className="usage-note">
              source={snapshot.source} · status={snapshot.status} · modelCalls={snapshot.modelCallIds.length}
            </div>

            {snapshot.modelCallUsages.length > 0 ? (
              <div className="usage-table-wrapper">
                <table className="usage-table">
                  <thead><tr>
                    <th>Model call</th><th>Model</th><th>Stop</th><th>Selected</th>
                    <th>Input</th><th>Output</th><th>Cache read</th><th>Cache create</th>
                  </tr></thead>
                  <tbody>
                    {snapshot.modelCallUsages.map((call) => {
                      const callUsage = usageTotalsFromUsage(call.usage);
                      return (
                        <tr key={call.modelCallId}>
                          <td title={call.modelCallId}>{usageShortId(call.modelCallId)}</td>
                          <td>{call.model ?? "unknown"}</td>
                          <td>{call.stopReason ?? "—"}</td>
                          <td>{call.selectedReason}</td>
                          <td>{usageFormatValue(callUsage.inputTokens, "input_tokens")}</td>
                          <td>{usageFormatValue(callUsage.outputTokens, "output_tokens")}</td>
                          <td>{usageFormatValue(callUsage.cacheReadInputTokens, "cache_read_input_tokens")}</td>
                          <td>{usageFormatValue(callUsage.cacheCreationInputTokens, "cache_creation_input_tokens")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="debug-empty">No model-call usage rows for this bundle.</div>
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}

// ─── View component ───────────────────────────────────────────────────

export function AssistantUsageMiniOverlayView({
  bundleId,
  snapshot,
  onClose,
}: AssistantUsageMiniOverlayProps) {
  return render({
    state: {},
    props: { bundleId, snapshot },
    fn: renderMiniOverlayContent,
    events: { onClose, onStopPropagation },
    memo: undefined,
  });
}
