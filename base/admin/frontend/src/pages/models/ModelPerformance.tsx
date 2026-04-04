import { useState, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Legend,
  CartesianGrid,
} from "recharts";
import { Activity, Clock, Zap, DollarSign } from "lucide-react";
import { usePerformanceByRole, useLatencyTrend } from "../../api/hooks";
import type { RolePerformance } from "../../types";
import ChartCard from "../../components/common/ChartCard";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";
import MetricCard from "../../components/common/MetricCard";

const COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

export default function ModelPerformance() {
  const [days, setDays] = useState(7);
  const { data: perfData, isLoading: perfLoading } = usePerformanceByRole(days);
  const { data: trendData, isLoading: trendLoading } = useLatencyTrend(days);

  const roles: RolePerformance[] = useMemo(() => perfData?.roles ?? [], [perfData]);
  const trend = useMemo(() => trendData?.trend ?? [], [trendData]);
  const activeRoles = useMemo(() => roles.filter((r) => r.assigned), [roles]);
  const activeWithTraffic = useMemo(
    () => activeRoles.filter((r) => r.request_count > 0),
    [activeRoles],
  );
  const displayRoles = activeWithTraffic.length > 0 ? activeWithTraffic : activeRoles;

  const totalRequests = displayRoles.reduce((s, r) => s + r.request_count, 0);
  const totalTokens = displayRoles.reduce((s, r) => s + r.total_tokens, 0);
  const avgLatency =
    displayRoles.length > 0
      ? displayRoles.reduce((s, r) => s + r.avg_latency_ms * r.request_count, 0) / (totalRequests || 1)
      : 0;
  const slowest =
    displayRoles.length > 0
      ? displayRoles.reduce((a, b) => (a.p95_latency_ms > b.p95_latency_ms ? a : b))
      : null;
  const totalCost = displayRoles.reduce((s, r) => s + r.total_actual_cost, 0);
  const windowSeconds = Math.max(1, days * 24 * 60 * 60);
  const rps = totalRequests / windowSeconds;
  const tps = totalTokens / windowSeconds;

  const activeModelHints = useMemo(
    () =>
      new Set(
        displayRoles
          .map((r) => (r.registry_model || r.served_name || "").toLowerCase())
          .filter(Boolean),
      ),
    [displayRoles],
  );
  const scopedTrend = useMemo(() => {
    if (activeModelHints.size === 0) return trend;
    return trend.filter((t) => {
      const model = (t.model || "").toLowerCase();
      for (const hint of activeModelHints) {
        if (model.includes(hint) || hint.includes(model)) return true;
      }
      return false;
    });
  }, [trend, activeModelHints]);

  const trendModels = useMemo(() => {
    const set = new Set<string>();
    scopedTrend.forEach((t) => set.add(t.model));
    return Array.from(set);
  }, [scopedTrend]);

  const pivotedTrend = useMemo(() => {
    const byDate: Record<string, Record<string, number>> = {};
    for (const t of scopedTrend) {
      if (!byDate[t.date]) byDate[t.date] = { date: t.date } as never;
      const parts = t.model.split("/");
      const short = parts[parts.length - 1].substring(0, 28);
      (byDate[t.date] as Record<string, number>)[short] = t.avg_latency_ms;
    }
    return Object.values(byDate);
  }, [scopedTrend]);

  const latencyChartData = displayRoles.map((r) => ({
    role: r.role,
    avg: Math.round(r.avg_latency_ms),
    p95: Math.round(r.p95_latency_ms),
  }));

  const isLoading = perfLoading || trendLoading;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Performance by Role</h1>
          <p className="mt-1 text-sm text-gray-500">
            Active role throughput and latency (RPS/TPS, avg, p95), scoped to current model assignments
          </p>
        </div>
        <select
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7d</option>
          <option value={14}>Last 14d</option>
          <option value={30}>Last 30d</option>
        </select>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      ) : displayRoles.length === 0 ? (
        <EmptyState
          title="No performance data"
          description="Metrics populate after traffic flows through active model roles"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <MetricCard
              label="Total Requests"
              value={totalRequests.toLocaleString()}
              icon={Activity}
            />
            <MetricCard
              label="RPS"
              value={rps.toFixed(rps < 1 ? 3 : 2)}
              subtitle={`${days}d window`}
              icon={Activity}
            />
            <MetricCard
              label="TPS"
              value={tps.toFixed(tps < 1 ? 1 : 0)}
              subtitle={`${totalTokens.toLocaleString()} tokens`}
              icon={Zap}
            />
            <MetricCard
              label="Avg Latency"
              value={`${Math.round(avgLatency)}ms`}
              icon={Clock}
            />
            <MetricCard
              label="Slowest Role (p95)"
              value={slowest ? `${Math.round(slowest.p95_latency_ms)}ms` : "-"}
              subtitle={slowest ? slowest.role : undefined}
              icon={Zap}
            />
            <MetricCard
              label="Actual Cost"
              value={`$${totalCost.toFixed(4)}`}
              icon={DollarSign}
            />
          </div>

          <ChartCard title="Latency by Role (avg + p95)">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={latencyChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="role" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} label={{ value: "ms", angle: -90, position: "insideLeft" }} />
                <Tooltip formatter={(v) => (v == null ? "" : `${Number(v).toLocaleString()}ms`)} />
                <Legend />
                <Bar dataKey="avg" name="Avg Latency" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="p95" name="p95 Latency" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {pivotedTrend.length > 1 && (
            <ChartCard title="Latency Trend (daily avg)">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={pivotedTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} label={{ value: "ms", angle: -90, position: "insideLeft" }} />
                  <Tooltip />
                  <Legend />
                  {trendModels.map((m, i) => {
                    const parts = m.split("/");
                    const short = parts[parts.length - 1].substring(0, 28);
                    return (
                      <Line
                        key={m}
                        type="monotone"
                        dataKey={short}
                        stroke={COLORS[i % COLORS.length]}
                        strokeWidth={2}
                        dot={false}
                      />
                    );
                  })}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          <DataTable
            columns={[
              { key: "role", label: "Role", sortable: true },
              {
                key: "registry_model",
                label: "Configured model",
                sortable: true,
                render: (r: RolePerformance) =>
                  r.assigned ? (r.registry_model || r.served_name || "—") : "—",
              },
              {
                key: "registry_provider",
                label: "Provider",
                sortable: true,
                render: (r: RolePerformance) => (r.assigned ? r.registry_provider || "—" : "—"),
              },
              { key: "request_count", label: "Requests", sortable: true, render: (r: RolePerformance) => r.request_count.toLocaleString() },
              { key: "avg_latency_ms", label: "Avg Latency", sortable: true, render: (r: RolePerformance) => `${r.avg_latency_ms.toFixed(0)}ms` },
              { key: "p95_latency_ms", label: "p95 Latency", sortable: true, render: (r: RolePerformance) => `${r.p95_latency_ms.toFixed(0)}ms` },
              { key: "total_tokens", label: "Total Tokens", sortable: true, render: (r: RolePerformance) => r.total_tokens.toLocaleString() },
              { key: "total_actual_cost", label: "Actual Cost", sortable: true, render: (r: RolePerformance) => `$${r.total_actual_cost.toFixed(4)}` },
            ]}
            data={displayRoles}
            keyField="role"
          />
        </>
      )}
    </div>
  );
}
