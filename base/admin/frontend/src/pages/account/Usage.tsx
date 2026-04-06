import { useState } from "react";
import { useUsageMeSummary, useUsageMeSeries, useYarnUserUsage } from "../../api/hooks";
import type { UsageTimeSeriesEntry } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import { Coins, Clock, Zap, AlertTriangle, Hash } from "lucide-react";
import { fmtCost, fmtDurationMs, fmtTokens } from "../../lib/formatUsage";

const PERIOD_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

function fmtBucket(iso: string): string {
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

type UsageSummarySectionProps = {
  title: string;
  subtitle: string;
  requests: number;
  tokens: number;
  costUsd: number;
  avgLatencyMs: number;
  details?: string;
};

function UsageSummarySection({
  title,
  subtitle,
  requests,
  tokens,
  costUsd,
  avgLatencyMs,
  details,
}: UsageSummarySectionProps) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <MetricCard label="Requests" value={requests.toLocaleString()} icon={Hash} />
        <MetricCard label="Tokens" value={fmtTokens(tokens)} icon={Zap} />
        <MetricCard label="Cost (Effective)" value={fmtCost(costUsd)} icon={Coins} />
        <MetricCard label="Avg Latency" value={fmtDurationMs(avgLatencyMs)} icon={Clock} />
      </div>
      {details ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{details}</p>
      ) : null}
    </div>
  );
}

export default function Usage() {
  const [period, setPeriod] = useState(24);
  const { data: summary, isLoading: summaryLoading } = useUsageMeSummary(period);
  const { data: series, isLoading: seriesLoading } = useUsageMeSeries(period);
  const { data: yarnUsage, isLoading: yarnLoading } = useYarnUserUsage(
    period <= 24 ? 24 : period <= 168 ? 168 : 720,
  );

  const loading = summaryLoading || seriesLoading;
  const bucketRows: UsageTimeSeriesEntry[] = series ?? [];
  const plannerRequests = summary?.trace_count ?? 0;
  const plannerTokens = summary?.total_tokens ?? 0;
  const plannerCost = summary?.actual_cost_usd && summary.actual_cost_usd > 0 ? summary.actual_cost_usd : (summary?.estimated_cost_usd ?? 0);
  const plannerLatency = summary?.avg_duration_ms ?? 0;
  const plannerErrors = summary?.error_count ?? 0;
  const plannerHasData = plannerRequests > 0;

  const coderRequests = yarnUsage?.total_requests ?? 0;
  const coderTokens = (yarnUsage?.tokens_in ?? 0) + (yarnUsage?.tokens_out ?? 0);
  const coderCost = yarnUsage?.actual_cost_usd && yarnUsage.actual_cost_usd > 0 ? yarnUsage.actual_cost_usd : (yarnUsage?.estimated_cost_usd ?? 0);
  const coderLatency = yarnUsage?.avg_latency_ms ?? 0;
  const coderCached = yarnUsage?.tokens_cached ?? 0;
  const coderErrors = yarnUsage?.errors ?? 0;
  const coderEscalations = yarnUsage?.escalations ?? 0;
  const coderHasData = coderRequests > 0;

  const totalRequests = plannerRequests + coderRequests;
  const totalTokens = plannerTokens + coderTokens;
  const totalCost = plannerCost + coderCost;
  const totalLatency =
    totalRequests > 0
      ? (plannerLatency * plannerRequests + coderLatency * coderRequests) / totalRequests
      : 0;
  const totalHasData = totalRequests > 0;

  const hasCostVariance =
    summary && summary.actual_cost_usd > 0 && summary.estimated_cost_usd > 0;

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Usage
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Planner and Coder usage for your account over the selected period.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              onClick={() => setPeriod(opt.hours)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                period === opt.hours
                  ? "bg-indigo-600 text-white"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !summary && !yarnUsage ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading usage data…</p>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-3">
            <UsageSummarySection
              title="Planner Usage"
              subtitle={plannerHasData ? `past ${period}h` : "no data"}
              requests={plannerRequests}
              tokens={plannerTokens}
              costUsd={plannerCost}
              avgLatencyMs={plannerLatency}
              details={
                plannerHasData
                  ? plannerErrors > 0
                    ? `${plannerErrors} errors`
                    : summary?.source === "planner_usage_log"
                      ? "metered from planner usage logs"
                      : undefined
                  : "No planner usage recorded for this period."
              }
            />
            <UsageSummarySection
              title="Coder Usage"
              subtitle={coderHasData ? `past ${period}h` : "no data"}
              requests={coderRequests}
              tokens={coderTokens}
              costUsd={coderCost}
              avgLatencyMs={coderLatency}
              details={
                coderHasData
                  ? [
                      coderCached > 0 ? `${fmtTokens(coderCached)} cached` : null,
                      coderErrors > 0 ? `${coderErrors} errors` : null,
                      coderEscalations > 0 ? `${coderEscalations} escalations` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Coder metering data is available."
                  : "No coder usage recorded for this period."
              }
            />
            <UsageSummarySection
              title="Total Usage"
              subtitle={totalHasData ? `past ${period}h` : "no data"}
              requests={totalRequests}
              tokens={totalTokens}
              costUsd={totalCost}
              avgLatencyMs={totalLatency}
              details={
                totalHasData
                  ? `Combined planner + coder totals`
                  : "No planner or coder usage recorded for this period."
              }
            />
          </div>

          {summary?.note && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/80 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
              {summary?.note}
            </div>
          )}

          {plannerHasData && hasCostVariance && summary && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="text-sm text-amber-800 dark:text-amber-300">
                  <p className="font-medium">Cost variance detected</p>
                  <p className="mt-0.5">
                    Estimated (Forecast) {fmtCost(summary.estimated_cost_usd)} vs Actual (from API){" "}
                    {fmtCost(summary.actual_cost_usd)} (
                    {(
                      ((summary.actual_cost_usd - summary.estimated_cost_usd) /
                        summary.estimated_cost_usd) *
                      100
                    ).toFixed(1)}
                    % difference). Estimated costs use the configured pricing model;
                    actual costs come from provider-reported values when available or reconciled.
                  </p>
                </div>
              </div>
            </div>
          )}

          {bucketRows.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
                        Time
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                        Requests
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                        Tokens
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                        Est. Cost
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                        Actual Cost
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                        Avg Latency
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
                    {bucketRows.slice(0, 50).map((row) => (
                      <tr
                        key={row.bucket}
                        className="hover:bg-gray-50 dark:hover:bg-gray-900"
                      >
                        <td className="whitespace-nowrap px-4 py-2 text-gray-700 dark:text-gray-300">
                          {fmtBucket(row.bucket)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-900 dark:text-gray-100">
                          {row.requests}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium text-gray-900 dark:text-gray-100">
                          {fmtTokens(row.total_tokens)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400" title="Estimated (Forecast)">
                          {fmtCost(row.estimated_cost_usd)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400" title="Actual (from API)">
                          {fmtCost(row.actual_cost_usd)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtDurationMs(row.avg_duration_ms)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {bucketRows.length > 50 && (
                <div className="border-t border-gray-200 bg-gray-50 px-4 py-2 text-center text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  Showing first 50 of {bucketRows.length} time buckets
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
              No planner time-series buckets for this period.
            </div>
          )}
        </>
      )}
      {yarnLoading && !yarnUsage && (
        <div className="h-24 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      )}
    </div>
  );
}
