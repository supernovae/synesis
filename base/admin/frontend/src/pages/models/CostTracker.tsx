import { useState, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
} from "recharts";
import {
  useModelCosts,
  useUpdateModelCost,
  useCostsByModel,
  useCostsByRole,
  useCostsDaily,
  useCostRateHistory,
} from "../../api/hooks";
import type { CostByModelEntry, CostByRoleEntry, DailyCostEntry, CostRateSnapshotEntry } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import ChartCard from "../../components/common/ChartCard";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import { DollarSign, Cloud, Server, PenLine, TrendingUp, TrendingDown } from "lucide-react";
import type { ModelCost } from "../../types";

const COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

function SourceBadge({ source }: { source: string }) {
  const isCloud = source === "openrouter";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        isCloud
          ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
          : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
      }`}
    >
      {isCloud ? <Cloud className="h-3 w-3" /> : <Server className="h-3 w-3" />}
      {isCloud ? "OpenRouter" : "Local"}
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
  const [outputRate, setOutputRate] = useState(cost.output_per_million || 0);

  const handleSave = () => {
    mutation.mutate(
      {
        role: cost.role,
        profile: cost.profile,
        model: cost.model,
        source: cost.source,
        input_per_million: inputRate,
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
          Edit Cost: {cost.role} / {cost.profile}
        </h3>
        <p className="mt-1 text-sm text-gray-500">{cost.model}</p>
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Input $/M tokens</span>
            <input type="number" step="0.01" value={inputRate} onChange={(e) => setInputRate(parseFloat(e.target.value) || 0)} className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
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
  return parts[parts.length - 1].substring(0, 30);
}

export default function CostTracker() {
  const [days, setDays] = useState(7);
  const { data: rateData, isLoading } = useModelCosts();
  const { data: byModelData } = useCostsByModel(days);
  const { data: roleData } = useCostsByRole(days);
  const { data: dailyData } = useCostsDaily(days);
  const { data: rateHistoryData } = useCostRateHistory(90);
  const [editing, setEditing] = useState<ModelCost | null>(null);

  const roles = rateData?.roles ?? [];
  const byModel: CostByModelEntry[] = byModelData?.models ?? [];
  const byRole: CostByRoleEntry[] = roleData?.roles ?? [];
  const daily: DailyCostEntry[] = dailyData?.daily ?? [];
  const rateHistory: CostRateSnapshotEntry[] = rateHistoryData?.snapshots ?? [];

  const chartData = roles.map((r) => ({
    role: r.role,
    input: r.input_per_million,
    output: r.output_per_million,
  }));

  const totalEstimated = byModel.reduce((s, m) => s + m.estimated_cost_usd, 0);
  const totalActual = byModel.reduce((s, m) => s + m.actual_cost_usd, 0);
  const totalRequests = byModel.reduce((s, m) => s + m.requests, 0);
  const costDiff = totalActual > 0 && totalEstimated > 0
    ? ((totalActual - totalEstimated) / totalEstimated) * 100
    : 0;

  const rateHistoryModels = useMemo(() => {
    const set = new Set<string>();
    rateHistory.forEach((s) => set.add(s.model));
    return Array.from(set);
  }, [rateHistory]);

  const pivotedHistory = useMemo(() => {
    const byDate: Record<string, Record<string, number>> = {};
    for (const s of rateHistory) {
      const d = s.captured_at.split("T")[0];
      if (!byDate[d]) byDate[d] = {} as never;
      (byDate[d] as Record<string, number>)["date"] = d as never;
      (byDate[d] as Record<string, number>)[`${shortModel(s.model)}_in`] = s.input_per_million;
      (byDate[d] as Record<string, number>)[`${shortModel(s.model)}_out`] = s.output_per_million;
    }
    return Object.values(byDate).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [rateHistory]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Cost Tracker</h1>
          <p className="mt-1 text-sm text-gray-500">
            Per-role rates, estimated vs actual usage costs, and price history
          </p>
        </div>
        <select
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7d</option>
          <option value={14}>Last 14d</option>
          <option value={30}>Last 30d</option>
        </select>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : roles.length === 0 ? (
        <EmptyState title="No cost data" description="Cost data populates from models.yaml and Postgres overrides" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <MetricCard
              label="Estimated Cost"
              value={`$${totalEstimated.toFixed(4)}`}
              subtitle={`${days}d period`}
              icon={DollarSign}
            />
            <MetricCard
              label="Actual Cost"
              value={totalActual > 0 ? `$${totalActual.toFixed(4)}` : "N/A"}
              subtitle={totalActual > 0 ? "from OpenRouter" : "no data yet"}
              icon={DollarSign}
            />
            <MetricCard
              label="Cost Variance"
              value={totalActual > 0 ? `${costDiff > 0 ? "+" : ""}${costDiff.toFixed(1)}%` : "-"}
              icon={costDiff > 0 ? TrendingUp : TrendingDown}
              trend={costDiff > 2 ? "up" : costDiff < -2 ? "down" : "neutral"}
            />
            <MetricCard
              label="Total Requests"
              value={totalRequests.toLocaleString()}
              subtitle={`${days}d period`}
            />
          </div>

          {/* Rate config table */}
          <ChartCard title="Cost per Million Tokens" subtitle="Input vs Output by role">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={chartData}>
                <XAxis dataKey="role" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => `$${v.toFixed(2)}`} />
                <Legend />
                <Bar dataKey="input" name="Input $/M" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="output" name="Output $/M" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <DataTable
            columns={[
              { key: "role", label: "Role", sortable: true },
              { key: "model", label: "Model" },
              { key: "profile", label: "Profile", sortable: true },
              { key: "source", label: "Source", render: (r) => <SourceBadge source={r.source as string} /> },
              { key: "input_per_million", label: "Input $/M", sortable: true, render: (r) => `$${(r.input_per_million as number).toFixed(2)}` },
              { key: "output_per_million", label: "Output $/M", sortable: true, render: (r) => `$${(r.output_per_million as number).toFixed(2)}` },
              { key: "cost_formula", label: "Formula", render: (r) => <span className="text-xs text-gray-500">{(r.cost_formula as string) || "---"}</span> },
              { key: "actions", label: "", render: (r) => (
                <button onClick={() => setEditing(r as ModelCost)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" title="Edit cost">
                  <PenLine className="h-4 w-4" />
                </button>
              )},
            ]}
            data={roles}
            keyField="role"
          />

          {/* Daily cost trend: estimated vs actual */}
          {daily.length > 0 && (
            <ChartCard title={`Daily Cost Trend (${days}d)`} subtitle="Estimated vs Actual cost per day">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={daily}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v.toFixed(4)}`} />
                  <Tooltip formatter={(v: number) => `$${v.toFixed(6)}`} />
                  <Legend />
                  <Bar dataKey="estimated_cost_usd" name="Estimated" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="actual_cost_usd" name="Actual" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {/* Cost by role: estimated vs actual */}
          {byRole.length > 0 && (
            <ChartCard title={`Cost by Role (${days}d)`} subtitle="Estimated vs Actual per pipeline role">
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={byRole}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="role" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v.toFixed(4)}`} />
                  <Tooltip formatter={(v: number) => `$${v.toFixed(6)}`} />
                  <Legend />
                  <Bar dataKey="estimated_cost_usd" name="Estimated" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="actual_cost_usd" name="Actual" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {/* Cost by model: estimated vs actual */}
          {byModel.length > 0 && (
            <>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Cost by Model ({days}d)
              </h2>
              <DataTable
                columns={[
                  { key: "model", label: "Model", sortable: true, render: (r: CostByModelEntry) => shortModel(r.model) },
                  { key: "requests", label: "Requests", sortable: true },
                  { key: "prompt_tokens", label: "Prompt Tokens", sortable: true, render: (r: CostByModelEntry) => r.prompt_tokens.toLocaleString() },
                  { key: "completion_tokens", label: "Completion Tokens", sortable: true, render: (r: CostByModelEntry) => r.completion_tokens.toLocaleString() },
                  { key: "estimated_cost_usd", label: "Estimated", sortable: true, render: (r: CostByModelEntry) => `$${r.estimated_cost_usd.toFixed(6)}` },
                  { key: "actual_cost_usd", label: "Actual", sortable: true, render: (r: CostByModelEntry) => r.actual_cost_usd > 0 ? `$${r.actual_cost_usd.toFixed(6)}` : "-" },
                ]}
                data={byModel}
                keyField="model"
              />
            </>
          )}

          {/* Price history */}
          {pivotedHistory.length > 1 && (
            <ChartCard title="Price History (90d)" subtitle="Input rate changes over time">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={pivotedHistory}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} label={{ value: "$/M", angle: -90, position: "insideLeft" }} />
                  <Tooltip />
                  <Legend />
                  {rateHistoryModels.map((m, i) => (
                    <Line
                      key={m}
                      type="stepAfter"
                      dataKey={`${shortModel(m)}_in`}
                      name={`${shortModel(m)} input`}
                      stroke={COLORS[i % COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </>
      )}

      {editing && <EditCostModal cost={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
