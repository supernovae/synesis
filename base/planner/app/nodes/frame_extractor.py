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

from ..config import settings
from ..gliner_client import get_gliner_client
from ..llm_telemetry import get_llm_http_client
from ..schemas import FirstPassFrame, MissingFieldReport, UserTask, safe_parse_json
from ..state import NodeOutcome, NodeTrace
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
        return None
    expires_at, result = entry
    if expires_at and time.monotonic() > expires_at:
        _frame_cache.pop(key, None)
        return None
    _frame_cache.move_to_end(key)
    return result


def _frame_cache_put(task_description: str, result: dict[str, Any]) -> None:
    if not settings.frame_cache_enabled:
        return
    key = hashlib.sha256(task_description.encode()).hexdigest()
    while len(_frame_cache) >= settings.frame_cache_max_entries:
        _frame_cache.popitem(last=False)
    _frame_cache[key] = (0.0, result)  # no TTL expiry (0 = never)


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
  "requested_format": "prose|table|code|diagram|bullet_list|mixed",
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
) -> UserTask:
    """Stage 3: LLM second-pass to repair missing/conflicting fields."""
    _repair_kw: dict[str, Any] = {"stop": ["\n\n"]}
    if settings.guided_json_enabled:
        _repair_kw["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
    else:
        _repair_kw["response_format"] = {"type": "json_object"}

    llm = ChatOpenAI(
        base_url=settings.planner_model_url,
        api_key="not-needed",
        model=settings.planner_model_name,
        temperature=0.1,
        max_completion_tokens=768 if not settings.guided_json_enabled else 1024,
        streaming=True,
        use_responses_api=False,
        model_kwargs=_repair_kw,
        http_client=get_llm_http_client(uds_path=settings.planner_model_uds or None),
    )

    repair_input = json.dumps(
        {
            "raw_prompt": raw_text[:2000],
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

    return UserTask(**{k: v for k, v in raw.items() if k in UserTask.model_fields})


_NUMBERED_LINE_RE = re.compile(r"^\s*(\d+)[.)]\s+(.+)$", re.MULTILINE)
_DASH_BULLET_LINE_RE = re.compile(r"^\s*[-*]\s+(.+)$", re.MULTILINE)
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


def _extract_deliverables_from_text(text: str) -> tuple[list[str], list[str], list[str]]:
    """Extract deliverable phrases from numbered and bulleted lists in the prompt.

    Separates imperative asks ("State the main design goals") from constraints
    ("Budget is limited") and negative constraints ("Do not give a generic answer").
    Returns only the deliverable-like items.
    """
    candidates: list[str] = []
    # Numbered items (1. ... / 2) ...)
    for _, content in _NUMBERED_LINE_RE.findall(text):
        candidates.append(content.strip().rstrip(",;."))
    # Dash/bullet items (- ... / * ...)
    for content in _DASH_BULLET_LINE_RE.findall(text):
        candidates.append(content.strip().rstrip(",;."))

    deliverables: list[str] = []
    constraints: list[str] = []
    negative: list[str] = []
    for c in candidates:
        if not c or len(c) < 5:
            continue
        if _NEGATIVE_PREFIXES.match(c):
            negative.append(c)
        elif _CONSTRAINT_PREFIXES.match(c):
            constraints.append(c)
        else:
            deliverables.append(c)

    return deliverables, constraints, negative


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

    extracted_deliverables, extracted_constraints, extracted_negative = _extract_deliverables_from_text(
        task_description
    )

    if extracted_deliverables:
        deliverables = extracted_deliverables
    elif explicit_deliverables and required_elements:
        deliverables = required_elements[:explicit_deliverables]
    else:
        deliverables = []

    first_sentence = task_description.split("\n")[0].strip()[:200]

    task = UserTask(
        main_question=first_sentence,
        explicit_requirements=[first_sentence] if first_sentence else [],
        deliverables=deliverables,
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
        # Stage 1: GLiNER2 extraction (offloaded to thread to avoid blocking event loop)
        prompt_text = task_description[:3000]
        client = get_gliner_client()
        first_pass = await asyncio.to_thread(client.extract, prompt_text)

        stage1_latency = (time.monotonic() - start) * 1000
        total_spans = sum(
            len(getattr(first_pass, f))
            for f in FirstPassFrame.model_fields
            if f not in ("task_classification", "field_confidence_map")
        )
        logger.info(
            "frame_stage1_complete",
            extra={
                "spans": total_spans,
                "classification": first_pass.task_classification,
                "latency_ms": round(stage1_latency),
            },
        )

        # Stage 2: Deterministic normalization + intent anchor resolution
        user_task, report, unresolved_conflicts = normalize_frame(first_pass, prompt_text)

        stage2_latency = (time.monotonic() - start) * 1000
        logger.info(
            "frame_stage2_complete",
            extra={
                "deliverables": len(user_task.deliverables),
                "requirements": len(user_task.explicit_requirements),
                "second_pass_needed": report.should_call_second_pass,
                "reasons": report.reasons,
                "latency_ms": round(stage2_latency),
            },
        )

        # Stage 3: LLM repair (only if needed AND difficulty warrants it)
        # The repair threshold adapts to inference_mode: "selective" raises it
        # to 0.6 so more prompts use the deterministic frame; "full" keeps 0.4.
        tokens_used = 0
        extraction_mode = "gliner2_only"
        _repair_threshold = settings.effective_frame_repair_above
        if report.should_call_second_pass and difficulty >= _repair_threshold:
            extraction_mode = "gliner2_plus_llm_repair"
            _saved_anchors = user_task.intent_anchors
            _saved_excl = user_task.anchor_exclude_signals
            _saved_assumptions = user_task.anchor_assumptions
            user_task = await _llm_repair(prompt_text, first_pass, report)
            if _saved_anchors:
                user_task.intent_anchors = _saved_anchors
                user_task.anchor_exclude_signals = _saved_excl
                user_task.anchor_assumptions = _saved_assumptions
            tokens_used = 0  # token tracking happens inside ChatOpenAI
        elif report.should_call_second_pass:
            extraction_mode = "gliner2_skip_repair_low_difficulty"
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

        # LLM fallback for anchor resolution on high-difficulty tasks with
        # many unrecognized technologies (only if fast path yielded nothing).
        if (
            settings.anchor_resolution_enabled
            and settings.anchor_llm_fallback_enabled
            and not user_task.intent_anchors
            and difficulty >= 0.7
        ):
            from .frame_normalizer import resolve_intent_anchors_with_llm_fallback

            try:
                llm_anchors, llm_excl, llm_assumptions, llm_conflicts = await resolve_intent_anchors_with_llm_fallback(
                    user_task,
                    difficulty,
                    run_id=state.get("run_id", ""),
                )
                if llm_anchors:
                    user_task.intent_anchors = llm_anchors
                    user_task.anchor_exclude_signals = llm_excl
                    user_task.anchor_assumptions = llm_assumptions
                if llm_conflicts:
                    unresolved_conflicts = llm_conflicts
            except Exception:
                logger.warning("anchor_llm_fallback_failed", exc_info=True)

        user_task_dict = user_task.model_dump()
        latency = (time.monotonic() - start) * 1000

        logger.info(
            "frame_extractor_complete",
            extra={
                "mode": extraction_mode,
                "deliverables": len(user_task.deliverables),
                "requirements": len(user_task.explicit_requirements),
                "constraints": len(user_task.constraints),
                "negative_constraints": len(user_task.negative_constraints),
                "deliverables_extracted": len(user_task.deliverables),
                "constraints_extracted": len(user_task.constraints),
                "gliner_used": True,
                "domain_tags": user_task.domain_tags,
                "format": user_task.requested_format,
                "needs_web": user_task.needs_web,
                "decision_required": user_task.decision_required,
                "latency_ms": round(latency),
            },
        )

        _frame_cache_put(task_description, user_task_dict)

        result: dict[str, Any] = {
            "user_task": user_task_dict,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"{extraction_mode}: {len(user_task.deliverables)} deliverables, "
                    f"{len(user_task.explicit_requirements)} requirements",
                    confidence=0.9,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                    tokens_used=tokens_used,
                )
            ],
        }
        if unresolved_conflicts:
            result["unresolved_conflicts"] = unresolved_conflicts

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
