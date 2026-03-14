"""Lightweight oscillation detector for the anti-oscillation framework.

Scores style, decision, retrieval, section churn, and content drift
oscillation patterns using only state data — no LLM calls.  Called from
``route_after_critic`` to decide whether to continue retrying or
force-terminate.

Content drift scoring (added to address multi-draft concatenation
regression) detects when the heading structure changes significantly
across writer iterations, which signals that the writer is generating
entirely new proposals instead of targeted revisions.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("synesis.oscillation_detector")

STYLE_WEIGHT = 0.20
DECISION_WEIGHT = 0.25
RETRIEVAL_WEIGHT = 0.10
CHURN_WEIGHT = 0.20
OVERRIDE_WEIGHT = 0.05
CONTENT_DRIFT_WEIGHT = 0.20


@dataclass
class OscillationReport:
    style_score: float = 0.0
    decision_score: float = 0.0
    retrieval_score: float = 0.0
    section_churn: float = 0.0
    content_drift: float = 0.0
    unsupported_overrides: int = 0
    total_score: float = 0.0
    details: list[str] = field(default_factory=list)


def detect_oscillation(state: dict[str, Any]) -> OscillationReport:
    """Score oscillation across all dimensions. Returns report with 0-1 scores."""
    report = OscillationReport()

    report.style_score = _score_style_oscillation(state)
    report.decision_score = _score_decision_oscillation(state)
    report.retrieval_score = _score_retrieval_oscillation(state)
    report.section_churn = _score_section_churn(state)
    report.content_drift = _score_content_drift(state)
    report.unsupported_overrides = _count_unsupported_overrides(state)

    override_score = min(1.0, report.unsupported_overrides * 0.3)

    report.total_score = (
        STYLE_WEIGHT * report.style_score
        + DECISION_WEIGHT * report.decision_score
        + RETRIEVAL_WEIGHT * report.retrieval_score
        + CHURN_WEIGHT * report.section_churn
        + CONTENT_DRIFT_WEIGHT * report.content_drift
        + OVERRIDE_WEIGHT * override_score
    )

    if report.total_score > 0.3:
        logger.info(
            "oscillation_detected",
            extra={
                "total": round(report.total_score, 2),
                "style": round(report.style_score, 2),
                "decision": round(report.decision_score, 2),
                "retrieval": round(report.retrieval_score, 2),
                "churn": round(report.section_churn, 2),
                "content_drift": round(report.content_drift, 2),
                "unsupported_overrides": report.unsupported_overrides,
            },
        )

    return report


# ---------------------------------------------------------------------------
# Dimension scorers
# ---------------------------------------------------------------------------


def _score_style_oscillation(state: dict[str, Any]) -> float:
    """Compare style_contract_locked against draft content signals."""
    contract = state.get("style_contract_locked") or {}
    draft = state.get("generated_code", "")
    if not contract or not draft:
        return 0.0

    score = 0.0
    details: list[str] = []

    if contract.get("direct_answer_first", True):
        first_para = draft.strip().split("\n\n")[0] if draft.strip() else ""
        preamble_markers = ("before we begin", "let me start by", "in this response", "let's first")
        if any(m in first_para.lower() for m in preamble_markers):
            score += 0.5
            details.append("preamble detected despite direct_answer_first")

    return min(1.0, score)


def _score_decision_oscillation(state: dict[str, Any]) -> float:
    """Detect flip-flopping in override_log — same decision overridden multiple times."""
    override_log = state.get("override_log") or []
    if len(override_log) < 2:
        return 0.0

    decision_counts: Counter[str] = Counter()
    for entry in override_log:
        did = entry.get("target_decision_id", "")
        if did:
            decision_counts[did] += 1

    if not decision_counts:
        return 0.0

    max_flips = max(decision_counts.values())
    if max_flips >= 3:
        return 1.0
    if max_flips >= 2:
        return 0.6
    return 0.0


def _score_retrieval_oscillation(state: dict[str, Any]) -> float:
    """Score retrieval churn: repeated critic→router evidence requests for the same section.

    When the critic sends evidence back to the Router 2+ times for the same
    section_id, this is retrieval churn — the same evidence keeps failing review.
    At threshold, the Router should invalidate cached evidence and diversify.
    """
    critique_register = state.get("critique_register") or {}
    evidence_requests = state.get("evidence_requests") or []
    need_more = state.get("need_more_evidence", False)

    if not need_more and not evidence_requests:
        return 0.0

    section_complaint_counts: Counter[int | None] = Counter()
    for item_id, item in critique_register.items():
        if not isinstance(item, dict):
            continue
        if item.get("status") == "open" and "evidence" in str(item).lower():
            section_id = item.get("section_id")
            section_complaint_counts[section_id] += 1

    node_traces = state.get("node_traces") or []
    router_passes = sum(1 for t in node_traces if _trace_node(t) == "router")

    if router_passes >= 3:
        score = min(1.0, router_passes * 0.25)
    elif any(count >= 2 for count in section_complaint_counts.values()):
        score = 0.6
        _invalidate_churned_sections(state, section_complaint_counts)
    elif router_passes >= 2:
        score = 0.3
    else:
        score = 0.0

    if score > 0:
        logger.debug(
            "retrieval_churn_detected",
            extra={
                "router_passes": router_passes,
                "section_complaints": dict(section_complaint_counts),
                "score": round(score, 2),
            },
        )

    return score


def _invalidate_churned_sections(
    state: dict[str, Any],
    section_counts: Counter[int | None],
) -> None:
    """Invalidate cached evidence for sections with 2+ complaints.

    Called when the oscillation detector identifies retrieval churn for
    specific sections. This prevents the Router from returning the same
    bad evidence from cache on the next pass.
    """
    try:
        from .retrieval_cache import get_retrieval_cache

        cache = get_retrieval_cache()
        for section_id, count in section_counts.items():
            if count >= 2 and section_id is not None:
                removed = cache.invalidate_by_section(section_id)
                if removed:
                    logger.info(
                        "retrieval_churn_cache_invalidated",
                        extra={"section_id": section_id, "entries_removed": removed},
                    )
    except Exception:
        logger.debug("retrieval_churn_invalidation_failed", exc_info=True)


def _trace_node(trace: Any) -> str:
    """Extract node_name from a trace (dict or NodeTrace)."""
    if isinstance(trace, dict):
        return trace.get("node_name", "")
    return getattr(trace, "node_name", "")


def _score_section_churn(state: dict[str, Any]) -> float:
    """High churn = many fingerprint changes without corresponding critique items."""
    fingerprints = state.get("draft_fingerprints") or []
    if len(fingerprints) < 2:
        return 0.0

    changes = sum(1 for i in range(1, len(fingerprints)) if fingerprints[i] != fingerprints[i - 1])
    if changes == 0:
        return 0.0

    register = state.get("critique_register") or {}
    open_items = sum(1 for v in register.values() if isinstance(v, dict) and v.get("status") == "open")
    resolved_items = sum(
        1 for v in register.values() if isinstance(v, dict) and v.get("status") in ("resolved", "settled")
    )
    critique_driven = open_items + resolved_items

    if changes > 0 and critique_driven == 0:
        return min(1.0, changes * 0.4)

    if changes > critique_driven * 2:
        return min(1.0, (changes - critique_driven) * 0.2)

    return 0.0


def _count_unsupported_overrides(state: dict[str, Any]) -> int:
    """Count override_log entries without approval or reason."""
    override_log = state.get("override_log") or []
    count = 0
    for entry in override_log:
        if not entry.get("approved") or not (entry.get("override_reason") or "").strip():
            count += 1
    return count


# ---------------------------------------------------------------------------
# Content drift: heading structure + key term stability across iterations
# ---------------------------------------------------------------------------

_HEADING_RE = re.compile(r"^(#{1,3})\s+(.+)", re.MULTILINE)
_KEY_TERM_RE = re.compile(
    r"\b(?:FAISS|Elasticsearch|Pinecone|Milvus|Redis|PostgreSQL|"
    r"MySQL|MongoDB|BERT|GPT-\d|Llama|Phi-\d|StarCoder|TinyML|"
    r"Kubernetes|Docker|Terraform|FastAPI|Flask|LangChain|"
    r"vLLM|OpenAI|Anthropic|Mistral)\b",
    re.IGNORECASE,
)


def _extract_heading_sig(text: str) -> list[str]:
    """Extract normalized heading signature from markdown."""
    return [m.group(2).strip().lower() for m in _HEADING_RE.finditer(text)]


def _extract_key_terms(text: str) -> set[str]:
    """Extract technology/model key terms from text."""
    return {m.group(0).lower() for m in _KEY_TERM_RE.finditer(text)}


def _score_content_drift(state: dict[str, Any]) -> float:
    """Detect when writer produces structurally different documents across iterations.

    Compares the current draft's heading structure and key technology terms
    against the previous iteration's draft (stored in ``_previous_draft``
    state or inferred from ``draft_fingerprints`` count).  High drift with
    low critique coverage signals uncontrolled rewriting.
    """
    iteration = state.get("iteration_count", 0)
    if iteration < 1:
        return 0.0

    current_draft = (state.get("generated_code") or "").strip()
    if not current_draft:
        return 0.0

    fingerprints = state.get("draft_fingerprints") or []
    if len(fingerprints) < 2:
        return 0.0

    all_unique = len(set(fingerprints)) == len(fingerprints)
    if not all_unique:
        return 0.0

    # Check for duplicate title headings — the exact symptom of
    # the multi-draft concatenation bug
    headings = _extract_heading_sig(current_draft)
    if headings:
        h1_headings = [
            m.group(2).strip().lower()
            for m in _HEADING_RE.finditer(current_draft)
            if m.group(1) == "#"
        ]
        if len(h1_headings) > 1:
            unique_h1 = set(h1_headings)
            if len(unique_h1) < len(h1_headings):
                logger.warning(
                    "content_drift_duplicate_titles",
                    extra={
                        "h1_count": len(h1_headings),
                        "unique_h1": len(unique_h1),
                        "titles": h1_headings[:5],
                    },
                )
                return 1.0

    score = 0.0
    critique_register = state.get("critique_register") or {}
    open_critiques = sum(
        1 for v in critique_register.values()
        if isinstance(v, dict) and v.get("status") == "open"
    )

    # Every fingerprint change without corresponding open critiques
    # suggests the writer is rewriting without direction
    if len(fingerprints) >= 3 and all_unique and open_critiques <= 1:
        score += 0.6
        logger.debug(
            "content_drift_unguided_rewrites",
            extra={
                "fingerprint_count": len(fingerprints),
                "open_critiques": open_critiques,
            },
        )

    # Repair instruction consistency: if the critic repeatedly targets
    # the same section with different repair actions, it's oscillating
    repair_instructions = state.get("repair_instructions") or []
    if repair_instructions and iteration >= 2:
        targets = [r.get("target", "") for r in repair_instructions if isinstance(r, dict)]
        target_counts = Counter(targets)
        repeated_targets = sum(1 for c in target_counts.values() if c >= 2)
        if repeated_targets >= 2:
            score += 0.3
            logger.debug(
                "content_drift_repair_oscillation",
                extra={"repeated_targets": repeated_targets, "targets": dict(target_counts)},
            )

    return min(1.0, score)
