import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBenchmarks } from "../../api/hooks";
import client from "../../api/client";
import EmptyState from "../../components/common/EmptyState";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import { Target, Timer, TrendingUp, Play } from "lucide-react";

function useRunBenchmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.post("/rag/benchmarks/run").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rag", "benchmarks"] });
    },
  });
}

export default function Benchmarks() {
  const { data, isLoading } = useBenchmarks();
  const runMutation = useRunBenchmark();

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />;
  }

  if (!data?.aggregate || Object.keys(data.aggregate).length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
              Retrieval Benchmarks
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Hybrid retrieval benchmark results
            </p>
          </div>
          <button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Play className={`h-4 w-4 ${runMutation.isPending ? "animate-pulse" : ""}`} />
            {runMutation.isPending ? "Running..." : "Run Benchmark"}
          </button>
        </div>
        <EmptyState
          title="No benchmark data"
          description="Click 'Run Benchmark' to execute a retrieval quality test"
        />
      </div>
    );
  }

  const agg = data.aggregate;

  const qualityMetrics = Object.entries(agg)
    .filter(([k]) => k.startsWith("recall") || k.startsWith("mrr") || k.startsWith("ndcg"))
    .map(([key, value]) => ({ metric: key, value: Number(value) }));

  const latencyMetrics = Object.entries(agg)
    .filter(([k]) => k.includes("ms"))
    .map(([key, value]) => ({ metric: key, value: Number(value) }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Retrieval Benchmarks
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {data.run_id ? `Run: ${data.run_id}` : "Hybrid retrieval benchmark results"}
          </p>
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <Play className={`h-4 w-4 ${runMutation.isPending ? "animate-pulse" : ""}`} />
          {runMutation.isPending ? "Running..." : "Run Benchmark"}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <MetricCard label="recall@10" value={(agg["recall@10"] ?? 0).toFixed(3)} icon={Target} />
        <MetricCard label="mrr@10" value={(agg["mrr@10"] ?? 0).toFixed(3)} icon={TrendingUp} />
        <MetricCard label="ndcg@10" value={(agg["ndcg@10"] ?? 0).toFixed(3)} />
        <MetricCard label="p95 Latency" value={`${(agg["p95_ms"] ?? 0).toFixed(0)}ms`} icon={Timer} />
      </div>

      {qualityMetrics.length > 0 && (
        <ChartCard title="Quality Metrics">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={qualityMetrics}>
              <XAxis dataKey="metric" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => v.toFixed(3)} />
              <Bar dataKey="value" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {latencyMetrics.length > 0 && (
        <ChartCard title="Latency Percentiles" subtitle="Milliseconds">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={latencyMetrics}>
              <XAxis dataKey="metric" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => `${v.toFixed(0)}ms`} />
              <Bar dataKey="value" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {data.per_query?.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <h3 className="mb-2 text-sm font-medium text-gray-900">
            Per-Query Results ({data.per_query.length} queries)
          </h3>
          <div className="max-h-64 overflow-y-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b">
                  {Object.keys(data.per_query[0]).map((k) => (
                    <th key={k} className="px-2 py-1 text-left font-medium text-gray-500">{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.per_query.slice(0, 50).map((row, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    {Object.values(row).map((v, j) => (
                      <td key={j} className="px-2 py-1 text-gray-600">
                        {typeof v === "number" ? v.toFixed(3) : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
