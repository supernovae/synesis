"""Unified parallel retrieval — RAG + web search in a single async step.

Runs internal RAG retrieval immediately and fires web search in background;
web results merge in only if they arrive within the RAG budget.  Results are
fused via authority-weighted Reciprocal Rank Fusion.

Post-retrieval pipeline:
  Phase 5:  adaptive top-K via cliff detection
  Phase 5b: cohesion lock detection (dominant entity from top 3)
  Phase 5c: cohesion micro-critic filtering (embedding + parallel LLM)
  Phase 5d: contextual compression (sentence-level extraction)

Coherence gate (Phase 6) was removed — Milvus hybrid search + FlashRank
cross-encoder reranking + rerank-score floor handle relevance filtering.
See docs/COHERENCE_GATE_ARCHIVE.md for rationale and restoration guide.

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
import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from .config import settings
from .rag_client import retrieve_context
from .search_sources import get_search_sources, select_sources
from .web_search import SearchResult, search_and_process, search_sources_parallel

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

# Catalog domain IDs are lowercase alphanumeric + underscore (e.g. kubernetes, software_architecture).
# Free-text tags (spaces, punctuation) must not be used in Milvus domain filter or retrieval returns 0.
_CATALOG_DOMAIN_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")


def _normalize_domain_hints_for_filter(domain_hints: list[str] | None) -> list[str]:
    """Keep only hints that look like catalog domain IDs; drop free-text to avoid 0-result filters."""
    if not domain_hints:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for h in domain_hints:
        s = str(h).strip().lower() if h else ""
        if not s or s in seen:
            continue
        if _CATALOG_DOMAIN_RE.match(s):
            out.append(s)
            seen.add(s)
    return out[:10]


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
    domain: str = ""
    source_id: str = ""  # search source catalog id (e.g. "web_general", "code_general")


@dataclass
class RetrievalBundle:
    """Results from retrieve_unified() with optional cohesion lock and phase timings."""

    results: list[UnifiedResult]
    cohesion_lock: dict[str, Any] | None = None
    rag_degraded: bool = False
    web_degraded: bool = False
    degradation_notes: str = ""
    phase_timings: dict[str, float] = field(default_factory=dict)


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
                domain=getattr(r, "domain", "") or "",
            )
        )
    return out


def _web_to_unified(web_results: list[SearchResult], source_weight: float = 1.0) -> list[UnifiedResult]:
    """Convert SearchResult objects to UnifiedResult with authority boost.

    Web results get the same AUTHORITY_BOOST multipliers so that a
    [R:canonical] web result from an internal search engine ranks
    alongside canonical RAG hits, while [W] external results rank lower.
    source_weight is an additional multiplier from the search source catalog.
    """
    from .injection_scanner import reduce_context_on_injection, scan_web_content

    out: list[UnifiedResult] = []
    for r in web_results:
        body = r.fetched_content.strip() if r.fetched_content else ""
        if not body:
            body = r.snippet[:300].replace("\n", " ").strip()
        if body:
            scan = scan_web_content(body, source=f"web:{r.url[:80]}")
            if scan.detected:
                body = reduce_context_on_injection(body, "")
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
                score=r.relevance * boost * source_weight,
                is_trusted=r.is_trusted,
                title=r.title or "",
                source_id=getattr(r, "source_id", "") or "",
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


def _taxonomy_boost(
    results: list[UnifiedResult],
    domain_hints: list[str] | None = None,
    boost: float = 1.15,
) -> list[UnifiedResult]:
    """Apply a score boost to results whose origin domain matches taxonomy hints.

    When the frame extraction identifies specific domain tags (e.g. "kubernetes",
    "python"), results from matching domains are boosted to float higher in the
    ranking. This prevents topical drift in broad queries where generic popular
    sources would otherwise outrank domain-specific ones.

    Boost is multiplicative (default 15%) and applied before cliff detection
    so that domain-aligned results have a better chance of surviving the cut.
    """
    if not domain_hints or not results:
        return results

    hint_set = {h.lower().strip() for h in domain_hints if h}
    if not hint_set:
        return results

    boosted = 0
    for r in results:
        doc_domain = getattr(r, "domain", "").lower().strip()
        doc_tags = set()
        if doc_domain:
            doc_tags.add(doc_domain)
        if hasattr(r, "document_name") and r.document_name:
            doc_tags.add(r.document_name.lower().strip())

        if hint_set & doc_tags or (doc_domain and doc_domain in hint_set):
            r.score *= boost
            boosted += 1

    if boosted:
        results.sort(key=lambda r: r.score, reverse=True)
        logger.debug("taxonomy_boost_applied", extra={"boosted": boosted, "hints": list(hint_set)[:5]})

    return results


def _parse_preferred_domains(preferred_domains: list[str] | None) -> set[str]:
    """Extract bare domain names from 'site:X' style scope strings."""
    if not preferred_domains:
        return set()
    domains: set[str] = set()
    for scope in preferred_domains:
        d = scope.replace("site:", "").strip().lower()
        if d:
            domains.add(d)
    return domains


def _preferred_domain_boost(
    results: list[UnifiedResult],
    preferred_domains: list[str] | None = None,
    boost: float = 1.4,
) -> list[UnifiedResult]:
    """Boost web results from taxonomy-preferred domains.

    Replaces the previous approach of injecting site: operators into the
    search query (which broke non-web engines and filtered out all results
    when the preferred domains didn't cover the query topic). Instead, results
    from preferred domains get a multiplicative score boost so they rank
    higher when available, without excluding everything else.
    """
    domains = _parse_preferred_domains(preferred_domains)
    if not domains or not results:
        return results

    boosted = 0
    for r in results:
        if r.retrieval_source != "web" or not r.source_url:
            continue
        try:
            host = (urlparse(r.source_url).hostname or "").lower()
        except Exception:
            continue
        if any(host == d or host.endswith("." + d) for d in domains):
            r.score *= boost
            boosted += 1

    if boosted:
        results.sort(key=lambda r: r.score, reverse=True)
        logger.debug(
            "preferred_domain_boost_applied",
            extra={"boosted": boosted, "domains": sorted(domains)[:5]},
        )

    return results


def _restrict_domain_filter(
    results: list[UnifiedResult],
    preferred_domains: list[str] | None = None,
) -> list[UnifiedResult]:
    """Drop web results whose URL hostname is not in the allowed domain list.

    Used in 'restrict' domain_policy mode for locked-down environments that
    only want results from approved domains. RAG results are never filtered.
    """
    domains = _parse_preferred_domains(preferred_domains)
    if not domains or not results:
        return results

    kept: list[UnifiedResult] = []
    dropped = 0
    for r in results:
        if r.retrieval_source != "web":
            kept.append(r)
            continue
        if not r.source_url:
            kept.append(r)
            continue
        try:
            host = (urlparse(r.source_url).hostname or "").lower()
        except Exception:
            kept.append(r)
            continue
        if any(host == d or host.endswith("." + d) for d in domains):
            kept.append(r)
        else:
            dropped += 1

    if dropped:
        logger.info(
            "restrict_domain_filter_applied",
            extra={"dropped": dropped, "kept": len(kept), "domains": sorted(domains)[:5]},
        )

    return kept


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


async def _multi_source_web_search(
    query: str,
    domain_hints: list[str] | None = None,
    search_source_ids: list[str] | None = None,
) -> dict[str, list[SearchResult]]:
    """Select and fan-out across configured search sources in parallel.

    Falls back to the legacy single-profile search_and_process() when no
    source catalog is configured or only the default web_general source is active.
    """
    all_sources = get_search_sources()
    if not all_sources:
        results = await search_and_process(query, profile="web", fetch_pages=True)
        return {"web_general": results}

    if search_source_ids:
        selected = [s for s in all_sources if s.id in search_source_ids]
    else:
        selected = select_sources(
            all_sources,
            domain_tags=domain_hints,
        )

    if not selected:
        results = await search_and_process(query, profile="web", fetch_pages=True)
        return {"web_general": results}

    # Single source: use direct search for efficiency
    if len(selected) == 1:
        src = selected[0]
        results = await search_and_process(
            query,
            profile="web" if not src.searxng_params.get("engines") else "code",
            fetch_pages=src.fetch_pages,
        )
        for r in results:
            r.source_id = src.id
        return {src.id: results}

    # Multiple sources: parallel fan-out
    source_dicts = [
        {
            "source_id": src.id,
            "searxng_params": src.searxng_params,
            "trust": {"authority": src.trust.authority, "origin_type": src.trust.origin_type},
            "max_results": src.max_results,
            "fetch_pages": src.fetch_pages,
        }
        for src in selected
    ]
    return await search_sources_parallel(query, source_dicts)


async def retrieve_unified(
    query: str,
    difficulty: float = 0.5,
    collections: list[str] | None = None,
    top_k: int = 8,
    web_query: str = "",
    force_web: bool = False,
    domain_hints: list[str] | None = None,
    skip_web: bool = False,
    search_source_ids: list[str] | None = None,
    preferred_domains: list[str] | None = None,
    preseeded_lock: Any = None,
) -> RetrievalBundle:
    """Parallel RAG + multi-source web retrieval with authority-weighted RRF fusion.

    Args:
      query: RAG retrieval query (frame-distilled when available).
      web_query: Separate concise web search query. If empty, falls back
                 to query[:120].  Frame-driven callers should always provide
                 a dedicated web_query for search-engine-friendly results.
      domain_hints: Taxonomy domain tags from frame extraction. Used as a
                    post-retrieval score boost (Phase 4b), NOT as a Milvus
                    filter.  The user's query drives retrieval breadth.
      skip_web: When True (e.g. needs_web=false in frame), web search is
                disabled regardless of other settings.
      search_source_ids: Explicit list of search source IDs to query. When
                         provided, overrides automatic source selection.
      preferred_domains: Taxonomy-derived preferred web domains (e.g.
                         ["site:kubernetes.io"]). Applied as a post-retrieval
                         boost or restrict filter based on domain_policy mode,
                         NOT injected into the search query string.

    Returns:
      RetrievalBundle with results and optional cohesion_lock metadata.

    Steps:
      1. asyncio.gather(RAG, multi-source web) — parallel execution
      2. Convert both to UnifiedResult with authority metadata preserved
      3. Adaptive web gating (L-RAG pattern): if RAG returns 3+ results,
         cap web slots so RAG dominates; if RAG is empty, web fills the gap
      3b. Domain policy: prefer (boost) or restrict (filter) by taxonomy domains
      4. RRF merge into one ranked list
      5. Adaptive top-k via cliff detection
      5b. Cohesion lock detection (dominant entity from top 3)
      5c. Cohesion micro-critic filtering (embedding + parallel LLM)
      5d. Contextual compression (sentence-level extraction)
    """
    if collections is None:
        collections = ["synesis_catalog"]

    # Taxonomy domain hints are used ONLY as a post-retrieval boost (Phase 4b),
    # never as a Milvus WHERE-clause filter.  The user's query drives retrieval;
    # taxonomy lifts domain-matching results higher in the ranking but never
    # hides cross-domain content that the reranker would keep.
    domain_filter = ""

    web_budget = settings.scaled_web_budget(difficulty)
    web_enabled = settings.web_search_enabled and (web_budget > 0 or force_web) and not skip_web

    overfetch_min = getattr(settings, "rag_overfetch_min", 30)
    overfetch_max = getattr(settings, "rag_overfetch_max", 50)
    overfetch = int(overfetch_min + difficulty * (overfetch_max - overfetch_min))

    t_total = time.monotonic()

    # Phase 1: RAG-first retrieval — web search fires in background.
    # RAG results flow immediately; web merges in only if it finishes
    # within the RAG budget (no extra waiting).
    _WEB_GRACE_MS = 500  # max ms to wait for web AFTER RAG completes
    t_phase1 = time.monotonic()
    rag_coro = retrieve_context(query=query, collections=collections, top_k=overfetch, domain_filter=domain_filter)

    web_task: asyncio.Task | None = None
    if web_enabled:
        effective_web_query = web_query if web_query else query[:120]
        web_task = asyncio.create_task(
            _multi_source_web_search(
                effective_web_query,
                domain_hints=domain_hints,
                search_source_ids=search_source_ids,
            ),
            name="web_search",
        )

    # Await RAG — this is the critical path.
    try:
        rag_raw = await rag_coro
    except Exception as rag_exc:
        rag_raw = rag_exc

    # If web task is running, give it a short grace period after RAG completes.
    web_multi_raw: dict[str, list[SearchResult]] = {}
    if web_task is not None:
        if web_task.done():
            try:
                web_multi_raw = web_task.result()
            except Exception as web_exc:
                web_multi_raw = web_exc
        else:
            try:
                web_multi_raw = await asyncio.wait_for(
                    asyncio.shield(web_task), timeout=_WEB_GRACE_MS / 1000
                )
            except (TimeoutError, asyncio.TimeoutError):
                logger.info(
                    "web_search_still_running",
                    extra={"query": query[:60], "grace_ms": _WEB_GRACE_MS},
                )
                web_multi_raw = {}
            except Exception as web_exc:
                web_multi_raw = web_exc

    phase1_ms = (time.monotonic() - t_phase1) * 1000

    _rag_degraded = False
    _web_degraded = False
    _degradation_notes_parts: list[str] = []

    if isinstance(rag_raw, BaseException):
        logger.warning("unified_rag_failed", extra={"error": str(rag_raw)[:200]})
        rag_raw = []
        _rag_degraded = True
        _degradation_notes_parts.append("RAG retrieval failed")
    if isinstance(web_multi_raw, BaseException):
        logger.warning("unified_web_failed", extra={"error": str(web_multi_raw)[:200]})
        web_multi_raw = {}
        _web_degraded = True
        _degradation_notes_parts.append("Web search failed")

    # Flatten multi-source web results into a single list with source-weight
    web_raw: list[SearchResult] = []
    _source_weights: dict[str, float] = {}
    if isinstance(web_multi_raw, dict):
        for sid, results in web_multi_raw.items():
            web_raw.extend(results)
            if results:
                _source_weights[sid] = results[0].score if results else 1.0
        if web_multi_raw:
            _src_summary = {sid: len(res) for sid, res in web_multi_raw.items() if res}
            if _src_summary:
                _degradation_notes_parts.append(
                    f"Sources queried: {', '.join(f'{k}({v})' for k, v in _src_summary.items())}"
                )

    # Phase 2: convert to unified format (authority metadata preserved)
    rag_unified = _rag_to_unified(rag_raw)
    web_unified = _web_to_unified(web_raw)

    # Phase 2b: graceful degradation — when RAG is empty/failed and web was
    # skipped, force a fallback web search so the user still gets evidence.
    if not rag_unified and not web_unified and not web_enabled and settings.web_search_enabled:
        _rag_degraded = True
        _degradation_notes_parts.append("Local evidence unavailable, expanding to web search")
        logger.info(
            "unified_rag_empty_web_fallback",
            extra={"query": query[:80], "skip_web_overridden": True},
        )
        effective_web_query = (web_query if web_query else query[:120]).strip()
        fallback_candidates: list[str] = [effective_web_query]
        compact_query = " ".join(effective_web_query.split()[:12]).strip()
        if compact_query and compact_query != effective_web_query:
            fallback_candidates.append(compact_query)
        if domain_hints:
            scope_query = f"{compact_query or effective_web_query} {' '.join(domain_hints[:2])}".strip()
            if scope_query and scope_query not in fallback_candidates:
                fallback_candidates.append(scope_query)

        for idx, candidate in enumerate(fallback_candidates[:3], start=1):
            try:
                web_raw_fb = await search_and_process(candidate, profile="web", fetch_pages=True)
                web_unified = _web_to_unified(web_raw_fb if not isinstance(web_raw_fb, BaseException) else [])
            except Exception:
                logger.warning(
                    "unified_web_fallback_failed", extra={"attempt": idx, "query": candidate[:80]}, exc_info=True
                )
                web_unified = []
                _degradation_notes_parts.append(f"Web fallback attempt {idx} failed")
                continue

            if web_unified:
                _degradation_notes_parts.append(f"Web fallback attempt {idx} succeeded ({len(web_unified)} hits)")
                break
            _degradation_notes_parts.append(f"Web fallback attempt {idx} returned no usable results")

        if not web_unified:
            _web_degraded = True
            _degradation_notes_parts.append("Web fallback exhausted without usable results")
    elif not rag_unified and not _rag_degraded:
        _rag_degraded = True
        _degradation_notes_parts.append("RAG returned no results")

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

    # Phase 3b: domain policy — boost or restrict web results by taxonomy domains
    if preferred_domains and web_unified:
        _domain_policy_mode = getattr(settings, "domain_policy_mode", "prefer")
        if _domain_policy_mode == "restrict":
            web_unified = _restrict_domain_filter(web_unified, preferred_domains)
        else:
            _boost = getattr(settings, "domain_policy_boost", 1.4)
            web_unified = _preferred_domain_boost(web_unified, preferred_domains, boost=_boost)

    # Phase 4: RRF merge
    merged = _rrf_merge(rag_unified, web_unified, k=settings.rag_rrf_k)

    # Phase 4b: taxonomy domain-match boost — lift results matching frame domain_tags
    merged = _taxonomy_boost(merged, domain_hints=domain_hints)

    # Phase 5: adaptive top-K via similarity-gap cliff detection (CAR, arXiv:2511.14769).
    gap_mult = getattr(settings, "rag_adaptive_gap_multiplier", 1.5)
    final = _adaptive_topk(merged, max_k=top_k, gap_multiplier=gap_mult)

    # Phase 5b-5d: Cohesion Lock pipeline — inter-document coherence filtering.
    # When a preseeded_lock is provided (from intent anchors), skip Phase 5b
    # detection and go straight to filtering/compression.
    cohesion_lock_dict: dict[str, Any] | None = None
    phase5b_ms = 0.0
    if settings.cohesion_lock_enabled and len(final) >= settings.cohesion_lock_min_results:
        _t_phase5b = time.monotonic()
        from .cohesion import cohesion_filter, compress_to_cohesion, detect_cohesion_lock

        if preseeded_lock is not None:
            lock = preseeded_lock
            logger.info(
                "cohesion_lock_preseeded",
                extra={
                    "entity": lock.entity,
                    "source": lock.source,
                    "exclude_signals": lock.exclude_signals[:5],
                },
            )
        else:
            lock = await detect_cohesion_lock(final, top_n=3)
        if lock is not None:
            cohesion_lock_dict = lock.to_dict()
            pre_filter_count = len(final)
            filtered = await cohesion_filter(final, lock, protected_top_n=3)
            filtered = await compress_to_cohesion(filtered, lock)

            survival_rate = len(filtered) / max(pre_filter_count, 1)
            if survival_rate < 0.2 and pre_filter_count >= 5:
                logger.warning(
                    "cohesion_too_aggressive",
                    extra={
                        "lock_entity": lock.entity,
                        "pre_filter": pre_filter_count,
                        "post_filter": len(filtered),
                        "survival_rate": round(survival_rate, 2),
                        "action": "reverting to pre-cohesion results",
                    },
                )
                _degradation_notes_parts.append(
                    f"Cohesion lock '{lock.entity}' removed {pre_filter_count - len(filtered)}/{pre_filter_count} results — reverted"
                )
            else:
                final = filtered

            logger.info(
                "cohesion_pipeline_complete",
                extra={
                    "lock_entity": lock.entity,
                    "lock_type": lock.lock_type,
                    "pre_filter": pre_filter_count,
                    "post_filter": len(final),
                    "survival_rate": round(survival_rate, 2),
                },
            )
        phase5b_ms = (time.monotonic() - _t_phase5b) * 1000

    total_retrieval_ms = (time.monotonic() - t_total) * 1000
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
            "skip_web": skip_web,
            "domain_filter": domain_filter or "(none)",
            "cohesion_lock": (cohesion_lock_dict or {}).get("entity", "(none)"),
        },
    )
    logger.info(
        "unified_retrieval_phase_timing",
        extra={
            "query": query[:80],
            "phase1_rag_web_ms": round(phase1_ms, 1),
            "phase5b_cohesion_ms": round(phase5b_ms, 1),
            "total_ms": round(total_retrieval_ms, 1),
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

    return RetrievalBundle(
        results=final,
        cohesion_lock=cohesion_lock_dict,
        rag_degraded=_rag_degraded,
        web_degraded=_web_degraded,
        degradation_notes="; ".join(_degradation_notes_parts) if _degradation_notes_parts else "",
        phase_timings={
            "phase1_rag_web_ms": round(phase1_ms, 1),
            "phase5b_cohesion_ms": round(phase5b_ms, 1),
            "total_ms": round(total_retrieval_ms, 1),
        },
    )


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
