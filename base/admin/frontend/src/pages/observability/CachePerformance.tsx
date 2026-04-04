import { useState } from "react";
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
import { useCacheMetrics, useCacheHistory } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";
import { Database, Zap, Target, Server, Key, Activity } from "lucide-react";
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
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
        {label} Prefix Cache
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          label="Hit Rate"
          value={`${hitPct}%`}
          icon={Target}
        />
        <MetricCard
          label="Cached Tokens"
          value={metrics.cached_prompt_tokens.toLocaleString()}
          icon={Zap}
        />
        <MetricCard
          label="Total Tokens"
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
            label="Est. LLM cost (USD)"
            value={`$${metrics.estimated_cost_usd.toFixed(4)}`}
            icon={Database}
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
    </div>
  );
}

export default function CachePerformance() {
  const { data, isLoading } = useCacheMetrics();
  const [period, setPeriod] = useState(24);
  const { data: history } = useCacheHistory(period);

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100" />;
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Prefix Cache Performance
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Provider-level prefix cache metrics for Planner and Yarn
          </p>
        </div>
        <EmptyState title="No cache data" icon={Database} />
      </div>
    );
  }

  const mergedChart = mergeHitRateHistory(history?.snapshots ?? []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Prefix Cache Performance
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Prometheus counters from planner-ts and yarn-ts (/metrics), plus live session stats from /health.
          History below comes from periodic snapshots in Postgres when enabled.
        </p>
      </div>

      {/* Service-level prefix cache cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.planner && (
          <PrefixCacheCard label="Planner" metrics={data.planner} />
        )}
        {data.yarn && (
          <PrefixCacheCard label="Yarn" metrics={data.yarn} />
        )}
      </div>

      {/* Time-series chart */}
      {mergedChart.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-gray-600">Period:</span>
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.hours}
                onClick={() => setPeriod(opt.hours)}
                className={`rounded px-2 py-1 text-xs font-medium ${
                  period === opt.hours
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
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
                  name="Planner"
                />
                <Line
                  type="monotone"
                  dataKey="yarn"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  dot={false}
                  name="Yarn"
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      )}

      {/* Redis & Sessions */}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.redis && (
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
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
                  label="Active sessions (planner)"
                  value={data.redis.total_keys}
                  icon={Key}
                />
              )}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              “Active sessions” mirrors planner-ts session count (Redis-backed when REDIS_URL is set), not raw
              Redis DBSIZE.
            </p>
          </div>
        )}

        {data.sessions && (
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
              Sessions
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.sessions.planner && (
                <>
                  <MetricCard
                    label="Planner store"
                    value={data.sessions.planner.backend}
                    icon={Key}
                  />
                  <MetricCard
                    label="Planner sessions"
                    value={data.sessions.planner.count}
                    icon={Database}
                  />
                  <MetricCard
                    label="Planner w/ checkpoint"
                    value={data.sessions.planner.checkpoints}
                    icon={Activity}
                  />
                  {data.sessions.planner.total_history_entries != null ? (
                    <MetricCard
                      label="Planner history msgs"
                      value={data.sessions.planner.total_history_entries}
                      icon={Activity}
                    />
                  ) : null}
                </>
              )}
              {data.sessions.yarn && (
                <>
                  <MetricCard
                    label="Yarn active sessions"
                    value={data.sessions.yarn.active}
                    icon={Activity}
                  />
                  {data.sessions.yarn.total_history_entries != null ? (
                    <MetricCard
                      label="Yarn history msgs"
                      value={data.sessions.yarn.total_history_entries}
                      icon={Database}
                    />
                  ) : null}
                  {data.sessions.yarn.checkpointed_sessions != null ? (
                    <MetricCard
                      label="Yarn checkpointed"
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
