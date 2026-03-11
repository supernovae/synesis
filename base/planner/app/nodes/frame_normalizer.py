"""Stage 2 — Deterministic normalizer for the GLiNER2 frame extraction pipeline.

Pure Python, no ML, no LLM. Takes a FirstPassFrame (raw GLiNER2 output) and
produces a normalized UserTask + MissingFieldReport for gating Stage 3.
"""

from __future__ import annotations

import logging
import re

from ..schemas import (
    FirstPassFrame,
    MissingFieldReport,
    RawExtractionCandidate,
    UserTask,
)

logger = logging.getLogger("synesis.frame_normalizer")

# --------------------------------------------------------------------------- #
# Quality/style signal detection — items classified as constraints by GLiNER2
# that are actually style instructions (should become success_criteria)
# --------------------------------------------------------------------------- #

_QUALITY_SIGNAL_RE = re.compile(
    r"^(be |don't |do not |keep |avoid |make .* explicit|acknowledge|"
    r"separate .* from|if .*(unsure|uncertain|not sure)|prefer )",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------- #
# Decision signal patterns
# --------------------------------------------------------------------------- #

_DECISION_RE = re.compile(
    r"\b(choose|rank|compare|recommend|which is better|versus|vs\.|trade-?off|select between)\b",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------- #
# Negative constraint patterns (catches items misclassified as constraints)
# --------------------------------------------------------------------------- #

_NEGATIVE_RE = re.compile(
    r"^(do not|don't|never|avoid|no |must not|should not|cannot)\b",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------- #
# Format detection patterns
# --------------------------------------------------------------------------- #

_FORMAT_PATTERNS = {
    "table": re.compile(r"\b(table|matrix|grid|spreadsheet)\b", re.IGNORECASE),
    "code": re.compile(r"\b(code|snippet|script|implementation|function|class)\b", re.IGNORECASE),
    "diagram": re.compile(r"\b(diagram|chart|graph|flowchart|mermaid|uml)\b", re.IGNORECASE),
    "bullet_list": re.compile(r"\b(bullet|list|numbered|enumerat)\b", re.IGNORECASE),
    "email": re.compile(r"\b(email|letter|memo)\b", re.IGNORECASE),
}


def _text_similarity(a: str, b: str) -> float:
    """Jaccard word-overlap similarity between two strings."""
    wa = set(a.lower().split())
    wb = set(b.lower().split())
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def _dedup_candidates(candidates: list[RawExtractionCandidate], threshold: float = 0.6) -> list[RawExtractionCandidate]:
    """Merge near-duplicate candidates, keeping the one with highest confidence."""
    if len(candidates) <= 1:
        return candidates

    kept: list[RawExtractionCandidate] = []
    for cand in sorted(candidates, key=lambda c: c.confidence, reverse=True):
        is_dup = False
        for existing in kept:
            if _text_similarity(cand.text, existing.text) > threshold:
                is_dup = True
                break
        if not is_dup:
            kept.append(cand)
    return kept


def _extract_texts(candidates: list[RawExtractionCandidate]) -> list[str]:
    """Pull .text from a list of candidates."""
    return [c.text for c in candidates]


def normalize_frame(frame: FirstPassFrame, raw_text: str) -> tuple[UserTask, MissingFieldReport]:
    """Stage 2: deterministic normalization of GLiNER2 raw extraction.

    Returns (UserTask, MissingFieldReport).
    """
    # Dedup within each field
    requirements = _dedup_candidates(frame.requirements)
    constraints = _dedup_candidates(frame.constraints)
    neg_constraints = _dedup_candidates(frame.negative_constraints)
    deliverables = _dedup_candidates(frame.deliverables)
    formats = _dedup_candidates(frame.formats)
    technologies = _dedup_candidates(frame.technologies)
    domain_tags = _dedup_candidates(frame.domain_tags)
    _dedup_candidates(frame.timeline_signals)  # consumed by callers via frame
    quality_instructions = _dedup_candidates(frame.quality_instructions)
    decision_signals = _dedup_candidates(frame.decision_signals)
    escalation_signals = _dedup_candidates(frame.escalation_signals)
    main_q_candidates = _dedup_candidates(frame.main_question_candidates)

    # Reclassify: constraints that are actually quality/style instructions
    real_constraints: list[RawExtractionCandidate] = []
    promoted_quality: list[RawExtractionCandidate] = []
    for c in constraints:
        if _QUALITY_SIGNAL_RE.match(c.text.strip()):
            promoted_quality.append(c)
        elif _NEGATIVE_RE.match(c.text.strip()):
            neg_constraints.append(c)
        else:
            real_constraints.append(c)
    quality_instructions = quality_instructions + promoted_quality

    # Detect decision_required from decision_signals + raw text
    decision_required = bool(decision_signals) or bool(_DECISION_RE.search(raw_text))

    # Determine requested_format
    requested_format = "prose"
    if formats:
        requested_format = formats[0].text.lower()
    else:
        for fmt, pattern in _FORMAT_PATTERNS.items():
            if pattern.search(raw_text):
                requested_format = fmt
                break

    # Pick main_question
    main_question = ""
    if main_q_candidates:
        main_question = main_q_candidates[0].text
    elif requirements:
        main_question = requirements[0].text

    # Build success_criteria from quality_instructions
    success_criteria = _extract_texts(quality_instructions)

    # Build ambiguities: timeline signals without concrete dates
    ambiguities: list[str] = []

    # Build assumptions_needed
    assumptions_needed: list[str] = []

    # Detect missing critical fields
    missing_critical: list[str] = []
    if not main_question and not requirements:
        missing_critical.append("main_question")
    if not deliverables and len(raw_text) > 200:
        missing_critical.append("deliverables")

    # Detect conflicting fields (same span in both constraints and requirements)
    conflicting: list[tuple[str, str]] = []
    req_texts = {c.text.lower().strip() for c in requirements}
    for c in real_constraints:
        if c.text.lower().strip() in req_texts:
            conflicting.append(("constraints", "requirements"))
            break

    # Low-confidence fields
    low_confidence: list[str] = []
    for field_name, avg_conf in frame.field_confidence_map.items():
        if avg_conf < 0.3:
            low_confidence.append(field_name)

    # Build the report
    should_call = needs_second_pass(
        frame,
        MissingFieldReport(
            missing_critical_fields=missing_critical,
            conflicting_fields=conflicting,
            low_confidence_fields=low_confidence,
        ),
    )

    reasons: list[str] = []
    if missing_critical:
        reasons.append(f"missing critical fields: {missing_critical}")
    if conflicting:
        reasons.append(f"conflicting fields: {conflicting}")
    if low_confidence:
        reasons.append(f"low confidence: {low_confidence}")
    if len(main_q_candidates) > 2:
        reasons.append(f"ambiguous main question ({len(main_q_candidates)} candidates)")

    report = MissingFieldReport(
        missing_critical_fields=missing_critical,
        conflicting_fields=conflicting,
        low_confidence_fields=low_confidence,
        should_call_second_pass=should_call,
        reasons=reasons,
    )

    user_task = UserTask(
        main_question=main_question,
        explicit_requirements=_extract_texts(requirements),
        constraints=_extract_texts(real_constraints),
        negative_constraints=_extract_texts(_dedup_candidates(neg_constraints)),
        requested_format=requested_format,
        deliverables=_extract_texts(deliverables),
        success_criteria=success_criteria,
        ambiguities=ambiguities,
        assumptions_needed=assumptions_needed,
        domain_tags=_extract_texts(domain_tags),
        technologies=_extract_texts(technologies),
        escalation_signals=_extract_texts(escalation_signals),
        decision_required=decision_required,
        needs_web=False,
    )

    logger.info(
        "normalize_frame reqs=%d constraints=%d deliverables=%d second_pass=%s",
        len(user_task.explicit_requirements),
        len(user_task.constraints),
        len(user_task.deliverables),
        report.should_call_second_pass,
    )

    return user_task, report


def needs_second_pass(frame: FirstPassFrame, report: MissingFieldReport) -> bool:
    """Determine if LLM repair (Stage 3) is needed."""
    if report.missing_critical_fields:
        return True
    if report.conflicting_fields:
        return True
    if len(frame.main_question_candidates) > 2:
        return True
    return any(v < 0.3 for v in frame.field_confidence_map.values())
