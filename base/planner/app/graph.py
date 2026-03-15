"""Synesis LangGraph -- the core orchestration loop.

All paths:
  [User] -> EntryPipeline (Classifier + Advisor || FrameExtractor) -> Router
  -> Planner -> Router -> Executor/Writer -> FinalScrubber -> Respond

The Router is the single retrieval orchestrator. No other node touches
retrieval backends (rag_client, web_search, unified_retrieval).

When critic_background=True (default), critic runs asynchronously after
the response is delivered. When inline, writer -> critic -> scrubber.
"""

from __future__ import annotations

import asyncio
import logging
import re
from functools import wraps
from typing import Any

from langgraph.graph import END, StateGraph

from .config import settings
from .contract_validator import (
    validate_citation_preservation,
    validate_critique_resolutions,
    validate_decision_drift,
    validate_required_sections,
    validate_style_compliance,
    validated_node,
)
from .nodes import (
    critic_node,
    entry_pipeline_node,
    executor_node,
    final_scrubber_node,
    patch_integrity_gate_node,
    planner_node,
    router_node,
    writer_node,
)
from .oscillation_detector import detect_oscillation
from .state import GraphState, NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.graph")


def with_telemetry_node(func):
    """Structured logging + optional OTel span for each graph node."""
    from synesis_telemetry import set_node, span

    @wraps(func)
    async def wrapper(state: dict[str, Any]) -> dict[str, Any]:
        import time

        node_name = func.__name__.replace("_node", "")
        set_node(node_name)
        start = time.monotonic()

        with span(node_name):
            coro_or_result = func(state)
            result = await coro_or_result if asyncio.iscoroutine(coro_or_result) else coro_or_result

        latency_ms = (time.monotonic() - start) * 1000
        traces = result.get("node_traces") or []
        if traces and hasattr(traces[-1], "latency_ms") and traces[-1].latency_ms > 0:
            latency_ms = traces[-1].latency_ms

        outcome = "success"
        if traces:
            last = traces[-1]
            outcome = getattr(last, "outcome", "success")
            if hasattr(outcome, "value"):
                outcome = outcome.value

        logger.info(
            "node_complete",
            extra={
                "node": node_name,
                "latency_ms": round(latency_ms, 1),
                "outcome": outcome,
                "next_node": result.get("next_node", ""),
            },
        )
        set_node("")
        return result

    return wrapper


def with_timeout(timeout_seconds: float):
    """Erlang-style timeout wrapper. Node either returns or gets killed.

    Handles both sync and async node functions: sync results are returned
    directly (no timeout needed — they already completed), async coroutines
    are guarded by asyncio.wait_for.
    """

    def decorator(func):
        @wraps(func)
        async def wrapper(state: dict[str, Any]) -> dict[str, Any]:
            try:
                result = func(state)
                if not asyncio.iscoroutine(result):
                    return result
                return await asyncio.wait_for(
                    result,
                    timeout=timeout_seconds,
                )
            except TimeoutError:
                node_name = func.__name__.replace("_node", "")
                logger.error("node_timeout", extra={"node": node_name, "timeout_seconds": timeout_seconds})
                return {
                    "current_node": node_name,
                    "next_node": "respond",
                    "error": f"Node '{node_name}' timed out after {timeout_seconds}s",
                    "generated_code": state.get("generated_code", ""),
                    "code_explanation": state.get("code_explanation", ""),
                    "patch_ops": state.get("patch_ops", []) or [],
                    "evidence_packets": state.get("evidence_packets", []) or [],
                    "retrieval_degraded": state.get("retrieval_degraded", False),
                    "retrieval_degradation_notes": state.get("retrieval_degradation_notes", ""),
                    "node_traces": [
                        NodeTrace(
                            node_name=node_name,
                            reasoning=f"Timeout after {timeout_seconds}s",
                            confidence=0.0,
                            outcome=NodeOutcome.TIMEOUT,
                            latency_ms=timeout_seconds * 1000,
                        )
                    ],
                }
            except asyncio.CancelledError:
                node_name = func.__name__.replace("_node", "")
                logger.warning("node_cancelled", extra={"node": node_name, "timeout_seconds": timeout_seconds})
                raise

        return wrapper

    return decorator


# ---------------------------------------------------------------------------
# Routing functions
# ---------------------------------------------------------------------------


def _is_text_only() -> bool:
    return settings.frontdoor_mode == "text_only"


def route_after_entry_pipeline(state: dict[str, Any]) -> str:
    """After entry pipeline -> router OR directly to writer.

    Trivial tasks (difficulty < 0.15) skip the router and planner entirely,
    going straight to the writer to answer from parametric knowledge.

    Easy tasks where the classifier set rag_mode=disabled (difficulty < 0.3,
    no plan required) also skip the router — there's nothing to retrieve, so
    the router adds only latency and memory overhead.

    In text_only front door mode, code tasks are never routed to executor;
    they use the writer path (which can emit fenced code blocks).
    """
    if state.get("pending_question_continue"):
        return "router"

    if state.get("message_origin") == "ui_helper":
        return "respond"

    text_only = _is_text_only()

    if state.get("task_is_trivial"):
        is_code = state.get("is_code_task", False)
        target = "executor" if (is_code and not text_only) else "writer"
        logger.info(
            "entry_pipeline_trivial_fast_path",
            extra={
                "target": target,
                "difficulty": state.get("difficulty", 0),
                "frontdoor_mode": settings.frontdoor_mode,
            },
        )
        return target

    # Easy tasks with no retrieval needed go straight to writer.
    # The entry classifier sets rag_mode="disabled" for difficulty < 0.3
    # (parametric knowledge only — code snippets, general questions, etc.).
    # Skipping the router avoids initializing the full retrieval stack.
    rag_mode = state.get("rag_mode", "normal")
    if rag_mode == "disabled" and not state.get("plan_required"):
        target = "writer"
        if not text_only and state.get("is_code_task", False):
            target = "executor"
        logger.info(
            "entry_pipeline_easy_no_retrieval",
            extra={
                "target": target,
                "difficulty": state.get("difficulty", 0),
                "rag_mode": rag_mode,
                "intent_class": state.get("intent_class", ""),
                "frontdoor_mode": settings.frontdoor_mode,
            },
        )
        return target

    return "router"


def route_after_router(state: dict[str, Any]) -> str:
    """Router sets next_node based on mode detection.

    In text_only mode, executor is never a valid target; redirect to writer.
    """
    if state.get("error"):
        return "respond"
    next_node = state.get("next_node", "planner")
    if _is_text_only() and next_node == "executor":
        next_node = "writer"
    if next_node in ("planner", "executor", "writer", "respond"):
        return next_node
    return "planner"


def route_after_planner(state: dict[str, Any]) -> str:
    """After planner: clarification, approval, evidence requests, or proceed to router for section evidence."""
    if state.get("clarification_question"):
        return "respond"
    if state.get("plan_pending_approval"):
        return "respond"

    planner_errors = state.get("planner_error_count", 0)
    has_plan = bool((state.get("execution_plan") or {}).get("steps"))

    if planner_errors >= 2 and has_plan:
        logger.warning(
            "planner_fallback_routing_to_writer",
            extra={"planner_errors": planner_errors},
        )
        return "router"

    if planner_errors >= 2 and not has_plan:
        logger.error(
            "planner_exhausted_no_plan",
            extra={"planner_errors": planner_errors},
        )
        return "respond"

    evidence_requests = state.get("evidence_requests") or []
    if evidence_requests:
        return "router"

    return "router"


def route_after_executor(state: dict[str, Any]) -> str:
    """Route after executor (code tasks).

    In text_only mode, executor should not be reached but as a safety net
    routes straight to respond and skips patch_integrity_gate.
    """
    if _is_text_only():
        return "respond"
    if state.get("needs_input_question"):
        return "respond"
    stop_reason = state.get("stop_reason", "")
    if stop_reason:
        return "respond"
    if not state.get("is_code_task", False):
        return "respond"
    return "patch_integrity_gate"


def route_after_writer(state: dict[str, Any]) -> str:
    """After writer: critic if difficulty warrants it, else scrubber.

    When critic_background is True, critic is skipped in the graph and
    fired as a background task from respond_node instead.  The user sees
    the response immediately; critic results are logged asynchronously.
    """
    if settings.critic_background:
        return "final_scrubber"
    difficulty = state.get("difficulty", 0.5)
    if difficulty < settings.critic_skip_below_difficulty:
        return "final_scrubber"
    return "critic"


def route_after_patch_integrity_gate(state: dict[str, Any]) -> str:
    """Gate pass -> critic; Gate fail -> router (for evidence re-retrieval)."""
    if not state.get("integrity_passed", True):
        return "router"
    return "critic"


def route_after_critic(state: dict[str, Any]) -> str:
    """Route after critic: router for refinement, scrubber for approval."""
    if state.get("error"):
        return "respond"

    osc_report = detect_oscillation(state)
    if osc_report.total_score > settings.oscillation_threshold:
        logger.warning(
            "oscillation_threshold_exceeded",
            extra={
                "total": round(osc_report.total_score, 2),
                "style": round(osc_report.style_score, 2),
                "decision": round(osc_report.decision_score, 2),
            },
        )
        return "final_scrubber"

    iteration = state.get("iteration_count", 0)
    max_iter = state.get("max_iterations", settings.max_iterations)

    approved = state.get("critic_approved", True)
    need_evidence = state.get("need_more_evidence", False)

    if (approved and not need_evidence) or iteration >= max_iter:
        return "final_scrubber"

    should_continue = state.get("critic_should_continue", False)
    if need_evidence:
        return "router"
    if not approved and should_continue:
        # Writing-quality rejections go directly to writer (bypass router).
        # Evidence gaps are handled above via need_evidence → router.
        return "writer"
    if state.get("critic_continue_reason") in ("blocked_external", "needs_input"):
        return "respond"

    return "respond"


# ---------------------------------------------------------------------------
# Text cleanup utilities (used by respond_node and writer pass)
# ---------------------------------------------------------------------------

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_TOULMIN_LABEL_RE = re.compile(r"^(CLAIM|GROUNDS|WARRANT|REBUTTAL|QUALIFIER)\s*:", re.MULTILINE)
_SELF_NARRATION_RE = re.compile(
    r"^(Okay,? (?:I need|let me|let's)|Let me (?:start|think|tackle)|"
    r"I think |I should |Wait, |Hmm,? |Now,? I need |"
    r"Putting it all together|I need to ).*?(?:\n\n|\Z)",
    re.MULTILINE | re.DOTALL,
)

_HEADING_DELIVERABLE_SUFFIX_RE = re.compile(
    r"^(#{1,3}\s+(?:Section:\s*)?)"
    r"(.+?)"
    r"\s*[—–\-]\s+"  # noqa: RUF001 — intentional en-dash match
    r"(?:outline|describe|explain|propose|list|give|state|provide|detail|cover|specify|discuss)\b"
    r".*$",
    re.MULTILINE | re.IGNORECASE,
)

_HEADING_SECTION_PREFIX_RE = re.compile(
    r"^(#{1,3})\s+Section:\s*",
    re.MULTILINE,
)

_FENCED_CODE_RE = re.compile(r"(```[^\n]*\n.*?```)", re.DOTALL)


def _clean_section_artifacts(text: str) -> str:
    """Strip model thinking blocks, Toulmin scaffolding labels, self-narration, and heading artifacts."""
    blocks: list[str] = []

    def _stash(m: re.Match) -> str:
        blocks.append(m.group(0))
        return f"\x00FENCED{len(blocks) - 1}\x00"

    text = _FENCED_CODE_RE.sub(_stash, text)
    text = _THINK_RE.sub("", text)
    text = _TOULMIN_LABEL_RE.sub("", text)
    text = _SELF_NARRATION_RE.sub("", text)
    text = _HEADING_DELIVERABLE_SUFFIX_RE.sub(r"\1\2", text)
    text = _HEADING_SECTION_PREFIX_RE.sub(r"\1 ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)

    for i, block in enumerate(blocks):
        text = text.replace(f"\x00FENCED{i}\x00", block)

    return text.strip()


# ---------------------------------------------------------------------------
# Writer pass (synthesis / polish)
# ---------------------------------------------------------------------------

_WRITER_SYSTEM = (
    "You are the Writer for Synesis. You receive assembled sections from "
    "specialist nodes (code, explanation, safety analysis, suggestions). "
    "Your job is to synthesize these into a single, coherent, well-structured "
    "response. Do not add information — only improve flow, tone, and structure. "
    "Preserve all code blocks and markdown formatting verbatim.\n\n"
    "CODE FENCE RULE:\n"
    "- NEVER strip, flatten, or omit triple-backtick fenced code blocks.\n"
    "- Every code snippet MUST be wrapped in ```lang ... ``` fences.\n"
    "- If the input already has fenced blocks, keep them exactly as-is.\n\n"
    "CRITICAL CLEANUP RULES:\n"
    "- REMOVE any <think>...</think> blocks or model reasoning artifacts.\n"
    "- REMOVE any 'Okay, I need to...' or 'Let me think about...' self-narration.\n"
    "- The output must read as polished professional prose, not internal notes."
)


async def _writer_pass(content: str, state: dict[str, Any]) -> str:
    """Writer synthesis pass for polishing assembled output."""
    difficulty = state.get("difficulty", 0.5)
    rt = state.get("routing_thresholds") or {}
    writer_threshold = float(rt.get("writer_pass_above", 0.2))
    if difficulty < writer_threshold:
        return content
    section_count = content.count("\n---\n") + content.count("\n**")
    if section_count < 3:
        return content

    if len(content) < 500:
        return content

    writer_url = settings.writer_model_url or settings.general_model_url
    writer_name = settings.writer_model_name or settings.general_model_name
    if not writer_url:
        return content

    try:
        from langchain_core.messages import HumanMessage, SystemMessage
        from langchain_openai import ChatOpenAI

        from .llm_telemetry import get_llm_http_client

        writer_budget = settings.scaled_writer_budget(difficulty)

        writer_llm = ChatOpenAI(
            base_url=writer_url,
            api_key="not-needed",
            model=writer_name,
            temperature=0.3,
            max_completion_tokens=writer_budget,
            streaming=False,
            use_responses_api=False,
            model_kwargs=(
                {"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}}
                if settings.guided_json_enabled
                else {}
            ),
            http_client=get_llm_http_client(),
        )

        frame = state.get("user_task") or {}
        frame_deliverables = frame.get("deliverables") or []
        frame_output_format = frame.get("requested_format", "")

        preserve_hints = ""
        if frame_deliverables:
            preserve_hints += (
                " The user requested these deliverables — ensure each appears in the output: "
                + "; ".join(frame_deliverables[:8])
                + "."
            )
        if frame_output_format and frame_output_format != "prose":
            preserve_hints += f" Expected output format: {frame_output_format}."

        cohesion_lock = state.get("cohesion_lock") or {}
        cohesion_entity = cohesion_lock.get("entity", "")
        cohesion_hint = ""
        if cohesion_entity:
            exclude = cohesion_lock.get("exclude_signals") or []
            exclude_part = f" Do not introduce content about: {', '.join(exclude[:6])}." if exclude else ""
            cohesion_hint = f" Stay within the conceptual frame: {cohesion_entity}.{exclude_part}"

        instruction = (
            "Synthesize these independently-generated sections into a single coherent document. "
            "Improve flow and transitions between sections. Remove exact duplicate sentences only. "
            "PRESERVE the following verbatim: all code blocks, markdown formatting, "
            "and any structured headings the user explicitly requested. "
            "Do NOT add generic compliance scaffolding or enterprise boilerplate "
            "that was not present in the source sections. "
            "Match your depth to the source material — do not compress or inflate." + preserve_hints + cohesion_hint
        )

        result = await writer_llm.ainvoke(
            [
                SystemMessage(content=_WRITER_SYSTEM),
                HumanMessage(content=f"{instruction}\n\n{content}"),
            ]
        )
        polished = _clean_section_artifacts((result.content or "").strip())
        if polished and len(polished) > len(content) * 0.5:
            logger.info("writer_pass applied, original=%d polished=%d", len(content), len(polished))
            return polished
        logger.warning("writer_pass output too short, using original")
        return content
    except Exception:
        logger.warning("writer_pass failed, using original", exc_info=True)
        return content


# ---------------------------------------------------------------------------
# Respond node
# ---------------------------------------------------------------------------


async def respond_node(state: dict[str, Any]) -> dict[str, Any]:
    """Terminal node -- assembles the final response for the user."""
    from langchain_core.messages import AIMessage

    from .config import settings
    from .conversation_memory import memory
    from .decision_summary import build_decision_summary

    code = state.get("generated_code", "")
    logger.debug(
        "respond_received generated_code_len=%d patch_ops=%d", len(code or ""), len(state.get("patch_ops") or [])
    )
    patch_ops = state.get("patch_ops", []) or []
    explanation = state.get("code_explanation", "")
    what_ifs = state.get("what_if_analyses", [])
    error = state.get("error")
    traces = state.get("node_traces", [])
    clarification_question = state.get("clarification_question", "")
    clarification_options = state.get("clarification_options", [])
    needs_input_question = state.get("needs_input_question", "")
    execution_plan = state.get("execution_plan", {})
    plan_pending_approval = state.get("plan_pending_approval", False)
    user_id = state.get("user_id", "anonymous")
    memory_scope = state.get("memory_scope") or user_id

    if state.get("message_origin") == "ui_helper" and not code and not error:
        return {
            "messages": [AIMessage(content="[UI helper request; no coding task to process.]")],
            "current_node": "respond",
        }

    if plan_pending_approval and execution_plan and not code and not error:
        memory.store_pending_question(
            user_id,
            {
                "run_id": state.get("run_id", ""),
                "turn_id": str(state.get("iteration_count", 0)),
                "source_node": "planner",
                "question": "Reply to proceed or suggest changes.",
                "context": {
                    "execution_plan": execution_plan,
                    "task_description": state.get("task_description", ""),
                    "target_language": state.get("target_language") or "markdown",
                    "task_type": state.get("task_type", "general"),
                    "assumptions": state.get("assumptions", []),
                    "failure_context": state.get("failure_context", []),
                    "is_code_task": state.get("is_code_task"),
                },
                "execution_plan": execution_plan,
                "task_description": state.get("task_description", ""),
            },
        )
        steps = execution_plan.get("steps", [])
        lines = ["**Execution plan:**"]
        for s in steps:
            act = s.get("action", str(s)) if isinstance(s, dict) else str(s)
            lines.append(f"- {act}")
        oq = execution_plan.get("open_questions", [])
        if oq:
            lines.append("\n**Open questions:** " + "; ".join(oq))
        lines.append("\nReply with any message to proceed, or describe changes you'd like.")
        content = "\n".join(lines)
        return {
            "messages": [AIMessage(content=content)],
            "current_node": "respond",
        }

    if clarification_question and not code and not error:
        content = f"**I need a bit more information to proceed:**\n\n{clarification_question}"
        if clarification_options:
            content += "\n\nOptions:\n" + "\n".join(f"- {opt}" for opt in clarification_options)
        memory.store_pending_question(
            memory_scope,
            {
                "run_id": state.get("run_id", ""),
                "turn_id": str(state.get("iteration_count", 0)),
                "source_node": "router",
                "question": clarification_question,
                "context": {
                    "task_description": state.get("task_description", ""),
                    "target_language": state.get("target_language") or "markdown",
                    "is_code_task": state.get("is_code_task"),
                },
            },
        )
        return {
            "messages": [AIMessage(content=content)],
            "current_node": "respond",
        }

    stop_reason = state.get("stop_reason", "")
    if stop_reason and not code and not error:
        reason_msg = {
            "blocked_external": "Missing dependency, credential, or network access.",
            "cannot_reproduce": "Sandbox environment doesn't match requirements.",
            "unsafe_request": "Task conflicts with safety policy.",
        }.get(stop_reason, stop_reason)
        content = f"**I cannot proceed:** {reason_msg}"
        expl = state.get("stop_reason_explanation", "").strip()
        if expl:
            content += f"\n\n{expl}"
        return {
            "messages": [AIMessage(content=content)],
            "current_node": "respond",
        }

    if needs_input_question and not code and not error:
        content = f"**I need a bit more information:**\n\n{needs_input_question}"
        ctx = {
            "task_description": state.get("task_description", ""),
            "target_language": state.get("target_language") or "markdown",
            "execution_plan": state.get("execution_plan", {}),
            "assumptions": state.get("assumptions", []),
            "is_code_task": state.get("is_code_task"),
        }
        memory.store_pending_question(
            memory_scope,
            {
                "run_id": state.get("run_id", ""),
                "turn_id": str(state.get("iteration_count", 0)),
                "source_node": "executor",
                "question": needs_input_question,
                "context": ctx,
                "needs_input_question": needs_input_question,
                **ctx,
            },
        )
        return {
            "messages": [AIMessage(content=content)],
            "current_node": "respond",
        }

    parts: list[str] = []
    scrubbed = state.get("scrubbed_answer", "")
    compiled = state.get("compiled_answer", "")
    if scrubbed:
        content = scrubbed
        logger.info(
            "respond_using_scrubbed_answer",
            extra={"len": len(content)},
        )
    elif compiled:
        content = compiled
        logger.info(
            "respond_using_compiled_answer",
            extra={"len": len(content)},
        )
    elif error:
        err_text = str(error)
        if "timed out" in err_text.lower() and "router" in err_text.lower():
            content = (
                "I ran out of time while gathering evidence. "
                "I was still retrieving and summarizing sources when the router hit its time limit."
            )
            deg_notes = (state.get("retrieval_degradation_notes") or "").strip()
            if deg_notes:
                content += f"\n\nWhat I found before timing out: {deg_notes}"
            content += (
                "\n\nTry narrowing scope or asking for a phased answer "
                "(for example: key decisions first, then deeper sections)."
            )
        else:
            content = f"I encountered an issue while processing your request: {error}"
        if code:
            content += f"\n\nPartial result:\n```\n{code}\n```"
    else:
        lang = state.get("target_language") or "markdown"
        display_code = code
        if not (display_code or "").strip() and patch_ops:
            blocks = []
            for op in patch_ops:
                p = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
                t = (
                    op.get("text", "") or op.get("content", "")
                    if isinstance(op, dict)
                    else getattr(op, "text", "") or getattr(op, "content", "")
                )
                if p and (t or "").strip():
                    blocks.append(f"**{p}**\n```{lang}\n{t.strip()}\n```")
            if blocks:
                display_code = "\n\n".join(blocks)

        difficulty = state.get("difficulty", 0.5)
        rt = state.get("routing_thresholds") or {}
        is_minimalist = difficulty < float(rt.get("trivial_below", 0.15))
        is_architect = difficulty >= float(rt.get("include_tests_above", 0.7))

        defaults = state.get("defaults_used", [])
        micro_ack_parts = list(defaults[:3]) if defaults else []
        if not is_minimalist and micro_ack_parts and display_code:
            ack = f"Got it — {lang} + " + ", ".join(str(x) for x in micro_ack_parts[:3]) + ". Here are the file(s):"
            parts.append(ack)
        if display_code:
            if not state.get("is_code_task", False) or (patch_ops and not code) or "```" in display_code:
                parts.append(display_code)
            else:
                parts.append(f"```{lang}\n{display_code}\n```")
        if is_minimalist:
            one_line = (explanation or "").strip() or (micro_ack_parts[0] if micro_ack_parts else "Done.")
            parts.append(one_line[:200])
        else:
            if explanation:
                parts.append(f"\n**Approach:** {explanation}")
            if is_architect and what_ifs:
                parts.append("\n**Safety Analysis:**")
                for wif in what_ifs:
                    risk_icon = {"low": "~", "medium": "!", "high": "!!", "critical": "!!!"}
                    icon = risk_icon.get(getattr(wif, "risk_level", "low"), "?")
                    scenario = getattr(wif, "scenario", str(wif))
                    expl = getattr(wif, "explanation", "")
                    mitigation = getattr(wif, "suggested_mitigation", "")
                    parts.append(f"- [{icon}] {scenario}: {expl}")
                    if mitigation:
                        parts.append(f"  Mitigation: {mitigation}")
            if is_architect and settings.decision_summary_enabled:
                summary = build_decision_summary(state)
                if summary:
                    parts.append(f"\n---\n**How I got here**\n{summary}")
        critic_nonblocking = state.get("critic_nonblocking") or []
        if critic_nonblocking and state.get("is_code_task", False):
            suggestion_lines = []
            for item in critic_nonblocking[:5]:
                desc = item.get("description", str(item)) if isinstance(item, dict) else str(item)
                desc = desc.strip()
                if desc:
                    suggestion_lines.append(f"- {desc}")
            if suggestion_lines:
                suggestions_md = "\n".join(suggestion_lines)
                parts.append(f"\n<details>\n<summary>Suggestions</summary>\n\n{suggestions_md}\n\n</details>")
        advisory = (state.get("advisory_message") or "").strip()
        knowledge_gap = (state.get("knowledge_gap_message") or "").strip()
        if advisory:
            parts.append(f"\n---\n**{advisory}**")
        if knowledge_gap:
            parts.append(f"\n---\n**{knowledge_gap}**")
        if not parts:
            logger.warning(
                "respond_empty_parts code_len=%d patch_ops=%d has_explanation=%s",
                len(code or ""),
                len(patch_ops),
                bool(explanation),
            )
            content = "I processed your request but have no output to show."
        else:
            content = "\n".join(parts)
            content = await _writer_pass(content, state)

    avg_confidence = 0.0
    if traces:
        confidences = [t.confidence for t in traces if isinstance(t, NodeTrace)]
        if confidences:
            avg_confidence = sum(confidences) / len(confidences)

    logger.info(
        "response_assembled",
        extra={
            "has_code": bool(code),
            "has_patch_ops": len(patch_ops),
            "has_display": bool(parts),
            "has_error": bool(error),
            "what_if_count": len(what_ifs),
            "iterations": state.get("iteration_count", 0),
            "avg_confidence": avg_confidence,
        },
    )

    # Structured feedback log: captures full pipeline metadata per request
    # for downstream learning, taxonomy tuning, and cache warm policy.
    user_task = state.get("user_task") or {}
    evidence_packets = state.get("evidence_packets") or []
    critic_scores = state.get("critic_scores") or {}
    _fb_run_id = state.get("run_id", "")
    _fb_difficulty = state.get("difficulty", 0.5)
    _fb_task_type = state.get("task_type", "general")
    _fb_domain_tags = user_task.get("domain_tags", [])
    _fb_evidence_count = len(evidence_packets)
    _fb_avg_confidence = round(
        sum(p.get("confidence", 0) if isinstance(p, dict) else getattr(p, "confidence", 0) for p in evidence_packets)
        / max(1, _fb_evidence_count),
        4,
    )
    _fb_critic_score = critic_scores.get("weighted_overall", 0.0)
    _fb_blocking = len(state.get("blocking_issues") or [])
    _fb_iterations = state.get("iteration_count", 0)
    _fb_is_code = state.get("is_code_task", False)
    _fb_resp_len = len(content)
    _fb_has_error = bool(error)
    logger.info(
        "request_feedback",
        extra={
            "run_id": _fb_run_id,
            "difficulty": _fb_difficulty,
            "task_type": _fb_task_type,
            "domain_tags": _fb_domain_tags,
            "needs_web": user_task.get("needs_web", False),
            "evidence_packet_count": _fb_evidence_count,
            "avg_evidence_confidence": _fb_avg_confidence,
            "critic_weighted_score": _fb_critic_score,
            "critic_blocking_issues": _fb_blocking,
            "iteration_count": _fb_iterations,
            "is_code_task": _fb_is_code,
            "response_length": _fb_resp_len,
            "has_error": _fb_has_error,
        },
    )
    if _synesis_tracer is not None:
        _synesis_tracer.set_request_metadata(
            run_id=_fb_run_id,
            difficulty=_fb_difficulty,
            task_type=_fb_task_type,
            domain_tags=_fb_domain_tags,
            evidence_packet_count=_fb_evidence_count,
            avg_evidence_confidence=_fb_avg_confidence,
            critic_weighted_score=_fb_critic_score,
            critic_blocking_issues=_fb_blocking,
            iteration_count=_fb_iterations,
            is_code_task=_fb_is_code,
            response_length=_fb_resp_len,
            has_error=_fb_has_error,
        )

    # Fire background critic when graph skipped it (critic_background=True).
    # Runs asynchronously; results are logged but do not block the response.
    # Gate on actual content rather than absence of error — recoverable planner
    # errors should not prevent critic evaluation of a delivered response.
    has_content = bool(state.get("scrubbed_answer") or state.get("generated_code"))
    if (
        settings.critic_background
        and not state.get("critic_approved")
        and not state.get("critic_feedback")
        and state.get("difficulty", 0.5) >= settings.critic_skip_below_difficulty
        and has_content
    ):
        _fire_background_critic(dict(state))

    return {
        "messages": [AIMessage(content=content)],
        "current_node": "respond",
    }


# ---------------------------------------------------------------------------
# Background critic
# ---------------------------------------------------------------------------

_bg_critic_tasks: set[asyncio.Task[None]] = set()

_bg_critic_metrics_init = False
_bg_critic_approved_counter = None
_bg_critic_rejected_counter = None


def _ensure_bg_critic_metrics() -> None:
    global _bg_critic_metrics_init, _bg_critic_approved_counter, _bg_critic_rejected_counter
    if _bg_critic_metrics_init:
        return
    try:
        from prometheus_client import Counter

        _bg_critic_approved_counter = Counter(
            "synesis_background_critic_approved_total",
            "Background critic approvals",
        )
        _bg_critic_rejected_counter = Counter(
            "synesis_background_critic_rejected_total",
            "Background critic rejections",
        )
    except Exception:
        pass
    _bg_critic_metrics_init = True


def _fire_background_critic(state_snapshot: dict[str, Any]) -> None:
    """Schedule the critic to run as a background task outside the graph.

    The task logs results via structured logging but never feeds back into
    the current response.  Anti-oscillation and feedback loop data is still
    captured for downstream analysis.
    """

    async def _run() -> None:
        try:
            result = await critic_node(state_snapshot)
            scores = result.get("critic_scores") or {}
            approved = result.get("critic_approved", False)
            logger.info(
                "background_critic_complete",
                extra={
                    "run_id": state_snapshot.get("run_id", ""),
                    "weighted_overall": scores.get("weighted_overall", 0.0),
                    "blocking_issues": len(result.get("blocking_issues") or []),
                    "approved": approved,
                },
            )
            _ensure_bg_critic_metrics()
            if approved and _bg_critic_approved_counter:
                _bg_critic_approved_counter.inc()
            elif not approved and _bg_critic_rejected_counter:
                _bg_critic_rejected_counter.inc()
        except Exception:
            logger.warning("background_critic_failed", exc_info=True)

    task = asyncio.create_task(_run())
    _bg_critic_tasks.add(task)
    task.add_done_callback(_bg_critic_tasks.discard)


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

timeout = settings.node_timeout_seconds

graph_builder = StateGraph(GraphState)

# SynesisTracer (attached via get_graph_config callbacks) creates per-node
# spans from LangChain callback events.  with_telemetry_node provides
# structured logging + optional OTel spans independently.
graph_builder.add_node("entry_pipeline", with_telemetry_node(with_timeout(timeout)(entry_pipeline_node)))
graph_builder.add_node("router", with_telemetry_node(with_timeout(timeout)(router_node)))
graph_builder.add_node("planner", with_telemetry_node(with_timeout(timeout)(planner_node)))
graph_builder.add_node(
    "executor",
    with_telemetry_node(
        with_timeout(timeout)(
            validated_node(
                executor_node,
                validators_before=[validate_decision_drift, validate_style_compliance],
                validators_after=[validate_required_sections, validate_citation_preservation],
            )
        )
    ),
)
graph_builder.add_node("writer", with_telemetry_node(with_timeout(timeout)(writer_node)))
graph_builder.add_node("patch_integrity_gate", with_telemetry_node(with_timeout(timeout)(patch_integrity_gate_node)))
graph_builder.add_node(
    "critic",
    with_telemetry_node(
        with_timeout(timeout)(
            validated_node(
                critic_node,
                validators_after=[validate_critique_resolutions],
            )
        )
    ),
)
graph_builder.add_node("final_scrubber", with_telemetry_node(with_timeout(timeout)(final_scrubber_node)))
graph_builder.add_node("respond", with_telemetry_node(with_timeout(timeout)(respond_node)))

# Entry flow: single pipeline node -> router
graph_builder.set_entry_point("entry_pipeline")
graph_builder.add_conditional_edges(
    "entry_pipeline",
    route_after_entry_pipeline,
    {"router": "router", "writer": "writer", "executor": "executor", "respond": "respond"},
)

# Router -> planner | executor | writer | respond
graph_builder.add_conditional_edges(
    "router",
    route_after_router,
    {"planner": "planner", "executor": "executor", "writer": "writer", "respond": "respond"},
)

# Planner -> router (always — router decides next step)
graph_builder.add_conditional_edges(
    "planner",
    route_after_planner,
    {"router": "router", "respond": "respond"},
)

# Executor -> patch_integrity_gate | respond
graph_builder.add_conditional_edges(
    "executor",
    route_after_executor,
    {"respond": "respond", "patch_integrity_gate": "patch_integrity_gate"},
)

# Writer -> critic | final_scrubber
graph_builder.add_conditional_edges(
    "writer",
    route_after_writer,
    {"critic": "critic", "final_scrubber": "final_scrubber"},
)

# Patch integrity gate -> critic | router
graph_builder.add_conditional_edges(
    "patch_integrity_gate",
    route_after_patch_integrity_gate,
    {"router": "router", "critic": "critic"},
)

# Critic -> writer (quality revision) | router (evidence gap) | final_scrubber (approved) | respond
graph_builder.add_conditional_edges(
    "critic",
    route_after_critic,
    {"writer": "writer", "router": "router", "final_scrubber": "final_scrubber", "respond": "respond"},
)

# Terminal edges
graph_builder.add_edge("final_scrubber", "respond")
graph_builder.add_edge("respond", END)


async def upgrade_checkpointer_to_redis() -> bool:
    """Upgrade the compiled graph's checkpointer from MemorySaver to AsyncRedisSaver.

    Must be called from an async context (e.g. FastAPI lifespan).  AsyncRedisSaver
    requires an async context manager, so it cannot be initialized at module level
    where uvicorn's event loop is already running.

    Returns True if upgrade succeeded, False if Redis is unavailable.
    """
    if settings.session_checkpointer_backend != "redis" or not settings.session_redis_url:
        return False
    try:
        import os

        from langgraph.checkpoint.redis import AsyncRedisSaver

        # redisvl (transitive dep of langgraph-checkpoint-redis) creates its
        # own Redis connections via get_address_from_env() which reads REDIS_URL.
        # Without this, aput() raises ValueError after every graph execution.
        os.environ.setdefault("REDIS_URL", settings.session_redis_url)

        cm = AsyncRedisSaver.from_conn_string(settings.session_redis_url)
        saver = await cm.__aenter__()
        await saver.asetup()
        graph.checkpointer = saver
        logger.info(
            "redis_checkpointer_ready",
            extra={"url": settings.session_redis_url[:40], "type": "AsyncRedisSaver"},
        )
        return True
    except Exception:
        logger.warning("redis_checkpointer_init_failed, keeping MemorySaver", exc_info=True)
        return False


def _log_graph_init_memory(label: str) -> None:
    """Log RSS during module-level graph init for OOM diagnosis."""
    import resource as _res

    rss_kb = _res.getrusage(_res.RUSAGE_SELF).ru_maxrss
    import os as _os

    rss_mib = rss_kb / (1024 if _os.uname().sysname != "Darwin" else (1024 * 1024))
    logger.info("graph_init_memory", extra={"label": label, "rss_mib": round(rss_mib, 1)})


_log_graph_init_memory("before_graph_compile")
from langgraph.checkpoint.memory import MemorySaver

graph = graph_builder.compile(checkpointer=MemorySaver())
_log_graph_init_memory("after_graph_compile")

from .synesis_tracer import flush_synesis_tracer, get_synesis_tracer

_synesis_tracer = get_synesis_tracer()


def flush_tracer() -> None:
    """Flush the SynesisTracer after each graph execution."""
    flush_synesis_tracer()


def get_graph_config(extra: dict[str, Any] | None = None, thread_id: str = "") -> dict[str, Any]:
    """Build graph invocation config with SynesisTracer callback and session thread_id."""
    cfg: dict[str, Any] = {"recursion_limit": 50}
    if extra:
        cfg.update(extra)
    if thread_id:
        cfg.setdefault("configurable", {})["thread_id"] = thread_id
    if _synesis_tracer is not None:
        cfg.setdefault("callbacks", []).append(_synesis_tracer)
    return cfg
