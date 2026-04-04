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
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
];

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
        <MetricCard
          label="Est. Savings"
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

  const chartData = (history?.snapshots ?? []).map((s) => ({
    time: new Date(s.captured_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    service: s.service,
    hit_rate: Math.round(s.hit_rate * 100),
    requests: s.requests,
    savings: s.estimated_savings_usd,
  }));

  const plannerChart = chartData.filter((d) => d.service === "planner");
  const yarnChart = chartData.filter((d) => d.service === "yarn");
  const mergedChart = plannerChart.map((p, i) => ({
    time: p.time,
    planner: p.hit_rate,
    yarn: yarnChart[i]?.hit_rate ?? 0,
  }));

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
                <XAxis dataKey="time" tick={{ fontSize: 11 }} />
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
              {data.redis.total_keys != null && (
                <MetricCard
                  label="Total Keys"
                  value={data.redis.total_keys}
                  icon={Key}
                />
              )}
            </div>
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
                    label="Planner Backend"
                    value={data.sessions.planner.backend}
                    icon={Key}
                  />
                  <MetricCard
                    label="Planner Sessions"
                    value={data.sessions.planner.count}
                    icon={Database}
                  />
                </>
              )}
              {data.sessions.yarn && (
                <MetricCard
                  label="Yarn Active"
                  value={data.sessions.yarn.active}
                  icon={Activity}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
