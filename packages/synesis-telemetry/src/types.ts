export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens: number;
  cache_creation_tokens?: number;
  estimated_cost_usd: number;
  actual_cost_usd: number;
}

export interface PricingRates {
  input_per_million: number;
  output_per_million: number;
  cached_input_per_million: number | null;
  /** When null, cache_creation tokens use input_per_million in estimates. */
  cache_write_input_per_million?: number | null;
}

/**
 * Where pricing was resolved from — ordered by preference.
 * - provider:      the model provider reported a USD cost directly
 * - manual:        operator set rates in the admin Model Registry
 * - infra_calc:    computed from infrastructure cost (vLLM / KServe)
 * - api_lookup:    auto-resolved from provider pricing tables
 * - fallback_base: no source available; using platform-wide base defaults
 * - unknown:       no pricing information at all (should not persist)
 */
export type PricingSource =
  | "provider"
  | "manual"
  | "infra_calc"
  | "api_lookup"
  | "fallback_base"
  | "unknown";

export interface CostResult {
  estimated_cost_usd: number;
  pricing_source: PricingSource;
}

export interface UsageEvent {
  service: "planner" | "yarn";
  request_id: string;
  trace_id?: string;
  timestamp: number;
  user_id: string;
  org_id: string;
  tenant_id: string;
  model: string;
  role: string;
  tokens: LlmUsage;
  cost: {
    estimated_usd: number;
    actual_usd: number;
    rates_snapshot: PricingRates;
  };
  latency_ms: number;
  prefix_cache: {
    mode: string;
    hit_tokens: number;
    miss_tokens: number;
    hit_rate: number;
  };
}

export interface TraceSensemaking {
  domain_profile?: {
    domains: Array<{ key: string; weight: number }>;
    frameCoherence: string;
  };
  task_frame?: Record<string, unknown>;
  planner_confidence: number;
  clarification_triggered: boolean;
  clarification_question?: string;
  clarification_options?: string[];
  assumptions: string[];
  frame_coherence: string;
  assumption_tags_applied?: {
    assumption: number;
    estimate: number;
    clarified: number;
  };
}

export interface TraceCriticResult {
  approved: boolean;
  need_more_evidence: boolean;
  scores: Record<string, number>;
  blocking_issues: unknown[];
  nonblocking: unknown[];
  is_background: boolean;
}

export interface TraceClassification {
  difficulty: number;
  task_size: string;
  risk_score: number;
  effort_mode: string;
  model_tier: string;
  rag_mode: string;
  plan_required: boolean;
  show_assumptions: boolean;
  taxonomy_key: string;
  cynefin_domain?: "clear" | "complicated" | "complex" | "chaotic";
  active_vertical?: string;
}

export interface TraceLLMCallRecord {
  model: string;
  node: string;
  role?: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens?: number;
  latency_ms: number;
  prompt_snippet?: string;
  completion_snippet?: string;
  timestamp: number;
  actual_cost?: number;
  estimated_cost?: number;
}

export interface TraceSpanRecord {
  node_name: string;
  intent?: string;
  start_time: number;
  end_time: number;
  latency_ms: number;
  tokens_used: number;
  confidence: number;
  outcome: string;
  reasoning?: string;
  llm_calls: TraceLLMCallRecord[];
  metadata?: Record<string, unknown>;
}

export interface TraceRecord {
  service: "planner" | "yarn";
  /**
   * Trace/correlation ID for this request path.
   */
  trace_id: string;
  /**
   * Request ID for this emitted record (request-scoped).
   */
  request_id: string;
  /**
   * Optional authz lineage/correlation ID (planner authz trace).
   */
  authz_trace_id?: string;
  /**
   * Optional conversation/session correlation key.
   */
  conversation_id?: string;
  /**
   * Optional parent trace ID (immediate predecessor in same conversation).
   */
  parent_trace_id?: string;
  /**
   * Optional root trace ID (first trace in same conversation lineage).
   */
  root_trace_id?: string;
  timestamp: number;
  user_id: string;
  org_id: string;
  tenant_id: string;
  model: string;
  tokens: LlmUsage;
  cost: {
    estimated_usd: number;
    actual_usd: number;
    rates_snapshot: PricingRates;
  };
  latency_ms: number;
  query_snippet?: string;
  spans?: TraceSpanRecord[];
  decision_ledger?: unknown[];
  sensemaking?: TraceSensemaking;
  task_frame?: Record<string, unknown>;
  critic_result?: TraceCriticResult;
  background_critic?: Record<string, unknown>;
  classification?: TraceClassification;
  difficulty?: number;
  task_type?: string;
  domain_tags?: string[];
  is_code_task?: boolean;
  has_error?: boolean;
  iteration_count?: number;
  max_iterations?: number;
  phase_timings?: Record<string, number>;
  trace_context?: Record<string, unknown>;
  evidence_summary?: Record<string, unknown>;
  taxonomy?: Record<string, unknown>;
  critic_scores?: Record<string, unknown>;
  context_curation?: Record<string, unknown>;
  streaming?: {
    mode: "streaming" | "non-streaming";
    time_to_first_token_ms?: number;
  };
  error?: string;
}
