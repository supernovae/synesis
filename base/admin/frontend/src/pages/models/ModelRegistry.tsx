import { useState } from "react";
import {
  useModelDeployments,
  useActivateModel,
  useDeactivateModel,
  useActivateEnvironment,
  useUpdateModelDeployment,
  useDeleteModelDeployment,
  useSyncModelsFromYaml,
  useReconcileModels,
  useCreateModelDeployment,
  useUpdateFallbacks,
  useProviderKeys,
} from "../../api/hooks";
import type { ModelDeployment } from "../../types";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import StatusBadge from "../../components/common/StatusBadge";
import {
  Layers,
  CheckCircle,
  XCircle,
  Cloud,
  Server,
  Power,
  PowerOff,
  RefreshCw,
  Download,
  Pencil,
  Trash2,
  Plus,
  Zap,
} from "lucide-react";

const PROVIDERS: Record<string, { label: string; prefix: string; apiKeyEnv: string; needsEndpoint: boolean; placeholder: string }> = {
  openrouter: { label: "OpenRouter",  prefix: "openrouter/",   apiKeyEnv: "OPENROUTER_API_KEY", needsEndpoint: false, placeholder: "x-ai/grok-4-fast" },
  groq:       { label: "Groq",        prefix: "groq/",         apiKeyEnv: "GROQ_API_KEY",       needsEndpoint: false, placeholder: "llama-3.3-70b-versatile" },
  together:   { label: "Together AI", prefix: "together_ai/",  apiKeyEnv: "TOGETHER_API_KEY",   needsEndpoint: false, placeholder: "meta-llama/Llama-3-70b" },
  deepinfra:  { label: "DeepInfra",   prefix: "deepinfra/",    apiKeyEnv: "DEEPINFRA_API_KEY",  needsEndpoint: false, placeholder: "meta-llama/Meta-Llama-3.1-70B" },
  fireworks:  { label: "Fireworks AI", prefix: "fireworks_ai/", apiKeyEnv: "FIREWORKS_API_KEY",  needsEndpoint: false, placeholder: "llama-v3p1-70b-instruct" },
  openai:     { label: "OpenAI",      prefix: "openai/",       apiKeyEnv: "OPENAI_API_KEY",     needsEndpoint: false, placeholder: "gpt-4o" },
  anthropic:  { label: "Anthropic",   prefix: "anthropic/",    apiKeyEnv: "ANTHROPIC_API_KEY",  needsEndpoint: false, placeholder: "claude-sonnet-4-20250514" },
  vllm:       { label: "vLLM (local)", prefix: "openai/",      apiKeyEnv: "",                   needsEndpoint: true,  placeholder: "synesis-router" },
  custom:     { label: "Custom (OpenAI-compatible)", prefix: "openai/", apiKeyEnv: "", needsEndpoint: true, placeholder: "model-name" },
};

const SOURCE_ICON: Record<string, typeof Cloud> = {
  openrouter: Cloud,
  groq: Cloud,
  together: Cloud,
  deepinfra: Cloud,
  fireworks: Cloud,
  openai: Cloud,
  anthropic: Cloud,
  vllm: Server,
  kserve: Server,
  custom: Cloud,
  external: Cloud,
  local: Server,
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  activating: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  configured: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  error: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

interface EditState {
  id: number;
  model: string;
  endpoint: string;
  max_tokens: number;
  temperature: number;
  fallbacks: string;
}

export default function ModelRegistry() {
  const { data, isLoading } = useModelDeployments();
  const activateMut = useActivateModel();
  const deactivateMut = useDeactivateModel();
  const activateEnvMut = useActivateEnvironment();
  const updateMut = useUpdateModelDeployment();
  const deleteMut = useDeleteModelDeployment();
  const syncYaml = useSyncModelsFromYaml();
  const reconcileMut = useReconcileModels();
  const createMut = useCreateModelDeployment();
  const fallbackMut = useUpdateFallbacks();

  const [editing, setEditing] = useState<EditState | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newDep, setNewDep] = useState({ environment: "", role: "", model: "", source: "openrouter", endpoint: "", apiKeyEnv: "" });

  const { data: providerKeysData } = useProviderKeys();
  const configuredKeys = new Set((providerKeysData ?? []).filter((k: any) => k.configured).map((k: any) => k.name));

  const deployments = data?.deployments ?? [];
  const active = deployments.filter((d) => d.is_active);
  const environments = [...new Set(deployments.map((d) => d.environment))].sort();

  const envGroups: Record<string, ModelDeployment[]> = {};
  for (const d of deployments) {
    if (!envGroups[d.environment]) envGroups[d.environment] = [];
    envGroups[d.environment].push(d);
  }

  const handleToggle = (d: ModelDeployment) => {
    if (d.is_active) {
      deactivateMut.mutate(d.id);
    } else {
      activateMut.mutate(d.id);
    }
  };

  const handleSaveEdit = () => {
    if (!editing) return;
    const params: Record<string, unknown> = {};
    const dep = deployments.find((d) => d.id === editing.id);
    if (dep?.litellm_params) Object.assign(params, dep.litellm_params);
    params.max_tokens = editing.max_tokens;
    params.temperature = editing.temperature;
    const fbList = editing.fallbacks
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    updateMut.mutate(
      { id: editing.id, model: editing.model, endpoint: editing.endpoint, litellm_params: params as any },
      {
        onSuccess: () => {
          fallbackMut.mutate({ id: editing.id, fallbacks: fbList });
          setEditing(null);
        },
      },
    );
  };

  const handleCreate = () => {
    const provider = PROVIDERS[newDep.source] ?? PROVIDERS.custom;
    const litellm_params: Record<string, unknown> = {
      model: `${provider.prefix}${newDep.model}`,
      max_tokens: provider.needsEndpoint ? 32768 : 8192,
      temperature: 0.1,
    };
    const keyEnv = newDep.apiKeyEnv || provider.apiKeyEnv;
    if (keyEnv) {
      litellm_params.api_key = `os.environ/${keyEnv}`;
    } else if (provider.needsEndpoint) {
      litellm_params.api_key = "not-needed";
    }
    if (provider.needsEndpoint && newDep.endpoint) {
      litellm_params.api_base = newDep.endpoint;
    }
    createMut.mutate(
      {
        environment: newDep.environment,
        role: newDep.role,
        model: newDep.model,
        endpoint: newDep.endpoint || "",
        source: newDep.source as any,
        served_name: `synesis-${newDep.role}`,
        litellm_params: litellm_params as any,
      },
      { onSuccess: () => { setShowAdd(false); setNewDep({ environment: "", role: "", model: "", source: "openrouter", endpoint: "", apiKeyEnv: "" }); } }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Model Registry</h1>
          <p className="mt-1 text-sm text-gray-500">Manage model deployments, activate environments, and sync to LiteLLM gateway</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => reconcileMut.mutate()}
            disabled={reconcileMut.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <Zap className="h-3.5 w-3.5" />
            {reconcileMut.isPending ? "Syncing..." : "Force Sync"}
          </button>
          <button
            onClick={() => syncYaml.mutate()}
            disabled={syncYaml.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <Download className="h-3.5 w-3.5" />
            {syncYaml.isPending ? "Seeding..." : "Seed from YAML"}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Model
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : deployments.length === 0 ? (
        <EmptyState title="No model deployments" description="Seed from models.yaml or add models manually" />
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-4 sm:grid-cols-4">
            <MetricCard label="Total Deployments" value={deployments.length} icon={Layers} />
            <MetricCard label="Active" value={active.length} icon={CheckCircle} />
            <MetricCard label="Inactive" value={deployments.length - active.length} icon={XCircle} />
            <MetricCard label="Environments" value={environments.length} icon={Cloud} />
          </div>

          {/* Active models banner */}
          {active.length > 0 && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/30">
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-green-800 dark:text-green-300">
                <CheckCircle className="h-4 w-4" /> Active Models ({active.length})
              </h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {active.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 rounded bg-white px-3 py-2 text-sm dark:bg-gray-900">
                    <span className="font-medium text-gray-800 dark:text-gray-200">{d.role}</span>
                    <span className="flex-1 truncate text-xs text-gray-500">{d.model}</span>
                    <SyncBadge d={d} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Activate environment */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Activate Environment:</span>
            {environments.map((env) => {
              const isActive = envGroups[env]?.every((d) => d.is_active);
              return (
                <button
                  key={env}
                  onClick={() => activateEnvMut.mutate(env)}
                  disabled={activateEnvMut.isPending}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                    isActive
                      ? "bg-green-600 text-white"
                      : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                  }`}
                >
                  {env}
                </button>
              );
            })}
          </div>

          {/* Environment groups */}
          {Object.entries(envGroups).map(([envName, entries]) => {
            const isOpenRouter = envName.startsWith("openrouter");
            const Icon = isOpenRouter ? Cloud : Server;
            return (
              <div key={envName} className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
                <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
                  <Icon className="h-4 w-4 text-gray-500" />
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{envName}</h3>
                  <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
                    {entries.length} models
                  </span>
                </div>
                <div className="divide-y divide-gray-50 dark:divide-gray-800">
                  {entries.map((d) => (
                    <div
                      key={d.id}
                      className={`flex items-center gap-3 px-4 py-3 ${d.is_active ? "bg-green-50/50 dark:bg-green-950/10" : ""}`}
                    >
                      {/* Toggle */}
                      <button
                        onClick={() => handleToggle(d)}
                        disabled={activateMut.isPending || deactivateMut.isPending}
                        className="flex-shrink-0"
                        title={d.is_active ? "Deactivate" : "Activate"}
                      >
                        {d.is_active ? (
                          <Power className="h-4 w-4 text-green-600" />
                        ) : (
                          <PowerOff className="h-4 w-4 text-gray-400 hover:text-green-500" />
                        )}
                      </button>

                      {/* Role */}
                      <span className="w-20 text-xs font-semibold text-gray-700 dark:text-gray-300">{d.role}</span>

                      {/* Model */}
                      <span className="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-400">{d.model || "—"}</span>

                      {/* Status */}
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[d.status] || STATUS_COLORS.unknown}`}>
                        {d.status}
                      </span>

                      {/* Sync indicator */}
                      <SyncBadge d={d} />

                      {/* Actions */}
                      <button
                        onClick={() =>
                          setEditing({
                            id: d.id,
                            model: d.model,
                            endpoint: d.endpoint,
                            max_tokens: (d.litellm_params?.max_tokens as number) ?? 8192,
                            temperature: (d.litellm_params?.temperature as number) ?? 0.1,
                            fallbacks: (d.fallbacks ?? []).join(", "),
                          })
                        }
                        className="text-gray-400 hover:text-blue-600"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Delete ${d.role} from ${d.environment}?`))
                            deleteMut.mutate(d.id);
                        }}
                        className="text-gray-400 hover:text-red-600"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* Edit modal */}
      {editing && (
        <Modal onClose={() => setEditing(null)} title="Edit Model Deployment">
          <div className="space-y-3">
            <Field label="Model" value={editing.model} onChange={(v) => setEditing({ ...editing, model: v })} />
            <Field label="Endpoint" value={editing.endpoint} onChange={(v) => setEditing({ ...editing, endpoint: v })} />
            <Field label="Max Tokens" value={String(editing.max_tokens)} onChange={(v) => setEditing({ ...editing, max_tokens: Number(v) || 8192 })} type="number" />
            <Field label="Temperature" value={String(editing.temperature)} onChange={(v) => setEditing({ ...editing, temperature: Number(v) || 0.1 })} type="number" />
            <Field label="Fallback Models" value={editing.fallbacks} onChange={(v) => setEditing({ ...editing, fallbacks: v })} placeholder="comma-separated served names, e.g. synesis-general-fb" />
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(null)} className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">Cancel</button>
              <button onClick={handleSaveEdit} disabled={updateMut.isPending} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
                {updateMut.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Add modal */}
      {showAdd && (() => {
        const provider = PROVIDERS[newDep.source] ?? PROVIDERS.custom;
        const keyEnv = newDep.apiKeyEnv || provider.apiKeyEnv;
        const keyConfigured = keyEnv ? configuredKeys.has(keyEnv) : true;
        return (
          <Modal onClose={() => setShowAdd(false)} title="Add Model Deployment">
            <div className="space-y-3">
              <Field label="Environment" value={newDep.environment} onChange={(v) => setNewDep({ ...newDep, environment: v })} placeholder="e.g. api, dev" />
              <Field label="Role" value={newDep.role} onChange={(v) => setNewDep({ ...newDep, role: v })} placeholder="e.g. router, general, critic" />
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Provider</label>
                <select
                  value={newDep.source}
                  onChange={(e) => setNewDep({ ...newDep, source: e.target.value, apiKeyEnv: "" })}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                >
                  {Object.entries(PROVIDERS).map(([key, p]) => (
                    <option key={key} value={key}>
                      {p.label}{p.apiKeyEnv ? (configuredKeys.has(p.apiKeyEnv) ? " \u2713" : " \u2022 key needed") : ""}
                    </option>
                  ))}
                </select>
              </div>
              <Field
                label="Model"
                value={newDep.model}
                onChange={(v) => setNewDep({ ...newDep, model: v })}
                placeholder={provider.placeholder}
              />
              {provider.needsEndpoint && (
                <Field label="Endpoint" value={newDep.endpoint} onChange={(v) => setNewDep({ ...newDep, endpoint: v })} placeholder="http://model-service.namespace.svc:8080/v1" />
              )}
              {keyEnv && (
                <div className="rounded border px-3 py-2 text-xs border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                  <span className="text-gray-500 dark:text-gray-400">API Key env: </span>
                  <code className="font-mono text-gray-700 dark:text-gray-300">{keyEnv}</code>
                  {keyConfigured ? (
                    <span className="ml-2 text-green-600 dark:text-green-400">(configured)</span>
                  ) : (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">(not set — add in Settings &gt; Provider Keys)</span>
                  )}
                </div>
              )}
              {newDep.source === "custom" && (
                <Field
                  label="API Key Env Var (optional)"
                  value={newDep.apiKeyEnv}
                  onChange={(v) => setNewDep({ ...newDep, apiKeyEnv: v })}
                  placeholder="e.g. MY_PROVIDER_API_KEY"
                />
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowAdd(false)} className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">Cancel</button>
                <button
                  onClick={handleCreate}
                  disabled={createMut.isPending || !newDep.environment || !newDep.role || !newDep.model}
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {createMut.isPending ? "Creating..." : "Create"}
                </button>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* Reconcile result toast */}
      {reconcileMut.isSuccess && reconcileMut.data && (
        <div className="fixed bottom-4 right-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 shadow-lg dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          Sync complete: {(reconcileMut.data as any).added} added, {(reconcileMut.data as any).removed} removed, {(reconcileMut.data as any).unchanged} unchanged
        </div>
      )}
    </div>
  );
}

function SyncBadge({ d }: { d: ModelDeployment }) {
  if (!d.is_active) return null;
  if (d.litellm_model_id) {
    return <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">Synced</span>;
  }
  return <span className="rounded-full bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">Pending</span>;
}

function Modal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, type = "text",
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
      />
    </div>
  );
}
