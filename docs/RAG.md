# Hybrid RAG Pipeline

Synesis uses a **unified catalog** (`synesis_catalog`) — a single Milvus collection with `pack_id` as partition key for all domain knowledge. Normal external ingestion writes to `pack_id="global"`; managed Doc Packs write to versioned pack partitions such as `go-latest` or `python-3.13`. The unified indexer (`base/rag/indexer/`) writes enrichment fields (`context_prefix`, `heading_path`, `chunk_summary`, `keywords`, `tags`, `document_name`) and provenance metadata (`authority`, `origin_type`, `source_url`). **Ingestion topology** (queue, Milvus v17, optional preprocess/spam/gatekeeper, trust attribution, dependent services) is documented in [INDEXERS.md](INDEXERS.md), [SYNPACKS.md](SYNPACKS.md), and [INGESTION_ENRICHMENT.md](INGESTION_ENRICHMENT.md).

## How It Works (planner-ts)

The active planner runtime (`base/planner-ts/`) retrieves evidence through the unified retrieval path (`base/planner-ts/src/retrieval/unified.ts`). The router dispatches parallel RAG and web searches, merging results via Reciprocal Rank Fusion (RRF).

1. **Milvus Hybrid Search**: The RAG client (`base/planner-ts/src/retrieval/rag-client.ts`) queries Milvus using its native `hybrid_search` (dense vectors + sparse BM25 vectors in a single request).

2. **Cross-Encoder Reranking**: The merged candidates are re-scored by the configured reranker (BGE cross-encoder by default, FlashRank as a faster alternative). The reranker computes query-passage relevance scores that are more accurate than the initial retrieval scores.

3. **Similarity-Gap Adaptive Top-K**: Instead of returning a fixed number of results, the pipeline detects the natural "relevance cliff" — the point where reranker scores drop sharply. Results above the cliff are included; results below are dropped. This cuts token waste from low-relevance filler.

4. **Unified RRF Merge**: RAG results and web search results are merged via a second RRF pass in `retrieveUnified()`, producing a single ranked evidence list with source provenance.

### Planned parity items (engineering tracker)

Retrieval parity and remaining items are tracked in [development/chat-planner-ts-feature-tracker.md](development/chat-planner-ts-feature-tracker.md):

- **Keyword query distillation** — distilling the user query into focused keyphrases via the keyword-service before retrieval. Prevents keyword pollution that causes irrelevant matches.
- **Multi-query expansion** — generating 3 query variants (direct, HyDE hypothetical document, conceptual expansion with taxonomy hints) retrieved in parallel and merged via RRF.
- **In-process BM25** — replaced by Milvus server-side sparse retrieval.

## Re-ranker Options

| Re-ranker | Size | Latency | Accuracy | Mode |
|-----------|------|---------|----------|------|
| **BGE-reranker-v2-m3** (default) | ~1.1GB | ~50-200ms | High | Separate service (HTTP) |
| **FlashRank** | ~34MB | ~4ms | Good for simple queries | Inline single-vector scoring |

BGE runs as a dedicated microservice (`bge-reranker`) following the ML service boundary pattern — heavy ML dependencies stay out of the planner image. FlashRank runs inline in the planner process with no external dependencies.

## Research Basis

Retrieval-related papers (IterKey, CAR, HyDE, L-RAG, Higress-RAG, RRF, original RAG) are listed with links in **[AWESOME_PAPERS.MD — RAG and retrieval](AWESOME_PAPERS.MD#rag-and-retrieval)**. The bullets below stay as a **Synesis mapping** only:

- **IterKey** — keyword query distillation before retrieval.
- **CAR** — similarity-gap adaptive top-K after reranking.
- **RRF** — merge vector + BM25, RAG + web, and multi-query lanes without score calibration.
- **HyDE** — hypothetical document embedding for dense recall.
- **L-RAG** — adaptive web gating when RAG scores are already strong.
- **Higress-RAG** — informed unified multi-source retrieval layout.

## Resilience

If the BGE reranker service is unreachable, the reranker gracefully falls back to returning results in their RRF-merged order. The Perses dashboard tracks fallback events so you can monitor service health.

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

| `RAG_RRF_K` | `60` | RRF fusion constant |
| `RAG_BGE_RERANKER_URL` | (empty) | BGE service URL (enable accuracy mode) |

## Observability

Three Prometheus metrics and Perses panels track retrieval health:

- **Retrieval Source Distribution**: Pie chart showing proportion of results from vector, BM25 (sparse), or both retrievers — useful for understanding which retriever is winning and whether your RAG corpus works better with semantic or keyword search.
- **Re-ranker Latency (p50/p95)**: Time series of reranking latency by reranker type (FlashRank, BGE).

## Content Integrity

RAG chunks are scanned for prompt injection patterns at index time.
Each chunk receives a `scan_status` field in the Milvus schema (`clean`,
`flagged`, or `unscanned`). Flagged chunks appear in the Admin UI review
queue (`/rag/review`) where operators can vet (upgrade authority) or
reject (delete) them.

All RAG content — including vetted documents — is wrapped as
`<context trust="untrusted">` in LLM prompts. Vetting boosts
ranking via the authority hierarchy (`canonical` > `vetted` >
`community` > `external`) but does not bypass trust boundaries.

See [SECURITY.md](SECURITY.md) for the full defense-in-depth model.

## Deploying BGE Reranker

The BGE reranker service runs as a separate deployment in the planner namespace:

```bash
# Deploy the BGE reranker service
oc apply -k base/planner/bge-reranker/

# Point planner-ts to it
oc set env deployment/synesis-planner-ts -n synesis-planner \
  SYNESIS_RAG_RERANKER=bge \
  SYNESIS_RAG_BGE_RERANKER_URL=http://bge-reranker.synesis-planner.svc.cluster.local:8000
```

---

Back to [README](../README.md) | See also: [Knowledge Indexers](INDEXERS.md) | [Web Search & Multi-Source Federation](WEB_SEARCH.md)
