import { useState } from "react";
import { Link } from "react-router";
import { usePipelineServices, useRoleAssignments, useUsageSummaryUnified } from "../../api/hooks";
import { UsageGlossaryBanner } from "../../components/models/UsageGlossary";
import { fmtCost, fmtTokens } from "../../lib/formatUsage";
import { Layers, Server, Gauge, Sparkles, Cloud, DollarSign } from "lucide-react";

const HOURS_CHIPS = [24, 72, 168] as const;

export default function ModelsCostsOverview() {
  const [sinceHours, setSinceHours] = useState<number>(24);
  const { data, isLoading } = useUsageSummaryUnified(sinceHours);
  const { data: rolesData } = useRoleAssignments();
  const { data: servicesData } = usePipelineServices();

  const tr = data?.pipeline?.traces;
  const yarn = data?.yarn;
  const spend = data?.total_platform_spend as Record<string, number | string> | undefined;
  const activeRoles = (rolesData?.roles ?? []).filter((r) => r.assigned);
  const mainRoles = activeRoles.filter((r) => !["coder", "summarizer"].includes(r.role));
  const microRoles = activeRoles.filter((r) => ["coder", "summarizer"].includes(r.role));
  const pipelineServices = servicesData?.services ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Models & Pricing</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Unified view of Chat pipeline usage and Coder / IDE pricing.
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
          {spend && (
            <div className="rounded-lg border-2 border-indigo-200 bg-gradient-to-r from-indigo-50 to-violet-50 p-4 dark:border-indigo-800 dark:from-indigo-950/30 dark:to-violet-950/30">
              <div className="flex items-center gap-2 text-indigo-700 dark:text-indigo-300">
                <DollarSign className="h-5 w-5" />
                <h2 className="font-semibold">Total Usage Price</h2>
                <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                  {sinceHours}h window
                </span>
              </div>
              <div className="mt-3 grid gap-4 sm:grid-cols-3">
                <dl className="space-y-1 text-sm">
                  <dt className="font-medium text-gray-700 dark:text-gray-300">Chat (pipeline)</dt>
                  <dd className="text-lg font-semibold text-gray-900 dark:text-white">
                    {fmtCost(Number(spend.planner_price_usd || 0))}
                    <span className="ml-1 text-xs font-normal text-gray-500">price</span>
                  </dd>
                  <dd className="text-xs text-gray-500 dark:text-gray-400">planner_usage_log (+ trace fallback)</dd>
                  {Number(spend.planner_provider_actual_usd || 0) > 0 && (
                    <dd className="text-xs text-gray-500">
                      {fmtCost(Number(spend.planner_provider_actual_usd))} provider actual
                    </dd>
                  )}
                </dl>
                <dl className="space-y-1 text-sm">
                  <dt className="font-medium text-gray-700 dark:text-gray-300">Coder</dt>
                  <dd className="text-lg font-semibold text-gray-900 dark:text-white">
                    {fmtCost(Number(spend.yarn_price_usd || 0))}
                    <span className="ml-1 text-xs font-normal text-gray-500">price</span>
                  </dd>
                  {Number(spend.yarn_provider_actual_usd || 0) > 0 && (
                    <dd className="text-xs text-gray-500">
                      {fmtCost(Number(spend.yarn_provider_actual_usd))} provider actual
                    </dd>
                  )}
                </dl>
                <dl className="space-y-1 text-sm">
                  <dt className="font-medium text-gray-700 dark:text-gray-300">Total</dt>
                  <dd className="text-lg font-semibold text-indigo-600 dark:text-indigo-400">
                    {fmtCost(Number(spend.total_price_usd || 0))}
                  </dd>
                  <dd className="text-xs text-gray-500">
                    configured usage price
                  </dd>
                </dl>
              </div>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <Gauge className="h-5 w-5" />
                <h2 className="font-semibold text-gray-900 dark:text-white">Chat (pipeline)</h2>
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Requests</dt>
                  <dd>{tr?.request_count ?? tr?.trace_count ?? "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Tokens</dt>
                  <dd>{tr?.total_tokens != null ? fmtTokens(tr.total_tokens) : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500" title="Configured model rate card price">Usage Price</dt>
                  <dd>{tr ? fmtCost(tr.price_usd) : "—"}</dd>
                </div>
                {tr?.provider_actual_cost_usd != null && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500" title="Platform-admin-only provider actual">Provider Actual</dt>
                    <dd>{fmtCost(tr.provider_actual_cost_usd)}</dd>
                  </div>
                )}
                {tr?.source && (
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Source: {tr.source}</p>
                )}
                {tr?.note && (
                  <p className="text-xs text-amber-800 dark:text-amber-200/90">{tr.note}</p>
                )}
              </dl>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center gap-2 text-violet-600 dark:text-violet-400">
                <Sparkles className="h-5 w-5" />
                <h2 className="font-semibold text-gray-900 dark:text-white">Coder / IDE</h2>
              </div>
              {yarn ? (
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Requests</dt>
                    <dd>{yarn.total_requests ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Tokens (in+out)</dt>
                    <dd>
                      {fmtTokens(
                        Number(yarn.total_tokens_in || 0) +
                          Number(yarn.total_tokens_out || 0)
                      )}
                    </dd>
                  </div>
                  {/* cached is now accurately reported via vLLM usage + extractUsage; subset of input. See usage-extract.ts and yarn session detail for full breakdown. */}
                  <div className="flex justify-between">
                    <dt className="text-gray-500" title="Configured model rate card price">Usage Price</dt>
                    <dd>
                      {yarn.total_price_usd != null ? fmtCost(Number(yarn.total_price_usd)) : "—"}
                    </dd>
                  </div>
                  {yarn.total_provider_actual_cost_usd != null && (
                    <div className="flex justify-between">
                      <dt className="text-gray-500" title="Platform-admin-only provider actual">Provider Actual</dt>
                      <dd>{fmtCost(Number(yarn.total_provider_actual_cost_usd))}</dd>
                    </div>
                  )}
                  <div className="pt-2">
                    <Link
                      to="/yarn"
                      className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      Open Coder overview →
                    </Link>
                  </div>
                </dl>
              ) : (
                <p className="mt-3 text-sm text-gray-500">
                  Coder totals require org admin or higher, or no data yet.
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">
                Main model roles
              </h2>
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                Active role-to-model assignments (API vs local runtime).
              </p>
              <div className="space-y-2">
                {mainRoles.length === 0 ? (
                  <p className="text-sm text-gray-500">No active assignments.</p>
                ) : (
                  mainRoles.map((r) => {
                    const isLocal = ["vllm", "kserve"].includes((r.provider || "").toLowerCase());
                    const RuntimeIcon = isLocal ? Server : Cloud;
                    return (
                      <div key={r.role} className="flex items-center justify-between rounded border border-gray-200 px-3 py-2 dark:border-gray-700">
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white">{r.role}</p>
                          <p className="max-w-[420px] truncate text-xs text-gray-500 dark:text-gray-400" title={r.model}>
                            {r.model || r.served_name}
                          </p>
                        </div>
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${isLocal ? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"}`}>
                          <RuntimeIcon className="h-3 w-3" />
                          {isLocal ? "local" : "api"}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">
                Microservices & supporting roles
              </h2>
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                Supporting model roles and pipeline microservice health.
              </p>
              <div className="space-y-2">
                {microRoles.map((r) => (
                  <div key={r.role} className="flex items-center justify-between rounded border border-gray-200 px-3 py-2 dark:border-gray-700">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{r.role}</p>
                      <p className="max-w-[420px] truncate text-xs text-gray-500 dark:text-gray-400" title={r.model}>
                        {r.model || r.served_name}
                      </p>
                    </div>
                    <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                      role
                    </span>
                  </div>
                ))}
                {pipelineServices.slice(0, 6).map((svc) => (
                  <div key={svc.name} className="flex items-center justify-between rounded border border-gray-200 px-3 py-2 dark:border-gray-700">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{svc.name}</p>
                      <p className="max-w-[420px] truncate text-xs text-gray-500 dark:text-gray-400" title={svc.url || ""}>
                        {svc.url || "not configured"}
                      </p>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${
                      !svc.configured
                        ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                        : svc.reachable
                          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                          : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                    }`}>
                      {!svc.configured ? "not set" : svc.reachable ? "ok" : "down"}
                    </span>
                  </div>
                ))}
                {microRoles.length === 0 && pipelineServices.length === 0 && (
                  <p className="text-sm text-gray-500">No microservice data.</p>
                )}
              </div>
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Quick links</h2>
            <div className="flex flex-wrap gap-3">
              <Link
                to="/models/costs"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:hover:bg-gray-800"
              >
                <Layers className="h-4 w-4" /> Usage pricing charts
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
