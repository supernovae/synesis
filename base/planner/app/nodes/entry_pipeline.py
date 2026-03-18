"""Entry Pipeline — runs classifier, then advisor + frame_extractor concurrently.

Replaces the sequential entry_classifier -> strategic_advisor -> frame_extractor
chain with a single graph node that parallelizes the two independent branches:

    entry_classifier (150ms, deterministic)
         |
         +---> strategic_advisor  (~1s, tiny LLM)
         |          |
         +---> frame_extractor   (~8s, GLiNER service)
         |          |
         +---> predictive_cache_warm (best-effort, non-blocking)
         |          |
         v----------v
       merged state update

strategic_advisor and frame_extractor have zero data dependencies on each
other — both only read entry_classifier outputs (task_description, difficulty,
taxonomy_metadata, etc.).  Running them concurrently saves ~1s.

predictive_cache_warm uses the keyword service to extract likely retrieval
queries from the raw user message and pre-populates the cache so the router's
first evidence requests may already be cached.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from ..config import settings
from ..streaming_events import emit_sub_phase
from ..synesis_tracer import get_synesis_tracer
from .entry_classifier import entry_classifier_node
from .frame_extractor import frame_extractor_node
from .strategic_advisor import strategic_advisor_node

logger = logging.getLogger("synesis.entry_pipeline")


def _has_session_context(state: dict[str, Any]) -> bool:
    """True when a prior checkpoint already populated frame + style contract."""
    frame = state.get("semantic_frame")
    contract = state.get("style_contract_locked")
    return bool(frame) and bool(contract)


async def entry_pipeline_node(state: dict[str, Any]) -> dict[str, Any]:
    """Single graph node that replaces the 3-node sequential entry chain."""

    import time as _time

    _t0 = _time.monotonic()

    # Phase 1: classifier (fast, deterministic — always runs so difficulty is fresh)
    emit_sub_phase("Classifying request\u2026")
    classified = entry_classifier_node(state)
    if asyncio.iscoroutine(classified):
        classified = await classified

    _classifier_ms = (_time.monotonic() - _t0) * 1000

    _tracer = get_synesis_tracer()
    if _tracer:
        _tracer.record_phase_timing("entry.classifier_ms", _classifier_ms)
        taxonomy_meta = classified.get("taxonomy_metadata") or {}
        if taxonomy_meta:
            _tracer.set_taxonomy(taxonomy_meta)

    _difficulty = classified.get("difficulty", 0)
    _intent = classified.get("intent_class", "")
    emit_sub_phase(f"Classified: {_intent} (difficulty {_difficulty:.1f})")

    # Session resume: if a prior checkpoint already set semantic_frame and
    # style_contract_locked, skip the expensive advisor + frame_extractor.
    # The classifier still runs so difficulty and taxonomy are up to date.
    if _has_session_context(state):
        logger.info(
            "session_resumed",
            extra={"has_frame": True, "has_contract": True},
        )
        emit_sub_phase("Resuming session context\u2026")
        classified["current_node"] = "entry_pipeline"
        return classified

    # Fast-path: skip advisor (~1s) and frame_extractor (~4-8s) when:
    #   1. Trivial tasks (difficulty < 0.15)
    #   2. Easy no-retrieval tasks (rag_mode=disabled, no plan required)
    # In "selective" mode, the rag_mode=disabled threshold is higher (0.5
    # vs 0.3), so more prompts hit this fast path.
    _is_easy_no_retrieval = classified.get("rag_mode") == "disabled" and not classified.get("plan_required")
    if classified.get("task_is_trivial") or _is_easy_no_retrieval:
        _reason = "trivial task" if classified.get("task_is_trivial") else "simple task, no retrieval needed"
        emit_sub_phase(f"Fast-path: {_reason}")
        logger.info(
            "entry_pipeline_fast_path",
            extra={
                "difficulty": classified.get("difficulty", 0),
                "rag_mode": classified.get("rag_mode", ""),
                "classifier_ms": round(_classifier_ms, 1),
                "skipped": "advisor+frame_extractor",
            },
        )
        if _tracer:
            _tracer.annotate_span(
                "entry_pipeline",
                {
                    "fast_path": {
                        "reason": _reason,
                        "difficulty": classified.get("difficulty", 0),
                        "rag_mode": classified.get("rag_mode", ""),
                        "classifier_ms": round(_classifier_ms, 1),
                        "skipped": "advisor+frame_extractor",
                    },
                },
            )
        classified["current_node"] = "entry_pipeline"
        return classified

    # Build intermediate state visible to the parallel branches
    merged_input = {**state, **classified}

    # Phase 2: advisor + frame extractor + predictive warm (all concurrent)
    emit_sub_phase("Extracting intent & assessing strategy\u2026")
    _t_parallel = _time.monotonic()
    advisor_result, frame_result, _ = await asyncio.gather(
        _ensure_coro(strategic_advisor_node(merged_input)),
        _ensure_coro(frame_extractor_node(merged_input)),
        _predictive_cache_warm(merged_input),
    )
    _parallel_ms = (_time.monotonic() - _t_parallel) * 1000
    if _tracer:
        _tracer.record_phase_timing("entry.parallel_ms", _parallel_ms)

    # Merge all outputs; later keys win (frame > advisor > classifier)
    combined: dict[str, Any] = {}
    combined.update(classified)
    combined.update(advisor_result)
    combined.update(frame_result)

    # Merge node_traces from all three phases
    traces: list[Any] = []
    for src in (classified, advisor_result, frame_result):
        traces.extend(src.get("node_traces") or [])
    combined["node_traces"] = traces

    combined["current_node"] = "entry_pipeline"

    _total_ms = (_time.monotonic() - _t0) * 1000
    if _tracer:
        _tracer.record_phase_timing("entry.total_ms", _total_ms)
    logger.info(
        "entry_pipeline_complete",
        extra={
            "difficulty": classified.get("difficulty", 0),
            "task_is_trivial": classified.get("task_is_trivial", False),
            "classifier_ms": round(_classifier_ms, 1),
            "total_ms": round(_total_ms, 1),
        },
    )

    return combined


async def _ensure_coro(result: Any) -> Any:
    """Await if coroutine, return directly otherwise."""
    if asyncio.iscoroutine(result):
        return await result
    return result


_kw_async_client: httpx.AsyncClient | None = None


def _get_keyword_async_client() -> httpx.AsyncClient:
    global _kw_async_client
    if _kw_async_client is None:
        _kw_async_client = httpx.AsyncClient(
            base_url=settings.keyword_service_url,
            timeout=5,
        )
    return _kw_async_client


async def _predictive_cache_warm(state: dict[str, Any]) -> None:
    """Best-effort pre-warming of keyword + embedder services during entry.

    Extracts keywords and pre-computes embeddings for likely retrieval queries.
    The main benefits are:
    1. Warms TCP/TLS connections to keyword-service and TEI embedder
    2. Pre-computes query embeddings that the router's semantic cache
       will need shortly after — reduces first-call latency

    Failures are silently logged. This must never block or slow the pipeline.
    """
    task_desc = (state.get("task_description") or "").strip()
    difficulty = state.get("difficulty", 0.5)
    if not task_desc or difficulty < 0.15:
        return

    try:
        kw_client = _get_keyword_async_client()
        resp = await kw_client.post(
            "/keywords",
            json={
                "text": task_desc[:500],
                "top_n": 5,
                "ngram_range": [1, 2],
                "use_mmr": True,
                "diversity": 0.5,
            },
        )
        resp.raise_for_status()
        keywords = resp.json().get("keywords") or []

        if not keywords:
            return

        terms = [kw[0] for kw in keywords[:5] if isinstance(kw, (list, tuple))]
        if not terms:
            return

        # Pre-embed likely query strings to warm the embedder connection
        # and prime any internal TEI caching
        from ..embed_client import get_async_embed_client

        embed = get_async_embed_client()
        queries = [
            " ".join(terms[:3]),
            f"{terms[0]} {terms[-1]} architecture" if len(terms) >= 2 else terms[0],
        ]
        await embed.embed(queries, normalize=True)

        logger.debug(
            "predictive_cache_warm",
            extra={"queries": len(queries), "keywords": terms},
        )
    except Exception:
        logger.debug("predictive_cache_warm_skipped", exc_info=True)
