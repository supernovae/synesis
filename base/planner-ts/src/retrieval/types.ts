export interface UnifiedResult {
  retrieval_source: "rag" | "web";
  source_url: string;
  source_id?: string;
  title: string;
  text: string;
  score: number;
  authority?: string;
  origin_type?: string;
  heading_path?: string;
  document_name?: string;
  context_prefix?: string;
  chunk_summary?: string;
  domain?: string;
  is_trusted?: boolean;
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
}

export interface UnifiedRetrievalRequest {
  query: string;
  difficulty?: number;
  collections?: string[];
  topK?: number;
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
  domain: string;
  source_url: string;
  heading_path: string;
  context_prefix: string;
  chunk_summary: string;
  document_name: string;
}

/** Authority multipliers applied after reranking (same as Python). */
export const AUTHORITY_BOOST: Record<string, number> = {
  canonical: 1.5,
  vetted: 1.3,
  community: 1.0,
  external: 0.7,
  "": 1.0,
};
