import { useState } from "react";
import {
  useServingEndpoints,
  useCreateServingEndpoint,
  useUpdateServingEndpoint,
  useDeleteServingEndpoint,
  useServingHealth,
  useProviderCatalog,
} from "../../api/hooks";
import type { ServingEndpointEntry, ProviderInfo } from "../../types";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import {
  Plus,
  Pencil,
  Trash2,
  Activity,
  Server,
  Cloud,
  Check,
  X,
} from "lucide-react";

interface EditState {
  id: number | null;
  name: string;
  provider: string;
  model: string;
  endpoint_url: string;
  api_key_env: string;
  is_active: boolean;
  notes: string;
}

function emptyEdit(): EditState {
  return { id: null, name: "", provider: "openrouter", model: "", endpoint_url: "", api_key_env: "", is_active: true, notes: "" };
}

function editFromRow(r: ServingEndpointEntry): EditState {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    model: r.model,
    endpoint_url: r.endpoint_url,
    api_key_env: r.api_key_env,
    is_active: r.is_active,
    notes: r.notes,
  };
}

export default function ServingManagement() {
  const { data, isLoading } = useServingEndpoints();
  const { data: healthData } = useServingHealth();
  const { data: catalogData } = useProviderCatalog();
  const createMut = useCreateServingEndpoint();
  const updateMut = useUpdateServingEndpoint();
  const deleteMut = useDeleteServingEndpoint();
  const [editing, setEditing] = useState<EditState | null>(null);

  const endpoints: ServingEndpointEntry[] = data?.endpoints ?? [];
  const providers: Record<string, ProviderInfo> = catalogData?.providers ?? {};
  const healthMap = new Map(
    (healthData?.endpoints ?? []).map((h) => [h.id, h]),
  );

  const activeCount = endpoints.filter((e) => e.is_active).length;
  const healthyCount = (healthData?.endpoints ?? []).filter((h) => h.reachable).length;

  const closeModal = () => {
    setEditing(null);
    createMut.reset();
    updateMut.reset();
  };

  const handleSave = () => {
    if (!editing) return;
    if (editing.id !== null) {
      updateMut.mutate(
        { id: editing.id, ...editing },
        { onSuccess: () => closeModal() },
      );
    } else {
      createMut.mutate(
        { name: editing.name, provider: editing.provider, model: editing.model, endpoint_url: editing.endpoint_url, api_key_env: editing.api_key_env, is_active: editing.is_active, notes: editing.notes },
        { onSuccess: () => closeModal() },
      );
    }
  };

  const handleDelete = (id: number, name: string) => {
    if (!window.confirm(`Delete serving endpoint "${name}"?`)) return;
    deleteMut.mutate(id);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Model Serving</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure curated service entries for the model picklist and monitor serving endpoint health.
          </p>
        </div>
        <button
          onClick={() => setEditing(emptyEdit())}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Endpoint
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Total Endpoints</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{endpoints.length}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Active</p>
          <p className="mt-1 text-2xl font-semibold text-green-600">{activeCount}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Healthy</p>
          <p className="mt-1 text-2xl font-semibold text-blue-600">{healthyCount}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : endpoints.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center dark:border-gray-600">
          <Server className="mx-auto h-8 w-8 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No serving endpoints</h3>
          <p className="mt-1 text-xs text-gray-500">
            Add curated service entries that will appear in the Model Registry picklist.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {endpoints.map((ep) => {
            const health = healthMap.get(ep.id);
            const Icon = providers[ep.provider]?.is_local ? Server : Cloud;
            return (
              <div
                key={ep.id}
                className={`rounded-lg border p-4 ${
                  ep.is_active
                    ? "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
                    : "border-dashed border-gray-300 bg-gray-50 dark:border-gray-600 dark:bg-gray-800/50"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className={`h-4 w-4 ${ep.is_active ? "text-blue-500" : "text-gray-400"}`} />
                    <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{ep.name}</h3>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setEditing(editFromRow(ep))}
                      className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-800"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(ep.id, ep.name)}
                      className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="mt-2 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      providers[ep.provider]?.is_local
                        ? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                        : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                    }`}>
                      {providers[ep.provider]?.label ?? ep.provider}
                    </span>
                    {ep.is_active ? (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        <Check className="h-2.5 w-2.5" /> active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                        <X className="h-2.5 w-2.5" /> inactive
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-gray-600 dark:text-gray-400" title={ep.model}>
                    {ep.model || "—"}
                  </p>
                  {ep.endpoint_url && (
                    <p className="truncate text-[11px] text-gray-400" title={ep.endpoint_url}>
                      {ep.endpoint_url}
                    </p>
                  )}
                </div>

                {/* Health status */}
                {health && (
                  <div className="mt-3 flex items-center gap-2 rounded border border-gray-100 bg-gray-50 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-800">
                    <Activity className={`h-3 w-3 ${health.reachable ? "text-green-500" : "text-red-500"}`} />
                    <span className={`text-[11px] font-medium ${health.reachable ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                      {health.reachable ? "Healthy" : "Unreachable"}
                    </span>
                    {health.latency_ms != null && (
                      <span className="text-[10px] text-gray-400">{health.latency_ms}ms</span>
                    )}
                    {health.error && !health.reachable && (
                      <span className="truncate text-[10px] text-red-400" title={health.error}>
                        {health.error.slice(0, 60)}
                      </span>
                    )}
                  </div>
                )}

                {ep.notes && (
                  <p className="mt-2 text-[11px] text-gray-400 line-clamp-2">{ep.notes}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
            <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              {editing.id ? "Edit" : "Add"} Serving Endpoint
            </h3>
            <div className="space-y-3">
              <ApiErrorBanner error={createMut.error || updateMut.error} />
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Name</label>
                <input
                  type="text"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="e.g. production-gpt4o"
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Provider</label>
                <select
                  value={editing.provider}
                  onChange={(e) => setEditing({ ...editing, provider: e.target.value })}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                >
                  {Object.entries(providers).map(([key, p]) => (
                    <option key={key} value={key}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Model</label>
                <input
                  type="text"
                  value={editing.model}
                  onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                  placeholder={providers[editing.provider]?.placeholder ?? "model-name"}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Endpoint URL</label>
                <input
                  type="text"
                  value={editing.endpoint_url}
                  onChange={(e) => setEditing({ ...editing, endpoint_url: e.target.value })}
                  placeholder="http://model-service.namespace.svc:8080/v1"
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">API Key Env Var</label>
                <input
                  type="text"
                  value={editing.api_key_env}
                  onChange={(e) => setEditing({ ...editing, api_key_env: e.target.value })}
                  placeholder="e.g. OPENAI_API_KEY"
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Notes</label>
                <textarea
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                  rows={2}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editing.is_active}
                  onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })}
                  className="rounded"
                />
                <span className="text-gray-700 dark:text-gray-300">Active (visible in picklists)</span>
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={closeModal}
                  className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={createMut.isPending || updateMut.isPending || !editing.name.trim() || !editing.model.trim()}
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {(createMut.isPending || updateMut.isPending) ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
