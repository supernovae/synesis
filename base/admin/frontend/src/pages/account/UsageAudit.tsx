import { useMemo, useState } from "react";
import { ShieldCheck, Clock, Coins, Database, Zap } from "lucide-react";
import { useUsageMeRequests } from "../../api/hooks";
import { fmtCost, fmtDurationMs, fmtTokens } from "../../lib/formatUsage";
import type { UsageAuditRequest } from "../../types";

const PERIOD_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

function fmtDate(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function sourceLabel(source: string): string {
  return source === "coder" ? "Coder" : "Chat";
}

function BillingBreakdown({ row }: { row: UsageAuditRequest }) {
  const b = row.billing_breakdown;
  return (
    <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-md bg-gray-50 p-2 dark:bg-gray-800">
        <div className="text-gray-500 dark:text-gray-400">Uncached input</div>
        <div className="font-medium text-gray-900 dark:text-gray-100">
          {fmtTokens(b.tokens_uncached_input)} / {fmtCost(b.input_price_usd)}
        </div>
      </div>
      <div className="rounded-md bg-emerald-50 p-2 dark:bg-emerald-950/30">
        <div className="text-emerald-700 dark:text-emerald-300">Cache reads</div>
        <div className="font-medium text-emerald-950 dark:text-emerald-100">
          {fmtTokens(b.tokens_cache_read)} / {fmtCost(b.cache_read_price_usd)}
        </div>
      </div>
      <div className="rounded-md bg-amber-50 p-2 dark:bg-amber-950/30">
        <div className="text-amber-700 dark:text-amber-300">Cache writes</div>
        <div className="font-medium text-amber-950 dark:text-amber-100">
          {fmtTokens(b.tokens_cache_write)} / {fmtCost(b.cache_write_price_usd)}
        </div>
      </div>
      <div className="rounded-md bg-gray-50 p-2 dark:bg-gray-800">
        <div className="text-gray-500 dark:text-gray-400">Output</div>
        <div className="font-medium text-gray-900 dark:text-gray-100">
          {fmtTokens(b.tokens_output)} / {fmtCost(b.output_price_usd)}
        </div>
      </div>
    </div>
  );
}

export default function UsageAudit() {
  const [period, setPeriod] = useState(720);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, isLoading } = useUsageMeRequests(period, 50, 0);
  const rows = useMemo(() => data?.requests ?? [], [data?.requests]);
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => {
          acc.price += row.price_usd;
          acc.discount += row.billing_breakdown.cache_discount_usd;
          acc.cacheReads += row.billing_breakdown.tokens_cache_read;
          acc.cacheWrites += row.billing_breakdown.tokens_cache_write;
          return acc;
        },
        { price: 0, discount: 0, cacheReads: 0, cacheWrites: 0 },
      ),
    [rows],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Usage audit</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500 dark:text-gray-400">
            Request-level metering view for your account. This page shows billing and cache accounting only;
            prompts, tool payloads, responses, spans, and diagnostics are not exposed here.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              onClick={() => setPeriod(opt.hours)}
              className={`rounded-md px-3 py-1 text-xs font-medium ${
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

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center gap-2 text-sm text-gray-500"><Database className="h-4 w-4" /> Requests</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{data?.total ?? 0}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center gap-2 text-sm text-gray-500"><Coins className="h-4 w-4" /> Usage price</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{fmtCost(totals.price)}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center gap-2 text-sm text-gray-500"><Zap className="h-4 w-4" /> Cache reads</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{fmtTokens(totals.cacheReads)}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center gap-2 text-sm text-gray-500"><ShieldCheck className="h-4 w-4" /> Cache discount</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{fmtCost(totals.discount)}</div>
        </div>
      </div>

      <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-100">
        Default privacy mode is metering-only. Training consent is off unless explicitly enabled, and raw text is not visible in this audit view.
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-900 dark:text-gray-400">
            <tr>
              <th className="px-4 py-3 text-left">Request</th>
              <th className="px-4 py-3 text-left">Model</th>
              <th className="px-4 py-3 text-right">Tokens</th>
              <th className="px-4 py-3 text-right">Cache</th>
              <th className="px-4 py-3 text-right">Price</th>
              <th className="px-4 py-3 text-right">Latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
            {isLoading ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading audit rows...</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No usage audit rows for this period.</td></tr>
            ) : rows.map((row) => {
              const open = expanded === row.request_id;
              return (
                <tr key={`${row.source}:${row.request_id}`} className="align-top hover:bg-gray-50 dark:hover:bg-gray-900">
                  <td className="px-4 py-3">
                    <button onClick={() => setExpanded(open ? null : row.request_id)} className="block text-left">
                      <span className="block font-mono text-xs text-indigo-700 dark:text-indigo-300">{row.request_id}</span>
                      <span className="mt-1 block text-xs text-gray-500">{sourceLabel(row.source)} / {fmtDate(row.created_at)}</span>
                    </button>
                    {open && (
                      <div className="mt-3 max-w-3xl space-y-2">
                        <BillingBreakdown row={row} />
                        <div className="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                          <span>No-cache baseline: {fmtCost(row.billing_breakdown.no_cache_price_usd)}</span>
                          <span>Pricing: {row.pricing_source}</span>
                          {row.key_name || row.key_prefix ? (
                            <span>Key: {row.key_name || row.key_prefix}</span>
                          ) : null}
                          <span>Privacy: {row.privacy_mode}</span>
                          <span>Redaction: {row.redaction_status}</span>
                          <span>Training: {row.training_allowed ? "allowed" : "off"}</span>
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-xs truncate font-medium text-gray-900 dark:text-gray-100">{row.model}</div>
                    <div className="text-xs text-gray-500">{row.provider}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtTokens(row.total_tokens)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {Math.round(row.billing_breakdown.cache_hit_rate * 1000) / 10}% / {fmtTokens(row.tokens_cached)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">{fmtCost(row.price_usd)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{fmtDurationMs(row.latency_ms)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
