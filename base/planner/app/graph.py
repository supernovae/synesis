"""Synesis LangGraph -- the core orchestration loop.

  [User Input] -> [EntryClassifier] -> [StrategicAdvisor] -> [Router] -> [Planner?] -> [Worker] -> [PatchGate] -> [Critic] -> [Response]

Supervisor can request clarification (-> respond) or suggest planning (-> planner).
Planner produces execution_plan; Worker consumes it. Sandbox and LSP are no longer
fixed pipeline stages; they remain available as tools for future agent-based self-correction loops.
"""

from __future__ import annotations

import asyncio
import logging
from functools import wraps
from typing import Any

from langgraph.graph import END, StateGraph
from langgraph.types import Send

from .config import settings
from .nodes import (
    context_curator_node,
    critic_node,
    entry_classifier_node,
    patch_integrity_gate_node,
    planner_node,
    section_worker_node,
    strategic_advisor_node,
    supervisor_node,
    worker_node,
)
from .state import GraphState, NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.graph")


def with_debug_node_timing(func):
    """Log node exit at DEBUG with latency for performance tuning."""

    @wraps(func)
    async def wrapper(state: dict[str, Any]) -> dict[str, Any]:
        import time

        start = time.monotonic()
        coro_or_result = func(state)
        result = await coro_or_result if asyncio.iscoroutine(coro_or_result) else coro_or_result
        latency_ms = (time.monotonic() - start) * 1000
        node_name = func.__name__.replace("_node", "")
        # Prefer latency from node's own trace if present
        traces = result.get("node_traces") or []
        if traces and hasattr(traces[-1], "latency_ms") and traces[-1].latency_ms > 0:
            latency_ms = traces[-1].latency_ms
        logger.debug("Node %s took %.0fms", node_name, latency_ms)
        return result

    return wrapper


def with_timeout(timeout_seconds: float):
    """Erlang-style timeout wrapper. Node either returns or gets killed."""

    def decorator(func):
        @wraps(func)
        async def wrapper(state: dict[str, Any]) -> dict[str, Any]:
            try:
                return await asyncio.wait_for(
                    func(state),
                    timeout=timeout_seconds,
                )
            except TimeoutError:
                node_name = func.__name__.replace("_node", "")
                logger.error(f"Node '{node_name}' timed out after {timeout_seconds}s")
                return {
                    "current_node": node_name,
                    "next_node": "respond",
                    "error": f"Node '{node_name}' timed out after {timeout_seconds}s",
                    "generated_code": state.get("generated_code", ""),
                    "code_explanation": state.get("code_explanation", ""),
                    "patch_ops": state.get("patch_ops", []) or [],
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

        return wrapper

    return decorator


def route_after_entry_classifier(state: dict[str, Any]) -> str:
    """Route after deterministic IntentEnvelope. Easy → context_curator; hard → planner; else supervisor."""
    # Pending question (user replying to clarification/plan/needs_input)
    if state.get("pending_question_continue"):
        src = state.get("pending_question_source", "worker")
        if src in ("worker", "planner"):
            return "context_curator"
        return src

    # UI helper slipped through main.py filter — short-circuit
    if state.get("message_origin") == "ui_helper":
        return "respond"

    # Plan required (code, taxonomy-driven document, or explicit "lets plan"): bypass Supervisor, go to Planner
    if state.get("plan_required"):
        if state.get("task_size") in ("hard", "medium") or not state.get("is_code_task", False):
            return "planner"

    # Bypass Supervisor: easy fast path, or knowledge-downgraded tasks that
    # don't need LLM routing (e.g. "What are the differences between REST and GraphQL?")
    if state.get("bypass_supervisor"):
        return "context_curator"

    return "supervisor"


def route_after_supervisor(state: dict[str, Any]) -> str:
    next_node = state.get("next_node", "respond")
    if state.get("error"):
        return "respond"
    if next_node == "planner":
        return "planner"
    if next_node == "worker":
        # Supervisor LLM classifies easy; pass through to Worker with rag_mode=disabled
        return "context_curator"
    return "respond"


def route_after_critic(state: dict[str, Any]) -> str:
    """Respond unless need_more_evidence or (not approved & should_continue)."""
    if state.get("error"):
        return "respond"
    iteration = state.get("iteration_count", 0)
    max_iter = state.get("max_iterations", settings.max_iterations)
    if state.get("critic_approved", True) and not state.get("need_more_evidence"):
        return "respond"
    if iteration >= max_iter:
        return "respond"
    need_evidence = state.get("need_more_evidence", False)
    approved = state.get("critic_approved", True)
    should_continue = state.get("critic_should_continue", False)
    if need_evidence:
        return "supervisor"
    if not approved and should_continue:
        return "supervisor"
    if state.get("critic_continue_reason") in ("blocked_external", "needs_input"):
        return "supervisor"
    return "respond"


def _get_resolved_rag_context(state: dict[str, Any]) -> list[str]:
    """Resolve RAG context from refs+cache or legacy rag_context."""
    from .context_resolver import get_resolved_rag_context

    return get_resolved_rag_context(state)


_WRITER_SYSTEM = (
    "You are the Writer for Synesis. You receive assembled sections from "
    "specialist nodes (code, explanation, safety analysis, suggestions). "
    "Your job is to synthesize these into a single, coherent, well-structured "
    "response. Do not add information — only improve flow, tone, and structure. "
    "Preserve all code blocks and markdown formatting verbatim. Keep it concise."
)


async def _writer_pass(content: str, state: dict[str, Any]) -> str:
    """Optional writer synthesis for hard tasks with multi-section responses.

    Uses the general model (or dedicated writer endpoint if configured) to
    polish assembled output. Skipped for easy/medium tasks, short responses,
    or when no writer endpoint is available.
    """
    task_size = state.get("task_size", "medium")
    if task_size != "hard":
        return content

    section_count = content.count("\n---\n") + content.count("\n**")
    if section_count < 3:
        return content

    if len(content) < 500:
        return content

    writer_url = settings.writer_model_url or settings.executor_model_url
    writer_name = settings.writer_model_name or settings.executor_model_name
    if not writer_url:
        return content

    try:
        from langchain_core.messages import HumanMessage, SystemMessage
        from langchain_openai import ChatOpenAI

        from .llm_telemetry import get_llm_http_client

        is_depth = state.get("depth_mode", False)
        writer_budget = 8192 if is_depth else 4096

        writer_llm = ChatOpenAI(
            base_url=writer_url,
            api_key="not-needed",
            model=writer_name,
            temperature=0.3,
            max_completion_tokens=writer_budget,
            streaming=False,
            use_responses_api=False,
            http_client=get_llm_http_client(),
        )

        instruction = (
            "Synthesize these independently-generated sections into a single coherent document. "
            "Improve flow and transitions between sections. Remove redundancy. "
            "Preserve all substantive content, code blocks, and markdown formatting verbatim."
            if is_depth
            else "Polish this multi-section response:"
        )

        result = await writer_llm.ainvoke(
            [
                SystemMessage(content=_WRITER_SYSTEM),
                HumanMessage(content=f"{instruction}\n\n{content}"),
            ]
        )
        polished = result.content.strip()
        if polished and len(polished) > len(content) * 0.5:
            logger.info("writer_pass applied, original=%d polished=%d", len(content), len(polished))
            return polished
        logger.warning("writer_pass output too short, using original")
        return content
    except Exception:
        logger.warning("writer_pass failed, using original", exc_info=True)
        return content


async def respond_node(state: dict[str, Any]) -> dict[str, Any]:
    """Terminal node -- assembles the final response for the user.

    For hard tasks with multi-section responses, an optional writer pass
    (MoA aggregator pattern) uses the general model to synthesize sections
    into a coherent, polished response.
    """
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

    # EntryClassifier routed UI-helper here (defensive; normally filtered in main.py)
    if state.get("message_origin") == "ui_helper" and not code and not error:
        return {
            "messages": [AIMessage(content="[UI helper request; no coding task to process.]")],
            "current_node": "respond",
        }

    # JCS Phase 6: plan approval — store unified pending question, surface to user
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
                    "rag_context": _get_resolved_rag_context(state),
                    "task_type": state.get("task_type", "general"),
                    "assumptions": state.get("assumptions", []),
                    "failure_context": state.get("failure_context", []),
                    "web_search_results": state.get("web_search_results", []),
                    "is_code_task": state.get("is_code_task"),
                },
                "execution_plan": execution_plan,
                "task_description": state.get("task_description", ""),
                "target_language": state.get("target_language") or "markdown",
                "rag_context": _get_resolved_rag_context(state),
                "task_type": state.get("task_type", "general"),
                "assumptions": state.get("assumptions", []),
                "failure_context": state.get("failure_context", []),
                "web_search_results": state.get("web_search_results", []),
                "is_code_task": state.get("is_code_task"),
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

    # JCS: surface clarification (Supervisor) — store unified pending question
    if clarification_question and not code and not error:
        content = f"**I need a bit more information to proceed:**\n\n{clarification_question}"
        if clarification_options:
            content += "\n\nOptions:\n" + "\n".join(f"- {opt}" for opt in clarification_options)
        memory.store_pending_question(
            memory_scope,
            {
                "run_id": state.get("run_id", ""),
                "turn_id": str(state.get("iteration_count", 0)),
                "source_node": "supervisor",
                "question": clarification_question,
                "context": {
                    "task_description": state.get("task_description", ""),
                    "target_language": state.get("target_language") or "markdown",
                    "rag_context": _get_resolved_rag_context(state),
                    "is_code_task": state.get("is_code_task"),
                },
                "task_description": state.get("task_description", ""),
                "target_language": state.get("target_language") or "markdown",
                "rag_context": _get_resolved_rag_context(state),
                "is_code_task": state.get("is_code_task"),
            },
        )
        return {
            "messages": [AIMessage(content=content)],
            "current_node": "respond",
        }

    # JCS: Worker stop_reason (blocked_external, cannot_reproduce, unsafe_request; needs_scope_expansion → Supervisor)
    stop_reason = state.get("stop_reason", "")
    if stop_reason and not code and not error:
        reason_msg = {
            "blocked_external": "Missing dependency, credential, or network access.",
            "cannot_reproduce": "Sandbox environment doesn't match requirements.",
            "unsafe_request": "Task conflicts with safety policy.",
            "needs_scope_expansion": "Need to touch files not in the execution plan. Supervisor will ask or update manifest.",
        }.get(stop_reason, stop_reason)
        content = f"**I cannot proceed:** {reason_msg}"
        expl = state.get("stop_reason_explanation", "").strip()
        if expl:
            content += f"\n\n{expl}"
        return {
            "messages": [AIMessage(content=content)],
            "current_node": "respond",
        }

    # JCS: needs_input (Executor) — store unified pending question
    if needs_input_question and not code and not error:
        content = f"**I need a bit more information:**\n\n{needs_input_question}"
        ctx = {
            "task_description": state.get("task_description", ""),
            "target_language": state.get("target_language") or "markdown",
            "rag_context": _get_resolved_rag_context(state),
            "execution_plan": state.get("execution_plan", {}),
            "assumptions": state.get("assumptions", []),
            "is_code_task": state.get("is_code_task"),
        }
        memory.store_pending_question(
            memory_scope,
            {
                "run_id": state.get("run_id", ""),
                "turn_id": str(state.get("iteration_count", 0)),
                "source_node": "worker",
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
    if error:
        content = f"I encountered an issue while processing your request: {error}"
        if code:
            content += f"\n\nPartial result:\n```\n{code}\n```"
    else:
        lang = state.get("target_language") or "markdown"
        task_size = state.get("task_size", "medium")
        # When Worker outputs patch_ops (multi-file), code may be empty; build display from patches
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

        is_minimalist = task_size == "easy"
        is_architect = task_size == "hard"

        # Micro-ack: brief line when we have defaults to surface (human, low-friction)
        defaults = state.get("defaults_used", [])
        micro_ack_parts = list(defaults[:3]) if defaults else []
        if not is_minimalist and micro_ack_parts and display_code:
            ack = f"Got it — {lang} + " + ", ".join(str(x) for x in micro_ack_parts[:3]) + ". Here are the file(s):"
            parts.append(ack)
            # Step 2: Medium tasks — friendly note that defaults can be overridden (no blocking)
            if task_size == "medium" and any(
                x
                for x in (defaults or [])
                if isinstance(x, str) and ("pytest" in x.lower() or "unittest" in x.lower() or "test" in x.lower())
            ):
                parts.append("*If you'd prefer a different test framework or setup, just say so.*")
        if display_code:
            if not state.get("is_code_task", False) or (patch_ops and not code):
                parts.append(display_code)
            elif "```" in display_code:
                # Already has fenced code blocks (markdown output from Worker)
                parts.append(display_code)
            else:
                parts.append(f"```{lang}\n{display_code}\n```")
        # Minimalist: code + one line only
        if is_minimalist:
            one_line = (explanation or "").strip() or (micro_ack_parts[0] if micro_ack_parts else "Done.")
            parts.append(one_line[:200])  # Cap at 200 chars for true minimalism
        else:
            if explanation:
                parts.append(f"\n**Approach:** {explanation}")
            # What-If and Decision Summary: Architect only
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
        # Critic nonblocking suggestions: surface as collapsible section for code responses
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
        # Carried uncertainties: known unknowns surfaced to user — any persona when relevant
        carried = state.get("carried_uncertainties_signal") or {}
        debt_items = carried.get("items") or []
        if debt_items:
            debt_lines = [
                f"- {item.get('description', '')[:120]}" for item in debt_items[:3] if item.get("description")
            ]
            if debt_lines:
                parts.append("\n---\n**What I'm carrying**\n" + "\n".join(debt_lines))
        # Budget Alert (Q1.3): high-score docs excluded for token limit
        context_pack = state.get("context_pack")
        if context_pack:
            pack = (
                context_pack
                if isinstance(context_pack, dict)
                else (context_pack.model_dump() if hasattr(context_pack, "model_dump") else {})
            )
            budget_alert = pack.get("budget_alert", "")
            resync = pack.get("context_resync_message", "")
            if budget_alert:
                parts.append(f"\n---\n**{budget_alert}**")
            if resync:
                parts.append(f"\n---\n**{resync}**")
        # Advisory message (Strategic Advisor) + Knowledge gap (Safety-II)
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

    return {
        "messages": [AIMessage(content=content)],
        "current_node": "respond",
    }


async def merge_sections_node(state: dict[str, Any]) -> dict[str, Any]:
    """Assemble parallel section results into a unified response.

    Orders sections by section_id, concatenates with heading separators,
    and feeds the assembled content through the writer pass for synthesis.
    This is the "Reduce" phase of the Skeleton-of-Thought map-reduce pattern.
    """
    section_results = state.get("section_results") or []
    if not section_results:
        logger.warning("merge_sections_empty")
        return {
            "generated_code": "*No sections were generated.*",
            "current_node": "merge_sections",
        }

    ordered = sorted(section_results, key=lambda s: s.get("section_id", 0))

    parts: list[str] = []
    total_latency = 0
    rag_count = 0
    web_count = 0
    for sec in ordered:
        text = sec.get("text", "").strip()
        if text:
            parts.append(text)
        total_latency += sec.get("latency_ms", 0)
        if sec.get("had_rag"):
            rag_count += 1
        if sec.get("had_web"):
            web_count += 1

    assembled = "\n\n---\n\n".join(parts)

    # Writer pass: synthesis and polish
    assembled = await _writer_pass(assembled, state)

    logger.info(
        "merge_sections_complete",
        extra={
            "sections": len(ordered),
            "assembled_len": len(assembled),
            "total_section_latency_ms": total_latency,
            "sections_with_rag": rag_count,
            "sections_with_web": web_count,
        },
    )

    return {
        "generated_code": assembled,
        "current_node": "merge_sections",
    }


timeout = settings.node_timeout_seconds

graph_builder = StateGraph(GraphState)

graph_builder.add_node("entry_classifier", with_debug_node_timing(entry_classifier_node))
graph_builder.add_node("strategic_advisor", with_debug_node_timing(strategic_advisor_node))
graph_builder.add_node("supervisor", with_debug_node_timing(with_timeout(timeout)(supervisor_node)))
graph_builder.add_node("planner", with_debug_node_timing(with_timeout(timeout)(planner_node)))
graph_builder.add_node("context_curator", with_debug_node_timing(context_curator_node))
graph_builder.add_node("worker", with_debug_node_timing(with_timeout(timeout)(worker_node)))
graph_builder.add_node("patch_integrity_gate", with_debug_node_timing(patch_integrity_gate_node))
graph_builder.add_node("critic", with_debug_node_timing(with_timeout(timeout)(critic_node)))
graph_builder.add_node("section_worker", with_debug_node_timing(section_worker_node))
graph_builder.add_node("merge_sections", with_debug_node_timing(merge_sections_node))
graph_builder.add_node("respond", with_debug_node_timing(respond_node))

graph_builder.set_entry_point("entry_classifier")
graph_builder.add_edge("entry_classifier", "strategic_advisor")
graph_builder.add_conditional_edges(
    "strategic_advisor",
    route_after_entry_classifier,
    {"context_curator": "context_curator", "supervisor": "supervisor", "planner": "planner", "respond": "respond"},
)
graph_builder.add_conditional_edges(
    "supervisor",
    route_after_supervisor,
    {"context_curator": "context_curator", "planner": "planner", "respond": "respond"},
)


def route_after_planner(state: dict[str, Any]) -> str | list[Send]:
    """Route after planner: approval, depth-mode fan-out, or monolithic path."""
    if state.get("plan_pending_approval"):
        return "respond"

    # Depth mode: fan out to parallel section workers via Send() API
    # (Skeleton-of-Thought pattern, ICLR 2024)
    if state.get("depth_mode"):
        steps = (state.get("execution_plan") or {}).get("steps", [])
        if steps:
            max_parallel = settings.depth_mode_max_parallel
            sends = [
                Send("section_worker", {
                    "section_id": s.get("id", i + 1),
                    "section_action": s.get("action", str(s)),
                    "full_plan": state.get("execution_plan", {}),
                    "task_description": state.get("task_description", ""),
                    "conversation_history": (state.get("conversation_history") or [])[-4:],
                    "target_language": state.get("target_language") or "markdown",
                    "is_code_task": False,
                    "taxonomy_metadata": state.get("taxonomy_metadata") or {},
                    "web_search_enabled": settings.web_search_enabled,
                    "plan_required": True,
                })
                for i, s in enumerate(steps[:max_parallel])
            ]
            # If more steps than max_parallel, remaining are serialized after merge
            if len(steps) > max_parallel:
                logger.info(
                    "depth_mode_overflow",
                    extra={"total_steps": len(steps), "parallel": max_parallel},
                )
            return sends

    return "context_curator"


graph_builder.add_conditional_edges(
    "planner",
    route_after_planner,
    {"context_curator": "context_curator", "respond": "respond", "section_worker": "section_worker"},
)
graph_builder.add_edge("context_curator", "worker")
graph_builder.add_edge("section_worker", "merge_sections")
graph_builder.add_edge("merge_sections", "respond")


def route_after_worker(state: dict[str, Any]) -> str:
    """When Executor needs_input or stop_reason, route accordingly; else continue to Patch Integrity Gate."""
    if state.get("needs_input_question"):
        return "respond"
    stop_reason = state.get("stop_reason", "")
    if stop_reason == "needs_scope_expansion":
        return "supervisor"  # §8.5: Supervisor asks user or triggers Planner to update manifest
    if stop_reason:
        return "respond"
    # Explain-only fast path: skip patch_integrity_gate entirely.
    # High-complexity science domains route to critic for depth check; everything else goes direct.
    if not state.get("is_code_task", False):
        taxonomy_metadata = state.get("taxonomy_metadata") or {}
        complexity = float(taxonomy_metadata.get("complexity_score", 0))
        if complexity > 0.6 and taxonomy_metadata.get("required_elements"):
            return "critic"
        return "respond"
    return "patch_integrity_gate"


def route_after_patch_integrity_gate(state: dict[str, Any]) -> str:
    """Gate pass -> critic; Gate fail -> context_curator -> worker (no iteration increment)."""
    if not state.get("integrity_passed", True):
        return "context_curator"
    return "critic"


graph_builder.add_conditional_edges(
    "worker",
    route_after_worker,
    {
        "respond": "respond",
        "supervisor": "supervisor",
        "patch_integrity_gate": "patch_integrity_gate",
        "critic": "critic",
    },
)
graph_builder.add_conditional_edges(
    "patch_integrity_gate",
    route_after_patch_integrity_gate,
    {
        "context_curator": "context_curator",
        "critic": "critic",
    },
)
graph_builder.add_conditional_edges("critic", route_after_critic, {"respond": "respond", "supervisor": "supervisor"})
graph_builder.add_edge("respond", END)

graph = graph_builder.compile()
