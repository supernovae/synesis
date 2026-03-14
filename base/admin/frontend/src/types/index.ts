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
}

export interface DashboardSummary {
  services: ServiceStatus[];
  metrics: {
    total_requests: number;
    error_rate: number;
    avg_latency_ms: number;
    cache_hit_rate: number;
    active_models: number;
  };
  cost_estimate: {
    period: string;
    total_usd: number;
    by_role: Record<string, number>;
  };
}

export interface ModelEntry {
  role: string;
  model_name: string;
  served_name: string;
  endpoint: string;
  status: "healthy" | "degraded" | "offline";
  description: string;
}

export interface ModelCost {
  role: string;
  model: string;
  input_per_million: number;
  output_per_million: number;
  estimated_monthly: number;
}

export interface CorpusStats {
  collection: string;
  total_chunks: number;
  total_documents: number;
  domains_covered: number;
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

export interface McpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  call_count?: number;
  avg_latency_ms?: number;
}

export interface FeedbackEntry {
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
  chunk_id: string;
  query: string;
  task_description: string;
  max_score: number;
  platform_context: string;
  timestamp: string;
  language: string;
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
}

export interface CircuitBreakerState {
  name: string;
  state: "closed" | "open" | "half_open";
  trips: number;
  last_trip: string | null;
}

export interface BenchmarkResults {
  aggregate: Record<string, number>;
  per_query: Array<Record<string, number>>;
  timestamp?: string;
}
