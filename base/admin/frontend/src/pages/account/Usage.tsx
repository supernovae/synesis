import { useState } from "react";
import { useUsageSummary, useUsageSeries, useYarnUserUsage } from "../../api/hooks";
import type { UsageRollupEntry } from "../../api/hooks";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import { Coins, Clock, Zap, AlertTriangle, Hash, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { fmtCost, fmtDurationMs, fmtTokens } from "../../lib/formatUsage";

const PERIOD_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

function groupByBucket(rows: UsageRollupEntry[]): Record<string, UsageRollupEntry[]> {
  const grouped: Record<string, UsageRollupEntry[]> = {};
  for (const r of rows) {
    (grouped[r.bucket] ??= []).push(r);
  }
  return grouped;
}

interface BucketRow {
  bucket: string;
  requests: number;
  prompt: number;
  completion: number;
  cached: number;
  total: number;
  estimated: number;
  actual: number;
  avgMs: number;
  errors: number;
}

function aggregateBuckets(rows: UsageRollupEntry[]): BucketRow[] {
  const groups = groupByBucket(rows);
  return Object.entries(groups)
    .map(([bucket, entries]) => {
      const requests = entries.reduce((s, e) => s + e.request_count, 0);
      return {
        bucket,
        requests,
        prompt: entries.reduce((s, e) => s + e.prompt_tokens, 0),
        completion: entries.reduce((s, e) => s + e.completion_tokens, 0),
        cached: entries.reduce((s, e) => s + e.cached_tokens, 0),
        total: entries.reduce((s, e) => s + e.total_tokens, 0),
        estimated: entries.reduce((s, e) => s + e.estimated_cost_usd, 0),
        actual: entries.reduce((s, e) => s + e.actual_cost_usd, 0),
        avgMs:
          requests > 0
            ? entries.reduce((s, e) => s + e.avg_duration_ms * e.request_count, 0) / requests
            : 0,
        errors: entries.reduce((s, e) => s + e.error_count, 0),
      };
    })
    .sort((a, b) => b.bucket.localeCompare(a.bucket));
}

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

export default function Usage() {
  const [period, setPeriod] = useState(24);
  const { data: summary, isLoading: summaryLoading } = useUsageSummary(period);
  const { data: series, isLoading: seriesLoading } = useUsageSeries(period);
  const { data: yarnUsage, isLoading: yarnLoading } = useYarnUserUsage(
    period <= 24 ? 24 : period <= 168 ? 168 : 720,
  );

  const loading = summaryLoading || seriesLoading;
  const bucketRows = series ? aggregateBuckets(series) : [];
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
            Pipeline usage from 5-minute rollups (traces). Yarn / IDE spend is separate — see{" "}
            <Link to="/models/overview" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              Models &amp; Costs overview
            </Link>
            .
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

      {loading && !summary ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading usage data…</p>
      ) : !summary || summary.total_requests === 0 ? (
        <EmptyState
          title="No usage data for this period"
          description="Usage is aggregated from trace records in 5-minute buckets. Run some requests to see data here."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Total Requests"
              value={summary.total_requests.toLocaleString()}
              icon={Hash}
              subtitle={`past ${period}h`}
            />
            <MetricCard
              label="Total Tokens"
              value={fmtTokens(summary.total_tokens)}
              icon={Zap}
              subtitle={`${fmtTokens(summary.prompt_tokens)} prompt · ${fmtTokens(summary.completion_tokens)} completion`}
            />
            <MetricCard
              label="Estimated Cost"
              value={fmtCost(summary.estimated_cost_usd)}
              icon={Coins}
              subtitle={
                hasCostVariance
                  ? `actual: ${fmtCost(summary.actual_cost_usd)}`
                  : "from trace pricing model"
              }
            />
            <MetricCard
              label="Avg Latency"
              value={fmtDurationMs(summary.avg_duration_ms)}
              icon={Clock}
              subtitle={
                summary.error_count > 0
                  ? `${summary.error_count} errors`
                  : undefined
              }
            />
          </div>

          {summary.cached_tokens > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                <span className="font-medium text-green-600 dark:text-green-400">
                  {fmtTokens(summary.cached_tokens)}
                </span>{" "}
                cached prompt tokens ({((summary.cached_tokens / summary.prompt_tokens) * 100).toFixed(1)}%
                of prompt tokens served from KV-cache)
              </p>
            </div>
          )}

          {hasCostVariance && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="text-sm text-amber-800 dark:text-amber-300">
                  <p className="font-medium">Cost variance detected</p>
                  <p className="mt-0.5">
                    Estimated {fmtCost(summary.estimated_cost_usd)} vs actual{" "}
                    {fmtCost(summary.actual_cost_usd)} (
                    {(
                      ((summary.actual_cost_usd - summary.estimated_cost_usd) /
                        summary.estimated_cost_usd) *
                      100
                    ).toFixed(1)}
                    % difference). Estimated costs use the configured pricing model;
                    actual costs come from provider-reported values when available.
                  </p>
                </div>
              </div>
            </div>
          )}

          {bucketRows.length > 0 && (
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
                        Prompt
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                        Completion
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                        Total
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">
                        Est. Cost
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
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtTokens(row.prompt)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtTokens(row.completion)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium text-gray-900 dark:text-gray-100">
                          {fmtTokens(row.total)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtCost(row.estimated)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtDurationMs(row.avgMs)}
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
          )}
        </>
      )}

      {/* Yarn Agent Consumption */}
      <div className="border-t border-gray-200 pt-8 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-violet-500" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Yarn Agent Usage
          </h2>
        </div>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Token consumption and performance from the Yarn coding agent
        </p>
      </div>

      {yarnLoading ? (
        <div className="h-28 animate-pulse rounded-lg bg-gray-100" />
      ) : !yarnUsage || yarnUsage.total_requests === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center dark:border-gray-700 dark:bg-gray-900">
          <Sparkles className="mx-auto h-8 w-8 text-gray-300 dark:text-gray-600" />
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            No Yarn agent usage recorded for this period
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Yarn Requests"
            value={yarnUsage.total_requests.toLocaleString()}
            icon={Hash}
          />
          <MetricCard
            label="Tokens Used"
            value={fmtTokens(yarnUsage.tokens_in + yarnUsage.tokens_out)}
            icon={Zap}
            subtitle={`${fmtTokens(yarnUsage.tokens_in)} in · ${fmtTokens(yarnUsage.tokens_out)} out`}
          />
          <MetricCard
            label="Yarn Cost"
            value={fmtCost(yarnUsage.cost_usd)}
            icon={Coins}
            subtitle={
              yarnUsage.tokens_cached > 0
                ? `${fmtTokens(yarnUsage.tokens_cached)} cached`
                : undefined
            }
          />
          <MetricCard
            label="Avg Latency"
            value={fmtDurationMs(yarnUsage.avg_latency_ms)}
            icon={Clock}
            subtitle={
              yarnUsage.errors > 0
                ? `${yarnUsage.errors} errors · ${yarnUsage.escalations} escalations`
                : yarnUsage.escalations > 0
                  ? `${yarnUsage.escalations} escalations`
                  : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
