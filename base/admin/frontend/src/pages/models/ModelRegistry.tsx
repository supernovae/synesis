import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import {
  useRoleAssignments,
  useAssignRole,
  useDeactivateRole,
  useSyncModelsFromYaml,
  useReconcileModels,
  useProviderKeys,
  useProviderCatalog,
  usePipelineServices,
  useDiscoverModels,
  useProviderDefaults,
} from "../../api/hooks";
import type { ProviderKeyStatus } from "../../api/hooks";
import type { ModelDeployment, ProviderInfo, DiscoveredModel } from "../../types";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import {
  Layers,
  CheckCircle,
  XCircle,
  Cloud,
  Server,
  Zap,
  Download,
  Pencil,
  Link2,
  AlertTriangle,
  Search,
  Wand2,
  RefreshCw,
} from "lucide-react";

const SOURCE_ICON: Record<string, typeof Cloud> = {
  openrouter: Cloud, xai: Zap, groq: Cloud, together: Cloud, deepinfra: Cloud,
  dashscope: Cloud, "dashscope-us": Cloud,
  fireworks: Cloud, openai: Cloud, anthropic: Cloud, mistral: Cloud,
  azure: Cloud, vllm: Server, kserve: Server, custom: Cloud,
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  activating: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  configured: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  error: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  unassigned: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

interface EditState {
  role: string;
  provider: string;
  model: string;
  endpoint: string;
  api_key_env: string;
  max_tokens: string;
  temperature: string;
  fallbacks: string;
}

function emptyEdit(role: string): EditState {
  return { role, provider: "openrouter", model: "", endpoint: "", api_key_env: "", max_tokens: "8192", temperature: "0.1", fallbacks: "" };
}

function editFromDeployment(d: ModelDeployment): EditState {
  const mt = (d.litellm_params?.max_tokens as number) ?? 8192;
  const temp = (d.litellm_params?.temperature as number) ?? 0.1;
  return {
    role: d.role,
    provider: d.provider || "custom",
    model: d.model,
    endpoint: d.endpoint,
    api_key_env: d.api_key_env || "",
    max_tokens: String(mt),
    temperature: String(temp),
    fallbacks: (d.fallbacks ?? []).join(", "),
  };
}

export default function ModelRegistry() {
  const { data, isLoading } = useRoleAssignments();
  const assignMut = useAssignRole();
  const deactivateMut = useDeactivateRole();
  const syncYaml = useSyncModelsFromYaml();
  const reconcileMut = useReconcileModels();

  const { data: catalogData } = useProviderCatalog();
  const { data: providerKeysData } = useProviderKeys();
  const { data: pipelineServices } = usePipelineServices();

  const [editing, setEditing] = useState<EditState | null>(null);

  const providers = catalogData?.providers ?? {};
  const configuredKeys = new Set(
    (providerKeysData ?? []).filter((k: ProviderKeyStatus) => k.configured).map((k) => k.name),
  );

  const roles: ModelDeployment[] = data?.roles ?? [];
  const assigned = roles.filter((r) => r.assigned);
  const unassigned = roles.filter((r) => !r.assigned);

  // Detect shared physical models (same provider + model + endpoint).
  const sharedMap = new Map<string, string[]>();
  for (const r of assigned) {
    const key = `${r.provider}|${r.model}|${r.endpoint}`;
    if (!sharedMap.has(key)) sharedMap.set(key, []);
    sharedMap.get(key)!.push(r.role);
  }

  const closeEditModal = () => {
    assignMut.reset();
    setEditing(null);
  };

  const handleSave = () => {
    if (!editing) return;
    const prov = providers[editing.provider];
    const keyEnv = (editing.api_key_env || prov?.api_key_env || "").trim();
    const keyOk = !keyEnv || configuredKeys.has(keyEnv);
    if (keyEnv && !keyOk) {
      if (editing.provider === "custom") {
        if (
          !window.confirm(
            "This API key env var is not set under Settings → Provider API Keys. LiteLLM will fail until the key exists in the cluster secret. Continue saving?",
          )
        ) {
          return;
        }
      } else {
        return;
      }
    }
    const fbList = editing.fallbacks.split(",").map((s) => s.trim()).filter(Boolean);
    const parsedMaxTokens = Number(editing.max_tokens);
    const parsedTemp = Number(editing.temperature);
    assignMut.mutate(
      {
        role: editing.role,
        provider: editing.provider,
        model: editing.model,
        endpoint: editing.endpoint,
        api_key_env: editing.api_key_env,
        max_tokens: parsedMaxTokens > 0 ? parsedMaxTokens : 8192,
        temperature: !isNaN(parsedTemp) && parsedTemp >= 0 ? parsedTemp : 0.1,
        fallbacks: fbList.length ? fbList : undefined,
      },
      { onSuccess: () => closeEditModal() },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Model Registry</h1>
          <p className="mt-1 text-sm text-gray-500">
            Assign a model to each pipeline role. Changes sync to LiteLLM automatically.
          </p>
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
            onClick={() => {
              if (
                !window.confirm(
                  "Re-seed from models.yaml? This clears and replaces model_deployments from the mounted file. " +
                    "Ongoing changes should be made in Registry (role assignments) instead.",
                )
              ) {
                return;
              }
              syncYaml.mutate();
            }}
            disabled={syncYaml.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <Download className="h-3.5 w-3.5" />
            {syncYaml.isPending ? "Seeding..." : "Seed from YAML"}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : roles.length === 0 ? (
        <EmptyState
          title="No roles configured"
          description="Bootstrap from models.yaml (one-time), then manage live assignments here or via PUT /api/v1/models/roles/{role}."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard label="Roles" value={roles.length} icon={Layers} />
            <MetricCard label="Assigned" value={assigned.length} icon={CheckCircle} />
            <MetricCard label="Unassigned" value={unassigned.length} icon={XCircle} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {roles.map((r) => {
              const Icon = r.assigned ? (SOURCE_ICON[r.provider] ?? Cloud) : XCircle;
              const shareKey = r.assigned ? `${r.provider}|${r.model}|${r.endpoint}` : "";
              const sharedRoles = shareKey ? sharedMap.get(shareKey) ?? [] : [];
              const isShared = sharedRoles.length > 1;

              return (
                <div
                  key={r.role}
                  className={`rounded-lg border p-4 transition ${
                    r.assigned
                      ? "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
                      : "border-dashed border-gray-300 bg-gray-50 dark:border-gray-600 dark:bg-gray-800/50"
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className={`h-4 w-4 ${r.assigned ? "text-green-500" : "text-gray-400"}`} />
                      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 capitalize">
                        {r.role}
                      </h3>
                      {isShared && (
                        <span className="flex items-center gap-0.5 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400" title={`Shared with ${sharedRoles.filter((x) => x !== r.role).join(", ")}`}>
                          <Link2 className="h-2.5 w-2.5" />
                          shared
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => setEditing(r.assigned ? editFromDeployment(r) : emptyEdit(r.role))}
                      className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-800"
                      title={r.assigned ? "Change model" : "Assign model"}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {r.assigned ? (
                    <div className="mt-3 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <ProviderBadge provider={r.provider} providers={providers} />
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLORS[r.status] || STATUS_COLORS.unknown}`}>
                          {r.status}
                        </span>
                      </div>
                      <p className="truncate text-xs text-gray-600 dark:text-gray-400" title={r.model}>
                        {r.model || "—"}
                      </p>
                      {r.endpoint && (
                        <p className="truncate text-[11px] text-gray-400" title={r.endpoint}>
                          {r.endpoint}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-gray-400">No model assigned</p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Pipeline Services</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Live reachability for model endpoints and ingestion microservices used by indexing.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(pipelineServices?.services ?? []).map((svc) => (
            <div key={svc.name} className="rounded border border-gray-200 p-2 dark:border-gray-700">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{svc.name}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    !svc.configured
                      ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      : svc.reachable
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                  }`}
                >
                  {!svc.configured ? "not set" : svc.reachable ? "ok" : "down"}
                </span>
              </div>
              <div className="mt-1 truncate text-[11px] text-gray-500 dark:text-gray-400" title={svc.url}>
                {svc.url || "—"}
              </div>
              <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                {svc.status_code ? `status ${svc.status_code}` : "no status"}
                {svc.latency_ms != null ? ` · ${svc.latency_ms}ms` : ""}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Edit / Assign modal */}
      {editing && (
        <EditModal
          editing={editing}
          setEditing={setEditing}
          providers={providers}
          configuredKeys={configuredKeys}
          roles={roles}
          assignMut={assignMut}
          deactivateMut={deactivateMut}
          onClose={closeEditModal}
          onSave={handleSave}
        />
      )}

      {/* Reconcile result toast */}
      {reconcileMut.isSuccess && reconcileMut.data && (
        <div className="fixed bottom-4 right-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 shadow-lg dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          Sync complete: {reconcileMut.data.added} added, {reconcileMut.data.removed} removed, {reconcileMut.data.unchanged} unchanged
        </div>
      )}
    </div>
  );
}

function ProviderBadge({ provider, providers }: { provider: string; providers: Record<string, ProviderInfo> }) {
  const info = providers[provider];
  const label = info?.label ?? provider;
  const isLocal = info?.is_local ?? false;
  const Icon = isLocal ? Server : Cloud;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
      isLocal
        ? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
        : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
    }`}>
      <Icon className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}

/* ----------------------------------------------------------------------- */
/* Model Explorer (appears inside the edit modal when provider supports it) */
/* ----------------------------------------------------------------------- */

function ModelExplorer({
  providerKey,
  onSelect,
}: {
  providerKey: string;
  onSelect: (model: DiscoveredModel) => void;
}) {
  const [search, setSearch] = useState("");
  const [bypassCache, setBypassCache] = useState(false);
  const { data, isLoading, isFetching } = useDiscoverModels(providerKey, bypassCache);

  const filtered = useMemo(() => {
    if (!data?.models) return [];
    const q = search.toLowerCase().trim();
    if (!q) return data.models.slice(0, 50);
    return data.models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    ).slice(0, 50);
  }, [data, search]);

  if (isLoading) {
    return <div className="animate-pulse rounded bg-gray-100 p-3 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">Loading models from provider...</div>;
  }

  if (data?.error) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        Discovery unavailable: {data.error}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${data?.count ?? 0} models...`}
            className="w-full rounded border border-gray-300 bg-white py-1.5 pl-7 pr-3 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          />
        </div>
        <button
          onClick={() => setBypassCache(true)}
          disabled={isFetching}
          className="rounded border border-gray-300 p-1.5 text-gray-400 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
          title="Refresh model list"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>
      {data?.cached && (
        <p className="text-[10px] text-gray-400">Cached result ({data.count} models)</p>
      )}
      <div className="max-h-40 overflow-y-auto rounded border border-gray-200 dark:border-gray-700">
        {filtered.length === 0 ? (
          <p className="px-3 py-2 text-xs text-gray-400">No models match "{search}"</p>
        ) : (
          filtered.map((m) => (
            <button
              key={m.id}
              onClick={() => onSelect(m)}
              className="flex w-full items-center justify-between gap-2 border-b border-gray-100 px-3 py-1.5 text-left text-xs hover:bg-blue-50 dark:border-gray-800 dark:hover:bg-blue-950/30 last:border-b-0"
            >
              <div className="min-w-0">
                <span className="block truncate font-medium text-gray-800 dark:text-gray-200">{m.id}</span>
                {m.context_window && (
                  <span className="text-[10px] text-gray-400">{(m.context_window / 1000).toFixed(0)}k ctx</span>
                )}
              </div>
              {m.pricing_input_per_million != null && (
                <span className="whitespace-nowrap text-[10px] text-gray-400">
                  ${m.pricing_input_per_million.toFixed(2)}/M in
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Edit / Assign Modal                                                      */
/* ----------------------------------------------------------------------- */

function EditModal({
  editing,
  setEditing,
  providers,
  configuredKeys,
  roles,
  assignMut,
  deactivateMut,
  onClose,
  onSave,
}: {
  editing: EditState;
  setEditing: (s: EditState) => void;
  providers: Record<string, ProviderInfo>;
  configuredKeys: Set<string>;
  roles: ModelDeployment[];
  assignMut: ReturnType<typeof useAssignRole>;
  deactivateMut: ReturnType<typeof useDeactivateRole>;
  onClose: () => void;
  onSave: () => void;
}) {
  const [showExplorer, setShowExplorer] = useState(false);
  const prov = providers[editing.provider];
  const supportsDiscovery = prov?.supports_discovery ?? false;

  // Fetch defaults whenever provider+model are set
  const selectedModel = editing.model.trim();
  const { data: defaults } = useProviderDefaults(
    editing.provider,
    selectedModel,
    null,
  );

  const handleSelectModel = (m: DiscoveredModel) => {
    setEditing({
      ...editing,
      model: m.id,
    });
    setShowExplorer(false);
  };

  const handleApplyDefaults = () => {
    if (!defaults) return;
    setEditing({
      ...editing,
      max_tokens: String(defaults.max_tokens),
      temperature: String(defaults.temperature),
    });
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const keyEnv = (editing.api_key_env || prov?.api_key_env || "").trim();
  const catalogKeyBlocked = !!keyEnv && editing.provider !== "custom" && !configuredKeys.has(keyEnv);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          {roles.find((r) => r.role === editing.role)?.assigned ? "Change" : "Assign"} Model — {editing.role}
        </h3>

        <div className="space-y-3">
          {catalogKeyBlocked && (
            <div className="flex gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs dark:border-amber-800 dark:bg-amber-950/30">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1 text-amber-900 dark:text-amber-200">
                <p className="font-medium">Set the provider key before saving</p>
                <p className="text-amber-800/95 dark:text-amber-300/95">
                  Configure <code className="rounded bg-amber-100/80 px-1 font-mono dark:bg-amber-900/50">{keyEnv}</code> under{" "}
                  <Link to="/settings/provider-keys" className="font-medium underline hover:text-amber-950 dark:hover:text-amber-100">
                    Settings → Provider API Keys
                  </Link>
                  . This dialog only maps roles to models; secrets stay in the cluster secret.
                </p>
              </div>
            </div>
          )}

          <ApiErrorBanner error={assignMut.error} />

          {/* Provider picklist */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Provider</label>
            <select
              value={editing.provider}
              onChange={(e) => {
                setEditing({ ...editing, provider: e.target.value, api_key_env: "", endpoint: "" });
                setShowExplorer(false);
              }}
              className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
            >
              {Object.entries(providers).map(([key, p]) => (
                <option key={key} value={key}>
                  {p.label}
                  {p.api_key_env ? (configuredKeys.has(p.api_key_env) ? " ✓" : " • key needed") : ""}
                </option>
              ))}
              {Object.keys(providers).length === 0 && (
                <>
                  <option value="openrouter">OpenRouter</option>
                  <option value="groq">Groq</option>
                  <option value="vllm">Local vLLM</option>
                  <option value="custom">Custom</option>
                </>
              )}
            </select>
          </div>

          {/* Model field with explorer toggle */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Model</label>
              {supportsDiscovery && (
                <button
                  onClick={() => setShowExplorer(!showExplorer)}
                  className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  <Search className="h-3 w-3" />
                  {showExplorer ? "Type manually" : "Browse models"}
                </button>
              )}
            </div>
            {showExplorer && supportsDiscovery ? (
              <ModelExplorer
                providerKey={editing.provider}
                onSelect={handleSelectModel}
              />
            ) : (
              <input
                type="text"
                value={editing.model}
                onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                placeholder={providers[editing.provider]?.placeholder ?? "model-name"}
                className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              />
            )}
            {editing.model && !showExplorer && supportsDiscovery && (
              <p className="mt-0.5 text-[10px] text-gray-400">Tip: use "Browse models" to pick a canonical model ID</p>
            )}
          </div>

          {(providers[editing.provider]?.needs_endpoint ?? (editing.provider === "vllm" || editing.provider === "kserve" || editing.provider === "custom" || editing.provider === "azure")) && (
            <Field
              label="Endpoint URL"
              value={editing.endpoint}
              onChange={(v) => setEditing({ ...editing, endpoint: v })}
              placeholder="http://model-service.namespace.svc:8080/v1"
            />
          )}

          {/* API key status */}
          {keyEnv && (
            <div className="rounded border px-3 py-2 text-xs border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
              <span className="text-gray-500 dark:text-gray-400">API Key: </span>
              <code className="font-mono text-gray-700 dark:text-gray-300">{keyEnv}</code>
              {configuredKeys.has(keyEnv) ? (
                <span className="ml-2 text-green-600 dark:text-green-400">(configured)</span>
              ) : (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  (not set —{" "}
                  <Link to="/settings/provider-keys" className="underline hover:text-amber-700 dark:hover:text-amber-300">
                    add in Provider API Keys
                  </Link>
                  )
                </span>
              )}
            </div>
          )}

          {editing.provider === "custom" && (
            <Field
              label="API Key Env Var (optional)"
              value={editing.api_key_env}
              onChange={(v) => setEditing({ ...editing, api_key_env: v })}
              placeholder="e.g. MY_PROVIDER_API_KEY"
            />
          )}

          {/* Defaults autofill */}
          {defaults && selectedModel && (
            <div className="flex items-center gap-2 rounded border border-blue-100 bg-blue-50 px-3 py-2 text-xs dark:border-blue-900 dark:bg-blue-950/30">
              <Wand2 className="h-3.5 w-3.5 text-blue-500" />
              <span className="text-blue-800 dark:text-blue-300">Recommended defaults available</span>
              <button
                onClick={handleApplyDefaults}
                className="ml-auto rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700"
              >
                Apply
              </button>
            </div>
          )}

          <Field
            label="Max Tokens"
            value={editing.max_tokens}
            onChange={(v) => setEditing({ ...editing, max_tokens: v })}
            onBlur={() => { if (!editing.max_tokens.trim() || Number(editing.max_tokens) <= 0) setEditing({ ...editing, max_tokens: "8192" }); }}
            type="number"
            hint="LiteLLM default — planner overrides per call with its own budget"
          />
          <Field
            label="Temperature"
            value={editing.temperature}
            onChange={(v) => setEditing({ ...editing, temperature: v })}
            onBlur={() => { const n = Number(editing.temperature); if (editing.temperature.trim() === "" || isNaN(n) || n < 0) setEditing({ ...editing, temperature: "0.1" }); }}
            type="number"
            hint="LiteLLM default — planner sets its own temps per node (0.1 planner, 0.3 writer)"
          />
          <Field
            label="Fallback Models"
            value={editing.fallbacks}
            onChange={(v) => setEditing({ ...editing, fallbacks: v })}
            placeholder="comma-separated served names"
          />

          <div className="flex items-center justify-between gap-2 pt-2">
            {roles.find((r) => r.role === editing.role)?.assigned && (
              <button
                onClick={() => {
                  deactivateMut.mutate(editing.role, { onSuccess: () => onClose() });
                }}
                disabled={deactivateMut.isPending}
                className="rounded px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
              >
                Deactivate
              </button>
            )}
            <div className="ml-auto flex gap-2">
              <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">
                Cancel
              </button>
              <button
                onClick={onSave}
                disabled={(() => {
                  const p = providers[editing.provider];
                  const env = (editing.api_key_env || p?.api_key_env || "").trim();
                  const needsConfiguredKey = !!env && editing.provider !== "custom";
                  const blocked = needsConfiguredKey && !configuredKeys.has(env);
                  return assignMut.isPending || !editing.model.trim() || blocked;
                })()}
                title={
                  (() => {
                    const p = providers[editing.provider];
                    const env = (editing.api_key_env || p?.api_key_env || "").trim();
                    if (env && editing.provider !== "custom" && !configuredKeys.has(env)) {
                      return "Configure this key under Settings → Provider API Keys first";
                    }
                    return undefined;
                  })()
                }
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {assignMut.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, onBlur, placeholder, type = "text", hint,
}: {
  label: string; value: string; onChange: (v: string) => void; onBlur?: () => void;
  placeholder?: string; type?: string; hint?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
      />
      {hint && <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{hint}</p>}
    </div>
  );
}
