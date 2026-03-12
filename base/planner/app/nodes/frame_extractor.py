"""Frame Extractor — 3-stage pipeline for structured task decomposition.

Stage 1: GLiNER2 microservice extracts raw spans (entities + classification)
Stage 2: Deterministic normalizer deduplicates, reclassifies, scores confidence
Stage 3: LLM repair — invoked ONLY when Stage 2 flags missing/conflicting fields

Output: UserTask dict written to state["user_task"], consumed by all downstream nodes.
"""

from __future__ import annotations

import asyncio
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
    llm = ChatOpenAI(
        base_url=settings.planner_model_url,
        api_key="not-needed",
        model=settings.planner_model_name,
        temperature=0.1,
        max_completion_tokens=1024,
        streaming=False,
        use_responses_api=False,
        model_kwargs={"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
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

        # Stage 2: Deterministic normalization
        user_task, report = normalize_frame(first_pass, prompt_text)

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

        # Stage 3: LLM repair (only if needed)
        tokens_used = 0
        extraction_mode = "gliner2_only"
        if report.should_call_second_pass:
            extraction_mode = "gliner2_plus_llm_repair"
            user_task = await _llm_repair(prompt_text, first_pass, report)
            tokens_used = 0  # token tracking happens inside ChatOpenAI

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

        return {
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
