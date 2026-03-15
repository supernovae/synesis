import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  McpTool,
  FeedbackEntry,
  KnowledgeGap,
  CuratorProposal,
  ServiceStatus,
  FailureRecord,
  CacheMetrics,
  CircuitBreakerState,
  BenchmarkResults,
} from "../types";

// --- Dashboard ---

export function useDashboardSummary() {
  return useQuery<DashboardSummary>({
    queryKey: ["dashboard", "summary"],
    queryFn: () => client.get("/dashboard/summary").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

// --- Models ---

export function useModels() {
  return useQuery<{ models: ModelEntry[] }>({
    queryKey: ["models"],
    queryFn: () => client.get("/models").then((r) => r.data),
  });
}

export function useModelCosts() {
  return useQuery<{ roles: ModelCost[] }>({
    queryKey: ["models", "costs"],
    queryFn: () => client.get("/models/costs").then((r) => r.data),
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
  return useQuery<BenchmarkResults>({
    queryKey: ["rag", "benchmarks"],
    queryFn: () => client.get("/rag/benchmarks").then((r) => r.data),
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
  });
}

export function useCacheMetrics() {
  return useQuery<CacheMetrics>({
    queryKey: ["observability", "cache"],
    queryFn: () => client.get("/observability/cache").then((r) => r.data),
    refetchInterval: 15_000,
  });
}

export function useCircuitBreakers() {
  return useQuery<{ breakers: CircuitBreakerState[] }>({
    queryKey: ["observability", "circuit-breakers"],
    queryFn: () =>
      client.get("/observability/circuit-breakers").then((r) => r.data),
    refetchInterval: 15_000,
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

// --- Traces ---

export function useTraces(params?: {
  offset?: number;
  limit?: number;
  has_error?: boolean;
  user_id?: string;
  task_type?: string;
  domain_tag?: string;
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
