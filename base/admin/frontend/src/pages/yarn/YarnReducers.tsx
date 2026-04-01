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
  useCompactionHistory,
} from "../../api/hooks";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";

const PERIOD_OPTIONS = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

export default function YarnReducers() {
  const { data: rt, isLoading } = useYarnRuntimeTelemetry();
  const trr = rt?.toolResultReduction;
  const [period, setPeriod] = useState(24);
  const { data: compactionHistory } = useCompactionHistory(period, "yarn");

  const historyChart = (compactionHistory?.snapshots ?? []).map((s) => ({
    time: new Date(s.captured_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    compactions: s.compaction_count,
    tokensSaved: s.tokens_saved_estimate,
    errors: s.errors,
  }));
  const reducerSizeDeltaPct = trr && trr.rawCharsTotal > 0
    ? ((trr.reducedCharsTotal - trr.rawCharsTotal) / trr.rawCharsTotal) * 100
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
          Real-time tool-output reduction and artifact compaction metrics from
          the live Yarn process. Historical data persists across restarts.
        </p>
      </div>

      {isLoading ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : !trr ? (
        <EmptyState
          title="No reducer telemetry available"
          description="Reducer metrics appear after Yarn processes tool results that match a reducer family. Possible reasons for no data: the service hasn't started, no tool-calling requests have been made, tool outputs were too small to trigger reduction (under max raw chars), or reducers are disabled via SYNESIS_YARN_REDUCERS_ENABLED=false."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total Reduced" value={trr.reducedCount} />
            <StatCard
              label="Tokens Saved"
              value={trr.tokensSavedEstimateTotal}
            />
            <StatCard
              label="Raw Chars In"
              value={trr.rawCharsTotal}
            />
            <StatCard
              label="Reduced Chars Out"
              value={trr.reducedCharsTotal}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Overall Performance"
              subtitle="Aggregate reducer metrics since last restart"
            >
              <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
                <Row label="Total reduced outputs" value={trr.reducedCount} />
                <Row
                  label="Estimated tokens saved"
                  value={trr.tokensSavedEstimateTotal}
                />
                <Row
                  label="Raw chars processed"
                  value={trr.rawCharsTotal}
                />
                <Row
                  label="Reduced chars emitted"
                  value={trr.reducedCharsTotal}
                />
                {reducerSizeDeltaPct !== null && (
                  <Row
                    label={reducerSizeDeltaPct <= 0 ? "Avg reduction ratio" : "Avg expansion ratio"}
                    value={`${Math.abs(reducerSizeDeltaPct).toFixed(1)}%`}
                    warn={reducerSizeDeltaPct > 0}
                  />
                )}
                <Row
                  label="Artifact fallbacks"
                  value={trr.fallbackToArtifactCount}
                />
                <Row
                  label="Reducer failures"
                  value={trr.reducerFailures}
                  warn={trr.reducerFailures > 0}
                />
              </div>
            </ChartCard>

            <ChartCard
              title="Family Dispatch"
              subtitle="Invocation counts by reducer family"
            >
              <div className="space-y-2">
                {Object.keys(trr.byFamily || {}).length === 0 ? (
                  <p className="text-sm text-gray-500">
                    No family dispatch data yet.
                  </p>
                ) : (
                  Object.entries(trr.byFamily)
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
            subtitle="Circuit-breaker state per family — enabled, degraded, or disabled"
          >
            {Object.keys(trr.lifecycle || {}).length === 0 ? (
              <p className="text-sm text-gray-500">
                No reducer lifecycle state yet.
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
                    {Object.entries(trr.lifecycle)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([name, state]) => {
                        const total = state.successes + state.failures;
                        const healthPct =
                          total > 0
                            ? ((state.successes / total) * 100).toFixed(0)
                            : "—";
                        return (
                          <tr
                            key={name}
                            className="border-b border-gray-100 dark:border-gray-800"
                          >
                            <td className="py-2 pr-4 font-mono text-gray-900 dark:text-white">
                              {name}
                            </td>
                            <td className="py-2 pr-4">
                              <LifecycleBadge state={state.lifecycle} />
                            </td>
                            <td className="py-2 pr-4 text-right text-green-600 dark:text-green-400">
                              {state.successes}
                            </td>
                            <td className="py-2 pr-4 text-right text-red-600 dark:text-red-400">
                              {state.failures}
                            </td>
                            <td className="py-2 text-right text-gray-700 dark:text-gray-300">
                              {healthPct}%
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </ChartCard>

          {rt?.sawtoothContext ? (
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
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                Historical Period:
              </span>
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.hours}
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
                  {!trr
                    ? "Awaiting first request — historical data will appear after compaction events are recorded."
                    : `No historical compaction data in this period. Compaction checkpoints occur after ${12} tool calls or when history reaches 60 messages. The admin telemetry scraper must also be running and able to reach Yarn's /metrics endpoint.`}
                </p>
              </ChartCard>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
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
