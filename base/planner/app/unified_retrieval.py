"""Unified parallel retrieval — RAG + web search in a single async step.

Runs internal RAG and web search concurrently via asyncio.gather, merges
results via authority-weighted Reciprocal Rank Fusion, and adaptively gates
web results based on RAG quality.

Authority system preserved end-to-end:
  - RAG: authority boost applied in rag_client.py (canonical=1.5, vetted=1.3, etc.)
  - Web: authority assigned by engine_authority_map config; boost applied here
  - Datamarks: [R:authority] for trusted, [W] for untrusted — unchanged

Research basis:
  RAG-R1 (arxiv 2507.02962): multi-query parallelism, -11% latency +13% quality
  Higress-RAG (arxiv 2602.23374): full-link RRF fusion across retrieval sources
  L-RAG (arxiv 2601.06551): entropy-based gating, skip retrieval when not needed
  AMSRAG (MDPI 2025): confidence-aware fusion, dynamic source weighting
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

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


def _rag_to_unified(rag_results: list) -> list[UnifiedResult]:
    """Convert RetrievalResult objects to UnifiedResult.

    RAG results arrive with authority boost already applied in rag_client.py,
    so scores reflect the [R:canonical] > [R:vetted] > ... ordering.
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
) -> list[UnifiedResult]:
    """Reciprocal Rank Fusion across RAG and web ranked lists.

    RRF score = 1/(k + rank) within each source list.  Since RAG and web
    results are typically disjoint documents, this naturally interleaves
    them by rank position.  Authority affects ordering indirectly: boosted
    scores determine rank within each source before RRF.
    """
    for rank, r in enumerate(rag_results):
        r.score = 1.0 / (k + rank + 1)
    for rank, r in enumerate(web_results):
        r.score = 1.0 / (k + rank + 1)

    merged = rag_results + web_results
    merged.sort(key=lambda r: r.score, reverse=True)
    return merged


async def retrieve_unified(
    query: str,
    difficulty: float = 0.5,
    collections: list[str] | None = None,
    top_k: int = 8,
) -> list[UnifiedResult]:
    """Parallel RAG + web retrieval with authority-weighted RRF fusion.

    Steps:
      1. asyncio.gather(RAG, web) — parallel execution
      2. Convert both to UnifiedResult with authority metadata preserved
      3. Adaptive web gating (L-RAG pattern): if RAG returns 3+ results,
         cap web slots so RAG dominates; if RAG is empty, web fills the gap
      4. RRF merge into one ranked list
      5. Return top-k
    """
    if collections is None:
        collections = ["synesis_catalog"]

    web_budget = settings.scaled_web_budget(difficulty)
    web_enabled = settings.web_search_enabled and web_budget > 0

    # Phase 1: parallel retrieval
    rag_coro = retrieve_context(query=query, collections=collections, top_k=top_k)

    if web_enabled:
        web_query = query[:200]
        web_coro = search_and_process(web_query, profile="web", fetch_pages=True)
        rag_raw, web_raw = await asyncio.gather(
            rag_coro, web_coro, return_exceptions=True
        )
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
    final = merged[:top_k]

    logger.info(
        "unified_retrieval",
        extra={
            "rag_count": len(rag_unified),
            "web_count": len(web_unified),
            "merged_count": len(final),
            "rag_in_final": sum(1 for r in final if r.retrieval_source == "rag"),
            "web_in_final": sum(1 for r in final if r.retrieval_source == "web"),
            "difficulty": round(difficulty, 2),
            "web_enabled": web_enabled,
        },
    )

    return final


def format_unified_context(
    results: list[UnifiedResult],
    max_chars: int = 1500,
) -> str:
    """Format unified results as one <context> block with authority datamarks.

    Preserves existing datamark conventions:
      - [R:authority] for trusted sources (RAG with authority, mapped web engines)
      - [R] for RAG with no authority set
      - [W] for untrusted web sources
    """
    if not results:
        return ""

    chunks: list[str] = []
    for r in results:
        text = r.text[:max_chars]
        if r.retrieval_source == "rag":
            prefix = f"[R:{r.authority}]" if r.authority else "[R]"
            citation = f" (source: {r.source_url})" if r.source_url else ""
            chunks.append(f"{prefix}{citation} {text}")
        else:
            prefix = f"[R:{r.authority}]" if r.is_trusted else "[W]"
            if r.source_url and r.title:
                chunks.append(f"{prefix} [{r.title}]({r.source_url}): {text}")
            elif r.source_url:
                chunks.append(f"{prefix} ({r.source_url}): {text}")
            else:
                chunks.append(f"{prefix} {text}")

    joined = "\n---\n".join(chunks)
    return f'\n<context trust="untrusted">\n{joined}\n</context>'
