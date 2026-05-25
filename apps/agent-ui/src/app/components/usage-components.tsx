import { useState, useEffect, useMemo } from "react";
import type { BundleUsageSnapshot } from "../../tauri";
import type { SessionUsageIndicatorKey } from "../types";
import {
  formatBundleUsageCost,
  formatBundleUsageHitRate,
  usageTotalsFromUsage,
  usageFormatValue,
  usageShortId,
  sessionUsageSnapshotsForSession,
  sessionUsageTotals,
  sessionUsageCurrency,
  sessionUsageCostAmount,
  sessionUsageHitRateFromTotals,
  bundleUsageStorageKey,
  bundleUsageIndicatorValue,
  formatSessionUsageIndicatorValue,
  sessionUsageModelCostByCallId,
  formatModelCallCost,
} from "../usage-cost";

// ─── Props types ──────────────────────────────────────────────────────

type AssistantUsageMiniOverlayProps = {
  bundleId: string;
  snapshot: BundleUsageSnapshot | null;
  onClose: () => void;
};

type SessionUsageDashboardProps = {
  activeSessionId: string | null;
  usageByKey: Record<string, BundleUsageSnapshot>;
};

// ─── Constants ─────────────────────────────────────────────────────────

const sessionUsageIndicatorOptions: Array<{
  key: SessionUsageIndicatorKey;
  label: string;
}> = [
  { key: "costAmount", label: "Cost" },
  { key: "totalInputTokens", label: "Total input" },
  { key: "inputTokens", label: "Input" },
  { key: "outputTokens", label: "Output" },
  { key: "cacheReadInputTokens", label: "Cache hit input" },
  { key: "cacheCreationInputTokens", label: "Cache create input" },
  { key: "hitRate", label: "Hit rate" },
  { key: "modelCallCount", label: "Model calls" },
];

// ─── AssistantUsageMiniOverlay ─────────────────────────────────────────

export function AssistantUsageMiniOverlay({
  bundleId,
  snapshot,
  onClose,
}: AssistantUsageMiniOverlayProps) {
  const usage = snapshot?.usage ?? null;
  const cost = formatBundleUsageCost(snapshot);

  return (
    <div className="assistant-usage-mini-backdrop" role="presentation" onClick={onClose}>
      <section
        className="assistant-usage-mini-panel"
        aria-label="Assistant usage"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="usage-overlay-close"
          type="button"
          onClick={onClose}
          aria-label="Close assistant usage"
        >
          ×
        </button>

        <header className="assistant-usage-mini-header">
          <strong>Assistant Usage</strong>
          <span>{usageShortId(bundleId)}</span>
        </header>

        {!snapshot ? (
          <div className="debug-empty">
            Usage snapshot missing for this assistant bundle.
          </div>
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
                  <thead>
                    <tr>
                      <th>Model call</th>
                      <th>Model</th>
                      <th>Stop</th>
                      <th>Selected</th>
                      <th>Input</th>
                      <th>Output</th>
                      <th>Cache read</th>
                      <th>Cache create</th>
                    </tr>
                  </thead>
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

// ─── SessionUsageDashboard ─────────────────────────────────────────────

export function SessionUsageDashboard({
  activeSessionId,
  usageByKey,
}: SessionUsageDashboardProps) {
  const [indicator, setIndicator] = useState<SessionUsageIndicatorKey>("costAmount");
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);

  const snapshots = useMemo(
    () => sessionUsageSnapshotsForSession(usageByKey, activeSessionId),
    [usageByKey, activeSessionId],
  );

  useEffect(() => {
    if (!selectedBundleId && snapshots.length > 0) {
      setSelectedBundleId(snapshots[snapshots.length - 1]?.bundleId ?? null);
      return;
    }
    if (selectedBundleId && !snapshots.some((snapshot) => snapshot.bundleId === selectedBundleId)) {
      setSelectedBundleId(snapshots[snapshots.length - 1]?.bundleId ?? null);
    }
  }, [selectedBundleId, snapshots]);

  const totals = useMemo(() => sessionUsageTotals(snapshots), [snapshots]);
  const currency = sessionUsageCurrency(snapshots);
  const costAmount = sessionUsageCostAmount(snapshots);
  const hitRate = sessionUsageHitRateFromTotals(totals);
  const selectedSnapshot =
    selectedBundleId && activeSessionId
      ? usageByKey[bundleUsageStorageKey(activeSessionId, selectedBundleId)] ?? null
      : null;

  const maxValue = Math.max(
    0,
    ...snapshots.map((snapshot) => bundleUsageIndicatorValue(snapshot, indicator)),
  );
  const chartWidth = 720;
  const chartHeight = 180;
  const paddingX = 32;
  const paddingY = 22;
  const usableWidth = chartWidth - paddingX * 2;
  const usableHeight = chartHeight - paddingY * 2;
  const points = snapshots.map((snapshot, index) => {
    const x =
      snapshots.length <= 1
        ? chartWidth / 2
        : paddingX + (index / (snapshots.length - 1)) * usableWidth;
    const value = bundleUsageIndicatorValue(snapshot, indicator);
    const y =
      maxValue <= 0
        ? chartHeight - paddingY
        : chartHeight - paddingY - (value / maxValue) * usableHeight;
    return { snapshot, value, x, y };
  });
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");

  if (!activeSessionId) {
    return <div className="debug-empty">No active session selected.</div>;
  }

  if (snapshots.length === 0) {
    return (
      <div className="debug-empty">
        No usage snapshots found for this session. Run history usage backfill or complete a stream turn first.
      </div>
    );
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
          [
            "cost",
            "Cost",
            costAmount == null
              ? "unavailable"
              : formatSessionUsageIndicatorValue(costAmount, "costAmount", currency),
          ],
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
            onChange={(event) => setIndicator(event.target.value as SessionUsageIndicatorKey)}
          >
            {sessionUsageIndicatorOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="usage-chart-card">
        <svg
          className="usage-timeline-chart"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          role="img"
          aria-label="Session usage timeline"
        >
          <line
            className="usage-timeline-axis"
            x1={paddingX}
            y1={chartHeight - paddingY}
            x2={chartWidth - paddingX}
            y2={chartHeight - paddingY}
          />
          <line
            className="usage-timeline-grid"
            x1={paddingX}
            y1={paddingY}
            x2={chartWidth - paddingX}
            y2={paddingY}
          />
          {points.length > 1 ? <polyline className="usage-timeline-line" points={polyline} /> : null}
          {points.map((point) => {
            const isSelected = selectedBundleId === point.snapshot.bundleId;
            const label = formatSessionUsageIndicatorValue(point.value, indicator, currency);
            return (
              <g key={point.snapshot.bundleId}>
                <circle
                  className={`usage-timeline-point ${isSelected ? "selected" : ""}`}
                  cx={point.x}
                  cy={point.y}
                  r={isSelected ? 6 : 4}
                  tabIndex={0}
                  role="button"
                  aria-label={`Bundle ${usageShortId(point.snapshot.bundleId)} ${label}`}
                  onClick={() => setSelectedBundleId(point.snapshot.bundleId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedBundleId(point.snapshot.bundleId);
                    }
                  }}
                />
                <title>
                  {usageShortId(point.snapshot.bundleId)} · {label}
                </title>
              </g>
            );
          })}
        </svg>

        <div className="usage-note">
          {snapshots.length} bundles · click a point to inspect bundle details
        </div>
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
                  <th>Model call</th>
                  <th>Model</th>
                  <th>Stop</th>
                  <th>Selected</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cache hit</th>
                  <th>Cache create</th>
                  <th>Total input</th>
                  <th>Hit rate</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {selectedSnapshot.modelCallUsages.map((call) => {
                  const callUsage = usageTotalsFromUsage(call.usage);
                  const callHitRate =
                    callUsage.totalInputTokens > 0
                      ? callUsage.cacheReadInputTokens / callUsage.totalInputTokens
                      : null;
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
