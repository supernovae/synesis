import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  useUpdateModelCost,
  useActiveCosts,
  useCostsByRole,
  useCostsDaily,
} from "../../api/hooks";
import type { CostByRoleEntry, DailyCostEntry } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import ChartCard from "../../components/common/ChartCard";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import { DollarSign, Cloud, Server, PenLine } from "lucide-react";
import type { ModelCost, ActiveCostEntry } from "../../types";
import { UsageGlossaryBanner } from "../../components/models/UsageGlossary";
import { Link } from "react-router";

const SOURCE_BADGE_STYLES: Record<string, string> = {
  manual: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  legacy: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  bundled: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  infra_calc: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  unknown: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  legacy: "Legacy",
  bundled: "API Pricing",
  infra_calc: "Infra Calc",
  unknown: "Unknown",
};

function PricingSourceBadge({ source }: { source: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${SOURCE_BADGE_STYLES[source] || SOURCE_BADGE_STYLES.unknown}`}>
      {SOURCE_LABELS[source] || source}
    </span>
  );
}

function ProviderBadge({ source }: { source: string }) {
  const isLocal = source === "local" || source === "vllm" || source === "kserve";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        isLocal
          ? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
          : "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
      }`}
    >
      {isLocal ? <Server className="h-3 w-3" /> : <Cloud className="h-3 w-3" />}
      {source}
    </span>
  );
}

function EditCostModal({
  cost,
  onClose,
}: {
  cost: ModelCost;
  onClose: () => void;
}) {
  const mutation = useUpdateModelCost();
  const [formula, setFormula] = useState(cost.cost_formula || "");
  const [monthly, setMonthly] = useState(cost.monthly_fixed_cost || 0);
  const [inputRate, setInputRate] = useState(cost.input_per_million || 0);
  const [cachedInputRate, setCachedInputRate] = useState<number | "">(
    cost.input_cached_per_million != null && cost.input_cached_per_million !== undefined
      ? cost.input_cached_per_million
      : "",
  );
  const [cacheWriteRate, setCacheWriteRate] = useState<number | "">(
    cost.input_cache_write_per_million != null && cost.input_cache_write_per_million !== undefined
      ? cost.input_cache_write_per_million
      : "",
  );
  const [outputRate, setOutputRate] = useState(cost.output_per_million || 0);

  const handleSave = () => {
    mutation.mutate(
      {
        role: cost.role,
        profile: cost.profile,
        model: cost.model,
        source: cost.source,
        input_per_million: inputRate,
        input_cached_per_million: cachedInputRate === "" ? null : cachedInputRate,
        input_cache_write_per_million: cacheWriteRate === "" ? null : cacheWriteRate,
        output_per_million: outputRate,
        monthly_fixed_cost: monthly,
        cost_formula: formula,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Edit Cost: {cost.role}
        </h3>
        <p className="mt-1 text-sm text-gray-500">{cost.model}</p>
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Input $/M tokens</span>
            <input type="number" step="0.01" value={inputRate} onChange={(e) => setInputRate(parseFloat(e.target.value) || 0)} className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Cached input $/M (optional)</span>
            <input
              type="number"
              step="0.01"
              value={cachedInputRate}
              onChange={(e) => {
                const v = e.target.value;
                setCachedInputRate(v === "" ? "" : parseFloat(v) || 0);
              }}
              placeholder="Blank → server uses ~10% of input rate"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Cache write $/M (optional)</span>
            <input
              type="number"
              step="0.01"
              value={cacheWriteRate}
              onChange={(e) => {
                const v = e.target.value;
                setCacheWriteRate(v === "" ? "" : parseFloat(v) || 0);
              }}
              placeholder="Blank → server uses input rate"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Output $/M tokens</span>
            <input type="number" step="0.01" value={outputRate} onChange={(e) => setOutputRate(parseFloat(e.target.value) || 0)} className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Monthly fixed cost ($)</span>
            <input type="number" step="1" value={monthly} onChange={(e) => setMonthly(parseFloat(e.target.value) || 0)} className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Cost formula / notes</span>
            <input type="text" value={formula} onChange={(e) => setFormula(e.target.value)} placeholder="e.g. $2.24/hr x 3 nodes x 730h" className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">Cancel</button>
          <button onClick={handleSave} disabled={mutation.isPending} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {mutation.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function shortModel(name: string): string {
  const parts = name.split("/");
  return (parts.at(-1) ?? name).substring(0, 30);
}

export default function CostTracker() {
  const [days, setDays] = useState(7);
  const { data: activeData, isLoading } = useActiveCosts();
  const { data: roleData } = useCostsByRole(days);
  const { data: dailyData } = useCostsDaily(days);
  const [editing, setEditing] = useState<ModelCost | null>(null);

  const activeRoles: ActiveCostEntry[] = activeData?.roles ?? [];

  const byRole: CostByRoleEntry[] = roleData?.roles ?? [];
  const daily: DailyCostEntry[] = dailyData?.daily ?? [];

  const totalPrice = byRole.reduce((s, r) => s + r.price_usd, 0);
  const totalProviderActual = byRole.reduce((s, r) => s + (r.provider_actual_cost_usd ?? 0), 0);
  const totalRequests = byRole.reduce((s, r) => s + r.requests, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Usage Pricing</h1>
          <p className="mt-1 text-sm text-gray-500">
            Rolled up from <span className="font-medium">trace JSON llm_calls</span> (per-role), not
            planner_usage_log; Coder / IDE pricing is on{" "}
            <Link to="/models/overview" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              Overview
            </Link>
            .
          </p>
        </div>
        <select
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7d</option>
          <option value={14}>Last 14d</option>
          <option value={30}>Last 30d</option>
        </select>
      </div>

      <UsageGlossaryBanner />

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : activeRoles.length === 0 && byRole.length === 0 ? (
        <EmptyState title="No pricing data" description="Usage pricing populates after requests flow through the pipeline" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <MetricCard
              label="Usage Price"
              value={`$${totalPrice.toFixed(4)}`}
              subtitle={`${days}d · from trace llm_calls`}
              icon={DollarSign}
            />
            <MetricCard
              label="Provider Actual"
              value={totalProviderActual > 0 ? `$${totalProviderActual.toFixed(4)}` : "Hidden"}
              subtitle={totalProviderActual > 0 ? "platform admin only" : "not available on this view"}
              icon={DollarSign}
            />
            <MetricCard
              label="Cache-Aware"
              value="Rate card"
              subtitle="input/cache/output pricing"
              icon={DollarSign}
            />
            <MetricCard
              label="Total Requests"
              value={totalRequests.toLocaleString()}
              subtitle={`${days}d period`}
            />
          </div>

          {/* Price by role (primary chart) */}
          {byRole.length > 0 && (
            <ChartCard title={`Price by Role (${days}d)`} subtitle="Configured usage price per pipeline role">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={byRole}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="role" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v.toFixed(4)}`} />
                  <Tooltip formatter={(v) => (v == null ? "" : `$${Number(v).toFixed(6)}`)} />
                  <Legend />
                  <Bar dataKey="price_usd" name="Usage Price" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="provider_actual_cost_usd" name="Provider Actual" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {/* Daily price trend */}
          {daily.length > 0 && (
            <ChartCard title={`Daily Price Trend (${days}d)`} subtitle="Configured usage price per day">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={daily}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v.toFixed(4)}`} />
                  <Tooltip formatter={(v) => (v == null ? "" : `$${Number(v).toFixed(6)}`)} />
                  <Legend />
                  <Bar dataKey="price_usd" name="Usage Price" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="provider_actual_cost_usd" name="Provider Actual" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {/* Rate config table */}
          {activeRoles.length > 0 && (
            <>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Rate Configuration</h2>
              <DataTable
                columns={[
                  { key: "role", label: "Role", sortable: true },
                  { key: "model", label: "Model", render: (r) => <span className="text-xs">{shortModel(r.model)}</span> },
                  { key: "source", label: "Provider", render: (r) => <ProviderBadge source={r.provider ?? r.source} /> },
                  { key: "input_per_million", label: "Input $/M", sortable: true, render: (r) => `$${r.input_per_million.toFixed(2)}` },
                  {
                    key: "input_cached_per_million",
                    label: "Cache read $/M",
                    sortable: true,
                    render: (r: ModelCost) =>
                      r.input_cached_per_million != null ? `$${Number(r.input_cached_per_million).toFixed(2)}` : "—",
                  },
                  {
                    key: "input_cache_write_per_million",
                    label: "Cache write $/M",
                    sortable: true,
                    render: (r: ModelCost) =>
                      r.input_cache_write_per_million != null ? `$${Number(r.input_cache_write_per_million).toFixed(2)}` : "input",
                  },
                  { key: "output_per_million", label: "Output $/M", sortable: true, render: (r) => `$${r.output_per_million.toFixed(2)}` },
                  {
                    key: "pricing_source", label: "Source", render: (r: ModelCost) => <PricingSourceBadge source={r.pricing_source ?? "unknown"} />,
                  },
                  { key: "cost_formula", label: "Formula", render: (r) => <span className="text-xs text-gray-500">{r.cost_formula || "---"}</span> },
                  { key: "actions", label: "", render: (r) => (
                    <button onClick={() => setEditing(r as ModelCost)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800" title="Edit cost">
                      <PenLine className="h-4 w-4" />
                    </button>
                  )},
                ]}
                data={activeRoles}
                keyField="role"
              />
            </>
          )}
        </>
      )}

      {editing && <EditCostModal cost={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
