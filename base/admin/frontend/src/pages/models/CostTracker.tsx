import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useQuery } from "@tanstack/react-query";
import {
  useModelCosts,
  useModelCostsByModel,
  useUpdateModelCost,
} from "../../api/hooks";
import client from "../../api/client";
import DataTable from "../../components/common/DataTable";
import ChartCard from "../../components/common/ChartCard";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import { DollarSign, Cloud, Server, PenLine } from "lucide-react";
import type { ModelCost } from "../../types";

interface RoleCost {
  role: string;
  prompt_tokens: number;
  completion_tokens: number;
  requests: number;
  cost_usd: number;
}

function useRoleCosts(days: number = 7) {
  return useQuery<{ roles: RoleCost[]; period_days: number }>({
    queryKey: ["models", "costs", "by-role", days],
    queryFn: () => client.get("/models/costs/by-role", { params: { days } }).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

interface DailyCost {
  date: string;
  tokens: number;
  requests: number;
  cost_usd: number;
}

function useDailyCosts(days: number = 7) {
  return useQuery<{ daily: DailyCost[]; period_days: number }>({
    queryKey: ["models", "costs", "daily", days],
    queryFn: () => client.get("/models/costs/daily", { params: { days } }).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

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
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Input $/M tokens
            </span>
            <input
              type="number"
              step="0.01"
              value={inputRate}
              onChange={(e) => setInputRate(parseFloat(e.target.value) || 0)}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Output $/M tokens
            </span>
            <input
              type="number"
              step="0.01"
              value={outputRate}
              onChange={(e) => setOutputRate(parseFloat(e.target.value) || 0)}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Monthly fixed cost ($)
            </span>
            <input
              type="number"
              step="1"
              value={monthly}
              onChange={(e) => setMonthly(parseFloat(e.target.value) || 0)}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Cost formula / notes
            </span>
            <input
              type="text"
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              placeholder="e.g. $2.24/hr × 3 nodes × 730h"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={mutation.isPending}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {mutation.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CostTracker() {
  const { data, isLoading } = useModelCosts();
  const { data: byModelData } = useModelCostsByModel();
  const { data: roleData } = useRoleCosts(7);
  const { data: dailyData } = useDailyCosts(7);
  const [editing, setEditing] = useState<ModelCost | null>(null);

  const roles = data?.roles ?? [];
  const byModel = byModelData?.models ?? [];
  const byRole = roleData?.roles ?? [];
  const daily = dailyData?.daily ?? [];

  const chartData = roles.map((r) => ({
    role: r.role,
    input: r.input_per_million,
    output: r.output_per_million,
  }));

  const totalInput = roles.reduce((s, r) => s + r.input_per_million, 0);
  const totalOutput = roles.reduce((s, r) => s + r.output_per_million, 0);
  const totalUsageCost = byModel.reduce((s, m) => s + m.cost_usd, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Cost Tracker
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Per-role cost rates and usage-based totals from traces
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : roles.length === 0 ? (
        <EmptyState
          title="No cost data"
          description="Cost data populates from models.yaml and Postgres overrides"
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <MetricCard label="Roles" value={roles.length} icon={DollarSign} />
            <MetricCard
              label="Avg Input $/M"
              value={`$${(totalInput / roles.length).toFixed(2)}`}
            />
            <MetricCard
              label="Avg Output $/M"
              value={`$${(totalOutput / roles.length).toFixed(2)}`}
            />
            <MetricCard
              label="7d Usage Cost"
              value={`$${totalUsageCost.toFixed(4)}`}
              icon={DollarSign}
            />
          </div>

          <ChartCard
            title="Cost per Million Tokens"
            subtitle="Input vs Output by role"
          >
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={chartData}>
                <XAxis dataKey="role" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(v: number) => `$${v.toFixed(2)}`}
                />
                <Bar
                  dataKey="input"
                  name="Input $/M"
                  fill="#3b82f6"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="output"
                  name="Output $/M"
                  fill="#8b5cf6"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <DataTable
            columns={[
              { key: "role", label: "Role", sortable: true },
              { key: "model", label: "Model" },
              { key: "profile", label: "Profile", sortable: true },
              {
                key: "source",
                label: "Source",
                render: (r) => <SourceBadge source={r.source as string} />,
              },
              {
                key: "input_per_million",
                label: "Input $/M",
                sortable: true,
                render: (r) =>
                  `$${(r.input_per_million as number).toFixed(2)}`,
              },
              {
                key: "output_per_million",
                label: "Output $/M",
                sortable: true,
                render: (r) =>
                  `$${(r.output_per_million as number).toFixed(2)}`,
              },
              {
                key: "cost_formula",
                label: "Formula",
                render: (r) => (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {(r.cost_formula as string) || "---"}
                  </span>
                ),
              },
              {
                key: "actions",
                label: "",
                render: (r) => (
                  <button
                    onClick={() => setEditing(r as ModelCost)}
                    className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
                    title="Edit cost"
                  >
                    <PenLine className="h-4 w-4" />
                  </button>
                ),
              },
            ]}
            data={roles}
            keyField="role"
          />

          {byRole.length > 0 && (
            <ChartCard title="Cost by Role (7d)" subtitle="Prompt vs completion token cost per pipeline role">
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={byRole}>
                  <XAxis dataKey="role" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v.toFixed(4)}`} />
                  <Tooltip formatter={(v: number) => `$${v.toFixed(6)}`} />
                  <Legend />
                  <Bar dataKey="cost_usd" name="Total Cost" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {daily.length > 0 && (
            <ChartCard title="Daily Cost Trend (7d)" subtitle="Total estimated cost per day">
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={daily}>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v.toFixed(4)}`} />
                  <Tooltip formatter={(v: number) => `$${v.toFixed(6)}`} />
                  <Bar dataKey="cost_usd" name="Cost" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {byModel.length > 0 && (
            <>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Total Cost by Model (7d)
              </h2>
              <ChartCard title="Usage Cost by Model" subtitle="Based on trace token counts">
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={byModel} layout="vertical">
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v: number) => `$${v.toFixed(4)}`}
                    />
                    <YAxis
                      type="category"
                      dataKey="model"
                      tick={{ fontSize: 10 }}
                      width={140}
                    />
                    <Tooltip
                      formatter={(v: number) => `$${v.toFixed(6)}`}
                    />
                    <Bar
                      dataKey="cost_usd"
                      name="Cost"
                      fill="#10b981"
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <DataTable
                columns={[
                  { key: "model", label: "Model", sortable: true },
                  {
                    key: "prompt_tokens",
                    label: "Prompt Tokens",
                    sortable: true,
                    render: (r) =>
                      (r.prompt_tokens as number).toLocaleString(),
                  },
                  {
                    key: "completion_tokens",
                    label: "Completion Tokens",
                    sortable: true,
                    render: (r) =>
                      (r.completion_tokens as number).toLocaleString(),
                  },
                  {
                    key: "requests",
                    label: "Requests",
                    sortable: true,
                  },
                  {
                    key: "cost_usd",
                    label: "Cost",
                    sortable: true,
                    render: (r) =>
                      `$${(r.cost_usd as number).toFixed(6)}`,
                  },
                ]}
                data={byModel}
                keyField="model"
              />
            </>
          )}
        </>
      )}

      {editing && (
        <EditCostModal cost={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
