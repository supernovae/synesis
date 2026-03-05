# Hybrid RAG Pipeline

Synesis uses a **unified catalog** (`synesis_catalog`) — a single Milvus collection for all domain knowledge. Indexers (language packs, domain runbooks, code, API specs, etc.) write to this catalog with metadata (`domain`, `indexer_source`). A hybrid retrieval pipeline combines semantic vector search with keyword-based BM25 over the catalog, merged via Reciprocal Rank Fusion (RRF), and refined by a cross-encoder re-ranker. Semantic search catches paraphrases; BM25 catches exact syntax (critical for code).

## How It Works

1. **Ensemble Retrieval**: The user query is sent to both retrievers in parallel:
   - **Vector search** (Milvus): Embeds the query and finds semantically similar chunks via cosine similarity.
   - **BM25 search** (in-memory): Keyword matching using BM25Okapi, built from chunks cached from Milvus at startup and refreshed every 10 minutes.

2. **Reciprocal Rank Fusion**: Results from both retrievers (over `synesis_catalog`) are merged using RRF (`score = sum(1/(k + rank))`). Each result is tagged with its source ("vector", "bm25", or "both").

3. **Cross-Encoder Re-ranking**: The merged candidates are re-scored by a cross-encoder that evaluates the (query, document) pair jointly — unlike the retrievers which score documents independently.

## Re-ranker Options

| Re-ranker | Size | Latency | Accuracy | Infrastructure |
|-----------|------|---------|----------|----------------|
| **FlashRank** (default) | ~34MB | ~4ms | Good | None — runs inline in the planner |
| **BGE-reranker-v2-m3** | ~1.1GB | ~50-200ms | Best | Separate service in planner namespace |

## Resilience

If Milvus or the embedder service goes down, the pipeline automatically degrades to **BM25-only** from cached chunks. No external dependency is needed for BM25 — it runs entirely in the planner's memory. This means retrieval continues even during vector service outages, and the Perses dashboard tracks fallback events so you can monitor service health.

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
      "reranker": "flashrank",
      "top_k": 5
    }
  }'
```

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `strategy` | `hybrid`, `vector`, `bm25` | `hybrid` | Which retrievers to use |
| `reranker` | `flashrank`, `bge`, `none` | `flashrank` | Cross-encoder re-ranker |
| `top_k` | integer | `5` | Number of results to return |

## Configuration

All retrieval settings are environment variables (prefixed `SYNESIS_`):

| Setting | Default | Description |
|---------|---------|-------------|
| `RAG_RETRIEVAL_STRATEGY` | `hybrid` | Default retrieval strategy |
| `RAG_RERANKER` | `flashrank` | Default cross-encoder re-ranker |
| `RAG_RERANKER_MODEL` | `ms-marco-MiniLM-L-12-v2` | FlashRank model variant |
| `RAG_BM25_REFRESH_INTERVAL_SECONDS` | `600` | BM25 index rebuild interval |
| `RAG_RRF_K` | `60` | RRF fusion constant |
| `RAG_BGE_RERANKER_URL` | (empty) | BGE service URL (enable accuracy mode) |
| `RAG_UNIFIED_CATALOG` | `true` | Use single synesis_catalog (false = legacy multi-collection) |

## Observability

Three Prometheus metrics and Perses panels track retrieval health:

- **Retrieval Source Distribution**: Pie chart showing proportion of results from vector, BM25, or both retrievers — useful for understanding which retriever is winning and whether your RAG corpus works better with semantic or keyword search.
- **Re-ranker Latency (p50/p95)**: Time series of cross-encoder re-ranking latency by re-ranker type.
- **BM25 Fallback Rate**: Tracks how often the pipeline falls back to BM25-only due to vector service failures. A sustained non-zero rate indicates Milvus/embedder health issues.

## Deploying BGE Reranker (Optional)

The BGE reranker service is only needed if you want the higher-accuracy mode. It's not deployed by default.

```bash
# Deploy the BGE reranker service
oc apply -k base/planner/bge-reranker/

# Point the planner to it
oc set env deployment/synesis-planner -n synesis-planner \
  SYNESIS_RAG_BGE_RERANKER_URL=http://bge-reranker.synesis-planner.svc.cluster.local:8000
```

---

Back to [README](../README.md) | See also: [Knowledge Indexers](INDEXERS.md)
