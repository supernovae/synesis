"""Fast Plan Gate — deterministic validation immediately after the Planner.

Validates the plan against the user's frame (deliverables, format, schema,
constraints) *before* evidence retrieval. Catches structural mismatches early
so the system doesn't burn retrieval+writing+critic cycles on a doomed plan.

All checks are pure-Python (<5ms) except the optional shallow coherence
classification which makes a single small-model LLM call (~200ms).
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from ..config import reasoning_body, settings
from ..state import NodeOutcome, NodeTrace
from ..synesis_tracer import get_synesis_tracer

logger = logging.getLogger("synesis.plan_gate")

_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
_DOC_REF_RE = re.compile(
    r"\b(?:according to|as described in|per|see|ref(?:erence)?:?)\s+[\"']?[A-Z]",
    re.IGNORECASE,
)
_EVIDENCE_CITE_RE = re.compile(r"\[(?:source|ref|doc|evidence)\s*\d", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Individual checks — each returns a list of error strings (empty = pass)
# ---------------------------------------------------------------------------


def _check_plan_nonempty(steps: list[dict[str, Any]]) -> list[str]:
    if not steps:
        return ["plan_empty: planner produced zero steps"]
    return []


def _check_step_quality(steps: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    for s in steps:
        action = (s.get("action") or "").strip()
        if len(action) < 10:
            errors.append(
                f"step_trivial: step {s.get('id', '?')} action is too short ({len(action)} chars): '{action[:30]}'"
            )
    return errors


def _check_deliverable_coverage(
    steps: list[dict[str, Any]],
    deliverables: list[str],
    deliverable_details: list[dict[str, Any]] | None = None,
) -> list[str]:
    if not deliverables:
        return []

    errors: list[str] = []
    all_ids = set(range(len(deliverables)))
    covered: set[int] = set()
    has_mapping = False

    # Build per-step action text index for sub-requirement checking
    step_actions_by_deliverable: dict[int, str] = {}
    for s in steps:
        d_ids = s.get("deliverable_ids") or []
        if d_ids:
            has_mapping = True
            for x in d_ids:
                if isinstance(x, (int, float)):
                    did = int(x)
                    covered.add(did)
                    step_actions_by_deliverable.setdefault(did, "")
                    step_actions_by_deliverable[did] += " " + (s.get("action") or "").lower()

    if has_mapping:
        missing_ids = sorted(all_ids - covered)
        if missing_ids:
            names = [deliverables[i] for i in missing_ids if i < len(deliverables)]
            errors.append(
                f"deliverable_uncovered: {len(missing_ids)} deliverable(s) not mapped to any plan step: {names[:5]}"
            )
    else:
        actions_text = " ".join((s.get("action") or "").lower() for s in steps)
        uncovered: list[str] = []
        for d in deliverables:
            words = [w for w in d.lower().split() if len(w) > 3]
            if not words:
                continue
            hits = sum(1 for w in words if w in actions_text)
            if hits / len(words) < 0.5:
                uncovered.append(d)

        if uncovered:
            errors.append(
                f"deliverable_uncovered: {len(uncovered)} deliverable(s) not addressed "
                f"in plan actions (keyword fallback): {uncovered[:5]}"
            )

    # Sub-requirement coverage: check that each deliverable's sub-requirements
    # have at least 30% keyword presence in the mapped plan steps.
    if deliverable_details and has_mapping:
        for i, dd in enumerate(deliverable_details):
            if i not in step_actions_by_deliverable:
                continue
            sub_reqs = (dd.get("sub_requirements") or []) if isinstance(dd, dict) else getattr(dd, "sub_requirements", [])
            if len(sub_reqs) < 2:
                continue
            action_text = step_actions_by_deliverable[i]
            missed_reqs: list[str] = []
            for sr in sub_reqs:
                words = [w for w in sr.lower().split() if len(w) > 3]
                if not words:
                    continue
                hits = sum(1 for w in words if w in action_text)
                if hits / len(words) < 0.3:
                    missed_reqs.append(sr)
            title = (dd.get("title") or deliverables[i]) if isinstance(dd, dict) else getattr(dd, "title", deliverables[i])
            if len(missed_reqs) > len(sub_reqs) * 0.5:
                errors.append(
                    f"subreq_gap: deliverable '{title}' has {len(missed_reqs)}/{len(sub_reqs)} "
                    f"sub-requirements not addressed in plan steps: {missed_reqs[:3]}"
                )

    return errors


def _check_format_alignment(
    steps: list[dict[str, Any]],
    requested_format: str,
) -> list[str]:
    from ..schemas import STRUCTURED_FORMATS

    if requested_format not in STRUCTURED_FORMATS:
        return []

    actions_text = " ".join((s.get("action") or "").lower() for s in steps)
    fmt_lower = requested_format.lower()

    if fmt_lower in actions_text or "output" in actions_text or "structured" in actions_text:
        return []

    return [
        f"format_blind: plan does not reference the required output format "
        f"({requested_format.upper()}). No step mentions '{fmt_lower}', 'output', "
        f"or 'structured' — the writer will likely produce markdown instead."
    ]


def _check_schema_field_mapping(
    steps: list[dict[str, Any]],
    output_schema: list[str],
) -> list[str]:
    if not output_schema:
        return []

    actions_text = " ".join((s.get("action") or "").lower() for s in steps)
    missing = [f for f in output_schema if f.lower() not in actions_text]

    if len(missing) > len(output_schema) * 0.5:
        return [
            f"schema_gap: {len(missing)}/{len(output_schema)} required schema fields "
            f"not referenced in any plan step: {missing[:8]}"
        ]
    return []


def _check_hallucination_guard(
    steps: list[dict[str, Any]],
    has_evidence: bool,
) -> list[str]:
    if has_evidence:
        return []

    errors: list[str] = []
    for s in steps:
        action = s.get("action") or ""
        if _URL_RE.search(action):
            errors.append(
                f"phantom_url: step {s.get('id', '?')} references a URL but no evidence has been retrieved yet"
            )
        if _DOC_REF_RE.search(action) or _EVIDENCE_CITE_RE.search(action):
            errors.append(
                f"phantom_citation: step {s.get('id', '?')} cites a document/source "
                f"but no evidence has been retrieved yet"
            )
    return errors


def _check_constraint_coverage(
    steps: list[dict[str, Any]],
    constraints: list[str],
) -> list[str]:
    if not constraints or len(constraints) < 2:
        return []

    actions_text = " ".join((s.get("action") or "").lower() for s in steps)
    unaddressed: list[str] = []

    for c in constraints:
        words = [w for w in c.lower().split() if len(w) > 3]
        if not words:
            continue
        hits = sum(1 for w in words if w in actions_text)
        if hits / len(words) < 0.3:
            unaddressed.append(c)

    if len(unaddressed) > len(constraints) * 0.6:
        return [
            f"constraints_ignored: {len(unaddressed)}/{len(constraints)} constraints "
            f"have no keyword presence in plan steps: {unaddressed[:4]}"
        ]
    return []


async def _shallow_coherence_check(
    steps: list[dict[str, Any]],
    task_description: str,
    deliverables: list[str],
) -> list[str]:
    """Optional small-LLM yes/no classification. Kept short and constrained."""
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_openai import ChatOpenAI

    from ..llm_telemetry import get_llm_http_client

    _pg_kw: dict[str, Any] = {"response_format": {"type": "json_object"}}
    _pg_rb = reasoning_body(settings.router_reasoning_effort)
    if _pg_rb:
        _pg_kw["extra_body"] = _pg_rb
    llm = ChatOpenAI(
        base_url=settings.router_model_url,
        api_key="not-needed",
        model=settings.router_model_name,
        temperature=0,
        max_completion_tokens=1024,
        streaming=False,
        use_responses_api=False,
        http_client=get_llm_http_client(uds_path=settings.router_model_uds or None),
        model_kwargs=_pg_kw,
    )

    plan_summary = "\n".join(f"  Step {s.get('id', i)}: {(s.get('action') or '')[:120]}" for i, s in enumerate(steps))
    deliverable_list = ", ".join(deliverables[:10]) if deliverables else "(none)"

    system = (
        "You are a plan validator. Reply JSON only: "
        '{"match": true} or {"match": false, "mismatches": ["short reason 1", ...]}\n'
        "Do NOT rewrite the plan. Do NOT reason step by step. Just classify."
    )
    prompt = (
        f"User request summary: {task_description[:3000]}\n"
        f"Deliverables: {deliverable_list}\n\n"
        f"Plan steps:\n{plan_summary}\n\n"
        "Does the plan adequately address the user's request and deliverables?"
    )

    try:
        resp = await llm.ainvoke(
            [
                SystemMessage(content=system),
                HumanMessage(content=prompt),
            ]
        )
        import json

        data = json.loads(resp.content or "{}")
        if not data.get("match", True):
            mismatches = data.get("mismatches") or ["plan does not match user request"]
            return [f"coherence_mismatch: {m}" for m in mismatches[:3]]
    except Exception as e:
        logger.warning("plan_gate_coherence_check_failed", extra={"error": str(e)[:200]})

    return []


# ---------------------------------------------------------------------------
# Gate node
# ---------------------------------------------------------------------------


async def plan_gate_node(state: dict[str, Any]) -> dict[str, Any]:
    """Validate the planner's output before evidence retrieval.

    Runs deterministic structural checks and optionally a shallow LLM
    coherence classification. Returns gate results in state for routing.
    """
    start = time.monotonic()
    node_name = "plan_gate"

    plan = state.get("execution_plan") or {}
    steps = plan.get("steps") or []
    task_frame = state.get("task_frame") or {}
    deliverables = [t.get("description", "") for t in (task_frame.get("tasks") or [])]
    requested_format = task_frame.get("requested_format", "prose")
    output_schema = task_frame.get("output_schema") or []
    constraints = task_frame.get("global_constraints") or []
    has_evidence = bool(state.get("evidence_packets"))
    difficulty = state.get("difficulty", 0.5)

    # Skip gate for trivial tasks and clarification/approval scenarios
    if state.get("clarification_question") or state.get("plan_pending_approval"):
        latency = (time.monotonic() - start) * 1000
        return {
            "plan_gate_passed": True,
            "plan_gate_errors": [],
            "plan_gate_feedback": "",
            "current_node": node_name,
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning="Skipped: clarification or approval pending",
                    confidence=1.0,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                )
            ],
        }

    deliverable_details = [
        {"title": t.get("description", ""), "sub_requirements": t.get("sub_requirements", []), "format_hint": t.get("format_hint", "")}
        for t in (task_frame.get("tasks") or [])
    ]

    # Collect errors from all deterministic checks
    errors: list[str] = []
    errors.extend(_check_plan_nonempty(steps))
    errors.extend(_check_step_quality(steps))
    errors.extend(_check_deliverable_coverage(steps, deliverables, deliverable_details))
    errors.extend(_check_format_alignment(steps, requested_format))
    errors.extend(_check_schema_field_mapping(steps, output_schema))
    errors.extend(_check_hallucination_guard(steps, has_evidence))
    errors.extend(_check_constraint_coverage(steps, constraints))

    checks_run = 7
    ran_coherence = False

    # Optional shallow coherence LLM check
    if (
        not errors
        and settings.plan_gate_coherence_enabled
        and difficulty >= settings.plan_gate_coherence_threshold
        and steps
    ):
        ran_coherence = True
        checks_run += 1
        task_desc = state.get("task_description") or task_frame.get("main_question") or ""
        errors.extend(await _shallow_coherence_check(steps, task_desc, deliverables))

    passed = not errors
    latency = (time.monotonic() - start) * 1000

    # Build human-readable feedback for planner retry
    feedback = ""
    if not passed:
        feedback_lines = ["Your previous plan failed validation:"]
        for e in errors:
            feedback_lines.append(f"  - {e}")
        feedback_lines.append(
            "Revise the plan to address ALL issues above. "
            "Ensure every deliverable is mapped, the output format is acknowledged, "
            "and no phantom citations appear."
        )
        feedback = "\n".join(feedback_lines)

    planner_error_count = state.get("planner_error_count", 0)
    if not passed:
        planner_error_count += 1

    log_extra = {
        "passed": passed,
        "errors": errors[:10],
        "checks_run": checks_run,
        "coherence_check": ran_coherence,
        "latency_ms": round(latency, 1),
        "planner_error_count": planner_error_count,
        "step_count": len(steps),
        "deliverable_count": len(deliverables),
        "requested_format": requested_format,
    }

    if passed:
        logger.info("plan_gate_passed", extra=log_extra)
    else:
        logger.warning("plan_gate_failed", extra=log_extra)

    trace = NodeTrace(
        node_name=node_name,
        reasoning=f"{'PASS' if passed else 'FAIL'}: {len(errors)} error(s)",
        assumptions=[],
        confidence=1.0 if passed else 0.0,
        outcome=NodeOutcome.SUCCESS if passed else NodeOutcome.ERROR,
        latency_ms=latency,
    )

    # Annotate trace span for visibility in admin UI
    _tracer = get_synesis_tracer()
    if _tracer:
        _tracer.record_phase_timing("plan_gate.total_ms", latency)
        _tracer.annotate_span(
            node_name,
            {
                "plan_gate": {
                    "passed": passed,
                    "errors": errors[:10],
                    "checks_run": checks_run,
                    "coherence_check": ran_coherence,
                    "latency_ms": round(latency, 1),
                },
            },
        )

    return {
        "plan_gate_passed": passed,
        "plan_gate_errors": errors,
        "plan_gate_feedback": feedback,
        "planner_error_count": planner_error_count,
        "current_node": node_name,
        "node_traces": [trace],
    }
