import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { clsx } from "clsx";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Clock,
  Coins,
  Hash,
  Layers,
  ShieldAlert,
  Users,
} from "lucide-react";
import {
  useYarnOverview,
  useYarnPerformance,
  useYarnIntelligence,
  useYarnRuntimeTelemetry,
  useYarnReducerTelemetryHistory,
  type YarnPerformanceBucket,
} from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { fmtCost, fmtDurationMs } from "../../lib/formatUsage";

const PERIOD_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

function fmtBucketLabel(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const QUICK_LINKS = [
  {
    to: "/yarn/sessions",
    title: "Sessions",
    description: "Browse agent sessions and drill into requests",
    icon: Layers,
  },
  {
    to: "/yarn/events",
    title: "Events & Errors",
    description: "Timeline of requests, escalations, and failures",
    icon: ShieldAlert,
  },
  {
    to: "/yarn/performance",
    title: "Performance",
    description: "Time-bucketed traffic, latency, and cost",
    icon: Activity,
  },
  {
    to: "/yarn/verification",
    title: "Verification",
    description: "Health probe and smoke checks against Yarn",
    icon: AlertTriangle,
  },
];

export default function YarnOverview() {
  const [sinceHours, setSinceHours] = useState(24);
  const { data: overview, isLoading: ovLoading } = useYarnOverview(sinceHours);
  const { data: perf, isLoading: perfLoading } = useYarnPerformance(sinceHours);
  const { data: intelligence, isLoading: intelLoading } = useYarnIntelligence(sinceHours);
  const { data: runtimeTelemetry } = useYarnRuntimeTelemetry();
  const { data: reducerHistory } = useYarnReducerTelemetryHistory(sinceHours);

  const loading = ovLoading || perfLoading || intelLoading;
  const buckets: YarnPerformanceBucket[] = perf ?? [];

  const chartData = buckets.map((b) => ({
    ...b,
    label: fmtBucketLabel(b.bucket),
    okRequests: Math.max(0, b.requests - b.errors - b.escalations),
  }));

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Yarn Ops
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Agent runtime overview and key metrics
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              type="button"
              onClick={() => setSinceHours(opt.hours)}
              className={clsx(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                sinceHours === opt.hours
                  ? "bg-indigo-600 text-white"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !overview ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : !overview || overview.total_requests === 0 ? (
        <EmptyState
          title="No Yarn usage in this period"
          description="Metrics appear after the Yarn service records sessions and usage in the admin database."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <MetricCard
              label="Requests"
              value={overview.total_requests.toLocaleString()}
              icon={Hash}
              subtitle={`past ${sinceHours}h`}
            />
            <MetricCard
              label="Errors"
              value={overview.error_count.toLocaleString()}
              icon={AlertTriangle}
              subtitle={
                overview.error_rate > 0
                  ? `${(overview.error_rate * 100).toFixed(2)}% rate`
                  : undefined
              }
            />
            <MetricCard
              label="Escalations"
              value={overview.escalation_count.toLocaleString()}
              icon={ShieldAlert}
            />
            <MetricCard
              label="Avg Latency"
              value={fmtDurationMs(overview.avg_latency_ms)}
              icon={Clock}
              subtitle={
                overview.p99_latency_ms
                  ? `p99 ${fmtDurationMs(overview.p99_latency_ms)}`
                  : undefined
              }
            />
            <MetricCard
              label="Total Cost"
              value={fmtCost(overview.total_actual_cost_usd > 0 ? overview.total_actual_cost_usd : overview.total_estimated_cost_usd)}
              icon={Coins}
              subtitle={overview.total_actual_cost_usd > 0 ? `Actual (Est: ${fmtCost(overview.total_estimated_cost_usd)})` : "Estimated (Forecast)"}
            />
            <MetricCard
              label="Active Sessions"
              value={overview.active_sessions.toLocaleString()}
              icon={Users}
              subtitle="touched in window"
            />
          </div>

          {intelligence ? (
            <div className="grid gap-4 lg:grid-cols-3">
              <ChartCard
                title="Session Intelligence"
                subtitle="Behavior quality and efficiency indicators"
              >
                <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                  <div className="flex items-center justify-between">
                    <span>Avg tool calls / request</span>
                    <span className="font-medium">{intelligence.avg_tool_calls_per_request.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Cache hit estimate</span>
                    <span className="font-medium">{(intelligence.cache_hit_estimate * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Tool-use stop rate</span>
                    <span className="font-medium">{(intelligence.tool_use_stop_rate * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Error-like rate</span>
                    <span className="font-medium">{(intelligence.error_like_rate * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>First-pass verify rate</span>
                    <span className="font-medium">{(intelligence.first_pass_verify_rate * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Verification stall rate</span>
                    <span className="font-medium">{(intelligence.verification_stall_rate * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Blind retry rate</span>
                    <span className="font-medium">{(intelligence.blind_retry_rate * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Patch ratio</span>
                    <span className="font-medium">{(intelligence.patch_ratio * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Structured parser coverage</span>
                    <span className="font-medium">{(intelligence.structured_error_coverage * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Completion gate blocked</span>
                    <span className="font-medium">{(intelligence.completion_gate_blocked_rate * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Pre-finalize critic blocked</span>
                    <span className="font-medium">{(intelligence.critic_block_rate * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Trajectory events</span>
                    <span className="font-medium">{intelligence.trajectory_events.toLocaleString()}</span>
                  </div>
                </div>
              </ChartCard>

              <ChartCard
                title="Top Models"
                subtitle="Most active models by request count and cost"
              >
                <div className="space-y-2">
                  {intelligence.top_models.length === 0 ? (
                    <p className="text-sm text-gray-500">No model data yet.</p>
                  ) : (
                    intelligence.top_models.map((m) => {
                      const effectiveCost = m.actual_cost_usd > 0 ? m.actual_cost_usd : m.estimated_cost_usd;
                      const avgCost = m.requests > 0 ? effectiveCost / m.requests : 0;
                      return (
                        <div key={m.model} className="flex items-center justify-between text-sm">
                          <span className="truncate pr-2 text-gray-700 dark:text-gray-300">{m.model}</span>
                          <span className="text-right text-gray-500 dark:text-gray-400">
                            <span className="tabular-nums">{m.requests}</span> req · {fmtCost(effectiveCost)}
                            <span className="ml-1 text-[10px] text-gray-400 dark:text-gray-500">
                              ({fmtCost(avgCost)}/req)
                            </span>
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </ChartCard>

              <ChartCard
                title="Finish Reasons"
                subtitle="Most common terminal outcomes"
              >
                <div className="space-y-2">
                  {Object.keys(intelligence.finish_reason_counts).length === 0 ? (
                    <p className="text-sm text-gray-500">No finish reason data yet.</p>
                  ) : (
                    Object.entries(intelligence.finish_reason_counts).map(([reason, count]) => (
                      <div key={reason} className="flex items-center justify-between text-sm">
                        <span className="truncate pr-2 text-gray-700 dark:text-gray-300">{reason}</span>
                        <span className="text-gray-500 dark:text-gray-400">{count}</span>
                      </div>
                    ))
                  )}
                </div>
              </ChartCard>

              <ChartCard
                title="Trajectory Buckets"
                subtitle="request_trajectory_v1 distribution"
              >
                <div className="space-y-2">
                  {Object.keys(intelligence.trajectory_bucket_counts || {}).length === 0 ? (
                    <p className="text-sm text-gray-500">No trajectory bucket data yet.</p>
                  ) : (
                    Object.entries(intelligence.trajectory_bucket_counts).map(([bucket, count]) => (
                      <div key={bucket} className="flex items-center justify-between text-sm">
                        <span className="truncate pr-2 text-gray-700 dark:text-gray-300">{bucket}</span>
                        <span className="text-gray-500 dark:text-gray-400">{count}</span>
                      </div>
                    ))
                  )}
                </div>
              </ChartCard>
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Requests over time"
              subtitle="Bucketed traffic from Yarn usage log"
            >
              {chartData.length === 0 ? (
                <p className="text-sm text-gray-500">No bucket data for this range.</p>
              ) : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="yarnReqFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{ fontSize: 12 }}
                        formatter={(v) => [v == null ? 0 : Number(v), "Requests"]}
                      />
                      <Area
                        type="monotone"
                        dataKey="requests"
                        stroke="#4f46e5"
                        fill="url(#yarnReqFill)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Errors & escalations"
              subtitle="Per bucket — stacked counts"
            >
              {chartData.length === 0 ? (
                <p className="text-sm text-gray-500">No bucket data for this range.</p>
              ) : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip contentStyle={{ fontSize: 12 }} />
                      <Bar dataKey="okRequests" stackId="a" fill="#22c55e" name="OK" />
                      <Bar dataKey="escalations" stackId="a" fill="#f59e0b" name="Escalations" />
                      <Bar dataKey="errors" stackId="a" fill="#ef4444" name="Errors" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </ChartCard>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Explore
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {QUICK_LINKS.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="group flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-900"
                >
                  <div className="rounded-lg bg-indigo-50 p-2 dark:bg-indigo-950/50">
                    <item.icon className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="font-medium text-gray-900 dark:text-white">
                        {item.title}
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-gray-400 transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {item.description}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </>
      )}

      {runtimeTelemetry?.toolResultReduction ? (
        <div
          className={clsx(
            "space-y-4 pt-8",
            overview && overview.total_requests > 0
              ? "border-t border-gray-200 dark:border-gray-700"
              : "",
          )}
        >
          <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Tool-result reducers
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Reducer performance"
              subtitle="Live counters (Yarn process — reset when Yarn restarts)"
            >
              <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                <div className="flex items-center justify-between">
                  <span>Total reduced outputs</span>
                  <span className="font-medium">{runtimeTelemetry.toolResultReduction.reducedCount}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Estimated tokens saved</span>
                  <span className="font-medium">{runtimeTelemetry.toolResultReduction.tokensSavedEstimateTotal}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Fallback to artifact</span>
                  <span className="font-medium">{runtimeTelemetry.toolResultReduction.fallbackToArtifactCount}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Reducer failures</span>
                  <span className="font-medium">{runtimeTelemetry.toolResultReduction.reducerFailures}</span>
                </div>
              </div>
            </ChartCard>
            <ChartCard
              title="Reducer lifecycle"
              subtitle="Per-family state (live)"
            >
              <div className="space-y-2">
                {Object.entries(runtimeTelemetry.toolResultReduction.lifecycle || {}).length === 0 ? (
                  <p className="text-sm text-gray-500">No reducer lifecycle state yet.</p>
                ) : (
                  Object.entries(runtimeTelemetry.toolResultReduction.lifecycle).map(([name, state]) => (
                    <div key={name} className="flex items-center justify-between text-sm">
                      <span className="truncate pr-2 text-gray-700 dark:text-gray-300">
                        {name} ({state.lifecycle})
                      </span>
                      <span className="text-gray-500 dark:text-gray-400">
                        ok {state.successes} / fail {state.failures}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </ChartCard>
          </div>

          {reducerHistory ? (
            <ChartCard
              title="Saved reducer activity"
              subtitle={`Persisted in Postgres via admin telemetry snapshots (~5 min). Same period as above (${sinceHours}h).`}
            >
              <div className="space-y-4 text-sm text-gray-700 dark:text-gray-300">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Snapshots in window: {reducerHistory.snapshot_count}
                  {reducerHistory.latest_snapshot_at
                    ? ` · latest ${new Date(reducerHistory.latest_snapshot_at).toLocaleString()}`
                    : ""}
                  {reducerHistory.stale ? " · stale" : ""}
                </p>
                {reducerHistory.scrape_status?.last_error ? (
                  <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                    Last scrape error: {reducerHistory.scrape_status.last_error}
                  </p>
                ) : null}

                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Cumulative totals (DB)
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Reduced outputs</span>
                      <span className="font-medium tabular-nums">
                        {reducerHistory.cumulative.reduced_count_total.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Reducer failures</span>
                      <span className="font-medium tabular-nums">
                        {reducerHistory.cumulative.reducer_failures_total.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Est. tokens saved</span>
                      <span className="font-medium tabular-nums">
                        {reducerHistory.cumulative.tokens_saved_estimate_total.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Fallback to artifact</span>
                      <span className="font-medium tabular-nums">
                        {reducerHistory.cumulative.fallback_to_artifact_total.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Windowed deltas ({sinceHours}h)
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Reduced outputs (Δ)</span>
                      <span className="font-medium tabular-nums">
                        {reducerHistory.rollup.reduced_count_delta.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Reducer failures (Δ)</span>
                      <span className="font-medium tabular-nums">
                        {reducerHistory.rollup.reducer_failures_delta.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Est. tokens saved (Δ)</span>
                      <span className="font-medium tabular-nums">
                        {reducerHistory.rollup.tokens_saved_estimate_delta.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Fallback to artifact (Δ)</span>
                      <span className="font-medium tabular-nums">
                        {reducerHistory.rollup.fallback_to_artifact_delta.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>

                {Object.keys(reducerHistory.cumulative.lifecycle).length === 0 ? (
                  <p className="text-sm text-gray-500">No per-family cumulative lifecycle totals yet.</p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Pass / fail by family (cumulative)
                    </p>
                    {Object.entries(reducerHistory.cumulative.lifecycle).map(([fam, d]) => (
                      <div key={fam} className="flex items-center justify-between text-sm">
                        <span className="truncate pr-2">{fam}</span>
                        <span className="text-gray-500 dark:text-gray-400 tabular-nums">
                          ok {d.success_total} · fail {d.fail_total}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {reducerHistory.snapshot_count < 2 ? (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {reducerHistory.snapshot_count === 0
                      ? "No snapshots yet — the admin background job records reducer stats when Yarn is reachable."
                      : "Need at least two snapshots to compute stable deltas for this window."}
                  </p>
                ) : null}
              </div>
            </ChartCard>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
