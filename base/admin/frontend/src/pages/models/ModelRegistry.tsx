import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import {
  useRoleAssignments,
  useAssignRole,
  useDeactivateRole,
  useReconcileModels,
  useProviderGovernance,
  buildCatalogFromGovernance,
  usePipelineServices,
  useDiscoverModels,
  useProviderDefaults,
  useActiveCosts,
  useUpdateModelCost,
} from "../../api/hooks";
import type { ModelDeployment, ProviderInfo, DiscoveredModel, ActiveCostEntry } from "../../types";
import MetricCard from "../../components/common/MetricCard";
import EmptyState from "../../components/common/EmptyState";
import {
  Layers,
  CheckCircle,
  XCircle,
  Cloud,
  Server,
  Zap,
  Pencil,
  Link2,
  AlertTriangle,
  Search,
  Wand2,
  RefreshCw,
  DollarSign,
} from "lucide-react";

const SOURCE_ICON: Record<string, typeof Cloud> = {
  openrouter: Cloud, xai: Zap, groq: Cloud, together: Cloud, deepinfra: Cloud,
  dashscope: Cloud, "dashscope-us": Cloud,
  fireworks: Cloud, openai: Cloud, anthropic: Cloud, mistral: Cloud,
  azure: Cloud, vllm: Server, kserve: Server, custom: Cloud,
};

/** Whether the Assign/Change model dialog should show the OpenAI-compatible base URL field. */
function showEndpointUrlField(providerKey: string, p?: ProviderInfo): boolean {
  const hardcoded =
    providerKey === "vllm" ||
    providerKey === "kserve" ||
    providerKey === "custom" ||
    providerKey === "azure";
  // DashScope: always offer URL so operators can pick intl vs US or a proxy (defaults still apply if empty).
  if (providerKey === "dashscope" || providerKey === "dashscope-us") return true;
  if (!p) return hardcoded;
  if (p.needs_endpoint === true) return true;
  if (p.needs_endpoint === false) return false;
  // Custom providers from DB: show unless explicitly needs_endpoint=false
  if (p.is_custom === true && p.needs_endpoint !== false) return true;
  return hardcoded;
}

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
  top_p: string;
  top_k: string;
  min_p: string;
  presence_penalty: string;
  repetition_penalty: string;
  enable_thinking: "inherit" | "enabled" | "disabled";
  fallbacks: string;
  adapter_hint: string;
}

const ADAPTER_FAMILIES = [
  { value: "", label: "Auto-detect" },
  { value: "qwen3-coder", label: "Qwen3-Coder" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "kimi", label: "Kimi / Moonshot" },
  { value: "minimax", label: "MiniMax" },
  { value: "generic", label: "Generic OpenAI" },
] as const;

const QWEN_CODING_PRESET: Pick<
  EditState,
  "temperature" | "top_p" | "top_k" | "min_p" | "presence_penalty" | "repetition_penalty" | "enable_thinking"
> = {
  temperature: "0.6",
  top_p: "0.95",
  top_k: "20",
  min_p: "0.0",
  presence_penalty: "0.0",
  repetition_penalty: "1.0",
  enable_thinking: "enabled",
};

function emptyEdit(role: string): EditState {
  return {
    role,
    provider: "openrouter",
    model: "",
    endpoint: "",
    api_key_env: "",
    max_tokens: "8192",
    temperature: "0.1",
    top_p: "",
    top_k: "",
    min_p: "",
    presence_penalty: "",
    repetition_penalty: "",
    enable_thinking: "inherit",
    fallbacks: "",
    adapter_hint: "",
  };
}

function editFromDeployment(d: ModelDeployment): EditState {
  const lp = d.litellm_params ?? {};
  const mt = (lp.max_tokens as number) ?? 8192;
  const temp = (lp.temperature as number) ?? 0.1;
  const enableThinkingRaw = lp.enable_thinking;
  return {
    role: d.role,
    provider: d.provider || "custom",
    model: d.model,
    endpoint: d.endpoint,
    api_key_env: d.api_key_env || "",
    max_tokens: String(mt),
    temperature: String(temp),
    top_p: lp.top_p != null ? String(lp.top_p) : "",
    top_k: lp.top_k != null ? String(lp.top_k) : "",
    min_p: lp.min_p != null ? String(lp.min_p) : "",
    presence_penalty: lp.presence_penalty != null ? String(lp.presence_penalty) : "",
    repetition_penalty: lp.repetition_penalty != null ? String(lp.repetition_penalty) : "",
    enable_thinking:
      typeof enableThinkingRaw === "boolean"
        ? (enableThinkingRaw ? "enabled" : "disabled")
        : "inherit",
    fallbacks: (d.fallbacks ?? []).join(", "),
    adapter_hint: d.adapter_hint ?? "",
  };
}

/** Pre-fill endpoint from Models → Providers default when DB row is empty but catalog has a URL. */
function mergeEditEndpointFromProvider(
  state: EditState,
  providers: Record<string, ProviderInfo>,
): EditState {
  if ((state.endpoint ?? "").trim()) return state;
  const def = (providers[state.provider]?.default_endpoint ?? "").trim();
  if (!def) return state;
  return { ...state, endpoint: def };
}

function applyQwenCodingPreset(state: EditState): EditState {
  return {
    ...state,
    ...QWEN_CODING_PRESET,
  };
}

function resetInheritedGenerationOverrides(state: EditState): EditState {
  return {
    ...state,
    top_p: "",
    top_k: "",
    min_p: "",
    presence_penalty: "",
    repetition_penalty: "",
    enable_thinking: "inherit",
  };
}

function parseOptionalFloat(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function parseOptionalInt(value: string): number | undefined {
  const parsed = parseOptionalFloat(value);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) return undefined;
  return parsed;
}

export default function ModelRegistry() {
  const { data, isLoading } = useRoleAssignments();
  const assignMut = useAssignRole();
  const deactivateMut = useDeactivateRole();
  const reconcileMut = useReconcileModels();
  const { data: costsData } = useActiveCosts();
  const costByRole = useMemo(() => {
    const m = new Map<string, ActiveCostEntry>();
    for (const c of costsData?.roles ?? []) m.set(c.role, c);
    return m;
  }, [costsData]);

  const { data: govData } = useProviderGovernance();
  const catalogData = useMemo(
    () => (govData ? buildCatalogFromGovernance(govData) : undefined),
    [govData],
  );
  const configuredKeys = useMemo(
    () =>
      new Set(
        (govData?.provider_secret_keys ?? [])
          .filter((k) => k.configured)
          .map((k) => k.name),
      ),
    [govData?.provider_secret_keys],
  );
  const { data: pipelineServices } = usePipelineServices();

  const [editing, setEditing] = useState<EditState | null>(null);

  const providers = catalogData?.providers ?? {};

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
            "This API key env var is not set under Models → Providers → Provider API keys. LiteLLM will fail until the key exists in the cluster secret. Continue saving?",
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
    const parsedTopP = parseOptionalFloat(editing.top_p);
    const parsedTopK = parseOptionalInt(editing.top_k);
    const parsedMinP = parseOptionalFloat(editing.min_p);
    const parsedPresencePenalty = parseOptionalFloat(editing.presence_penalty);
    const parsedRepetitionPenalty = parseOptionalFloat(editing.repetition_penalty);
    const parsedEnableThinking =
      editing.enable_thinking === "inherit"
        ? undefined
        : editing.enable_thinking === "enabled";
    const defEp = (prov?.default_endpoint ?? "").trim();
    const ep = (editing.endpoint ?? "").trim();
    const endpointForApi = defEp && ep === defEp ? "" : ep;
    assignMut.mutate(
      {
        role: editing.role,
        provider: editing.provider,
        model: editing.model,
        endpoint: endpointForApi,
        api_key_env: editing.api_key_env,
        max_tokens: parsedMaxTokens > 0 ? parsedMaxTokens : 8192,
        temperature: !isNaN(parsedTemp) && parsedTemp >= 0 ? parsedTemp : 0.1,
        top_p: parsedTopP != null && parsedTopP >= 0 && parsedTopP <= 1 ? parsedTopP : undefined,
        top_k: parsedTopK != null && parsedTopK >= 0 ? parsedTopK : undefined,
        min_p: parsedMinP != null && parsedMinP >= 0 && parsedMinP <= 1 ? parsedMinP : undefined,
        presence_penalty: parsedPresencePenalty,
        repetition_penalty:
          parsedRepetitionPenalty != null && parsedRepetitionPenalty >= 0
            ? parsedRepetitionPenalty
            : undefined,
        enable_thinking: parsedEnableThinking,
        fallbacks: fbList.length ? fbList : undefined,
        adapter_hint: editing.adapter_hint || null,
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
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : roles.length === 0 ? (
        <EmptyState
          title="No roles configured"
          description="No active role assignments yet. Configure providers and assign roles here or via PUT /api/v1/models/roles/{role}."
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
                      onClick={() =>
                        setEditing(
                          r.assigned
                            ? mergeEditEndpointFromProvider(editFromDeployment(r), providers)
                            : emptyEdit(r.role),
                        )
                      }
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
                      <RateCardBadge cost={costByRole.get(r.role)} />
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
          cost={costByRole.get(editing.role)}
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

const PRICING_SOURCE_STYLES: Record<string, { bg: string; label: string }> = {
  manual: { bg: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400", label: "set" },
  litellm: { bg: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400", label: "litellm" },
  bundled: { bg: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400", label: "bundled" },
  infra_calc: { bg: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400", label: "infra" },
  fallback_base: { bg: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400", label: "fallback" },
  unknown: { bg: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400", label: "unknown" },
};

function fmtRate(v: number): string {
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function RateCardBadge({ cost }: { cost?: ActiveCostEntry }) {
  if (!cost) return null;
  const src = cost.pricing_source ?? "unknown";
  const style = PRICING_SOURCE_STYLES[src] ?? PRICING_SOURCE_STYLES.unknown;
  const isFallback = src === "fallback_base";
  return (
    <div className={`mt-2 rounded border px-2 py-1.5 ${isFallback ? "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20" : "border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/50"}`}>
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          <DollarSign className="h-3 w-3 text-gray-400" />
          <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400">Rate Card</span>
        </div>
        <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${style.bg}`}>
          {style.label}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-1 text-[10px]">
        <div>
          <span className="text-gray-400">in</span>{" "}
          <span className={`font-mono font-medium ${isFallback ? "text-amber-700 dark:text-amber-400" : "text-gray-700 dark:text-gray-300"}`}>
            {fmtRate(cost.input_per_million)}
          </span>
        </div>
        <div>
          <span className="text-gray-400">out</span>{" "}
          <span className={`font-mono font-medium ${isFallback ? "text-amber-700 dark:text-amber-400" : "text-gray-700 dark:text-gray-300"}`}>
            {fmtRate(cost.output_per_million)}
          </span>
        </div>
        <div>
          <span className="text-gray-400">cache</span>{" "}
          <span className="font-mono font-medium text-gray-700 dark:text-gray-300">
            {cost.input_cached_per_million != null ? fmtRate(cost.input_cached_per_million) : "—"}
          </span>
        </div>
      </div>
      {isFallback && (
        <p className="mt-1 text-[9px] text-amber-600 dark:text-amber-400">
          Using fallback rates — click edit to set real pricing
        </p>
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
  cost,
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
  cost?: ActiveCostEntry;
}) {
  const [showExplorer, setShowExplorer] = useState(false);
  const updateCostMut = useUpdateModelCost();
  const [pricingEdit, setPricingEdit] = useState<{
    input_per_million: string;
    output_per_million: string;
    input_cached_per_million: string;
  }>({
    input_per_million: cost?.input_per_million?.toString() ?? "",
    output_per_million: cost?.output_per_million?.toString() ?? "",
    input_cached_per_million: cost?.input_cached_per_million?.toString() ?? "",
  });
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

  const providerOptions = useMemo(
    () => Object.entries(providers).sort(([, a], [, b]) => a.label.localeCompare(b.label)),
    [providers],
  );

  const keyEnv = (editing.api_key_env || prov?.api_key_env || "").trim();
  const catalogKeyBlocked = !!keyEnv && editing.provider !== "custom" && !configuredKeys.has(keyEnv);
  const hasAdvancedGenerationOverrides = Boolean(
    editing.top_p.trim()
    || editing.top_k.trim()
    || editing.min_p.trim()
    || editing.presence_penalty.trim()
    || editing.repetition_penalty.trim()
    || editing.enable_thinking !== "inherit",
  );

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
                  <Link
                    to="/models/providers#provider-api-keys"
                    className="font-medium underline hover:text-amber-950 dark:hover:text-amber-100"
                  >
                    Models → Providers → API keys
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
                const next = e.target.value;
                const def = providers[next]?.default_endpoint ?? "";
                setEditing({
                  ...editing,
                  provider: next,
                  api_key_env: "",
                  endpoint: def,
                });
                setShowExplorer(false);
              }}
              className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
            >
              {providerOptions.map(([key, p]) => (
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

          {showEndpointUrlField(editing.provider, providers[editing.provider]) && (
            <Field
              label="Endpoint URL (OpenAI-compatible base)"
              value={editing.endpoint}
              onChange={(v) => setEditing({ ...editing, endpoint: v })}
              placeholder={
                editing.provider === "dashscope"
                  ? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
                  : editing.provider === "dashscope-us"
                    ? "https://dashscope-us.aliyuncs.com/compatible-mode/v1"
                    : "http://model-service.namespace.svc:8080/v1"
              }
              hint={
                (prov?.default_endpoint ?? "").trim()
                  ? "Pre-filled from Models → Providers (same as the provider default). Clear the field to inherit that default from settings, or override here only for this role."
                  : "Leave blank to use the static catalog default or the URL you set under Models → Providers. Required for vLLM, KServe, and Custom."
              }
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
                  <Link
                    to="/models/providers#provider-api-keys"
                    className="underline hover:text-amber-700 dark:hover:text-amber-300"
                  >
                    add under Models → Providers
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

          <details
            className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50"
            open={hasAdvancedGenerationOverrides || undefined}
          >
            <summary className="cursor-pointer select-none text-xs font-semibold text-gray-700 dark:text-gray-300">
              Advanced generation settings
            </summary>
            <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
              Used as model defaults when request-level params are absent. Empty optional fields inherit runtime defaults.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing(applyQwenCodingPreset(editing))}
                className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-700"
              >
                Apply Qwen Coding Preset
              </button>
              <button
                type="button"
                onClick={() => setEditing(resetInheritedGenerationOverrides(editing))}
                className="rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Reset to inherited defaults
              </button>
              <span className="text-[10px] text-gray-500 dark:text-gray-400">
                qwen3.6-35b-a3b: temp 0.6, top_p 0.95, top_k 20, thinking enabled
              </span>
            </div>
            <div className="mt-3 space-y-3">
              <Field
                label="Max Tokens"
                value={editing.max_tokens}
                onChange={(v) => setEditing({ ...editing, max_tokens: v })}
                onBlur={() => { if (!editing.max_tokens.trim() || Number(editing.max_tokens) <= 0) setEditing({ ...editing, max_tokens: "8192" }); }}
                type="number"
                hint="LiteLLM default — Chat service may still enforce per-request budget caps"
              />
              <Field
                label="Temperature"
                value={editing.temperature}
                onChange={(v) => setEditing({ ...editing, temperature: v })}
                onBlur={() => { const n = Number(editing.temperature); if (editing.temperature.trim() === "" || isNaN(n) || n < 0) setEditing({ ...editing, temperature: "0.1" }); }}
                type="number"
                hint="Used when callers do not send temperature"
              />
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="Top P"
                  value={editing.top_p}
                  onChange={(v) => setEditing({ ...editing, top_p: v })}
                  type="number"
                  hint="0..1"
                />
                <Field
                  label="Top K"
                  value={editing.top_k}
                  onChange={(v) => setEditing({ ...editing, top_k: v })}
                  type="number"
                  hint="integer"
                />
                <Field
                  label="Min P"
                  value={editing.min_p}
                  onChange={(v) => setEditing({ ...editing, min_p: v })}
                  type="number"
                  hint="0..1"
                />
                <Field
                  label="Presence Penalty"
                  value={editing.presence_penalty}
                  onChange={(v) => setEditing({ ...editing, presence_penalty: v })}
                  type="number"
                />
                <Field
                  label="Repetition Penalty"
                  value={editing.repetition_penalty}
                  onChange={(v) => setEditing({ ...editing, repetition_penalty: v })}
                  type="number"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Thinking Mode
                </label>
                <select
                  value={editing.enable_thinking}
                  onChange={(e) => setEditing({ ...editing, enable_thinking: e.target.value as EditState["enable_thinking"] })}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                >
                  <option value="inherit">Inherit runtime default</option>
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
                <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                  Maps to <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-gray-800">enable_thinking</code> for compatible OpenAI-style providers.
                </p>
              </div>
            </div>
          </details>
          {/* Rate Card / Pricing */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5 text-gray-500" />
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                  Rate Card
                </span>
                <span className="text-[10px] text-gray-400">(USD per 1M tokens)</span>
              </div>
              {cost && (
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${(PRICING_SOURCE_STYLES[cost.pricing_source ?? "unknown"] ?? PRICING_SOURCE_STYLES.unknown).bg}`}>
                  {(PRICING_SOURCE_STYLES[cost.pricing_source ?? "unknown"] ?? PRICING_SOURCE_STYLES.unknown).label}
                </span>
              )}
            </div>
            {cost?.pricing_source === "fallback_base" && (
              <div className="mb-2 flex items-start gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>Using fallback rates ($1.00/$5.00) — costs are over-reported. Set real provider rates below.</span>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="mb-0.5 block text-[10px] font-medium text-gray-500 dark:text-gray-400">Input</label>
                <input
                  type="number"
                  step="0.001"
                  value={pricingEdit.input_per_million}
                  onChange={(e) => setPricingEdit({ ...pricingEdit, input_per_million: e.target.value })}
                  placeholder="0.40"
                  className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs tabular-nums dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-0.5 block text-[10px] font-medium text-gray-500 dark:text-gray-400">Output</label>
                <input
                  type="number"
                  step="0.001"
                  value={pricingEdit.output_per_million}
                  onChange={(e) => setPricingEdit({ ...pricingEdit, output_per_million: e.target.value })}
                  placeholder="2.40"
                  className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs tabular-nums dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="mb-0.5 block text-[10px] font-medium text-gray-500 dark:text-gray-400">Cached In</label>
                <input
                  type="number"
                  step="0.001"
                  value={pricingEdit.input_cached_per_million}
                  onChange={(e) => setPricingEdit({ ...pricingEdit, input_cached_per_million: e.target.value })}
                  placeholder="auto"
                  className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs tabular-nums dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
            </div>
            <p className="mt-1.5 text-[10px] text-gray-400 dark:text-gray-500">
              Cached rate defaults to 10% of input if blank. Saved independently from model assignment.
            </p>
            <button
              type="button"
              onClick={() => {
                const inp = parseFloat(pricingEdit.input_per_million);
                const out = parseFloat(pricingEdit.output_per_million);
                const cached = pricingEdit.input_cached_per_million.trim()
                  ? parseFloat(pricingEdit.input_cached_per_million)
                  : null;
                if (isNaN(inp) || isNaN(out) || inp < 0 || out < 0) return;
                updateCostMut.mutate({
                  role: editing.role,
                  input_per_million: inp,
                  output_per_million: out,
                  input_cached_per_million: cached,
                });
              }}
              disabled={updateCostMut.isPending}
              className="mt-2 w-full rounded bg-gray-200 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            >
              {updateCostMut.isPending ? "Saving rates..." : updateCostMut.isSuccess ? "Rates saved" : "Save Rate Card"}
            </button>
          </div>

          <Field
            label="Fallback Models"
            value={editing.fallbacks}
            onChange={(v) => setEditing({ ...editing, fallbacks: v })}
            placeholder="comma-separated served names"
          />

          {/* Adapter / Shim override */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Adapter Hint</label>
            <select
              value={editing.adapter_hint}
              onChange={(e) => setEditing({ ...editing, adapter_hint: e.target.value })}
              className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
            >
              {ADAPTER_FAMILIES.map((af) => (
                <option key={af.value} value={af.value}>{af.label}</option>
              ))}
            </select>
            <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
              Override model-family detection for tool prompts and behavior shims. Auto-detect infers from the model name.
            </p>
          </div>

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
                      return "Configure this key under Models → Providers → Provider API keys first";
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
