# Hybrid RAG Pipeline

Synesis uses a **unified catalog** (`synesis_catalog`) — a single Milvus collection with `authority` as partition key for all domain knowledge. The unified indexer (`base/rag/indexer/`) writes to this catalog with enrichment fields (`context_prefix`, `heading_path`, `chunk_summary`, `keywords`, `document_name`) and provenance metadata (`authority`, `origin_type`, `source_url`). A hybrid retrieval pipeline combines semantic vector search with keyword-based BM25, merged via Reciprocal Rank Fusion (RRF), and refined by a cross-encoder reranker. Semantic search catches paraphrases; BM25 catches exact syntax (critical for code). The BM25 corpus includes heading_path and chunk_summary for richer keyword matching.

## How It Works

1. **Keyword Query Distillation**: Before retrieval, the user query is distilled into focused keyphrases using the keyword-service microservice (reusing the TEI embedder for embeddings). This extracts the salient terms from the query instead of sending raw prompt text, preventing keyword pollution that causes irrelevant matches.

2. **Adaptive Overfetch**: The number of candidates fetched from Milvus scales with the continuous difficulty score (30 candidates for simple queries, up to 50 for complex ones). Complex queries benefit from a wider candidate net; simple queries avoid noise.

3. **Ensemble Retrieval**: The distilled query is sent to both retrievers in parallel:
   - **Vector search** (Milvus): Embeds the query and finds semantically similar chunks via cosine similarity.
   - **BM25 search** (in-memory): Keyword matching using BM25Okapi, built from chunks cached from Milvus at startup and refreshed every 10 minutes.

4. **Reciprocal Rank Fusion**: Results from both retrievers (over `synesis_catalog`) are merged using RRF (`score = sum(1/(k + rank))`). Each result is tagged with its source ("vector", "bm25", or "both").

5. **Cross-Encoder Reranking**: The merged candidates are re-scored by the configured reranker (BGE cross-encoder by default, FlashRank as a faster alternative). The reranker computes query-passage relevance scores that are more accurate than the initial retrieval scores.

6. **Similarity-Gap Adaptive Top-K**: Instead of returning a fixed number of results, the pipeline detects the natural "relevance cliff" — the point where reranker scores drop sharply. Results above the cliff are included; results below are dropped. This cuts token waste from low-relevance filler.

## Re-ranker Options

| Re-ranker | Size | Latency | Accuracy | Mode |
|-----------|------|---------|----------|------|
| **BGE-reranker-v2-m3** (default) | ~1.1GB | ~50-200ms | High | Separate service (HTTP) |
| **FlashRank** | ~34MB | ~4ms | Good for simple queries | Inline single-vector scoring |

BGE runs as a dedicated microservice (`bge-reranker`) following the ML service boundary pattern — heavy ML dependencies stay out of the planner image. FlashRank runs inline in the planner process with no external dependencies.

## Research Basis

The retrieval pipeline is informed by the following research:

- **IterKey** (arXiv:2505.08450) — Iterative keyword generation for RAG retrieval. Demonstrates 5-20% accuracy improvement over raw BM25 queries. Basis for the keyword query distillation step.
- **Cluster-based Adaptive Retrieval (CAR)** (arXiv:2511.14769) — Detects transition points in query-document similarity distances to dynamically determine retrieval depth. Achieves 60% token reduction and 10% hallucination reduction. Basis for the similarity-gap adaptive top-K.
- **Reciprocal Rank Fusion (RRF)** (Cormack et al., 2009) — Score-agnostic rank fusion for combining heterogeneous retrieval sources. Used for merging vector + BM25 results, and for merging RAG + web results in unified retrieval.
- **L-RAG** (arXiv:2601.06551) — Entropy-based gating that skips retrieval when not needed. Basis for the adaptive web gating logic that caps web results when RAG is strong.
- **Higress-RAG** (arXiv:2602.23374) — Full-link RRF fusion across retrieval sources with CRAG and adaptive routing. Informed the unified retrieval architecture.

## Resilience

If Milvus or the embedder service goes down, the pipeline automatically degrades to **BM25-only** from cached chunks. No external dependency is needed for BM25 — it runs entirely in the planner's memory. This means retrieval continues even during vector service outages, and the Perses dashboard tracks fallback events so you can monitor service health.

If the BGE reranker service is unreachable, the reranker gracefully falls back to returning results in their RRF-merged order. If the keyword service fails, query distillation falls back to first-sentence truncation.

## Per-Request Control

Pass an optional `retrieval` object in the chat completion request to override strategy and re-ranker:

```bash
curl -X POST https://synesis-api.apps.openshiftdemo.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "synesis-agent",
    "messages": [{"role": "user", "content": "Write a bash trap handler"}],
    "retrieval": {
      "strategy": "hybrid",
      "reranker": "bge",
      "top_k": 5
    }
  }'
```

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `strategy` | `hybrid`, `vector`, `bm25` | `hybrid` | Which retrievers to use |
| `reranker` | `flashrank`, `bge`, `none` | `bge` | Reranker model |
| `top_k` | integer | `5` | Max results to return (adaptive top-K may return fewer) |

## Configuration

All retrieval settings are environment variables (prefixed `SYNESIS_`):

| Setting | Default | Description |
|---------|---------|-------------|
| `RAG_RETRIEVAL_STRATEGY` | `hybrid` | Default retrieval strategy |
| `RAG_RERANKER` | `flashrank` | Default reranker (`flashrank`, `bge`, `none`) |
| `RAG_RERANKER_MODEL` | `ms-marco-MiniLM-L-12-v2` | FlashRank model variant (only used when reranker=flashrank) |
| `RAG_OVERFETCH_MIN` | `30` | Minimum candidates fetched from Milvus (at difficulty=0) |
| `RAG_OVERFETCH_MAX` | `50` | Maximum candidates fetched from Milvus (at difficulty=1) |
| `RAG_ADAPTIVE_GAP_MULTIPLIER` | `1.5` | Similarity-gap cliff threshold (higher = less aggressive pruning) |
| `RAG_BM25_REFRESH_INTERVAL_SECONDS` | `600` | BM25 index rebuild interval |
| `RAG_RRF_K` | `60` | RRF fusion constant |
| `RAG_BGE_RERANKER_URL` | (empty) | BGE service URL (enable accuracy mode) |

## Observability

Three Prometheus metrics and Perses panels track retrieval health:

- **Retrieval Source Distribution**: Pie chart showing proportion of results from vector, BM25, or both retrievers — useful for understanding which retriever is winning and whether your RAG corpus works better with semantic or keyword search.
- **Re-ranker Latency (p50/p95)**: Time series of reranking latency by reranker type (FlashRank, BGE).
- **BM25 Fallback Rate**: Tracks how often the pipeline falls back to BM25-only due to vector service failures. A sustained non-zero rate indicates Milvus/embedder health issues.

## Deploying BGE Reranker

The BGE reranker service runs as a separate deployment in the planner namespace:

```bash
# Deploy the BGE reranker service
oc apply -k base/planner/bge-reranker/

# Point the planner to it
oc set env deployment/synesis-planner -n synesis-planner \
  SYNESIS_RAG_RERANKER=bge \
  SYNESIS_RAG_BGE_RERANKER_URL=http://bge-reranker.synesis-planner.svc.cluster.local:8000
```

---

Back to [README](../README.md) | See also: [Knowledge Indexers](INDEXERS.md)
