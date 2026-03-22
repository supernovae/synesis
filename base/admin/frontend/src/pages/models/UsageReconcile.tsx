import { useState } from "react";
import { useUsageReconcile } from "../../api/hooks";
import { UsageGlossaryBanner } from "../../components/models/UsageGlossary";
import { fmtCost, fmtTokens } from "../../lib/formatUsage";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";

const HOURS_CHIPS = [24, 72, 168] as const;

export default function UsageReconcile() {
  const [sinceHours, setSinceHours] = useState(24);
  const { data, isLoading, isError, error } = useUsageReconcile(sinceHours, true);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Usage reconciliation</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Platform admin: compare rollups, trace totals, sampled llm_calls walk, and Yarn. Investigate
          drift before trusting dashboards.
        </p>
      </div>

      <UsageGlossaryBanner />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-600 dark:text-gray-400">Period:</span>
        {HOURS_CHIPS.map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => setSinceHours(h)}
            className={`rounded-md px-3 py-1 text-sm font-medium ${
              sinceHours === h
                ? "bg-indigo-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200"
            }`}
          >
            {h}h
          </button>
        ))}
      </div>

      {isError && <ApiErrorBanner error={error} />}

      {isLoading ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : data ? (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
              <h2 className="font-semibold text-gray-900 dark:text-white">Deltas</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt>Rollup tokens − trace row tokens</dt>
                  <dd className="font-mono">{data.deltas?.total_tokens_rollup_minus_trace_row ?? "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Est. USD (rollup − trace)</dt>
                  <dd className="font-mono">
                    {data.deltas?.estimated_usd_rollup_minus_trace != null
                      ? fmtCost(data.deltas.estimated_usd_rollup_minus_trace)
                      : "—"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>% token drift (rollup vs trace)</dt>
                  <dd className="font-mono">
                    {data.deltas?.pct_tokens_rollup_vs_trace != null
                      ? `${data.deltas.pct_tokens_rollup_vs_trace}%`
                      : "—"}
                  </dd>
                </div>
              </dl>
            </div>
            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
              <h2 className="font-semibold text-gray-900 dark:text-white">Yarn (global)</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt>Requests</dt>
                  <dd>{data.yarn?.request_count ?? "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Total tokens</dt>
                  <dd>{data.yarn?.total_tokens != null ? fmtTokens(data.yarn.total_tokens) : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Cost USD</dt>
                  <dd>{data.yarn?.cost_usd != null ? fmtCost(data.yarn.cost_usd) : "—"}</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
            <h2 className="font-semibold text-amber-950 dark:text-amber-200">LLM calls walk (sample)</h2>
            <p className="mt-1 text-amber-900/80 dark:text-amber-200/80">
              {data.llm_calls_walk?.note}{" "}
              {data.llm_calls_walk?.partial ? (
                <strong>Partial sample — more traces exist in window.</strong>
              ) : null}
            </p>
            <dl className="mt-2 grid gap-2 sm:grid-cols-3">
              <div>
                <dt className="text-gray-600 dark:text-gray-400">Tokens summed</dt>
                <dd className="font-mono">
                  {fmtTokens(data.llm_calls_walk?.prompt_completion_tokens_summed ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-gray-600 dark:text-gray-400">Est. USD</dt>
                <dd className="font-mono">{fmtCost(data.llm_calls_walk?.estimated_cost_usd ?? 0)}</dd>
              </div>
              <div>
                <dt className="text-gray-600 dark:text-gray-400">Actual USD</dt>
                <dd className="font-mono">{fmtCost(data.llm_calls_walk?.actual_cost_usd ?? 0)}</dd>
              </div>
            </dl>
          </div>

          <p className="text-xs text-gray-500">
            Last rollup bucket: {data.rollup_latest_bucket_utc ?? "—"}
          </p>
        </div>
      ) : !isError ? (
        <p className="text-sm text-gray-500">No data.</p>
      ) : null}
    </div>
  );
}
