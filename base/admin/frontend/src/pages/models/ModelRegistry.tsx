import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { ApiErrorBanner } from "../../components/common/ApiErrorBanner";
import {
  useRoleAssignments,
  useAssignRole,
  useDeactivateRole,
  useProviderGovernance,
  buildCatalogFromGovernance,
  useDiscoverModels,
  useProviderDefaults,
  useActiveCosts,
  useUpdateModelCost,
  usePublicOfferings,
  useCreatePublicOffering,
  usePatchPublicOffering,
  useDeletePublicOffering,
  type PublicModelOffering,
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
  Pencil,
  Link2,
  AlertTriangle,
  Search,
  Wand2,
  RefreshCw,
  DollarSign,
  Plus,
} from "lucide-react";

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

/** Which coder-* deployment row supplies base URL / API keys for an extra public model name. */
const ROUTE_VIA_OPTIONS = [
  { value: "coder-pulse", short: "Coder Pulse" },
  { value: "coder-core", short: "Coder Core" },
  { value: "coder-horizon", short: "Coder Horizon" },
] as const;

function routeViaLabel(role: string | null | undefined, effortFallback: string): string {
  const r = (role ?? "").trim().toLowerCase();
  const found = ROUTE_VIA_OPTIONS.find((o) => o.value === r);
  if (found) return found.short;
  return `Coder ${effortFallback}`;
}

/** Display order for the canonical mapping table (remaining roles sort alphabetically after). */
const CANONICAL_ROLE_ORDER = [
  "coder-pulse",
  "coder-core",
  "coder-horizon",
  "general-pulse",
  "general-core",
  "general-horizon",
  "router",
  "general",
  "critic",
  "coder-compaction",
  "summarizer",
] as const;

const ROLE_ROW_TITLE: Partial<Record<string, string>> = {
  "coder-pulse": "Yarn / IDE — fast tier",
  "coder-core": "Yarn / IDE — default tier",
  "coder-horizon": "Yarn / IDE — deep tier",
  "general-pulse": "Chat — fast effort tier",
  "general-core": "Chat — default effort tier",
  "general-horizon": "Chat — deep effort tier",
};

function sortRolesForCanonicalTable(a: ModelDeployment, b: ModelDeployment): number {
  const idx = (role: string) => {
    const i = (CANONICAL_ROLE_ORDER as readonly string[]).indexOf(role);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const d = idx(a.role) - idx(b.role);
  if (d !== 0) return d;
  return a.role.localeCompare(b.role);
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

type PublicOfferingPatch = {
  id: number;
} & Partial<{
  client_model_id: string;
  label: string | null;
  effort_tier: string;
  route_via_role: string | null;
  backend_model_override: string | null;
  expose_planner: boolean;
  expose_yarn: boolean;
  is_active: boolean;
}>;

function ExtraPublicOfferingCard({
  o,
  roles,
  onPatch,
  onDelete,
}: {
  o: PublicModelOffering;
  roles: ModelDeployment[];
  onPatch: (patch: PublicOfferingPatch) => void;
  onDelete: (id: number) => void;
}) {
  const [label, setLabel] = useState(() => o.label ?? "");
  const [wire, setWire] = useState(() => o.backend_model_override ?? "");

  useEffect(() => {
    setLabel(o.label ?? "");
    setWire(o.backend_model_override ?? "");
  }, [o.id, o.label, o.backend_model_override, o.updated_at]);

  const routeKey = (o.route_via_role ?? `coder-${o.effort_tier}`).trim();
  const dep = roles.find((r) => r.role === routeKey);

  const commitLabel = () => {
    const next = label.trim();
    const cur = (o.label ?? "").trim();
    if (next === cur) return;
    onPatch({ id: o.id, label: next === "" ? null : next });
  };

  const commitWire = () => {
    const next = wire.trim();
    const cur = (o.backend_model_override ?? "").trim();
    if (next === cur) return;
    onPatch({ id: o.id, backend_model_override: next === "" ? null : next });
  };

  const effectiveWire = wire.trim() || dep?.model?.trim() || "—";

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/30 p-3 dark:border-violet-900/40 dark:bg-violet-950/20">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Wand2 className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
          <div className="min-w-0">
            <h3 className="font-mono text-sm font-semibold text-gray-900 dark:text-white">{o.client_model_id}</h3>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Remove model “${o.client_model_id}”?`)) {
              onDelete(o.id);
            }
          }}
          className="shrink-0 text-xs text-red-600 hover:underline dark:text-red-400"
        >
          Remove
        </button>
      </div>

      <label className="mt-2 block text-[11px] text-gray-500 dark:text-gray-400">
        Label (shown in UIs)
        <input
          className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="Optional display name"
        />
      </label>

      <label className="mt-2 block text-[11px] text-gray-500 dark:text-gray-400">
        Wire model / LiteLLM id
        <input
          className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-gray-600 dark:bg-gray-800"
          value={wire}
          onChange={(e) => setWire(e.target.value)}
          onBlur={commitWire}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder={dep?.model ? `Leave blank to use ${dep.model}` : "Optional override"}
        />
      </label>
      <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
        Effective wire: <span className="font-mono text-gray-700 dark:text-gray-300">{effectiveWire}</span>
      </p>

      <label className="mt-2 block text-[11px] text-gray-500 dark:text-gray-400">
        Connection
        <select
          className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
          value={routeKey}
          onChange={(e) =>
            onPatch({
              id: o.id,
              route_via_role: e.target.value,
            })
          }
        >
          {ROUTE_VIA_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.short}
            </option>
          ))}
        </select>
      </label>
      {dep?.assigned ? (
        <p className="mt-1 truncate text-[10px] text-gray-500" title={dep.endpoint || ""}>
          {routeViaLabel(o.route_via_role, o.effort_tier)} → {dep.provider} · {dep.endpoint || "default URL"}
        </p>
      ) : (
        <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">
          Assign {routeViaLabel(o.route_via_role, o.effort_tier)} in the cards above so this model can route.
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-3 border-t border-violet-100 pt-2 text-[11px] dark:border-violet-900/30">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={o.expose_planner}
            onChange={(e) => onPatch({ id: o.id, expose_planner: e.target.checked })}
          />
          Planner
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={o.expose_yarn}
            onChange={(e) => onPatch({ id: o.id, expose_yarn: e.target.checked })}
          />
          Yarn
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={o.is_active}
            onChange={(e) => onPatch({ id: o.id, is_active: e.target.checked })}
          />
          Active
        </label>
      </div>
    </div>
  );
}

export default function ModelRegistry() {
  const { data, isLoading } = useRoleAssignments();
  const assignMut = useAssignRole();
  const deactivateMut = useDeactivateRole();
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
  const { data: publicOfferingsData, isLoading: publicOfferingsLoading } = usePublicOfferings();
  const createOfferingMut = useCreatePublicOffering();
  const patchOfferingMut = usePatchPublicOffering();
  const deleteOfferingMut = useDeletePublicOffering();
  const [newOffering, setNewOffering] = useState({
    client_model_id: "",
    label: "",
    route_via_role: "coder-core" as (typeof ROUTE_VIA_OPTIONS)[number]["value"],
    backend_model_override: "",
    expose_planner: true,
    expose_yarn: true,
  });

  const [editing, setEditing] = useState<EditState | null>(null);

  const providers = catalogData?.providers ?? {};

  const roles: ModelDeployment[] = data?.roles ?? [];
  const assigned = roles.filter((r) => r.assigned);
  const unassigned = roles.filter((r) => !r.assigned);

  const sortedRoles = useMemo(() => [...roles].sort(sortRolesForCanonicalTable), [roles]);

  // Same provider + model + endpoint → multiple roles can share one upstream deployment.
  const sharedMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of roles) {
      if (!r.assigned) continue;
      const key = `${r.provider}|${r.model}|${r.endpoint}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r.role);
    }
    return m;
  }, [roles]);

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
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Model Registry</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          The <strong>canonical mapping</strong> table is one row per internal role (e.g.{" "}
          <span className="font-mono text-xs">general-core</span>, <span className="font-mono text-xs">coder-pulse</span>
          ). Multiple roles can point at the same provider/model — you do not need a separate physical deployment per
          role. Extra client-visible model names below add aliases (e.g. for Open WebUI) without renaming those roles.
        </p>
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

          <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Canonical mapping</h2>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Each role is how Yarn, Planner, and LiteLLM identify a slot. Assign the same upstream model to several
                roles when it should serve more than one slot.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-800/80 dark:text-gray-400">
                    <th className="px-3 py-2">Role</th>
                    <th className="px-3 py-2">Provider</th>
                    <th className="px-3 py-2">Model</th>
                    <th className="hidden px-3 py-2 md:table-cell">Endpoint</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="hidden px-3 py-2 lg:table-cell">Also mapped</th>
                    <th className="px-3 py-2 text-right"> </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRoles.map((r) => {
                    const shareKey = r.assigned ? `${r.provider}|${r.model}|${r.endpoint}` : "";
                    const sharedRoles = shareKey ? sharedMap.get(shareKey) ?? [] : [];
                    const coRoles = sharedRoles.filter((x) => x !== r.role);
                    const hint = ROLE_ROW_TITLE[r.role];
                    return (
                      <tr
                        key={r.role}
                        className={`border-b border-gray-100 dark:border-gray-800 ${
                          r.assigned ? "" : "bg-gray-50/80 dark:bg-gray-800/30"
                        }`}
                      >
                        <td className="max-w-[140px] px-3 py-2 align-top">
                          <span
                            className="font-mono text-[11px] font-semibold text-gray-900 dark:text-white"
                            title={hint ?? r.role}
                          >
                            {r.role}
                          </span>
                          {hint && (
                            <span className="mt-0.5 block text-[10px] leading-snug text-gray-500 dark:text-gray-400">
                              {hint}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          {r.assigned ? (
                            <ProviderBadge provider={r.provider} providers={providers} />
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="max-w-[180px] px-3 py-2 align-top">
                          {r.assigned ? (
                            <span className="break-all font-mono text-[11px] text-gray-800 dark:text-gray-200" title={r.model}>
                              {r.model || "—"}
                            </span>
                          ) : (
                            <span className="text-gray-400">Unassigned</span>
                          )}
                        </td>
                        <td className="hidden max-w-[200px] px-3 py-2 align-top md:table-cell">
                          {r.endpoint ? (
                            <span className="block truncate text-[11px] text-gray-500 dark:text-gray-400" title={r.endpoint}>
                              {r.endpoint}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          {r.assigned ? (
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLORS[r.status] || STATUS_COLORS.unknown}`}
                            >
                              {r.status}
                            </span>
                          ) : (
                            <span className="text-[10px] text-gray-400">—</span>
                          )}
                        </td>
                        <td className="hidden px-3 py-2 align-top lg:table-cell">
                          {coRoles.length > 0 ? (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] text-blue-700 dark:text-blue-400"
                              title={`Same deployment as: ${coRoles.join(", ")}`}
                            >
                              <Link2 className="h-3 w-3 shrink-0" />
                              <span className="font-mono">{coRoles.join(", ")}</span>
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right align-top">
                          <button
                            type="button"
                            onClick={() =>
                              setEditing(
                                r.assigned
                                  ? mergeEditEndpointFromProvider(editFromDeployment(r), providers)
                                  : emptyEdit(r.role),
                              )
                            }
                            className="inline-flex rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-800"
                            title={r.assigned ? "Change model" : "Assign model"}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Extra model names</h2>
            <p className="mt-1 max-w-3xl text-xs text-gray-500 dark:text-gray-400">
              Add additional <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">model</code> strings clients can
              select (e.g. <span className="font-mono">kimi</span>, <span className="font-mono">minimax</span>). Each
              entry uses the <strong>wire model</strong> you set (or the deployment’s model if left blank) and inherits
              <strong> base URL and API keys</strong> from one of the coder assignments above — without renaming
              pulse/core/horizon themselves.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-dashed border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-900/50 dark:bg-indigo-950/20">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-indigo-900 dark:text-indigo-200">
            <Plus className="h-3.5 w-3.5" />
            Add model (platform admin)
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <input
              className="rounded border border-gray-300 px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-800"
              placeholder="Model id (e.g. kimi, qwen-pro)"
              value={newOffering.client_model_id}
              onChange={(e) => setNewOffering({ ...newOffering, client_model_id: e.target.value })}
            />
            <input
              className="rounded border border-gray-300 px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-800"
              placeholder="Label (shown in UIs)"
              value={newOffering.label}
              onChange={(e) => setNewOffering({ ...newOffering, label: e.target.value })}
            />
            <input
              className="rounded border border-gray-300 px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-800"
              placeholder="Wire model / LiteLLM id (optional if same as deployment)"
              value={newOffering.backend_model_override}
              onChange={(e) => setNewOffering({ ...newOffering, backend_model_override: e.target.value })}
            />
          </div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
              <span className="shrink-0">Use connection from</span>
              <select
                className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                value={newOffering.route_via_role}
                onChange={(e) =>
                  setNewOffering({
                    ...newOffering,
                    route_via_role: e.target.value as (typeof ROUTE_VIA_OPTIONS)[number]["value"],
                  })
                }
              >
                {ROUTE_VIA_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.short} deployment
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={newOffering.expose_planner}
                onChange={(e) => setNewOffering({ ...newOffering, expose_planner: e.target.checked })}
              />
              Planner / chat
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={newOffering.expose_yarn}
                onChange={(e) => setNewOffering({ ...newOffering, expose_yarn: e.target.checked })}
              />
              Yarn / coder
            </label>
            <button
              type="button"
              disabled={createOfferingMut.isPending || !newOffering.client_model_id.trim()}
              onClick={() => {
                createOfferingMut.mutate(
                  {
                    client_model_id: newOffering.client_model_id.trim(),
                    label: newOffering.label.trim() || null,
                    route_via_role: newOffering.route_via_role,
                    backend_model_override: newOffering.backend_model_override.trim() || null,
                    expose_planner: newOffering.expose_planner,
                    expose_yarn: newOffering.expose_yarn,
                  },
                  {
                    onSuccess: () =>
                      setNewOffering({
                        client_model_id: "",
                        label: "",
                        route_via_role: "coder-core",
                        backend_model_override: "",
                        expose_planner: true,
                        expose_yarn: true,
                      }),
                  },
                );
              }}
              className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50 sm:ml-auto"
            >
              {createOfferingMut.isPending ? "Adding…" : "Add model"}
            </button>
          </div>
          {createOfferingMut.isError && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              {(createOfferingMut.error as Error)?.message ?? "Create failed"}
            </p>
          )}
        </div>

        {publicOfferingsLoading ? (
          <div className="mt-4 h-28 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
        ) : (publicOfferingsData?.offerings ?? []).length === 0 ? (
          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">No extra model names yet.</p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(publicOfferingsData?.offerings ?? []).map((o: PublicModelOffering) => (
              <ExtraPublicOfferingCard
                key={o.id}
                o={o}
                roles={roles}
                onPatch={(patch) => patchOfferingMut.mutate(patch)}
                onDelete={(id) => deleteOfferingMut.mutate(id)}
              />
            ))}
          </div>
        )}
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
