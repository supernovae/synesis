import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import client from "./client";
import type {
  DashboardSummary,
  ModelCost,
  CorpusStats,
  QualitySummary,
  DomainScorecard,
  TaxonomyDomain,
  PipelineMetrics,
  CriticStats,
  CriticDetailed,
  McpTool,
  FeedbackEntry,
  KnowledgeGap,
  CuratorProposal,
  ServiceHealthSnapshot,
  FailureRecord,
  CacheMetrics,
  CircuitBreakerState,
  BenchmarkResults,
  IngestionSource,
  IngestionItem,
  IngestionRun,
  IngestionStats,
  StagedIngestionDocument,
} from "../types";

// --- Dashboard ---

export function useDashboardSummary() {
  return useQuery<DashboardSummary>({
    queryKey: ["dashboard", "summary"],
    queryFn: () => client.get("/dashboard/summary").then((r) => r.data),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

export interface UsageUnifiedSummary {
  since_hours: number;
  pipeline: {
    rollups: Record<string, number | string>;
    traces: {
      period_hours: number;
      trace_count: number;
      total_tokens: number;
      estimated_cost_usd: number;
      actual_cost_usd: number;
    };
  };
  rollup_latest_bucket_utc: string | null;
  rollup_lag_seconds_approx: number | null;
  yarn: Record<string, number | string> | null;
  total_platform_spend?: {
    planner_estimated_usd: number;
    planner_actual_usd: number;
    yarn_estimated_usd: number;
    yarn_actual_usd: number;
    total_estimated_usd: number;
    total_actual_usd: number;
    effective_total_usd: number;
    note: string;
  };
  glossary: Record<string, string>;
}

export function useUsageSummaryUnified(sinceHours: number) {
  return useQuery<UsageUnifiedSummary>({
    queryKey: ["usage", "summary-unified", sinceHours],
    queryFn: () =>
      client.get("/usage/summary-unified", { params: { since_hours: sinceHours } }).then((r) => r.data),
  });
}

export function useUsageReconcile(sinceHours: number, enabled: boolean) {
  return useQuery({
    queryKey: ["usage", "reconcile", sinceHours],
    queryFn: () => client.get("/usage/reconcile", { params: { since_hours: sinceHours } }).then((r) => r.data),
    enabled,
  });
}

export function useMcpAgentHealth() {
  return useQuery({
    queryKey: ["integrations", "mcp", "health"],
    queryFn: () => client.get("/integrations/mcp/health").then((r) => r.data),
  });
}

export function useMcpAdminCatalog() {
  return useQuery<{
    tools: Array<{ name: string; description?: string; min_role?: string }>;
    scope: string;
    note?: string;
  }>({
    queryKey: ["integrations", "mcp", "admin-catalog"],
    queryFn: () => client.get("/integrations/mcp/admin-catalog").then((r) => r.data),
  });
}

// --- Models ---

export function useModelCosts() {
  return useQuery<{ roles: ModelCost[] }>({
    queryKey: ["models", "costs"],
    queryFn: () => client.get("/models/costs").then((r) => r.data),
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
    queryFn: () => client.get("/models/pipeline-services").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useModelCostsByModel() {
  return useQuery<{
    models: import("../types").ModelCostByModel[];
    period: string;
  }>({
    queryKey: ["models", "costs", "by-model"],
    queryFn: () => client.get("/models/costs/by-model").then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export function useUpdateModelCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ModelCost> & { role: string }) =>
      client.put("/models/costs", data).then((r) => r.data),
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
    queryFn: () => client.get("/models/performance").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

// --- Model Deployments (DB-first) ---

export function useModelDeployments() {
  return useQuery<{ deployments: import("../types").ModelDeployment[] }>({
    queryKey: ["models", "deployments"],
    queryFn: () => client.get("/models/deployments").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useCreateModelDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<import("../types").ModelDeployment> & { environment: string; role: string }) =>
      client.post("/models/deployments", data).then((r) => r.data),
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
      client.put(`/models/deployments/${id}`, data).then((r) => r.data),
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
      client.delete(`/models/deployments/${id}`).then((r) => r.data),
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
      client.post(`/models/deployments/${id}/activate`).then((r) => r.data),
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
      client.post(`/models/deployments/${id}/deactivate`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useSyncModelsFromYaml() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.post("/models/sync-from-yaml").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["models", "roles"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export interface ReconcileModelsResult {
  added: number;
  removed: number;
  unchanged: number;
}

export function useReconcileModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      client.post<ReconcileModelsResult>("/models/reconcile").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useUpdateFallbacks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fallbacks }: { id: number; fallbacks: string[] }) =>
      client.put(`/models/deployments/${id}/fallbacks`, { fallbacks }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

// --- Provider Keys ---

export interface ProviderKeyStatus {
  name: string;
  configured: boolean;
  /** Display label from catalog; optional for legacy keys */
  provider?: string;
}

export function useProviderKeys() {
  return useQuery<ProviderKeyStatus[]>({
    queryKey: ["providers", "keys"],
    queryFn: () => client.get("/providers/keys").then((r) => r.data.keys ?? r.data),
    staleTime: 30_000,
  });
}

export function useSetProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      client.put(`/providers/keys/${name}`, { value }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers", "keys"] });
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      client.delete(`/providers/keys/${name}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers", "keys"] });
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useLitellmRestartStatus() {
  return useQuery<import("../types").LiteLLMRestartStatus>({
    queryKey: ["providers", "litellm", "restart-status"],
    queryFn: () => client.get("/providers/litellm/restart-status").then((r) => r.data),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

// --- Role-first model registry ---

export function useRoleAssignments() {
  return useQuery<{ roles: import("../types").ModelDeployment[] }>({
    queryKey: ["models", "roles"],
    queryFn: () => client.get("/models/roles").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useAssignRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role, ...data }: { role: string; provider: string; model: string; endpoint?: string; api_key_env?: string; max_tokens?: number; temperature?: number; fallbacks?: string[]; description?: string; notes?: string }) =>
      client.put(`/models/roles/${role}`, data).then((r) => r.data),
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
      client.delete(`/models/roles/${role}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useRoleHistory(role: string) {
  return useQuery<{ history: import("../types").RoleHistoryEntry[] }>({
    queryKey: ["models", "roles", role, "history"],
    queryFn: () => client.get(`/models/roles/${role}/history`).then((r) => r.data),
    enabled: !!role,
  });
}

export function useProviderCatalog() {
  return useQuery<{
    providers: Record<string, import("../types").ProviderInfo>;
    roles: import("../types").RoleInfo[];
  }>({
    queryKey: ["providers", "catalog"],
    queryFn: () => client.get("/providers/catalog").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useDiscoverModels(providerKey: string | null, bypassCache = false) {
  return useQuery<import("../types").DiscoveryResult>({
    queryKey: ["providers", "discovery", providerKey, bypassCache],
    queryFn: () =>
      client
        .get(`/providers/discovery/${providerKey}/models`, { params: { bypass_cache: bypassCache } })
        .then((r) => r.data),
    enabled: !!providerKey,
    staleTime: 5 * 60_000,
  });
}

export function useProviderDefaults(providerKey: string, modelId: string, contextWindow?: number | null) {
  return useQuery<import("../types").ProviderDefaults>({
    queryKey: ["providers", "defaults", providerKey, modelId, contextWindow],
    queryFn: () =>
      client
        .get(`/providers/discovery/${providerKey}/defaults`, {
          params: { model_id: modelId, context_window: contextWindow ?? undefined },
        })
        .then((r) => r.data),
    enabled: !!providerKey && !!modelId,
    staleTime: 5 * 60_000,
  });
}

export function useValidateModel() {
  return useMutation<import("../types").ModelValidation, Error, { provider: string; model: string }>({
    mutationFn: (data) =>
      client.post("/providers/discovery/validate", data).then((r) => r.data),
  });
}

// --- Provider Governance ---

export function useProviderGovernance() {
  return useQuery<{ providers: import("../types").ProviderConfigInfo[] }>({
    queryKey: ["provider-governance"],
    queryFn: () => client.get("/provider-governance").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useUpdateProviderConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerKey, ...data }: { providerKey: string } & Partial<import("../types").ProviderConfig>) =>
      client.put(`/provider-governance/${providerKey}`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["provider-governance"] });
      qc.invalidateQueries({ queryKey: ["providers", "catalog"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useResetProviderConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerKey: string) =>
      client.delete(`/provider-governance/${providerKey}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["provider-governance"] });
      qc.invalidateQueries({ queryKey: ["providers", "catalog"] });
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
      litellm_prefix?: string;
      api_key_env?: string;
      needs_endpoint?: boolean;
      placeholder?: string;
      is_local?: boolean;
      enabled?: boolean;
    }) => client.post("/provider-governance", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["provider-governance"] });
      qc.invalidateQueries({ queryKey: ["providers", "catalog"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerKey: string) =>
      client.delete(`/provider-governance/${providerKey}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["provider-governance"] });
      qc.invalidateQueries({ queryKey: ["providers", "catalog"] });
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
      client.get("/models/performance/by-role", { params: { days } }).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

// --- Active costs (role-first with pricing resolution) ---

export function useActiveCosts() {
  return useQuery<{ roles: import("../types").ActiveCostEntry[] }>({
    queryKey: ["models", "costs", "active"],
    queryFn: () => client.get("/models/costs/active").then((r) => r.data),
    refetchInterval: 60_000,
  });
}

// --- Infrastructure cost settings ---

export function useInfraCatalog() {
  return useQuery<{ instances: import("../types").InfraInstanceType[] }>({
    queryKey: ["settings", "infra-costs", "catalog"],
    queryFn: () => client.get("/settings/infra-costs/catalog").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useInfraConfigs() {
  return useQuery<{ configs: import("../types").InfraCostConfig[] }>({
    queryKey: ["settings", "infra-costs"],
    queryFn: () => client.get("/settings/infra-costs").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useSetInfraCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role, ...data }: { role: string } & Partial<import("../types").InfraCostConfig>) =>
      client.put(`/settings/infra-costs/${role}`, data).then((r) => r.data),
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
      client.delete(`/settings/infra-costs/${role}`).then((r) => r.data),
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
    queryFn: () => client.get("/audit/events", { params: { limit } }).then((r) => r.data),
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
  total_actual_cost: number;
}

export function useDetailedPerformance(days: number = 7) {
  return useQuery<{ models: DetailedModelPerformance[]; period_days: number }>({
    queryKey: ["models", "performance", "detailed", days],
    queryFn: () =>
      client.get("/models/performance/detailed", { params: { days } }).then((r) => r.data),
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
      client.get("/models/performance/latency-trend", { params: { days } }).then((r) => r.data),
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
  estimated_cost_usd: number;
  actual_cost_usd: number;
}

export function useCostsByModel(days: number = 7) {
  return useQuery<{ models: CostByModelEntry[]; period_days: number }>({
    queryKey: ["models", "costs", "by-model", days],
    queryFn: () =>
      client.get("/models/costs/by-model", { params: { days } }).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export interface CostByRoleEntry {
  role: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens?: number;
  requests: number;
  estimated_cost_usd: number;
  actual_cost_usd: number;
}

export function useCostsByRole(days: number = 7) {
  return useQuery<{ roles: CostByRoleEntry[]; period_days: number }>({
    queryKey: ["models", "costs", "by-role", days],
    queryFn: () =>
      client.get("/models/costs/by-role", { params: { days } }).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export interface DailyCostEntry {
  date: string;
  tokens: number;
  requests: number;
  estimated_cost_usd: number;
  actual_cost_usd: number;
}

export function useCostsDaily(days: number = 7) {
  return useQuery<{ daily: DailyCostEntry[]; period_days: number }>({
    queryKey: ["models", "costs", "daily", days],
    queryFn: () =>
      client.get("/models/costs/daily", { params: { days } }).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export interface CostRateSnapshotEntry {
  model: string;
  role: string;
  input_per_million: number;
  output_per_million: number;
  source: string;
  captured_at: string;
}

export function useCostRateHistory(days: number = 90) {
  return useQuery<{ snapshots: CostRateSnapshotEntry[]; period_days: number }>({
    queryKey: ["models", "costs", "rate-history", days],
    queryFn: () =>
      client.get("/models/costs/rate-history", { params: { days } }).then((r) => r.data),
    refetchInterval: 5 * 60_000,
  });
}

// --- RAG ---

export function useCorpusStats() {
  return useQuery<CorpusStats>({
    queryKey: ["rag", "corpus"],
    queryFn: () => client.get("/rag/corpus").then((r) => r.data),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export function useQualitySummary() {
  return useQuery<QualitySummary>({
    queryKey: ["rag", "quality"],
    queryFn: () => client.get("/rag/quality").then((r) => r.data),
  });
}

export function useQualityDomains(params?: { sort?: string; health?: string }) {
  return useQuery<{ domains: DomainScorecard[] }>({
    queryKey: ["rag", "quality", "domains", params],
    queryFn: () =>
      client.get("/rag/quality/domains", { params }).then((r) => r.data),
  });
}

export function useQualityDomain(key: string) {
  return useQuery<DomainScorecard>({
    queryKey: ["rag", "quality", "domains", key],
    queryFn: () =>
      client.get(`/rag/quality/domains/${key}`).then((r) => r.data),
    enabled: !!key,
  });
}

export function useBenchmarks() {
  return useQuery<BenchmarkResults & { run_id?: string; triggered_by?: string; started_at?: string }>({
    queryKey: ["rag", "benchmarks"],
    queryFn: () => client.get("/rag/benchmarks").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

// --- Taxonomy ---

export function useTaxonomy() {
  return useQuery<{ domains: TaxonomyDomain[] }>({
    queryKey: ["taxonomy"],
    queryFn: () => client.get("/taxonomy").then((r) => r.data),
  });
}

export function useTaxonomyDomain(key: string) {
  return useQuery<TaxonomyDomain>({
    queryKey: ["taxonomy", key],
    queryFn: () => client.get(`/taxonomy/${key}`).then((r) => r.data),
    enabled: !!key,
  });
}

export function useUpdateTaxonomyDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { key: string; path?: string; complexity?: number; persona?: string }) =>
      client.put(`/taxonomy/${data.key}`, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["taxonomy"] }),
  });
}

export function useSyncTaxonomyFromYaml() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.post("/taxonomy/sync-from-yaml").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["taxonomy"] }),
  });
}

export function useExportTaxonomyYaml() {
  return useMutation({
    mutationFn: () => client.post("/taxonomy/export-yaml").then((r) => r.data),
  });
}

// --- Pipeline ---

interface GraphNode {
  id: string;
  label?: string;
  type?: string;
}

interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

interface PipelineGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function usePipelineGraph() {
  return useQuery<PipelineGraph>({
    queryKey: ["pipeline", "graph"],
    queryFn: () => client.get("/pipeline/graph").then((r) => r.data),
  });
}

export function usePipelineMetrics() {
  return useQuery<{ nodes: PipelineMetrics[] }>({
    queryKey: ["pipeline", "metrics"],
    queryFn: () => client.get("/pipeline/metrics").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useCriticStats() {
  return useQuery<CriticStats>({
    queryKey: ["pipeline", "critic"],
    queryFn: () => client.get("/pipeline/critic").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useCriticDetailed(days: number = 7) {
  return useQuery<CriticDetailed>({
    queryKey: ["pipeline", "critic", "detailed", days],
    queryFn: () =>
      client
        .get("/pipeline/critic/detailed", { params: { days } })
        .then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export interface CriticEvaluation {
  trace_id: string;
  timestamp: number;
  query_snippet: string;
  weighted_overall: number;
  approved: boolean;
  failure_modes: string[];
  repair_instructions: string;
}

export function useCriticEvaluations(params?: {
  days?: number;
  limit?: number;
  offset?: number;
}) {
  return useQuery<{
    evaluations: CriticEvaluation[];
    total: number;
    limit: number;
    offset: number;
  }>({
    queryKey: ["pipeline", "critic", "evaluations", params],
    queryFn: () =>
      client
        .get("/pipeline/critic/evaluations", { params })
        .then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export interface CriticModel {
  id: string;
  label: string;
  provider: string;
}

export function useCriticModels() {
  return useQuery<{ models: CriticModel[] }>({
    queryKey: ["pipeline", "critic", "models"],
    queryFn: () => client.get("/pipeline/critic/models").then((r) => r.data),
  });
}

export interface CriticRunResult {
  trace_id: string;
  model: string;
  model_label: string;
  scores: Record<string, number>;
  approved: boolean;
  failure_modes: string[];
  repair_instructions: Array<{
    priority: number;
    target: string;
    action: string;
    reason: string;
  }>;
  overall_assessment: string;
  latency_ms: number;
}

export function useRunCritic() {
  const qc = useQueryClient();
  return useMutation<CriticRunResult, Error, { trace_id: string; model: string }>({
    mutationFn: (data) => client.post("/pipeline/critic/run", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pipeline", "critic"] });
    },
  });
}

export function usePurgeTrivialTraces() {
  const qc = useQueryClient();
  return useMutation<
    { deleted?: number; would_delete?: number; dry_run: boolean; min_tokens?: number },
    Error,
    { min_tokens?: number; dry_run?: boolean }
  >({
    mutationFn: (params) =>
      client.post("/traces/purge-trivial", null, { params }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["traces"] });
      qc.invalidateQueries({ queryKey: ["pipeline", "critic"] });
    },
  });
}

export function useDeleteTrace() {
  const qc = useQueryClient();
  return useMutation<{ deleted: string }, Error, string>({
    mutationFn: (traceId) => client.delete(`/traces/${traceId}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["traces"] });
      qc.invalidateQueries({ queryKey: ["pipeline", "critic"] });
    },
  });
}

export function useBulkDeleteTraces() {
  const qc = useQueryClient();
  return useMutation<{ deleted: number; requested: number }, Error, string[]>({
    mutationFn: (traceIds) =>
      client.post("/traces/bulk-delete", traceIds).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["traces"] });
      qc.invalidateQueries({ queryKey: ["pipeline", "critic"] });
    },
  });
}

export function useClearCriticData() {
  const qc = useQueryClient();
  return useMutation<{ trace_id: string; cleared: boolean }, Error, string>({
    mutationFn: (traceId) =>
      client.post("/pipeline/critic/clear", { trace_id: traceId }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pipeline", "critic"] });
      qc.invalidateQueries({ queryKey: ["traces"] });
    },
  });
}

// --- Integrations ---

export function useMcpTools() {
  return useQuery<{ tools: McpTool[] }>({
    queryKey: ["integrations", "mcp", "tools"],
    queryFn: () => client.get("/integrations/mcp/tools").then((r) => r.data),
  });
}

interface WebSearchStats {
  total: number;
  avg_latency_ms: number | null;
  error_rate: number | null;
}

export function useWebSearchStats() {
  return useQuery<WebSearchStats>({
    queryKey: ["integrations", "web-search"],
    queryFn: () => client.get("/integrations/web-search").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

interface WebSearchLogEntry {
  id: number;
  timestamp: number;
  run_id: string;
  query: string;
  source_id: string;
  profile: string;
  url: string;
  domain: string;
  title: string;
  snippet: string;
  score: number;
  latency_ms: number;
  outcome: string;
  engine: string;
}

export function useWebSearchLog(params?: {
  domain?: string;
  outcome?: string;
  q?: string;
  page?: number;
  page_size?: number;
}) {
  return useQuery<{ items: WebSearchLogEntry[]; total: number; page: number; page_size: number }>({
    queryKey: ["integrations", "web-search", "log", params],
    queryFn: () =>
      client.get("/integrations/web-search/log", { params }).then((r) => r.data),
    refetchInterval: 30_000,
  });
}

interface DomainSummary {
  domain: string;
  count: number;
  avg_latency_ms: number;
  last_seen: number;
  error_count: number;
}

export function useWebSearchDomains() {
  return useQuery<{ domains: DomainSummary[] }>({
    queryKey: ["integrations", "web-search", "domains"],
    queryFn: () =>
      client.get("/integrations/web-search/log/domains").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

interface WebUrlPolicyEntry {
  id: number;
  url_pattern: string;
  policy: string;
  reason: string;
  reviewed_by: string;
  reviewed_at: number;
  boost_factor: number;
  auto_ingest: boolean;
}

export function useWebSearchPolicies() {
  return useQuery<{ policies: WebUrlPolicyEntry[] }>({
    queryKey: ["integrations", "web-search", "policies"],
    queryFn: () =>
      client.get("/integrations/web-search/policies").then((r) => r.data),
  });
}

export function useCreateWebSearchPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      url_pattern: string;
      policy: string;
      reason?: string;
      boost_factor?: number;
      auto_ingest?: boolean;
    }) => client.post("/integrations/web-search/policies", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "web-search", "policies"] });
    },
  });
}

export function useDeleteWebSearchPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      client.delete(`/integrations/web-search/policies/${id}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "web-search", "policies"] });
    },
  });
}

export function useIngestWebUrl() {
  return useMutation({
    mutationFn: (data: { url: string; title?: string; reason?: string }) =>
      client.post("/integrations/web-search/ingest", data).then((r) => r.data),
  });
}

// --- Feedback ---

export function useFeedback(params?: {
  vote?: string;
  limit?: number;
  source?: string;
  review_status?: string;
  offset?: number;
}) {
  return useQuery<{ entries: FeedbackEntry[]; total: number }>({
    queryKey: ["feedback", params],
    queryFn: () => client.get("/feedback", { params }).then((r) => r.data),
  });
}

export function useSyncOpenWebUIFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.post("/feedback/sync-openwebui").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["feedback"] }),
  });
}

export function useFeedbackWorkspaceUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      source: "planner" | "openwebui";
      run_id?: string;
      message_id?: string;
      owui_id?: string;
      review_status: "pending" | "reviewed" | "closed";
      internal_note: string;
    }) => client.patch("/feedback/workspace", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["feedback"] }),
  });
}

export function useKnowledgeGaps(params?: { domain?: string; page?: number }) {
  return useQuery<{ gaps: KnowledgeGap[]; total: number }>({
    queryKey: ["feedback", "knowledge-gaps", params],
    queryFn: () =>
      client.get("/feedback/knowledge-gaps", { params }).then((r) => r.data),
  });
}

export function useSubmitKnowledge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { domain: string; content: string }) =>
      client.post("/feedback/knowledge-gaps/submit", data),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["feedback", "knowledge-gaps"] }),
  });
}

export function useCuratorProposals() {
  return useQuery<{ proposals: CuratorProposal[] }>({
    queryKey: ["feedback", "curator"],
    queryFn: () => client.get("/feedback/curator").then((r) => r.data),
  });
}

export function useCuratorAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; action: "approve" | "reject" }) =>
      client.post(`/feedback/curator/${data.id}/${data.action}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["feedback", "curator"] }),
  });
}

// --- Observability ---

export function useServiceHealth() {
  return useQuery<ServiceHealthSnapshot>({
    queryKey: ["observability", "health"],
    queryFn: () => client.get("/observability/health").then((r) => r.data),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useCacheMetrics() {
  return useQuery<CacheMetrics>({
    queryKey: ["observability", "cache"],
    queryFn: () => client.get("/observability/cache").then((r) => r.data),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useCompactionHistory(sinceHours = 24, service = "") {
  return useQuery<{
    snapshots: Array<{
      service: string;
      captured_at: string;
      compaction_count: number;
      chars_before: number;
      chars_after: number;
      tokens_saved_estimate: number;
      errors: number;
      detail: Record<string, unknown> | null;
    }>;
    count: number;
  }>({
    queryKey: ["observability", "compaction-history", sinceHours, service],
    queryFn: () =>
      client
        .get("/observability/compaction", { params: { since_hours: sinceHours, service } })
        .then((r) => r.data),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useCacheHistory(sinceHours = 24, service = "") {
  return useQuery<{ snapshots: import("../types").CacheHistorySnapshot[]; count: number }>({
    queryKey: ["observability", "cache-history", sinceHours, service],
    queryFn: () =>
      client
        .get("/observability/cache/history", { params: { since_hours: sinceHours, service } })
        .then((r) => r.data),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useCircuitBreakers() {
  return useQuery<{ breakers: CircuitBreakerState[] }>({
    queryKey: ["observability", "circuit-breakers"],
    queryFn: () =>
      client.get("/observability/circuit-breakers").then((r) => r.data),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useFailures(params?: {
  language?: string;
  error_type?: string;
  page?: number;
  page_size?: number;
}) {
  return useQuery<{ failures: FailureRecord[]; total: number }>({
    queryKey: ["observability", "failures", params],
    queryFn: () =>
      client.get("/observability/failures", { params }).then((r) => r.data),
  });
}

export function useDeleteFailure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (failureId: string) =>
      client.delete(`/observability/failures/${failureId}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "failures"] });
    },
  });
}

export function useBulkDeleteFailures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (failureIds: string[]) =>
      client.post("/observability/failures/bulk-delete", { failure_ids: failureIds }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "failures"] });
    },
  });
}

export function usePurgeFailures() {
  const qc = useQueryClient();
  return useMutation<{ deleted: number; resolved_only: boolean }, Error, boolean>({
    mutationFn: (resolvedOnly) =>
      client.delete("/observability/failures", { params: { resolved_only: resolvedOnly } }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "failures"] });
    },
  });
}

export function useFailureDetail(id: string) {
  return useQuery<FailureRecord>({
    queryKey: ["observability", "failures", id],
    queryFn: () =>
      client.get(`/observability/failures/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

interface FailureStats {
  total: number;
  by_type: Record<string, number>;
  by_language: Record<string, number>;
}

export function useFailureStats() {
  return useQuery<FailureStats>({
    queryKey: ["observability", "failures", "stats"],
    queryFn: () =>
      client.get("/observability/failures/stats").then((r) => r.data),
  });
}

// --- Knowledge Gaps (Observability) ---

export function useObservabilityKnowledgeGaps(params?: {
  page?: number;
  page_size?: number;
  status?: string;
}) {
  return useQuery<{ gaps: KnowledgeGap[]; total: number }>({
    queryKey: ["observability", "knowledge-gaps", params],
    queryFn: () =>
      client
        .get("/observability/knowledge-gaps", { params })
        .then((r) => r.data),
  });
}

export function useResolveGap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { chunk_id: string; resolution_note?: string }) =>
      client.post(`/observability/knowledge-gaps/${data.chunk_id}/resolve`, {
        resolution_note: data.resolution_note || "",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "knowledge-gaps"] });
      qc.invalidateQueries({ queryKey: ["feedback", "knowledge-gaps"] });
    },
  });
}

export function useReopenGap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chunk_id: string) =>
      client.post(`/observability/knowledge-gaps/${chunk_id}/reopen`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "knowledge-gaps"] });
      qc.invalidateQueries({ queryKey: ["feedback", "knowledge-gaps"] });
    },
  });
}

export function usePurgeGap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chunk_id: string) =>
      client.delete(`/observability/knowledge-gaps/${chunk_id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "knowledge-gaps"] });
      qc.invalidateQueries({ queryKey: ["feedback", "knowledge-gaps"] });
    },
  });
}

export function useBulkGapAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      gap_ids: string[];
      action: "resolve" | "reopen" | "purge";
      resolution_note?: string;
    }) => client.post("/observability/knowledge-gaps/bulk-action", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "knowledge-gaps"] });
      qc.invalidateQueries({ queryKey: ["feedback", "knowledge-gaps"] });
    },
  });
}

export function usePurgeGapsByStatus() {
  const qc = useQueryClient();
  return useMutation<{ deleted: number; status: string }, Error, "resolved" | "reopened" | "open">({
    mutationFn: (status) =>
      client.delete("/observability/knowledge-gaps", { params: { status } }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "knowledge-gaps"] });
      qc.invalidateQueries({ queryKey: ["feedback", "knowledge-gaps"] });
    },
  });
}

interface KnowledgeGapStats {
  total_gaps: number;
  avg_score: number;
  by_context: Record<string, number>;
  by_language: Record<string, number>;
  [key: string]: unknown;
}

export function useKnowledgeGapStats() {
  return useQuery<KnowledgeGapStats>({
    queryKey: ["observability", "knowledge-gaps", "stats"],
    queryFn: () =>
      client
        .get("/observability/knowledge-gaps/stats")
        .then((r) => r.data),
  });
}

// --- Traces ---

export function useTraces(params?: {
  offset?: number;
  limit?: number;
  has_error?: boolean;
  user_id?: string;
  org_id?: string;
  task_type?: string;
  domain_tag?: string;
  max_tokens?: number;
  min_hallucinated_urls?: number;
}) {
  return useQuery<{ traces: import("../types").TraceRecord[]; total: number }>({
    queryKey: ["traces", params],
    queryFn: () => client.get("/traces", { params }).then((r) => r.data),
    refetchInterval: 15_000,
  });
}

export function useTrace(traceId: string) {
  return useQuery<import("../types").TraceRecord>({
    queryKey: ["traces", traceId],
    queryFn: () => client.get(`/traces/${traceId}`).then((r) => r.data),
    enabled: !!traceId,
  });
}

export function useTraceStats() {
  return useQuery<import("../types").TraceStats>({
    queryKey: ["traces", "stats"],
    queryFn: () => client.get("/traces/stats").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

// --- Assistant ---

export function useAssistantChat() {
  return useMutation<
    { response: string; tokens: number; model: string; tool_rounds?: number },
    Error,
    { message: string; context?: string; trace_id?: string; span_index?: number }
  >({
    mutationFn: (data) =>
      client.post("/assistant/chat", data).then((r) => r.data),
  });
}

// --- Settings ---

interface SystemConfigData {
  config: Record<string, unknown>;
}

export function useSystemConfig() {
  return useQuery<SystemConfigData>({
    queryKey: ["settings", "config"],
    queryFn: () => client.get("/settings/config").then((r) => r.data),
  });
}

// --- Conflict Groups ---

export function useConflictGroups(params?: Record<string, unknown>) {
  const search = new URLSearchParams();
  if (params?.status) search.set("status", String(params.status));
  const qs = search.toString();
  return useQuery<{ groups: import("../types").ConflictGroup[]; total: number }>({
    queryKey: ["conflict-groups", qs],
    queryFn: () =>
      client.get(`/pipeline/conflict-groups${qs ? `?${qs}` : ""}`).then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useConflictGroupStats() {
  return useQuery<{
    total: number;
    pending_review: number;
    approved: number;
    rejected: number;
  }>({
    queryKey: ["conflict-groups", "stats"],
    queryFn: () => client.get("/pipeline/conflict-groups/stats").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useReviewConflictGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: number; status: string; reviewer_note?: string }) =>
      client
        .post(`/pipeline/conflict-groups/${data.id}/review`, {
          status: data.status,
          reviewer_note: data.reviewer_note || "",
        })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conflict-groups"] });
    },
  });
}

export function useDeleteConflictGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      client.delete(`/pipeline/conflict-groups/${id}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conflict-groups"] });
    },
  });
}

// --- Ingestion Queue ---

export function useIngestionStats() {
  return useQuery<IngestionStats>({
    queryKey: ["ingestion", "stats"],
    queryFn: () => client.get("/ingestion/stats").then((r) => r.data),
    refetchInterval: 10_000,
  });
}

export interface HandlerMetadata {
  handler_type: string;
  label: string;
  source_type: string;
  uri_pattern: string;
  uri_hint: string;
  config_hints: Record<string, unknown>;
  artifact_kind: string;
}

export function useIngestionHandlers() {
  return useQuery<{ handlers: HandlerMetadata[] }>({
    queryKey: ["ingestion", "handlers"],
    queryFn: () => client.get("/ingestion/handlers").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export interface SchemaSyncEntry {
  collection: string;
  schema_version: number;
  expected_version: number;
  upgrade_pending: boolean;
  last_reset_at: string | null;
  last_reported_by: string | null;
  updated_at: string | null;
}

export interface SchemaSyncResponse {
  expected_version: number;
  upgrade_pending: boolean;
  syncs: SchemaSyncEntry[];
}

export function useSchemaSync() {
  return useQuery<SchemaSyncResponse>({
    queryKey: ["ingestion", "schema-sync"],
    queryFn: () => client.get("/ingestion/schema-sync").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useResetMilvusCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { confirm: string; reset_queue?: boolean }) =>
      client.post("/ingestion/milvus/reset-catalog", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useIngestionSources() {
  return useQuery<{ sources: IngestionSource[] }>({
    queryKey: ["ingestion", "sources"],
    queryFn: () => client.get("/ingestion/sources").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useCreateIngestionSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      handler: string;
      domain?: string;
      authority?: string;
      origin_type?: string;
      config?: Record<string, unknown>;
      tags?: string[];
      visibility_scope?: string;
      org_id?: string;
      tenant_id?: string;
      acl_mode?: string;
      acl_groups?: string;
    }) => client.post("/ingestion/sources", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useIngestionItems(params?: {
  status?: string;
  handler?: string;
  domain?: string;
  source_id?: number;
  page?: number;
  page_size?: number;
}) {
  return useQuery<{ items: IngestionItem[]; total: number; page: number; page_size: number }>({
    queryKey: ["ingestion", "items", params],
    queryFn: () => client.get("/ingestion/items", { params }).then((r) => r.data),
    refetchInterval: 15_000,
  });
}

export function useAddIngestionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      uri: string;
      handler?: string;
      title?: string;
      domain?: string;
      authority?: string;
      origin_type?: string;
      tags?: string[];
      priority?: number;
      config?: Record<string, unknown>;
    }) => client.post("/ingestion/items", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useAddIngestionItemsBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      items: Array<{
        uri: string;
        handler?: string;
        title?: string;
        domain?: string;
        authority?: string;
        tags?: string[];
        priority?: number;
        config?: Record<string, unknown>;
      }>;
    }) => client.post("/ingestion/items/bulk", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useDeleteIngestionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      client.delete(`/ingestion/items/${id}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useRetryIngestionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      client.post(`/ingestion/items/${id}/retry`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function usePatchIngestionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      itemId: number;
      title?: string;
      handler?: string;
      domain?: string;
      authority?: string;
      origin_type?: string;
      tags?: string[];
      priority?: number;
      config?: Record<string, unknown>;
      source_id?: number;
      status?: string;
    }) => {
      const { itemId, ...body } = data;
      return client.patch(`/ingestion/items/${itemId}`, body).then((r) => r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useRequeueIngestionItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { itemId: number; reset_retries?: boolean }) =>
      client
        .post(`/ingestion/items/${data.itemId}/requeue?reset_retries=${data.reset_retries ?? false}`)
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export interface DiscoveryResult {
  url: string;
  handler: string;
  title: string;
  domain: string;
  tags: string[];
  config: Record<string, unknown>;
  risk_flags: string[];
  recommended_mode: "active" | "batch";
  notes: string;
}

export function useBatchPreflight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { status_filter?: string; limit?: number; use_llm?: boolean }) =>
      client.post("/ingestion/discover/batch", data).then((r) => r.data as { processed: number; flagged: number; errors: number }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useDiscoverUrl() {
  return useMutation({
    mutationFn: (data: { url: string; hints?: string; use_llm?: boolean; model_id?: string }) =>
      client.post("/ingestion/discover", data).then((r) => r.data as DiscoveryResult),
  });
}

export function useRerunStagedItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { itemId: number; phase: "all" | "fetch" | "normalize" | "enrich"; reset_retries?: boolean }) =>
      client
        .post(`/ingestion/staged/items/${data.itemId}/rerun`, {
          phase: data.phase,
          reset_retries: data.reset_retries ?? true,
        })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useRecoverStaleIngestionLeases() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { stale_minutes: number }) =>
      client.post("/ingestion/staged/leases/recover", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

export function useStagedItemDocuments(itemId: number | null) {
  return useQuery<{ documents: StagedIngestionDocument[] }>({
    queryKey: ["ingestion", "staged-documents", itemId],
    queryFn: () => client.get(`/ingestion/staged/items/${itemId}/documents`).then((r) => r.data),
    enabled: typeof itemId === "number" && itemId > 0,
    refetchInterval: 15_000,
  });
}

export function useEditStagedDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      documentId: number;
      title?: string;
      domain?: string;
      authority?: string;
      origin_type?: string;
      tags?: string[];
      config_snapshot?: Record<string, unknown>;
    }) =>
      client
        .patch(`/ingestion/staged/documents/${data.documentId}`, {
          title: data.title,
          domain: data.domain,
          authority: data.authority,
          origin_type: data.origin_type,
          tags: data.tags,
          config_snapshot: data.config_snapshot,
        })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
      qc.invalidateQueries({ queryKey: ["ingestion", "staged-documents"] });
    },
  });
}

export function useIngestionRuns() {
  return useQuery<{ runs: IngestionRun[] }>({
    queryKey: ["ingestion", "runs"],
    queryFn: () => client.get("/ingestion/runs").then((r) => r.data),
    refetchInterval: 15_000,
  });
}

export function useBootstrapIngestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { file: File; status_override?: string }) => {
      const form = new FormData();
      form.append("file", data.file);
      const params = data.status_override ? `?status_override=${data.status_override}` : "";
      return client.post(`/ingestion/bootstrap${params}`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      }).then((r) => r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion"] });
    },
  });
}

// --- Usage Rollups ---

export interface UsageRollupEntry {
  bucket: string;
  model: string;
  role: string;
  user_id: string;
  org_id: string;
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  actual_cost_usd: number;
  avg_duration_ms: number;
  error_count: number;
}

export interface UsageSummary {
  period_hours: number;
  total_requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  actual_cost_usd: number;
  avg_duration_ms: number;
  error_count: number;
}

export function useUsageSeries(sinceHours = 24) {
  return useQuery<UsageRollupEntry[]>({
    queryKey: ["usage", "series", sinceHours],
    queryFn: () => client.get(`/usage?since_hours=${sinceHours}`).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export function useUsageSummary(sinceHours = 24) {
  return useQuery<UsageSummary>({
    queryKey: ["usage", "summary", sinceHours],
    queryFn: () => client.get(`/usage/summary?since_hours=${sinceHours}`).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

// --- Yarn Ops ---

export interface YarnOverview {
  since_hours: number;
  total_requests: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens_cached: number;
  total_cost_usd: number;
  avg_latency_ms: number;
  p99_latency_ms: number;
  error_count: number;
  error_rate: number;
  escalation_count: number;
  total_tool_calls: number;
  active_sessions: number;
}

export interface YarnPerformanceBucket {
  bucket: string | null;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cost_usd: number;
  avg_latency_ms: number;
  max_latency_ms: number;
  escalations: number;
  errors: number;
}

export interface YarnIntelligence {
  since_hours: number;
  requests: number;
  avg_tool_calls_per_request: number;
  cache_hit_estimate: number;
  tool_use_stop_rate: number;
  error_like_rate: number;
  top_models: Array<{ model: string; requests: number; cost_usd: number }>;
  finish_reason_counts: Record<string, number>;
}

export interface YarnRuntimeTelemetry {
  timestamp: number;
  toolResultReduction?: {
    rawCharsTotal: number;
    reducedCharsTotal: number;
    reducedCount: number;
    artifactHandleCount: number;
    tokensSavedEstimateTotal: number;
    fallbackToArtifactCount: number;
    reducerFailures: number;
    byFamily: Record<string, number>;
    lifecycle: Record<string, { lifecycle: string; successes: number; failures: number; lastError?: string }>;
  };
  sawtoothContext?: {
    compactionCount: number;
    totalCharsBefore: number;
    totalCharsAfter: number;
    compactionFailures: number;
  };
}

export interface YarnSessionRow {
  id: number;
  session_key: string;
  user_id: string;
  username: string | null;
  role: string | null;
  conversation_id: string | null;
  client_kind: string | null;
  provider: string | null;
  model: string | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens_cached: number;
  total_cost_usd: number;
  request_count: number;
  escalation_count: number;
  created_at: string | null;
  last_active_at: string | null;
}

export interface YarnSessionRequestRow {
  id: number;
  request_id: string;
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  latency_ms: number;
  cost_usd: number;
  escalated: boolean;
  tool_calls_count: number;
  finish_reason: string | null;
  created_at: string | null;
}

export interface YarnSessionEventRow {
  id: number;
  event_kind: string;
  component: string;
  detail: string;
  request_id: string | null;
  metadata_json: Record<string, unknown> | null;
  created_at: string | null;
}

export interface YarnSessionDetailResponse {
  session: YarnSessionRow;
  requests: YarnSessionRequestRow[];
  events: YarnSessionEventRow[];
}

export interface YarnEventRow {
  id: number;
  session_key: string;
  request_id: string;
  user_id: string;
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  latency_ms: number;
  cost_usd: number;
  escalated: boolean;
  tool_calls_count: number;
  finish_reason: string | null;
  created_at: string | null;
}

export interface YarnHealthResult {
  name: string;
  status: string;
  status_code: number | null;
  latency_ms: number;
  error: string | null;
  category: string;
}

export interface YarnVerifyCheck {
  check: string;
  status: string;
  status_code?: number;
  error?: string;
}

export interface YarnVerifyResult {
  overall: string;
  checks: YarnVerifyCheck[];
}

export function useYarnOverview(sinceHours: number) {
  return useQuery<YarnOverview>({
    queryKey: ["yarn", "overview", sinceHours],
    queryFn: () =>
      client.get("/yarn/overview", { params: { since_hours: sinceHours } }).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export function useYarnPerformance(sinceHours: number, bucketMinutes = 15) {
  return useQuery<YarnPerformanceBucket[]>({
    queryKey: ["yarn", "performance", sinceHours, bucketMinutes],
    queryFn: () =>
      client
        .get("/yarn/performance", {
          params: { since_hours: sinceHours, bucket_minutes: bucketMinutes },
        })
        .then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export function useYarnIntelligence(sinceHours: number) {
  return useQuery<YarnIntelligence>({
    queryKey: ["yarn", "intelligence", sinceHours],
    queryFn: () =>
      client.get("/yarn/intelligence", { params: { since_hours: sinceHours } }).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export function useYarnRuntimeTelemetry() {
  return useQuery<YarnRuntimeTelemetry>({
    queryKey: ["yarn", "runtime-telemetry"],
    queryFn: () => client.get("/yarn/runtime-telemetry").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useYarnSessions(page: number, pageSize: number, activeSinceHours = 168) {
  return useQuery<{ sessions: YarnSessionRow[]; total: number }>({
    queryKey: ["yarn", "sessions", page, pageSize, activeSinceHours],
    queryFn: () =>
      client
        .get("/yarn/sessions", { params: { page, page_size: pageSize, active_since_hours: activeSinceHours } })
        .then((r) => r.data),
    placeholderData: keepPreviousData,
  });
}

export function useYarnSessionDetail(sessionKey: string | undefined) {
  return useQuery<YarnSessionDetailResponse>({
    queryKey: ["yarn", "session", sessionKey],
    queryFn: () =>
      client.get(`/yarn/sessions/${encodeURIComponent(sessionKey!)}`).then((r) => r.data),
    enabled: Boolean(sessionKey),
  });
}

export interface YarnPurgeResult {
  dry_run: boolean;
  sessions: number;
  usage_rows: number;
  events: number;
}

export function useYarnSessionsPurge() {
  const qc = useQueryClient();
  return useMutation<YarnPurgeResult, Error, { older_than_days: number; session_key_prefix?: string; dry_run: boolean }>({
    mutationFn: (params) =>
      client.post("/yarn/sessions/purge", null, { params }).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["yarn"] });
    },
  });
}

export function useYarnEvents(
  page: number,
  pageSize: number,
  sinceHours: number,
  errorsOnly: boolean,
) {
  return useQuery<{ events: YarnEventRow[]; total: number }>({
    queryKey: ["yarn", "events", page, pageSize, sinceHours, errorsOnly],
    queryFn: () =>
      client
        .get("/yarn/events", {
          params: {
            page,
            page_size: pageSize,
            since_hours: sinceHours,
            errors_only: errorsOnly,
          },
        })
        .then((r) => r.data),
    placeholderData: keepPreviousData,
  });
}

export function useYarnHealth() {
  return useQuery<YarnHealthResult>({
    queryKey: ["yarn", "health"],
    queryFn: () => client.get("/yarn/health").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useYarnVerify() {
  const qc = useQueryClient();
  return useMutation<YarnVerifyResult>({
    mutationFn: () => client.post("/yarn/verify").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["yarn", "health"] });
    },
  });
}

// --- Yarn User Usage ---

export interface YarnUserUsage {
  user_id: string;
  since_hours: number;
  total_requests: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cost_usd: number;
  avg_latency_ms: number;
  escalations: number;
  errors: number;
}

export function useYarnUserUsage(sinceHours = 720) {
  return useQuery<YarnUserUsage>({
    queryKey: ["yarn", "user-usage", sinceHours],
    queryFn: () =>
      client
        .get("/yarn/user-usage", { params: { since_hours: sinceHours } })
        .then((r) => r.data),
    refetchInterval: 120_000,
  });
}

// --- Security / Guardrails ---

export interface SecurityEventRow {
  id: number;
  event_id: string;
  created_at: string | null;
  event_type: string;
  severity: string;
  confidence: number;
  confidence_band: string;
  action_taken: string;
  scope: string;
  service: string;
  request_id: string;
  session_id: string;
  user_id: string;
  token_id: string;
  org_id: string;
  patterns_found: string[];
  excerpt: string;
  scanner_name: string;
  latency_ms: number;
  detail: Record<string, unknown>;
  resolved: boolean;
  resolved_by: string;
  resolved_action: string;
  resolved_reason: string;
  resolved_at: string | null;
}

export interface SecuritySummary {
  total: number;
  unresolved: number;
  by_severity: Record<string, number>;
  by_type: Record<string, number>;
  since_hours: number;
}

export function useSecurityEvents(params: {
  limit?: number;
  before_id?: number;
  severity?: string;
  event_type?: string;
  service?: string;
  resolved?: boolean;
  since_hours?: number;
}) {
  return useQuery<{ events: SecurityEventRow[] }>({
    queryKey: ["security", "events", params],
    queryFn: () =>
      client.get("/security/events", { params }).then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useSecuritySummary(sinceHours: number) {
  return useQuery<SecuritySummary>({
    queryKey: ["security", "summary", sinceHours],
    queryFn: () =>
      client
        .get("/security/summary", { params: { since_hours: sinceHours } })
        .then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useResolveSecurityEvent() {
  const qc = useQueryClient();
  return useMutation<
    SecurityEventRow,
    Error,
    { event_id: string; action: string; reason: string }
  >({
    mutationFn: ({ event_id, ...body }) =>
      client
        .post(`/security/events/${event_id}/resolve`, body)
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["security"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Authorization / OpenFGA
// ---------------------------------------------------------------------------

export interface AuthzStatus {
  engine: string;
  evaluations: number;
  rejections: number;
  openfga_configured: boolean;
  recent_events: Array<{
    trace_id: string;
    resource: string;
    action: string;
    allow: boolean;
    matched_rules: string[];
    user_id: string;
    timestamp: number;
  }>;
  store: { store_id: string; api_url: string } | null;
  latest_model: { id: string; type_definitions_count: number } | null;
}

export function useAuthzStatus() {
  return useQuery<AuthzStatus>({
    queryKey: ["authz", "status"],
    queryFn: () => client.get("/authz/status").then((r) => r.data),
    refetchInterval: 15_000,
  });
}

export interface AuthzTuple {
  user: string;
  relation: string;
  object: string;
  timestamp?: string;
}

export function useAuthzTuples(filters: { user?: string; relation?: string; object?: string }) {
  return useQuery<{ tuples: AuthzTuple[]; count: number }>({
    queryKey: ["authz", "tuples", filters],
    queryFn: () => client.get("/authz/tuples", { params: filters }).then((r) => r.data),
  });
}

export function useWriteAuthzTuple() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { user: string; relation: string; object: string }) =>
      client.post("/authz/tuples", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["authz"] });
    },
  });
}

export function useDeleteAuthzTuple() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { user: string; relation: string; object: string }) =>
      client.delete("/authz/tuples", { data }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["authz"] });
    },
  });
}

export interface AuthzCheckResult {
  user: string;
  relation: string;
  object: string;
  allowed: boolean;
}

export function useRunAuthzCheck() {
  return useMutation<AuthzCheckResult, Error, { user: string; relation: string; object: string }>({
    mutationFn: (data) => client.post("/authz/check", data).then((r) => r.data),
  });
}

export interface AuthzUserPermissions {
  user_id: string;
  fga_user: string;
  direct_tuples: AuthzTuple[];
  computed_checks: Record<string, boolean>;
}

export function useAuthzUserPermissions(userId: string) {
  return useQuery<AuthzUserPermissions>({
    queryKey: ["authz", "user-permissions", userId],
    queryFn: () => client.get(`/authz/user-permissions/${userId}`).then((r) => r.data),
    enabled: !!userId,
  });
}

export interface AuthzSchemaType {
  type: string;
  relations: Record<string, { directly_related: string[] }>;
}

export function useAuthzSchemaTypes() {
  return useQuery<{ types: AuthzSchemaType[]; model_id: string | null }>({
    queryKey: ["authz", "schema-types"],
    queryFn: () => client.get("/authz/schema-types").then((r) => r.data),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Model Policies — conditional model selection rules
// ---------------------------------------------------------------------------

export interface PolicyRule {
  id?: number;
  role?: string;
  priority: number;
  condition_type: string;
  condition_value: string;
  model: string;
  label: string;
  enabled: boolean;
}

export function useModelPolicies() {
  return useQuery<{ policies: Record<string, PolicyRule[]> }>({
    queryKey: ["models", "policies"],
    queryFn: () => client.get("/models/policies").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useRolePolicies(role: string) {
  return useQuery<{ role: string; rules: PolicyRule[]; preview: Record<string, string> }>({
    queryKey: ["models", "policies", role],
    queryFn: () => client.get(`/models/policies/${role}`).then((r) => r.data),
    enabled: !!role,
  });
}

export function useSaveRolePolicies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role, rules }: { role: string; rules: Omit<PolicyRule, "id">[] }) =>
      client.put(`/models/policies/${role}`, rules).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "policies"] });
      qc.invalidateQueries({ queryKey: ["pipeline", "graph"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteRolePolicies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (role: string) =>
      client.delete(`/models/policies/${role}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models", "policies"] });
      qc.invalidateQueries({ queryKey: ["pipeline", "graph"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export interface EffortRecommendationPreviewRequest {
  prompt: string;
  effort_mode?: "auto" | "pulse" | "core" | "horizon" | null;
  include_frame?: boolean;
  operational_health?: number | null;
}

export interface EffortRecommendationPreviewResponse {
  requested_mode: "auto" | "pulse" | "core" | "horizon";
  selected_mode: "pulse" | "core" | "horizon";
  recommendation: {
    recommended_mode: "pulse" | "core" | "horizon";
    confidence: number;
    reasons: string[];
    routing_signals: {
      complexity: number;
      ambiguity: number;
      risk: number;
      scope: number;
      user_intent: number;
      operational_health: number;
    };
  };
  classification: Record<string, unknown>;
  policy: {
    retrieval_depth: number;
    tool_budget: number;
    critique_passes: number;
    planner_depth: number;
    context_budget: number;
    graph_variant: string;
    response_depth: string;
  };
}

export function useEffortRecommendationPreview() {
  return useMutation<EffortRecommendationPreviewResponse, Error, EffortRecommendationPreviewRequest>({
    mutationFn: (data) => client.post("/models/effort/recommend", data).then((r) => r.data),
  });
}
