import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  useYarnRuntimeTelemetry,
  useYarnReducerTelemetryHistory,
  useCompactionHistory,
} from "../../api/hooks";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { formatReducerHealth, formatSnapshotFreshness } from "./reducerTelemetry";

const PERIOD_OPTIONS = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

export default function YarnReducers() {
  const { data: rt, isLoading, isError, error } = useYarnRuntimeTelemetry();
  const trr = rt?.toolResultReduction;
  const [period, setPeriod] = useState(24);
  const { data: reducerHistory } = useYarnReducerTelemetryHistory(period);
  const { data: compactionHistory } = useCompactionHistory(period, "yarn");
  const cumulative = reducerHistory?.cumulative;
  const hasLive = Boolean(trr);
  const hasDb = (reducerHistory?.snapshot_count ?? 0) > 0;

  const historyChart = (compactionHistory?.snapshots ?? []).map((s) => ({
    time: new Date(s.captured_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    compactions: s.compaction_count,
    tokensSaved: s.tokens_saved_estimate,
    errors: s.errors,
  }));
  const rawCharsForRatio = trr?.rawCharsTotal ?? cumulative?.raw_chars_total ?? 0;
  const reducedCharsForRatio = trr?.reducedCharsTotal ?? cumulative?.reduced_chars_total ?? 0;
  const reducerSizeDeltaPct =
    rawCharsForRatio > 0
      ? ((reducedCharsForRatio - rawCharsForRatio) / rawCharsForRatio) * 100
      : null;
  const sawtoothDeltaPct = rt?.sawtoothContext && rt.sawtoothContext.totalCharsBefore > 0
    ? ((rt.sawtoothContext.totalCharsAfter - rt.sawtoothContext.totalCharsBefore) / rt.sawtoothContext.totalCharsBefore) * 100
    : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Reducer &amp; Compaction
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Real-time tool-output reduction from the live Coder runtime; DB-backed totals match the selected time window
          and survive restarts (same rollup as Observability → Cache). Use the period control for historical compaction
          charts.
        </p>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Period:</span>
        {PERIOD_OPTIONS.map((opt) => (
          <button
            key={opt.hours}
            type="button"
            onClick={() => setPeriod(opt.hours)}
            className={`rounded px-2 py-1 text-xs font-medium ${
              period === opt.hours
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <ApiErrorBanner error={isError ? error : undefined} />

      {isLoading && !hasLive && !hasDb ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : !hasLive && !hasDb ? (
        <EmptyState
          title="No reducer telemetry available"
          description="Reducer metrics appear after the Coder runtime processes tool results that match a reducer family. Possible reasons for no data: the service hasn't started, no tool-calling requests have been made, tool outputs were too small to trigger reduction (under max raw chars), reducers are disabled via SYNESIS_YARN_REDUCERS_ENABLED=false, or admin cannot reach SYNESIS_YARN_URL /health/telemetry."
        />
      ) : (
        <>
          {!hasLive && hasDb ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
              Live <code className="text-xs">/health/telemetry</code> is unavailable; showing persisted totals for the
              selected window and any cached runtime fields.
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total Transformed"
              value={cumulative?.reduced_count_total ?? trr?.reducedCount ?? 0}
            />
            <StatCard
              label="Tokens Saved (est.)"
              value={cumulative?.tokens_saved_estimate_total ?? trr?.tokensSavedEstimateTotal ?? 0}
            />
            <StatCard
              label="Raw Chars In"
              value={cumulative?.raw_chars_total ?? trr?.rawCharsTotal ?? 0}
              subtitle={hasDb ? "DB total in window (preferred)" : "Live process"}
            />
            <StatCard
              label="Reduced Chars Out"
              value={cumulative?.reduced_chars_total ?? trr?.reducedCharsTotal ?? 0}
              subtitle={hasDb ? "DB total in window (preferred)" : "Live process"}
            />
          </div>

          <ChartCard
            title="Persisted Cumulative Totals"
            subtitle="DB-backed reducer counters (survive admin / Coder runtime reloads)"
          >
            <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
              <Row label="Snapshots captured" value={reducerHistory?.snapshot_count ?? 0} />
              <Row
                label="Latest snapshot"
                value={formatSnapshotFreshness(
                  reducerHistory?.snapshot_count ?? 0,
                  reducerHistory?.latest_snapshot_at ?? null,
                  Boolean(reducerHistory?.stale),
                )}
              />
              <Row label="Snapshot stale" value={reducerHistory?.stale ? "yes" : "no"} warn={Boolean(reducerHistory?.stale)} />
              <Row label="Reduced outputs (total)" value={cumulative?.reduced_count_total ?? 0} />
              <Row label="Raw chars in (total)" value={cumulative?.raw_chars_total ?? 0} />
              <Row label="Reduced chars out (total)" value={cumulative?.reduced_chars_total ?? 0} />
              <Row
                label="Net chars saved (total)"
                value={cumulative?.net_chars_saved_total ?? 0}
                warn={(cumulative?.net_chars_saved_total ?? 0) < 0}
              />
              <Row label="Reducer failures (total)" value={cumulative?.reducer_failures_total ?? 0} warn={(cumulative?.reducer_failures_total ?? 0) > 0} />
              <Row label="Fallback to artifact (total)" value={cumulative?.fallback_to_artifact_total ?? 0} />
              <Row label="Guided truncations (total)" value={cumulative?.guided_truncation_total ?? 0} />
              <Row label="Task-pruned outputs (total)" value={cumulative?.task_pruned_total ?? 0} />
              <Row label="Task-pruned lines kept (total)" value={cumulative?.task_pruned_lines_kept_total ?? 0} />
              <Row label="Task-pruned lines dropped (total)" value={cumulative?.task_pruned_lines_dropped_total ?? 0} />
              {reducerHistory?.scrape_status?.last_error ? (
                <Row label="Last scrape error" value={reducerHistory.scrape_status.last_error} warn />
              ) : null}
            </div>
          </ChartCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Overall Performance"
              subtitle={
                hasLive
                  ? "Live reducer metrics from the current Coder process"
                  : "Live metrics unavailable — see persisted totals above"
              }
            >
              {hasLive ? (
                <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
                  <Row label="Total transformed outputs" value={trr!.reducedCount} />
                  <Row label="Outputs shrunk" value={trr!.shrunkCount} />
                  <Row label="Outputs expanded" value={trr!.expandedCount} warn={trr!.expandedCount > 0} />
                  <Row label="Outputs unchanged" value={trr!.unchangedCount} />
                  <Row label="Estimated tokens saved" value={trr!.tokensSavedEstimateTotal} />
                  <Row
                    label="Net chars saved"
                    value={formatSigned(trr!.netCharsSavedTotal)}
                    warn={trr!.netCharsSavedTotal < 0}
                  />
                  <Row label="Raw chars processed" value={trr!.rawCharsTotal} />
                  <Row label="Reduced chars emitted" value={trr!.reducedCharsTotal} />
                  {reducerSizeDeltaPct !== null && (
                    <Row
                      label={reducerSizeDeltaPct <= 0 ? "Avg reduction ratio" : "Avg expansion ratio"}
                      value={`${Math.abs(reducerSizeDeltaPct).toFixed(1)}%`}
                      warn={reducerSizeDeltaPct > 0}
                    />
                  )}
                  <Row label="Artifact fallbacks" value={trr!.fallbackToArtifactCount} />
                  <Row label="Reducer failures" value={trr!.reducerFailures} warn={trr!.reducerFailures > 0} />
                  <Row label="Guided truncations" value={trr!.guidedTruncationCount ?? 0} />
                  <Row label="Task-pruned outputs" value={trr!.taskPrunedCount ?? 0} />
                  <Row label="Task-pruned lines kept" value={trr!.taskPrunedLinesKept ?? 0} />
                  <Row label="Task-pruned lines dropped" value={trr!.taskPrunedLinesDropped ?? 0} />
                </div>
              ) : (
                <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
                  <Row label="Net chars saved (persisted window)" value={cumulative?.net_chars_saved_total ?? 0} />
                  <Row label="Raw chars (Δ in window)" value={reducerHistory?.rollup.raw_chars_delta ?? 0} />
                  <Row label="Reduced chars (Δ)" value={reducerHistory?.rollup.reduced_chars_delta ?? 0} />
                  <Row label="Net chars saved (Δ)" value={reducerHistory?.rollup.net_chars_saved_delta ?? 0} />
                  {reducerSizeDeltaPct !== null ? (
                    <Row
                      label={reducerSizeDeltaPct <= 0 ? "Avg reduction ratio" : "Avg expansion ratio"}
                      value={`${Math.abs(reducerSizeDeltaPct).toFixed(1)}%`}
                      warn={reducerSizeDeltaPct > 0}
                    />
                  ) : null}
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Family Dispatch"
              subtitle="Invocation counts by reducer family"
            >
              <div className="space-y-2">
                {!hasLive || Object.keys(trr!.byFamily || {}).length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {!hasLive
                      ? "Family dispatch requires live telemetry."
                      : "No family dispatch data yet."}
                  </p>
                ) : (
                  Object.entries(trr!.byFamily)
                    .sort(([, a], [, b]) => (b as number) - (a as number))
                    .map(([family, count]) => (
                      <div
                        key={family}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="font-mono text-gray-700 dark:text-gray-300">
                          {family}
                        </span>
                        <span className="text-gray-500 dark:text-gray-400">
                          {String(count)}
                        </span>
                      </div>
                    ))
                )}
              </div>
            </ChartCard>
          </div>

          <ChartCard
            title="Reducer Lifecycle"
            subtitle="Health uses DB cumulative totals; state uses live Coder runtime status"
          >
            {Object.keys(cumulative?.lifecycle || {}).length === 0 ? (
              <p className="text-sm text-gray-500">
                No reducer lifecycle totals yet. Wait for telemetry snapshots to accumulate.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400">
                      <th className="pb-2 pr-4 font-medium">Family</th>
                      <th className="pb-2 pr-4 font-medium">State</th>
                      <th className="pb-2 pr-4 font-medium text-right">
                        Successes
                      </th>
                      <th className="pb-2 pr-4 font-medium text-right">
                        Failures
                      </th>
                      <th className="pb-2 font-medium text-right">
                        Health
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(cumulative?.lifecycle || {})
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([name, state]) => {
                        const liveState = trr?.lifecycle?.[name]?.lifecycle ?? "unknown";
                        const healthLabel = formatReducerHealth(state.success_total, state.fail_total);
                        return (
                          <tr
                            key={name}
                            className="border-b border-gray-100 dark:border-gray-800"
                          >
                            <td className="py-2 pr-4 font-mono text-gray-900 dark:text-white">
                              {name}
                            </td>
                            <td className="py-2 pr-4">
                              <LifecycleBadge state={liveState} />
                            </td>
                            <td className="py-2 pr-4 text-right text-green-600 dark:text-green-400">
                              {state.success_total}
                            </td>
                            <td className="py-2 pr-4 text-right text-red-600 dark:text-red-400">
                              {state.fail_total}
                            </td>
                            <td className="py-2 text-right text-gray-700 dark:text-gray-300">
                              {healthLabel}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </ChartCard>

          {hasLive && rt?.sawtoothContext ? (
            <ChartCard
              title="Sawtooth Context Compaction"
              subtitle="LLM-driven context compaction metrics"
            >
              <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
                <Row
                  label="Compactions performed"
                  value={rt.sawtoothContext.compactionCount}
                />
                <Row
                  label="Avg chars before"
                  value={
                    rt.sawtoothContext.compactionCount > 0
                      ? Math.round(
                          rt.sawtoothContext.totalCharsBefore /
                            rt.sawtoothContext.compactionCount,
                        )
                      : 0
                  }
                />
                <Row
                  label="Avg chars after"
                  value={
                    rt.sawtoothContext.compactionCount > 0
                      ? Math.round(
                          rt.sawtoothContext.totalCharsAfter /
                            rt.sawtoothContext.compactionCount,
                        )
                      : 0
                  }
                />
                {sawtoothDeltaPct !== null && (
                  <Row
                    label={sawtoothDeltaPct <= 0 ? "Avg compaction ratio" : "Avg expansion ratio"}
                    value={`${Math.abs(sawtoothDeltaPct).toFixed(1)}%`}
                    warn={sawtoothDeltaPct > 0}
                  />
                )}
                <Row
                  label="Compaction failures"
                  value={rt.sawtoothContext.compactionFailures}
                  warn={rt.sawtoothContext.compactionFailures > 0}
                />
              </div>
            </ChartCard>
          ) : null}

          {/* Historical compaction data */}
          <div>
            {historyChart.length > 0 ? (
              <ChartCard
                title="Compaction Over Time"
                subtitle="Persisted compaction events — survives restarts"
              >
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={historyChart}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <RechartsTooltip />
                    <Line
                      type="monotone"
                      dataKey="tokensSaved"
                      stroke="#8b5cf6"
                      strokeWidth={2}
                      dot={false}
                      name="Tokens Saved"
                    />
                    <Line
                      type="monotone"
                      dataKey="compactions"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={false}
                      name="Compactions"
                    />
                    <Line
                      type="monotone"
                      dataKey="errors"
                      stroke="#ef4444"
                      strokeWidth={1}
                      dot={false}
                      name="Errors"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>
            ) : (
              <ChartCard
                title="Compaction Over Time"
                subtitle="Persisted compaction events — survives restarts"
              >
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {`No historical compaction data in this period. Compaction checkpoints occur after ${12} tool calls or when history reaches 60 messages. The admin telemetry scraper must also be running and able to reach the Coder runtime /metrics endpoint.`}
                </p>
              </ChartCard>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, subtitle }: { label: string; value: number; subtitle?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {subtitle ? (
        <p className="mt-1 text-[0.65rem] text-gray-500 dark:text-gray-400">{subtitle}</p>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  warn,
}: {
  label: string;
  value: number | string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span
        className={
          warn
            ? "font-medium text-amber-600 dark:text-amber-400"
            : "font-medium"
        }
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
    </div>
  );
}

function LifecycleBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    enabled:
      "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    degraded:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    disabled:
      "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[state] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}
    >
      {state}
    </span>
  );
}

function formatSigned(value: number): string {
  if (value > 0) return `+${value.toLocaleString()}`;
  return value.toLocaleString();
}
