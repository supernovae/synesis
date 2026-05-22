import { useState } from "react";
import { Link } from "react-router-dom";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import {
  useCacheMetrics,
  useCacheHistory,
  useCacheCanaryReport,
  useTokenEconomicsMetrics,
  useYarnReducerTelemetryHistory,
} from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { Database, Zap, Target, Server, Key, Activity, BarChart3, ShieldCheck, AlertTriangle } from "lucide-react";
import type { CacheCanaryReportObservability, PrefixCacheServiceMetrics, TokenEconomicsObservability } from "../../types";

const PERIOD_OPTIONS = [
  { label: "1h", hours: 1 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

function mergeHitRateHistory(
  snapshots: import("../../types").CacheHistorySnapshot[],
): { time: string; label: string; planner?: number; yarn?: number }[] {
  const buckets = new Map<string, { time: string; label: string; planner?: number; yarn?: number }>();
  for (const s of snapshots) {
    if (!s.captured_at) continue;
    const d = new Date(s.captured_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 16);
    let row = buckets.get(key);
    if (!row) {
      row = {
        time: key,
        label: d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      };
      buckets.set(key, row);
    }
    const hr = Math.round(s.hit_rate * 100);
    if (s.service === "planner") row.planner = hr;
    if (s.service === "yarn") row.yarn = hr;
  }
  return Array.from(buckets.values()).sort((a, b) => a.time.localeCompare(b.time));
}

function PrefixCacheCard({
  label,
  metrics,
}: {
  label: string;
  metrics: PrefixCacheServiceMetrics;
}) {
  const hitPct = (metrics.hit_rate * 100).toFixed(1);
  const cacheWrite = metrics.cache_write_tokens ?? 0;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
        {label} Prefix Cache
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          label="Hit Rate"
          value={`${hitPct}%`}
          icon={Target}
          subtitle="Provider-reported cache reads / total prompt"
        />
        <MetricCard
          label="Cached Tokens (read)"
          value={metrics.cached_prompt_tokens.toLocaleString()}
          icon={Zap}
          subtitle="Prompt tokens served from provider cache"
        />
        {cacheWrite > 0 && (
          <MetricCard
            label="Cache Write Tokens"
            value={cacheWrite.toLocaleString()}
            icon={Zap}
            subtitle="Tokens written to provider cache"
          />
        )}
        <MetricCard
          label="Total Prompt Tokens"
          value={metrics.total_prompt_tokens.toLocaleString()}
          icon={Database}
        />
        <MetricCard
          label="Requests"
          value={metrics.requests.toLocaleString()}
          icon={Activity}
        />
        {metrics.estimated_cost_usd != null && metrics.estimated_cost_usd > 0 ? (
          <MetricCard
            label="LLM cost (Estimated)"
            value={`$${metrics.estimated_cost_usd.toFixed(4)}`}
            icon={Database}
            subtitle="Forecast based on rates"
          />
        ) : null}
        <MetricCard
          label="Cache value (est.)"
          subtitle="Proxy from cached/total × est. cost"
          value={`$${metrics.estimated_savings_usd.toFixed(4)}`}
          icon={Zap}
        />
        {metrics.mode && (
          <MetricCard label="Mode" value={metrics.mode} icon={Key} />
        )}
      </div>
      {metrics.hit_rate === 0 && metrics.total_prompt_tokens > 0 && (
        <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          Hit rate is 0% — most OpenAI-compatible providers (Alibaba, DeepInfra, Groq, xAI,
          OpenRouter) do not report <code>prompt_tokens_details.cached_tokens</code> in their API responses
          even when server-side prefix caching is active. vLLM requires <code>--enable-prompt-tokens-details</code>.
          Stable prefix and transcript pruning still reduce actual compute cost upstream.
        </p>
      )}
    </div>
  );
}

function OptimizationsCard({
  optimizations,
}: {
  optimizations: NonNullable<PrefixCacheServiceMetrics["optimizations"]>;
}) {
  const tp = optimizations.transcriptPruning;
  const tr = optimizations.toolResultReduction as Record<string, unknown> | undefined;
  const ff = optimizations.featureFlags;

  const enabledFlags = ff
    ? Object.entries(ff).filter(([, v]) => v).length
    : 0;
  const totalFlags = ff ? Object.keys(ff).length : 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
        Coder token efficiency
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tp && (
          <>
            <MetricCard
              label="Transcript Pruning"
              value={tp.invocations?.toLocaleString() ?? "0"}
              icon={Zap}
              subtitle="Invocations (prune passes)"
            />
            <MetricCard
              label="Chars Saved (pruning)"
              value={(tp.totalCharsSaved ?? 0).toLocaleString()}
              icon={Target}
              subtitle="Cumulative characters removed"
            />
            <MetricCard
              label="Tool Results Evicted"
              value={(tp.toolResultsEvicted ?? 0).toLocaleString()}
              icon={Activity}
              subtitle="Stale tool outputs replaced with stubs"
            />
            <MetricCard
              label="File Reads Deduped"
              value={(tp.fileDeduped ?? 0).toLocaleString()}
              icon={Database}
              subtitle="Superseded file read results"
            />
            <MetricCard
              label="Assistant Condensed"
              value={(tp.assistantCondensed ?? 0).toLocaleString()}
              icon={Activity}
              subtitle="Old assistant messages truncated"
            />
          </>
        )}
        {tr && (
          <>
            <MetricCard
              label="Tool outputs transformed"
              value={(typeof tr.reducedCount === "number" ? tr.reducedCount : 0).toLocaleString()}
              icon={Zap}
              subtitle="Reducer invocations (live process)"
            />
            <MetricCard
              label="Raw chars in (reducer)"
              value={(typeof tr.rawCharsTotal === "number" ? tr.rawCharsTotal : 0).toLocaleString()}
              icon={Database}
              subtitle="Input size before reduction"
            />
            <MetricCard
              label="Reduced chars out"
              value={(typeof tr.reducedCharsTotal === "number" ? tr.reducedCharsTotal : 0).toLocaleString()}
              icon={Target}
              subtitle="Size after reduction"
            />
            <MetricCard
              label="Net chars saved (reducer)"
              value={(typeof tr.netCharsSavedTotal === "number" ? tr.netCharsSavedTotal : 0).toLocaleString()}
              icon={Activity}
              subtitle="Cumulative raw − reduced (live)"
            />
          </>
        )}
        {optimizations.validationNormalization &&
          typeof optimizations.validationNormalization === "object" &&
          !Array.isArray(optimizations.validationNormalization) && (
            <MetricCard
              label="Validation normalization"
              value="active"
              icon={Key}
              subtitle="JSON / envelope normalization (see telemetry for counters)"
            />
          )}
        {ff && (
          <MetricCard
            label="Feature Flags"
            value={`${enabledFlags}/${totalFlags}`}
            icon={Key}
            subtitle="Optimization flags enabled"
          />
        )}
      </div>
      {ff && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            Feature flag details
          </summary>
          <div className="mt-2 grid gap-1 text-xs">
            {Object.entries(ff)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, val]) => (
                <div key={key} className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      val ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"
                    }`}
                  />
                  <span className="font-mono text-gray-600 dark:text-gray-400">{key}</span>
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}

function topCounterEntry(counter: Record<string, number> | undefined): [string, number] | null {
  if (!counter) return null;
  const entries = Object.entries(counter).sort((a, b) => b[1] - a[1]);
  return entries[0] ?? null;
}

function counterValue(counter: Record<string, number> | undefined, key: string): number {
  return counter?.[key] ?? 0;
}

function TokenEconomicsCard({ metrics }: { metrics: TokenEconomicsObservability | undefined }) {
  const token = metrics?.token_economics;
  const policy = metrics?.cache_policy;
  const topRecommendation = topCounterEntry(token?.recommendations);
  const topAction = topCounterEntry(policy?.actions);
  const topWarning = topCounterEntry(token?.warnings);
  const topPolicyReason = topCounterEntry(policy?.reasons);
  const observations = token?.request_observation_count ?? 0;
  const decisions = policy?.decision_count ?? 0;
  const hasEvents = Boolean((metrics?.inspected_events ?? 0) > 0);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
        <ShieldCheck className="h-4 w-4" />
        Token economics controller
      </h3>
      {hasEvents ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard
              label="Observed requests"
              value={observations.toLocaleString()}
              icon={Activity}
              subtitle={`${metrics?.inspected_events.toLocaleString() ?? "0"} relevant events in ${metrics?.since_hours ?? 24}h`}
            />
            <MetricCard
              label="Avg cache hit"
              value={`${(token?.avg_cache_hit_pct ?? 0).toFixed(1)}%`}
              icon={Target}
              subtitle="Provider-reported hit pct from request trajectories"
            />
            <MetricCard
              label="Warnings"
              value={(token?.warning_event_count ?? 0).toLocaleString()}
              icon={AlertTriangle}
              subtitle={topWarning ? `${topWarning[0]} (${topWarning[1]})` : "No warning event types"}
            />
            <MetricCard
              label="Top recommendation"
              value={topRecommendation?.[0] ?? "none"}
              icon={Key}
              subtitle={topRecommendation ? `${topRecommendation[1]} request observations` : undefined}
            />
            <MetricCard
              label="Controller decisions"
              value={decisions.toLocaleString()}
              icon={ShieldCheck}
              subtitle={topAction ? `${topAction[0]} (${topAction[1]})` : "No controller decisions"}
            />
            <MetricCard
              label="Safety backoffs"
              value={(policy?.retry_loop_risk_count ?? 0).toLocaleString()}
              icon={AlertTriangle}
              subtitle={topPolicyReason ? `Top reason: ${topPolicyReason[0]}` : undefined}
            />
            <MetricCard
              label="Cache unavailable"
              value={(policy?.cache_unavailable_count ?? 0).toLocaleString()}
              icon={Server}
              subtitle="Miss streaks or missing telemetry crossed threshold"
            />
            <MetricCard
              label="Premium suppressed"
              value={(policy?.premium_write_suppressed_count ?? 0).toLocaleString()}
              icon={Zap}
              subtitle={`${token?.premium_write_without_read_count ?? 0} premium write-without-read warnings`}
            />
            <MetricCard
              label="Cache outcomes"
              value={`hit ${counterValue(token?.cache_outcomes, "hit")} / miss ${counterValue(token?.cache_outcomes, "miss")}`}
              icon={Database}
              subtitle={`write-only ${counterValue(token?.cache_outcomes, "write_without_read")}, no usage ${counterValue(token?.cache_outcomes, "no_usage")}`}
            />
          </div>
          {(policy?.latest.length || token?.latest.length) ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                Latest controller and token-economics events
              </summary>
              <div className="mt-2 grid gap-2 text-xs text-gray-600 dark:text-gray-300">
                {policy?.latest.slice(0, 5).map((ev, idx) => (
                  <div key={`policy-${ev.request_id ?? ev.session_key}-${idx}`} className="font-mono">
                    {ev.action || "observe"} / {ev.compaction_mode || "default"} / {ev.provider || "provider"}{" "}
                    {ev.reasons?.length ? `(${ev.reasons.join(", ")})` : ""}
                  </div>
                ))}
                {token?.latest.slice(0, 5).map((ev, idx) => (
                  <div key={`token-${ev.request_id ?? ev.session_key}-${idx}`} className="font-mono">
                    {ev.cache_outcome || "unknown"} / {ev.recommendation || "observe"} / hit{" "}
                    {Number(ev.cache_hit_pct ?? 0).toFixed(0)}%{" "}
                    {ev.warnings?.length ? `(${ev.warnings.join(", ")})` : ""}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          No token-economics or cache-policy controller events in this window. Events appear after Yarn emits
          request trajectories, token warning events, or controller decisions.
        </p>
      )}
    </div>
  );
}

function reportTime(value: string | null | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function alertClass(severity: "info" | "warning" | "error"): string {
  if (severity === "error") {
    return "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200";
  }
  if (severity === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200";
  }
  return "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200";
}

function CacheCanaryReportCard({ report }: { report: CacheCanaryReportObservability | undefined }) {
  if (!report) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
          <ShieldCheck className="h-4 w-4" />
          Provider cache canaries
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">Loading cache canary report status...</p>
      </div>
    );
  }

  const errors = report.alerts.filter((alert) => alert.severity === "error").length;
  const warnings = report.alerts.filter((alert) => alert.severity === "warning").length;
  const passedOffline = Math.max(0, report.summary.total - report.summary.failed);
  const passedLive = Math.max(0, report.live_summary.total - report.live_summary.failed - report.live_summary.skipped);
  const status = !report.configured ? "not configured" : !report.present ? "missing" : report.stale ? "stale" : "fresh";
  const notableLiveResults = report.live_results
    .filter((result) => result.status !== "skipped" || result.warnings.length > 0 || result.failures.length > 0)
    .slice(0, 8);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
        <ShieldCheck className="h-4 w-4" />
        Provider cache canaries
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          label="Report status"
          value={status}
          icon={report.stale || !report.present ? AlertTriangle : ShieldCheck}
          subtitle={report.generated_at ? `Generated ${reportTime(report.generated_at)}` : "Latest generated_at unavailable"}
        />
        <MetricCard
          label="Offline canaries"
          value={report.summary.total > 0 ? `${passedOffline}/${report.summary.total}` : "none"}
          icon={Database}
          subtitle={`${report.summary.failed} failed`}
        />
        <MetricCard
          label="Live canaries"
          value={report.live_summary.total > 0 ? `${passedLive}/${report.live_summary.total}` : "none"}
          icon={Activity}
          subtitle={`${report.live_summary.skipped} skipped, ${report.live_summary.failed} failed`}
        />
        <MetricCard
          label="Canary mode"
          value={report.mode}
          icon={Key}
          subtitle={report.modified_at ? `Modified ${reportTime(report.modified_at)}` : undefined}
        />
        <MetricCard
          label="Warnings"
          value={warnings.toLocaleString()}
          icon={AlertTriangle}
          subtitle="Cache uncertainty and skipped live probes"
        />
        <MetricCard
          label="Errors"
          value={errors.toLocaleString()}
          icon={AlertTriangle}
          subtitle="Failed offline/live probes or unreadable report"
        />
      </div>

      {report.path ? (
        <p className="mt-3 break-all text-xs text-gray-500 dark:text-gray-400">
          Report path: <code>{report.path}</code>
        </p>
      ) : null}

      {report.alerts.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {report.alerts.slice(0, 10).map((alert, idx) => (
            <div key={`${alert.code}-${alert.provider_id ?? "global"}-${idx}`} className={`rounded border px-3 py-2 text-xs ${alertClass(alert.severity)}`}>
              <div className="font-mono">
                {alert.severity.toUpperCase()} / {alert.code}
                {alert.provider_id ? ` / ${alert.provider_id}` : ""}
              </div>
              <div className="mt-1">{alert.message}</div>
            </div>
          ))}
          {report.alerts.length > 10 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {report.alerts.length - 10} more alert(s) hidden.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200">
          Cache canary report is present and no operator alerts were produced.
        </p>
      )}

      {notableLiveResults.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            Live canary result details
          </summary>
          <div className="mt-2 grid gap-2 text-xs text-gray-600 dark:text-gray-300">
            {notableLiveResults.map((result) => (
              <div key={result.id} className="rounded border border-gray-200 px-3 py-2 dark:border-gray-700">
                <div className="font-mono">
                  {result.id} / {result.status}
                  {result.reason ? ` / ${result.reason}` : ""}
                </div>
                <div className="mt-1">
                  hit {result.cache_hit_pct.toFixed(1)}% / cached {result.cached_prompt_tokens.toLocaleString()} /{" "}
                  recommendation {result.recommendation}
                </div>
                {result.warnings.length > 0 ? <div className="mt-1">warnings: {result.warnings.join(", ")}</div> : null}
                {result.failures.length > 0 ? <div className="mt-1">failures: {result.failures.join(", ")}</div> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export default function CachePerformance() {
  const { data: cache, isLoading, isError, error } = useCacheMetrics();
  const [period, setPeriod] = useState(24);
  const { data: history } = useCacheHistory(period);
  const { data: tokenEconomics, isError: isTokenEconomicsError, error: tokenEconomicsError } =
    useTokenEconomicsMetrics(period);
  const { data: cacheCanaryReport, isError: isCacheCanaryError, error: cacheCanaryError } = useCacheCanaryReport();
  const { data: reducerHistory } = useYarnReducerTelemetryHistory(period);

  const initialLoading = isLoading && cache === undefined && !isError;
  if (initialLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />;
  }

  const data = cache;
  const mergedChart = mergeHitRateHistory(history?.snapshots ?? []);
  const reducerSnapCount = reducerHistory?.snapshot_count ?? 0;
  const cum = reducerHistory?.cumulative;
  const roll = reducerHistory?.rollup;
  const hasPrefixCards = Boolean(data?.planner || data?.yarn);
  const hasCoderEfficiencyLive = Boolean(data?.yarn?.optimizations);
  const hasCoderEfficiencyDb = reducerSnapCount > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          Prefix Cache Performance
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Prometheus counters from the Chat service (planner-ts) and Coder runtime (yarn-ts) at /metrics, plus live
          session stats from /health. Coder token-efficiency metrics combine live /health/telemetry with DB-backed
          reducer snapshots (same source as{" "}
          <Link to="/yarn/reducers" className="text-blue-600 hover:underline dark:text-blue-400">
            Yarn → Reducers
          </Link>
          ). Charts use periodic Postgres snapshots when the telemetry scraper is enabled.
        </p>
      </div>

      <ApiErrorBanner error={isError ? error : undefined} />
      <ApiErrorBanner error={isTokenEconomicsError ? tokenEconomicsError : undefined} />
      <ApiErrorBanner error={isCacheCanaryError ? cacheCanaryError : undefined} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Time window:</span>
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
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Applies to prefix-cache history chart and persisted reducer rollup below.
        </span>
      </div>

      {/* Service-level prefix cache cards */}
      {!data && !isError ? (
        <EmptyState title="No cache data" icon={Database} />
      ) : !hasPrefixCards && !isError ? (
        <EmptyState
          title="No prefix-cache scrape yet"
          icon={Database}
          description="The admin API could not read planner-ts / yarn-ts metrics, or counters are still zero. Verify SYNESIS_PLANNER_TS_URL, SYNESIS_YARN_TS_URL, and network from admin to those services."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data?.planner && <PrefixCacheCard label="Chat (planner-ts)" metrics={data.planner} />}
          {data?.yarn && <PrefixCacheCard label="Coder (yarn-ts)" metrics={data.yarn} />}
        </div>
      )}

      <TokenEconomicsCard metrics={tokenEconomics} />
      <CacheCanaryReportCard report={cacheCanaryReport} />

      {/* Coder: persisted reducer / char totals (windowed, restart-tolerant) */}
      {hasCoderEfficiencyDb && cum && roll ? (
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
            <BarChart3 className="h-4 w-4" />
            Coder reduction — persisted ({period}h window)
          </h3>
          <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
            Totals sum monotonic deltas between telemetry snapshots (Coder restarts handled). Δ is change across the
            selected window. For live process-only counters, see &quot;Coder token efficiency&quot; below or{" "}
            <Link to="/yarn/reducers" className="text-blue-600 hover:underline dark:text-blue-400">
              Reducers
            </Link>
            .
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard
              label="Raw chars in (total)"
              value={(cum.raw_chars_total ?? 0).toLocaleString()}
              icon={Database}
              subtitle="Persisted cumulative in window"
            />
            <MetricCard
              label="Reduced chars out (total)"
              value={(cum.reduced_chars_total ?? 0).toLocaleString()}
              icon={Target}
              subtitle="Persisted cumulative in window"
            />
            <MetricCard
              label="Net chars saved (total)"
              value={(cum.net_chars_saved_total ?? 0).toLocaleString()}
              icon={Activity}
              subtitle="Persisted cumulative in window"
            />
            <MetricCard
              label="Raw chars (Δ in window)"
              value={(roll.raw_chars_delta ?? 0).toLocaleString()}
              icon={Zap}
            />
            <MetricCard
              label="Reduced chars (Δ)"
              value={(roll.reduced_chars_delta ?? 0).toLocaleString()}
              icon={Zap}
            />
            <MetricCard
              label="Snapshots / stale"
              value={`${reducerSnapCount} / ${reducerHistory?.stale ? "stale" : "fresh"}`}
              icon={Server}
              subtitle={
                reducerHistory?.latest_snapshot_at
                  ? `Latest ${new Date(reducerHistory.latest_snapshot_at).toLocaleString()}`
                  : undefined
              }
            />
          </div>
        </div>
      ) : null}

      {/* Coder runtime optimization stats (live telemetry) */}
      {hasCoderEfficiencyLive && data?.yarn?.optimizations ? (
        <OptimizationsCard optimizations={data.yarn.optimizations} />
      ) : hasCoderEfficiencyDb ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Live coder token-efficiency (transcript pruning, feature flags) needs{" "}
          <code className="text-[0.7rem]">yarn-ts /health/telemetry</code> from admin. Persisted reducer char totals in
          this window are shown above.
        </p>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/80 p-4 dark:border-gray-600 dark:bg-gray-900/40">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            <strong className="font-medium">Coder token efficiency</strong> (live transcript pruning, reducers, flags)
            appears when the admin API can read <code className="text-xs">yarn-ts /health/telemetry</code> with{" "}
            <code className="text-xs">INTERNAL_SERVICE_TOKEN</code>. Persisted reducer totals appear once the telemetry
            scraper stores snapshots.
          </p>
        </div>
      )}

      {/* Time-series chart */}
      {mergedChart.length > 0 ? (
        <ChartCard
          title="Cache Hit Rate Over Time"
          subtitle="Percentage of prompt tokens served from prefix cache"
        >
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={mergedChart}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip formatter={(v) => (v == null ? "" : `${Number(v)}%`)} />
              <Legend />
              <Line
                type="monotone"
                dataKey="planner"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
                name="Chat"
              />
              <Line
                type="monotone"
                dataKey="yarn"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={false}
                name="Coder"
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      ) : (
        <ChartCard
          title="Cache Hit Rate Over Time"
          subtitle="Percentage of prompt tokens served from prefix cache"
        >
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No prefix-cache snapshots in this window. The admin telemetry job must write{" "}
            <code className="text-xs">PrefixCacheSnapshot</code> rows (planner-ts and yarn-ts reachable from admin).
          </p>
        </ChartCard>
      )}

      {/* Redis & Sessions */}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.redis && (
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
              Redis
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricCard
                label="Status"
                value={data.redis.status === "connected" ? "Connected" : data.redis.status}
                icon={Server}
              />
              {data.redis.configured != null && (
                <MetricCard
                  label="Redis configured"
                  value={data.redis.configured ? "yes" : "no"}
                  icon={Server}
                />
              )}
              {data.redis.total_keys != null && (
                <MetricCard
                  label="Active sessions (Chat)"
                  value={data.redis.total_keys}
                  icon={Key}
                />
              )}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              “Active sessions” mirrors the Chat service (planner-ts) session count (Redis-backed when REDIS_URL is set), not raw
              Redis DBSIZE.
            </p>
          </div>
        )}

        {data?.sessions && (
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
              Sessions
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.sessions.planner && (
                <>
                  <MetricCard
                    label="Chat session store"
                    value={data.sessions.planner.backend}
                    icon={Key}
                  />
                  <MetricCard
                    label="Chat sessions"
                    value={data.sessions.planner.count}
                    icon={Database}
                  />
                  <MetricCard
                    label="Chat w/ checkpoint"
                    value={data.sessions.planner.checkpoints}
                    icon={Activity}
                  />
                  {data.sessions.planner.total_history_entries != null ? (
                    <MetricCard
                      label="Chat history msgs"
                      value={data.sessions.planner.total_history_entries}
                      icon={Activity}
                    />
                  ) : null}
                </>
              )}
              {data.sessions.yarn && (
                <>
                  <MetricCard
                    label="Coder active sessions"
                    value={data.sessions.yarn.active}
                    icon={Activity}
                  />
                  {data.sessions.yarn.total_history_entries != null ? (
                    <MetricCard
                      label="Coder history msgs"
                      value={data.sessions.yarn.total_history_entries}
                      icon={Database}
                    />
                  ) : null}
                  {data.sessions.yarn.checkpointed_sessions != null ? (
                    <MetricCard
                      label="Coder checkpointed"
                      value={data.sessions.yarn.checkpointed_sessions}
                      icon={Target}
                    />
                  ) : null}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
