/**
 * Milvus RAG retrieval client — HTTP to Milvus REST v2 API.
 *
 * Ports the Python retrieve_context() from rag_client.py:
 *   1. Embed query via TEI
 *   2. Search Milvus (vector, bm25, or hybrid with RRF)
 *   3. Optionally rerank via BGE
 *   4. Apply authority multipliers and score floor
 *
 * Uses Milvus REST API v2 (/v2/vectordb/entities/search and /hybrid_search).
 */

import { embed } from "./embedder.js";
import { buildScopeFilter } from "./scope-filter.js";
import type { RagResult, ScopeFilterOptions, AUTHORITY_BOOST } from "./types.js";
import { AUTHORITY_BOOST as AUTH_BOOST } from "./types.js";

export interface RagClientConfig {
  milvusHost: string;
  milvusPort: number;
  embedderUrl: string;
  embedderModel: string;
  bgeRerankerUrl: string;
  retrievalStrategy: "hybrid" | "vector" | "bm25";
  rrfK: number;
  scoreThreshold: number;
  rerankScoreMin: number;
  timeoutMs?: number;
}

const OUTPUT_FIELDS = [
  "text", "authority", "origin_type", "domain",
  "source_url", "heading_path", "context_prefix", "chunk_summary",
  "document_name", "visibility_scope", "org_id", "tenant_id",
  "acl_mode", "acl_groups",
  "scan_status", "scan_signals", "approval_status", "review_trace_id",
  "raw_content_hash", "crawl_timestamp", "effective_at_epoch",
  "tags", "language", "artifact_kind",
  "corpus_class", "constraint_kind", "content_profile", "scope_tags",
  "constraint_source", "constraint_confidence", "golden_path_id",
  "novel_pattern", "novel_trace_level",
  "has_code", "code_signal_count", "code_density", "code_language",
];

interface MilvusSearchResponse {
  code: number;
  data: Array<Record<string, unknown>>;
}

// Synesis catalog vector field names in current schema.
const DENSE_VECTOR_FIELD = "embedding";
const SPARSE_VECTOR_FIELD = "sparse_text";

function milvusBase(config: RagClientConfig): string {
  return `http://${config.milvusHost}:${config.milvusPort}`;
}

async function vectorSearch(
  config: RagClientConfig,
  collection: string,
  queryVector: number[],
  limit: number,
  filter: string,
): Promise<Array<Record<string, unknown>>> {
  const body: Record<string, unknown> = {
    collectionName: collection,
    annsField: DENSE_VECTOR_FIELD,
    data: [queryVector],
    limit,
    outputFields: OUTPUT_FIELDS,
    params: { radius: config.scoreThreshold },
  };
  if (filter) body.filter = filter;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 15000);
  try {
    const resp = await fetch(`${milvusBase(config)}/v2/vectordb/entities/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const json = (await resp.json()) as MilvusSearchResponse;
    return json.data ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function hybridSearch(
  config: RagClientConfig,
  collection: string,
  queryVector: number[],
  queryText: string,
  limit: number,
  filter: string,
): Promise<Array<Record<string, unknown>>> {
  const body: Record<string, unknown> = {
    collectionName: collection,
    search: [
      { data: [queryVector], annsField: DENSE_VECTOR_FIELD, limit: limit * 2 },
      { data: [queryText], annsField: SPARSE_VECTOR_FIELD, limit: limit * 2 },
    ],
    rerank: { strategy: "rrf", params: { k: config.rrfK } },
    limit,
    outputFields: OUTPUT_FIELDS,
  };
  if (filter) body.filter = filter;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 15000);
  try {
    const resp = await fetch(`${milvusBase(config)}/v2/vectordb/entities/hybrid_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const json = (await resp.json()) as MilvusSearchResponse;
    return json.data ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function bgeRerank(
  rerankerUrl: string,
  query: string,
  passages: string[],
  timeoutMs: number,
): Promise<number[]> {
  if (!rerankerUrl || passages.length === 0) return passages.map(() => 0);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${rerankerUrl.replace(/\/$/, "")}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, passages }),
      signal: controller.signal,
    });
    if (!resp.ok) return passages.map(() => 0);
    const json = (await resp.json()) as { scores: number[] };
    return json.scores ?? passages.map(() => 0);
  } catch {
    return passages.map(() => 0);
  } finally {
    clearTimeout(timer);
  }
}

function toRagResult(row: Record<string, unknown>, fallbackScore: number): RagResult {
  return {
    text: String(row.text ?? ""),
    source: String(row.source ?? "unknown"),
    collection: String(row.collection ?? ""),
    retrieval_source: "hybrid",
    vector_score: Number(row.distance ?? row.score ?? fallbackScore),
    bm25_score: 0,
    rrf_score: Number(row.score ?? row.distance ?? fallbackScore),
    rerank_score: 0,
    origin_type: String(row.origin_type ?? ""),
    authority: String(row.authority ?? ""),
    domain: String(row.domain ?? ""),
    source_url: String(row.source_url ?? ""),
    heading_path: String(row.heading_path ?? ""),
    context_prefix: String(row.context_prefix ?? ""),
    chunk_summary: String(row.chunk_summary ?? ""),
    document_name: String(row.document_name ?? row.source ?? ""),
    scan_status: String(row.scan_status ?? "unscanned"),
    scan_signals: String(row.scan_signals ?? ""),
    approval_status: String(row.approval_status ?? "auto_approved"),
    review_trace_id: String(row.review_trace_id ?? ""),
    content_hash: String(row.raw_content_hash ?? ""),
    crawl_timestamp: Number(row.crawl_timestamp ?? 0),
    effective_at_epoch: Number(row.effective_at_epoch ?? 0),
    tags: String(row.tags ?? ""),
    language: String(row.language ?? ""),
    artifact_kind: String(row.artifact_kind ?? ""),
    corpus_class: String(row.corpus_class ?? ""),
    constraint_kind: String(row.constraint_kind ?? ""),
    content_profile: String(row.content_profile ?? ""),
    scope_tags: String(row.scope_tags ?? ""),
    constraint_source: String(row.constraint_source ?? ""),
    constraint_confidence: Number(row.constraint_confidence ?? -1),
    golden_path_id: String(row.golden_path_id ?? ""),
    novel_pattern: row.novel_pattern === true || row.novel_pattern === "true",
    novel_trace_level: String(row.novel_trace_level ?? "none"),
    has_code: row.has_code === true || row.has_code === "true",
    code_signal_count: Number(row.code_signal_count ?? 0),
    code_density: Number(row.code_density ?? 0),
    code_language: String(row.code_language ?? ""),
  };
}

/**
 * Retrieve documents from Milvus, optionally rerank, and apply authority boosts.
 */
export async function retrieveContext(
  query: string,
  config: RagClientConfig,
  options: {
    collections?: string[];
    topK?: number;
    scopeFilter?: ScopeFilterOptions;
    extraFilter?: string;
  } = {},
): Promise<RagResult[]> {
  const collections = options.collections ?? ["synesis_catalog"];
  const topK = options.topK ?? 5;
  const scopeExpr = buildScopeFilter(options.scopeFilter);
  const filter = scopeExpr && options.extraFilter
    ? `${scopeExpr} and ${options.extraFilter}`
    : scopeExpr || options.extraFilter || "";

  const embeddings = await embed([query], { url: config.embedderUrl, model: config.embedderModel });
  const queryVector = embeddings[0];
  if (!queryVector?.length) return [];

  const allResults: RagResult[] = [];

  for (const collection of collections) {
    let rows: Array<Record<string, unknown>>;

    if (config.retrievalStrategy === "hybrid") {
      rows = await hybridSearch(config, collection, queryVector, query, topK * 2, filter);
    } else if (config.retrievalStrategy === "bm25") {
      rows = await vectorSearch(config, collection, queryVector, topK * 2, filter);
    } else {
      rows = await vectorSearch(config, collection, queryVector, topK * 2, filter);
    }

    for (let i = 0; i < rows.length; i++) {
      allResults.push(toRagResult(rows[i], 1 / (i + 1)));
    }
  }

  if (config.bgeRerankerUrl && allResults.length > 0) {
    const passages = allResults.map((r) => r.text);
    const scores = await bgeRerank(config.bgeRerankerUrl, query, passages, config.timeoutMs ?? 15000);
    for (let i = 0; i < allResults.length; i++) {
      allResults[i].rerank_score = scores[i] ?? 0;
    }
  }

  for (const result of allResults) {
    const baseScore = result.rerank_score > 0 ? result.rerank_score : result.rrf_score;
    const boost = AUTH_BOOST[result.authority] ?? 1.0;
    result.rerank_score = baseScore * boost;
  }

  allResults.sort((a, b) => {
    const aScore = a.rerank_score > 0 ? a.rerank_score : a.rrf_score;
    const bScore = b.rerank_score > 0 ? b.rerank_score : b.rrf_score;
    return bScore - aScore;
  });

  if (config.rerankScoreMin > 0 && config.bgeRerankerUrl) {
    return allResults.filter((r) => r.rerank_score >= config.rerankScoreMin);
  }

  return allResults;
}
