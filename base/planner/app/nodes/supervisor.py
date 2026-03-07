"""Supervisor node -- Router (models.yaml: router role, Qwen3-8B).

Deterministic passthroughs handle most traffic without touching the LLM.
When the LLM is needed, it returns a minimal RouterDecision JSON (~50 tokens)
and all other state (task_size, is_code_task, target_language, allowed_tools)
flows through from EntryClassifier unchanged.
"""

from __future__ import annotations

import logging
import re
import time
from collections import Counter
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..failfast_cache import cache as failfast_cache
from ..failure_store import query_similar_failures
from ..injection_scanner import scan_and_filter_rag_context
from ..llm_telemetry import get_llm_http_client
from ..rag_client import retrieve_context, select_collections_for_task
from ..schemas import RouterDecision, make_tool_ref, parse_and_validate
from ..state import NodeOutcome, NodeTrace, RetrievalParams
from ..web_search import format_search_results, search_client

logger = logging.getLogger("synesis.supervisor")


# ── Router prompt: minimal JSON-lite schema ──
# The Router decides WHERE to send the request, nothing else.
# EntryClassifier already resolved: task_size, is_code_task, target_language,
# allowed_tools, difficulty, bypass flags.
ROUTER_SYSTEM_PROMPT = """\
You are the Router. Decide where to send this request.

Reply with JSON only:
{"route":"worker|planner|respond","rag_mode":"disabled|light|normal","reasoning":"one sentence","confidence":0.0-1.0}

Rules:
- "worker": default. Single-step tasks, explanations, code, documents.
- "planner": multi-step code tasks that need decomposition into verifiable steps.
- "respond": ONLY when critical info is missing and you must ask ONE question.
- rag_mode: "disabled" for greetings/trivial, "light" for common knowledge, "normal" for domain-specific.
"""

_SEARCH_TRIGGER_KEYWORDS = re.compile(
    r"\b(latest|current|newest|updated|upgrade|migrate|deprecated|"
    r"kubernetes|openshift|k8s|aws|azure|gcp|docker|terraform|"
    r"react|fastapi|django|flask|spring|nestjs|express|gin|"
    r"v\d+|version\s*\d)",
    re.IGNORECASE,
)

_API_KEYWORDS = re.compile(
    r"\b(api|endpoint|openapi|swagger|rest|grpc|graphql|sdk|client)\b",
    re.IGNORECASE,
)


def _should_search_supervisor(
    task_description: str,
    confidence: float,
    is_code_task: bool,
) -> tuple[bool, str, str]:
    """Decide whether to trigger a web search. Returns (should_search, query, profile)."""
    if not settings.web_search_supervisor_enabled:
        return False, "", ""
    if confidence < 0.7:
        return True, task_description[:200], "web"
    if _SEARCH_TRIGGER_KEYWORDS.search(task_description):
        if _API_KEYWORDS.search(task_description):
            return True, task_description[:200], "code"
        return True, task_description[:200], "web"
    return False, "", ""


supervisor_llm = ChatOpenAI(
    base_url=settings.supervisor_model_url,
    api_key="not-needed",
    model=settings.supervisor_model_name,
    temperature=0.0,
    max_completion_tokens=256,
    use_responses_api=False,
    http_client=get_llm_http_client(uds_path=settings.supervisor_model_uds or None),
    model_kwargs={"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
)


def _build_passthrough_result(
    state: dict[str, Any],
    *,
    next_node: str,
    reasoning: str,
    log_event: str,
    start: float,
    extra_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a deterministic passthrough result (no LLM call)."""
    user_context = _get_user_context(state)
    task_desc = (user_context or "").strip()[:1000] or state.get("task_description", "")
    is_code_task = state.get("is_code_task", True)
    latency = (time.monotonic() - start) * 1000

    trace = NodeTrace(
        node_name="supervisor",
        reasoning=reasoning,
        assumptions=[],
        confidence=1.0,
        outcome=NodeOutcome.SUCCESS,
        latency_ms=latency,
    )
    logger.info(log_event, extra={"latency_ms": latency})

    result: dict[str, Any] = {
        "task_type": state.get("task_type", "general"),
        "task_description": task_desc,
        "target_language": state.get("target_language") or "markdown",
        "assumptions": [],
        "defaults_used": [],
        "task_is_trivial": state.get("task_is_trivial", False),
        "is_code_task": is_code_task,
        "include_tests": is_code_task and state.get("task_size") == "hard",
        "include_run_commands": is_code_task,
        "allowed_tools": state.get("allowed_tools", ["none"] if not is_code_task else ["sandbox", "lsp"]),
        "rag_mode": "disabled" if not is_code_task else state.get("rag_mode", "normal"),
        "needs_code_generation": is_code_task,
        "rag_results": [],
        "rag_context": [],
        "rag_collections_queried": [],
        "tool_refs": state.get("tool_refs") or [],
        "failure_context": state.get("failure_context", []),
        "web_search_results": state.get("web_search_results", []),
        "web_search_queries": state.get("web_search_queries", []),
        "current_node": "supervisor",
        "next_node": next_node,
        "generated_code": state.get("generated_code", ""),
        "code_explanation": state.get("code_explanation", ""),
        "patch_ops": state.get("patch_ops", []) or [],
        "node_traces": [trace],
    }
    if extra_fields:
        result.update(extra_fields)
    return result


def _get_user_context(state: dict[str, Any]) -> str:
    """Extract the last human message content from state."""
    for m in reversed(state.get("messages", [])):
        if hasattr(m, "type") and m.type == "human":
            return m.content
    return ""


async def supervisor_node(state: dict[str, Any]) -> dict[str, Any]:
    start = time.monotonic()
    node_name = "supervisor"

    try:
        iteration = state.get("iteration_count", 0)
        critic_feedback = state.get("critic_feedback", "")
        conversation_history = state.get("conversation_history", [])
        user_context = _get_user_context(state)
        task_size = state.get("task_size", "medium")
        is_code_task = state.get("is_code_task", True)

        # ── Passthrough 1: hard + plan_required → Planner (no LLM) ──
        if task_size == "hard" and state.get("plan_required") and iteration == 0:
            return _build_passthrough_result(
                state,
                next_node="planner",
                reasoning="Hard+plan_required from EntryClassifier → Planner",
                log_event="supervisor_passthrough_complex",
                start=start,
                extra_fields={"is_code_task": True, "include_tests": True},
            )

        # ── Passthrough 2: is_code_task=false → Worker (no LLM) ──
        # Skip passthrough when plan_required (critic retry loop needs full supervisor path)
        if not is_code_task and iteration == 0 and not state.get("plan_required"):
            return _build_passthrough_result(
                state,
                next_node="worker",
                reasoning="Taxonomy: is_code_task=false → Worker",
                log_event="supervisor_passthrough_explain_only",
                start=start,
                extra_fields={
                    "is_code_task": False,
                    "target_language": "markdown",
                    "allowed_tools": ["none"],
                    "rag_mode": "disabled",
                    "active_domain_refs": state.get("active_domain_refs"),
                    "platform_context": state.get("platform_context"),
                },
            )

        # ── LLM routing path ──
        # Build concise prompt with EntryClassifier context
        context_parts = [f"User request: {user_context}"]

        if state.get("user_answer_to_clarification"):
            context_parts.append(f"User answered clarification: {state['user_answer_to_clarification']}")

        if iteration > 0 and critic_feedback:
            context_parts.append(f"Revision {iteration}. Critic feedback: {critic_feedback}")

        if state.get("intent_classifier_source") == "deterministic":
            context_parts.append(
                f"Pre-classified: task_size={task_size}, "
                f"is_code_task={is_code_task}, "
                f"intent={state.get('intent_class', 'unknown')}"
            )

        if conversation_history and iteration == 0:
            recent = conversation_history[-6:]
            history_lines = "\n".join(f"- {h}" if not str(h).startswith("- ") else str(h) for h in recent)
            context_parts.append(f"Recent conversation:\n{history_lines}")

        if state.get("scope_expansion_needed"):
            context_parts.append(
                f"Scope expansion needed: {state.get('scope_expansion_reason', 'Worker needs more files')}"
            )

        prompt_messages = [
            SystemMessage(content=ROUTER_SYSTEM_PROMPT),
            HumanMessage(content="\n\n".join(context_parts)),
        ]

        response = await supervisor_llm.ainvoke(prompt_messages)

        try:
            decision = parse_and_validate(response.content, RouterDecision)
        except Exception as parse_err:
            logger.warning("router_parse_failed: %s, defaulting to worker", parse_err)
            decision = RouterDecision(
                route="worker",
                rag_mode="disabled",
                reasoning="Parse fallback",
                confidence=0.5,
            )

        # ── Clarification path ──
        if decision.needs_clarification and decision.clarification_question:
            latency = (time.monotonic() - start) * 1000
            trace = NodeTrace(
                node_name=node_name,
                reasoning=decision.reasoning,
                assumptions=[],
                confidence=decision.confidence,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=latency,
                tokens_used=response.usage_metadata.get("total_tokens", 0)
                if (response and response.usage_metadata)
                else 0,
            )
            logger.info("supervisor_clarification_request", extra={"question": decision.clarification_question[:80]})
            return {
                "task_type": state.get("task_type", "general"),
                "task_description": state.get("task_description", user_context),
                "target_language": state.get("target_language") or "markdown",
                "clarification_question": decision.clarification_question,
                "clarification_options": [],
                "assumptions": [],
                "defaults_used": [],
                "current_node": node_name,
                "next_node": "respond",
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
                "node_traces": [trace],
            }

        # ── Resolve route: LLM decision + policy guards ──
        next_node = decision.route
        supervisor_guard = state.get("supervisor_clarification_only", False)
        if supervisor_guard and next_node == "planner":
            next_node = "worker"
        if not is_code_task and next_node == "planner" and not state.get("plan_required"):
            next_node = "worker"

        # ── RAG retrieval ──
        rag_mode = decision.rag_mode
        target_language = state.get("target_language") or "markdown"
        task_desc = state.get("task_description") or user_context or ""

        retrieval_params: RetrievalParams | None = state.get("retrieval_params")
        strategy = retrieval_params.strategy if retrieval_params else settings.rag_retrieval_strategy
        reranker = retrieval_params.reranker if retrieval_params else settings.rag_reranker
        top_k = retrieval_params.top_k if retrieval_params else settings.rag_top_k
        fetch_count = getattr(settings, "rag_overfetch_count", None) or top_k
        if state.get("rag_gravity") == "light":
            fetch_count = min(fetch_count, 5)

        rag_results = []
        rag_context = []
        rag_collections = []
        fallback_to_bm25 = False

        if is_code_task and rag_mode != "disabled":
            task_type = state.get("task_type", "general")
            rag_collections, rag_domain_filter = select_collections_for_task(
                task_type=task_type,
                target_language=target_language,
                task_description=task_desc,
                platform_context=state.get("platform_context") or None,
                active_domain_refs=state.get("active_domain_refs") or None,
            )
            if not rag_collections:
                rag_collections = [f"{target_language}_v1"]

            rag_results = await retrieve_context(
                query=task_desc,
                collections=rag_collections,
                top_k=fetch_count,
                strategy=strategy,
                reranker=reranker,
                domain_filter=rag_domain_filter or "",
            )
            rag_context = [r.text for r in rag_results]
            if settings.injection_scan_enabled and rag_context:
                rag_context, rag_injection, rag_details = scan_and_filter_rag_context(
                    rag_context,
                    action=settings.injection_action,
                )
                if rag_injection:
                    logger.warning(
                        "injection_scan_rag",
                        extra={"chunks_affected": len(rag_details), "details": rag_details[:5]},
                    )
            fallback_to_bm25 = any(r.retrieval_source == "bm25" and strategy != "bm25" for r in rag_results)

        # ── Failure knowledge base ──
        failure_context: list[str] = []
        if is_code_task and rag_mode != "disabled":
            cache_hints = failfast_cache.get_hints(task_desc, target_language)
            if cache_hints:
                failure_context.extend(cache_hints)

            try:
                similar_failures = await query_similar_failures(
                    task_description=task_desc,
                    language=target_language,
                    top_k=3,
                )
                for f in similar_failures:
                    summary = f"[{f['error_type']}] {f['task_description'][:200]} → {f['error_output'][:200]}"
                    if f.get("resolution"):
                        summary += f" (resolved with: {f['resolution'][:200]})"
                    failure_context.append(summary)
            except Exception as e:
                logger.warning("failure_store_query_failed: %s", e)

        # ── Web search ──
        web_search_results: list[str] = []
        web_search_queries: list[str] = []
        if rag_mode != "disabled" and settings.web_search_enabled:
            should_search, search_query, search_profile = _should_search_supervisor(
                task_description=task_desc,
                confidence=decision.confidence,
                is_code_task=is_code_task,
            )
            if should_search:
                results = await search_client.search(search_query, profile=search_profile)
                web_search_results = format_search_results(results)
                if results:
                    web_search_queries.append(f"[{search_profile}] {search_query[:120]}")
                    logger.info(
                        "supervisor_web_search",
                        extra={"profile": search_profile, "query": search_query[:120], "results_count": len(results)},
                    )

        source_counts = Counter(r.retrieval_source for r in rag_results)
        latency = (time.monotonic() - start) * 1000

        trace = NodeTrace(
            node_name=node_name,
            reasoning=decision.reasoning,
            assumptions=[],
            confidence=decision.confidence,
            outcome=NodeOutcome.SUCCESS,
            latency_ms=latency,
            tokens_used=response.usage_metadata.get("total_tokens", 0) if (response and response.usage_metadata) else 0,
        )

        logger.info(
            "supervisor_decision",
            extra={
                "route": next_node,
                "rag_mode": rag_mode,
                "confidence": decision.confidence,
                "iteration": iteration,
                "latency_ms": latency,
                "retrieval_strategy": strategy,
                "rag_results_count": len(rag_results),
                "retrieval_sources": dict(source_counts),
                "user_id": state.get("user_id", "anonymous"),
            },
        )

        existing_refs = state.get("tool_refs") or []
        if rag_results:
            rag_tool_ref = make_tool_ref(
                "rag",
                {
                    "query": task_desc[:500],
                    "collections": rag_collections,
                    "top_k": fetch_count,
                    "strategy": strategy,
                    "reranker": reranker,
                },
                {"count": len(rag_results), "sources": [getattr(r, "source", "") for r in rag_results[:5]]},
            )
            tool_refs = [*existing_refs, rag_tool_ref.model_dump()]
        else:
            tool_refs = existing_refs

        # ── Build output: state passthrough + LLM route decision ──
        out: dict[str, Any] = {
            "task_type": state.get("task_type", "general"),
            "task_description": task_desc,
            "target_language": target_language,
            "assumptions": [],
            "defaults_used": [],
            "task_is_trivial": state.get("task_is_trivial", False),
            "is_code_task": is_code_task,
            "include_tests": is_code_task and task_size == "hard",
            "include_run_commands": is_code_task,
            "allowed_tools": state.get("allowed_tools", ["none"] if not is_code_task else ["sandbox", "lsp"]),
            "rag_mode": rag_mode,
            "rag_results": rag_results,
            "rag_context": rag_context,
            "rag_collections_queried": rag_collections,
            "tool_refs": tool_refs,
            "rag_retrieval_strategy": strategy,
            "rag_reranker_used": reranker,
            "rag_vector_fallback_to_bm25": fallback_to_bm25,
            "failure_context": failure_context,
            "web_search_results": web_search_results,
            "web_search_queries": web_search_queries,
            "current_node": node_name,
            "next_node": next_node,
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "node_traces": [trace],
        }

        # Scope expansion: expand touched_files so Worker retry doesn't loop
        if state.get("scope_expansion_needed") and next_node == "worker":
            requested = state.get("requested_files", []) or []
            current = state.get("touched_files", []) or []
            seen = {p.rstrip("/") for p in current if p}
            expanded = list(current)
            for p in requested:
                if p and p.rstrip("/") not in seen:
                    expanded.append(p)
                    seen.add(p.rstrip("/"))
            if expanded != current:
                out["touched_files"] = expanded

        # SupervisorGuard: preserve Critic's evidence context
        if supervisor_guard and next_node == "worker":
            for key in (
                "evidence_needed",
                "evidence_gap",
                "strategy_candidates",
                "revision_strategy",
                "revision_constraints",
                "task_description",
                "critic_feedback",
            ):
                if key in state and state[key] is not None:
                    out[key] = state[key]

        return out

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.exception("supervisor_error")
        trace = NodeTrace(
            node_name=node_name,
            reasoning=f"Error: {e}",
            assumptions=[],
            confidence=0.0,
            outcome=NodeOutcome.ERROR,
            latency_ms=latency,
        )
        return {
            "current_node": node_name,
            "next_node": "respond",
            "error": str(e),
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "node_traces": [trace],
        }
