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
import { fmtCost, fmtDurationMs, fmtTokens } from "../../lib/formatUsage";

const PERIOD_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

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
    description: "Time-bucketed traffic, latency, and usage price",
    icon: Activity,
  },
  {
    to: "/yarn/verification",
    title: "Verification",
    description: "Health probe and smoke checks against the Coder runtime",
    icon: AlertTriangle,
  },
  {
    to: "/yarn/transition-calibration",
    title: "Transition Calibration",
    description: "Trend transition quality thresholds and alert buckets",
    icon: Activity,
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
  const liveTaskKept = runtimeTelemetry?.toolResultReduction?.taskPrunedLinesKept ?? 0;
  const liveTaskDropped = runtimeTelemetry?.toolResultReduction?.taskPrunedLinesDropped ?? 0;
  const liveTaskTotal = liveTaskKept + liveTaskDropped;
  const liveTaskKeepRatio = liveTaskTotal > 0 ? (liveTaskKept / liveTaskTotal) * 100 : null;
  const cumulativeTaskKept = reducerHistory?.cumulative?.task_pruned_lines_kept_total ?? 0;
  const cumulativeTaskDropped = reducerHistory?.cumulative?.task_pruned_lines_dropped_total ?? 0;
  const cumulativeTaskTotal = cumulativeTaskKept + cumulativeTaskDropped;
  const cumulativeTaskKeepRatio = cumulativeTaskTotal > 0 ? (cumulativeTaskKept / cumulativeTaskTotal) * 100 : null;
  const transitionQuality = intelligence?.state_transition_quality;
  const transitionQualityActions = (() => {
    if (!transitionQuality) return [];
    const actions: string[] = [];
    if (transitionQuality.risk_flags.includes("high_regressed_rate")) {
      actions.push("Regressed transitions are elevated. Inspect recent regressed trajectories and recovery prompts.");
    }
    if (transitionQuality.risk_flags.includes("high_reground_required_rate")) {
      actions.push("Frequent re-ground requirements suggest stale/partial file memory pressure.");
    }
    if (transitionQuality.risk_flags.includes("low_global_scope_coverage")) {
      actions.push("Global-scope coverage is low. Verify org/model scope keys are stable and calibration samples are accumulating.");
    }
    if (transitionQuality.risk_flags.includes("low_quality_score_coverage")) {
      actions.push("Quality score coverage is low. Verify request_trajectory training signals include state_transition_quality_score.");
    }
    if (transitionQuality.risk_flags.includes("missing_global_calibration_events")) {
      actions.push("No global calibration events observed in this window. Check Redis-backed calibration persistence.");
    }
    if (transitionQuality.risk_flags.includes("negative_quality_score")) {
      actions.push("Average quality score is negative. Prioritize reducing regressed transitions before tuning thresholds.");
    }
    if (actions.length === 0 && transitionQuality.trajectory_events > 0) {
      actions.push("Quality profile is stable. Continue monitoring drift and top quality reasons.");
    }
    return actions.slice(0, 4);
  })();

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Coder
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Coder (IDE / agent runtime) overview and key metrics
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
          title="No Coder usage in this period"
          description="Metrics appear after the Coder runtime records sessions and usage in the admin database."
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
              label="Usage Price"
              value={fmtCost(overview.total_price_usd)}
              icon={Coins}
              subtitle={
                overview.total_provider_actual_cost_usd != null
                  ? `Provider actual ${fmtCost(overview.total_provider_actual_cost_usd)}`
                  : "Configured rate card"
              }
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
                title="Edit Anchor Misses"
                subtitle="edit_context_miss incidents and token burn"
              >
                <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                  <div className="flex items-center justify-between">
                    <span>Event rate</span>
                    <span className="font-medium">
                      {(intelligence.edit_context_miss.event_rate * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Impacted requests</span>
                    <span className="font-medium">
                      {intelligence.edit_context_miss.impacted_requests.toLocaleString()} / {intelligence.requests.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Impacted sessions</span>
                    <span className="font-medium">{intelligence.edit_context_miss.impacted_sessions.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Token burn on impacted requests</span>
                    <span className="font-medium">{fmtTokens(intelligence.edit_context_miss.impacted_tokens)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Cache hit on impacted requests</span>
                    <span className="font-medium">
                      {(intelligence.edit_context_miss.impacted_cache_hit_estimate * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Usage price on impacted requests</span>
                    <span className="font-medium">{fmtCost(intelligence.edit_context_miss.impacted_price_usd)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Request mapping coverage</span>
                    <span className="font-medium">
                      {(intelligence.edit_context_miss.mapping_coverage * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
                <div className="mt-4 space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Top impacted models
                    </p>
                    {intelligence.edit_context_miss.top_models.length === 0 ? (
                      <p className="mt-2 text-sm text-gray-500">No edit-anchor miss events in this window.</p>
                    ) : (
                      <div className="mt-2 space-y-1.5">
                        {intelligence.edit_context_miss.top_models.map((row) => (
                          <div key={`${row.provider}:${row.model}`} className="flex items-center justify-between text-sm">
                            <span className="truncate pr-2 text-gray-700 dark:text-gray-300">
                              {row.provider} / {row.model}
                            </span>
                            <span className="text-right text-gray-500 dark:text-gray-400">
                              {row.requests} req · {fmtTokens(row.total_tokens)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {intelligence.edit_context_miss.top_files.length > 0 && (
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Most-missed files
                      </p>
                      <div className="mt-2 space-y-1.5">
                        {intelligence.edit_context_miss.top_files.slice(0, 4).map((row) => (
                          <div key={row.file_path} className="flex items-center justify-between text-sm">
                            <span className="truncate pr-2 text-gray-700 dark:text-gray-300">{row.file_path}</span>
                            <span className="text-gray-500 dark:text-gray-400">{row.miss_count}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </ChartCard>

              <ChartCard
                title="Top Models"
                subtitle="Most active models by request count and usage price"
              >
                <div className="space-y-2">
                  {intelligence.top_models.length === 0 ? (
                    <p className="text-sm text-gray-500">No model data yet.</p>
                  ) : (
                    intelligence.top_models.map((m) => {
                      const avgPrice = m.requests > 0 ? m.price_usd / m.requests : 0;
                      return (
                        <div key={m.model} className="flex items-center justify-between text-sm">
                          <span className="truncate pr-2 text-gray-700 dark:text-gray-300">{m.model}</span>
                          <span className="text-right text-gray-500 dark:text-gray-400">
                            <span className="tabular-nums">{m.requests}</span> req · {fmtCost(m.price_usd)}
                            <span className="ml-1 text-[10px] text-gray-400 dark:text-gray-500">
                              ({fmtCost(avgPrice)}/req)
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

              <ChartCard
                title="State Transition Quality"
                subtitle="Calibration health, label mix, and operator actions"
              >
                {!transitionQuality ? (
                  <p className="text-sm text-gray-500">No transition quality telemetry yet.</p>
                ) : (
                  <div className="space-y-4">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="rounded-md border border-gray-200 p-2 dark:border-gray-700">
                        <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Avg quality score</p>
                        <p className={clsx(
                          "mt-1 text-sm font-semibold",
                          transitionQuality.score_avg >= 0.2
                            ? "text-emerald-700 dark:text-emerald-300"
                            : transitionQuality.score_avg < 0
                              ? "text-amber-700 dark:text-amber-300"
                              : "text-gray-800 dark:text-gray-100",
                        )}>
                          {transitionQuality.score_avg.toFixed(3)}
                        </p>
                      </div>
                      <div className="rounded-md border border-gray-200 p-2 dark:border-gray-700">
                        <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Global scope coverage</p>
                        <p className={clsx(
                          "mt-1 text-sm font-semibold",
                          transitionQuality.global_scope_coverage >= 0.65
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-amber-700 dark:text-amber-300",
                        )}>
                          {pct(transitionQuality.global_scope_coverage)}
                        </p>
                      </div>
                    </div>

                    <div className="space-y-1.5 text-sm text-gray-700 dark:text-gray-300">
                      <div className="flex items-center justify-between">
                        <span>Forward progress</span>
                        <span className="font-medium">{pct(transitionQuality.label_rates.forward_progress)} ({transitionQuality.label_counts.forward_progress})</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Stalled</span>
                        <span className="font-medium">{pct(transitionQuality.label_rates.stalled)} ({transitionQuality.label_counts.stalled})</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Regressed</span>
                        <span className={clsx(
                          "font-medium",
                          transitionQuality.label_rates.regressed >= 0.15
                            ? "text-amber-700 dark:text-amber-300"
                            : undefined,
                        )}>
                          {pct(transitionQuality.label_rates.regressed)} ({transitionQuality.label_counts.regressed})
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Re-ground required</span>
                        <span className={clsx(
                          "font-medium",
                          transitionQuality.label_rates.reground_required >= 0.08
                            ? "text-amber-700 dark:text-amber-300"
                            : undefined,
                        )}>
                          {pct(transitionQuality.label_rates.reground_required)} ({transitionQuality.label_counts.reground_required})
                        </span>
                      </div>
                    </div>

                    <div className="space-y-1.5 text-sm text-gray-700 dark:text-gray-300">
                      <div className="flex items-center justify-between">
                        <span>Threshold band (avg)</span>
                        <span className="font-medium">
                          {transitionQuality.threshold_band_avg.regressed_max.toFixed(3)} → {transitionQuality.threshold_band_avg.forward_progress_min.toFixed(3)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Calibration events (local / global)</span>
                        <span className="font-medium">
                          {transitionQuality.calibration_events.local} / {transitionQuality.calibration_events.global}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Latest global calibration</span>
                        <span className="font-medium">
                          {transitionQuality.calibration_events.latest_global_at
                            ? new Date(transitionQuality.calibration_events.latest_global_at).toLocaleString()
                            : "none"}
                        </span>
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Top quality reasons
                      </p>
                      {transitionQuality.top_reasons.length === 0 ? (
                        <p className="mt-1 text-sm text-gray-500">No reason breakdown in this window.</p>
                      ) : (
                        <div className="mt-2 space-y-1.5">
                          {transitionQuality.top_reasons.slice(0, 4).map((reasonRow) => (
                            <div key={reasonRow.reason} className="flex items-center justify-between text-sm">
                              <span className="truncate pr-2 text-gray-700 dark:text-gray-300">{reasonRow.reason}</span>
                              <span className="text-gray-500 dark:text-gray-400">{reasonRow.count}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/40">
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Actionable insight
                      </p>
                      <ul className="mt-1 space-y-1 text-sm text-gray-700 dark:text-gray-300">
                        {transitionQualityActions.map((item) => (
                          <li key={item} className="leading-5">- {item}</li>
                        ))}
                      </ul>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Link
                          to="/yarn/transition-calibration"
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
                        >
                          Open trend dashboard
                        </Link>
                        <Link
                          to="/yarn/events"
                          className="rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-900/50"
                        >
                          Inspect events
                        </Link>
                        <Link
                          to="/yarn/sessions"
                          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                        >
                          Drill into sessions
                        </Link>
                      </div>
                    </div>
                  </div>
                )}
              </ChartCard>
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Requests over time"
              subtitle="Bucketed traffic from Coder usage log"
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
          <div className="grid gap-4 lg:grid-cols-3">
            <ChartCard
              title="Reducer performance"
              subtitle="Live counters (Coder process — reset when the runtime restarts)"
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
                <div className="flex items-center justify-between">
                  <span>Raw chars in</span>
                  <span className="font-medium">
                    {runtimeTelemetry.toolResultReduction.rawCharsTotal.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Reduced chars out</span>
                  <span className="font-medium">
                    {runtimeTelemetry.toolResultReduction.reducedCharsTotal.toLocaleString()}
                  </span>
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
            <ChartCard
              title="Task pruning efficiency"
              subtitle="Task-conditioned keep/drop ratios (live + persisted)"
            >
              <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                <div className="flex items-center justify-between">
                  <span>Task-pruned outputs (live)</span>
                  <span className="font-medium">
                    {(runtimeTelemetry.toolResultReduction.taskPrunedCount ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Lines kept (live)</span>
                  <span className="font-medium">{liveTaskKept.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Lines dropped (live)</span>
                  <span className="font-medium">{liveTaskDropped.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Keep ratio (live)</span>
                  <span className="font-medium">
                    {liveTaskKeepRatio === null ? "—" : `${liveTaskKeepRatio.toFixed(1)}%`}
                  </span>
                </div>
                <div className="my-2 border-t border-gray-200 dark:border-gray-700" />
                <div className="flex items-center justify-between">
                  <span>Task-pruned outputs (DB)</span>
                  <span className="font-medium">
                    {(reducerHistory?.cumulative?.task_pruned_total ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Lines kept (DB)</span>
                  <span className="font-medium">{cumulativeTaskKept.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Lines dropped (DB)</span>
                  <span className="font-medium">{cumulativeTaskDropped.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Keep ratio (DB)</span>
                  <span className="font-medium">
                    {cumulativeTaskKeepRatio === null ? "—" : `${cumulativeTaskKeepRatio.toFixed(1)}%`}
                  </span>
                </div>
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
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Raw chars in (DB)</span>
                      <span className="font-medium tabular-nums">
                        {(reducerHistory.cumulative.raw_chars_total ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Reduced chars out (DB)</span>
                      <span className="font-medium tabular-nums">
                        {(reducerHistory.cumulative.reduced_chars_total ?? 0).toLocaleString()}
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
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Raw chars (Δ)</span>
                      <span className="font-medium tabular-nums">
                        {(reducerHistory.rollup.raw_chars_delta ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/80">
                      <span>Reduced chars (Δ)</span>
                      <span className="font-medium tabular-nums">
                        {(reducerHistory.rollup.reduced_chars_delta ?? 0).toLocaleString()}
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
                      ? "No snapshots yet — the admin background job records reducer stats when the Coder runtime is reachable."
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
