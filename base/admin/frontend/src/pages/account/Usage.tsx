import { useState } from "react";
import { Link } from "react-router";
import { useUsageMeDashboard } from "../../api/hooks";
import type { AccountUsageKeySummary, AccountUsageSummary } from "../../types";
import MetricCard from "../../components/common/MetricCard";
import { Coins, Clock, Hash, Zap } from "lucide-react";
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

function n(summary: AccountUsageSummary | undefined, key: keyof AccountUsageSummary): number {
  const value = summary?.[key];
  return typeof value === "number" ? value : 0;
}

type UsageSummarySectionProps = {
  title: string;
  subtitle: string;
  requests: number;
  tokens: number;
  priceUsd: number;
  avgLatencyMs: number;
  details?: string | undefined;
};

function UsageSummarySection({
  title,
  subtitle,
  requests,
  tokens,
  priceUsd,
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
        <MetricCard label="Usage Price" value={fmtCost(priceUsd)} icon={Coins} />
        <MetricCard label="Avg Latency" value={fmtDurationMs(avgLatencyMs)} icon={Clock} />
      </div>
      {details ? <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{details}</p> : null}
    </div>
  );
}

function summarySubtitle(summary: AccountUsageSummary | undefined, period: number): string {
  return n(summary, "requests") > 0 ? `past ${period}h` : "no data";
}

function chatDetails(chat: AccountUsageSummary | undefined): string {
  if (n(chat, "requests") === 0) {
    return "No Chat pipeline usage recorded for this period.";
  }
  if (n(chat, "error_count") > 0) {
    return `${n(chat, "error_count")} errors`;
  }
  return "Metered from Chat pipeline usage logs.";
}

function coderDetails(coder: AccountUsageSummary | undefined): string {
  if (n(coder, "requests") === 0) {
    return "No Coder usage recorded for this period.";
  }
  const parts = [
    n(coder, "tokens_cached") > 0 ? `${fmtTokens(n(coder, "tokens_cached"))} cached` : null,
    n(coder, "tokens_cache_write") > 0 ? `${fmtTokens(n(coder, "tokens_cache_write"))} cache write` : null,
    n(coder, "error_count") > 0 ? `${n(coder, "error_count")} errors` : null,
  ].filter(Boolean);
  return parts.join(" / ") || "Metered from Coder proxy usage logs.";
}

function keyName(row: AccountUsageKeySummary): string {
  if (row.key_name) return row.key_name;
  if (row.key_prefix) return `API key ${row.key_prefix}`;
  return row.auth_method === "pat" ? "API key" : "Account session / historical";
}

export default function Usage() {
  const [period, setPeriod] = useState(24);
  const { data: dashboard, isLoading } = useUsageMeDashboard(period);

  const chat = dashboard?.summary.chat;
  const coder = dashboard?.summary.coder;
  const total = dashboard?.summary.total;
  const bucketRows = dashboard?.series ?? [];
  const keyRows = dashboard?.by_key ?? [];
  const totalHasData = n(total, "requests") > 0;

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Usage</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Chat and Coder usage for your account over the selected period. Prices use the
            configured model rate card and cache pricing. See the{" "}
            <Link to="/account/usage/audit" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              request audit
            </Link>{" "}
            for per-request token and price accounting.
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

      {isLoading && !dashboard ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading usage data...</p>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-3">
            <UsageSummarySection
              title="Chat Usage"
              subtitle={summarySubtitle(chat, period)}
              requests={n(chat, "requests")}
              tokens={n(chat, "total_tokens")}
              priceUsd={n(chat, "price_usd")}
              avgLatencyMs={n(chat, "avg_latency_ms")}
              details={chatDetails(chat)}
            />
            <UsageSummarySection
              title="Coder Usage"
              subtitle={summarySubtitle(coder, period)}
              requests={n(coder, "requests")}
              tokens={n(coder, "total_tokens")}
              priceUsd={n(coder, "price_usd")}
              avgLatencyMs={n(coder, "avg_latency_ms")}
              details={coderDetails(coder)}
            />
            <UsageSummarySection
              title="Total Usage"
              subtitle={summarySubtitle(total, period)}
              requests={n(total, "requests")}
              tokens={n(total, "total_tokens")}
              priceUsd={n(total, "price_usd")}
              avgLatencyMs={n(total, "avg_latency_ms")}
              details={
                totalHasData
                  ? `Combined Chat + Coder totals. ${dashboard?.price_basis ?? ""}`.trim()
                  : "No Chat or Coder usage recorded for this period."
              }
            />
          </div>

          {totalHasData && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/70 p-4 text-sm text-indigo-950 dark:border-indigo-900 dark:bg-indigo-950/20 dark:text-indigo-100">
              Cache billing: {fmtTokens(n(total, "tokens_cached"))} cache-read tokens,{" "}
              {fmtTokens(n(total, "tokens_cache_write"))} cache-write tokens, and{" "}
              {fmtCost(n(total, "cache_discount_usd"))} discount against uncached input pricing.
            </div>
          )}

          {keyRows.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Usage By Key</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-950">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Key</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Chat</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Coder</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Tokens</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Cache Reads</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Price</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
                    {keyRows.map((row) => (
                      <tr key={row.key_id} className="hover:bg-gray-50 dark:hover:bg-gray-900">
                        <td className="px-4 py-2">
                          <div className="font-medium text-gray-900 dark:text-gray-100">{keyName(row)}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {row.auth_method || "account"}
                            {row.key_prefix ? ` / ${row.key_prefix}` : ""}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-900 dark:text-gray-100">
                          {row.chat_requests.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-900 dark:text-gray-100">
                          {row.coder_requests.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium text-gray-900 dark:text-gray-100">
                          {fmtTokens(row.total_tokens)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtTokens(row.tokens_cached)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtCost(row.price_usd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {bucketRows.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Time</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Chat</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Coder</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Tokens</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Cache Reads</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Price</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Avg Latency</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
                    {bucketRows.slice(0, 50).map((row) => (
                      <tr key={row.bucket} className="hover:bg-gray-50 dark:hover:bg-gray-900">
                        <td className="whitespace-nowrap px-4 py-2 text-gray-700 dark:text-gray-300">
                          {fmtBucket(row.bucket)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-900 dark:text-gray-100">
                          {row.chat_requests.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-900 dark:text-gray-100">
                          {row.coder_requests.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium text-gray-900 dark:text-gray-100">
                          {fmtTokens(row.total_tokens)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtTokens(row.tokens_cached)}
                        </td>
                        <td
                          className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400"
                          title="Configured model rate card price"
                        >
                          {fmtCost(row.price_usd)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">
                          {fmtDurationMs(row.avg_latency_ms)}
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
              No Chat or Coder time-series buckets for this period.
            </div>
          )}
        </>
      )}
    </div>
  );
}
