"""Stage 2 — Deterministic normalizer for the GLiNER2 frame extraction pipeline.

Pure Python, no ML, no LLM. Takes a FirstPassFrame (raw GLiNER2 output) and
produces a normalized UserTask + MissingFieldReport for gating Stage 3.

Includes the domain profiler (sensemaking-driven weighted multi-domain
understanding) which replaces the old intent-anchor hard-lock system.

Ref: Klein et al. (2007) Data-Frame theory of sensemaking.
Ref: Snowden & Boone (2007) Cynefin framework for frame coherence.
Ref: Blei, Ng & Jordan (2003) LDA — prompts are topic mixtures.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ..config import settings
from ..schemas import (
    DomainProfile,
    DomainWeight,
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
#
# Two tiers:
#   1. Presentation formats (table, diagram, code, etc.) — always markdown
#   2. Structured formats (json, yaml, xml, csv, toml) — checked second,
#      and only treated as "pure structured output" when the user's phrasing
#      explicitly asks for the entire response in that format.
#
# When a structured keyword appears in a complex prompt (e.g. "provide a
# YAML example"), it is classified as an *embedded* format: the writer
# stays in markdown mode and includes fenced code blocks in that format.
# --------------------------------------------------------------------------- #

_FORMAT_PATTERNS = {
    # Presentation (within markdown) — checked first in fallback scan
    "table": re.compile(r"\b(?:table|matrix|grid|spreadsheet)\b", re.IGNORECASE),
    "code": re.compile(r"\b(?:code|snippet|script|implementation|function|class)\b", re.IGNORECASE),
    "diagram": re.compile(r"\b(?:diagram|chart|graph|flowchart|mermaid|uml)\b", re.IGNORECASE),
    "bullet_list": re.compile(r"\b(?:bullet|list|numbered|enumerat)\b", re.IGNORECASE),
    "email": re.compile(r"\b(?:email|letter|memo)\b", re.IGNORECASE),
    "ascii": re.compile(r"\b(?:ascii\s*(?:art|table|diagram)|plaintext|plain[\s-]?text)\b", re.IGNORECASE),
    # Structured (machine-parseable) — checked second in fallback scan
    "json": re.compile(r"\bjson\b", re.IGNORECASE),
    "yaml": re.compile(r"\b(?:yaml|yml)\b", re.IGNORECASE),
    "xml": re.compile(r"\b(?:xml|xhtml)\b", re.IGNORECASE),
    "csv": re.compile(r"\b(?:csv|tsv|comma[\s-]?separated|tab[\s-]?separated)\b", re.IGNORECASE),
    "toml": re.compile(r"\btoml\b", re.IGNORECASE),
}

# Structured formats override the writer's markdown directive entirely —
# BUT only when the user explicitly wants the *whole response* in that format.
STRUCTURED_FORMATS = frozenset({"json", "yaml", "xml", "csv", "toml"})

# Gate: does the user want the *entire response* as a structured document?
# Matches phrasing like "output as yaml", "respond in json only",
# "return valid json", "format: yaml", "give me only yaml".
_PURE_STRUCTURED_RE = re.compile(
    r"(?:^|\b)(?:"
    r"(?:output|respond|return|reply|format|write)\s+"
    r"(?:(?:it|this|that|the response|everything)\s+)?"
    r"(?:only\s+|exclusively\s+|purely\s+|strictly\s+|as\s+|in\s+)?"
    r"(?:valid\s+|pure\s+)?"
    r"(?:json|yaml|yml|xml|csv|toml)"
    r"|"
    r"(?:json|yaml|yml|xml|csv|toml)\s+only"
    r"|"
    r"(?:give\s+me|i\s+(?:want|need))\s+(?:only\s+)?(?:(?:the|a)\s+)?"
    r"(?:raw\s+|valid\s+|pure\s+)?"
    r"(?:json|yaml|yml|xml|csv|toml)(?:\s+output|\s+response|\s+document)?"
    r"(?:\s+only)?"
    r")",
    re.IGNORECASE,
)

# Regex to extract field/key names from JSON-like schema blocks in prompts.
# Matches "field_name": or "field_name" inside { ... } blocks.
_SCHEMA_FIELD_RE = re.compile(r'"(\w+)"\s*:', re.MULTILINE)

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


_TASK_PREFIX_RE = re.compile(
    r"^(?:task|question|goal|objective|request|challenge)\s*:\s*",
    re.IGNORECASE | re.MULTILINE,
)
_IMPERATIVE_RE = re.compile(
    r"^(propose|design|explain|build|create|describe|compare|analyze|write|implement|develop|outline|plan|evaluate|summarize|list|identify|discuss|assess|review|provide|recommend|suggest|define|generate|draft)\b",
    re.IGNORECASE,
)
_PREAMBLE_RE = re.compile(
    r"^(you are|i am|i'm|imagine you|act as|pretend|assume you|context:|background:)\b",
    re.IGNORECASE,
)


def _extract_main_question_heuristic(raw_text: str) -> str:
    """Derive main_question from prompt structure when GLiNER found no requirements.

    Handles structured prompts like "Task: Propose an architecture..." or prompts
    starting with imperative verbs.  Returns "" only when nothing useful is found.
    """
    if not raw_text or not raw_text.strip():
        return ""

    # Try: "Task:" / "Question:" / "Goal:" prefix — extract text after it
    m = _TASK_PREFIX_RE.search(raw_text)
    if m:
        after = raw_text[m.end() :].strip()
        first_block = after.split("\n\n")[0].strip()
        first_line = first_block.split("\n")[0].strip()
        if len(first_line) > 20:
            return first_line[:300]
        if len(first_block) > 20:
            return first_block[:300]

    lines = [ln.strip() for ln in raw_text.strip().split("\n") if ln.strip()]
    for line in lines:
        if _PREAMBLE_RE.match(line):
            continue
        if _IMPERATIVE_RE.match(line):
            return line[:300]

    # Fall back to first non-trivial, non-preamble line
    for line in lines:
        if _PREAMBLE_RE.match(line):
            continue
        if len(line) > 20:
            return line[:300]

    # Last resort: first line if anything is there
    if lines and len(lines[0]) > 10:
        return lines[0][:300]

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
    frame: FirstPassFrame,
    raw_text: str,
    *,
    domain_ref_counts: dict[str, int] | None = None,
    active_domain_refs: list[str] | None = None,
) -> tuple[UserTask, MissingFieldReport]:
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

    # Determine requested_format + embedded_formats + output_schema.
    #
    # Three outcomes for structured keywords (json/yaml/xml/csv/toml):
    #   1. GLiNER explicitly extracted a format → trust it as-is
    #   2. Raw text fallback + _PURE_STRUCTURED_RE matches → pure structured
    #   3. Raw text fallback + keyword found but NOT pure → embedded example
    #      (stays markdown, writer adds fenced code blocks in that format)
    requested_format = "prose"
    embedded_formats: list[str] = []

    if formats:
        fmt_text = formats[0].text.lower().strip()
        for fmt, pattern in _FORMAT_PATTERNS.items():
            if pattern.search(fmt_text):
                requested_format = fmt
                break
        else:
            requested_format = fmt_text
    else:
        for fmt, pattern in _FORMAT_PATTERNS.items():
            if pattern.search(raw_text):
                if fmt in STRUCTURED_FORMATS:
                    if _PURE_STRUCTURED_RE.search(raw_text):
                        requested_format = fmt
                    else:
                        embedded_formats.append(fmt)
                else:
                    requested_format = fmt
                break

    # Collect any additional structured format mentions as embedded
    if requested_format not in STRUCTURED_FORMATS:
        for fmt in STRUCTURED_FORMATS:
            if fmt not in embedded_formats and _FORMAT_PATTERNS[fmt].search(raw_text):
                if not _PURE_STRUCTURED_RE.search(raw_text):
                    embedded_formats.append(fmt)
    embedded_formats = list(dict.fromkeys(embedded_formats))

    # Extract output_schema: field/key names when user specifies a structured schema.
    # Scans for JSON-like { "field": ... } blocks in the prompt.
    output_schema: list[str] = []
    if requested_format in STRUCTURED_FORMATS or embedded_formats:
        for brace_block in re.findall(r"\{[^{}]{10,}\}", raw_text):
            fields = _SCHEMA_FIELD_RE.findall(brace_block)
            output_schema.extend(f for f in fields if f not in output_schema)

    # Pick main_question — prefer extracted candidates, fall back to heuristic
    main_question = ""
    if main_q_candidates:
        main_question = main_q_candidates[0].text
    elif requirements:
        main_question = requirements[0].text
    else:
        main_question = _extract_main_question_heuristic(raw_text)

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
        output_schema=output_schema,
        embedded_formats=embedded_formats,
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

    # Domain profiling — sensemaking-driven weighted domain understanding.
    # Replaces old intent-anchor hard-lock with a DomainProfile that
    # classifies frame coherence as focused / composite / diffuse.
    profile = _build_domain_profile(
        user_task,
        domain_ref_counts=domain_ref_counts,
        active_domain_refs=active_domain_refs,
    )
    user_task.domain_profile = profile

    if embedded_formats:
        logger.info(
            "format_classified_as_embedded",
            extra={
                "requested_format": requested_format,
                "embedded_formats": embedded_formats,
            },
        )

    logger.info(
        "normalize_frame reqs=%d constraints=%d deliverables=%d second_pass=%s",
        len(user_task.explicit_requirements),
        len(user_task.constraints),
        len(user_task.deliverables),
        report.should_call_second_pass,
    )

    return user_task, report


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
# Domain Profiling — Sensemaking-Driven Weighted Domain Understanding
# ---------------------------------------------------------------------------
#
# Replaces the old intent-anchor / exclude-signal hard-lock system.
#
# Theory:
#   Pirolli & Card (1999) — build a holistic frame BEFORE gathering evidence.
#   Klein et al. (2007) — Data-Frame sensemaking: fit data into frames
#       iteratively, don't lock on first signal.
#   Blei, Ng & Jordan (2003) — prompts are topic mixtures with weights.
#   Snowden & Boone (2007) — Cynefin: focused = obvious/complicated,
#       composite = complicated (multi-expert), diffuse = complex (probe).
# ---------------------------------------------------------------------------


def _build_domain_profile(
    user_task: UserTask,
    *,
    domain_ref_counts: dict[str, int] | None = None,
    active_domain_refs: list[str] | None = None,
) -> DomainProfile:
    """Build a weighted domain profile from the full extracted frame.

    Algorithm:
      1. Seed weights from scoring engine domain_ref_counts.
      2. Boost domains whose technologies appear in deliverable text ("subject").
      3. Classify technologies that only appear in constraints as "tool".
      4. Normalize weights to 0-1.
      5. Classify frame coherence (focused / composite / diffuse).
      6. Annotate conflict-group relationships for downstream awareness.
    """
    if not settings.domain_profiling_enabled:
        return DomainProfile()

    counts = dict(domain_ref_counts or {})
    refs = list(active_domain_refs or [])

    # If no scoring-engine signal at all, build a minimal profile from GLiNER
    # domain_tags (the model's own domain-hint extraction).
    if not counts and not refs:
        for tag in user_task.domain_tags:
            tag_l = tag.lower().strip()
            if tag_l:
                counts[tag_l] = counts.get(tag_l, 0) + 1
                if tag_l not in refs:
                    refs.append(tag_l)

    if not counts:
        return DomainProfile(frame_coherence="diffuse", confidence=0.2)

    # --- Step 1: Seed raw weights from ref counts ---
    raw_weights: dict[str, float] = {}
    for domain, cnt in counts.items():
        raw_weights[domain] = float(cnt)

    # --- Step 2: Role classification via deliverable/constraint analysis ---
    deliverable_text = " ".join(user_task.deliverables).lower()
    constraint_text = " ".join(user_task.constraints).lower()
    tech_lower = [t.lower() for t in user_task.technologies]
    roles: dict[str, str] = {}

    from ..cohesion import get_conflict_groups

    conflict_groups = get_conflict_groups()

    # Map technologies to their domains via conflict groups
    tech_to_domain: dict[str, str] = {}
    for group_name, members in conflict_groups.items():
        for t in tech_lower:
            if t in members:
                tech_to_domain[t] = group_name

    # Classify: technologies in deliverables = "subject", in constraints = "tool"
    for t in tech_lower:
        if t in deliverable_text:
            domain = tech_to_domain.get(t, "")
            if domain and domain in raw_weights:
                raw_weights[domain] *= 1.5  # boost subject domains
                roles.setdefault(domain, "subject")
        elif t in constraint_text:
            domain = tech_to_domain.get(t, "")
            if domain:
                roles.setdefault(domain, "tool")

    # Any domain not classified via tech analysis gets "context"
    for domain in raw_weights:
        roles.setdefault(domain, "context")

    # --- Step 3: Normalize weights to 0-1 ---
    max_w = max(raw_weights.values()) if raw_weights else 1.0
    if max_w <= 0:
        max_w = 1.0
    normalized: dict[str, float] = {d: w / max_w for d, w in raw_weights.items()}

    # --- Step 4: Build DomainWeight list, sorted by weight descending ---
    domain_weights: list[DomainWeight] = []
    sources_map: dict[str, list[str]] = {}
    for domain in normalized:
        src: list[str] = []
        if domain in (domain_ref_counts or {}):
            src.append("scoring_engine")
        if domain in [t.lower().strip() for t in user_task.domain_tags]:
            src.append("gliner_domain_hint")
        for t in tech_lower:
            if tech_to_domain.get(t) == domain:
                src.append(f"technology:{t}")
                break
        sources_map[domain] = src

    for domain, weight in sorted(normalized.items(), key=lambda x: -x[1]):
        domain_weights.append(
            DomainWeight(
                domain=domain,
                weight=round(weight, 3),
                role=roles.get(domain, "context"),
                sources=sources_map.get(domain, []),
            )
        )

    # --- Step 5: Classify frame coherence ---
    weights_above_focused = [d for d in domain_weights if d.weight >= settings.focused_threshold]
    weights_above_composite = [d for d in domain_weights if d.weight >= settings.composite_threshold]
    all_below_diffuse = all(d.weight < settings.diffuse_max_weight for d in domain_weights)

    if len(weights_above_focused) == 1 and len(weights_above_composite) <= 2:
        coherence = "focused"
    elif len(weights_above_composite) >= 2:
        coherence = "composite"
    elif all_below_diffuse or not domain_weights:
        coherence = "diffuse"
    else:
        coherence = "focused"

    cross_domain = len(weights_above_composite) >= 2

    # Confidence: higher when one domain clearly dominates or the frame is clearly multi-domain
    if coherence == "focused" and weights_above_focused:
        confidence = min(0.95, weights_above_focused[0].weight)
    elif coherence == "composite":
        spread = max(d.weight for d in domain_weights) - min(d.weight for d in domain_weights if d.weight > 0.1)
        confidence = min(0.85, 0.7 + spread * 0.3)
    else:
        confidence = 0.3

    profile = DomainProfile(
        domains=domain_weights[:10],
        frame_coherence=coherence,
        cross_domain=cross_domain,
        confidence=round(confidence, 3),
    )

    logger.info(
        "domain_profile_built",
        extra={
            "domains": {d.domain: d.weight for d in profile.domains[:6]},
            "frame_coherence": profile.frame_coherence,
            "cross_domain": profile.cross_domain,
            "confidence": profile.confidence,
            "total_technologies": len(tech_lower),
            "total_domains": len(domain_weights),
        },
    )

    return profile


def needs_second_pass(frame: FirstPassFrame, report: MissingFieldReport) -> bool:
    """Determine if LLM repair (Stage 3) is needed."""
    if report.missing_critical_fields:
        return True
    if report.conflicting_fields:
        return True
    if len(frame.main_question_candidates) > 2:
        return True
    return any(v < 0.3 for v in frame.field_confidence_map.values())
