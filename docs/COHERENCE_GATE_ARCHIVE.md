# Coherence Gate — Archive & Decision Record

> **Status**: Removed (March 2026)
> **Decision**: Rely on Milvus hybrid search + FlashRank reranking + rerank-score floor instead.
> **Restore from**: git history, or re-implement from the specification below.

## What It Was

A post-retrieval filter (Phase 6 in `unified_retrieval.py`) that re-embedded every
retrieved chunk alongside the query, computed pairwise cosine similarity, and dropped
chunks below a threshold (default 0.25).

```
query + N chunks  →  TEI embedder (batch of N+1 texts)  →  cosine sim  →  keep/drop
```

### Configuration

| Setting | Default | Purpose |
|---|---|---|
| `coherence_gate_threshold` | 0.25 | Minimum query-chunk cosine similarity |
| Difficulty < 0.3 | threshold + 0.05 | Stricter for easy tasks |
| Difficulty > 0.7 | threshold - 0.05 | Looser for hard tasks |

### Code Location (before removal)

- **Function**: `_coherence_gate()` in `base/planner/app/unified_retrieval.py`
- **Called from**: Phase 6, after cohesion filtering (Phase 5b)
- **Dependencies**: `AsyncEmbedClient.embed()` from `base/planner/app/embed_client.py`

## Why It Existed

When Synesis used a standalone BM25 index (pre-Milvus native BM25), polysemous term
matches were common. For example, "architecture" in a consensus algorithm paper would
score high on keyword match but was semantically distant from "AI assistant architecture."

The coherence gate was a safety net: re-embed everything and verify semantic proximity
to the query at the full-text level.

### Research Basis

- **CRAG** (arXiv 2401.15884) — Grade retrieved docs as Correct/Incorrect/Ambiguous
- **Self-RAG** (arXiv 2310.11511) — IsRel reflection: skip irrelevant retrieval
- **NQ-RAG** (arXiv 2411.19483) — Query-document coherence scoring
- **ARES** (arXiv 2311.09476) — Automated RAG evaluation via NLI

## Why It Was Removed

### 1. Redundant with Milvus Hybrid Search

Milvus native hybrid search already computes:
- **Dense arm**: COSINE similarity on HNSW index (same embedding model as the gate)
- **Sparse arm**: BM25 scoring on inverted index
- **RRF fusion**: Combines both arms into a single relevance score

The coherence gate was re-doing the dense arm's work on truncated text (first 500 chars
vs. the full embedding), making it both slower and less accurate than the original search.

### 2. Redundant with FlashRank Cross-Encoder

FlashRank reranking (`ms-marco-MiniLM-L-12-v2`) runs a cross-encoder that jointly
encodes (query, document) pairs. This is strictly more powerful than the cosine similarity
check the coherence gate performed — cross-encoders capture query-document interaction
that bi-encoder cosine similarity misses.

### 3. Massive Latency Cost

For a query returning 50 results, the coherence gate:
- Batched 51 texts (query + 50 × 500-char chunks) to the TEI embedder
- Waited for a full embedding round-trip (~3-10s depending on embedder load)
- Computed 50 dot products (~0ms, negligible)

This added 3-10 seconds per retrieval query — nearly the entire budget for what should
be a 3-4 second operation.

### 4. Replaced by Rerank Score Floor

A simpler, faster check: drop any result whose FlashRank `rerank_score` falls below
a configurable minimum (default 0.05). This uses scores already computed during
reranking — zero additional latency.

## How to Re-enable If Needed

If future retrieval quality regresses (e.g., polysemous matches slip through after
a Milvus or reranker change), consider these options in order:

1. **Raise the rerank score floor** (`rag_rerank_score_min` in config.py) — cheapest fix
2. **Tighten overfetch** — fewer candidates means fewer marginal matches
3. **Re-implement the coherence gate behind a feature flag**:
   - Add `coherence_gate_enabled: bool = False` to config.py
   - Restore `_coherence_gate()` from git history
   - Gate it: `if settings.coherence_gate_enabled: final = await _coherence_gate(...)`
   - Consider running it only when `top_rerank_score < 0.3` (low-confidence retrieval)

### Implementation Sketch (if restoring)

```python
async def _coherence_gate(
    query: str,
    results: list[UnifiedResult],
    threshold: float = 0.25,
) -> list[UnifiedResult]:
    if not results:
        return results
    try:
        from .embed_client import get_async_embed_client
        client = get_async_embed_client()
        chunk_texts = [r.text[:500] for r in results]
        all_texts = [query, *chunk_texts]
        embeddings = await client.embed(all_texts, normalize=True)
        query_emb = embeddings[0]
        kept = []
        for r, chunk_emb in zip(results, embeddings[1:]):
            sim = float(np.dot(query_emb, chunk_emb))
            if sim >= threshold:
                kept.append(r)
        return kept
    except Exception:
        return results
```

## Other Changes Made Alongside Removal

These changes were part of the same retrieval speed-up effort:

| Change | Rationale |
|---|---|
| `fetch_k` reduced from `top_k × 4` to `top_k × 2` | 200→100 candidates cuts Milvus + rerank time |
| Web search non-blocking | RAG results flow immediately; web merges in if ready within budget |
| Milvus pool `list_collections` validation removed | Try-search-and-recover instead of pre-flight check |
| Milvus keepalive between router passes | Prevent stale gRPC channels on second evidence pass |
| Rerank score floor added (`rag_rerank_score_min`) | Lightweight replacement for coherence gate filtering |
| Retrieval timeout raised from 45s to 90s | Safety margin while pipeline stabilizes |
