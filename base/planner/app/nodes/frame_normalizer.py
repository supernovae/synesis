"""Stage 2 — Deterministic normalizer for the GLiNER2 frame extraction pipeline.

Pure Python, no ML, no LLM. Takes a FirstPassFrame (raw GLiNER2 output) and
produces a normalized UserTask + MissingFieldReport for gating Stage 3.

Includes the intent anchor resolver that scans extracted technologies
against conflict groups to resolve ambiguity pre-retrieval.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ..config import settings
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

# --------------------------------------------------------------------------- #
# Persona detection — extract delivery style cues from the user message
# --------------------------------------------------------------------------- #

_PERSONA_PATTERNS: list[tuple[re.Pattern[str], str, bool]] = [
    # (pattern, template, skip_stopword_check)
    (re.compile(r"\blike\s+a\s+(\w+)\b", re.IGNORECASE), "{0}", False),
    (re.compile(r"\bas\s+(?:a|an)\s+(\w+)\b", re.IGNORECASE), "{0}", False),
    (re.compile(r"\bin\s+(?:the\s+)?(?:style|voice|tone)\s+of\s+(?:a\s+)?(\w+)", re.IGNORECASE), "{0}", False),
    (re.compile(r"\bexplain\s+(?:it\s+)?to\s+(?:a\s+)?(\d+)[\s-]*year[\s-]*old\b", re.IGNORECASE), "ELI{0}", True),
    (
        re.compile(r"\bexplain\s+(?:it\s+)?(?:like|as if)\s+(?:I'?m|i am)\s+(?:a\s+)?(\w+)\b", re.IGNORECASE),
        "{0}",
        False,
    ),
]

_PERSONA_STOPWORDS = frozenset(
    {
        "the",
        "a",
        "an",
        "it",
        "this",
        "that",
        "my",
        "your",
        "me",
        "way",
        "much",
        "more",
        "well",
        "also",
        "very",
        "how",
        "what",
        "why",
        "can",
        "do",
        "should",
        "would",
        "could",
        "will",
        "following",
        "possible",
    }
)


_PERSONA_MAX_LEN = 40
_PERSONA_BLOCKLIST_PATTERNS = [
    re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)", re.IGNORECASE),
    re.compile(r"system\s*:", re.IGNORECASE),
    re.compile(r"you\s+are\s+now", re.IGNORECASE),
    re.compile(r"new\s+instructions?\s*:", re.IGNORECASE),
    re.compile(r"override\s+(?:your\s+)?(?:instructions?|prompt)", re.IGNORECASE),
]


def _detect_persona(raw_text: str) -> str:
    """Extract persona cue from the raw user message.

    Returns the persona label (e.g. "pirate", "professor", "ELI5") or ""
    if no persona cue is detected. Capped at _PERSONA_MAX_LEN chars and
    rejected if it matches known injection patterns.
    """
    for pattern, template, skip_check in _PERSONA_PATTERNS:
        match = pattern.search(raw_text)
        if match:
            captured = match.group(1).strip().lower()
            if skip_check or (captured not in _PERSONA_STOPWORDS and len(captured) > 1):
                persona = template.format(captured)[:_PERSONA_MAX_LEN]
                for bp in _PERSONA_BLOCKLIST_PATTERNS:
                    if bp.search(persona):
                        return ""
                return persona
    return ""


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


def normalize_frame(
    frame: FirstPassFrame, raw_text: str,
) -> tuple[UserTask, MissingFieldReport, list[dict[str, Any]]]:
    """Stage 2: deterministic normalization of GLiNER2 raw extraction.

    Returns (UserTask, MissingFieldReport, unresolved_conflicts).
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

    # Pick main_question — prefer extracted candidates, fall back to raw text
    # for short single-sentence prompts where GLiNER missed the question.
    main_question = ""
    if main_q_candidates:
        main_question = main_q_candidates[0].text
    elif requirements:
        main_question = requirements[0].text
    elif raw_text and len(raw_text) < 300 and raw_text.count("\n") <= 1:
        main_question = raw_text.strip()

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

    persona = _detect_persona(raw_text)

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
        persona=persona,
    )

    # Build the topic frame — the conceptual search entity, deliberately
    # excluding technologies (those feed OutputCohesion, not search).
    user_task.topic_frame = _build_topic_frame(user_task)

    # Intent anchor resolution — scan technologies against conflict groups
    anchors, excl, anchor_assumptions, unresolved_conflicts = _resolve_intent_anchors(user_task)
    if anchors:
        user_task.intent_anchors = anchors
        user_task.anchor_exclude_signals = excl
        user_task.anchor_assumptions = anchor_assumptions

    logger.info(
        "normalize_frame reqs=%d constraints=%d deliverables=%d second_pass=%s",
        len(user_task.explicit_requirements),
        len(user_task.constraints),
        len(user_task.deliverables),
        report.should_call_second_pass,
    )

    return user_task, report, unresolved_conflicts


# ---------------------------------------------------------------------------
# Topic Frame Builder
# ---------------------------------------------------------------------------


def _build_topic_frame(user_task: UserTask) -> str:
    """Synthesize a conceptual search frame from question + deliverables + domain tags.

    The topic frame is what RAG queries should target.  It deliberately
    omits technologies — those are *constraints* on the output, not the
    search topic itself.

    Example:
      main_question: "Propose a practical architecture for an internal coding assistant"
      deliverables:  ["concrete architecture", "model choices", "failure modes"]
      domain_tags:   ["software architecture", "AI assistant"]
      => "Propose a practical architecture for an internal coding assistant;
          concrete architecture; model choices; failure modes [software architecture, AI assistant]"
    """
    parts: list[str] = []

    mq = (user_task.main_question or "").strip()
    if mq:
        parts.append(mq)

    for d in (user_task.deliverables or [])[:6]:
        d_str = (d if isinstance(d, str) else str(d)).strip()
        if d_str and d_str.lower() != mq.lower():
            parts.append(d_str)

    frame = "; ".join(parts)

    domain = [t.strip() for t in (user_task.domain_tags or [])[:4] if t.strip()]
    if domain:
        frame += f" [{', '.join(domain)}]"

    return frame[:1000]


# ---------------------------------------------------------------------------
# Intent Anchor Resolution
# ---------------------------------------------------------------------------

_CONFLICT_GROUP_DEFAULTS: dict[str, str] = {
    # When a conflict group is implied but no member is explicit, pick this.
    # Values are the most common industry default per group.
}


def _resolve_intent_anchors(
    user_task: UserTask,
) -> tuple[dict[str, str], list[str], list[str], list[dict[str, Any]]]:
    """Resolve technology ambiguity from extracted technologies against conflict groups.

    Returns:
        (anchors, exclude_signals, assumptions, unresolved_conflicts)
    """
    if not settings.anchor_resolution_enabled:
        return {}, [], [], []

    from ..cohesion import get_conflict_groups, _ENTITY_EXCLUSION_MAP

    conflict_groups = get_conflict_groups()
    tech_lower = {t.lower() for t in user_task.technologies}
    constraint_lower = {c.lower() for c in user_task.constraints}
    all_signals = tech_lower | constraint_lower

    anchors: dict[str, str] = {}
    exclude_signals: list[str] = []
    assumptions: list[str] = []
    unresolved: list[dict[str, Any]] = []

    for group_name, members in conflict_groups.items():
        hits = all_signals & members
        if len(hits) == 0:
            default = _CONFLICT_GROUP_DEFAULTS.get(group_name)
            if default:
                anchors[group_name] = default
                excl = _ENTITY_EXCLUSION_MAP.get(default, [])
                exclude_signals.extend(excl)
                assumptions.append(
                    f"Assuming {default} (no {group_name.replace('_', ' ')} specified)"
                )
            continue

        if len(hits) == 1:
            winner = next(iter(hits))
            anchors[group_name] = winner
            excl = _ENTITY_EXCLUSION_MAP.get(winner, [])
            exclude_signals.extend(excl)
        else:
            # Multiple members from the same group → conflict
            unresolved.append({
                "group": group_name,
                "members": sorted(hits),
                "all_members": sorted(members),
            })

    exclude_signals = list(dict.fromkeys(exclude_signals))

    if anchors or unresolved:
        logger.info(
            "intent_anchors_resolved",
            extra={
                "anchors": anchors,
                "exclude_signals": exclude_signals[:8],
                "assumptions": assumptions[:4],
                "unresolved_count": len(unresolved),
            },
        )

    return anchors, exclude_signals, assumptions, unresolved


async def resolve_intent_anchors_with_llm_fallback(
    user_task: UserTask,
    difficulty: float,
    run_id: str = "",
) -> tuple[dict[str, str], list[str], list[str], list[dict[str, Any]]]:
    """Full anchor resolution: fast map + LLM fallback for unknown domains.

    Called from the entry_pipeline or frame_extractor node (async context).
    The LLM fallback fires only when the fast path found zero conflict groups,
    the task is hard enough, and there are 3+ unrecognized technologies.
    """
    anchors, exclude_signals, assumptions, unresolved = _resolve_intent_anchors(user_task)

    if anchors or unresolved or not settings.anchor_llm_fallback_enabled:
        return anchors, exclude_signals, assumptions, unresolved

    if difficulty < settings.anchor_ask_min_difficulty:
        return anchors, exclude_signals, assumptions, unresolved

    from ..cohesion import get_conflict_groups, _ENTITY_EXCLUSION_MAP

    conflict_groups = get_conflict_groups()
    all_known = set()
    for members in conflict_groups.values():
        all_known |= members

    tech_lower = [t.lower() for t in user_task.technologies]
    unrecognized = [t for t in tech_lower if t not in all_known]

    if len(unrecognized) < 3:
        return anchors, exclude_signals, assumptions, unresolved

    # LLM fallback: ask the router model to detect mutually exclusive choices
    try:
        from langchain_core.messages import HumanMessage, SystemMessage
        from langchain_openai import ChatOpenAI

        from ..llm_telemetry import get_llm_http_client
        from ..schemas import safe_parse_json

        _kw: dict[str, Any] = {}
        if settings.guided_json_enabled:
            _kw["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
        else:
            _kw["response_format"] = {"type": "json_object"}

        llm = ChatOpenAI(
            base_url=settings.router_model_url,
            api_key="not-needed",
            model=settings.router_model_name,
            temperature=0.0,
            max_completion_tokens=256 if not settings.guided_json_enabled else 128,
            streaming=False,
            use_responses_api=False,
            model_kwargs=_kw,
            http_client=get_llm_http_client(uds_path=settings.router_model_uds or None),
        )

        prompt = (
            f"These technologies were extracted from a user prompt: {unrecognized}\n"
            "Are any of these mutually exclusive choices in the same decision category?\n"
            'Output JSON array: [{"group": "<category>", "members": ["a","b"], "default": "<most common>"}]\n'
            "If none are mutually exclusive, output: []"
        )

        resp = await llm.ainvoke([
            SystemMessage(content="You classify technology relationships. Output only JSON."),
            HumanMessage(content=prompt),
        ])

        raw = safe_parse_json(resp.content or "")
        discovered_groups = raw if isinstance(raw, list) else []

        for grp in discovered_groups:
            group_name = grp.get("group", "")
            members = grp.get("members", [])
            default = grp.get("default", "")
            if not group_name or len(members) < 2:
                continue

            members_lower = [m.lower() for m in members]
            hits = set(members_lower) & set(tech_lower)

            if len(hits) == 1:
                winner = next(iter(hits))
                anchors[group_name] = winner
                excl_for_winner = [m for m in members_lower if m != winner]
                exclude_signals.extend(excl_for_winner)
                assumptions.append(
                    f"Assuming {winner} (detected as {group_name.replace('_', ' ')} choice)"
                )
            elif len(hits) >= 2:
                unresolved.append({
                    "group": group_name,
                    "members": sorted(hits),
                    "all_members": sorted(members_lower),
                })

            # Persist discovery to admin DB (best-effort, fire-and-forget)
            _persist_discovered_group(
                group_name=group_name,
                members=members_lower,
                default_pick=default,
                source_query=(user_task.main_question or "")[:200],
                source_run_id=run_id,
            )

        exclude_signals = list(dict.fromkeys(exclude_signals))

        if discovered_groups:
            logger.info(
                "anchor_llm_fallback_discovered",
                extra={
                    "groups": len(discovered_groups),
                    "anchors": anchors,
                    "unresolved": len(unresolved),
                },
            )

    except Exception:
        logger.warning("anchor_llm_fallback_failed", exc_info=True)

    return anchors, exclude_signals, assumptions, unresolved


def _persist_discovered_group(
    group_name: str,
    members: list[str],
    default_pick: str,
    source_query: str,
    source_run_id: str,
) -> None:
    """Write a discovered conflict group to admin Postgres (best-effort)."""
    import json
    import os
    import threading

    db_url = os.getenv("SYNESIS_TRACE_DATABASE_URL", "")
    if not db_url:
        return

    exclusion_map: dict[str, list[str]] = {}
    for m in members:
        exclusion_map[m] = [other for other in members if other != m]

    def _write() -> None:
        try:
            import psycopg2

            dsn = db_url.replace("postgresql+asyncpg://", "postgresql://")
            conn = psycopg2.connect(dsn)
            cur = conn.cursor()
            cur.execute(
                """INSERT INTO discovered_conflict_groups
                   (group_name, members, default_pick, exclusion_map, source_query, source_run_id)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT DO NOTHING""",
                (
                    group_name,
                    json.dumps(members),
                    default_pick,
                    json.dumps(exclusion_map),
                    source_query,
                    source_run_id,
                ),
            )
            conn.commit()
            cur.close()
            conn.close()
        except Exception as e:
            logger.debug("persist_discovered_group_failed", extra={"error": str(e)[:200]})

    threading.Thread(target=_write, daemon=True).start()


def needs_second_pass(frame: FirstPassFrame, report: MissingFieldReport) -> bool:
    """Determine if LLM repair (Stage 3) is needed."""
    if report.missing_critical_fields:
        return True
    if report.conflicting_fields:
        return True
    if len(frame.main_question_candidates) > 2:
        return True
    return any(v < 0.3 for v in frame.field_confidence_map.values())
