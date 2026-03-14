import { useModels } from "../../api/hooks";
import DataTable from "../../components/common/DataTable";
import StatusBadge from "../../components/common/StatusBadge";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import { Layers, CheckCircle, XCircle } from "lucide-react";

export default function ModelRegistry() {
  const { data, isLoading } = useModels();
  const models = data?.models ?? [];
  const healthy = models.filter((m) => m.status === "healthy").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Model Registry</h1>
        <p className="mt-1 text-sm text-gray-500">
          Deployed models, roles, and endpoints
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100" />
      ) : models.length === 0 ? (
        <EmptyState
          title="No models registered"
          description="Model data appears once models.yaml is mounted"
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard label="Total Models" value={models.length} icon={Layers} />
            <MetricCard label="Healthy" value={healthy} icon={CheckCircle} />
            <MetricCard label="Offline" value={models.length - healthy} icon={XCircle} />
          </div>

          <DataTable
            columns={[
              { key: "role", label: "Role", sortable: true },
              { key: "model_name", label: "Model", sortable: true },
              { key: "served_name", label: "Served As" },
              {
                key: "endpoint",
                label: "Endpoint",
                className: "font-mono text-xs max-w-xs truncate",
              },
              { key: "description", label: "Description", className: "max-w-sm" },
              {
                key: "status",
                label: "Status",
                render: (r) => (
                  <StatusBadge status={r.status as "healthy" | "offline"} />
                ),
              },
            ]}
            data={models}
            keyField="role"
          />
        </>
      )}
    </div>
  );
}
