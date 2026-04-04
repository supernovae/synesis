import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { usePipelineMetrics } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import ChartCard from "../../components/common/ChartCard";
import EmptyState from "../../components/common/EmptyState";

export default function NodePerformance() {
  const { data, isLoading } = usePipelineMetrics();
  const nodes = data?.nodes ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Node Performance
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Per-node latency, confidence, and call counts
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : nodes.length === 0 ? (
        <EmptyState
          title="No pipeline metrics"
          description="Metrics will appear after requests are processed"
        />
      ) : (
        <>
          <ChartCard title="Node Confidence" subtitle="Average confidence score per node">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={nodes}>
                <XAxis dataKey="node" tick={{ fontSize: 11 }} />
                <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => (v == null ? "" : Number(v).toFixed(3))} />
                <Bar dataKey="avg_confidence" fill="#22c55e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <DataTable
            columns={[
              { key: "node", label: "Node", sortable: true },
              { key: "call_count", label: "Calls", sortable: true },
              {
                key: "avg_confidence",
                label: "Avg Confidence",
                sortable: true,
                render: (r) => (r.avg_confidence as number).toFixed(3),
              },
              {
                key: "avg_duration_ms",
                label: "Avg Duration",
                sortable: true,
                render: (r) => `${(r.avg_duration_ms as number).toFixed(0)}ms`,
              },
            ]}
            data={nodes}
            keyField="node"
          />
        </>
      )}
    </div>
  );
}
