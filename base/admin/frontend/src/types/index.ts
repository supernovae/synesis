export interface User {
  username: string;
  role: "admin" | "readonly";
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface ServiceStatus {
  name: string;
  status: "ok" | "error" | "degraded";
  status_code: number | null;
  error: string | null;
  latency_ms?: number;
  category?: "infrastructure" | "model" | "model-gateway";
}

export interface DashboardSummary {
  services: ServiceStatus[];
  metrics: {
    total_requests: number;
    error_rate: number;
    avg_latency_ms: number;
    cache_hit_rate: number;
    active_models: number;
    traces_24h: number;
    total_cost_24h: number;
  };
  cost_estimate: {
    period: string;
    total_usd: number;
    by_role: Record<string, number>;
  };
}

export interface ModelEntry {
  [key: string]: unknown;
  role: string;
  model_name: string;
  served_name: string;
  endpoint: string;
  status: "healthy" | "degraded" | "offline";
  description: string;
}

export interface ModelCost {
  [key: string]: unknown;
  role: string;
  model: string;
  profile: string;
  source: "local" | "openrouter";
  input_per_million: number;
  output_per_million: number;
  monthly_fixed_cost: number;
  cost_formula: string;
  notes: string;
}

export interface ModelCostByModel {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
  cost_usd: number;
}

export interface CorpusStats {
  collection: string;
  total_chunks: number;
  total_documents: number;
  total_sources: number;
  domains_covered: number;
  schema_version: number;
}

export interface DomainScorecard {
  domain: string;
  path: string;
  health: "strong" | "adequate" | "weak" | "empty";
  inventory: {
    total_chunks: number;
    total_documents: number;
  };
  coverage: {
    hit_rate: number;
    mean_mrr: number;
  };
  dead_weight: {
    unretrieved_documents: number;
  };
}

export interface QualitySummary {
  strong: number;
  adequate: number;
  weak: number;
  empty: number;
  scorecards: DomainScorecard[];
}

export interface TaxonomyDomain {
  key: string;
  path: string;
  complexity: number;
  persona: string;
  children?: TaxonomyDomain[];
}

export interface PipelineMetrics {
  [key: string]: unknown;
  node: string;
  avg_confidence: number;
  avg_duration_ms: number;
  call_count: number;
}

export interface CriticStats {
  total_evaluations: number;
  approval_rate: number;
  rejection_rate: number;
  avg_score: number;
  blocking_issues: number;
}

export interface CriticDetailed {
  period_days: number;
  total_evaluated: number;
  approved: number;
  rejected: number;
  approval_rate: number;
  avg_scores: Record<string, number>;
  score_distribution: Array<{ bucket: string; count: number }>;
  top_failure_modes: Array<{ mode: string; count: number }>;
  rejection_reasons: Array<{
    trace_id: string;
    query_snippet: string;
    failure_modes: string[];
    score: number;
  }>;
}

export interface McpTool {
  [key: string]: unknown;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  call_count?: number;
  avg_latency_ms?: number;
}

export interface FeedbackEntry {
  [key: string]: unknown;
  message_id: string;
  run_id: string;
  vote: "up" | "down";
  user_id: string;
  model: string;
  message_snippet: string;
  response_snippet: string;
  timestamp: string;
}

export interface KnowledgeGap {
  [key: string]: unknown;
  chunk_id: string;
  query: string;
  task_description: string;
  max_score: number;
  platform_context: string;
  timestamp: string;
  language: string;
  status?: "open" | "resolved" | "reopened";
  resolved_by?: string;
  resolution_note?: string;
  resolved_at?: number;
  web_search_fallback?: boolean;
}

export interface CuratorProposal {
  id: string;
  domain: string;
  path: string;
  source_name: string;
  handler: string;
  url: string;
  quality_score: number;
  rationale: string;
  status: "pending" | "approved" | "rejected";
}

export interface FailureRecord {
  [key: string]: unknown;
  failure_id: string;
  code: string;
  error_output: string;
  exit_code: number;
  error_type: string;
  language: string;
  task_description: string;
  resolution: string;
  timestamp: string;
}

export interface CacheMetrics {
  exact_hits: number;
  semantic_hits: number;
  misses: number;
  evictions: number;
  entries: number;
  hit_rate: number;
  redis?: {
    status: string;
    used_memory_human?: string;
    keyspace_hits?: number;
    keyspace_misses?: number;
    keyspace_hit_rate?: number;
    total_keys?: number;
  };
  session?: {
    backend: string;
  };
  l2_archive?: {
    configured: boolean;
  };
}

export interface CircuitBreakerState {
  name: string;
  state: "closed" | "open" | "half_open";
  trips: number;
  last_trip: string | null;
  category?: "llm" | "web_search" | "infrastructure";
}

export interface BenchmarkResults {
  aggregate: Record<string, number>;
  per_query: Array<Record<string, number>>;
  timestamp?: string;
}

export interface ConflictGroup {
  [key: string]: unknown;
  id: number;
  group_name: string;
  members: string[];
  default_pick: string;
  exclusion_map: Record<string, string[]>;
  source_query: string;
  source_run_id: string;
  status: "pending_review" | "approved" | "rejected";
  reviewer_note: string;
  discovered_at: string;
  reviewed_at: string;
}

// --- Traces ---

export interface LLMCallRecord {
  model: string;
  node: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  prompt_snippet: string;
  completion_snippet: string;
  prompt_full?: string;
  completion_full?: string;
  timestamp: number;
}

export interface SpanRecord {
  node_name: string;
  intent?: string;
  start_time: number;
  end_time: number;
  latency_ms: number;
  tokens_used: number;
  confidence: number;
  outcome: string;
  reasoning: string;
  llm_calls: LLMCallRecord[];
}

export interface TraceRecord {
  trace_id: string;
  user_id: string;
  query_snippet: string;
  timestamp: number;
  total_duration_ms: number;
  total_tokens: number;
  estimated_cost_usd: number;
  difficulty: number;
  task_type: string;
  domain_tags: string[];
  is_code_task: boolean;
  has_error: boolean;
  iteration_count: number;
  spans: SpanRecord[];
  critic_scores: Record<string, unknown>;
  evidence_summary: Record<string, unknown>;
  taxonomy: Record<string, unknown>;
  phase_timings?: Record<string, number>;
}

export interface TraceStats {
  total_traces_24h: number;
  error_count_24h: number;
  error_rate: number;
  avg_duration_ms: number;
  avg_tokens: number;
  avg_cost_usd: number;
  total_cost_usd: number;
  traces_per_hour: number;
}
