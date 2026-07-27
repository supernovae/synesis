import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import client from "./client";
import type {
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
  CacheCanaryReportObservability,
  TokenEconomicsObservability,
  CircuitBreakerState,
  BenchmarkResults,
  RagEvalResult,
  RagEvalSuiteInfo,
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
// --- RAG ---

export function useCorpusStats() {
  return useQuery<CorpusStats>({
    queryKey: ["rag", "corpus"],
    queryFn: () => apiGet("/rag/corpus"),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useQualitySummary() {
  return useQuery<QualitySummary>({
    queryKey: ["rag", "quality"],
    queryFn: () => apiGet("/rag/quality"),
  });
}

export function useQualityDomains(params?: { sort?: string; health?: string }) {
  return useQuery<{ domains: DomainScorecard[] }>({
    queryKey: ["rag", "quality", "domains", params],
    queryFn: () =>
      apiGet("/rag/quality/domains", { params }),
  });
}

export function useQualityDomain(key: string) {
  return useQuery<DomainScorecard>({
    queryKey: ["rag", "quality", "domains", key],
    queryFn: () =>
      apiGet(`/rag/quality/domains/${key}`),
    enabled: !!key,
  });
}

export function useBenchmarks() {
  return useQuery<BenchmarkResults & { run_id?: string; triggered_by?: string; started_at?: string }>({
    queryKey: ["rag", "benchmarks"],
    queryFn: () => apiGet("/rag/benchmarks"),
    staleTime: 5 * 60_000,
  });
}

export function useRagEvalSuites() {
  return useQuery<{ suites: RagEvalSuiteInfo[] }>({
    queryKey: ["evals", "rag", "suites"],
    queryFn: () => apiGet("/evals/rag/suites"),
    staleTime: 5 * 60_000,
  });
}

export function useLatestRagEval() {
  return useQuery<RagEvalResult>({
    queryKey: ["evals", "rag", "latest"],
    queryFn: () => apiGet("/evals/rag/latest"),
    staleTime: 60_000,
  });
}

export function useRunRagEval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { suite_name: string; top_k?: number }) =>
      apiPost<RagEvalResult>("/evals/rag/run", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["evals", "rag"] });
      qc.invalidateQueries({ queryKey: ["rag", "benchmarks"] });
    },
  });
}

export interface ContentPackEntry {
  pack_id: string;
  name: string;
  description: string;
  version: string;
  download_url: string;
  sha256: string;
  size_bytes: number;
  domain: string;
  language: string;
  content_type?: string;
  source_version?: string;
  source_release?: string;
  install_profile?: string;
  node_count?: number;
  edge_count?: number;
  example_count?: number;
  context_card_count?: number;
  pack_card_count?: number;
  anti_pattern_count?: number;
  pack_type?: string;
  endpoint?: Record<string, unknown>;
  endpoints?: Array<Record<string, unknown>>;
  delivery_modes?: string[];
  taxonomy_domains?: string[];
  routing_aliases?: string[];
  quality_score?: number;
  trust_score?: number;
  freshness_score?: number;
  requires_bulk_import?: boolean;
  tags: string[];
  created_at?: string;
  install_status?: "installed" | "update_available" | "not_installed";
  installed?: InstalledContentPack | null;
  quality?: ContentPackQualityReport | null;
}

export interface InstalledContentPack {
  pack_id: string;
  pack_version: string;
  pack_source_version: string;
  language: string;
  domain: string;
  pack_artifact_hash: string;
  row_count: number;
  quality?: ContentPackQualityReport | null;
}

export interface ContentPackQualityReport {
  pack_id: string;
  node_count: number;
  chunk_count: number;
  example_count: number;
  context_card_count: number;
  pack_card_count?: number;
  anti_pattern_count: number;
  constraint_count: number;
  external_ref_count: number;
  edge_count: number;
  source_version?: string;
  source_release?: string;
  quality_score?: number;
  trust_score?: number;
  freshness_score?: number;
  node_kind_counts?: Record<string, number>;
  edge_type_counts?: Record<string, number>;
}

export interface RagDegradedWarning {
  component: string;
  operation: string;
  message: string;
}

export interface ContentPackInstallJob {
  id: number;
  pack_id: string;
  pack_version: string;
  download_url: string;
  sha256: string;
  size_bytes: number;
  replace_existing: boolean;
  status: string;
  requested_by: string;
  claimed_by: string;
  result?: Record<string, unknown> | null;
  error_message: string;
  attempt_count: number;
  max_attempts: number;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
}

export interface ContentPacksOverview {
  config: {
    catalog_url: string;
    configured_catalog_url?: string;
    default_catalog_url?: string;
    using_default?: boolean;
    updated_by?: string;
    updated_at?: string | null;
  };
  catalog: {
    catalog_url: string;
    name?: string;
    version?: string;
    packs: ContentPackEntry[];
    errors: string[];
    ok: boolean;
    degraded?: boolean;
    warnings?: RagDegradedWarning[];
  };
  installed: InstalledContentPack[];
  quality_reports?: ContentPackQualityReport[];
  jobs: ContentPackInstallJob[];
  degraded?: boolean;
  warnings?: RagDegradedWarning[];
}

export function useContentPacks() {
  return useQuery<ContentPacksOverview>({
    queryKey: ["rag", "content-packs"],
    queryFn: () => apiGet("/rag/content-packs"),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useUpdateContentPackCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (catalog_url: string) =>
      apiPut("/rag/content-packs/config", { catalog_url }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rag", "content-packs"] }),
  });
}

export function useInstallContentPack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { pack_id: string; version?: string; replace?: boolean }) =>
      apiPost("/rag/content-packs/install", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rag", "content-packs"] }),
  });
}

export function useRetryContentPackInstallJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: number) =>
      apiPost(`/rag/content-packs/install-jobs/${jobId}/retry`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rag", "content-packs"] }),
  });
}

// --- Taxonomy ---

export function useTaxonomy() {
  return useQuery<{ domains: TaxonomyDomain[] }>({
    queryKey: ["taxonomy"],
    queryFn: () => apiGet("/taxonomy"),
  });
}

export function useTaxonomyDomain(key: string) {
  return useQuery<TaxonomyDomain>({
    queryKey: ["taxonomy", key],
    queryFn: () => apiGet(`/taxonomy/${key}`),
    enabled: !!key,
  });
}

export function useUpdateTaxonomyDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      key: string;
      path?: string;
      complexity?: number;
      persona?: string;
      required_elements?: string[];
      depth_instructions?: string;
      output_style_guidance?: string;
      calibration_guidance?: string;
    }) =>
      apiPut(`/taxonomy/${data.key}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["taxonomy"] }),
  });
}

export function useSyncTaxonomyFromYaml() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost("/taxonomy/sync-from-yaml"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["taxonomy"] }),
  });
}

export function useExportTaxonomyYaml() {
  return useMutation({
    mutationFn: () => apiPost("/taxonomy/export-yaml"),
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
    queryFn: () => apiGet("/pipeline/graph"),
  });
}

export function usePipelineMetrics() {
  return useQuery<{ nodes: PipelineMetrics[] }>({
    queryKey: ["pipeline", "metrics"],
    queryFn: () => apiGet("/pipeline/metrics"),
    refetchInterval: 30_000,
  });
}

export function useCriticStats() {
  return useQuery<CriticStats>({
    queryKey: ["pipeline", "critic"],
    queryFn: () => apiGet("/pipeline/critic"),
    refetchInterval: 30_000,
  });
}

export function useCriticDetailed(days: number = 7) {
  return useQuery<CriticDetailed>({
    queryKey: ["pipeline", "critic", "detailed", days],
    queryFn: () =>
      apiGet("/pipeline/critic/detailed", { params: { days } }),
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
      apiGet("/pipeline/critic/evaluations", { params }),
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
    queryFn: () => apiGet("/pipeline/critic/models"),
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
    mutationFn: (data) => apiPost("/pipeline/critic/run", data),
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
      apiPost("/traces/purge-trivial", null, { params }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["traces"] });
      qc.invalidateQueries({ queryKey: ["pipeline", "critic"] });
    },
  });
}

export function useDeleteTrace() {
  const qc = useQueryClient();
  return useMutation<{ deleted: string }, Error, string>({
    mutationFn: (traceId) => apiDelete(`/traces/${traceId}`),
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
      apiPost("/traces/bulk-delete", traceIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["traces"] });
      qc.invalidateQueries({ queryKey: ["pipeline", "critic"] });
    },
  });
}

export interface TraceArchiveResult {
  dry_run: boolean;
  delete_after_archive: boolean;
  matched: number;
  selected: number;
  limited: boolean;
  archive: { archive_id: string; bucket: string; key: string; record_count: number; bytes: number } | null;
  deleted: number;
}

export function useArchiveTraces() {
  const qc = useQueryClient();
  return useMutation<
    TraceArchiveResult,
    Error,
    {
      trace_ids?: string[];
      older_than_days?: number;
      trace_service?: string;
      dry_run?: boolean;
      delete_after_archive?: boolean;
    }
  >({
    mutationFn: (data) => apiPost("/traces/archive", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["traces"] });
      qc.invalidateQueries({ queryKey: ["pipeline", "critic"] });
    },
  });
}

export function usePurgeOldTraces() {
  const qc = useQueryClient();
  return useMutation<
    TraceArchiveResult,
    Error,
    { older_than_days: number; trace_service?: string; dry_run?: boolean; archive_before_delete?: boolean }
  >({
    mutationFn: (params) => apiPost("/traces/purge", null, { params }),
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
      apiPost("/pipeline/critic/clear", { trace_id: traceId }),
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
    queryFn: () => apiGet("/integrations/mcp/tools"),
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
    queryFn: () => apiGet("/integrations/web-search"),
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
  org_id: string;
  user_id: string;
  tenant_id: string;
  request_id: string;
  session_key: string;
  conversation_id: string;
  trace_id: string;
  source_surface: string;
  tool_name: string;
  query_hash: string;
  rate_bucket_key: string;
  blocked_reason: string;
  policy_action: string;
  token_estimate: number;
}

export function useWebSearchLog(params?: {
  domain?: string | undefined;
  outcome?: string | undefined;
  source_surface?: string | undefined;
  org_id?: string | undefined;
  user_id?: string | undefined;
  session_key?: string | undefined;
  request_id?: string | undefined;
  trace_id?: string | undefined;
  tool_name?: string | undefined;
  engine?: string | undefined;
  q?: string | undefined;
  page?: number;
  page_size?: number;
}) {
  return useQuery<{ items: WebSearchLogEntry[]; total: number; page: number; page_size: number }>({
    queryKey: ["integrations", "web-search", "log", params],
    queryFn: () =>
      apiGet("/integrations/web-search/log", { params }),
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
      apiGet("/integrations/web-search/log/domains"),
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
      apiGet("/integrations/web-search/policies"),
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
    }) => apiPost("/integrations/web-search/policies", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "web-search", "policies"] });
    },
  });
}

export function useDeleteWebSearchPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiDelete(`/integrations/web-search/policies/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "web-search", "policies"] });
    },
  });
}

export function useIngestWebUrl() {
  return useMutation({
    mutationFn: (data: { url: string; title?: string; reason?: string }) =>
      apiPost("/integrations/web-search/ingest", data),
  });
}

// --- Feedback ---

export function useFeedback(params?: {
  vote?: string | undefined;
  limit?: number;
  source?: string | undefined;
  review_status?: string | undefined;
  offset?: number;
}) {
  return useQuery<{ entries: FeedbackEntry[]; total: number }>({
    queryKey: ["feedback", params],
    queryFn: () => apiGet("/feedback", { params }),
  });
}

export function useSyncOpenWebUIFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost("/feedback/sync-openwebui"),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["feedback"] });
      await qc.refetchQueries({ queryKey: ["feedback"] });
    },
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
    }) => apiPatch("/feedback/workspace", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["feedback"] }),
  });
}

export function useKnowledgeGaps(params?: { domain?: string; page?: number }) {
  return useQuery<{ gaps: KnowledgeGap[]; total: number }>({
    queryKey: ["feedback", "knowledge-gaps", params],
    queryFn: () =>
      apiGet("/feedback/knowledge-gaps", { params }),
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
    queryFn: () => apiGet("/feedback/curator"),
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
    queryFn: () => apiGet("/observability/health"),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useCacheMetrics() {
  return useQuery<CacheMetrics>({
    queryKey: ["observability", "cache"],
    queryFn: () => apiGet("/observability/cache"),
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
      apiGet("/observability/compaction", { params: { since_hours: sinceHours, service } }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useCacheHistory(sinceHours = 24, service = "") {
  return useQuery<{ snapshots: import("../types").CacheHistorySnapshot[]; count: number }>({
    queryKey: ["observability", "cache-history", sinceHours, service],
    queryFn: () =>
      apiGet("/observability/cache/history", { params: { since_hours: sinceHours, service } }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useTokenEconomicsMetrics(sinceHours = 24) {
  return useQuery<TokenEconomicsObservability>({
    queryKey: ["observability", "token-economics", sinceHours],
    queryFn: () =>
      apiGet("/observability/cache/token-economics", { params: { since_hours: sinceHours } }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useCacheCanaryReport() {
  return useQuery<CacheCanaryReportObservability>({
    queryKey: ["observability", "cache-canary-report"],
    queryFn: () => apiGet("/observability/cache/canary-report"),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useCircuitBreakers() {
  return useQuery<{ breakers: CircuitBreakerState[] }>({
    queryKey: ["observability", "circuit-breakers"],
    queryFn: () =>
      apiGet("/observability/circuit-breakers"),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useFailures(params?: {
  language?: string | undefined;
  error_type?: string | undefined;
  page?: number;
  page_size?: number;
}) {
  return useQuery<{ failures: FailureRecord[]; total: number }>({
    queryKey: ["observability", "failures", params],
    queryFn: () =>
      apiGet("/observability/failures", { params }),
  });
}

export function useDeleteFailure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (failureId: string) =>
      apiDelete(`/observability/failures/${failureId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "failures"] });
    },
  });
}

export function useBulkDeleteFailures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (failureIds: string[]) =>
      apiPost("/observability/failures/bulk-delete", { failure_ids: failureIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "failures"] });
    },
  });
}

export function usePurgeFailures() {
  const qc = useQueryClient();
  return useMutation<{ deleted: number; resolved_only: boolean }, Error, boolean>({
    mutationFn: (resolvedOnly) =>
      apiDelete("/observability/failures", { params: { resolved_only: resolvedOnly } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["observability", "failures"] });
    },
  });
}

export function useFailureDetail(id: string) {
  return useQuery<FailureRecord>({
    queryKey: ["observability", "failures", id],
    queryFn: () =>
      apiGet(`/observability/failures/${id}`),
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
      apiGet("/observability/failures/stats"),
  });
}

// --- Knowledge Gaps (Observability) ---

export function useObservabilityKnowledgeGaps(params?: {
  page?: number;
  page_size?: number;
  status?: string | undefined;
}) {
  return useQuery<{ gaps: KnowledgeGap[]; total: number }>({
    queryKey: ["observability", "knowledge-gaps", params],
    queryFn: () =>
      apiGet("/observability/knowledge-gaps", { params }),
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
    }) => apiPost("/observability/knowledge-gaps/bulk-action", data),
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
      apiDelete("/observability/knowledge-gaps", { params: { status } }),
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
      apiGet("/observability/knowledge-gaps/stats"),
  });
}

// --- Traces ---

export function useTraces(params?: {
  offset?: number;
  limit?: number;
  has_error?: boolean | undefined;
  user_id?: string | undefined;
  org_id?: string | undefined;
  task_type?: string | undefined;
  domain_tag?: string | undefined;
  max_tokens?: number | undefined;
  min_hallucinated_urls?: number | undefined;
  /** planner | yarn | all */
  trace_service?: string;
}) {
  return useQuery<{ traces: import("../types").TraceRecord[]; total: number }>({
    queryKey: ["traces", params],
    queryFn: () => apiGet("/traces", { params }),
    refetchInterval: 15_000,
  });
}

export function useTrace(traceId: string) {
  return useQuery<import("../types").TraceRecord>({
    queryKey: ["traces", traceId],
    queryFn: () => apiGet(`/traces/${traceId}`),
    enabled: !!traceId,
  });
}

export function useTraceChain(traceId: string, limit = 200) {
  return useQuery<{
    trace_id: string;
    root_trace_id?: string;
    conversation_id?: string;
    chain: import("../types").TraceRecord[];
  }>({
    queryKey: ["traces", traceId, "chain", limit],
    queryFn: () => apiGet(`/traces/${traceId}/chain`, { params: { limit } }),
    enabled: !!traceId,
  });
}

export function useTraceStats() {
  return useQuery<import("../types").TraceStats>({
    queryKey: ["traces", "stats"],
    queryFn: () => apiGet("/traces/stats"),
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
      apiPost("/assistant/chat", data),
  });
}

export function useSupportAssistantChat() {
  return useMutation<
    { response: string; tokens: number; model: string; tool_rounds?: number },
    Error,
    { message: string; context?: string }
  >({
    mutationFn: (data) =>
      apiPost("/assistant/support/chat", data),
  });
}

// --- Settings ---

interface SystemConfigData {
  config: Record<string, unknown>;
}

export function useSystemConfig() {
  return useQuery<SystemConfigData>({
    queryKey: ["settings", "config"],
    queryFn: () => apiGet("/settings/config"),
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
      apiGet(`/pipeline/conflict-groups${qs ? `?${qs}` : ""}`),
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
    queryFn: () => apiGet("/pipeline/conflict-groups/stats"),
    refetchInterval: 30_000,
  });
}

export function useReviewConflictGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: number; status: string; reviewer_note?: string }) =>
      apiPost(`/pipeline/conflict-groups/${data.id}/review`, {
          status: data.status,
          reviewer_note: data.reviewer_note || "",
        }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conflict-groups"] });
    },
  });
}

export function useDeleteConflictGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiDelete(`/pipeline/conflict-groups/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conflict-groups"] });
    },
  });
}
