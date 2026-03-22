"""Rank-first evidence budgeting for the writer.

Selects evidence packet text in **descending score (confidence)** order and
packs into token and character budgets so high-signal content is never
dropped in favour of lower-ranked packets. Emits structured logs, Prometheus
metrics, and a compact report for traces / admin UI.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from .config import settings
from .token_utils import estimate_tokens

logger = logging.getLogger("synesis.context_curation")

_metrics_initialized = False
_excluded_counter: Any = None
_budget_alert_counter: Any = None
_util_histogram: Any = None
_low_util_counter: Any = None


def _ensure_metrics() -> None:
    global _metrics_initialized, _excluded_counter, _budget_alert_counter, _util_histogram, _low_util_counter
    if _metrics_initialized:
        return
    try:
        from prometheus_client import Counter, Histogram

        _excluded_counter = Counter(
            "synesis_context_curation_excluded_total",
            "Evidence packets or truncations excluded by reason",
            ["reason"],
        )
        _budget_alert_counter = Counter(
            "synesis_context_curation_budget_alert_total",
            "High-score evidence affected by budget (starvation signal)",
        )
        _util_histogram = Histogram(
            "synesis_context_curation_token_utilization_ratio",
            "Fraction of evidence token budget used after curation",
            buckets=(0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0),
        )
        _low_util_counter = Counter(
            "synesis_context_curation_low_utilization_total",
            "Evidence budget mostly empty despite multiple packets (possible over-fetch)",
        )
    except Exception:
        _excluded_counter = None
    _metrics_initialized = True


@dataclass
class _PacketCandidate:
    text: str
    score: float
    section_id: int | None
    doc_hint: str = ""


def _extract_top_snippets(
    snippets: list[Any],
    *,
    max_snippets: int,
    min_relevance: float,
) -> list[str]:
    scored: list[tuple[float, str]] = []
    for s in snippets or []:
        text = s.get("text", "") if isinstance(s, dict) else getattr(s, "text", "")
        rel = s.get("relevance", 0) if isinstance(s, dict) else getattr(s, "relevance", 0)
        text = (text or "").strip()
        if text and float(rel or 0) >= min_relevance:
            scored.append((float(rel), text))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in scored[:max_snippets]]


def _packet_to_text(
    p: dict[str, Any] | Any,
    *,
    max_snippets: int,
    min_relevance: float,
) -> str:
    summary = p.get("summary", "") if isinstance(p, dict) else getattr(p, "summary", "")
    if not summary:
        return ""
    snippets = p.get("snippets", []) if isinstance(p, dict) else getattr(p, "snippets", [])
    top = _extract_top_snippets(snippets, max_snippets=max_snippets, min_relevance=min_relevance)
    if top:
        snippet_block = "\n".join(f"  > {s}" for s in top)
        return f"{summary}\n\nKey excerpts:\n{snippet_block}"
    return summary


def _long_context_reorder(items: list[str]) -> list[str]:
    """Lost-in-the-middle mitigation (same logic as writer)."""
    if len(items) <= 2:
        return items
    reordered: list[str] = []
    for i, item in enumerate(items):
        if i % 2 == 0:
            reordered.append(item)
        else:
            reordered.insert(len(reordered) // 2, item)
    return reordered


def _doc_hint(p: dict[str, Any] | Any) -> str:
    sources = p.get("sources", []) if isinstance(p, dict) else getattr(p, "sources", [])
    for s in sources or []:
        meta = s.get("metadata", {}) if isinstance(s, dict) else getattr(s, "metadata", {})
        if isinstance(meta, dict):
            name = meta.get("document_name") or meta.get("document", "")
            if name:
                return str(name)[:120]
        uri = s.get("uri", "") if isinstance(s, dict) else getattr(s, "uri", "")
        if uri:
            return str(uri)[:120]
    return ""


def curate_evidence_for_writer(
    packets: list[dict[str, Any] | Any],
    *,
    difficulty: float,
    writer_model_name: str,
    long_context_reorder: bool,
) -> tuple[str, dict[str, Any]]:
    """Return (compiled_evidence, report) using rank-first greedy packing.

    *Packets* should already be sorted by descending confidence if callers
    want router order preserved for ties; this function re-sorts by score.

    Budgets:
    - Token cap: ``curator_rag_max_tokens``
    - Char cap: ``scaled_evidence_budget(difficulty)``
    - Minimum score: ``curator_min_rerank_score`` (applied to packet confidence)
    """
    _ensure_metrics()

    max_snips = 5 if difficulty >= 0.7 else 3
    min_rel = 0.45 if difficulty >= 0.7 else 0.6

    candidates: list[_PacketCandidate] = []
    for p in packets:
        conf = float(p.get("confidence", 0) if isinstance(p, dict) else getattr(p, "confidence", 0))
        text = _packet_to_text(p, max_snippets=max_snips, min_relevance=min_rel)
        if not text:
            continue
        sid = p.get("section_id") if isinstance(p, dict) else getattr(p, "section_id", None)
        sid = int(sid) if isinstance(sid, int) else None
        candidates.append(
            _PacketCandidate(
                text=text,
                score=conf,
                section_id=sid,
                doc_hint=_doc_hint(p),
            )
        )

    candidates.sort(key=lambda c: c.score, reverse=True)

    token_budget = max(256, int(getattr(settings, "curator_rag_max_tokens", 3000)))
    char_budget = max(1024, int(settings.scaled_evidence_budget(difficulty)))

    # Legacy safety: do not exceed rough model window minus headroom for output
    max_evidence_chars = (settings.compiler_model_context * 4) - (settings.writer_budget_max * 4) - 8000
    if max_evidence_chars > 0:
        char_budget = min(char_budget, max_evidence_chars)

    excluded: list[dict[str, Any]] = []
    for c in candidates:
        if c.score < float(settings.curator_min_rerank_score):
            excluded.append(
                {
                    "reason": "below_threshold",
                    "score": round(c.score, 4),
                    "doc_hint": c.doc_hint,
                    "text_snippet": c.text[:160],
                }
            )
            if _excluded_counter:
                _excluded_counter.labels(reason="below_threshold").inc()

    eligible = [c for c in candidates if c.score >= float(settings.curator_min_rerank_score)]
    kept: list[_PacketCandidate] = []
    tokens_used = 0
    chars_used = 0
    budget_alert = ""
    truncated_count = 0

    thr = float(settings.curator_budget_alert_threshold)

    for c in eligible:
        tks = estimate_tokens(c.text, writer_model_name)
        ch_len = len(c.text)
        if tks <= token_budget - tokens_used and ch_len <= char_budget - chars_used:
            kept.append(c)
            tokens_used += tks
            chars_used += ch_len
            continue

        # Try prefix fit (preserve highest-signal start)
        remaining_t = max(0, token_budget - tokens_used)
        remaining_c = max(0, char_budget - chars_used)
        if remaining_t < 32 or remaining_c < 200:
            excluded.append(
                {
                    "reason": "budget_exceeded",
                    "score": round(c.score, 4),
                    "doc_hint": c.doc_hint,
                    "text_snippet": c.text[:160],
                }
            )
            if _excluded_counter:
                _excluded_counter.labels(reason="budget_exceeded").inc()
            if c.score >= thr:
                budget_alert = (
                    f"High-score evidence (confidence={c.score:.2f}) could not fit ({c.doc_hint or 'unknown doc'})"
                )
                if _budget_alert_counter:
                    _budget_alert_counter.inc()
            continue

        low, high = 0, min(len(c.text), remaining_c)
        best = 0
        while low <= high:
            mid = (low + high) // 2
            chunk = c.text[:mid]
            if estimate_tokens(chunk, writer_model_name) <= remaining_t:
                best = mid
                low = mid + 1
            else:
                high = mid - 1

        if best < 200:
            excluded.append(
                {
                    "reason": "budget_exceeded",
                    "score": round(c.score, 4),
                    "doc_hint": c.doc_hint,
                    "text_snippet": c.text[:160],
                }
            )
            if _excluded_counter:
                _excluded_counter.labels(reason="budget_exceeded").inc()
            if c.score >= thr:
                budget_alert = (
                    f"High-score evidence (confidence={c.score:.2f}) truncated to near-empty "
                    f"({c.doc_hint or 'unknown doc'})"
                )
                if _budget_alert_counter:
                    _budget_alert_counter.inc()
            continue

        partial = c.text[:best].rstrip() + "\n\n[… evidence truncated for context budget …]"
        kept.append(
            _PacketCandidate(
                text=partial,
                score=c.score,
                section_id=c.section_id,
                doc_hint=c.doc_hint,
            )
        )
        tokens_used += estimate_tokens(partial, writer_model_name)
        chars_used += len(partial)
        truncated_count += 1
        if _excluded_counter:
            _excluded_counter.labels(reason="truncated").inc()
        if c.score >= thr:
            budget_alert = (
                f"High-score evidence (confidence={c.score:.2f}) was truncated ({c.doc_hint or 'unknown doc'})"
            )
            if _budget_alert_counter:
                _budget_alert_counter.inc()

    # Assemble: group by section_id for readability; preserve confidence order within group
    by_section: dict[int | None, list[_PacketCandidate]] = {}
    for c in kept:
        by_section.setdefault(c.section_id, []).append(c)

    def _section_key(sid: int | None) -> tuple[int, int]:
        if sid is None:
            return (1, 10**9)
        return (0, sid)

    compiled_sections: list[str] = []
    for sid in sorted(by_section.keys(), key=_section_key):
        parts = sorted(by_section[sid], key=lambda x: x.score, reverse=True)
        texts = [p.text for p in parts]
        if long_context_reorder and len(texts) > 2:
            texts = _long_context_reorder(texts)
        compiled_sections.append("\n---\n".join(texts))

    compiled = "\n---\n".join(compiled_sections)

    utilization = (tokens_used / token_budget) if token_budget else 0.0
    low_utilization = bool(len(candidates) >= 3 and utilization < 0.25)
    if low_utilization and _low_util_counter:
        _low_util_counter.inc()

    if _util_histogram:
        _util_histogram.observe(min(1.0, utilization))

    report: dict[str, Any] = {
        "packets_in": len(packets),
        "candidates_built": len(candidates),
        "packets_kept": len(kept),
        "packets_truncated": truncated_count,
        "excluded_count": len(excluded),
        "token_budget": token_budget,
        "tokens_used": tokens_used,
        "char_budget": char_budget,
        "chars_used": len(compiled),
        "utilization": round(utilization, 4),
        "low_utilization": low_utilization,
        "budget_alert": budget_alert,
        "excluded": excluded[:24],
    }

    logger.info(
        "context_curation",
        extra={
            "packets_in": report["packets_in"],
            "packets_kept": report["packets_kept"],
            "excluded_count": report["excluded_count"],
            "token_budget": token_budget,
            "tokens_used": tokens_used,
            "utilization": report["utilization"],
            "low_utilization": low_utilization,
            "budget_alert": bool(budget_alert),
            "truncated": truncated_count,
        },
    )

    return compiled, report
