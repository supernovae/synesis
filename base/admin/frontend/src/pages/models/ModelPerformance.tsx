import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useModelPerformance } from "../../api/hooks";
import ChartCard from "../../components/common/ChartCard";
import DataTable from "../../components/common/DataTable";
import EmptyState from "../../components/common/EmptyState";

export default function ModelPerformance() {
  const { data, isLoading } = useModelPerformance();
  const models = data?.models ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Model Performance
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Per-model token counts and request metrics
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : models.length === 0 ? (
        <EmptyState
          title="No performance data"
          description="Metrics will populate after requests flow through the pipeline"
        />
      ) : (
        <>
          <ChartCard title="Tokens by Model">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={models}>
                <XAxis dataKey="model" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => v.toLocaleString()} />
                <Bar dataKey="tokens" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <DataTable
            columns={[
              { key: "model", label: "Model", sortable: true },
              { key: "tokens", label: "Total Tokens", sortable: true, render: (r) => (r.tokens as number).toLocaleString() },
              { key: "requests", label: "Requests", sortable: true },
            ]}
            data={models}
            keyField="model"
          />
        </>
      )}
    </div>
  );
}
