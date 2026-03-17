"""Cohesion Lock Engine — post-retrieval inter-document coherence filtering.

Detects the dominant entity/theme from top retrieved documents, filters
incoherent docs via parallelized micro-critics, and compresses evidence
to sentences matching the lock.

Three-phase pipeline inserted into retrieve_unified() after adaptive top-K:
  Phase 5b: _detect_cohesion_lock()  — deterministic metadata + LLM fallback
  Phase 5c: _cohesion_filter()       — embedding tier + parallel LLM micro-critic
  Phase 5d: _compress_to_cohesion()  — sentence-level extraction

Conflict groups are loaded from cohesion_groups.yaml (data-driven, domain-agnostic)
and supplemented by LLM-discovered groups from the admin DB.

All embedding calls use the async TEI embedder (no new ML deps in-process).
LLM calls use the router model for lightweight JSON classification.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .config import settings
from .schemas import safe_parse_json

logger = logging.getLogger("synesis.cohesion")


@dataclass
class CohesionLock:
    """The detected dominant entity/theme for a retrieval set."""

    entity: str
    lock_type: str  # "generic" or "specific"
    exclude_signals: list[str]
    confidence: float = 0.0
    source: str = ""  # "metadata" or "llm"

    def to_dict(self) -> dict[str, Any]:
        return {
            "entity": self.entity,
            "type": self.lock_type,
            "exclude_signals": self.exclude_signals,
            "confidence": self.confidence,
            "source": self.source,
        }


# ---------------------------------------------------------------------------
# Phase 5b: Cohesion Lock Detection
# ---------------------------------------------------------------------------

_domain_brand_pattern: re.Pattern[str] | None = None


def _get_domain_brand_pattern() -> re.Pattern[str]:
    """Build regex pattern from all loaded conflict group members.

    Lazy-init so pattern reflects YAML + DB groups.
    """
    global _domain_brand_pattern
    if _domain_brand_pattern is not None:
        return _domain_brand_pattern
    _ensure_loaded()
    all_entities = sorted(_ENTITY_EXCLUSION_MAP.keys(), key=len, reverse=True)
    if not all_entities:
        _domain_brand_pattern = re.compile(r"(?!)")  # never-match
        return _domain_brand_pattern
    escaped = [re.escape(e) for e in all_entities]
    _domain_brand_pattern = re.compile(
        r"\b(" + "|".join(escaped) + r")\b",
        re.IGNORECASE,
    )
    return _domain_brand_pattern


def _extract_metadata_entities(results: list[Any]) -> Counter[str]:
    """Extract entity signals from result metadata (document_name, heading_path, authority)."""
    pattern = _get_domain_brand_pattern()
    entities: Counter[str] = Counter()
    for r in results:
        for field in ("document_name", "heading_path", "title"):
            text = getattr(r, field, "") or ""
            if text:
                for match in pattern.finditer(text):
                    entities[match.group(0).lower()] += 1
    return entities


def _detect_cohesion_lock_deterministic(
    results: list[Any],
    top_n: int = 3,
) -> CohesionLock | None:
    """Try to detect cohesion lock from metadata alone (no LLM call).

    If 2 of top 3 results share a specific entity, lock to it.
    Returns None when metadata is ambiguous — caller should try LLM fallback.
    """
    if len(results) < top_n:
        return None

    top_results = results[:top_n]
    entities = _extract_metadata_entities(top_results)

    if not entities:
        return None

    most_common_entity, count = entities.most_common(1)[0]
    if count >= 2:
        exclude_signals = _build_exclusion_signals(most_common_entity)
        return CohesionLock(
            entity=most_common_entity,
            lock_type="specific",
            exclude_signals=exclude_signals,
            confidence=count / top_n,
            source="metadata",
        )

    return None


# ---------------------------------------------------------------------------
# YAML-driven conflict groups + exclusion map
# ---------------------------------------------------------------------------

_COHESION_GROUPS_PATH = os.environ.get(
    "SYNESIS_COHESION_GROUPS_PATH",
    str(Path(__file__).parent / "cohesion_groups.yaml"),
)

_ENTITY_EXCLUSION_MAP: dict[str, list[str]] = {}
_CONFLICT_GROUPS: dict[str, set[str]] = {}
_ALIAS_MAP: dict[str, str] = {}  # alias -> canonical member
_YAML_LOADED = False


def _load_cohesion_groups_yaml() -> None:
    """Load conflict groups from cohesion_groups.yaml and derive exclusion map.

    Called once at first access.  Falls back to empty if file is missing.
    """
    global _YAML_LOADED
    if _YAML_LOADED:
        return
    _YAML_LOADED = True

    try:
        import yaml

        with open(_COHESION_GROUPS_PATH) as f:
            raw = yaml.safe_load(f) or {}
    except Exception:
        logger.warning("cohesion_groups_yaml_load_failed path=%s", _COHESION_GROUPS_PATH, exc_info=True)
        return

    for group_name, cfg in raw.items():
        members_raw = cfg.get("members") or []
        members = {m.lower() for m in members_raw if m}
        if len(members) < 2:
            continue
        _CONFLICT_GROUPS[group_name] = members

        aliases = cfg.get("aliases") or {}
        for canonical, alias_list in aliases.items():
            canonical_l = canonical.lower()
            for alias in alias_list or []:
                _ALIAS_MAP[alias.lower()] = canonical_l
                members.add(alias.lower())

        for member in members:
            _ENTITY_EXCLUSION_MAP[member] = [m for m in members if m != member]

    logger.info(
        "cohesion_groups_loaded",
        extra={"groups": len(_CONFLICT_GROUPS), "entities": len(_ENTITY_EXCLUSION_MAP), "path": _COHESION_GROUPS_PATH},
    )


def _ensure_loaded() -> None:
    if not _YAML_LOADED:
        _load_cohesion_groups_yaml()


def _build_exclusion_signals(entity: str) -> list[str]:
    """Build a list of entities to exclude based on the locked entity."""
    _ensure_loaded()
    canonical = _ALIAS_MAP.get(entity.lower(), entity.lower())
    return _ENTITY_EXCLUSION_MAP.get(canonical, [])


def _merge_db_conflict_groups(db_groups: list[dict]) -> None:
    """Merge admin-approved conflict groups into _CONFLICT_GROUPS at startup."""
    global _domain_brand_pattern
    _ensure_loaded()
    for entry in db_groups:
        name = entry.get("group_name", "")
        members = entry.get("members", [])
        exclusion_map = entry.get("exclusion_map", {})
        if name and members and len(members) >= 2:
            _CONFLICT_GROUPS[name] = set(m.lower() for m in members)
            for entity, excludes in exclusion_map.items():
                el = entity.lower()
                _ENTITY_EXCLUSION_MAP[el] = [e.lower() for e in excludes]
            logger.info(
                "conflict_group_loaded_from_db",
                extra={"group": name, "members": members[:6]},
            )
    if db_groups:
        _domain_brand_pattern = None  # invalidate cached regex


def get_conflict_groups() -> dict[str, set[str]]:
    """Public accessor for conflict groups (used by anchor resolver)."""
    _ensure_loaded()
    return _CONFLICT_GROUPS


_LOCK_DETECT_PROMPT = """\
Analyze these {n} document summaries and identify the dominant conceptual frame.

Documents:
{docs}

Output ONLY valid JSON:
{{"entity": "<dominant topic/brand/concept>", "type": "generic|specific", "exclude_signals": ["<conflicting topics to filter out>"]}}

Rules:
- "specific" when docs converge on a single brand/tool/framework/methodology (e.g. "AWS", "Ford", "FDM 3D printing", "SLA criteria")
- "generic" when docs converge on a theoretical/conceptual topic (e.g. "transformer architecture", "RAG pipeline design", "additive manufacturing")
- exclude_signals: topics that would conflict with the dominant frame (any domain, not just tech)
- If docs are too diverse to lock, use: {{"entity": "", "type": "generic", "exclude_signals": []}}"""


async def _detect_cohesion_lock_llm(
    results: list[Any],
    top_n: int = 3,
) -> CohesionLock | None:
    """Use the router LLM to detect cohesion lock when metadata is ambiguous."""
    if not settings.cohesion_lock_llm_fallback:
        return None

    top_results = results[:top_n]
    doc_summaries = []
    for i, r in enumerate(top_results):
        text_preview = (getattr(r, "text", "") or "")[:200]
        doc_name = getattr(r, "document_name", "") or ""
        heading = getattr(r, "heading_path", "") or ""
        doc_summaries.append(f"[{i + 1}] doc={doc_name} heading={heading}\n{text_preview}")

    try:
        from langchain_core.messages import HumanMessage, SystemMessage
        from langchain_openai import ChatOpenAI

        from .llm_telemetry import get_llm_http_client

        _cohesion_kw: dict[str, Any] = {}
        if settings.guided_json_enabled:
            _cohesion_kw["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
        else:
            _cohesion_kw["response_format"] = {"type": "json_object"}

        llm = ChatOpenAI(
            base_url=settings.router_model_url,
            api_key="not-needed",
            model=settings.router_model_name,
            temperature=0.0,
            max_completion_tokens=512 if not settings.guided_json_enabled else 128,
            streaming=False,
            use_responses_api=False,
            model_kwargs=_cohesion_kw,
            http_client=get_llm_http_client(uds_path=settings.router_model_uds or None),
        )

        prompt = _LOCK_DETECT_PROMPT.format(
            n=len(doc_summaries),
            docs="\n---\n".join(doc_summaries),
        )

        resp = await llm.ainvoke(
            [
                SystemMessage(content="You classify document sets. Output only JSON."),
                HumanMessage(content=prompt),
            ]
        )

        data = safe_parse_json(resp.content or "")
        entity = data.get("entity", "")
        if not entity:
            return None

        return CohesionLock(
            entity=entity,
            lock_type=data.get("type", "generic"),
            exclude_signals=data.get("exclude_signals", []),
            confidence=0.7,
            source="llm",
        )
    except Exception:
        logger.warning("cohesion_lock_llm_failed", exc_info=True)
        return None


async def detect_cohesion_lock(
    results: list[Any],
    top_n: int = 3,
) -> CohesionLock | None:
    """Detect the cohesion lock for a set of retrieval results.

    Strategy: deterministic metadata analysis first, LLM fallback for ambiguous cases.
    """
    if not settings.cohesion_lock_enabled:
        return None
    if len(results) < settings.cohesion_lock_min_results:
        return None

    lock = _detect_cohesion_lock_deterministic(results, top_n)
    if lock is not None:
        logger.info(
            "cohesion_lock_detected",
            extra={
                "entity": lock.entity,
                "type": lock.lock_type,
                "source": lock.source,
                "confidence": lock.confidence,
                "exclude_signals": lock.exclude_signals[:5],
            },
        )
        return lock

    lock = await _detect_cohesion_lock_llm(results, top_n)
    if lock is not None:
        logger.info(
            "cohesion_lock_detected",
            extra={
                "entity": lock.entity,
                "type": lock.lock_type,
                "source": lock.source,
                "confidence": lock.confidence,
                "exclude_signals": lock.exclude_signals[:5],
            },
        )
    return lock


# ---------------------------------------------------------------------------
# Phase 5c: Micro-Critic Filtering
# ---------------------------------------------------------------------------

_MICRO_CRITIC_PROMPT = """\
Cohesion lock: "{entity}" ({lock_type}).
Exclude signals: {exclude_signals}

Does this document align with the cohesion lock?

Document:
{doc_text}

Output ONLY valid JSON: {{"keep": true/false, "reason": "one sentence"}}"""


async def _micro_critic_llm_single(
    doc_text: str,
    lock: CohesionLock,
) -> dict[str, Any]:
    """Single LLM micro-critic call for one document."""
    try:
        from langchain_core.messages import HumanMessage, SystemMessage
        from langchain_openai import ChatOpenAI

        from .llm_telemetry import get_llm_http_client

        _mc_kw: dict[str, Any] = {}
        if settings.guided_json_enabled:
            _mc_kw["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
        else:
            _mc_kw["response_format"] = {"type": "json_object"}

        llm = ChatOpenAI(
            base_url=settings.router_model_url,
            api_key="not-needed",
            model=settings.router_model_name,
            temperature=0.0,
            max_completion_tokens=256 if not settings.guided_json_enabled else 64,
            streaming=False,
            use_responses_api=False,
            model_kwargs=_mc_kw,
            http_client=get_llm_http_client(uds_path=settings.router_model_uds or None),
        )

        prompt = _MICRO_CRITIC_PROMPT.format(
            entity=lock.entity,
            lock_type=lock.lock_type,
            exclude_signals=", ".join(lock.exclude_signals[:5]),
            doc_text=doc_text[:300],
        )

        resp = await llm.ainvoke(
            [
                SystemMessage(content="You are a document relevance filter. Output only JSON."),
                HumanMessage(content=prompt),
            ]
        )

        return safe_parse_json(resp.content or "")
    except Exception:
        logger.debug("micro_critic_llm_failed", exc_info=True)
        return {"keep": True, "reason": "LLM micro-critic failed; keeping by default"}


async def cohesion_filter(
    results: list[Any],
    lock: CohesionLock,
    protected_top_n: int = 3,
) -> list[Any]:
    """Filter results against the cohesion lock.

    Top N results are protected (they defined the lock). Remaining docs
    are evaluated with a two-tier approach: embedding similarity first,
    LLM micro-critic for borderline cases.
    """
    if not settings.cohesion_micro_critic_enabled or not lock.entity:
        return results
    if len(results) <= protected_top_n:
        return results

    protected = results[:protected_top_n]
    candidates = results[protected_top_n:]

    if not candidates:
        return results

    # Tier 1: Embedding-based fast filter
    try:
        from .embed_client import get_async_embed_client

        client = get_async_embed_client()
        lock_texts = [lock.entity]
        candidate_texts = [(getattr(c, "text", "") or "")[:200] for c in candidates]
        all_texts = lock_texts + candidate_texts
        embeddings = await client.embed(all_texts, normalize=True)

        lock_emb = embeddings[0]
        candidate_embs = embeddings[1:]

        kept: list[Any] = []
        borderline: list[tuple[int, Any]] = []
        dropped_embedding = 0

        for i, (cand, cand_emb) in enumerate(zip(candidates, candidate_embs)):
            sim = float(np.dot(lock_emb, cand_emb))

            if sim >= settings.cohesion_llm_borderline_high:
                kept.append(cand)
            elif sim < settings.cohesion_embedding_threshold:
                dropped_embedding += 1
                logger.debug(
                    "cohesion_filter_dropped_embedding",
                    extra={
                        "text_preview": (getattr(cand, "text", "") or "")[:60],
                        "similarity": round(sim, 3),
                        "lock_entity": lock.entity,
                    },
                )
            else:
                borderline.append((i, cand))

        # Also check for exclude_signal keywords in text — deterministic fast eviction
        if lock.exclude_signals:
            exclude_pattern = re.compile(
                r"\b(" + "|".join(re.escape(s) for s in lock.exclude_signals) + r")\b",
                re.IGNORECASE,
            )
            new_kept = []
            for cand in kept:
                text = (getattr(cand, "text", "") or "")[:500]
                if exclude_pattern.search(text):
                    dropped_embedding += 1
                    logger.debug(
                        "cohesion_filter_dropped_exclude_signal",
                        extra={
                            "text_preview": text[:60],
                            "lock_entity": lock.entity,
                        },
                    )
                else:
                    new_kept.append(cand)
            kept = new_kept

        # Tier 2: LLM micro-critic for borderline docs (parallel)
        dropped_llm = 0
        if borderline and settings.cohesion_lock_llm_fallback:
            tasks = [
                _micro_critic_llm_single(
                    (getattr(cand, "text", "") or "")[:300],
                    lock,
                )
                for _, cand in borderline
            ]
            verdicts = await asyncio.gather(*tasks, return_exceptions=True)
            for (_, cand), verdict in zip(borderline, verdicts):
                if isinstance(verdict, Exception) or verdict.get("keep", True):
                    kept.append(cand)
                else:
                    dropped_llm += 1
                    logger.debug(
                        "cohesion_filter_dropped_llm",
                        extra={
                            "text_preview": (getattr(cand, "text", "") or "")[:60],
                            "reason": verdict.get("reason", ""),
                            "lock_entity": lock.entity,
                        },
                    )
        else:
            kept.extend(cand for _, cand in borderline)

        logger.info(
            "cohesion_filter_summary",
            extra={
                "protected": len(protected),
                "candidates": len(candidates),
                "kept": len(kept),
                "dropped_embedding": dropped_embedding,
                "dropped_llm": dropped_llm,
                "borderline_count": len(borderline),
                "lock_entity": lock.entity,
            },
        )
        return protected + kept

    except Exception:
        logger.warning("cohesion_filter_failed", exc_info=True)
        return results


# ---------------------------------------------------------------------------
# Phase 5d: Contextual Compression
# ---------------------------------------------------------------------------

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n+")


async def compress_to_cohesion(
    results: list[Any],
    lock: CohesionLock,
) -> list[Any]:
    """Compress each document to sentences relevant to the cohesion lock.

    Uses batch embedding via TEI to compute sentence-level similarity to
    the lock entity.  Documents where > 70% of content would be removed
    keep their original text (they passed the micro-critic, so they're
    topically aligned — we just couldn't find matching sentences).
    """
    if not settings.cohesion_compression_enabled or not lock.entity:
        return results
    if not results:
        return results

    try:
        from .embed_client import get_async_embed_client

        client = get_async_embed_client()

        # Build sentence inventory across all docs
        doc_sentences: list[list[str]] = []
        all_sentences: list[str] = []
        for r in results:
            text = (getattr(r, "text", "") or "").strip()
            sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s.strip() and len(s.strip()) > 10]
            if not sentences:
                sentences = [text] if text else []
            doc_sentences.append(sentences)
            all_sentences.extend(sentences)

        if not all_sentences:
            return results

        # Batch embed: lock entity + all sentences in one call
        all_texts = [lock.entity, *all_sentences]
        embeddings = await client.embed(all_texts, normalize=True)
        lock_emb = embeddings[0]
        sentence_embs = embeddings[1:]

        threshold = settings.cohesion_compression_threshold
        compressed_results = []
        idx = 0
        total_removed = 0
        total_kept = 0

        for r, sentences in zip(results, doc_sentences):
            if not sentences:
                compressed_results.append(r)
                continue

            n_sentences = len(sentences)
            kept_sentences: list[str] = []
            for sent in sentences:
                sent_emb = sentence_embs[idx]
                sim = float(np.dot(lock_emb, sent_emb))
                if sim >= threshold:
                    kept_sentences.append(sent)
                    total_kept += 1
                else:
                    total_removed += 1
                idx += 1

            # Fallback: if compression removes > 70%, keep original
            if len(kept_sentences) < n_sentences * 0.3:
                compressed_results.append(r)
                continue

            compressed_text = " ".join(kept_sentences)
            # Create a copy with compressed text
            if hasattr(r, "__class__") and hasattr(r, "text"):
                from copy import copy

                r_copy = copy(r)
                r_copy.text = compressed_text
                compressed_results.append(r_copy)
            else:
                compressed_results.append(r)

        logger.info(
            "cohesion_compression_summary",
            extra={
                "docs": len(results),
                "total_sentences": total_kept + total_removed,
                "kept_sentences": total_kept,
                "removed_sentences": total_removed,
                "lock_entity": lock.entity,
            },
        )
        return compressed_results

    except Exception:
        logger.warning("cohesion_compression_failed", exc_info=True)
        return results
