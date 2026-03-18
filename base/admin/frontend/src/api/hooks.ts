import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import client from "./client";
import type {
  DashboardSummary,
  ModelEntry,
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
  ServiceStatus,
  FailureRecord,
  CacheMetrics,
  CircuitBreakerState,
  BenchmarkResults,
  IngestionSource,
  IngestionItem,
  IngestionRun,
  IngestionStats,
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

// --- Models ---

export function useModels() {
  return useQuery<{ models: ModelEntry[] }>({
    queryKey: ["models"],
    queryFn: () => client.get("/models").then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useModelCosts() {
  return useQuery<{ roles: ModelCost[] }>({
    queryKey: ["models", "costs"],
    queryFn: () => client.get("/models/costs").then((r) => r.data),
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

export function useFeedback(params?: { vote?: string; limit?: number }) {
  return useQuery<{ entries: FeedbackEntry[]; total: number }>({
    queryKey: ["feedback", params],
    queryFn: () => client.get("/feedback", { params }).then((r) => r.data),
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
  return useQuery<{ services: ServiceStatus[] }>({
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
  task_type?: string;
  domain_tag?: string;
  max_tokens?: number;
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
    { response: string; tokens: number; model: string },
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
