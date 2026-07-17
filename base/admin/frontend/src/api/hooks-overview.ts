import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import client from "./client";
import type {
  DashboardSummary,
  ModelCost,
} from "../types";

type GetConfig = Parameters<typeof client.get>[1];
type WriteConfig = Parameters<typeof client.post>[2];

function unwrap<T>(request: Promise<{ data: T }>): Promise<T> {
  return request.then((r) => r.data);
}

function apiGet<T>(url: string, config?: GetConfig) {
  return unwrap(client.get<T>(url, config));
}

function apiPost<T>(url: string, data?: unknown, config?: WriteConfig) {
  return unwrap(client.post<T>(url, data, config));
}

function apiPut<T>(url: string, data?: unknown, config?: WriteConfig) {
  return unwrap(client.put<T>(url, data, config));
}

function apiPatch<T>(url: string, data?: unknown, config?: WriteConfig) {
  return unwrap(client.patch<T>(url, data, config));
}

function apiDelete<T>(url: string, config?: GetConfig) {
  return unwrap(client.delete<T>(url, config));
}

// --- Dashboard ---

export function useDashboardSummary() {
  return useQuery<DashboardSummary>({
    queryKey: ["dashboard", "summary"],
    queryFn: () => apiGet("/dashboard/summary"),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

export interface UsageUnifiedSummary {
  since_hours: number;
  pipeline: {
    traces: {
      period_hours: number;
      trace_count: number;
      request_count?: number;
      total_tokens: number;
      price_usd: number;
      provider_actual_cost_usd?: number;
      avg_duration_ms: number;
      error_count: number;
      source?: string;
      note?: string;
    };
  };
  yarn: Record<string, number | string> | null;
  total_platform_spend?: {
    planner_price_usd: number;
    yarn_price_usd: number;
    total_price_usd: number;
    planner_provider_actual_usd?: number;
    yarn_provider_actual_usd?: number;
    total_provider_actual_usd?: number;
    note: string;
  };
  debug_yarn_trace_estimated_usd?: number;
  glossary: Record<string, string>;
}

export function useUsageSummaryUnified(sinceHours: number) {
  return useQuery<UsageUnifiedSummary>({
    queryKey: ["usage", "summary-unified", sinceHours],
    queryFn: () =>
      apiGet("/usage/summary-unified", { params: { since_hours: sinceHours } }),
  });
}

export function useMcpAgentHealth() {
  return useQuery<{ reachable: boolean; latency_ms?: number | null; error?: string | null }>({
    queryKey: ["integrations", "mcp", "health"],
    queryFn: () => apiGet("/integrations/mcp/health"),
  });
}

export function useMcpAdminMcpHealth() {
  return useQuery<{ reachable: boolean; latency_ms?: number | null; error?: string | null }>({
    queryKey: ["integrations", "mcp", "admin-mcp-health"],
    queryFn: () => apiGet("/integrations/mcp/admin-mcp-health"),
  });
}

export function useMcpAdminCatalog() {
  return useQuery<{
    tools: Array<{ name: string; description?: string; min_role?: string }>;
    scope: string;
    note?: string;
  }>({
    queryKey: ["integrations", "mcp", "admin-catalog"],
    queryFn: () => apiGet("/integrations/mcp/admin-catalog"),
  });
}

// --- Models ---

export function useModelCosts() {
  return useQuery<{ roles: ModelCost[] }>({
    queryKey: ["models", "costs"],
    queryFn: () => apiGet("/models/costs"),
  });
}

export function usePipelineServices() {
  return useQuery<{
    services: Array<{
      name: string;
      url: string;
      configured: boolean;
      reachable: boolean;
      status_code: number | null;
      latency_ms: number | null;
      error: string;
    }>;
  }>({
    queryKey: ["models", "pipeline-services"],
    queryFn: () => apiGet("/models/pipeline-services"),
    refetchInterval: 30_000,
  });
}

export function useModelCostsByModel() {
  return useQuery<{
    models: import("../types").ModelCostByModel[];
    period: string;
  }>({
    queryKey: ["models", "costs", "by-model"],
    queryFn: () => apiGet("/models/costs/by-model"),
    refetchInterval: 60_000,
  });
}

export function useUpdateModelCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ModelCost> & { role: string }) =>
      apiPut("/models/costs", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "costs"] });
      qc.invalidateQueries({ queryKey: ["models", "costs", "by-model"] });
      qc.invalidateQueries({ queryKey: ["models", "costs", "by-role"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}


interface ModelPerformanceEntry {
  [key: string]: unknown;
  model: string;
  tokens: number;
  requests: number;
}

export function useModelPerformance() {
  return useQuery<{ models: ModelPerformanceEntry[] }>({
    queryKey: ["models", "performance"],
    queryFn: () => apiGet("/models/performance"),
    refetchInterval: 30_000,
  });
}

// --- Model Deployments (DB-first) ---

export function useModelDeployments() {
  return useQuery<{ deployments: import("../types").ModelDeployment[] }>({
    queryKey: ["models", "deployments"],
    queryFn: () => apiGet("/models/deployments"),
    refetchInterval: 30_000,
  });
}

export function useCreateModelDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<import("../types").ModelDeployment> & { environment: string; role: string }) =>
      apiPost("/models/deployments", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useUpdateModelDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Partial<import("../types").ModelDeployment>) =>
      apiPut(`/models/deployments/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteModelDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiDelete(`/models/deployments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useActivateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiPost(`/models/deployments/${id}/activate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeactivateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiPost(`/models/deployments/${id}/deactivate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function usePromptProfiles(service?: "yarn" | "planner") {
  return useQuery<{ profiles: import("../types").PromptProfile[] }>({
    queryKey: ["models", "prompts", "profiles", service ?? "all"],
    queryFn: () =>
      apiGet("/models/prompts/profiles", { params: service ? { service } : undefined }),
    refetchInterval: 30_000,
  });
}

export function useCreatePromptProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<import("../types").PromptProfile> & { name: string; service: string; content: string }) =>
      apiPost("/models/prompts/profiles", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "prompts"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useUpdatePromptProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Partial<import("../types").PromptProfile>) =>
      apiPut(`/models/prompts/profiles/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "prompts"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeletePromptProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiDelete(`/models/prompts/profiles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "prompts"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function usePromptAssignments(service?: "yarn" | "planner") {
  return useQuery<{ assignments: import("../types").PromptAssignment[] }>({
    queryKey: ["models", "prompts", "assignments", service ?? "all"],
    queryFn: () =>
      apiGet("/models/prompts/assignments", { params: service ? { service } : undefined }),
    refetchInterval: 30_000,
  });
}

export function useUpsertPromptAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      service: "yarn" | "planner";
      target_type: "default" | "tier" | "role" | "model_family" | "chat_profile" | "node";
      target_value: string;
      profile_id: number;
      enabled?: boolean;
    }) => apiPut("/models/prompts/assignments", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "prompts"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeletePromptAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiDelete(`/models/prompts/assignments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "prompts"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useUpdateFallbacks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fallbacks }: { id: number; fallbacks: string[] }) =>
      apiPut(`/models/deployments/${id}/fallbacks`, { fallbacks }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

// --- Provider Keys (writes) + unified governance read ---

const PROVIDER_GOVERNANCE_QUERY_KEY = ["provider-governance"] as const;

async function fetchProviderGovernance(): Promise<import("../types").ProviderGovernanceResponse> {
  return apiGet("/provider-governance");
}

export function buildCatalogFromGovernance(data: import("../types").ProviderGovernanceResponse): {
  providers: Record<string, import("../types").ProviderInfo>;
  roles: import("../types").RoleInfo[];
} {
  const roles = data.roles ?? [];
  const providers: Record<string, import("../types").ProviderInfo> = {};
  for (const p of data.providers) {
    if (!p.enabled) continue;
    providers[p.key] = {
      key: p.key,
      label: p.label,
      route_prefix: p.route_prefix,
      api_key_env: p.api_key_env,
      needs_endpoint: p.needs_endpoint,
      placeholder: p.placeholder,
      is_local: p.is_local,
      supports_discovery: p.supports_discovery,
      is_custom: p.is_custom,
      default_endpoint: p.default_endpoint,
      api_key_configured: p.api_key_configured,
    };
  }
  return { providers, roles };
}

const providerGovernanceQueryOptions = {
  queryKey: PROVIDER_GOVERNANCE_QUERY_KEY,
  queryFn: fetchProviderGovernance,
  refetchInterval: 30_000,
} as const;

/** @deprecated Prefer fields on useProviderGovernance(); kept for shape parity with cluster secret rows */
export interface ProviderKeyStatus {
  name: string;
  configured: boolean;
  provider?: string;
}

/** Derived from the same cache as useProviderGovernance (GET /provider-governance). */
export function useProviderKeys() {
  return useQuery({
    ...providerGovernanceQueryOptions,
    select: (d: import("../types").ProviderGovernanceResponse) => d.provider_secret_keys ?? [],
  });
}

export function useSetProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      apiPut(`/providers/keys/${name}`, { value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROVIDER_GOVERNANCE_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiDelete(`/providers/keys/${name}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROVIDER_GOVERNANCE_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export interface ProviderSpendReconcileResult {
  ok: boolean;
  summary: {
    since_hours: number;
    providers_available: number;
    yarn_scanned: number;
    yarn_updated: number;
    planner_scanned: number;
    planner_updated: number;
    trace_scanned: number;
    trace_updated: number;
  };
}

export function useReconcileProviderSpend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sinceHours: number) =>
      apiPost<ProviderSpendReconcileResult>("/providers/spend/reconcile", null, {
          params: { since_hours: sinceHours },
        }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "costs"] });
      qc.invalidateQueries({ queryKey: ["yarn"] });
      qc.invalidateQueries({ queryKey: ["usage"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useProviderConsumerRestartStatus() {
  return useQuery<import("../types").ProviderConsumersRestartStatus>({
    queryKey: ["providers", "consumers", "restart-status"],
    queryFn: () => apiGet("/providers/consumers/restart-status"),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

// --- Role-first model registry ---

export function useRoleAssignments() {
  return useQuery<{ roles: import("../types").ModelDeployment[] }>({
    queryKey: ["models", "roles"],
    queryFn: () => apiGet("/models/roles"),
    refetchInterval: 30_000,
  });
}

export function useAssignRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role, ...data }: {
      role: string;
      provider: string;
      model: string;
      endpoint?: string | undefined;
      api_key_env?: string | undefined;
      max_tokens?: number;
      temperature?: number;
      top_p?: number | undefined;
      top_k?: number | undefined;
      min_p?: number | undefined;
      presence_penalty?: number | undefined;
      repetition_penalty?: number | undefined;
      enable_thinking?: boolean | undefined;
      reasoning_effort?: string | undefined;
      model_capability_preset?: string | undefined;
      fallbacks?: string[] | undefined;
      adapter_hint?: string | null;
      description?: string | undefined;
      notes?: string | undefined;
    }) =>
      apiPut(`/models/roles/${role}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeactivateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (role: string) =>
      apiDelete(`/models/roles/${role}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useRoleHistory(role: string) {
  return useQuery<{ history: import("../types").RoleHistoryEntry[] }>({
    queryKey: ["models", "roles", role, "history"],
    queryFn: () => apiGet(`/models/roles/${role}/history`),
    enabled: !!role,
  });
}

export function useProviderCatalog() {
  return useQuery({
    ...providerGovernanceQueryOptions,
    select: buildCatalogFromGovernance,
  });
}

export function useDiscoverModels(providerKey: string | null, bypassCache = false) {
  return useQuery<import("../types").DiscoveryResult>({
    queryKey: ["providers", "discovery", providerKey, bypassCache],
    queryFn: () =>
      apiGet(`/providers/discovery/${providerKey}/models`, { params: { bypass_cache: bypassCache } }),
    enabled: !!providerKey,
    staleTime: 5 * 60_000,
  });
}

export function useProviderDefaults(providerKey: string, modelId: string, contextWindow?: number | null) {
  return useQuery<import("../types").ProviderDefaults>({
    queryKey: ["providers", "defaults", providerKey, modelId, contextWindow],
    queryFn: () =>
      apiGet(`/providers/discovery/${providerKey}/defaults`, {
          params: { model_id: modelId, context_window: contextWindow ?? undefined },
        }),
    enabled: !!providerKey && !!modelId,
    staleTime: 5 * 60_000,
  });
}

export function useValidateModel() {
  return useMutation<import("../types").ModelValidation, Error, { provider: string; model: string }>({
    mutationFn: (data) =>
      apiPost("/providers/discovery/validate", data),
  });
}

// --- Provider Governance ---

export function useProviderGovernance() {
  return useQuery<import("../types").ProviderGovernanceResponse>(providerGovernanceQueryOptions);
}

export function useUpdateProviderConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerKey, ...data }: { providerKey: string } & Partial<import("../types").ProviderConfig>) =>
      apiPut(`/provider-governance/${providerKey}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROVIDER_GOVERNANCE_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useResetProviderConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerKey: string) =>
      apiDelete(`/provider-governance/${providerKey}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROVIDER_GOVERNANCE_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      key: string;
      label: string;
      route_prefix?: string;
      api_key_env?: string;
      needs_endpoint?: boolean;
      default_endpoint?: string;
      placeholder?: string;
      is_local?: boolean;
      enabled?: boolean;
    }) => apiPost("/provider-governance", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROVIDER_GOVERNANCE_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerKey: string) =>
      apiDelete(`/provider-governance/${providerKey}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROVIDER_GOVERNANCE_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

// --- Effective Serving (read-only, derived from Model Registry) ---
// No CRUD hooks — serving is managed via the Model Registry role assignments.

export function usePerformanceByRole(days: number = 7) {
  return useQuery<{ roles: import("../types").RolePerformance[]; period_days: number }>({
    queryKey: ["models", "performance", "by-role", days],
    queryFn: () =>
      apiGet("/models/performance/by-role", { params: { days } }),
    refetchInterval: 60_000,
  });
}

// --- Active costs (role-first with pricing resolution) ---

export function useActiveCosts() {
  return useQuery<{ roles: import("../types").ActiveCostEntry[] }>({
    queryKey: ["models", "costs", "active"],
    queryFn: () => apiGet("/models/costs/active"),
    refetchInterval: 60_000,
  });
}

export interface PublicModelOffering {
  id: number;
  client_model_id: string;
  label: string | null;
  effort_tier: string;
  connection_mode: string;
  route_via_role: string | null;
  standalone_provider: string | null;
  standalone_endpoint: string | null;
  standalone_api_key_env: string | null;
  backend_model_override: string | null;
  generation_params: Record<string, unknown> | null;
  expose_planner: boolean;
  expose_yarn: boolean;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export function usePublicOfferings() {
  return useQuery<{ offerings: PublicModelOffering[] }>({
    queryKey: ["models", "public-offerings"],
    queryFn: () => apiGet("/models/public-offerings"),
    refetchInterval: 60_000,
  });
}

export function useCreatePublicOffering() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      client_model_id: string;
      label?: string | null;
      effort_tier?: string | null;
      connection_mode?: string | null;
      route_via_role?: string | null;
      standalone_provider?: string | null;
      standalone_endpoint?: string | null;
      standalone_api_key_env?: string | null;
      backend_model_override?: string | null;
      generation_params?: Record<string, unknown> | null;
      expose_planner?: boolean;
      expose_yarn?: boolean;
      is_active?: boolean;
    }) => apiPost<PublicModelOffering>("/models/public-offerings", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "public-offerings"] });
    },
  });
}

export function usePatchPublicOffering() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: { id: number } & Partial<{
      client_model_id: string;
      label: string | null;
      effort_tier: string;
      connection_mode: string | null;
      route_via_role: string | null;
      standalone_provider: string | null;
      standalone_endpoint: string | null;
      standalone_api_key_env: string | null;
      backend_model_override: string | null;
      generation_params: Record<string, unknown> | null;
      expose_planner: boolean;
      expose_yarn: boolean;
      is_active: boolean;
    }>) => apiPatch<PublicModelOffering>(`/models/public-offerings/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "public-offerings"] });
    },
  });
}

export function useDeletePublicOffering() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiDelete(`/models/public-offerings/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "public-offerings"] });
    },
  });
}

// --- Infrastructure cost settings ---

export function useInfraCatalog() {
  return useQuery<{ instances: import("../types").InfraInstanceType[] }>({
    queryKey: ["settings", "infra-costs", "catalog"],
    queryFn: () => apiGet("/settings/infra-costs/catalog"),
    staleTime: 5 * 60_000,
  });
}

export function useInfraConfigs() {
  return useQuery<{ configs: import("../types").InfraCostConfig[] }>({
    queryKey: ["settings", "infra-costs"],
    queryFn: () => apiGet("/settings/infra-costs"),
    refetchInterval: 30_000,
  });
}

export function useSetInfraCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role, ...data }: { role: string } & Partial<import("../types").InfraCostConfig>) =>
      apiPut(`/settings/infra-costs/${role}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "infra-costs"] });
      qc.invalidateQueries({ queryKey: ["models", "costs"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteInfraCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (role: string) =>
      apiDelete(`/settings/infra-costs/${role}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "infra-costs"] });
      qc.invalidateQueries({ queryKey: ["models", "costs"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

// --- Admin audit log ---

export interface AdminAuditEventRow {
  id: number;
  created_at: string | null;
  source: string;
  actor_username: string;
  actor_user_id: string;
  actor_role: string;
  action: string;
  status: string;
  summary: string;
  detail: Record<string, unknown>;
}

export function useAdminAuditEvents(limit = 150) {
  return useQuery<{ events: AdminAuditEventRow[] }>({
    queryKey: ["audit", "events", limit],
    queryFn: () => apiGet("/audit/events", { params: { limit } }),
    refetchInterval: 15_000,
  });
}

// --- Model Performance (detailed, trace-based) ---

export interface DetailedModelPerformance {
  model: string;
  request_count: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  total_tokens: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cached_prompt_tokens: number;
  cache_hit_rate: number;
  total_price_usd: number;
  total_provider_actual_cost_usd?: number;
}

export function useDetailedPerformance(days: number = 7) {
  return useQuery<{ models: DetailedModelPerformance[]; period_days: number }>({
    queryKey: ["models", "performance", "detailed", days],
    queryFn: () =>
      apiGet("/models/performance/detailed", { params: { days } }),
    refetchInterval: 60_000,
  });
}

export interface LatencyTrendPoint {
  date: string;
  model: string;
  avg_latency_ms: number;
  request_count: number;
}

export function useLatencyTrend(days: number = 14) {
  return useQuery<{ trend: LatencyTrendPoint[]; period_days: number }>({
    queryKey: ["models", "performance", "latency-trend", days],
    queryFn: () =>
      apiGet("/models/performance/latency-trend", { params: { days } }),
    refetchInterval: 60_000,
  });
}

// --- Model Costs (enhanced) ---

export interface CostByModelEntry {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens?: number;
  requests: number;
  price_usd: number;
  provider_actual_cost_usd?: number;
}

export function useCostsByModel(days: number = 7) {
  return useQuery<{ models: CostByModelEntry[]; period_days: number }>({
    queryKey: ["models", "costs", "by-model", days],
    queryFn: () =>
      apiGet("/models/costs/by-model", { params: { days } }),
    refetchInterval: 60_000,
  });
}

export interface CostByRoleEntry {
  role: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens?: number;
  requests: number;
  price_usd: number;
  provider_actual_cost_usd?: number;
}

export function useCostsByRole(days: number = 7) {
  return useQuery<{ roles: CostByRoleEntry[]; period_days: number }>({
    queryKey: ["models", "costs", "by-role", days],
    queryFn: () =>
      apiGet("/models/costs/by-role", { params: { days } }),
    refetchInterval: 60_000,
  });
}

export interface DailyCostEntry {
  date: string;
  tokens: number;
  requests: number;
  price_usd: number;
  provider_actual_cost_usd?: number;
}

export function useCostsDaily(days: number = 7) {
  return useQuery<{ daily: DailyCostEntry[]; period_days: number }>({
    queryKey: ["models", "costs", "daily", days],
    queryFn: () =>
      apiGet("/models/costs/daily", { params: { days } }),
    refetchInterval: 60_000,
  });
}
