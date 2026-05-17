export interface UnifiedResult {
  retrieval_source: "rag" | "web";
  source_url: string;
  source_id?: string;
  chunk_id?: string;
  doc_id?: string;
  title: string;
  text: string;
  score: number;
  authority?: string;
  pack_id?: string;
  pack_version?: string;
  pack_source_version?: string;
  pack_partition?: string;
  symbol_kind?: string;
  symbol_fqn?: string;
  symbol_name?: string;
  package_name?: string;
  doc_relation_ids?: string;
  agent_hook?: string;
  perf_tier?: string;
  safety_contract?: string;
  lifecycle_model?: string;
  agent_enrichment_json?: string;
  origin_type?: string;
  source_type?: string;
  handler?: string;
  heading_path?: string;
  document_name?: string;
  context_prefix?: string;
  chunk_summary?: string;
  domain?: string;
  is_trusted?: boolean;
  scan_status?: string;
  scan_signals?: string;
  approval_status?: string;
  review_trace_id?: string;
  content_hash?: string;
  crawl_timestamp?: number;
  effective_at_epoch?: number;
  has_code?: boolean;
  code_signal_count?: number;
  code_density?: number;
  code_language?: string;
  artifact_kind?: string;
  content_format?: string;
  language?: string;
  repo_path?: string;
  module_path?: string;
  evidence_bucket?: "primary_code" | "supporting_docs";
}

export interface CohesionLockData {
  entity: string;
  type: "generic" | "specific";
  exclude_signals: string[];
  confidence: number;
  source: "metadata" | "llm" | "domain_profile" | "";
}

export interface RetrievalBundle {
  results: UnifiedResult[];
  cohesion_lock: CohesionLockData | null;
  rag_degraded: boolean;
  web_degraded: boolean;
  degradation_notes: string;
  phase_timings: Record<string, number>;
}

export interface ScopeFilterOptions {
  callerOrgId?: string;
  callerTenantIds?: string[];
  callerAclGroups?: string[];
  callerUserId?: string;
  callerConversationId?: string;
  authzMode?: "audit" | "enforce";
  authzTraceId?: string;
  trustedScopeSource?: "auth_context" | "trusted_forwarded_identity" | "none";
}

export interface UnifiedRetrievalRequest {
  query: string;
  difficulty?: number;
  collections?: string[];
  topK?: number;
  version?: string;
  commit?: string;
  branch?: string;
  temporalAt?: string;
  graphDepth?: number;
  edgeTypes?: string[];
  webQuery?: string;
  forceWeb?: boolean;
  domainHints?: string[];
  skipWeb?: boolean;
  searchSourceIds?: string[];
  preferredDomains?: string[];
  preseededLock?: CohesionLockData;
  callerOrgId?: string;
  callerTenantIds?: string[];
  callerAclGroups?: string[];
  callerUserId?: string;
  callerConversationId?: string;
  authzMode?: "audit" | "enforce";
  authzTraceId?: string;
  trustedScopeSource?: "auth_context" | "trusted_forwarded_identity" | "none";
  sourceSurface?: WebSearchSourceSurface;
  toolName?: string;
  requestId?: string;
  sessionKey?: string;
  traceId?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  score: number;
  relevance: number;
  fetched_content: string;
  authority: string;
  origin_type: string;
  is_trusted: boolean;
  source_id: string;
}

export interface RagResult {
  chunk_id?: string;
  doc_id?: string;
  id?: string;
  kind?: string;
  name?: string;
  text: string;
  source: string;
  collection: string;
  retrieval_source: "vector" | "bm25" | "both" | "hybrid";
  vector_score: number;
  bm25_score: number;
  rrf_score: number;
  rerank_score: number;
  origin_type: string;
  authority: string;
  pack_id?: string;
  pack_version?: string;
  pack_source_version?: string;
  pack_artifact_hash?: string;
  pack_partition?: string;
  symbol_kind?: string;
  symbol_fqn?: string;
  symbol_name?: string;
  package_name?: string;
  doc_relation_ids?: string;
  agent_hook?: string;
  perf_tier?: string;
  safety_contract?: string;
  lifecycle_model?: string;
  agent_enrichment_json?: string;
  domain: string;
  source_url: string;
  source_type?: string;
  handler?: string;
  heading_path: string;
  context_prefix: string;
  chunk_summary: string;
  document_name: string;
  scan_status?: string;
  scan_signals?: string;
  approval_status?: string;
  review_trace_id?: string;
  content_hash?: string;
  crawl_timestamp?: number;
  effective_at_epoch?: number;
  tags?: string;
  language?: string;
  content_type?: string;
  artifact_kind?: string;
  content_format?: string;
  repo_path?: string;
  module_path?: string;
  corpus_class?: string;
  constraint_kind?: string;
  content_profile?: string;
  scope_tags?: string;
  constraint_source?: string;
  constraint_confidence?: number;
  golden_path_id?: string;
  novel_pattern?: boolean;
  novel_trace_level?: string;
  has_code?: boolean;
  code_signal_count?: number;
  code_density?: number;
  code_language?: string;
  visibility_scope?: string;
  acl_mode?: string;
  authz_object_id?: string;
  query_aliases?: string;
  retrieval_terms?: string;
  task_intents?: string;
  source_release?: string;
  upstream_commit?: string;
  upstream_tag?: string;
  deprecation_status?: string;
  replacement_api?: string;
  deprecated?: boolean;
  quality_score?: number;
  trust_score?: number;
  freshness_score?: number;
  runnable?: boolean;
  anti_example?: boolean;
  imports?: string;
  setup?: string;
  expected_output?: string;
  test_command?: string;
  related_apis?: string;
}

/** Authority multipliers applied after reranking (same as Python). */
export const AUTHORITY_BOOST: Record<string, number> = {
  canonical: 1.5,
  vetted: 1.3,
  community: 1.0,
  external: 0.7,
  "": 1.0,
};

// ---------------------------------------------------------------------------
// Knowledge search endpoint types
// ---------------------------------------------------------------------------

export interface KnowledgeSearchRequest {
  query: string;
  mode?: "bundle" | "cards";
  top_k?: number;
  pack_id?: string;
  pack_ids?: string[];
  pack_version?: string;
  pack_partition?: string;
  symbol_kind?: string;
  symbol_fqn?: string;
  package_name?: string;
  perf_tier?: string;
  language?: string;
  artifact_kind?: string;
  domain?: string;
  corpus_class?: string;
  constraint_kind?: string;
  scope_tags?: string[];
  tags?: string;
  content_format?: string;
  repo_path?: string;
  module_path?: string;
  symbol_name?: string;
  has_code?: boolean;
  code_language?: string;
  content_profile?: string;
  constraint_source?: string;
  golden_path_id?: string;
  caller_org_id?: string;
  caller_tenant_ids?: string[];
  caller_acl_groups?: string[];
  caller_user_id?: string;
  caller_conversation_id?: string;
  version?: string;
  commit?: string;
  branch?: string;
  temporal_at?: string;
  graph_depth?: number;
  edge_types?: string[];
  topic?: string;
  symbol?: string;
  task?: string;
  content_type?: string;
  version_preference?: string;
  include_examples?: boolean;
  include_antipatterns?: boolean;
  include_context_cards?: boolean;
}

export interface PackResolveRequest {
  query?: string;
  domain?: string;
  content_type?: string;
  language?: string;
  package_name?: string;
  symbol?: string;
  version?: string;
  top_k?: number;
  caller_org_id?: string;
  caller_tenant_ids?: string[];
  caller_acl_groups?: string[];
  caller_user_id?: string;
}

export interface ResolvedPackCandidate {
  pack_id: string;
  pack_version: string;
  source_version: string;
  source_release: string;
  domain: string;
  content_type: string;
  language: string;
  package_name: string;
  trust_score: number;
  quality_score: number;
  freshness_score: number;
  node_count: number;
  chunk_count: number;
  example_count: number;
  context_card_count: number;
  pattern_count: number;
  constraint_count: number;
  edge_count: number;
  score: number;
}

export interface PackResolveResponse {
  query: string;
  candidates: ResolvedPackCandidate[];
  total: number;
}

export interface KnowledgeContextCard {
  title: string;
  what_to_use: string;
  when_to_use: string;
  do_not_use: string;
  minimal_example: string;
  verification: string;
  related_apis: string[];
  source_refs: string[];
  score: number;
}

export interface KnowledgeBundleResponse {
  query: string;
  resolved_pack?: ResolvedPackCandidate;
  context_cards: KnowledgeContextCard[];
  examples: KnowledgeResult[];
  anti_patterns: KnowledgeResult[];
  source_chunks: KnowledgeResult[];
  related_symbols: KnowledgeResult[];
  freshness_warnings: string[];
  quality: {
    quality_score: number;
    trust_score: number;
    freshness_score: number;
    evidence_count: number;
    example_count: number;
    anti_pattern_count: number;
    context_card_count: number;
  };
  timings: {
    resolve_ms: number;
    search_ms: number;
    bundle_ms: number;
    total_ms: number;
  };
}

export interface KnowledgeResult {
  text: string;
  source_url: string;
  chunk_id?: string;
  doc_id?: string;
  document_name: string;
  authority: string;
  pack_id?: string;
  pack_version?: string;
  pack_source_version?: string;
  pack_partition?: string;
  symbol_kind?: string;
  symbol_fqn?: string;
  symbol_name?: string;
  package_name?: string;
  doc_relation_ids?: string[];
  agent_hook?: string;
  perf_tier?: string;
  safety_contract?: string;
  lifecycle_model?: string;
  agent_enrichment_json?: string;
  origin_type: string;
  source_type?: string;
  handler?: string;
  domain: string;
  language: string;
  artifact_kind: string;
  content_format: string;
  repo_path: string;
  module_path: string;
  tags: string;
  context_prefix: string;
  chunk_summary: string;
  heading_path: string;
  score: number;
  constraint_kind: string;
  corpus_class: string;
  scope_tags: string[];
  content_profile: string;
  constraint_source: string;
  constraint_confidence: number;
  golden_path_id: string;
  novel_pattern: boolean;
  has_code: boolean;
  code_signal_count: number;
  code_density: number;
  code_language: string;
  scan_status: string;
  approval_status: string;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeResult[];
  query: string;
  total: number;
  timings: {
    embed_ms: number;
    search_ms: number;
    rerank_ms: number;
    total_ms: number;
  };
}

export type WebSearchSourceSurface =
  | "yarn_chat"
  | "yarn_mcp_http"
  | "openwebui_planner"
  | "planner_internal"
  | "external_api";

export interface WebSearchAttribution {
  source_surface: WebSearchSourceSurface;
  tool_name: string;
  request_id?: string;
  session_key?: string;
  conversation_id?: string;
  trace_id?: string;
  caller_org_id?: string;
  caller_user_id?: string;
  caller_tenant_ids?: string[];
}

export interface WebSearchRequest {
  query: string;
  top_k?: number;
  profile?: "web" | "code";
  fetch_pages?: boolean;
  max_fetch_pages?: number;
  min_relevance?: number;
  preferred_domains?: string[];
  source_surface?: WebSearchSourceSurface;
  tool_name?: string;
  request_id?: string;
  session_key?: string;
  conversation_id?: string;
  trace_id?: string;
  caller_org_id?: string;
  caller_user_id?: string;
  caller_tenant_ids?: string[];
}

export interface WebSearchResponse {
  query: string;
  total: number;
  results: SearchResult[];
  timings: {
    total_ms: number;
  };
  attribution_echo: WebSearchAttribution;
  policy: {
    action: "allow" | "deny" | "degraded";
    reason?: string;
  };
}
