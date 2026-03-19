"""Frame Extractor — 2-stage pipeline for structured task decomposition.

Stage 1 (parallel):
  - LLM semantic unit extraction: segment user prompt into atomic FrameUnits
  - GLiNER2 microservice: fast NER for technology/domain enrichment

Stage 2 (deterministic):
  - Link units into a TaskFrame: bind constraints to tasks, detect globals,
    merge GLiNER2 enrichment, build topic frame and domain profile.

Output: TaskFrame dict written to state["task_frame"], consumed by all
downstream nodes.
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
from ..schemas import (
    DomainProfile,
    DomainWeight,
    EvidenceSpec,
    FrameUnit,
    ScopedTask,
    TaskFrame,
    safe_parse_json,
)
from ..state import NodeOutcome, NodeTrace
from ..synesis_tracer import get_synesis_tracer

logger = logging.getLogger("synesis.frame_extractor")

# ---------------------------------------------------------------------------
# Frame extraction cache — caches full TaskFrame dict by task_description hash
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
    _frame_cache[key] = (0.0, result)
    record_frame_cache_size(len(_frame_cache))


# ---------------------------------------------------------------------------
# Stage 1a: LLM semantic unit extraction
# ---------------------------------------------------------------------------

_SEGMENT_SYSTEM = """\
You are a semantic segmenter. Break the user prompt into atomic units.
Each unit expresses exactly one intent, requirement, constraint, or fact.
Classify each as: goal, task, constraint, context, dependency, evaluation.

Rules:
- goal: the high-level outcome the user wants
- task: a discrete deliverable or section the user expects
- constraint: a limit, restriction, rule, or format requirement
- context: background information, team size, timeline, technology stack
- dependency: ordering between tasks ("X depends on Y", "before doing Z")
- evaluation: success criteria, quality instructions, how to judge the result

Do NOT merge unrelated ideas into one unit.
Do NOT infer requirements the user never stated.
Do NOT paraphrase — preserve the user's language.
If a sentence contains multiple distinct requirements, split them.

Output JSON: {"units": [{"text": "...", "type": "goal|task|constraint|context|dependency|evaluation"}]}"""


async def _llm_segment(raw_text: str) -> list[FrameUnit]:
    """Call the router model to segment the prompt into FrameUnits."""
    _kw: dict[str, Any] = {}
    _eb: dict[str, Any] = {}
    if settings.guided_json_enabled:
        _eb["chat_template_kwargs"] = {"enable_thinking": False}
    else:
        _kw["response_format"] = {"type": "json_object"}
    _eb.update(reasoning_body("none"))
    if _eb:
        _kw["extra_body"] = _eb

    llm = ChatOpenAI(
        base_url=settings.router_model_url,
        api_key="not-needed",
        model=settings.router_model_name,
        temperature=0,
        max_completion_tokens=settings.frame_repair_max_tokens,
        streaming=False,
        use_responses_api=False,
        model_kwargs=_kw if _kw else None,
        http_client=get_llm_http_client(uds_path=settings.router_model_uds or None),
    )

    result = await llm.ainvoke([
        SystemMessage(content=_SEGMENT_SYSTEM),
        HumanMessage(content=raw_text),
    ])

    try:
        raw = safe_parse_json(result.content or "")
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("llm_segment_parse_failed", extra={"error": str(exc)[:200]})
        raise

    units: list[FrameUnit] = []
    for item in raw.get("units", []):
        text = (item.get("text") or "").strip()
        unit_type = (item.get("type") or "context").lower()
        if unit_type not in ("goal", "task", "constraint", "context", "dependency", "evaluation"):
            unit_type = "context"
        if text:
            units.append(FrameUnit(text=text, unit_type=unit_type))  # type: ignore[arg-type]

    return units


# ---------------------------------------------------------------------------
# Stage 1b: GLiNER2 enrichment (technology + domain NER)
# ---------------------------------------------------------------------------


def _gliner_enrichment(prompt_text: str) -> dict[str, Any]:
    """Run GLiNER2 and extract technology/domain/format signals."""
    client = get_gliner_client()
    first_pass = client.extract(prompt_text[:5000])

    technologies = list({c.text for c in first_pass.technologies})
    domain_tags = list({c.text for c in first_pass.domain_tags})
    formats = [c.text.lower() for c in first_pass.formats]

    needs_web = False
    classification = first_pass.task_classification

    return {
        "technologies": technologies,
        "domain_tags": domain_tags,
        "formats": formats,
        "classification": classification,
        "needs_web": needs_web,
        "raw_frame": first_pass,
    }


# ---------------------------------------------------------------------------
# Stage 2: Deterministic semantic linking
# ---------------------------------------------------------------------------

_GLOBAL_CONSTRAINT_SIGNALS = re.compile(
    r"\b(all|every|each|always|never|entire|whole|throughout)\b",
    re.IGNORECASE,
)

_EVIDENCE_SIGNALS = re.compile(
    r"\b(cite|evidence|sources?|references?|RAG|retriev|ground)\b",
    re.IGNORECASE,
)

_ARTIFACT_TYPE_RE = re.compile(
    r"\b(json|yaml|yml|xml|csv|toml|code|diagram|mermaid|table|sql)\b",
    re.IGNORECASE,
)

_NEGATIVE_RE = re.compile(
    r"^(do not|don't|never|avoid|no |must not|should not|cannot)\b",
    re.IGNORECASE,
)

_FORMAT_PATTERNS = {
    "table": re.compile(r"\b(?:table|matrix|grid|spreadsheet)\b", re.IGNORECASE),
    "code": re.compile(r"\b(?:code|snippet|script|implementation|function|class)\b", re.IGNORECASE),
    "diagram": re.compile(r"\b(?:diagram|chart|graph|flowchart|mermaid|uml)\b", re.IGNORECASE),
    "bullet_list": re.compile(r"\b(?:bullet|list|numbered|enumerat)\b", re.IGNORECASE),
    "json": re.compile(r"\bjson\b", re.IGNORECASE),
    "yaml": re.compile(r"\b(?:yaml|yml)\b", re.IGNORECASE),
    "xml": re.compile(r"\b(?:xml|xhtml)\b", re.IGNORECASE),
    "csv": re.compile(r"\b(?:csv|tsv)\b", re.IGNORECASE),
    "toml": re.compile(r"\btoml\b", re.IGNORECASE),
}

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

_SCHEMA_FIELD_RE = re.compile(r'"(\w+)"\s*:', re.MULTILINE)

_STRUCTURED_FORMATS = frozenset({"json", "yaml", "xml", "csv", "toml"})

_PERSONA_PATTERNS: list[tuple[re.Pattern[str], str, bool]] = [
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

_PERSONA_STOPWORDS = frozenset({
    "the", "a", "an", "it", "this", "that", "my", "your", "me", "way",
    "much", "more", "well", "also", "very", "how", "what", "why", "can",
    "do", "should", "would", "could", "will", "following", "possible",
})


def _detect_persona(raw_text: str) -> str:
    for pattern, template, skip_check in _PERSONA_PATTERNS:
        match = pattern.search(raw_text)
        if match:
            captured = match.group(1).strip().lower()
            if skip_check or (captured not in _PERSONA_STOPWORDS and len(captured) > 1):
                persona = template.format(captured)[:40]
                return persona
    return ""


def _detect_format(raw_text: str, gliner_formats: list[str]) -> tuple[str, list[str]]:
    """Detect requested_format and embedded_formats from text and GLiNER signals."""
    requested_format = "prose"
    embedded_formats: list[str] = []

    if gliner_formats:
        fmt_text = gliner_formats[0].lower().strip()
        for fmt, pattern in _FORMAT_PATTERNS.items():
            if pattern.search(fmt_text):
                requested_format = fmt
                break
        else:
            requested_format = fmt_text
    else:
        for fmt, pattern in _FORMAT_PATTERNS.items():
            if pattern.search(raw_text):
                if fmt in _STRUCTURED_FORMATS:
                    if _PURE_STRUCTURED_RE.search(raw_text):
                        requested_format = fmt
                    else:
                        embedded_formats.append(fmt)
                else:
                    requested_format = fmt
                break

    if requested_format not in _STRUCTURED_FORMATS:
        for fmt in _STRUCTURED_FORMATS:
            if fmt not in embedded_formats and _FORMAT_PATTERNS.get(fmt, re.compile("")).search(raw_text):
                if not _PURE_STRUCTURED_RE.search(raw_text):
                    embedded_formats.append(fmt)
    embedded_formats = list(dict.fromkeys(embedded_formats))

    return requested_format, embedded_formats


def _detect_output_schema(raw_text: str, requested_format: str, embedded_formats: list[str]) -> list[str]:
    """Extract output_schema field names from JSON-like blocks in the prompt."""
    output_schema: list[str] = []
    if requested_format in _STRUCTURED_FORMATS or embedded_formats:
        for brace_block in re.findall(r"\{[^{}]{10,}\}", raw_text):
            fields = _SCHEMA_FIELD_RE.findall(brace_block)
            output_schema.extend(f for f in fields if f not in output_schema)
    return output_schema


def link_units_to_frame(
    units: list[FrameUnit],
    raw_text: str,
    gliner: dict[str, Any],
    *,
    domain_ref_counts: dict[str, int] | None = None,
    active_domain_refs: list[str] | None = None,
) -> TaskFrame:
    """Deterministic Stage 2: bind units into a TaskFrame with scoped constraints."""

    goals: list[str] = []
    tasks: list[ScopedTask] = []
    global_constraints: list[str] = []
    negative_constraints: list[str] = []
    context_items: list[str] = []
    evaluation: list[str] = []
    evidence = EvidenceSpec()

    task_counter = 0
    current_task: ScopedTask | None = None

    for unit in units:
        text = unit.text.strip()
        if not text:
            continue

        if unit.unit_type == "goal":
            goals.append(text)

        elif unit.unit_type == "task":
            task_id = f"task_{task_counter}"
            task_counter += 1
            artifacts = [m.lower() for m in _ARTIFACT_TYPE_RE.findall(text)]
            current_task = ScopedTask(
                id=task_id,
                description=text,
                artifacts=list(dict.fromkeys(artifacts)),
            )
            tasks.append(current_task)

        elif unit.unit_type == "constraint":
            if _NEGATIVE_RE.match(text):
                negative_constraints.append(text)
            elif current_task is None or _GLOBAL_CONSTRAINT_SIGNALS.search(text):
                global_constraints.append(text)
            else:
                artifact_mentions = [m.lower() for m in _ARTIFACT_TYPE_RE.findall(text)]
                if artifact_mentions:
                    bound = False
                    for t in tasks:
                        if set(artifact_mentions) & set(t.artifacts):
                            t.constraints.append(text)
                            bound = True
                    if not bound:
                        current_task.constraints.append(text)
                else:
                    current_task.constraints.append(text)

        elif unit.unit_type == "context":
            context_items.append(text)

        elif unit.unit_type == "dependency":
            if current_task:
                current_task.dependencies.append(text)
            else:
                context_items.append(text)

        elif unit.unit_type == "evaluation":
            evaluation.append(text)

        if _EVIDENCE_SIGNALS.search(text):
            evidence.required = True

    main_question = goals[0] if goals else ""
    if not main_question and tasks:
        main_question = tasks[0].description
    if not main_question:
        first_line = raw_text.strip().split("\n")[0].strip()[:300]
        main_question = first_line

    gliner_technologies = gliner.get("technologies") or []
    gliner_domain_tags = gliner.get("domain_tags") or []
    gliner_formats = gliner.get("formats") or []

    requested_format, embedded_formats = _detect_format(raw_text, gliner_formats)
    output_schema = _detect_output_schema(raw_text, requested_format, embedded_formats)
    persona = _detect_persona(raw_text)

    domain_tags = list(dict.fromkeys(gliner_domain_tags))
    if not domain_tags and (domain_ref_counts or active_domain_refs):
        for tag in (active_domain_refs or []):
            if tag and tag not in ("generic", "general"):
                domain_tags.append(tag)

    technologies = list(dict.fromkeys(gliner_technologies))

    frame = TaskFrame(
        goals=goals,
        tasks=tasks,
        global_constraints=global_constraints,
        negative_constraints=negative_constraints,
        context=context_items,
        evaluation=evaluation,
        evidence=evidence,
        main_question=main_question,
        requested_format=requested_format,
        output_schema=output_schema,
        embedded_formats=embedded_formats,
        domain_tags=domain_tags,
        technologies=technologies,
        needs_web=False,
        persona=persona,
        output_controls={},
    )

    frame.topic_frame = _build_topic_frame(frame)

    profile = _build_domain_profile(
        frame,
        domain_ref_counts=domain_ref_counts,
        active_domain_refs=active_domain_refs,
    )
    frame.domain_profile = profile

    return frame


def _build_domain_profile(
    frame: TaskFrame,
    *,
    domain_ref_counts: dict[str, int] | None = None,
    active_domain_refs: list[str] | None = None,
) -> DomainProfile:
    """Build a weighted domain profile from the TaskFrame.

    Ref: Klein et al. (2007) Data-Frame sensemaking.
    Ref: Snowden & Boone (2007) Cynefin — focused/composite/diffuse.
    """
    if not settings.domain_profiling_enabled:
        return DomainProfile()

    counts = dict(domain_ref_counts or {})
    refs = list(active_domain_refs or [])

    if not counts and not refs:
        for tag in frame.domain_tags:
            tag_l = tag.lower().strip()
            if tag_l:
                counts[tag_l] = counts.get(tag_l, 0) + 1
                if tag_l not in refs:
                    refs.append(tag_l)

    if not counts:
        return DomainProfile(frame_coherence="diffuse", confidence=0.2)

    raw_weights: dict[str, float] = {d: float(c) for d, c in counts.items()}

    task_text = " ".join(t.description for t in frame.tasks).lower()
    all_constraints = frame.global_constraints[:]
    for t in frame.tasks:
        all_constraints.extend(t.constraints)
    constraint_text = " ".join(all_constraints).lower()
    tech_lower = [t.lower() for t in frame.technologies]
    roles: dict[str, str] = {}

    from ..cohesion import get_conflict_groups

    conflict_groups = get_conflict_groups()

    tech_to_domain: dict[str, str] = {}
    for group_name, members in conflict_groups.items():
        for t in tech_lower:
            if t in members:
                tech_to_domain[t] = group_name

    for t in tech_lower:
        if t in task_text:
            domain = tech_to_domain.get(t, "")
            if domain and domain in raw_weights:
                raw_weights[domain] *= 1.5
                roles.setdefault(domain, "subject")
        elif t in constraint_text:
            domain = tech_to_domain.get(t, "")
            if domain:
                roles.setdefault(domain, "tool")

    for domain in raw_weights:
        roles.setdefault(domain, "context")

    max_w = max(raw_weights.values()) if raw_weights else 1.0
    if max_w <= 0:
        max_w = 1.0
    normalized = {d: w / max_w for d, w in raw_weights.items()}

    domain_weights: list[DomainWeight] = []
    sources_map: dict[str, list[str]] = {}
    for domain in normalized:
        src: list[str] = []
        if domain in (domain_ref_counts or {}):
            src.append("scoring_engine")
        if domain in [t.lower().strip() for t in frame.domain_tags]:
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
        },
    )

    return profile


def _build_topic_frame(frame: TaskFrame) -> str:
    """Synthesize a conceptual search frame from question + tasks + domain tags."""
    parts: list[str] = []

    mq = (frame.main_question or "").strip()
    if mq:
        parts.append(mq)

    for t in frame.tasks or []:
        d = t.description.strip()
        if d and d.lower() != mq.lower():
            parts.append(d)

    topic = "; ".join(parts)

    domain = [t.strip() for t in (frame.domain_tags or [])[:4] if t.strip()]
    if domain:
        topic += f" [{', '.join(domain)}]"

    return topic[:1000]


# ---------------------------------------------------------------------------
# Deterministic fallback (no LLM available)
# ---------------------------------------------------------------------------


def _build_deterministic_frame(
    task_description: str,
    taxonomy_metadata: dict[str, Any],
    explicit_deliverables: int,
) -> dict[str, Any]:
    """Build a TaskFrame from prompt text without external service calls."""
    domain = taxonomy_metadata.get("taxonomy_key", "general")

    first_sentence = task_description.split("\n")[0].strip()[:200]
    goals = [first_sentence] if first_sentence else []

    frame = TaskFrame(
        goals=goals,
        main_question=first_sentence,
        domain_tags=[domain] if domain and domain not in ("generic", "general") else [],
        requested_format="prose",
    )

    logger.info(
        "deterministic_frame_built",
        extra={
            "tasks": len(frame.tasks),
            "goals": len(frame.goals),
        },
    )

    return frame.model_dump()


# ---------------------------------------------------------------------------
# Main node
# ---------------------------------------------------------------------------


async def frame_extractor_node(state: dict[str, Any]) -> dict[str, Any]:
    """Extract a TaskFrame from the user prompt via the 2-stage pipeline.

    Stage 1 (parallel): LLM segmentation + GLiNER2 enrichment
    Stage 2 (deterministic): Semantic linking into TaskFrame

    Trivial prompts (difficulty < 0.15) skip all stages and get a deterministic frame.
    """
    start = time.monotonic()
    node_name = "frame_extractor"

    task_description = state.get("task_description", "")
    difficulty = state.get("difficulty", 0.5)
    taxonomy_metadata = state.get("taxonomy_metadata") or {}
    explicit_deliverables = state.get("explicit_deliverables", 0)

    if difficulty < 0.15 or not task_description.strip():
        task_frame = _build_deterministic_frame(task_description, taxonomy_metadata, explicit_deliverables)
        latency = (time.monotonic() - start) * 1000
        logger.info(
            "frame_extractor_deterministic",
            extra={
                "difficulty": round(difficulty, 2),
                "latency_ms": round(latency),
                "tasks_extracted": len((task_frame or {}).get("tasks", [])),
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
            "task_frame": task_frame,
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
                        "cached_tasks": len(cached_frame.get("tasks", [])),
                    },
                },
            )
        return {
            "task_frame": cached_frame,
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
        llm_coro = _llm_segment(task_description)
        gliner_coro = asyncio.to_thread(_gliner_enrichment, task_description)
        units, gliner = await asyncio.gather(llm_coro, gliner_coro)

        stage1_latency = (time.monotonic() - start) * 1000
        logger.info(
            "frame_stage1_complete",
            extra={
                "llm_units": len(units),
                "gliner_technologies": len(gliner.get("technologies", [])),
                "gliner_domains": len(gliner.get("domain_tags", [])),
                "latency_ms": round(stage1_latency),
            },
        )

        task_frame = link_units_to_frame(
            units,
            task_description,
            gliner,
            domain_ref_counts=state.get("domain_ref_counts"),
            active_domain_refs=state.get("active_domain_refs"),
        )

        if not task_frame.domain_tags:
            tax_key = taxonomy_metadata.get("taxonomy_key", "")
            if tax_key and tax_key not in ("generic", "general"):
                task_frame.domain_tags = [tax_key]

        task_frame_dict = task_frame.model_dump()
        latency = (time.monotonic() - start) * 1000

        logger.info(
            "frame_extractor_complete",
            extra={
                "mode": "llm_segment_plus_gliner",
                "goals": len(task_frame.goals),
                "tasks": len(task_frame.tasks),
                "global_constraints": len(task_frame.global_constraints),
                "negative_constraints": len(task_frame.negative_constraints),
                "evaluation": len(task_frame.evaluation),
                "gliner_used": True,
                "domain_tags": task_frame.domain_tags,
                "format": task_frame.requested_format,
                "needs_web": task_frame.needs_web,
                "latency_ms": round(latency),
            },
        )

        _frame_cache_put(task_description, task_frame_dict)

        _tracer = get_synesis_tracer()
        if _tracer:
            _units_snapshot = [
                {"text": u.text[:100], "type": u.unit_type}
                for u in units[:30]
            ]
            _tasks_snapshot = [
                {
                    "id": t.id,
                    "description": t.description[:100],
                    "constraints": t.constraints[:5],
                    "artifacts": t.artifacts,
                    "sub_requirements": t.sub_requirements[:5],
                }
                for t in task_frame.tasks[:15]
            ]
            _tracer.annotate_span(
                "entry_pipeline",
                {
                    "frame_extraction": {
                        "path": "llm_segment_plus_gliner",
                        "stage1_latency_ms": round(stage1_latency, 1),
                        "total_latency_ms": round(latency, 1),
                        "prompt_snippet": task_description[:300],
                        "llm_units": _units_snapshot,
                        "gliner_enrichment": {
                            "technologies": gliner.get("technologies", [])[:10],
                            "domain_tags": gliner.get("domain_tags", [])[:10],
                            "formats": gliner.get("formats", [])[:5],
                        },
                        "final_frame": {
                            "main_question": task_frame.main_question[:200],
                            "goals": task_frame.goals[:10],
                            "tasks": _tasks_snapshot,
                            "global_constraints": task_frame.global_constraints[:10],
                            "negative_constraints": task_frame.negative_constraints[:10],
                            "evaluation": task_frame.evaluation[:10],
                            "technologies": task_frame.technologies[:10],
                            "domain_tags": task_frame.domain_tags,
                            "requested_format": task_frame.requested_format,
                            "embedded_formats": task_frame.embedded_formats,
                            "needs_web": task_frame.needs_web,
                        },
                    },
                },
            )

        result: dict[str, Any] = {
            "task_frame": task_frame_dict,
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"llm_segment_plus_gliner: {len(task_frame.goals)} goals, "
                    f"{len(task_frame.tasks)} tasks, "
                    f"{len(task_frame.global_constraints)} global constraints",
                    confidence=0.9,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                )
            ],
        }

        return result

    except Exception as e:
        logger.warning("frame_extractor_failed error=%s, using deterministic fallback", e)
        task_frame = _build_deterministic_frame(task_description, taxonomy_metadata, explicit_deliverables)
        latency = (time.monotonic() - start) * 1000
        return {
            "task_frame": task_frame,
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
