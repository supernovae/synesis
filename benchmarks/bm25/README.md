# BM25 Benchmark: Custom Microservice vs Milvus Native

Compares three retrieval conditions on the same corpus and query set:

| Condition | BM25 Engine | Corpus Text | Fusion |
|-----------|-------------|-------------|--------|
| **A** | Custom bm25-service (BM25Okapi + suffix stemmer) | Enriched (heading + summary + doc name + keywords + tags + text) | Client-side RRF |
| **B1** | Milvus native BM25 Function (English analyzer) | Raw `text` field only | Milvus RRFRanker |
| **B2** | Milvus native BM25 Function (English analyzer) | Enriched `bm25_text` (same concat as A) | Milvus RRFRanker |

## What it measures

- **Quality**: Recall@{5,10,20}, MRR@{10,20}, NDCG@{10,20}
- **Latency**: p50/p95/p99 end-to-end retrieval time per query
- **Enrichment signal**: B1 vs B2 isolates whether metadata concatenation helps or adds noise

## Quick start

```bash
# 0. Install the reproducible benchmark environment
uv venv .venv
uv pip install --require-hashes -r requirements.lock

# 1. Port-forward to Milvus (if running locally)
oc port-forward svc/synesis-milvus 19530:19530 -n synesis-rag &

# 2. Set up the benchmark collection (copies from synesis_catalog)
python setup_bench_collection.py --milvus-uri http://localhost:19530 --drop

# 3. Run the benchmark
python bench_bm25.py \
    --milvus-uri http://localhost:19530 \
    --bm25-service-url http://localhost:8080 \
    --embedder-url http://localhost:8081/v1 \
    --runs 3 \
    --output results.json
```

## Files

- `queries.yaml` — 45 benchmark queries across all corpus domains
- `setup_bench_collection.py` — Creates `synesis_catalog_bm25bench` with native BM25 fields
- `bench_bm25.py` — Runs all three conditions, computes metrics, outputs report
- `relevance_labels.json` — Auto-generated on first run via pooling heuristic
- `results.json` — Full output with per-query breakdowns and aggregated metrics

## Interpreting results

- **B1 beats B2**: Your metadata enrichment is adding noise — Milvus native on raw text is sufficient
- **B2 beats B1**: The enrichment trick genuinely helps recall
- **A beats both B**: The custom stemmer or BM25Okapi implementation handles your corpus better than Milvus's English analyzer
- **B matches/beats A with lower latency**: Migration is worth it — eliminate the bm25-service pod
