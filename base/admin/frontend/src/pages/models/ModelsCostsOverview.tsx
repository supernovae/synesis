import { useState } from "react";
import { Link } from "react-router-dom";
import { useUsageSummaryUnified } from "../../api/hooks";
import { UsageGlossaryBanner } from "../../components/models/UsageGlossary";
import { fmtCost, fmtTokens } from "../../lib/formatUsage";
import { Layers, Server, Gauge, LineChart, Sparkles } from "lucide-react";

const HOURS_CHIPS = [24, 72, 168] as const;

export default function ModelsCostsOverview() {
  const [sinceHours, setSinceHours] = useState<number>(24);
  const { data, isLoading } = useUsageSummaryUnified(sinceHours);

  const roll = data?.pipeline?.rollups;
  const tr = data?.pipeline?.traces;
  const yarn = data?.yarn;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Models & Costs</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Unified view of pipeline usage, rollups, and Yarn / IDE spend (same definitions as Usage & spend).
        </p>
      </div>

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

      <UsageGlossaryBanner />

      {isLoading ? (
        <div className="h-40 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
                <Gauge className="h-5 w-5" />
                <h2 className="font-semibold text-gray-900 dark:text-white">Pipeline (rollups)</h2>
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Requests</dt>
                  <dd>{roll?.total_requests ?? "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Tokens</dt>
                  <dd>{roll?.total_tokens != null ? fmtTokens(Number(roll.total_tokens)) : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Est. cost</dt>
                  <dd>
                    {roll?.estimated_cost_usd != null
                      ? fmtCost(Number(roll.estimated_cost_usd))
                      : "—"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Actual cost</dt>
                  <dd>
                    {roll?.actual_cost_usd != null ? fmtCost(Number(roll.actual_cost_usd)) : "—"}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <LineChart className="h-5 w-5" />
                <h2 className="font-semibold text-gray-900 dark:text-white">Pipeline (trace rows)</h2>
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Traces</dt>
                  <dd>{tr?.trace_count ?? "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Tokens</dt>
                  <dd>{tr?.total_tokens != null ? fmtTokens(tr.total_tokens) : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Est. cost</dt>
                  <dd>{tr ? fmtCost(tr.estimated_cost_usd) : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Actual cost</dt>
                  <dd>{tr ? fmtCost(tr.actual_cost_usd) : "—"}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center gap-2 text-violet-600 dark:text-violet-400">
                <Sparkles className="h-5 w-5" />
                <h2 className="font-semibold text-gray-900 dark:text-white">Yarn / IDE</h2>
              </div>
              {yarn ? (
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Requests</dt>
                    <dd>{yarn.total_requests ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Tokens (in+out+cached)</dt>
                    <dd>
                      {fmtTokens(
                        Number(yarn.total_tokens_in || 0) +
                          Number(yarn.total_tokens_out || 0) +
                          Number(yarn.total_tokens_cached || 0),
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Cost</dt>
                    <dd>
                      {yarn.total_cost_usd != null ? fmtCost(Number(yarn.total_cost_usd)) : "—"}
                    </dd>
                  </div>
                  <div className="pt-2">
                    <Link
                      to="/yarn"
                      className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      Open Yarn Fabric →
                    </Link>
                  </div>
                </dl>
              ) : (
                <p className="mt-3 text-sm text-gray-500">
                  Yarn totals require org admin or higher, or no data yet.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-400">
            <strong className="text-gray-800 dark:text-gray-200">Rollup freshness:</strong>{" "}
            {data?.rollup_latest_bucket_utc
              ? `last bucket ${data.rollup_latest_bucket_utc}`
              : "no buckets yet"}
            {data?.rollup_lag_seconds_approx != null &&
              ` (~${Math.round(data.rollup_lag_seconds_approx / 60)} min behind UTC now)`}
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Quick links</h2>
            <div className="flex flex-wrap gap-3">
              <Link
                to="/models/costs"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:hover:bg-gray-800"
              >
                <Layers className="h-4 w-4" /> Usage & spend (charts)
              </Link>
              <Link
                to="/models/reconcile"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:hover:bg-gray-800"
              >
                <Gauge className="h-4 w-4" /> Reconciliation
              </Link>
              <Link
                to="/models"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:hover:bg-gray-800"
              >
                <Server className="h-4 w-4" /> Model registry
              </Link>
              <Link
                to="/settings/infra-costs"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:hover:bg-gray-800"
              >
                Infrastructure costs
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
