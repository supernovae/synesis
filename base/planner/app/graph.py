"""Synesis LangGraph -- the core orchestration loop.

Implements JCS (Joint Cognitive System) with Planner, Executor LLM, and Sandbox:
  [User Input] -> [Supervisor] -> [Planner?] -> [Worker/Executor LLM] -> [Sandbox] -> [Critic] -> [Response]
                       ^              |                   ^                |
                       |              |     (fail)         +--[LSP]<--------+
                       +---------- (needs_revision) -----------------------+

Supervisor can request clarification (-> respond) or suggest planning (-> planner).
Planner produces execution_plan; Worker consumes it. Sandbox runs code in isolated pod.
On failure, LSP enriches error context before routing back to Worker.
"""

from __future__ import annotations

import asyncio
import logging
from functools import wraps
from typing import Any

from langgraph.graph import END, StateGraph

from .config import settings
from .nodes import (
    context_curator_node,
    critic_node,
    lsp_analyzer_node,
    patch_integrity_gate_node,
    planner_node,
    sandbox_node,
    supervisor_node,
    worker_node,
)
from .state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.graph")


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


def entry_router_node(state: dict[str, Any]) -> dict[str, Any]:
    """Passthrough. Routing is done by conditional edge."""
    return state


def route_entry(state: dict[str, Any]) -> str:
    """Unified: if user replied to pending question, route to source_node; else supervisor."""
    if state.get("pending_question_continue"):
        src = state.get("pending_question_source", "worker")
        # Worker and planner (plan approval) paths go through context curator; supervisor direct
        if src in ("worker", "planner"):
            return "context_curator"
        return src
    return "supervisor"


def route_after_supervisor(state: dict[str, Any]) -> str:
    next_node = state.get("next_node", "respond")
    if state.get("error"):
        return "respond"
    if next_node == "planner":
        return "planner"
    if next_node == "worker":
        return "context_curator"
    return "respond"


def route_after_sandbox(state: dict[str, Any]) -> str:
    """Route based on sandbox execution results. Explicit single branch per failure.

    Rule: LSP only for type/symbol/compile failures when lsp_mode=on_failure.
    Lint and security failures NEVER go to LSP (LSP is for deep type analysis).
    At max iterations on failure → Critic (postmortem) → Respond.
    Worker path always goes through context_curator (re-curate on retries).
    """
    if state.get("error"):
        return "respond"
    exit_code = state.get("execution_exit_code")
    if exit_code is None or exit_code == 0:
        return "critic"
    iteration = state.get("iteration_count", 0)
    max_iter = state.get("max_iterations", settings.max_iterations)
    if iteration >= max_iter:
        return "critic"
    failure_type = state.get("failure_type", "runtime")
    lint_passed = state.get("execution_lint_passed", True)
    security_passed = state.get("execution_security_passed", True)
    lsp_eligible = failure_type in ("lsp", "runtime") and lint_passed and security_passed
    if settings.lsp_enabled and settings.lsp_mode == "on_failure" and lsp_eligible:
        return "lsp_analyzer"
    return "context_curator"


def route_after_critic(state: dict[str, Any]) -> str:
    """Explicit: Respond unless need_more_evidence or (not approved & should_continue). Supervisor routes to worker."""
    if state.get("error"):
        return "respond"
    if state.get("critic_approved", True) and not state.get("need_more_evidence"):
        return "respond"
    iteration = state.get("iteration_count", 0)
    max_iter = state.get("max_iterations", settings.max_iterations)
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


def respond_node(state: dict[str, Any]) -> dict[str, Any]:
    """Terminal node -- assembles the final response for the user."""
    from langchain_core.messages import AIMessage

    from ..config import settings
    from ..conversation_memory import memory
    from ..decision_summary import build_decision_summary

    code = state.get("generated_code", "")
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
                    "target_language": state.get("target_language", "bash"),
                    "rag_context": state.get("rag_context", []),
                    "task_type": state.get("task_type", "general"),
                    "assumptions": state.get("assumptions", []),
                    "failure_context": state.get("failure_context", []),
                    "web_search_results": state.get("web_search_results", []),
                },
                "execution_plan": execution_plan,
                "task_description": state.get("task_description", ""),
                "target_language": state.get("target_language", "bash"),
                "rag_context": state.get("rag_context", []),
                "task_type": state.get("task_type", "general"),
                "assumptions": state.get("assumptions", []),
                "failure_context": state.get("failure_context", []),
                "web_search_results": state.get("web_search_results", []),
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
            user_id,
            {
                "run_id": state.get("run_id", ""),
                "turn_id": str(state.get("iteration_count", 0)),
                "source_node": "supervisor",
                "question": clarification_question,
                "context": {},
                "task_description": state.get("task_description", ""),
                "target_language": state.get("target_language", "bash"),
                "rag_context": state.get("rag_context", []),
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
        memory.store_pending_question(
            user_id,
            {
                "run_id": state.get("run_id", ""),
                "turn_id": str(state.get("iteration_count", 0)),
                "source_node": "worker",
                "question": needs_input_question,
                "context": {},
                "needs_input_question": needs_input_question,
                "task_description": state.get("task_description", ""),
                "target_language": state.get("target_language", "bash"),
                "rag_context": state.get("rag_context", []),
                "execution_plan": state.get("execution_plan", {}),
                "assumptions": state.get("assumptions", []),
            },
        )
        return {
            "messages": [AIMessage(content=content)],
            "current_node": "respond",
        }

    if error:
        content = f"I encountered an issue while processing your request: {error}"
        if code:
            content += f"\n\nPartial result:\n```\n{code}\n```"
    else:
        parts = []
        if code:
            lang = state.get("target_language", "bash")
            parts.append(f"```{lang}\n{code}\n```")
        if explanation:
            parts.append(f"\n**Approach:** {explanation}")
        if what_ifs:
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
        # JCS: Decision Summary ("why this approach") — compact, non-noisy
        if settings.decision_summary_enabled:
            summary = build_decision_summary(state)
            if summary:
                parts.append(f"\n---\n**How I got here**\n{summary}")
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
        content = "\n".join(parts) if parts else "I processed your request but have no output to show."

    avg_confidence = 0.0
    if traces:
        confidences = [t.confidence for t in traces if isinstance(t, NodeTrace)]
        if confidences:
            avg_confidence = sum(confidences) / len(confidences)

    logger.info(
        "response_assembled",
        extra={
            "has_code": bool(code),
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


timeout = settings.node_timeout_seconds

graph_builder = StateGraph(dict)

sandbox_timeout = settings.sandbox_timeout_seconds + 15
lsp_timeout = settings.lsp_timeout_seconds + 5

graph_builder.add_node("entry", entry_router_node)
graph_builder.add_node("supervisor", with_timeout(timeout)(supervisor_node))
graph_builder.add_node("planner", with_timeout(timeout)(planner_node))
graph_builder.add_node("context_curator", context_curator_node)
graph_builder.add_node("worker", with_timeout(timeout)(worker_node))
graph_builder.add_node("patch_integrity_gate", patch_integrity_gate_node)
graph_builder.add_node("sandbox", with_timeout(sandbox_timeout)(sandbox_node))
graph_builder.add_node("lsp_analyzer", with_timeout(lsp_timeout)(lsp_analyzer_node))
graph_builder.add_node("critic", with_timeout(timeout)(critic_node))
graph_builder.add_node("respond", respond_node)

graph_builder.set_entry_point("entry")
graph_builder.add_conditional_edges(
    "entry",
    route_entry,
    {"context_curator": "context_curator", "supervisor": "supervisor", "planner": "planner"},
)
graph_builder.add_conditional_edges(
    "supervisor",
    route_after_supervisor,
    {"context_curator": "context_curator", "planner": "planner", "respond": "respond"},
)


def route_after_planner(state: dict[str, Any]) -> str:
    """When plan needs approval, surface to user; else continue to context curator -> worker."""
    if state.get("plan_pending_approval"):
        return "respond"
    return "context_curator"


graph_builder.add_conditional_edges(
    "planner",
    route_after_planner,
    {"context_curator": "context_curator", "respond": "respond"},
)
graph_builder.add_edge("context_curator", "worker")


def route_after_worker(state: dict[str, Any]) -> str:
    """When Executor needs_input or stop_reason, route accordingly; else continue to Patch Integrity Gate."""
    if state.get("needs_input_question"):
        return "respond"
    stop_reason = state.get("stop_reason", "")
    if stop_reason == "needs_scope_expansion":
        return "supervisor"  # §8.5: Supervisor asks user or triggers Planner to update manifest
    if stop_reason:
        return "respond"
    return "patch_integrity_gate"


def route_after_patch_integrity_gate(state: dict[str, Any]) -> str:
    """Gate pass -> sandbox/lsp; Gate fail -> context_curator→worker (no iteration increment)."""
    if not state.get("integrity_passed", True):
        return "context_curator"
    return state.get("next_node", "sandbox")


graph_builder.add_conditional_edges(
    "worker",
    route_after_worker,
    {"respond": "respond", "supervisor": "supervisor", "patch_integrity_gate": "patch_integrity_gate"},
)
graph_builder.add_conditional_edges(
    "patch_integrity_gate",
    route_after_patch_integrity_gate,
    {"context_curator": "context_curator", "lsp_analyzer": "lsp_analyzer", "sandbox": "sandbox"},
)


def route_after_lsp(state: dict[str, Any]) -> str:
    """When lsp_mode=always: if LSP reports Severity:Error, skip Sandbox and route to context_curator→Worker."""
    if state.get("lsp_has_compile_errors"):
        return "context_curator"
    return "sandbox"


if settings.lsp_enabled and settings.lsp_mode == "always":
    graph_builder.add_conditional_edges(
        "lsp_analyzer",
        route_after_lsp,
        {"context_curator": "context_curator", "sandbox": "sandbox"},
    )
else:
    graph_builder.add_edge("lsp_analyzer", "context_curator")

graph_builder.add_conditional_edges(
    "sandbox",
    route_after_sandbox,
    {"critic": "critic", "context_curator": "context_curator", "lsp_analyzer": "lsp_analyzer", "respond": "respond"},
)
graph_builder.add_conditional_edges("critic", route_after_critic, {"respond": "respond", "supervisor": "supervisor"})
graph_builder.add_edge("respond", END)

graph = graph_builder.compile()
