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
import { useCacheMetrics, useCacheHistory, useYarnReducerTelemetryHistory } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { Database, Zap, Target, Server, Key, Activity, BarChart3 } from "lucide-react";
import type { PrefixCacheServiceMetrics } from "../../types";

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

export default function CachePerformance() {
  const { data: cache, isLoading, isError, error } = useCacheMetrics();
  const [period, setPeriod] = useState(24);
  const { data: history } = useCacheHistory(period);
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
