import { useModels } from "../../api/hooks";
import { useQuery } from "@tanstack/react-query";
import client from "../../api/client";
import DataTable from "../../components/common/DataTable";
import StatusBadge from "../../components/common/StatusBadge";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import { Layers, CheckCircle, XCircle, Cloud, Server, Monitor } from "lucide-react";

interface DeploymentEntry {
  role: string;
  model: string;
  served_name: string;
  endpoint: string;
  status: string;
  gpu: string;
  notes: string;
}

interface TopologyData {
  environments: Record<string, DeploymentEntry[]>;
  roles: string[];
}

function useModelTopology() {
  return useQuery<TopologyData>({
    queryKey: ["models", "topology"],
    queryFn: () => client.get("/models/topology").then((r) => r.data),
    staleTime: 60_000,
  });
}

const ENV_ICON: Record<string, typeof Server> = {
  openrouter: Cloud,
  local: Server,
};

const STATUS_COLORS: Record<string, string> = {
  configured: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  healthy: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  degraded: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  offline: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export default function ModelRegistry() {
  const { data, isLoading } = useModels();
  const { data: topology, isLoading: topoLoading } = useModelTopology();
  const models = data?.models ?? [];
  const healthy = models.filter((m) => m.status === "healthy").length;
  const environments = topology?.environments ?? {};
  const envNames = Object.keys(environments);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Model Registry
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Deployed models, roles, and environment topology
        </p>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : models.length === 0 ? (
        <EmptyState
          title="No models registered"
          description="Model data appears once models.yaml is mounted"
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <MetricCard label="Total Roles" value={models.length} icon={Layers} />
            <MetricCard label="Healthy" value={healthy} icon={CheckCircle} />
            <MetricCard label="Offline" value={models.length - healthy} icon={XCircle} />
            <MetricCard label="Environments" value={envNames.length} icon={Monitor} />
          </div>

          {!topoLoading && envNames.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Deployment Topology
              </h2>
              <div className="grid gap-4 lg:grid-cols-2">
                {envNames.map((envName) => {
                  const entries = environments[envName];
                  const isOpenRouter = envName.startsWith("openrouter");
                  const Icon = isOpenRouter ? ENV_ICON.openrouter : ENV_ICON.local;
                  return (
                    <div
                      key={envName}
                      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
                    >
                      <div className="mb-3 flex items-center gap-2">
                        <Icon className="h-4 w-4 text-gray-500" />
                        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                          {envName}
                        </h3>
                        <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
                          {entries.length} roles
                        </span>
                      </div>
                      <div className="space-y-2">
                        {entries.map((entry) => (
                          <div
                            key={`${envName}-${entry.role}`}
                            className="flex items-center gap-3 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/50"
                          >
                            <span className="min-w-[5rem] text-xs font-medium text-gray-700 dark:text-gray-300">
                              {entry.role}
                            </span>
                            <span className="flex-1 truncate text-xs text-gray-500 dark:text-gray-400">
                              {entry.model || "—"}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[entry.status] || STATUS_COLORS.unknown}`}
                            >
                              {entry.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Model Details
          </h2>
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
