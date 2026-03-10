"""Unified parallel retrieval — RAG + web search in a single async step.

Runs internal RAG and web search concurrently via asyncio.gather, merges
results via authority-weighted Reciprocal Rank Fusion, and adaptively gates
web results based on RAG quality.

Post-retrieval coherence gate (Phase 6) validates each chunk against the
query using sentence-transformers cosine similarity, dropping off-topic
results before they enter the prompt context.

Authority system preserved end-to-end:
  - RAG: authority boost applied in rag_client.py (canonical=1.5, vetted=1.3, etc.)
  - Web: authority assigned by engine_authority_map config; boost applied here
  - Datamarks: [R:authority] for trusted, [W] for untrusted — unchanged

Research basis:
  RAG-R1 (arxiv 2507.02962): multi-query parallelism, -11% latency +13% quality
  Higress-RAG (arxiv 2602.23374): full-link RRF fusion across retrieval sources
  L-RAG (arxiv 2601.06551): entropy-based gating, skip retrieval when not needed
  AMSRAG (MDPI 2025): confidence-aware fusion, dynamic source weighting
  CRAG (arxiv 2401.15884): grade retrieved docs as Correct/Incorrect/Ambiguous
  Self-RAG (arxiv 2310.11511): IsRel reflection — skip irrelevant retrieval
  NQ-RAG (arxiv 2411.19483): query-document coherence scoring
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import numpy as np

from .config import settings
from .rag_client import retrieve_context
from .web_search import SearchResult, search_and_process

logger = logging.getLogger("synesis.unified_retrieval")

# Same authority boost as rag_client.py (RA-RAG, arxiv 2410.22954).
# Applied to web results here; RAG results arrive pre-boosted.
AUTHORITY_BOOST: dict[str, float] = {
    "canonical": 1.5,
    "vetted": 1.3,
    "community": 1.0,
    "external": 0.7,
    "": 1.0,
}

_MIN_RAG_FOR_GATING = 3


@dataclass
class UnifiedResult:
    """A single retrieval result from any source (RAG or web)."""

    text: str
    source_url: str = ""
    authority: str = ""
    origin_type: str = ""
    retrieval_source: str = ""  # "rag" or "web"
    score: float = 0.0
    is_trusted: bool = False
    title: str = ""
    heading_path: str = ""
    context_prefix: str = ""
    chunk_summary: str = ""
    document_name: str = ""


def _rag_to_unified(rag_results: list) -> list[UnifiedResult]:
    """Convert RetrievalResult objects to UnifiedResult.

    RAG results arrive with authority boost already applied in rag_client.py,
    so scores reflect the [R:canonical] > [R:vetted] > ... ordering.
    Enrichment fields (heading_path, context_prefix, chunk_summary, document_name)
    are passed through for the context formatter.
    """
    out: list[UnifiedResult] = []
    for r in rag_results:
        score = r.rerank_score if r.rerank_score > 0 else r.rrf_score
        auth = getattr(r, "authority", "") or ""
        out.append(
            UnifiedResult(
                text=r.text[:1500],
                source_url=getattr(r, "source_url", "") or "",
                authority=auth,
                origin_type=getattr(r, "origin_type", "") or "",
                retrieval_source="rag",
                score=score,
                is_trusted=bool(auth and auth != "external"),
                title=getattr(r, "source", "") or "",
                heading_path=getattr(r, "heading_path", "") or "",
                context_prefix=getattr(r, "context_prefix", "") or "",
                chunk_summary=getattr(r, "chunk_summary", "") or "",
                document_name=getattr(r, "document_name", "") or "",
            )
        )
    return out


def _web_to_unified(web_results: list[SearchResult]) -> list[UnifiedResult]:
    """Convert SearchResult objects to UnifiedResult with authority boost.

    Web results get the same AUTHORITY_BOOST multipliers so that a
    [R:canonical] web result from an internal search engine ranks
    alongside canonical RAG hits, while [W] external results rank lower.
    """
    out: list[UnifiedResult] = []
    for r in web_results:
        body = r.fetched_content.strip() if r.fetched_content else ""
        if not body:
            body = r.snippet[:300].replace("\n", " ").strip()
        if not body:
            continue
        boost = AUTHORITY_BOOST.get(r.authority, AUTHORITY_BOOST["external"])
        out.append(
            UnifiedResult(
                text=body,
                source_url=r.url,
                authority=r.authority or "external",
                origin_type=r.origin_type or "external",
                retrieval_source="web",
                score=r.relevance * boost,
                is_trusted=r.is_trusted,
                title=r.title or "",
            )
        )
    return out


def _rrf_merge(
    rag_results: list[UnifiedResult],
    web_results: list[UnifiedResult],
    k: int = 60,
    original_weight: float = 0.3,
) -> list[UnifiedResult]:
    """Reciprocal Rank Fusion across RAG and web ranked lists.

    Blends RRF positional score with the original relevance score rather
    than overwriting it.  This preserves relevance information for
    downstream cliff detection and the coherence gate.

    final_score = rrf_score * (1 - original_weight) + original_score * original_weight

    A chunk with rerank_score 0.99 at rank 2 now scores meaningfully higher
    than a chunk with score 0.51 at rank 3, rather than being nearly equal.
    """
    for rank, r in enumerate(rag_results):
        rrf = 1.0 / (k + rank + 1)
        r.score = rrf * (1 - original_weight) + r.score * original_weight
    for rank, r in enumerate(web_results):
        rrf = 1.0 / (k + rank + 1)
        r.score = rrf * (1 - original_weight) + r.score * original_weight

    merged = rag_results + web_results
    merged.sort(key=lambda r: r.score, reverse=True)
    return merged


def _adaptive_topk(
    results: list[UnifiedResult],
    max_k: int = 8,
    gap_multiplier: float = 1.5,
) -> list[UnifiedResult]:
    """CAR-style similarity-gap cliff detection (arXiv:2511.14769).

    Finds the first score gap exceeding mean_gap * gap_multiplier and cuts
    there. This naturally adapts: narrow queries with 2 strong hits stop at 2;
    broad queries with 8 similar-scoring hits keep all 8.

    Falls back to results[:max_k] if no clear cliff or fewer than 3 results.
    """
    if len(results) < 3:
        return results[:max_k]

    scores = [r.score for r in results[:max_k]]
    gaps = [scores[i] - scores[i + 1] for i in range(len(scores) - 1)]
    if not gaps:
        return results[:max_k]

    mean_gap = sum(gaps) / len(gaps)
    threshold = mean_gap * gap_multiplier

    for i, gap in enumerate(gaps):
        if gap > threshold and i >= 1:
            cliff_k = i + 1
            logger.debug(
                "adaptive_topk_cliff",
                extra={"cliff_at": cliff_k, "max_k": max_k, "gap": round(gap, 4)},
            )
            return results[:cliff_k]

    return results[:max_k]


def _coherence_gate(
    query: str,
    results: list[UnifiedResult],
    threshold: float = 0.25,
) -> list[UnifiedResult]:
    """Drop chunks whose embedding similarity to the query falls below threshold.

    Uses the TEI embedder service via embed_client to compute cosine similarity
    between the query and each chunk. This catches polysemous-term matches where
    "architecture" in a consensus algorithm paper scores high on vector search
    but is semantically distant from "AI assistant architecture" when compared
    at the full-text level.

    Follows the Self-RAG principle: no retrieval is better than bad retrieval.
    If all chunks are dropped, the section worker proceeds without context.

    Research basis:
      CRAG (arXiv 2401.15884) — grade docs as Correct/Incorrect/Ambiguous
      Self-RAG (arXiv 2310.11511) — IsRel reflection: skip irrelevant retrieval
      NQ-RAG (arXiv 2411.19483) — query-document coherence scoring
      ARES (arXiv 2311.09476) — automated RAG evaluation via NLI
    """
    if not results:
        return results

    try:
        from .embed_client import get_embed_client

        client = get_embed_client()
        chunk_texts = [r.text[:500] for r in results]
        all_texts = [query, *chunk_texts]
        embeddings = client.embed(all_texts, normalize=True)
        query_emb = embeddings[0]
        chunk_embs = embeddings[1:]

        kept: list[UnifiedResult] = []
        dropped = 0
        for r, chunk_emb in zip(results, chunk_embs):
            sim = float(np.dot(query_emb, chunk_emb))
            if sim >= threshold:
                kept.append(r)
            else:
                dropped += 1
                logger.debug(
                    "coherence_gate_dropped",
                    extra={
                        "text_preview": r.text[:80].replace("\n", " "),
                        "similarity": round(sim, 3),
                        "source": r.retrieval_source,
                        "has_url": bool(r.source_url),
                        "url_preview": r.source_url[:80] if r.source_url else "",
                        "authority": r.authority,
                    },
                )

        if dropped:
            logger.info(
                "coherence_gate_summary",
                extra={"input": len(results), "kept": len(kept), "dropped": dropped},
            )

        return kept
    except Exception:
        logger.warning("coherence_gate_failed", exc_info=True)
        return results


async def retrieve_unified(
    query: str,
    difficulty: float = 0.5,
    collections: list[str] | None = None,
    top_k: int = 8,
    web_query: str = "",
    force_web: bool = False,
) -> list[UnifiedResult]:
    """Parallel RAG + web retrieval with authority-weighted RRF fusion.

    Args:
      query: RAG retrieval query (frame-distilled when available).
      web_query: Separate concise web search query. If empty, falls back
                 to query[:120].  Frame-driven callers should always provide
                 a dedicated web_query for search-engine-friendly results.

    Steps:
      1. asyncio.gather(RAG, web) — parallel execution
      2. Convert both to UnifiedResult with authority metadata preserved
      3. Adaptive web gating (L-RAG pattern): if RAG returns 3+ results,
         cap web slots so RAG dominates; if RAG is empty, web fills the gap
      4. RRF merge into one ranked list
      5. Adaptive top-k via cliff detection
      6. Coherence gate — drop off-topic chunks (CRAG/Self-RAG pattern)
    """
    if collections is None:
        collections = ["synesis_catalog"]

    web_budget = settings.scaled_web_budget(difficulty)
    web_enabled = settings.web_search_enabled and (web_budget > 0 or force_web)

    # Adaptive overfetch: cast a wider net for complex queries since more
    # corpus chunks may be relevant. The cross-encoder reranker handles the extra noise.
    overfetch_min = getattr(settings, "rag_overfetch_min", 30)
    overfetch_max = getattr(settings, "rag_overfetch_max", 50)
    overfetch = int(overfetch_min + difficulty * (overfetch_max - overfetch_min))

    # Phase 1: parallel retrieval
    rag_coro = retrieve_context(query=query, collections=collections, top_k=overfetch)

    if web_enabled:
        effective_web_query = web_query if web_query else query[:120]
        web_coro = search_and_process(effective_web_query, profile="web", fetch_pages=True)
        rag_raw, web_raw = await asyncio.gather(rag_coro, web_coro, return_exceptions=True)
    else:
        rag_raw = await rag_coro
        web_raw: list[SearchResult] = []

    if isinstance(rag_raw, BaseException):
        logger.warning("unified_rag_failed", extra={"error": str(rag_raw)[:200]})
        rag_raw = []
    if isinstance(web_raw, BaseException):
        logger.warning("unified_web_failed", extra={"error": str(web_raw)[:200]})
        web_raw = []

    # Phase 2: convert to unified format (authority metadata preserved)
    rag_unified = _rag_to_unified(rag_raw)
    web_unified = _web_to_unified(web_raw)

    rag_with_url = sum(1 for r in rag_unified if r.source_url)
    web_with_url = sum(1 for r in web_unified if r.source_url)
    logger.debug(
        "unified_url_census_phase2",
        extra={
            "rag_total": len(rag_unified),
            "rag_with_url": rag_with_url,
            "web_total": len(web_unified),
            "web_with_url": web_with_url,
        },
    )

    # Phase 3: adaptive web gating (L-RAG pattern)
    # Strong RAG (3+ results) → web supplements (capped slots)
    # Weak/empty RAG → web fills the gap (all slots available)
    rag_confident = len(rag_unified) >= _MIN_RAG_FOR_GATING
    if rag_confident:
        max_web = max(2, top_k // 3)
    else:
        max_web = top_k
    web_unified = web_unified[:max_web]

    if rag_confident and web_raw:
        logger.debug(
            "unified_web_gated",
            extra={
                "rag_count": len(rag_unified),
                "web_before": len(web_raw),
                "web_after": len(web_unified),
                "max_web": max_web,
            },
        )

    # Phase 4: RRF merge
    merged = _rrf_merge(rag_unified, web_unified, k=settings.rag_rrf_k)

    # Phase 5: adaptive top-K via similarity-gap cliff detection (CAR, arXiv:2511.14769).
    # Replaces fixed merged[:top_k] — stops at the relevance cliff instead of
    # always returning top_k results, cutting token waste from irrelevant filler.
    gap_mult = getattr(settings, "rag_adaptive_gap_multiplier", 1.5)
    final = _adaptive_topk(merged, max_k=top_k, gap_multiplier=gap_mult)

    # Phase 6: coherence gate — drop off-topic chunks (CRAG/Self-RAG pattern).
    # Validates each chunk's topical coherence against the query using the
    # sentence-transformers encoder.  If all chunks are dropped, the section
    # worker proceeds with no context (better than poisoned context).
    coherence_thresh = getattr(settings, "coherence_gate_threshold", 0.25)
    final = await asyncio.to_thread(_coherence_gate, query, final, coherence_thresh)

    urls_in_final = sum(1 for r in final if r.source_url)
    logger.info(
        "unified_retrieval",
        extra={
            "rag_count": len(rag_unified),
            "web_count": len(web_unified),
            "merged_count": len(final),
            "rag_in_final": sum(1 for r in final if r.retrieval_source == "rag"),
            "web_in_final": sum(1 for r in final if r.retrieval_source == "web"),
            "urls_in_final": urls_in_final,
            "difficulty": round(difficulty, 2),
            "web_enabled": web_enabled,
        },
    )
    if urls_in_final == 0 and len(final) > 0:
        logger.warning(
            "unified_retrieval_no_urls",
            extra={
                "final_count": len(final),
                "rag_urls_phase2": rag_with_url,
                "web_urls_phase2": web_with_url,
            },
        )

    return final


def format_unified_context(
    results: list[UnifiedResult],
    max_chars: int = 1500,
) -> str:
    """Format unified results as one <context> block with enriched metadata.

    Delegates to the shared context_formatter.format_context_block() which
    uses heading_path, document_name, chunk_summary, and authority markers.
    """
    from .context_formatter import format_context_block

    return format_context_block(results, max_chars_per_chunk=max_chars)
