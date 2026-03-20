import { useState } from "react";
import {
  useRoleAssignments,
  useAssignRole,
  useDeactivateRole,
  useSyncModelsFromYaml,
  useReconcileModels,
  useProviderKeys,
  useProviderCatalog,
} from "../../api/hooks";
import type { ModelDeployment, ProviderInfo } from "../../types";
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
} from "lucide-react";

const SOURCE_ICON: Record<string, typeof Cloud> = {
  openrouter: Cloud, groq: Cloud, together: Cloud, deepinfra: Cloud,
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
  max_tokens: number;
  temperature: number;
  fallbacks: string;
}

function emptyEdit(role: string): EditState {
  return { role, provider: "openrouter", model: "", endpoint: "", api_key_env: "", max_tokens: 8192, temperature: 0.1, fallbacks: "" };
}

function editFromDeployment(d: ModelDeployment): EditState {
  return {
    role: d.role,
    provider: d.provider || "custom",
    model: d.model,
    endpoint: d.endpoint,
    api_key_env: d.api_key_env || "",
    max_tokens: (d.litellm_params?.max_tokens as number) ?? 8192,
    temperature: (d.litellm_params?.temperature as number) ?? 0.1,
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

  const [editing, setEditing] = useState<EditState | null>(null);

  const providers = catalogData?.providers ?? {};
  const configuredKeys = new Set(
    (providerKeysData ?? []).filter((k: any) => k.configured).map((k: any) => k.name),
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

  const handleSave = () => {
    if (!editing) return;
    const fbList = editing.fallbacks.split(",").map((s) => s.trim()).filter(Boolean);
    assignMut.mutate(
      {
        role: editing.role,
        provider: editing.provider,
        model: editing.model,
        endpoint: editing.endpoint,
        api_key_env: editing.api_key_env,
        max_tokens: editing.max_tokens,
        temperature: editing.temperature,
        fallbacks: fbList.length ? fbList : undefined,
      },
      { onSuccess: () => setEditing(null) },
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
            onClick={() => syncYaml.mutate()}
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
        <EmptyState title="No roles configured" description="Seed from models.yaml to set up role assignments" />
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

      {/* Edit / Assign modal */}
      {editing && (
        <Modal onClose={() => setEditing(null)} title={`${roles.find((r) => r.role === editing.role)?.assigned ? "Change" : "Assign"} Model — ${editing.role}`}>
          <div className="space-y-3">
            {/* Provider picklist */}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Provider</label>
              <select
                value={editing.provider}
                onChange={(e) => setEditing({ ...editing, provider: e.target.value, api_key_env: "" })}
                className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              >
                {Object.entries(providers).map(([key, p]) => (
                  <option key={key} value={key}>
                    {p.label}
                    {p.api_key_env ? (configuredKeys.has(p.api_key_env) ? " ✓" : " • key needed") : ""}
                  </option>
                ))}
                {/* Fallback if catalog hasn't loaded */}
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

            <Field
              label="Model"
              value={editing.model}
              onChange={(v) => setEditing({ ...editing, model: v })}
              placeholder={providers[editing.provider]?.placeholder ?? "model-name"}
            />

            {(providers[editing.provider]?.needs_endpoint ?? (editing.provider === "vllm" || editing.provider === "kserve" || editing.provider === "custom" || editing.provider === "azure")) && (
              <Field
                label="Endpoint URL"
                value={editing.endpoint}
                onChange={(v) => setEditing({ ...editing, endpoint: v })}
                placeholder="http://model-service.namespace.svc:8080/v1"
              />
            )}

            {/* API key status */}
            {(() => {
              const prov = providers[editing.provider];
              const keyEnv = editing.api_key_env || prov?.api_key_env || "";
              if (!keyEnv) return null;
              const configured = configuredKeys.has(keyEnv);
              return (
                <div className="rounded border px-3 py-2 text-xs border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                  <span className="text-gray-500 dark:text-gray-400">API Key: </span>
                  <code className="font-mono text-gray-700 dark:text-gray-300">{keyEnv}</code>
                  {configured ? (
                    <span className="ml-2 text-green-600 dark:text-green-400">(configured)</span>
                  ) : (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">(not set — add in Settings &gt; Provider Keys)</span>
                  )}
                </div>
              );
            })()}

            {editing.provider === "custom" && (
              <Field
                label="API Key Env Var (optional)"
                value={editing.api_key_env}
                onChange={(v) => setEditing({ ...editing, api_key_env: v })}
                placeholder="e.g. MY_PROVIDER_API_KEY"
              />
            )}

            <Field
              label="Max Tokens"
              value={String(editing.max_tokens)}
              onChange={(v) => setEditing({ ...editing, max_tokens: Number(v) || 8192 })}
              type="number"
            />
            <Field
              label="Temperature"
              value={String(editing.temperature)}
              onChange={(v) => setEditing({ ...editing, temperature: Number(v) || 0.1 })}
              type="number"
            />
            <Field
              label="Fallback Models"
              value={editing.fallbacks}
              onChange={(v) => setEditing({ ...editing, fallbacks: v })}
              placeholder="comma-separated served names"
            />

            <div className="flex items-center justify-between gap-2 pt-2">
              {/* Deactivate button (only for already-assigned roles) */}
              {roles.find((r) => r.role === editing.role)?.assigned && (
                <button
                  onClick={() => {
                    deactivateMut.mutate(editing.role, { onSuccess: () => setEditing(null) });
                  }}
                  disabled={deactivateMut.isPending}
                  className="rounded px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                >
                  Deactivate
                </button>
              )}
              <div className="ml-auto flex gap-2">
                <button onClick={() => setEditing(null)} className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={assignMut.isPending || !editing.model}
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {assignMut.isPending ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Reconcile result toast */}
      {reconcileMut.isSuccess && reconcileMut.data && (
        <div className="fixed bottom-4 right-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 shadow-lg dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          Sync complete: {(reconcileMut.data as any).added} added, {(reconcileMut.data as any).removed} removed, {(reconcileMut.data as any).unchanged} unchanged
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
