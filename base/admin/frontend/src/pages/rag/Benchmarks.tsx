import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useBenchmarks, useLatestRagEval, useRagEvalSuites, useRunRagEval } from "../../api/hooks";
import client from "../../api/client";
import EmptyState from "../../components/common/EmptyState";
import MetricCard from "../../components/common/MetricCard";
import ChartCard from "../../components/common/ChartCard";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import { Target, Timer, TrendingUp, Play, Database, FileJson } from "lucide-react";

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
  const { data: suitesData } = useRagEvalSuites();
  const { data: ragEval } = useLatestRagEval();
  const runMutation = useRunBenchmark();
  const runRagEval = useRunRagEval();
  const suiteOptions = suitesData?.suites ?? [];
  const [selectedSuite, setSelectedSuite] = useState("");
  const activeSuite = selectedSuite || suiteOptions[0]?.name || "";
  const ragCases = ragEval?.per_query ?? [];

  const ragQualityMetrics = useMemo(() => {
    const aggregate = ragEval?.aggregate ?? {};
    return [
      "pass_rate",
      "avg_score",
      "symbol_hit_rate",
      "example_hit_rate",
      "anti_pattern_hit_rate",
      "warning_hit_rate",
      "context_card_rate",
      "source_evidence_rate",
    ]
      .filter((key) => aggregate[key] !== undefined)
      .map((key) => ({ metric: key, value: Number(aggregate[key] ?? 0) }));
  }, [ragEval?.aggregate]);

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
              NornicDB graph retrieval benchmark results
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
        <ApiErrorBanner error={runMutation.error} onDismiss={() => runMutation.reset()} />
        <ApiErrorBanner error={runRagEval.error} onDismiss={() => runRagEval.reset()} />
        <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">SynPack Retrieval Evals</h2>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Runs YAML pack cases against planner knowledge bundles and persists training rows.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={activeSuite}
                onChange={(e) => setSelectedSuite(e.target.value)}
                className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              >
                {suiteOptions.map((suite) => (
                  <option key={suite.name} value={suite.name}>
                    {suite.name} ({suite.case_count})
                  </option>
                ))}
              </select>
              <button
                onClick={() => activeSuite && runRagEval.mutate({ suite_name: activeSuite, top_k: 8 })}
                disabled={!activeSuite || runRagEval.isPending}
                className="flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Play className={`h-4 w-4 ${runRagEval.isPending ? "animate-pulse" : ""}`} />
                {runRagEval.isPending ? "Running..." : "Run Eval"}
              </button>
            </div>
          </div>
          <EmptyState
            title="No SynPack eval data"
            description="Run a SynPack retrieval eval after installing a v2 pack to verify symbols, examples, warnings, and context cards."
          />
        </section>
        <EmptyState
          title="No benchmark data"
          description="Run a lightweight NornicDB retrieval probe or import a full regression benchmark"
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
            {data.run_id ? `Run: ${data.run_id}` : "NornicDB graph retrieval benchmark results"}
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

      <ApiErrorBanner error={runMutation.error} onDismiss={() => runMutation.reset()} />
      <ApiErrorBanner error={runRagEval.error} onDismiss={() => runRagEval.reset()} />

      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">SynPack Retrieval Evals</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {ragEval?.run_id
                ? `${ragEval.suite_name || "suite"} run ${ragEval.run_id}`
                : "Validate installed packs return answer-ready, source-backed context bundles."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={activeSuite}
              onChange={(e) => setSelectedSuite(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            >
              {suiteOptions.map((suite) => (
                <option key={suite.name} value={suite.name}>
                  {suite.name} ({suite.case_count})
                </option>
              ))}
            </select>
            <button
              onClick={() => activeSuite && runRagEval.mutate({ suite_name: activeSuite, top_k: 8 })}
              disabled={!activeSuite || runRagEval.isPending}
              className="flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Play className={`h-4 w-4 ${runRagEval.isPending ? "animate-pulse" : ""}`} />
              {runRagEval.isPending ? "Running..." : "Run Eval"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <MetricCard label="Pass Rate" value={`${Math.round(Number(ragEval?.aggregate?.pass_rate ?? 0) * 100)}%`} icon={Target} />
          <MetricCard label="Avg Score" value={Number(ragEval?.aggregate?.avg_score ?? 0).toFixed(3)} icon={TrendingUp} />
          <MetricCard label="Cases" value={String(ragEval?.aggregate?.case_count ?? 0)} icon={Database} />
          <MetricCard label="Training Rows" value={String(ragEval?.training_rows?.length ?? 0)} icon={FileJson} />
        </div>

        {ragQualityMetrics.length > 0 && (
          <div className="mt-5">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={ragQualityMetrics}>
                <XAxis dataKey="metric" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={54} />
                <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => (v == null ? "" : Number(v).toFixed(3))} />
                <Bar dataKey="value" fill="#059669" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {ragCases.length > 0 ? (
          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  {["Case", "Pass", "Score", "Evidence", "Failures"].map((h) => (
                    <th key={h} className="px-2 py-2 text-left font-medium text-gray-500 dark:text-gray-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ragCases.map((row) => (
                  <tr key={row.case_id} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="max-w-xs px-2 py-2">
                      <div className="font-medium text-gray-900 dark:text-gray-100">{row.case_id}</div>
                      <div className="truncate text-gray-500 dark:text-gray-400">{row.query}</div>
                    </td>
                    <td className="px-2 py-2">
                      <span className={`rounded-full px-2 py-1 font-medium ${row.passed ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>
                        {row.passed ? "pass" : "fail"}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-gray-700 dark:text-gray-300">{Number(row.score ?? 0).toFixed(3)}</td>
                    <td className="px-2 py-2 text-gray-600 dark:text-gray-300">
                      {Object.entries(row.counts ?? {}).map(([key, value]) => `${key}:${value}`).join(" ")}
                    </td>
                    <td className="max-w-sm px-2 py-2 text-red-700 dark:text-red-300">
                      {(row.failures ?? []).join("; ") || (row.warnings ?? []).join("; ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-4">
            <EmptyState title="No SynPack eval run yet" />
          </div>
        )}
      </section>

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
              <Tooltip formatter={(v) => (v == null ? "" : Number(v).toFixed(3))} />
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
              <Tooltip formatter={(v) => (v == null ? "" : `${Number(v).toFixed(0)}ms`)} />
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
                  {Object.keys(data.per_query[0] ?? {}).map((k) => (
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
