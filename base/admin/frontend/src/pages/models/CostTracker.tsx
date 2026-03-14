import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useModelCosts } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import ChartCard from "../../components/common/ChartCard";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import { DollarSign } from "lucide-react";

export default function CostTracker() {
  const { data, isLoading } = useModelCosts();
  const roles = data?.roles ?? [];

  const chartData = roles.map((r) => ({
    role: r.role,
    input: r.input_per_million,
    output: r.output_per_million,
  }));

  const totalInput = roles.reduce((s, r) => s + r.input_per_million, 0);
  const totalOutput = roles.reduce((s, r) => s + r.output_per_million, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Cost Tracker</h1>
        <p className="mt-1 text-sm text-gray-500">
          Per-role cost estimates from OpenRouter pricing
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : roles.length === 0 ? (
        <EmptyState
          title="No cost data"
          description="Cost estimates will populate from models.yaml"
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard label="Roles" value={roles.length} icon={DollarSign} />
            <MetricCard
              label="Avg Input $/M"
              value={`$${(totalInput / roles.length).toFixed(2)}`}
            />
            <MetricCard
              label="Avg Output $/M"
              value={`$${(totalOutput / roles.length).toFixed(2)}`}
            />
          </div>

          <ChartCard title="Cost per Million Tokens" subtitle="Input vs Output by role">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={chartData}>
                <XAxis dataKey="role" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => `$${v.toFixed(2)}`} />
                <Bar dataKey="input" name="Input $/M" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="output" name="Output $/M" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <DataTable
            columns={[
              { key: "role", label: "Role", sortable: true },
              { key: "model", label: "Model" },
              { key: "profile", label: "Profile" },
              {
                key: "input_per_million",
                label: "Input $/M",
                sortable: true,
                render: (r) => `$${(r.input_per_million as number).toFixed(2)}`,
              },
              {
                key: "output_per_million",
                label: "Output $/M",
                sortable: true,
                render: (r) => `$${(r.output_per_million as number).toFixed(2)}`,
              },
            ]}
            data={roles}
            keyField="role"
          />
        </>
      )}
    </div>
  );
}
