"""Frame Extractor — 3-stage pipeline for structured task decomposition.

Stage 1: GLiNER2 microservice extracts raw spans (entities + classification)
Stage 2: Deterministic normalizer deduplicates, reclassifies, scores confidence
Stage 3: LLM repair — invoked ONLY when Stage 2 flags missing/conflicting fields

Output: UserTask dict written to state["user_task"], consumed by all downstream nodes.
"""

from __future__ import annotations

import asyncio
import collections
import hashlib
import json
import logging
import re
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..api_metrics import record_frame_cache_hit, record_frame_cache_miss, record_frame_cache_size
from ..config import reasoning_body, settings
from ..gliner_client import get_gliner_client
from ..llm_telemetry import get_llm_http_client
from ..schemas import DeliverableDetail, FirstPassFrame, MissingFieldReport, UserTask, safe_parse_json
from ..state import NodeOutcome, NodeTrace
from ..synesis_tracer import get_synesis_tracer
from .frame_normalizer import normalize_frame

logger = logging.getLogger("synesis.frame_extractor")

# ---------------------------------------------------------------------------
# Frame extraction cache — caches full UserTask dict by task_description hash
# ---------------------------------------------------------------------------
_frame_cache: collections.OrderedDict[str, tuple[float, dict[str, Any]]] = collections.OrderedDict()


def _frame_cache_get(task_description: str) -> dict[str, Any] | None:
    if not settings.frame_cache_enabled:
        return None
    key = hashlib.sha256(task_description.encode()).hexdigest()
    entry = _frame_cache.get(key)
    if entry is None:
        record_frame_cache_miss()
        return None
    expires_at, result = entry
    if expires_at and time.monotonic() > expires_at:
        _frame_cache.pop(key, None)
        record_frame_cache_miss()
        record_frame_cache_size(len(_frame_cache))
        return None
    _frame_cache.move_to_end(key)
    record_frame_cache_hit()
    return result


def _frame_cache_put(task_description: str, result: dict[str, Any]) -> None:
    if not settings.frame_cache_enabled:
        return
    key = hashlib.sha256(task_description.encode()).hexdigest()
    while len(_frame_cache) >= settings.frame_cache_max_entries:
        _frame_cache.popitem(last=False)
    _frame_cache[key] = (0.0, result)  # no TTL expiry (0 = never)
    record_frame_cache_size(len(_frame_cache))


# --------------------------------------------------------------------------- #
# Stage 3: LLM repair prompt (compact — NOT full re-extraction)
# --------------------------------------------------------------------------- #

_REPAIR_SYSTEM = """\
You are a task normalizer. You receive:
1. The raw user message.
2. First-pass extracted candidates (from a NER model).
3. A report of missing, conflicting, or low-confidence fields.

Your job is REPAIR — fill gaps and resolve conflicts. Do NOT re-extract from scratch.

Rules:
- Prefer extracted candidates unless clearly contradictory.
- Do not invent hidden requirements the user never stated.
- Preserve ambiguity explicitly when unresolved — put it in "ambiguities".
- Separate explicit requirements (what to do) from inferred success criteria (how well).
- Separate hard constraints from style preferences.
- Mark assumptions only when the answer requires information the user omitted.
- If the main question is unclear, pick the best candidate and record the ambiguity.
- If a field is unknown, output an empty string or empty list — never hallucinate.
- "needs_web" should be true ONLY if the query asks about current events, recent \
changes, latest versions, news, or anything time-sensitive.

Output valid JSON matching this schema. No prose outside the JSON object.
Be terse. Every value should use the minimum words needed. Do not elaborate inside JSON string values.

{
  "main_question": "one-sentence core request",
  "explicit_requirements": ["action items the user wants addressed"],
  "constraints": ["limits, restrictions, boundaries"],
  "negative_constraints": ["things to avoid or not do"],
  "requested_format": "prose|json|yaml|xml|csv|toml|ascii|table|code|diagram|bullet_list|email",
  "output_schema": ["top-level field/key names when a structured format is requested"],
  "deliverables": ["explicit output sections or artifacts expected"],
  "success_criteria": ["quality/style instructions that apply to all sections"],
  "ambiguities": ["underspecified or unclear aspects"],
  "assumptions_needed": ["assumptions required to proceed"],
  "domain_tags": ["subject area tags"],
  "technologies": ["specific tools, frameworks, languages mentioned"],
  "escalation_signals": ["uncertainty or evidence-sensitivity cues"],
  "decision_required": false,
  "needs_web": false
}"""


async def _llm_repair(
    raw_text: str,
    first_pass: FirstPassFrame,
    report: MissingFieldReport,
) -> tuple[UserTask, int]:
    """Stage 3: LLM second-pass to repair missing/conflicting fields.

    Returns (repaired_task, tokens_used).
    """
    _repair_kw: dict[str, Any] = {}
    _repair_eb: dict[str, Any] = {}
    if settings.guided_json_enabled:
        _repair_eb["chat_template_kwargs"] = {"enable_thinking": False}
    else:
        _repair_kw["response_format"] = {"type": "json_object"}
    # Repair is a deterministic JSON-fill task — never needs reasoning.
    # Force "none" regardless of planner_reasoning_effort to avoid Grok
    # spending 10-20s thinking about simple gap-filling.
    _repair_eb.update(reasoning_body("none"))
    if _repair_eb:
        _repair_kw["extra_body"] = _repair_eb

    llm = ChatOpenAI(
        base_url=settings.router_model_url,
        api_key="not-needed",
        model=settings.router_model_name,
        temperature=0.1,
        max_completion_tokens=settings.frame_repair_max_tokens,
        streaming=False,
        use_responses_api=False,
        stop=["\n\n"],
        model_kwargs=_repair_kw if _repair_kw else None,
        http_client=get_llm_http_client(uds_path=settings.router_model_uds or None),
    )

    repair_input = json.dumps(
        {
            "raw_prompt": raw_text[:4000],
            "extracted": first_pass.model_dump(),
            "report": report.model_dump(),
        },
        indent=None,
        default=str,
    )

    result = await llm.ainvoke(
        [
            SystemMessage(content=_REPAIR_SYSTEM),
            HumanMessage(content=repair_input),
        ]
    )

    try:
        raw = safe_parse_json(result.content or "")
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("llm_repair_json_parse_failed", extra={"error": str(exc)[:200]})
        raise

    task = UserTask(**{k: v for k, v in raw.items() if k in UserTask.model_fields})
    usage = getattr(result, "usage_metadata", None) or {}
    repair_tokens = usage.get("total_tokens", 0) if isinstance(usage, dict) else 0
    return task, repair_tokens


_CONSTRAINT_PREFIXES = re.compile(
    r"^(?:team size|budget|security|must support|mix of|the system should|"
    r"must be|should be|needs to be|limited|requires?|at least|at most|"
    r"no more than|within \d|max(?:imum)?|min(?:imum)?)",
    re.IGNORECASE,
)
_NEGATIVE_PREFIXES = re.compile(
    r"^(?:do not|don't|avoid|never|no )",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Universal structure patterns — every way humans create hierarchy in prompts
# ---------------------------------------------------------------------------
# Section-level (top-level deliverables):
_HEADING_NUMBERED_RE = re.compile(
    r"^\s*#{1,6}\s+(\d+)\.?\s+(?:\*\*)?(.+?)(?:\*\*)?\s*$", re.MULTILINE,
)
_BOLD_SECTION_RE = re.compile(
    r"^\s*\*\*(?:(?:Section|Part|Step|Phase)\s+)?(\d+)[.):]\s*(.+?)\*\*\s*$",
    re.MULTILINE | re.IGNORECASE,
)
_NUMBERED_LINE_RE = re.compile(r"^\s*(\d+)[.)]\s+(.+)$", re.MULTILINE)
_LETTERED_RE = re.compile(r"^\s*([a-zA-Z])[.)]\s+(.+)$", re.MULTILINE)
_ROMAN_RE = re.compile(
    r"^\s*((?:X{0,3})(?:IX|IV|V?I{0,3}))[.)]\s+(.+)$",
    re.MULTILINE | re.IGNORECASE,
)
# Item-level (child requirements under a section):
_DASH_BULLET_LINE_RE = re.compile(r"^\s*[-*]\s+(.+)$", re.MULTILINE)
# Colon-delimited label at line start (only when >= 2 such lines exist)
_COLON_LABEL_RE = re.compile(r"^([A-Z][A-Za-z &/]+):\s+(.+)$", re.MULTILINE)

# Per-deliverable format hints — detects "in JSON", "provide YAML", etc.
_FORMAT_HINT_RE = re.compile(
    r"\b(?:in\s+)?(json|yaml|xml|csv|toml|markdown|mermaid|diagram|table|code)\b",
    re.IGNORECASE,
)

# Meta-labels whose children should be promoted to top-level deliverables
_META_DELIVERABLE_RE = re.compile(
    r"^(?:deliverables?|what i (?:want|need)|requirements?|tasks?|"
    r"goals?|objectives?|outputs?|asks?)\b",
    re.IGNORECASE,
)


class _StructuredItem:
    """A parsed prompt item with optional children."""

    __slots__ = ("text", "level", "children")

    def __init__(self, text: str, level: int = 0) -> None:
        self.text = text
        self.level = level
        self.children: list[str] = []


def _extract_format_hints(section_text: str, children: list[str]) -> str:
    """Scan a section heading and its children for output format indicators."""
    combined = section_text + " " + " ".join(children)
    hits = _FORMAT_HINT_RE.findall(combined)
    if not hits:
        return ""
    unique = list(dict.fromkeys(h.lower() for h in hits))
    return ", ".join(unique)


def _extract_deliverables_from_text(
    text: str,
) -> tuple[list[str], list[str], list[str], list[str], dict[int, str]]:
    """Extract deliverables, child requirements, constraints, negatives, and format hints.

    Recognises markdown headings, bold sections, numbered/lettered/roman lists,
    dash/star bullets, and colon-delimited labels.  Section-level items become
    deliverables; bullets nested beneath them become child requirements that
    capture the hierarchy users express in structured prompts.

    Returns (deliverables, sub_requirements, constraints, negative_constraints,
             format_hints) where format_hints maps deliverable index -> hint str.
    """
    # --- Phase 1: collect section-level candidates (order matters — first match wins) ---
    section_hits: list[tuple[int, str]] = []
    seen_positions: set[int] = set()

    for pattern in (_HEADING_NUMBERED_RE, _BOLD_SECTION_RE):
        for m in pattern.finditer(text):
            if m.start() not in seen_positions:
                seen_positions.add(m.start())
                section_hits.append((m.start(), m.group(2).strip().rstrip(",;.")))

    for pattern in (_NUMBERED_LINE_RE, _LETTERED_RE, _ROMAN_RE):
        for m in pattern.finditer(text):
            if m.start() not in seen_positions:
                seen_positions.add(m.start())
                section_hits.append((m.start(), m.group(2).strip().rstrip(",;.")))

    colon_matches = list(_COLON_LABEL_RE.finditer(text))
    if len(colon_matches) >= 2:
        for m in colon_matches:
            if m.start() not in seen_positions:
                seen_positions.add(m.start())
                label = m.group(1).strip()
                body = m.group(2).strip().rstrip(",;.")
                section_hits.append((m.start(), f"{label}: {body}"))

    section_hits.sort(key=lambda t: t[0])
    sections = [_StructuredItem(content, level=0) for _, content in section_hits]

    # --- Phase 2: collect bullet-level candidates ---
    bullet_candidates: list[tuple[int, str]] = []
    for m in _DASH_BULLET_LINE_RE.finditer(text):
        if m.start() not in seen_positions:
            bullet_candidates.append((m.start(), m.group(1).strip().rstrip(",;.")))

    # --- Phase 3: assign bullets to their nearest preceding section ---
    if sections and bullet_candidates:
        section_positions = [pos for pos, _ in section_hits]
        for bpos, btext in bullet_candidates:
            parent_idx = -1
            for i, spos in enumerate(section_positions):
                if spos < bpos:
                    parent_idx = i
                else:
                    break
            if parent_idx >= 0:
                sections[parent_idx].children.append(btext)

    # --- Phase 4: classify into deliverables / constraints / negatives ---
    deliverables: list[str] = []
    sub_requirements: list[str] = []
    constraints: list[str] = []
    negative: list[str] = []
    format_hints: dict[int, str] = {}

    # Track which section index maps to which deliverable index so we can
    # associate sub-requirements with the correct parent deliverable later.
    section_to_deliverable: dict[int, int] = {}

    def _classify_child(item: str, target_list: list[str]) -> None:
        """Classify a sub-item (bullet) as deliverable/constraint/negative."""
        if not item or len(item) < 3:
            return
        if _NEGATIVE_PREFIXES.match(item):
            negative.append(item)
        elif _CONSTRAINT_PREFIXES.match(item):
            constraints.append(item)
        else:
            target_list.append(item)

    for sec_idx, sec in enumerate(sections):
        t = sec.text
        if not t or len(t) < 3:
            continue

        promote_children = bool(_META_DELIVERABLE_RE.match(t))

        if not promote_children:
            del_idx = len(deliverables)
            deliverables.append(t)
            section_to_deliverable[sec_idx] = del_idx

            hint = _extract_format_hints(t, sec.children)
            if hint:
                format_hints[del_idx] = hint

        child_target = deliverables if promote_children else sub_requirements
        for child in sec.children:
            _classify_child(child, child_target)

    # Orphan bullets (no parent section) — classify directly
    if not sections:
        for _, btext in bullet_candidates:
            if not btext or len(btext) < 5:
                continue
            if _NEGATIVE_PREFIXES.match(btext):
                negative.append(btext)
            elif _CONSTRAINT_PREFIXES.match(btext):
                constraints.append(btext)
            else:
                deliverables.append(btext)

    return deliverables, sub_requirements, constraints, negative, format_hints


def _build_deliverable_details(
    deliverables: list[str],
    sub_requirements: list[str],
    format_hints: dict[int, str],
) -> list[DeliverableDetail]:
    """Build DeliverableDetail list from text parser output.

    Sub-requirements are currently a flat list (no parent tracking beyond
    order).  We assign them proportionally across deliverables.  Format
    hints are keyed by deliverable index from the extraction phase.
    """
    if not deliverables:
        return []

    details: list[DeliverableDetail] = []
    for i, title in enumerate(deliverables):
        details.append(
            DeliverableDetail(
                title=title,
                format_hint=format_hints.get(i, ""),
            )
        )

    # Distribute sub-requirements across deliverables proportionally.
    # If we have N deliverables and M sub-reqs, each deliverable gets
    # roughly M/N sub-reqs in order.  This preserves document order.
    if sub_requirements and details:
        n = len(details)
        chunk_size = max(1, len(sub_requirements) // n)
        for i, detail in enumerate(details):
            start = i * chunk_size
            end = start + chunk_size if i < n - 1 else len(sub_requirements)
            detail.sub_requirements = sub_requirements[start:end]

    return details


def _fuzzy_match(a: str, b: str) -> bool:
    """Check if two deliverable titles refer to the same thing."""
    a_lower = a.lower().strip()
    b_lower = b.lower().strip()
    if a_lower == b_lower:
        return True
    # One contains the other (handles "Architecture Design" vs
    # "Architecture Design and Implementation")
    if a_lower in b_lower or b_lower in a_lower:
        return True
    # Significant word overlap (>60%)
    a_words = {w for w in a_lower.split() if len(w) > 3}
    b_words = {w for w in b_lower.split() if len(w) > 3}
    if a_words and b_words:
        overlap = len(a_words & b_words)
        return overlap / min(len(a_words), len(b_words)) > 0.6
    return False


def _merge_extractions(
    user_task: UserTask,
    text_deliverables: list[str],
    text_sub_reqs: list[str],
    text_constraints: list[str],
    text_negatives: list[str],
    text_fmt_hints: dict[int, str],
) -> dict[str, Any]:
    """Merge text structure parser results into a UserTask from GLiNER2.

    GLiNER2 provides entity-level extraction (technologies, domain tags,
    classification, format detection).  The text structure parser provides
    hierarchical extraction (sections, sub-requirements, per-deliverable
    format hints).  Merging gives us the best of both.

    Mutates user_task in place.  Returns stats dict for logging.
    """
    deliverables_added = 0
    constraints_added = 0
    negatives_added = 0

    existing_deliverables = list(user_task.deliverables)

    # Union of deliverables: add text parser deliverables not already in GLiNER2 set
    for td in text_deliverables:
        if not any(_fuzzy_match(td, ed) for ed in existing_deliverables):
            user_task.deliverables.append(td)
            existing_deliverables.append(td)
            deliverables_added += 1

    # Union of constraints
    existing_constraints_lower = {c.lower() for c in user_task.constraints}
    for tc in text_constraints:
        if tc.lower() not in existing_constraints_lower:
            user_task.constraints.append(tc)
            existing_constraints_lower.add(tc.lower())
            constraints_added += 1

    # Union of negative constraints
    existing_neg_lower = {n.lower() for n in user_task.negative_constraints}
    for tn in text_negatives:
        if tn.lower() not in existing_neg_lower:
            user_task.negative_constraints.append(tn)
            existing_neg_lower.add(tn.lower())
            negatives_added += 1

    # Add sub-requirements to explicit_requirements (deduped)
    existing_reqs_lower = {r.lower() for r in user_task.explicit_requirements}
    for sr in text_sub_reqs:
        if sr.lower() not in existing_reqs_lower:
            user_task.explicit_requirements.append(sr)
            existing_reqs_lower.add(sr.lower())

    # Build deliverable_details from the merged deliverables list.
    # Match text parser's positional format hints to the final deliverable
    # list, and distribute sub-requirements.
    user_task.deliverable_details = _build_deliverable_details(
        user_task.deliverables, text_sub_reqs, text_fmt_hints,
    )

    return {
        "deliverables_added": deliverables_added,
        "constraints_added": constraints_added,
        "negatives_added": negatives_added,
        "total_deliverables": len(user_task.deliverables),
        "total_details": len(user_task.deliverable_details),
    }


def _build_deterministic_task(
    task_description: str,
    taxonomy_metadata: dict[str, Any],
    explicit_deliverables: int,
) -> dict[str, Any]:
    """Build a UserTask from prompt text without external service calls.

    Extracts deliverables, constraints, and negative constraints directly
    from numbered/bulleted lists in the prompt. Falls back to taxonomy
    required_elements only when no deliverables are found in the text.
    """
    domain = taxonomy_metadata.get("taxonomy_key", "general")
    required_elements = taxonomy_metadata.get("required_elements") or []

    extracted_deliverables, extracted_sub_reqs, extracted_constraints, extracted_negative, fmt_hints = (
        _extract_deliverables_from_text(task_description)
    )

    if extracted_deliverables:
        deliverables = extracted_deliverables
    elif explicit_deliverables and required_elements:
        deliverables = required_elements[:explicit_deliverables]
    else:
        deliverables = []

    details = _build_deliverable_details(deliverables, extracted_sub_reqs, fmt_hints)

    first_sentence = task_description.split("\n")[0].strip()[:200]
    requirements = [first_sentence] if first_sentence else []
    if extracted_sub_reqs:
        requirements.extend(extracted_sub_reqs)

    task = UserTask(
        main_question=first_sentence,
        explicit_requirements=requirements,
        deliverables=deliverables,
        deliverable_details=details,
        constraints=extracted_constraints,
        negative_constraints=extracted_negative,
        domain_tags=[domain] if domain and domain not in ("generic", "general") else [],
        requested_format="prose",
    )

    logger.info(
        "deterministic_task_built",
        extra={
            "deliverables": len(task.deliverables),
            "constraints": len(task.constraints),
            "negative_constraints": len(task.negative_constraints),
            "source": "text_extraction" if extracted_deliverables else "taxonomy_fallback",
        },
    )

    return task.model_dump()


async def frame_extractor_node(state: dict[str, Any]) -> dict[str, Any]:
    """Extract a UserTask from the user prompt via the 3-stage pipeline.

    Stage 1: GLiNER2 service → raw spans with confidence
    Stage 2: Deterministic normalizer → UserTask + MissingFieldReport
    Stage 3: LLM repair → only if Stage 2 flags issues

    Trivial prompts (difficulty < 0.15) skip all stages and get a deterministic frame.
    """
    start = time.monotonic()
    node_name = "frame_extractor"

    task_description = state.get("task_description", "")
    difficulty = state.get("difficulty", 0.5)
    taxonomy_metadata = state.get("taxonomy_metadata") or {}
    explicit_deliverables = state.get("explicit_deliverables", 0)

    if difficulty < 0.15 or not task_description.strip():
        user_task = _build_deterministic_task(task_description, taxonomy_metadata, explicit_deliverables)
        latency = (time.monotonic() - start) * 1000
        logger.info(
            "frame_extractor_deterministic",
            extra={
                "difficulty": round(difficulty, 2),
                "latency_ms": round(latency),
                "deliverables_extracted": len((user_task or {}).get("deliverables", [])),
                "constraints_extracted": len((user_task or {}).get("constraints", [])),
                "gliner_used": False,
            },
        )
        _tracer = get_synesis_tracer()
        if _tracer:
            _tracer.annotate_span(
                "entry_pipeline",
                {
                    "frame_extraction": {
                        "path": "deterministic_trivial",
                        "difficulty": round(difficulty, 2),
                        "latency_ms": round(latency, 1),
                        "prompt_snippet": task_description[:200],
                    },
                },
            )
        return {
            "user_task": user_task,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning="deterministic_trivial",
                    confidence=0.8,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                )
            ],
        }

    # Frame cache: return cached result for identical task descriptions
    cached_frame = _frame_cache_get(task_description)
    if cached_frame is not None:
        latency = (time.monotonic() - start) * 1000
        logger.info("frame_cache_hit", extra={"latency_ms": round(latency)})
        _tracer = get_synesis_tracer()
        if _tracer:
            _tracer.annotate_span(
                "entry_pipeline",
                {
                    "frame_extraction": {
                        "path": "cache_hit",
                        "latency_ms": round(latency, 1),
                        "prompt_snippet": task_description[:200],
                        "cached_deliverables": len(cached_frame.get("deliverables", [])),
                    },
                },
            )
        return {
            "user_task": cached_frame,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning="frame_cache_hit",
                    confidence=0.9,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                )
            ],
        }

    try:
        # Stage 1: GLiNER2 + text structure parser in parallel.
        # GLiNER2 is ~100-500ms (network + CPU inference); text parser is
        # ~1-5ms pure regex.  Running them concurrently means the text parser
        # adds zero wall-clock overhead.
        prompt_text = task_description[:5000]
        client = get_gliner_client()

        gliner_coro = asyncio.to_thread(client.extract, prompt_text)
        text_coro = asyncio.to_thread(_extract_deliverables_from_text, prompt_text)
        first_pass, text_results = await asyncio.gather(gliner_coro, text_coro)

        stage1_latency = (time.monotonic() - start) * 1000
        total_spans = sum(
            len(getattr(first_pass, f))
            for f in FirstPassFrame.model_fields
            if f not in ("task_classification", "field_confidence_map")
        )
        text_deliverables, text_sub_reqs, text_constraints, text_negatives, text_fmt_hints = text_results
        logger.info(
            "frame_stage1_complete",
            extra={
                "spans": total_spans,
                "classification": first_pass.task_classification,
                "text_parser_deliverables": len(text_deliverables),
                "text_parser_sub_reqs": len(text_sub_reqs),
                "text_parser_format_hints": len(text_fmt_hints),
                "latency_ms": round(stage1_latency),
            },
        )

        # Stage 2: Deterministic normalization + domain profiling
        user_task, report = normalize_frame(
            first_pass,
            prompt_text,
            domain_ref_counts=state.get("domain_ref_counts"),
            active_domain_refs=state.get("active_domain_refs"),
        )

        stage2_latency = (time.monotonic() - start) * 1000

        # Stage 2b: Merge text structure parser results into UserTask.
        # The text parser captures hierarchy (sections → sub-requirements)
        # and per-deliverable format hints that GLiNER2 NER cannot detect.
        merge_stats = _merge_extractions(
            user_task, text_deliverables, text_sub_reqs,
            text_constraints, text_negatives, text_fmt_hints,
        )

        # Frame completeness check: count structural sections in raw text
        # and compare against extracted deliverables.  A mismatch means we're
        # losing user-specified sections — flag it loudly.
        _section_count = len(_HEADING_NUMBERED_RE.findall(prompt_text))
        _section_count += len(_BOLD_SECTION_RE.findall(prompt_text))
        if _section_count == 0:
            _section_count = len(_NUMBERED_LINE_RE.findall(prompt_text))
        _del_count = len(user_task.deliverables)
        _completeness_gap = _section_count - _del_count
        if _completeness_gap > 0 and _section_count >= 3:
            logger.warning(
                "frame_completeness_warning",
                extra={
                    "sections_in_prompt": _section_count,
                    "deliverables_extracted": _del_count,
                    "gap": _completeness_gap,
                    "prompt_length": len(prompt_text),
                },
            )

        logger.info(
            "frame_stage2_complete",
            extra={
                "deliverables": len(user_task.deliverables),
                "deliverable_details": len(user_task.deliverable_details),
                "requirements": len(user_task.explicit_requirements),
                "second_pass_needed": report.should_call_second_pass,
                "reasons": report.reasons,
                "merge_stats": merge_stats,
                "sections_in_prompt": _section_count,
                "frame_completeness_gap": _completeness_gap,
                "latency_ms": round(stage2_latency),
            },
        )

        # Stage 3: LLM repair — only if merge didn't fill the gaps.
        # Re-evaluate repair need: if text parser provided deliverables
        # and main_question is populated, skip the expensive LLM call.
        tokens_used = 0
        extraction_mode = "gliner2_plus_text_parser"
        _repair_threshold = settings.frame_repair_above
        _saved_profile = user_task.domain_profile

        repair_still_needed = report.should_call_second_pass
        if repair_still_needed and merge_stats.get("deliverables_added", 0) > 0:
            remaining_reasons = [
                r for r in (report.reasons or [])
                if "deliverable" not in r.lower()
            ]
            if not remaining_reasons and user_task.main_question:
                repair_still_needed = False
                extraction_mode = "gliner2_plus_text_parser_no_repair"
                logger.info(
                    "frame_repair_skipped_text_parser_filled_gaps",
                    extra={
                        "original_reasons": report.reasons,
                        "deliverables_after_merge": len(user_task.deliverables),
                    },
                )

        if repair_still_needed and difficulty >= _repair_threshold:
            extraction_mode = "gliner2_text_parser_plus_llm_repair"
            user_task, tokens_used = await _llm_repair(prompt_text, first_pass, report)
            if _saved_profile:
                user_task.domain_profile = _saved_profile
            # Re-merge text parser results into repaired task (repair
            # produces flat lists; text parser adds hierarchy back).
            _merge_extractions(
                user_task, text_deliverables, text_sub_reqs,
                text_constraints, text_negatives, text_fmt_hints,
            )
        elif repair_still_needed:
            extraction_mode = "gliner2_text_parser_skip_repair_low_difficulty"
            logger.info(
                "frame_repair_skipped_low_difficulty",
                extra={
                    "difficulty": round(difficulty, 2),
                    "reasons": report.reasons,
                },
            )

        # Merge taxonomy defaults if GLiNER2 missed domain
        if not user_task.domain_tags:
            tax_key = taxonomy_metadata.get("taxonomy_key", "")
            if tax_key and tax_key not in ("generic", "general"):
                user_task.domain_tags = [tax_key]

        user_task_dict = user_task.model_dump()
        latency = (time.monotonic() - start) * 1000

        logger.info(
            "frame_extractor_complete",
            extra={
                "mode": extraction_mode,
                "deliverables": len(user_task.deliverables),
                "deliverable_details": len(user_task.deliverable_details),
                "requirements": len(user_task.explicit_requirements),
                "constraints": len(user_task.constraints),
                "negative_constraints": len(user_task.negative_constraints),
                "gliner_used": True,
                "domain_tags": user_task.domain_tags,
                "format": user_task.requested_format,
                "needs_web": user_task.needs_web,
                "decision_required": user_task.decision_required,
                "latency_ms": round(latency),
            },
        )

        _frame_cache_put(task_description, user_task_dict)

        _tracer = get_synesis_tracer()
        if _tracer:
            # Rich trace: dump actual data at each stage so the admin UI
            # shows exactly what each extractor produced, not just counts.
            _gliner_snapshot = {
                "classification": first_pass.task_classification,
                "deliverables": [c.text for c in first_pass.deliverables][:20],
                "requirements": [c.text for c in first_pass.requirements][:20],
                "constraints": [c.text for c in first_pass.constraints][:10],
                "technologies": [c.text for c in first_pass.technologies][:10],
                "formats": [c.text for c in first_pass.formats][:5],
                "confidence_map": {
                    k: round(v, 2) for k, v in first_pass.field_confidence_map.items()
                },
            }
            _text_parser_snapshot = {
                "deliverables": text_deliverables[:20],
                "sub_requirements": text_sub_reqs[:20],
                "constraints": text_constraints[:10],
                "negatives": text_negatives[:10],
                "format_hints": {str(k): v for k, v in text_fmt_hints.items()},
            }
            _detail_snapshot = [
                {
                    "title": d.title,
                    "sub_reqs": d.sub_requirements[:8],
                    "format": d.format_hint,
                }
                for d in user_task.deliverable_details[:15]
            ]

            _tracer.annotate_span(
                "entry_pipeline",
                {
                    "frame_extraction": {
                        "path": extraction_mode,
                        "stage1_latency_ms": round(stage1_latency, 1),
                        "stage2_latency_ms": round(stage2_latency, 1),
                        "total_latency_ms": round(latency, 1),
                        "repair_tokens": tokens_used,
                        "prompt_snippet": task_description[:300],
                        "gliner_output": _gliner_snapshot,
                        "text_parser_output": _text_parser_snapshot,
                        "merge_stats": merge_stats,
                        "normalizer_report": {
                            "should_repair": report.should_call_second_pass,
                            "reasons": report.reasons[:5],
                        },
                        "final_frame": {
                            "main_question": user_task.main_question[:200],
                            "deliverables": user_task.deliverables[:15],
                            "deliverable_details": _detail_snapshot,
                            "explicit_requirements": user_task.explicit_requirements[:15],
                            "constraints": user_task.constraints[:10],
                            "negative_constraints": user_task.negative_constraints[:10],
                            "technologies": user_task.technologies[:10],
                            "domain_tags": user_task.domain_tags,
                            "requested_format": user_task.requested_format,
                            "embedded_formats": user_task.embedded_formats,
                            "needs_web": user_task.needs_web,
                        },
                    },
                },
            )

        result: dict[str, Any] = {
            "user_task": user_task_dict,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"{extraction_mode}: {len(user_task.deliverables)} deliverables, "
                    f"{len(user_task.deliverable_details)} details, "
                    f"{len(user_task.explicit_requirements)} requirements",
                    confidence=0.9,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                    tokens_used=tokens_used,
                )
            ],
        }

        return result

    except Exception as e:
        logger.warning("frame_extractor_failed error=%s, using deterministic fallback", e)
        user_task = _build_deterministic_task(task_description, taxonomy_metadata, explicit_deliverables)
        latency = (time.monotonic() - start) * 1000
        return {
            "user_task": user_task,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"pipeline fallback: {e}",
                    confidence=0.5,
                    outcome=NodeOutcome.ERROR,
                    latency_ms=latency,
                )
            ],
        }
