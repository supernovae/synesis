export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens: number;
  estimated_cost_usd: number;
  actual_cost_usd: number;
}

export interface PricingRates {
  input_per_million: number;
  output_per_million: number;
  cached_input_per_million: number | null;
}

export interface CostResult {
  estimated_cost_usd: number;
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
}

export interface TraceRecord {
  service: "planner" | "yarn";
  trace_id: string;
  request_id: string;
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
  spans?: unknown[];
  decision_ledger?: unknown[];
  node_traces?: unknown[];
  sensemaking?: TraceSensemaking;
  critic_result?: TraceCriticResult;
  classification?: TraceClassification;
  iteration_count?: number;
  max_iterations?: number;
  streaming?: {
    mode: "streaming" | "non-streaming";
    time_to_first_token_ms?: number;
  };
  error?: string;
}
