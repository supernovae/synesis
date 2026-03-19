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
import { useDetailedPerformance, useLatencyTrend } from "../../api/hooks";
import type { DetailedModelPerformance, LatencyTrendPoint } from "../../api/hooks";
import ChartCard from "../../components/common/ChartCard";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";
import MetricCard from "../../components/common/MetricCard";

const COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

function shortModel(name: string): string {
  const parts = name.split("/");
  return parts[parts.length - 1].substring(0, 28);
}

export default function ModelPerformance() {
  const [days, setDays] = useState(7);
  const { data: perfData, isLoading: perfLoading } = useDetailedPerformance(days);
  const { data: trendData, isLoading: trendLoading } = useLatencyTrend(days);

  const models = perfData?.models ?? [];
  const trend = trendData?.trend ?? [];

  const totalRequests = models.reduce((s, m) => s + m.request_count, 0);
  const avgLatency =
    models.length > 0
      ? models.reduce((s, m) => s + m.avg_latency_ms * m.request_count, 0) / (totalRequests || 1)
      : 0;
  const slowest = models.length > 0 ? models.reduce((a, b) => (a.p95_latency_ms > b.p95_latency_ms ? a : b)) : null;
  const totalCost = models.reduce((s, m) => s + m.total_actual_cost, 0);

  const trendModels = useMemo(() => {
    const set = new Set<string>();
    trend.forEach((t) => set.add(t.model));
    return Array.from(set);
  }, [trend]);

  const pivotedTrend = useMemo(() => {
    const byDate: Record<string, Record<string, number>> = {};
    for (const t of trend) {
      if (!byDate[t.date]) byDate[t.date] = { date: t.date } as never;
      (byDate[t.date] as Record<string, number>)[shortModel(t.model)] = t.avg_latency_ms;
    }
    return Object.values(byDate);
  }, [trend]);

  const latencyChartData = models.map((m) => ({
    model: shortModel(m.model),
    avg: Math.round(m.avg_latency_ms),
    p95: Math.round(m.p95_latency_ms),
  }));

  const isLoading = perfLoading || trendLoading;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Model Performance</h1>
          <p className="mt-1 text-sm text-gray-500">
            Per-model latency, request volume, and throughput from trace data
          </p>
        </div>
        <select
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm"
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
            <div key={i} className="h-24 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : models.length === 0 ? (
        <EmptyState
          title="No performance data"
          description="Metrics will populate after requests flow through the pipeline"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <MetricCard
              label="Total Requests"
              value={totalRequests.toLocaleString()}
              icon={Activity}
            />
            <MetricCard
              label="Avg Latency"
              value={`${Math.round(avgLatency)}ms`}
              icon={Clock}
            />
            <MetricCard
              label="Slowest (p95)"
              value={slowest ? `${Math.round(slowest.p95_latency_ms)}ms` : "-"}
              subtitle={slowest ? shortModel(slowest.model) : undefined}
              icon={Zap}
            />
            <MetricCard
              label="Actual Cost"
              value={`$${totalCost.toFixed(4)}`}
              icon={DollarSign}
            />
          </div>

          <ChartCard title="Latency by Model (avg + p95)">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={latencyChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="model"
                  tick={{ fontSize: 10 }}
                  interval={0}
                  angle={-20}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fontSize: 11 }} label={{ value: "ms", angle: -90, position: "insideLeft" }} />
                <Tooltip formatter={(v: number) => `${v.toLocaleString()}ms`} />
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
                  {trendModels.map((m, i) => (
                    <Line
                      key={m}
                      type="monotone"
                      dataKey={shortModel(m)}
                      stroke={COLORS[i % COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          <DataTable
            columns={[
              { key: "model", label: "Model", sortable: true, render: (r: DetailedModelPerformance) => shortModel(r.model) },
              { key: "request_count", label: "Requests", sortable: true, render: (r: DetailedModelPerformance) => r.request_count.toLocaleString() },
              { key: "avg_latency_ms", label: "Avg Latency", sortable: true, render: (r: DetailedModelPerformance) => `${r.avg_latency_ms.toFixed(0)}ms` },
              { key: "p95_latency_ms", label: "p95 Latency", sortable: true, render: (r: DetailedModelPerformance) => `${r.p95_latency_ms.toFixed(0)}ms` },
              { key: "total_tokens", label: "Total Tokens", sortable: true, render: (r: DetailedModelPerformance) => r.total_tokens.toLocaleString() },
              { key: "total_actual_cost", label: "Actual Cost", sortable: true, render: (r: DetailedModelPerformance) => `$${r.total_actual_cost.toFixed(4)}` },
            ]}
            data={models}
            keyField="model"
          />
        </>
      )}
    </div>
  );
}
