import { useState, useMemo } from "react";
import {
  useInfraCatalog,
  useInfraConfigs,
  useSetInfraCost,
  useDeleteInfraCost,
  useRoleAssignments,
} from "../../api/hooks";
import type { InfraInstanceType, InfraCostConfig } from "../../types";
import DataTable from "../../components/common/DataTable";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import { Server, Calculator, DollarSign, Plus, Trash2 } from "lucide-react";

function deriveRate(hourly: number, tokensPerHour: number): number {
  if (tokensPerHour <= 0 || hourly <= 0) return 0;
  return (hourly / tokensPerHour) * 1_000_000;
}

interface EditState {
  role: string;
  cloud: string;
  instance_type: string;
  gpu_model: string;
  gpu_count: number;
  hourly_rate: number;
  tokens_per_hour: number;
  notes: string;
}

function emptyEdit(role: string): EditState {
  return {
    role,
    cloud: "aws",
    instance_type: "",
    gpu_model: "",
    gpu_count: 0,
    hourly_rate: 0,
    tokens_per_hour: 10_000_000,
    notes: "",
  };
}

function editFromConfig(c: InfraCostConfig): EditState {
  return {
    role: c.role,
    cloud: c.cloud,
    instance_type: c.instance_type,
    gpu_model: c.gpu_model,
    gpu_count: c.gpu_count,
    hourly_rate: c.hourly_rate,
    tokens_per_hour: c.tokens_per_hour,
    notes: c.notes,
  };
}

export default function InfraCosts() {
  const { data: catalogData } = useInfraCatalog();
  const { data: configsData, isLoading } = useInfraConfigs();
  const { data: rolesData } = useRoleAssignments();
  const saveMut = useSetInfraCost();
  const deleteMut = useDeleteInfraCost();
  const [editing, setEditing] = useState<EditState | null>(null);

  const catalog = useMemo(() => catalogData?.instances ?? [], [catalogData]);
  const configs = useMemo(() => configsData?.configs ?? [], [configsData]);
  const configByRole = useMemo(() => {
    const m = new Map<string, InfraCostConfig>();
    configs.forEach((c) => m.set(c.role, c));
    return m;
  }, [configs]);

  const localRoles = useMemo(() => {
    return (rolesData?.roles ?? []).filter(
      (r) => r.assigned && (r.provider === "vllm" || r.provider === "kserve"),
    );
  }, [rolesData]);

  const totalMonthly = configs.reduce(
    (s, c) => s + c.hourly_rate * 730,
    0,
  );

  const catalogByType = useMemo(() => {
    const m = new Map<string, InfraInstanceType>();
    catalog.forEach((i) => m.set(i.instance_type, i));
    return m;
  }, [catalog]);

  const filteredCatalog = useMemo(() => {
    if (!editing) return catalog;
    if (editing.cloud === "other") return catalog.filter((i) => i.cloud === "other");
    return catalog.filter((i) => i.cloud === editing.cloud || i.cloud === "other");
  }, [catalog, editing]);

  const handleInstanceSelect = (instanceType: string) => {
    if (!editing) return;
    const inst = catalogByType.get(instanceType);
    if (inst) {
      setEditing({
        ...editing,
        instance_type: inst.instance_type,
        gpu_model: inst.gpu_model,
        gpu_count: inst.gpu_count,
        hourly_rate: inst.on_demand_hourly,
        tokens_per_hour: inst.estimated_tokens_per_hour,
      });
    }
  };

  const handleSave = () => {
    if (!editing) return;
    saveMut.mutate(
      {
        role: editing.role,
        cloud: editing.cloud,
        instance_type: editing.instance_type,
        gpu_model: editing.gpu_model,
        gpu_count: editing.gpu_count,
        hourly_rate: editing.hourly_rate,
        tokens_per_hour: editing.tokens_per_hour,
        notes: editing.notes,
      },
      { onSuccess: () => setEditing(null) },
    );
  };

  const derivedRate = editing
    ? deriveRate(editing.hourly_rate, editing.tokens_per_hour)
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Infrastructure Costs</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure compute costs for local vLLM/KServe deployments. The system derives per-token pricing from your instance rate and estimated throughput.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Local Roles" value={localRoles.length} icon={Server} />
        <MetricCard label="Configured" value={configs.length} icon={Calculator} />
        <MetricCard
          label="Est. Monthly"
          value={totalMonthly > 0 ? `$${totalMonthly.toFixed(0)}` : "-"}
          icon={DollarSign}
        />
      </div>

      {isLoading ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : localRoles.length === 0 && configs.length === 0 ? (
        <EmptyState
          title="No local model roles"
          description="Assign a local vLLM or KServe provider to a role in the Model Registry to configure infrastructure costs"
        />
      ) : (
        <>
          {/* Existing configs */}
          {configs.length > 0 && (
            <DataTable
              columns={[
                { key: "role", label: "Role", sortable: true },
                {
                  key: "instance_type",
                  label: "Instance",
                  render: (r: InfraCostConfig) => (
                    <span className="text-xs">
                      {r.cloud ? `${r.cloud.toUpperCase()} ` : ""}
                      {r.instance_type || "custom"}
                    </span>
                  ),
                },
                {
                  key: "gpu_model",
                  label: "GPU",
                  render: (r: InfraCostConfig) =>
                    r.gpu_count > 0 ? `${r.gpu_count}x ${r.gpu_model}` : "-",
                },
                {
                  key: "hourly_rate",
                  label: "$/hr",
                  sortable: true,
                  render: (r: InfraCostConfig) => `$${r.hourly_rate.toFixed(2)}`,
                },
                {
                  key: "tokens_per_hour",
                  label: "Tokens/hr",
                  render: (r: InfraCostConfig) =>
                    `${(r.tokens_per_hour / 1_000_000).toFixed(0)}M`,
                },
                {
                  key: "input_per_million",
                  label: "Derived $/M",
                  sortable: true,
                  render: (r: InfraCostConfig) => `$${r.input_per_million.toFixed(4)}`,
                },
                {
                  key: "actions",
                  label: "",
                  render: (r: InfraCostConfig) => (
                    <div className="flex gap-1">
                      <button
                        onClick={() => setEditing(editFromConfig(r))}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-800"
                        title="Edit"
                      >
                        <Calculator className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => deleteMut.mutate(r.role)}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ),
                },
              ]}
              data={configs}
              keyField="role"
            />
          )}

          {/* Unconfigured local roles */}
          {localRoles.filter((r) => !configByRole.has(r.role)).length > 0 && (
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-800/50">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Unconfigured Local Roles</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {localRoles
                  .filter((r) => !configByRole.has(r.role))
                  .map((r) => (
                    <button
                      key={r.role}
                      onClick={() => setEditing(emptyEdit(r.role))}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-blue-900/20"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {r.role}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Edit / Add modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setEditing(null)}>
          <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Infrastructure Cost: {editing.role}
            </h3>

            <div className="mt-4 space-y-3">
              {/* Cloud provider */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Cloud Provider</label>
                <select
                  value={editing.cloud}
                  onChange={(e) => setEditing({ ...editing, cloud: e.target.value, instance_type: "" })}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                >
                  <option value="aws">AWS</option>
                  <option value="gcp">GCP</option>
                  <option value="azure">Azure</option>
                  <option value="other">Other / Bare Metal</option>
                </select>
              </div>

              {/* Instance type picklist */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Instance Type</label>
                <select
                  value={editing.instance_type}
                  onChange={(e) => handleInstanceSelect(e.target.value)}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                >
                  <option value="">Select an instance...</option>
                  {filteredCatalog.map((i) => (
                    <option key={i.instance_type} value={i.instance_type}>
                      {i.label} — ${i.on_demand_hourly.toFixed(2)}/hr
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Hourly Rate ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={editing.hourly_rate}
                    onChange={(e) => setEditing({ ...editing, hourly_rate: parseFloat(e.target.value) || 0 })}
                    className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Est. Tokens/hr</label>
                  <input
                    type="number"
                    step="1000000"
                    value={editing.tokens_per_hour}
                    onChange={(e) => setEditing({ ...editing, tokens_per_hour: parseInt(e.target.value) || 0 })}
                    className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">GPU Model</label>
                  <input
                    type="text"
                    value={editing.gpu_model}
                    onChange={(e) => setEditing({ ...editing, gpu_model: e.target.value })}
                    placeholder="e.g. A100-80GB"
                    className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">GPU Count</label>
                  <input
                    type="number"
                    value={editing.gpu_count}
                    onChange={(e) => setEditing({ ...editing, gpu_count: parseInt(e.target.value) || 0 })}
                    className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Notes</label>
                <input
                  type="text"
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                  placeholder="e.g. reserved instance, spot pricing"
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>

              {/* Derived cost display */}
              <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-800 dark:bg-blue-950/30">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-blue-800 dark:text-blue-300">Derived Cost</span>
                  <span className="text-lg font-semibold text-blue-900 dark:text-blue-200">
                    ${derivedRate.toFixed(4)}/M tokens
                  </span>
                </div>
                <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">
                  ${editing.hourly_rate.toFixed(2)}/hr &divide; {(editing.tokens_per_hour / 1_000_000).toFixed(0)}M tokens/hr &times; 1M
                  {editing.hourly_rate > 0 && (
                    <> = ~${(editing.hourly_rate * 730).toFixed(0)}/mo</>
                  )}
                </p>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setEditing(null)}
                className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saveMut.isPending || editing.hourly_rate <= 0}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saveMut.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
