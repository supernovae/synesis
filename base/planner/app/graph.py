"""Synesis LangGraph -- the core orchestration loop.

Implements a 5-node cycle with Erlang-style fail-fast semantics:
  [User Input] -> [Supervisor] -> [Worker] -> [Executor] -> [Critic] -> [Response]
                       ^             ^            |              |
                       |             |   (fail)   |              |
                       |             +--[LSP]<----+              |
                       +---------- (needs_revision) ------------+

The Executor runs generated code in an isolated sandbox pod with linting
and security scanning. On failure, the LSP Analyzer enriches error
context with deep type checking before routing back to Worker. Each node
returns typed state updates. The graph routes conditionally based on
state['next_node']. Max iterations prevent infinite loops.

When lsp_mode="always", the LSP Analyzer also runs between Worker and
Executor on every code generation pass (not just failures).
"""

from __future__ import annotations

import asyncio
import logging
from functools import wraps
from typing import Any

from langgraph.graph import END, StateGraph

from .config import settings
from .nodes import critic_node, executor_node, lsp_analyzer_node, supervisor_node, worker_node
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


def route_after_supervisor(state: dict[str, Any]) -> str:
    next_node = state.get("next_node", "respond")
    if state.get("error"):
        return "respond"
    if next_node == "worker":
        return "worker"
    return "respond"


def route_after_executor(state: dict[str, Any]) -> str:
    """Route based on sandbox execution results.

    On failure with lsp_mode="on_failure", routes to lsp_analyzer for
    deep diagnostics before sending back to worker. In "always" mode,
    LSP already ran pre-execution so we go directly to worker.
    """
    if state.get("error"):
        return "respond"
    exit_code = state.get("execution_exit_code")
    if exit_code is None or exit_code == 0:
        return "critic"
    iteration = state.get("iteration_count", 0)
    max_iter = state.get("max_iterations", settings.max_iterations)
    if iteration >= max_iter:
        return "respond"
    if settings.lsp_enabled and settings.lsp_mode == "on_failure":
        return "lsp_analyzer"
    return "worker"


def route_after_critic(state: dict[str, Any]) -> str:
    if state.get("error"):
        return "respond"
    if state.get("critic_approved", True):
        return "respond"
    iteration = state.get("iteration_count", 0)
    max_iter = state.get("max_iterations", settings.max_iterations)
    if iteration >= max_iter:
        return "respond"
    return "supervisor"


def respond_node(state: dict[str, Any]) -> dict[str, Any]:
    """Terminal node -- assembles the final response for the user."""
    from langchain_core.messages import AIMessage

    code = state.get("generated_code", "")
    explanation = state.get("code_explanation", "")
    what_ifs = state.get("what_if_analyses", [])
    error = state.get("error")
    traces = state.get("node_traces", [])

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

executor_timeout = settings.sandbox_timeout_seconds + 15
lsp_timeout = settings.lsp_timeout_seconds + 5

graph_builder.add_node("supervisor", with_timeout(timeout)(supervisor_node))
graph_builder.add_node("worker", with_timeout(timeout)(worker_node))
graph_builder.add_node("executor", with_timeout(executor_timeout)(executor_node))
graph_builder.add_node("lsp_analyzer", with_timeout(lsp_timeout)(lsp_analyzer_node))
graph_builder.add_node("critic", with_timeout(timeout)(critic_node))
graph_builder.add_node("respond", respond_node)

graph_builder.set_entry_point("supervisor")
graph_builder.add_conditional_edges("supervisor", route_after_supervisor, {"worker": "worker", "respond": "respond"})

if settings.lsp_enabled and settings.lsp_mode == "always":
    graph_builder.add_edge("worker", "lsp_analyzer")
    graph_builder.add_edge("lsp_analyzer", "executor")
else:
    graph_builder.add_edge("worker", "executor")
    graph_builder.add_edge("lsp_analyzer", "worker")

graph_builder.add_conditional_edges(
    "executor",
    route_after_executor,
    {"critic": "critic", "worker": "worker", "lsp_analyzer": "lsp_analyzer", "respond": "respond"},
)
graph_builder.add_conditional_edges("critic", route_after_critic, {"respond": "respond", "supervisor": "supervisor"})
graph_builder.add_edge("respond", END)

graph = graph_builder.compile()
