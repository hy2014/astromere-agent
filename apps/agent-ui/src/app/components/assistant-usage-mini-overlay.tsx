/* @checkFns assistant-usage-mini-backdrop */
import type {ModelCallUsage} from "../../tauri";
import type {AggregatedUsage} from "../usage-cost";
import {render} from "../../core/dep";
import {usageShortId, usageFormatValue} from "../usage-cost";

// ─── Helpers ──────────────────────────────────────────────────────────

function hitRateFromTotals(totals: AggregatedUsage["totals"]): number | null {
  const totalInput =
    totals.totalInputTokens ||
    totals.inputTokens + totals.cacheReadInputTokens + totals.cacheCreationInputTokens;
  if (!totalInput || totalInput <= 0) return null;
  return totals.cacheReadInputTokens / totalInput;
}

function formatCost(totalCost: number | null): string {
  if (totalCost == null) return "unavailable";
  return `¥${totalCost.toFixed(4)}`;
}

function formatHitRate(totals: AggregatedUsage["totals"]): string {
  const rate = hitRateFromTotals(totals);
  return rate == null ? "unavailable" : `${(rate * 100).toFixed(2)}%`;
}

// ─── Props interface ─────────────────────────────────────────────────

interface AssistantUsageMiniOverlayProps {
  bundleId: string;
  aggregated: AggregatedUsage;
  onClose: () => void;
}

// ─── File-level functions ────────────────────────────────────────────

function onStopPropagation(event: React.MouseEvent): void {
  event.stopPropagation();
}

// ─── Render function ─────────────────────────────────────────────────

function renderMiniOverlayContent(
  {}: Record<string, never>,
  { bundleId, aggregated }: { bundleId: string; aggregated: AggregatedUsage },
  { onClose, onStopPropagation: _onStopPropagation }: { onClose: () => void; onStopPropagation: (e: React.MouseEvent) => void },
) {
  const { totals, usages, totalCost } = aggregated;
  const cost = formatCost(totalCost);

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

        <div className="usage-grid">
          {[
            ["totalInputTokens", "Total input", totals.totalInputTokens],
            ["inputTokens", "Input", totals.inputTokens],
            ["outputTokens", "Output", totals.outputTokens],
            ["cacheReadInputTokens", "Cache hit input", totals.cacheReadInputTokens],
            ["cacheCreationInputTokens", "Cache create input", totals.cacheCreationInputTokens],
            ["hitRate", "Hit rate", formatHitRate(totals)],
            ["modelCalls", "Model calls", usages.length],
            ["costAmount", "Cost", cost],
          ].map(([key, label, value]) => (
            <div className="usage-card" key={String(key)}>
              <span>{label}</span>
              <strong>{String(value ?? 0)}</strong>
            </div>
          ))}
        </div>

        {usages.length > 0 ? (
          <div className="usage-table-wrapper">
            <table className="usage-table">
              <thead><tr>
                <th>Model call</th><th>Model</th><th>Stop</th><th>Selected</th>
                <th>Input</th><th>Output</th><th>Cache read</th><th>Cache create</th>
              </tr></thead>
              <tbody>
                {usages.map((call: ModelCallUsage) => (
                  <tr key={call.modelCallId}>
                    <td title={call.modelCallId}>{usageShortId(call.modelCallId)}</td>
                    <td>{call.model ?? "unknown"}</td>
                    <td>{call.stopReason ?? "—"}</td>
                    <td>db</td>
                    <td>{usageFormatValue(call.inputTokens, "input_tokens")}</td>
                    <td>{usageFormatValue(call.outputTokens, "output_tokens")}</td>
                    <td>{usageFormatValue(call.cacheReadInputTokens, "cache_read_input_tokens")}</td>
                    <td>{usageFormatValue(call.cacheCreationInputTokens, "cache_creation_input_tokens")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="debug-empty">No model-call usage rows for this bundle.</div>
        )}
      </section>
    </div>
  );
}

// ─── View component ───────────────────────────────────────────────────

export function AssistantUsageMiniOverlayView({
  bundleId,
  aggregated,
  onClose,
}: AssistantUsageMiniOverlayProps) {
  return render({
    state: {},
    props: { bundleId, aggregated },
    fn: renderMiniOverlayContent,
    events: { onClose, onStopPropagation },
    memo: undefined,
  });
}
