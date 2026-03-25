export interface User {
  username: string;
  role: "admin" | "platform_admin" | "org_admin" | "readonly" | "user";
  user_id?: string;
  org_id?: string;
  org_name?: string;
  org_roles?: string[];
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface OidcConfig {
  enabled: boolean;
  issuer?: string;
  client_id?: string;
  scopes?: string;
}

export interface PersonalAccessToken {
  id: string;
  name: string;
  token_prefix: string;
  role: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked: boolean;
}

export interface TokenCreated {
  id: string;
  name: string;
  token: string;
  token_prefix: string;
  role: string;
  scopes: string[];
  expires_at: string | null;
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
    /** Sum of trace estimated_cost_usd (24h) — not provider invoice */
    trace_estimated_spend_24h_usd: number;
  };
  /** Monthly fixed infra estimate from model_costs — not usage spend */
  monthly_fixed_cost_estimate: {
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

export interface ModelDeployment {
  id: number | null;
  environment: string;
  role: string;
  model: string;
  endpoint: string;
  served_name: string;
  status: string;
  profile: string;
  provider: string;
  source: string;
  api_key_env: string;
  litellm_params: Record<string, unknown> | null;
  is_active: boolean;
  assigned: boolean;
  description: string;
  notes: string;
  gpu_config: Record<string, unknown> | null;
  litellm_model_id: string | null;
  fallbacks: string[] | null;
  updated_at: string | null;
}

export interface ProviderInfo {
  key: string;
  label: string;
  litellm_prefix: string;
  api_key_env: string;
  needs_endpoint: boolean;
  placeholder: string;
  is_local: boolean;
  supports_discovery: boolean;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  supports_streaming: boolean;
  supports_tools: boolean;
  pricing_input_per_million: number | null;
  pricing_output_per_million: number | null;
}

export interface DiscoveryResult {
  provider: string;
  models: DiscoveredModel[];
  error: string | null;
  cached: boolean;
  count: number;
}

export interface ProviderDefaults {
  max_tokens: number;
  temperature: number;
  supports_streaming: boolean;
  supports_tools: boolean;
  context_window: number | null;
  notes: string;
}

export interface ModelValidation {
  valid: boolean;
  reason?: string;
  suggestion?: string;
}

export interface RoleInfo {
  key: string;
  served_name: string;
  description: string;
}

export interface LiteLLMRestartStatus {
  deployment: string;
  namespace: string;
  restart_trigger_epoch: number | null;
  restart_trigger_at: string | null;
  generation: number;
  observed_generation: number;
  rollout_observed: boolean;
  desired_replicas: number;
  updated_replicas: number;
  ready_replicas: number;
  available_replicas: number;
}

export interface ProviderConfig {
  id: number;
  provider_key: string;
  enabled: boolean;
  default_max_tokens: number;
  default_temperature: number;
  allowed_roles: string[] | null;
  policies: Record<string, unknown> | null;
  notes: string;
  updated_at: string | null;
}

export interface ProviderConfigInfo extends ProviderInfo {
  is_custom: boolean;
  config: ProviderConfig | null;
  enabled: boolean;
  default_max_tokens: number;
  default_temperature: number;
  allowed_roles: string[] | null;
  policies: Record<string, unknown> | null;
  notes: string;
  config_updated_at: string | null;
}

// ServingEndpointEntry and ServingHealthCheck removed — serving is now a
// read-only view derived from ModelDeployment (Model Registry).

export interface RoleHistoryEntry {
  id: number;
  role: string;
  provider: string;
  model: string;
  endpoint: string;
  input_per_million: number;
  output_per_million: number;
  activated_at: string | null;
  deactivated_at: string | null;
}

export interface RolePerformance {
  role: string;
  request_count: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  total_tokens: number;
  total_prompt_tokens?: number;
  total_cached_prompt_tokens?: number;
  cache_hit_rate?: number;
  total_actual_cost: number;
  registry_model: string;
  registry_provider: string;
  served_name: string;
  assigned: boolean;
}

export interface ActiveCostEntry {
  [key: string]: unknown;
  role: string;
  model: string;
  profile: string;
  source: string;
  provider: string;
  input_per_million: number;
  /** When set, used for cached prompt tokens; otherwise ~10% of input rate (server default). */
  input_cached_per_million?: number | null;
  output_per_million: number;
  monthly_fixed_cost: number;
  cost_formula: string;
  notes: string;
  pricing_source: "manual" | "litellm" | "bundled" | "infra_calc" | "unknown";
}

export interface InfraInstanceType {
  cloud: string;
  instance_type: string;
  label: string;
  gpu_model: string;
  gpu_count: number;
  on_demand_hourly: number;
  estimated_tokens_per_hour: number;
}

export interface InfraCostConfig {
  role: string;
  cloud: string;
  instance_type: string;
  gpu_model: string;
  gpu_count: number;
  hourly_rate: number;
  tokens_per_hour: number;
  input_per_million: number;
  output_per_million: number;
  notes: string;
  updated_at: string | null;
}

export interface ModelCost {
  [key: string]: unknown;
  role: string;
  model: string;
  profile: string;
  source: string;
  /** When present (e.g. active rows), preferred over source for display */
  provider?: string;
  input_per_million: number;
  input_cached_per_million?: number | null;
  output_per_million: number;
  monthly_fixed_cost: number;
  cost_formula: string;
  notes: string;
  pricing_source?: ActiveCostEntry["pricing_source"];
}

export interface ModelCostByModel {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens?: number;
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
  chunk_count?: number;
  doc_count?: number;
  freshness_pct?: number;
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
  [key: string]: unknown;
  key: string;
  path: string;
  complexity: number;
  persona: string;
  children?: TaxonomyDomain[];
  required_elements?: string[];
  depth_instructions?: string;
  output_style_guidance?: string;
  epistemic_guidance?: string;
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
  id: string;
  source: "planner" | "openwebui";
  message_id: string;
  run_id: string;
  vote: "up" | "down" | "";
  user_id: string;
  model: string;
  message_snippet: string;
  response_snippet: string;
  timestamp: string;
  trace_href?: string | null;
  feedback_type?: string;
  reason?: string;
  user_comment?: string;
  tags?: string[];
  review_status?: "pending" | "reviewed" | "closed";
  internal_note?: string;
  updated_by?: string;
  owui_id?: string;
  chat_id?: string;
  classification_reasons?: string[];
  task_size?: string;
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
  prompt_cache?: {
    hits: number;
    misses: number;
    entries: number;
    hit_rate: number;
    enabled?: boolean;
    max_entries?: number;
    ttl_seconds?: number;
  };
  frame_cache?: {
    hits: number;
    misses: number;
    entries: number;
    hit_rate: number;
  };
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
  remediation?: string | null;
  retry_total?: number;
  fallback_total?: number;
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

// --- Ingestion Queue ---

export interface IngestionSource {
  id: number;
  name: string;
  handler: string;
  origin_type: string;
  authority: string;
  domain: string;
  config: Record<string, unknown> | null;
  tags: string[] | null;
  visibility_scope: string;
  org_id: string;
  tenant_id: string;
  acl_mode: string;
  acl_groups: string;
  status: string;
  item_count: number;
  pending_count: number;
  created_at: string | null;
}

/** Telemetry from the indexer after fetch (crawl breadth/depth for web_page, etc.). */
export interface IndexerIngestionStats {
  handler?: string;
  source_pages?: number;
  planned_max_pages?: number;
  planned_max_depth?: number;
  discovery?: string;
  max_depth_reached?: number;
}

export interface IngestionItem {
  id: number;
  source_id: number | null;
  uri: string;
  handler: string | null;
  title: string;
  domain: string;
  authority: string;
  origin_type: string;
  tags: string[] | null;
  priority: number;
  config: Record<string, unknown> | null;
  status: string;
  content_hash: string | null;
  chunk_count: number;
  error_message: string;
  milvus_doc_id: string;
  indexer_stats?: IndexerIngestionStats | null;
  retry_count: number;
  max_retries: number;
  queued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string | null;
}

export interface IngestionRun {
  id: number;
  source_id: number | null;
  trigger: string;
  status: string;
  items_total: number;
  items_indexed: number;
  items_failed: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface IngestionStats {
  total_sources: number;
  total_items: number;
  pending: number;
  running: number;
  indexed: number;
  failed: number;
  dead_letter?: number;
  staged_raw?: number;
  staged_norm?: number;
  enrich_queued?: number;
  total_chunks: number;
  staged_documents?: number;
  enrich_queue_pending?: number;
  semantic_contract_items?: number;
  semantic_chunks_enriched?: number;
  enrich_full_items?: number;
}

export interface StagedIngestionDocument {
  id: number;
  doc_key: string;
  canonical_uri: string;
  title: string;
  domain: string;
  authority: string;
  origin_type: string;
  tags: string[] | null;
  config_snapshot: Record<string, unknown> | null;
  raw_status: string;
  norm_status: string;
  enrich_status: string;
  norm_version: string;
  chunk_count: number;
  error_message: string;
  raw_s3_keys: Record<string, unknown> | null;
  norm_s3_md_key: string | null;
  norm_s3_meta_key: string | null;
  updated_at: string | null;
}

// --- Traces ---

export interface LLMCallRecord {
  model: string;
  node: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Provider-reported cached prompt tokens when available (OpenAI details, Anthropic cache read, etc.). */
  cached_prompt_tokens?: number;
  latency_ms: number;
  prompt_snippet: string;
  completion_snippet: string;
  prompt_full?: string;
  completion_full?: string;
  timestamp: number;
  actual_cost?: number;
  estimated_cost?: number;
  policy_source?: string;
  policy_rule_label?: string;
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
  metadata?: Record<string, unknown>;
}

export interface TraceRecord {
  trace_id: string;
  user_id: string;
  user_email?: string;
  org_id?: string;
  org_name?: string;
  query_snippet: string;
  timestamp: number;
  total_duration_ms: number;
  total_tokens: number;
  /** Sum of per-call cached prompt tokens when the provider returned them. */
  total_cached_prompt_tokens?: number;
  estimated_cost_usd: number;
  actual_cost_usd?: number;
  difficulty: number;
  task_type: string;
  domain_tags: string[];
  is_code_task: boolean;
  has_error: boolean;
  iteration_count: number;
  spans: SpanRecord[];
  critic_scores: Record<string, unknown>;
  background_critic?: Record<string, unknown>;
  manual_critic?: Record<string, unknown>;
  evidence_summary: Record<string, unknown>;
  context_curation?: Record<string, unknown>;
  taxonomy: Record<string, unknown>;
  phase_timings?: Record<string, number>;
  trace_context?: {
    token_budget_total?: number;
    token_budget_remaining?: number;
    token_budget_consumed?: number;
    token_budget_state?: string;
    budget_exhausted?: boolean;
    failure_stage?: string;
    failure_type?: string;
    failure_reason?: string;
    [key: string]: unknown;
  };
  short_circuit_reason?: string;
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
