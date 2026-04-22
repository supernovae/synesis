import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { clsx } from "clsx";
import { AlertTriangle, Gauge, Globe2, SlidersHorizontal } from "lucide-react";
import {
  useYarnTransitionQualityTelemetry,
  type YarnTransitionQualityBucket,
} from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

const PERIOD_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

const BUCKET_OPTIONS = [
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "60m", minutes: 60 },
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

function fmtPct(v: number): string {
  return `${(Math.max(0, v) * 100).toFixed(1)}%`;
}

function riskLabel(flag: string): string {
  if (flag === "high_regressed_rate") return "High regressed rate";
  if (flag === "high_reground_required_rate") return "High re-ground required rate";
  if (flag === "low_forward_progress_rate") return "Low forward progress rate";
  if (flag === "low_global_scope_coverage") return "Low global scope coverage";
  if (flag === "negative_quality_score") return "Negative quality score";
  if (flag === "missing_global_calibration_events") return "Missing global calibration events";
  if (flag === "no_calibration_events") return "No calibration events";
  return flag.replaceAll("_", " ");
}

export default function YarnTransitionCalibration() {
  const [sinceHours, setSinceHours] = useState(168);
  const [bucketMinutes, setBucketMinutes] = useState(60);
  const { data, isLoading, error } = useYarnTransitionQualityTelemetry(sinceHours, bucketMinutes);

  const buckets = data?.buckets ?? [];
  const chartData = useMemo(
    () =>
      buckets.map((b) => ({
        ...b,
        label: fmtBucketLabel(b.bucket),
        forward_progress_pct: Number((b.forward_progress_rate * 100).toFixed(2)),
        stalled_pct: Number((b.stalled_rate * 100).toFixed(2)),
        regressed_pct: Number((b.regressed_rate * 100).toFixed(2)),
        reground_required_pct: Number((b.reground_required_rate * 100).toFixed(2)),
        global_scope_coverage_pct: Number((b.global_scope_coverage * 100).toFixed(2)),
      })),
    [buckets],
  );

  const recentAlerts = data?.alert_buckets ?? [];
  const topReasons = data?.top_quality_reasons ?? [];

  const riskFlags = data?.summary.risk_flags ?? [];
  const thresholds = data?.alert_thresholds;
  const summary = data?.summary;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Transition Calibration
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Trend quality labels, calibration cadence, and alert thresholds for state transition health.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
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
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span>Bucket</span>
            <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900">
              {BUCKET_OPTIONS.map((opt) => (
                <button
                  key={opt.minutes}
                  type="button"
                  onClick={() => setBucketMinutes(opt.minutes)}
                  className={clsx(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    bucketMinutes === opt.minutes
                      ? "bg-indigo-600 text-white"
                      : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {error ? <ApiErrorBanner error={error} /> : null}

      {isLoading && !data ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : chartData.length === 0 ? (
        <EmptyState
          title="No transition telemetry in this period"
          description="No request_trajectory events were found for this scope and time window."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Avg quality score"
              value={summary ? summary.quality_score_avg.toFixed(2) : "0.00"}
              icon={Gauge}
            />
            <MetricCard
              label="Regressed rate (window)"
              value={summary ? fmtPct(summary.regressed_rate_avg) : "0.0%"}
              icon={AlertTriangle}
            />
            <MetricCard
              label="Global scope coverage"
              value={summary ? fmtPct(summary.global_scope_coverage_avg) : "0.0%"}
              icon={Globe2}
            />
            <MetricCard
              label="Calibration events"
              value={
                summary
                  ? `${summary.local_calibration_events_total} local / ${summary.global_calibration_events_total} global`
                  : "0 / 0"
              }
              icon={SlidersHorizontal}
            />
          </div>

          <ChartCard
            title="Quality score vs threshold band"
            subtitle="Quality score trend with dynamic forward/regressed threshold bands"
          >
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} domain={["dataMin - 0.1", "dataMax + 0.1"]} />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    formatter={(value, name) => {
                      if (name === "quality_score_avg") return [Number(value ?? 0).toFixed(3), "Quality score"];
                      if (name === "quality_forward_min_avg") return [Number(value ?? 0).toFixed(3), "Forward min"];
                      if (name === "quality_regressed_max_avg") return [Number(value ?? 0).toFixed(3), "Regressed max"];
                      return [String(value ?? ""), name];
                    }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="quality_score_avg"
                    stroke="#4f46e5"
                    strokeWidth={2}
                    dot={false}
                    name="quality_score_avg"
                  />
                  <Line
                    type="monotone"
                    dataKey="quality_forward_min_avg"
                    stroke="#16a34a"
                    strokeWidth={2}
                    dot={false}
                    strokeDasharray="4 4"
                    name="quality_forward_min_avg"
                  />
                  <Line
                    type="monotone"
                    dataKey="quality_regressed_max_avg"
                    stroke="#dc2626"
                    strokeWidth={2}
                    dot={false}
                    strokeDasharray="4 4"
                    name="quality_regressed_max_avg"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          <div className="grid gap-6 xl:grid-cols-2">
            <ChartCard
              title="Transition label rates"
              subtitle="Forward/stalled/regressed/reground_required by bucket"
            >
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                    <Tooltip
                      contentStyle={{ fontSize: 12 }}
                      formatter={(value) => [`${Number(value ?? 0).toFixed(1)}%`, "Rate"]}
                    />
                    <Legend />
                    <Line type="monotone" dataKey="forward_progress_pct" stroke="#16a34a" strokeWidth={2} dot={false} name="forward_progress" />
                    <Line type="monotone" dataKey="stalled_pct" stroke="#d97706" strokeWidth={2} dot={false} name="stalled" />
                    <Line type="monotone" dataKey="regressed_pct" stroke="#dc2626" strokeWidth={2} dot={false} name="regressed" />
                    <Line type="monotone" dataKey="reground_required_pct" stroke="#7c3aed" strokeWidth={2} dot={false} name="reground_required" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            <ChartCard
              title="Calibration cadence"
              subtitle="Local and global calibration event counts per bucket"
            >
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12 }} />
                    <Legend />
                    <Bar dataKey="local_calibration_events" fill="#2563eb" name="local_calibration" />
                    <Bar dataKey="global_calibration_events" fill="#0d9488" name="global_calibration" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <ChartCard
              title="Thresholds and current risk"
              subtitle="Alert configuration used to flag risky transition buckets"
            >
              <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
                <div className="flex items-center justify-between">
                  <span>Regressed rate warning</span>
                  <span className="font-medium">{fmtPct(thresholds?.regressed_rate_warn ?? 0)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Re-ground required warning</span>
                  <span className="font-medium">{fmtPct(thresholds?.reground_required_rate_warn ?? 0)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Global scope coverage minimum</span>
                  <span className="font-medium">{fmtPct(thresholds?.global_scope_coverage_warn ?? 0)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Quality score floor</span>
                  <span className="font-medium">{(thresholds?.quality_score_warn ?? 0).toFixed(2)}</span>
                </div>
                <div className="border-t border-gray-200 pt-3 dark:border-gray-700">
                  <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Active risk flags
                  </p>
                  {riskFlags.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {riskFlags.map((flag) => (
                        <span
                          key={flag}
                          className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-200"
                        >
                          {riskLabel(flag)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-300">
                      No window-level transition quality alerts are currently active.
                    </p>
                  )}
                </div>
              </div>
            </ChartCard>

            <ChartCard
              title="Operator actions and top reasons"
              subtitle="Recommended next actions derived from current transition-quality risk profile"
            >
              <div className="space-y-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Recommended actions
                  </p>
                  <div className="mt-2 space-y-2">
                    {(data?.actions ?? []).map((action) => (
                      <p key={action} className="text-sm text-gray-700 dark:text-gray-300">
                        {action}
                      </p>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Top quality reasons
                  </p>
                  {topReasons.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {topReasons.slice(0, 6).map((reason) => (
                        <div key={reason.reason} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1 dark:border-gray-700">
                          <span className="text-sm text-gray-700 dark:text-gray-300">
                            {reason.reason.replaceAll("_", " ")}
                          </span>
                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                            {reason.count}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                      No quality reasons captured in this period.
                    </p>
                  )}
                </div>
              </div>
            </ChartCard>
          </div>

          <ChartCard
            title="Recent alert buckets"
            subtitle="Buckets with threshold violations and likely operator follow-up targets"
          >
            {recentAlerts.length === 0 ? (
              <p className="text-sm text-emerald-700 dark:text-emerald-300">
                No alert buckets in this period.
              </p>
            ) : (
              <div className="space-y-2">
                {recentAlerts.slice(-12).reverse().map((bucket: YarnTransitionQualityBucket) => (
                  <div
                    key={bucket.bucket ?? `${bucket.trajectory_events}-${bucket.regressed_rate}`}
                    className="rounded border border-gray-200 p-3 dark:border-gray-700"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
                        {fmtBucketLabel(bucket.bucket)}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {bucket.trajectory_events.toLocaleString()} trajectories
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {bucket.risk_flags.map((flag) => (
                        <span
                          key={flag}
                          className="rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
                        >
                          {riskLabel(flag)}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 grid gap-2 text-xs text-gray-600 dark:text-gray-400 sm:grid-cols-3">
                      <span>Regressed: {fmtPct(bucket.regressed_rate)}</span>
                      <span>Re-ground: {fmtPct(bucket.reground_required_rate)}</span>
                      <span>Scope coverage: {fmtPct(bucket.global_scope_coverage)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ChartCard>
        </>
      )}
    </div>
  );
}
