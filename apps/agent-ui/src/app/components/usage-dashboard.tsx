/* @checkFns session-usage-dashboard */
import {useEffect, useMemo, useState} from "react";
import type {BundleUsageSnapshot} from "../../tauri";
import type {SessionUsageIndicatorKey} from "../types";
import {
  bundleUsageIndicatorValue,
  bundleUsageStorageKey,
  formatBundleUsageCost,
  formatBundleUsageHitRate,
  formatModelCallCost,
  formatSessionUsageIndicatorValue,
  sessionUsageCostAmount,
  sessionUsageCurrency,
  sessionUsageHitRateFromTotals,
  sessionUsageModelCostByCallId,
  sessionUsageSnapshotsForSession,
  sessionUsageTotals,
  usageFormatValue,
  usageShortId,
  usageTotalsFromUsage,
} from "../usage-cost";
import {render} from "../../core/dep";

// ─── WriteState ────────────────────────────────────────────────────────

const WriteState: {
  setIndicator: (key: SessionUsageIndicatorKey) => void;
  setSelectedBundleId: (id: string | null) => void;
} = {} as any;

// ─── Props interface ────────────────────────────────────────────────

interface SessionUsageDashboardProps {
  activeSessionId: string | null;
  streamUsageByBundleKey: Record<string, BundleUsageSnapshot>;
}

// ─── Constants ─────────────────────────────────────────────────────────

function indicatorOptions(): Array<{
  key: SessionUsageIndicatorKey;
  label: string;
}> {
  return [
    { key: "costAmount", label: "Cost" },
    { key: "totalInputTokens", label: "Total input" },
    { key: "inputTokens", label: "Input" },
    { key: "outputTokens", label: "Output" },
    { key: "cacheReadInputTokens", label: "Cache hit input" },
    { key: "cacheCreationInputTokens", label: "Cache create input" },
    { key: "hitRate", label: "Hit rate" },
    { key: "modelCallCount", label: "Model calls" },
  ];
}

// ─── File-level event helpers ──────────────────────────────────────────

function handleSetIndicatorValue(value: string): void {
  WriteState.setIndicator(value as SessionUsageIndicatorKey);
}

function handleSelectBundle(bundleId: string | null): void {
  WriteState.setSelectedBundleId(bundleId);
}

function handleKeyDownSelectBundle(
  bundleId: string,
  e: React.KeyboardEvent<SVGCircleElement>,
): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    WriteState.setSelectedBundleId(bundleId);
  }
}

// Custom hook helper to avoid useEffect checks in the View
function useSelectionSync(
  selectedBundleId: string | null,
  snapshots: BundleUsageSnapshot[],
  setSelectedBundleId: (id: string | null) => void,
) {
  useEffect(() => {
    if (!selectedBundleId && snapshots.length > 0) {
      setSelectedBundleId(snapshots[snapshots.length - 1]?.bundleId ?? null);
      return;
    }
    if (selectedBundleId && !snapshots.some((snap) => snap.bundleId === selectedBundleId)) {
      setSelectedBundleId(snapshots[snapshots.length - 1]?.bundleId ?? null);
    }
  }, [selectedBundleId, snapshots, setSelectedBundleId]);
}

// ─── SessionUsageDashboard View ─────────────────────────────────────────

export function SessionUsageDashboardView({
  activeSessionId,
  streamUsageByBundleKey,
}: SessionUsageDashboardProps) {
  const usageByKey = streamUsageByBundleKey;
  const [indicator, setIndicator] = useState<SessionUsageIndicatorKey>("costAmount");
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);

  // WriteState registrations
  WriteState.setIndicator = setIndicator;
  WriteState.setSelectedBundleId = setSelectedBundleId;

  const snapshots = useMemo(
    () => sessionUsageSnapshotsForSession(usageByKey, activeSessionId),
    [usageByKey, activeSessionId],
  );

  useSelectionSync(selectedBundleId, snapshots, setSelectedBundleId);

  const totals = useMemo(() => sessionUsageTotals(snapshots), [snapshots]);
  const currency = sessionUsageCurrency(snapshots);
  const costAmount = sessionUsageCostAmount(snapshots);
  const hitRate = sessionUsageHitRateFromTotals(totals);

  return render({
    state: { indicator, selectedBundleId },
    props: { activeSessionId, streamUsageByBundleKey },
    fn: renderSessionUsageDashboard,
    events: { handleSetIndicatorValue, handleSelectBundle, handleKeyDownSelectBundle },
    memo: { snapshots, totals, currency, costAmount, hitRate },
  });
}

function renderSessionUsageDashboard(
  { indicator, selectedBundleId }:
    { indicator: SessionUsageIndicatorKey; selectedBundleId: string | null },
  { activeSessionId, streamUsageByBundleKey }: { activeSessionId: string | null; streamUsageByBundleKey: Record<string, BundleUsageSnapshot> },
  { handleSetIndicatorValue, handleSelectBundle, handleKeyDownSelectBundle }:
    { handleSetIndicatorValue: (value: string) => void; handleSelectBundle: (bId: string | null) => void; handleKeyDownSelectBundle: (bundleId: string, e: React.KeyboardEvent<SVGCircleElement>) => void },
  { snapshots, totals, currency, costAmount, hitRate }:
    { snapshots: BundleUsageSnapshot[]; totals: ReturnType<typeof sessionUsageTotals>; currency: string; costAmount: number | null; hitRate: number | null },
) {
  const selectedSnapshot = selectedBundleId && activeSessionId
    ? streamUsageByBundleKey[bundleUsageStorageKey(activeSessionId, selectedBundleId)] ?? null
    : null;
  const maxValue = Math.max(0, ...snapshots.map((s) => bundleUsageIndicatorValue(s, indicator)));
  const chartWidth = 720;
  const chartHeight = 180;
  const paddingX = 32;
  const paddingY = 22;
  const points = snapshots.map((snapshot, index) => {
    const x = snapshots.length <= 1
      ? chartWidth / 2
      : paddingX + (index / (snapshots.length - 1)) * (chartWidth - paddingX * 2);
    const value = bundleUsageIndicatorValue(snapshot, indicator);
    const y = maxValue <= 0
      ? chartHeight - paddingY
      : chartHeight - paddingY - (value / maxValue) * (chartHeight - paddingY * 2);
    return { snapshot, value, x, y };
  });
  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");
  if (!activeSessionId) return <div className="debug-empty">No active session selected.</div>;

  if (snapshots.length === 0) {
    return <div className="debug-empty">No usage snapshots found for this session. Run history usage backfill or complete a stream turn first.</div>;
  }

  return (
    <section className="session-usage-dashboard">
      <div className="usage-grid">
        {[
          ["totalInputTokens", "Total input", usageFormatValue(totals.totalInputTokens, "total_input_tokens")],
          ["inputTokens", "Input", usageFormatValue(totals.inputTokens, "input_tokens")],
          ["outputTokens", "Output", usageFormatValue(totals.outputTokens, "output_tokens")],
          ["cacheReadInputTokens", "Cache hit input", usageFormatValue(totals.cacheReadInputTokens, "cache_read_input_tokens")],
          ["cacheCreationInputTokens", "Cache create input", usageFormatValue(totals.cacheCreationInputTokens, "cache_creation_input_tokens")],
          ["hitRate", "Hit rate", hitRate == null ? "unavailable" : `${(hitRate * 100).toFixed(2)}%`],
          ["modelCalls", "Model calls", String(snapshots.reduce((sum, snapshot) => sum + snapshot.modelCallUsages.length, 0))],
          ["cost", "Cost", costAmount == null ? "unavailable" : formatSessionUsageIndicatorValue(costAmount, "costAmount", currency)],
        ].map(([key, label, value]) => (
          <div className="usage-card" key={String(key)}>
            <span>{label}</span>
            <strong>{String(value)}</strong>
          </div>
        ))}
      </div>

      <div className="usage-toolbar">
        <label>
          <span>Indicator</span>
          <select
            value={indicator}
            onChange={(e) => handleSetIndicatorValue(e.target.value)}
          >
            {indicatorOptions().map((option: { key: SessionUsageIndicatorKey; label: string }) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="usage-chart-card">
        <svg className="usage-timeline-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Session usage timeline">
          <line className="usage-timeline-axis" x1={paddingX} y1={chartHeight - paddingY} x2={chartWidth - paddingX} y2={chartHeight - paddingY} />
          <line className="usage-timeline-grid" x1={paddingX} y1={paddingY} x2={chartWidth - paddingX} y2={paddingY} />
          {points.length > 1 ? <polyline className="usage-timeline-line" points={polyline} /> : null}
          {points.map((point) => {
            const isSelected = selectedBundleId === point.snapshot.bundleId;
            const label = formatSessionUsageIndicatorValue(point.value, indicator, currency);
            return (
              <g key={point.snapshot.bundleId}>
                <circle
                  className={`usage-timeline-point ${isSelected ? "selected" : ""}`}
                  cx={point.x} cy={point.y} r={isSelected ? 6 : 4}
                  tabIndex={0} role="button"
                  aria-label={`Bundle ${usageShortId(point.snapshot.bundleId)} ${label}`}
                  onClick={() => handleSelectBundle(point.snapshot.bundleId)}
                  onKeyDown={(e) => handleKeyDownSelectBundle(point.snapshot.bundleId, e)}
                />
                <title>{usageShortId(point.snapshot.bundleId)} · {label}</title>
              </g>
            );
          })}
        </svg>
        <div className="usage-note">{snapshots.length} bundles · click a point to inspect bundle details</div>
      </div>

      {selectedSnapshot ? (
        <section className="usage-bundle-detail">
          <header className="assistant-usage-mini-header">
            <strong>Bundle detail</strong>
            <span>{usageShortId(selectedSnapshot.bundleId)}</span>
          </header>
          <div className="usage-detail-grid">
            {[
              ["Bundle ID", selectedSnapshot.bundleId],
              ["Session ID", selectedSnapshot.sessionId],
              ["Source", selectedSnapshot.source],
              ["Status", selectedSnapshot.status],
              ["Started", selectedSnapshot.startedAtMs ? new Date(selectedSnapshot.startedAtMs).toLocaleString() : "—"],
              ["Completed", selectedSnapshot.completedAtMs ? new Date(selectedSnapshot.completedAtMs).toLocaleString() : "—"],
              ["Updated", selectedSnapshot.updatedAtMs ? new Date(selectedSnapshot.updatedAtMs).toLocaleString() : "—"],
              ["Cost", formatBundleUsageCost(selectedSnapshot)],
              ["Hit rate", formatBundleUsageHitRate(selectedSnapshot)],
            ].map(([label, value]) => (
              <div className="usage-detail-card" key={label} title={String(value)}>
                <span>{label}</span>
                <strong>{String(value)}</strong>
              </div>
            ))}
          </div>
          <div className="usage-table-wrapper">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Model call</th><th>Model</th><th>Stop</th><th>Selected</th><th>Input</th>
                  <th>Output</th><th>Cache hit</th><th>Cache create</th><th>Total input</th><th>Hit rate</th><th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {selectedSnapshot.modelCallUsages.map((call) => {
                  const callUsage = usageTotalsFromUsage(call.usage);
                  const callHitRate = callUsage.totalInputTokens > 0 ? callUsage.cacheReadInputTokens / callUsage.totalInputTokens : null;
                  const modelCostByCallId = sessionUsageModelCostByCallId(selectedSnapshot);
                  const cost = modelCostByCallId.get(call.modelCallId);
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
                      <td>{usageFormatValue(callUsage.totalInputTokens, "total_input_tokens")}</td>
                      <td>{callHitRate == null ? "unavailable" : `${(callHitRate * 100).toFixed(2)}%`}</td>
                      <td>{formatModelCallCost(cost, currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <div className="debug-empty">Select a bundle to inspect details.</div>
      )}
    </section>
  );
}

// SessionUsageDashboardView is exported above
