import type { UnifiedResult, RetrievalBundle, UnifiedRetrievalRequest } from "./types.js";
import { retrieveUnified, type RetrievalSettings } from "./unified.js";
import type { AppConfig } from "../config.js";

export interface RetrievalRequest {
  query: string;
  top_k?: number;
}

export interface RetrievalClient {
  retrieve(request: RetrievalRequest): Promise<UnifiedResult[]>;
  retrieveUnified?(request: UnifiedRetrievalRequest): Promise<RetrievalBundle>;
}

export class NullRetrievalClient implements RetrievalClient {
  async retrieve(_request: RetrievalRequest): Promise<UnifiedResult[]> {
    return [];
  }
}

/**
 * Full retrieval client backed by NornicDB + SearXNG + cohesion.
 *
 * Retrieval pipeline:
 *   graph RAG + web -> RRF merge -> adaptive top-k -> cohesion.
 */
export class UnifiedRetrievalClient implements RetrievalClient {
  private settings: RetrievalSettings;

  constructor(config: AppConfig) {
    let engineAuthorityMap: Record<string, { authority: string; origin_type: string }> = {};
    try {
      engineAuthorityMap = JSON.parse(config.SYNESIS_ENGINE_AUTHORITY_MAP || "{}");
    } catch { /* default empty */ }

    this.settings = {
      rag: {
        nornicUri: config.SYNESIS_NORNIC_URI,
        nornicUser: config.SYNESIS_NORNIC_USER,
        nornicPassword: config.SYNESIS_NORNIC_PASSWORD,
        nornicDatabase: config.SYNESIS_NORNIC_DATABASE,
        nornicVectorIndex: config.SYNESIS_NORNIC_VECTOR_INDEX,
        nornicRuntimeProfile: config.SYNESIS_NORNIC_RUNTIME_PROFILE,
        embedderUrl: config.SYNESIS_EMBEDDER_URL,
        embedderModel: config.SYNESIS_EMBEDDER_MODEL,
        retrievalStrategy: config.SYNESIS_RAG_RETRIEVAL_STRATEGY,
        rrfK: config.SYNESIS_RAG_RRF_K,
        scoreThreshold: config.SYNESIS_RAG_SCORE_THRESHOLD,
        rerankScoreMin: config.SYNESIS_RAG_RERANK_SCORE_MIN,
        graphDepth: config.SYNESIS_NORNIC_GRAPH_DEPTH,
        edgeTypes: config.SYNESIS_NORNIC_EDGE_TYPES.split(",").map((s) => s.trim()).filter(Boolean),
        rerankEnabled: config.SYNESIS_NORNIC_RERANK_ENABLED,
      },
      web: {
        url: config.SYNESIS_WEB_SEARCH_URL,
        enabled: config.SYNESIS_WEB_SEARCH_ENABLED,
        timeoutMs: config.SYNESIS_WEB_SEARCH_TIMEOUT_MS,
        maxResults: config.SYNESIS_WEB_SEARCH_MAX_RESULTS,
        engineAuthorityMap,
      },
      cohesion: {
        enabled: config.SYNESIS_COHESION_LOCK_ENABLED,
        minResults: config.SYNESIS_COHESION_LOCK_MIN_RESULTS,
        embeddingThreshold: config.SYNESIS_COHESION_EMBEDDING_THRESHOLD,
        llmBorderlineLow: config.SYNESIS_COHESION_LLM_BORDERLINE_LOW,
        llmBorderlineHigh: config.SYNESIS_COHESION_LLM_BORDERLINE_HIGH,
        compressionThreshold: config.SYNESIS_COHESION_COMPRESSION_THRESHOLD,
        embedderUrl: config.SYNESIS_EMBEDDER_URL,
        embedderModel: config.SYNESIS_EMBEDDER_MODEL,
      },
      rrfK: config.SYNESIS_RAG_RRF_K,
      overfetchMin: config.SYNESIS_RAG_OVERFETCH_MIN,
      overfetchMax: config.SYNESIS_RAG_OVERFETCH_MAX,
      adaptiveGapMultiplier: config.SYNESIS_RAG_ADAPTIVE_GAP_MULTIPLIER,
      domainPolicyMode: config.SYNESIS_DOMAIN_POLICY_MODE,
      domainPolicyBoost: config.SYNESIS_DOMAIN_POLICY_BOOST,
      webBudgetBase: config.SYNESIS_WEB_BUDGET_BASE,
      webBudgetMax: config.SYNESIS_WEB_BUDGET_MAX,
      freshnessWeight: config.SYNESIS_FRESHNESS_WEIGHT,
    };
  }

  async retrieve(request: RetrievalRequest): Promise<UnifiedResult[]> {
    const bundle = await this.retrieveUnified({
      query: request.query,
      topK: request.top_k,
    });
    return bundle.results;
  }

  async retrieveUnified(request: UnifiedRetrievalRequest): Promise<RetrievalBundle> {
    return retrieveUnified(request, this.settings);
  }
}
