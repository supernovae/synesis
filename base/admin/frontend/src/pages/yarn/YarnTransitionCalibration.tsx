import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
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
const STALE_BREACH_HOURS = 24;

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

function fmtRelativeFromNow(iso: string | null): string {
  if (!iso) return "unknown";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const elapsedMs = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function hoursSinceIso(iso: string | null): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, (Date.now() - ts) / 3_600_000);
}

function riskLabel(flag: string): string {
  if (flag === "high_regressed_rate") return "High regressed rate";
  if (flag === "high_reground_required_rate") return "High re-ground required rate";
  if (flag === "low_forward_progress_rate") return "Low forward progress rate";
  if (flag === "low_global_scope_coverage") return "Low global scope coverage";
  if (flag === "low_quality_score_coverage") return "Low quality score coverage";
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
  const qualityScoreCoverageAvg = summary?.quality_score_coverage_avg ?? 0;
  const qualityScoreObservedEventsTotal = summary?.quality_score_observed_events_total ?? 0;
  const scoreCoverageWarnPct = (thresholds?.quality_score_coverage_warn ?? 0) * 100;
  const scoreCoverageTrend = useMemo(
    () =>
      chartData.map((row) => ({
        label: row.label,
        bucket_iso: row.bucket,
        score_coverage_pct: Number((row.quality_score_coverage * 100).toFixed(2)),
        trajectory_events: row.trajectory_events,
      })),
    [chartData],
  );
  const latestScoreCoveragePct = scoreCoverageTrend.length > 0
    ? scoreCoverageTrend[scoreCoverageTrend.length - 1]?.score_coverage_pct ?? 0
    : 0;
  const minScoreCoveragePct = scoreCoverageTrend.length > 0
    ? scoreCoverageTrend.reduce(
      (minValue, row) => Math.min(minValue, row.score_coverage_pct),
      Number.POSITIVE_INFINITY,
    )
    : 0;
  const scoreCoverageBelowWarnBuckets = scoreCoverageTrend.reduce(
    (count, row) => count + (row.score_coverage_pct < scoreCoverageWarnPct ? 1 : 0),
    0,
  );
  const recentScoreCoverageBelowWarnBuckets = scoreCoverageTrend.reduce(
    (count, row) => {
      const ageHours = hoursSinceIso(row.bucket_iso);
      if (ageHours === null || ageHours > STALE_BREACH_HOURS) return count;
      return count + (row.score_coverage_pct < scoreCoverageWarnPct ? 1 : 0);
    },
    0,
  );
  const lastBelowWarnBucketIso = [...scoreCoverageTrend].reverse().find(
    (row) => row.score_coverage_pct < scoreCoverageWarnPct,
  )?.bucket_iso ?? null;
  const lastBelowWarnAgeHours = hoursSinceIso(lastBelowWarnBucketIso);
  const lastBelowWarnIsStale = lastBelowWarnAgeHours !== null && lastBelowWarnAgeHours > STALE_BREACH_HOURS;
  const lastBelowWarnSummary = lastBelowWarnBucketIso
    ? `${fmtRelativeFromNow(lastBelowWarnBucketIso)} (${fmtBucketLabel(lastBelowWarnBucketIso)})`
    : "none in window";
  const latestScoreCoverageBelowWarn = latestScoreCoveragePct < scoreCoverageWarnPct;
  const scoreCoverageStatus = latestScoreCoverageBelowWarn
    ? "at_risk"
    : recentScoreCoverageBelowWarnBuckets > 0
      ? "watch"
      : scoreCoverageBelowWarnBuckets > 0
        ? "recovered"
      : "healthy";

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
              subtitle={`${qualityScoreObservedEventsTotal.toLocaleString()} scored trajectories (${fmtPct(qualityScoreCoverageAvg)} coverage)`}
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

          <div className="grid gap-6 xl:grid-cols-3">
            <ChartCard
              title="Score coverage trend"
              subtitle="Sparkline to catch abrupt drops in observed quality scores"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={clsx(
                      "rounded-full px-2 py-0.5 text-xs font-medium",
                      scoreCoverageStatus === "at_risk"
                        ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200"
                        : scoreCoverageStatus === "watch"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
                          : scoreCoverageStatus === "recovered"
                            ? "bg-slate-100 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300"
                          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
                    )}
                  >
                    {scoreCoverageStatus === "at_risk"
                      ? "At risk"
                      : scoreCoverageStatus === "watch"
                        ? "Watch"
                        : scoreCoverageStatus === "recovered"
                          ? "Recovered"
                        : "Healthy"}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {scoreCoverageBelowWarnBuckets}/{scoreCoverageTrend.length} below floor
                    {" "}- {recentScoreCoverageBelowWarnBuckets} in last {STALE_BREACH_HOURS}h
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span>Last breach</span>
                  <span
                    className={clsx(
                      "font-medium",
                      lastBelowWarnIsStale
                        ? "text-gray-400 dark:text-gray-500"
                        : "text-gray-600 dark:text-gray-300",
                    )}
                  >
                    {lastBelowWarnSummary}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <div>
                    <p className="uppercase tracking-wide text-gray-500 dark:text-gray-500">Latest</p>
                    <p
                      className={clsx(
                        "mt-0.5 text-sm font-semibold",
                        latestScoreCoverageBelowWarn
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-emerald-700 dark:text-emerald-300",
                      )}
                    >
                      {fmtPct(latestScoreCoveragePct / 100)}
                    </p>
                  </div>
                  <div>
                    <p className="uppercase tracking-wide text-gray-500 dark:text-gray-500">Window min</p>
                    <p className="mt-0.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
                      {fmtPct(minScoreCoveragePct / 100)}
                    </p>
                  </div>
                  <div>
                    <p className="uppercase tracking-wide text-gray-500 dark:text-gray-500">Warn floor</p>
                    <p className="mt-0.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
                      {fmtPct(scoreCoverageWarnPct / 100)}
                    </p>
                  </div>
                </div>
                <div className="h-20">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={scoreCoverageTrend}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        vertical={false}
                        className="stroke-gray-200 dark:stroke-gray-700"
                      />
                      <XAxis dataKey="label" hide />
                      <YAxis domain={[0, 100]} hide />
                      <Tooltip
                        contentStyle={{ fontSize: 12 }}
                        formatter={(value, name, item) => {
                          if (name === "score_coverage_pct") {
                            const events = (item?.payload as { trajectory_events?: number } | undefined)
                              ?.trajectory_events ?? 0;
                            return [`${Number(value ?? 0).toFixed(1)}%`, `Score coverage (${events} events)`];
                          }
                          return [String(value ?? ""), name];
                        }}
                      />
                      <ReferenceArea y1={0} y2={scoreCoverageWarnPct} fill="#fef3c7" fillOpacity={0.35} />
                      <ReferenceLine y={scoreCoverageWarnPct} stroke="#f59e0b" strokeDasharray="4 4" />
                      <Line
                        type="monotone"
                        dataKey="score_coverage_pct"
                        stroke={latestScoreCoverageBelowWarn ? "#d97706" : "#0f766e"}
                        strokeWidth={2}
                        dot={(dotProps: unknown) => {
                          const point = dotProps as {
                            cx?: number;
                            cy?: number;
                            payload?: { score_coverage_pct?: number };
                          };
                          if (typeof point.cx !== "number" || typeof point.cy !== "number") return null;
                          const pointCoverage = point.payload?.score_coverage_pct ?? 0;
                          if (pointCoverage >= scoreCoverageWarnPct) return null;
                          return (
                            <circle
                              cx={point.cx}
                              cy={point.cy}
                              r={2.5}
                              fill="#dc2626"
                              stroke="#ffffff"
                              strokeWidth={1}
                            />
                          );
                        }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  Red dots mark buckets below the coverage floor.
                </p>
                <p
                  className={clsx(
                    "text-xs",
                    latestScoreCoverageBelowWarn
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-emerald-700 dark:text-emerald-300",
                  )}
                >
                  {latestScoreCoverageBelowWarn
                    ? "Latest bucket is below the coverage warning floor."
                    : scoreCoverageStatus === "recovered"
                      ? `Recovered with no below-floor buckets in the last ${STALE_BREACH_HOURS}h.`
                    : scoreCoverageBelowWarnBuckets > 0
                      ? "Latest bucket recovered above floor; earlier buckets dipped below."
                      : "All buckets in this window stayed above the coverage warning floor."}
                </p>
              </div>
            </ChartCard>

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
                <div className="flex items-center justify-between">
                  <span>Quality score coverage minimum</span>
                  <span className="font-medium">{fmtPct(thresholds?.quality_score_coverage_warn ?? 0)}</span>
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
                    <div className="mt-2 grid gap-2 text-xs text-gray-600 dark:text-gray-400 sm:grid-cols-2 lg:grid-cols-4">
                      <span>Regressed: {fmtPct(bucket.regressed_rate)}</span>
                      <span>Re-ground: {fmtPct(bucket.reground_required_rate)}</span>
                      <span>Scope coverage: {fmtPct(bucket.global_scope_coverage)}</span>
                      <span>Score coverage: {fmtPct(bucket.quality_score_coverage ?? 0)}</span>
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
