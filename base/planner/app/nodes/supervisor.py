"""Supervisor node -- the Erlang-style router that decides what happens next.

Uses the supervisor model to classify intent, fetch RAG context, and route.
JCS: can request clarification or suggest planning instead of guessing.
"""

from __future__ import annotations

import logging
import time
from collections import Counter
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..failfast_cache import cache as failfast_cache
from ..failure_store import query_similar_failures
from ..injection_scanner import scan_and_filter_rag_context
from ..rag_client import retrieve_context, select_collections_for_task
from ..schemas import SupervisorOut, make_tool_ref, parse_and_validate
from ..state import NodeOutcome, NodeTrace, RetrievalParams, TaskType
from ..web_search import format_search_results, search_client

logger = logging.getLogger("synesis.supervisor")

SUPERVISOR_SYSTEM_PROMPT = """\
You are the Supervisor. Goal: minimize user effort, maximize forward progress. Stop unnecessary clarification while staying safe.

1) TARGET LANGUAGE — Parse from user request. Never assume bash unless explicitly requested.
   Supported: python, javascript, typescript, go, rust, java, csharp, kotlin, ruby, php, swift, bash.
   When unspecified: infer from context (.py file, "learning to code"). Last resort: python.

2) ASSUMPTION ENGINE — Decide what is missing and whether it can be safely defaulted.
   - Parse: task complexity (trivial/small/multi-step/risky), missing inputs, whether defaults exist.
   - If trivial and language known: proceed with defaults. Never ask clarification.
   - Produce assumptions_structured: [{key, value, confidence, user_visible}] for assumptions you're making.
   - defaults_used: list of defaults applied (e.g. "pytest", "Python 3.11", "repo root writable").

3) INTENT + OUTPUT SHAPE — What format should the answer take?
   - deliverable_type: snippet | single_file | multi_file_patch | explain_only | mixed
   - Default: single_file for learning/code tasks. snippet for quick one-liners. explain_only when user asks "why" or "explain".
   - include_tests: true for code tasks unless user says "no tests". include_run_commands: true.
   - interaction_mode: "teach" when user says "I'm learning", "explain", "why" — then include brief explanation, run commands, tests. Otherwise "do" (just code + commands).

4) TRIVIAL-TASK FAST PATH — If trigger matches, proceed immediately. No questions.
   Triggers: "hello world", "write a script that prints X", "parse this json", "unit test for this function", simple print/function, basic test.
   Output: bypass_planner=true, bypass_clarification=true, route_to=worker, task_is_trivial=true.

5) CLARIFICATION — Ask only when required input is missing AND cannot be defaulted.
   Policy: Never ask if task_is_trivial and defaults exist.
   When you do ask: ONE question max. Prefer multiple-choice. clarification_options: ["(A) pytest (default)", "(B) unittest"].

6) TOOL GATING — Which tools does this task need?
   - "explain" or "simple code" / explain_only → allowed_tools: ["none"]
   - Debugging runtime error → allow sandbox, LSP as needed. Code generation → ["sandbox","lsp"].

7) ROUTING — route_to: worker (trivial/normal), planner (multi-step), respond (clarification needed).
   If task_is_trivial && target_language && !needs_clarification → route_to=worker, bypass_planner=true.

Return valid JSON:
{
  "task_type": "code_generation"|"code_review"|"explanation"|"debugging"|"shell_script"|"general",
  "task_description": "clear description",
  "target_language": "parsed from user",
  "needs_code_generation": true|false,
  "reasoning": "brief",
  "assumptions": ["human-readable list"],
  "assumptions_structured": [{"key":"test_runner","value":"pytest","confidence":0.9,"user_visible":true}],
  "defaults_used": ["pytest","Python 3.11"],
  "confidence": 0.0-1.0,
  "needs_clarification": false,
  "clarification_question": null,
  "clarification_options": [],
  "planning_suggested": false,
  "route_to": "worker"|"planner"|"respond",
  "task_is_trivial": true|false,
  "bypass_planner": true|false,
  "bypass_clarification": true|false,
  "deliverable_type": "snippet"|"single_file"|"multi_file_patch"|"explain_only"|"mixed",
  "interaction_mode": "teach"|"do",
  "include_tests": true|false,
  "include_run_commands": true|false,
  "allowed_tools": ["sandbox","lsp"]|["none"]
}

If this is a revision cycle, incorporate the critic's feedback into task_description.
"""

import re

# Ordered: more specific patterns first (e.g. typescript before script)
_LANGUAGE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\btypescript\b", re.IGNORECASE), "typescript"),
    (re.compile(r"\bjavascript\b|\.js\b|\.jsx\b|\.mjs\b", re.IGNORECASE), "javascript"),
    (re.compile(r"\bpython\b|\.py\b|learning\s+python", re.IGNORECASE), "python"),
    (re.compile(r"\bgolang\b|\bgo\s+(?:lang|code|script|program)\b|in\s+go\b|using\s+go\b|\.go\b", re.IGNORECASE), "go"),
    (re.compile(r"\brust\b|\.rs\b", re.IGNORECASE), "rust"),
    (re.compile(r"\bjava\b(?!\s+script)|\bkotlin\b|\.java\b|\.kt\b", re.IGNORECASE), "java"),
    (re.compile(r"\bc#\b|csharp\b|\.cs\b", re.IGNORECASE), "csharp"),
    (re.compile(r"\bruby\b|\.rb\b", re.IGNORECASE), "ruby"),
    (re.compile(r"\bphp\b|\.php\b", re.IGNORECASE), "php"),
    (re.compile(r"\bswift\b|\.swift\b", re.IGNORECASE), "swift"),
    (re.compile(r"\bbash\b|shell\b|\.sh\b|\.bash\b|sh script", re.IGNORECASE), "bash"),
]

DEFAULT_LANGUAGE = "python"


def _extract_language_from_text(text: str) -> str:
    """Parse target language from user message. Returns normalized name or DEFAULT_LANGUAGE."""
    if not text or not text.strip():
        return DEFAULT_LANGUAGE
    lower = text.lower()
    for pattern, lang in _LANGUAGE_PATTERNS:
        if pattern.search(text):
            return lang
    return DEFAULT_LANGUAGE


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
    needs_code: bool,
) -> tuple[bool, str, str]:
    """Decide whether the supervisor should trigger a web search.

    Returns (should_search, query, profile).
    """
    if not settings.web_search_supervisor_enabled or not needs_code:
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
    max_tokens=1536,
)


async def supervisor_node(state: dict[str, Any]) -> dict[str, Any]:
    start = time.monotonic()
    node_name = "supervisor"

    try:
        messages = state.get("messages", [])
        iteration = state.get("iteration_count", 0)
        critic_feedback = state.get("critic_feedback", "")

        conversation_history = state.get("conversation_history", [])

        user_context = ""
        if messages:
            last_user = next(
                (m for m in reversed(messages) if hasattr(m, "type") and m.type == "human"),
                None,
            )
            if last_user:
                user_context = last_user.content

        clarification_answer_block = ""
        user_answer_to_clarification = state.get("user_answer_to_clarification", "")
        if user_answer_to_clarification:
            clarification_answer_block = (
                f"\n\n## User answered your clarification\n"
                f"The user provided: {user_answer_to_clarification}\n"
                f"Incorporate this into the task description and proceed accordingly."
            )

        revision_note = ""
        if iteration > 0 and critic_feedback:
            revision_note = (
                f"\n\nThis is revision iteration {iteration}. "
                f"The critic provided this feedback:\n{critic_feedback}\n"
                f"Please incorporate this feedback into the task description."
            )
        scope_expansion_note = ""
        if state.get("scope_expansion_needed"):
            requested = state.get("requested_files", [])
            expl = (
                state.get("scope_expansion_reason")
                or state.get("stop_reason_explanation", "")
                or "Worker needs to touch files not in the execution plan."
            )
            files_str = ", ".join(requested[:5]) if requested else "(unlisted)"
            scope_expansion_note = (
                f"\n\n**Scope expansion needed:** {expl}\n"
                f"Requested files: {files_str}\n"
                f"Either ask the user to confirm which files to add, or set planning_suggested=true "
                f"to trigger Planner to update touched_files (deterministic: no extra planning chatter)."
            )

        history_block = ""
        if conversation_history and iteration == 0:
            history_lines = "\n".join(f"- {h}" for h in conversation_history[-10:])
            history_block = (
                f"\n\n## Conversation History\n"
                f"The user has had previous interactions. Recent context:\n"
                f"{history_lines}\n\n"
                f'Use this context to understand references like "it", '
                f'"that script", "the previous one", etc.'
            )

        prompt_messages = [
            SystemMessage(content=SUPERVISOR_SYSTEM_PROMPT),
            HumanMessage(
                content=f"User request: {user_context}{clarification_answer_block}{history_block}{revision_note}{scope_expansion_note}"
            ),
        ]

        response = await supervisor_llm.ainvoke(prompt_messages)

        try:
            parsed = parse_and_validate(response.content, SupervisorOut)
        except Exception as e:
            logger.warning(f"Supervisor schema validation failed: {e}, using fallback parse")
            import json

            content = response.content
            json_start = content.find("{")
            json_end = content.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                try:
                    data = json.loads(content[json_start:json_end])
                except json.JSONDecodeError:
                    data = {}
            else:
                data = {}

            if data:
                parsed = SupervisorOut(
                    task_type=TaskType(data.get("task_type", "general")),
                    task_description=data.get("task_description", ""),
                    target_language=data.get("target_language") or _extract_language_from_text(user_context),
                    needs_code_generation=data.get("needs_code_generation", True),
                    reasoning=data.get("reasoning", ""),
                    assumptions=data.get("assumptions", []),
                    confidence=data.get("confidence", 0.5),
                    needs_clarification=data.get("needs_clarification", False),
                    clarification_question=data.get("clarification_question"),
                    clarification_options=data.get("clarification_options", []),
                    planning_suggested=data.get("planning_suggested", False),
                    route_to=data.get("route_to"),
                    task_is_trivial=data.get("task_is_trivial", False),
                    bypass_planner=data.get("bypass_planner", False),
                    bypass_clarification=data.get("bypass_clarification", False),
                    deliverable_type=data.get("deliverable_type", "single_file"),
                    interaction_mode=data.get("interaction_mode", "do"),
                    include_tests=data.get("include_tests", True),
                    include_run_commands=data.get("include_run_commands", True),
                    allowed_tools=data.get("allowed_tools") or ["sandbox", "lsp"],
                    assumptions_structured=data.get("assumptions_structured") or [],
                    defaults_used=data.get("defaults_used") or [],
                )
            else:
                # Truncated or empty: infer from user message and proceed (avoid clarification loop)
                user_msg = user_context if user_context else ""
                parsed = SupervisorOut(
                    task_type=TaskType.CODE_GENERATION,
                    task_description=user_msg or "Generate code as requested",
                    target_language=_extract_language_from_text(user_msg),
                    needs_code_generation=True,
                    needs_clarification=False,
                    route_to="worker",
                    task_is_trivial=True,
                    bypass_planner=True,
                    bypass_clarification=True,
                    deliverable_type="single_file",
                    interaction_mode="do",
                    reasoning="Fallback: schema parse failed, proceeding with inferred task",
                    confidence=0.5,
                )

        task_type = parsed.task_type.value if isinstance(parsed.task_type, TaskType) else str(parsed.task_type)
        target_language = (parsed.target_language or "").strip() or _extract_language_from_text(user_context)
        needs_code = parsed.needs_code_generation

        # Policy: never ask clarification if trivial and language known (trivial tasks always have implicit defaults)
        bypass_clarification = getattr(parsed, "bypass_clarification", False) or (
            getattr(parsed, "task_is_trivial", False) and target_language
        )
        if bypass_clarification and parsed.needs_clarification:
            parsed = parsed.model_copy(update={"needs_clarification": False, "clarification_question": None})
            logger.info("supervisor_bypass_clarification", extra={"reason": "trivial_with_defaults"})

        # §7.8 / Item 1: SupervisorGuard mode — when from Critic, only clarification or forward.
        # May NOT modify evidence_needed, strategy_candidates, or planning. Passthrough to Worker.
        supervisor_guard = state.get("supervisor_clarification_only", False)
        if supervisor_guard:
            if parsed.planning_suggested:
                logger.info(
                    "supervisor_guard_override", extra={"reason": "planning_suggested disallowed in SupervisorGuard"}
                )
            planning_suggested = False
        elif state.get("scope_expansion_needed"):
            # Worker needs files not in touched_files; prefer Planner to update manifest
            planning_suggested = True
        else:
            planning_suggested = parsed.planning_suggested

        # JCS: route to respond when clarification needed
        if parsed.needs_clarification and parsed.clarification_question:
            next_node = "respond"
            latency = (time.monotonic() - start) * 1000
            trace = NodeTrace(
                node_name=node_name,
                reasoning=parsed.reasoning,
                assumptions=parsed.assumptions,
                confidence=parsed.confidence,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=latency,
                tokens_used=response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0,
            )
            logger.info("supervisor_clarification_request", extra={"question": parsed.clarification_question[:80]})
            return {
                "task_type": task_type,
                "task_description": parsed.task_description,
                "target_language": target_language,
                "clarification_question": parsed.clarification_question,
                "clarification_options": parsed.clarification_options,
                "assumptions": parsed.assumptions,
                "defaults_used": getattr(parsed, "defaults_used", []),
                "assumptions_structured": getattr(parsed, "assumptions_structured", []),
                "current_node": node_name,
                "next_node": next_node,
                "node_traces": [trace],
            }

        # Resolve retrieval params: per-request override > config defaults
        retrieval_params: RetrievalParams | None = state.get("retrieval_params")
        strategy = retrieval_params.strategy if retrieval_params else settings.rag_retrieval_strategy
        reranker = retrieval_params.reranker if retrieval_params else settings.rag_reranker
        top_k = retrieval_params.top_k if retrieval_params else settings.rag_top_k
        fetch_count = getattr(settings, "rag_overfetch_count", None) or top_k

        rag_results = []
        rag_context = []
        rag_collections = []
        fallback_to_bm25 = False

        if needs_code:
            task_desc = parsed.task_description or user_context
            rag_collections = select_collections_for_task(
                task_type=task_type,
                target_language=target_language,
                task_description=task_desc,
            )
            if not rag_collections:
                rag_collections = [f"{target_language}_v1"]

            rag_params = {
                "query": task_desc[:500],
                "collections": rag_collections,
                "top_k": fetch_count,
                "strategy": strategy,
                "reranker": reranker,
            }
            rag_results = await retrieve_context(
                query=task_desc,
                collections=rag_collections,
                top_k=fetch_count,
                strategy=strategy,
                reranker=reranker,
            )
            rag_result_summary = {
                "count": len(rag_results),
                "sources": [getattr(r, "source", "") for r in rag_results[:5]],
            }
            rag_tool_ref = make_tool_ref("rag", rag_params, rag_result_summary)
            rag_context = [r.text for r in rag_results]
            # IDE coordination: scan RAG for prompt injection
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

        # Prefer route_to from LLM when valid; respect bypass_planner and supervisor_guard
        route_to = getattr(parsed, "route_to", None)
        bypass_planner = getattr(parsed, "bypass_planner", False) or getattr(parsed, "task_is_trivial", False)
        if route_to in ("worker", "planner", "respond"):
            if supervisor_guard and route_to == "planner":
                next_node = "worker"
            elif bypass_planner and route_to == "planner":
                next_node = "worker"  # Trivial fast path: skip planner
            else:
                next_node = route_to
        else:
            if bypass_planner and needs_code:
                next_node = "worker"
            else:
                next_node = "planner" if (needs_code and planning_suggested) else ("worker" if needs_code else "respond")

        # Query failure knowledge base for similar past failures
        failure_context: list[str] = []
        if needs_code:
            task_desc = parsed.task_description or user_context

            # 1. Check fail-fast cache (instant, in-memory)
            cache_hints = failfast_cache.get_hints(task_desc, target_language)
            if cache_hints:
                failure_context.extend(cache_hints)
                logger.info(f"Fail-fast cache hit for {target_language} task")

            # 2. Query failure vector store (Milvus)
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
                logger.warning(f"Failure store query failed: {e}")

        # Web search: context discovery and grounding
        web_search_results: list[str] = []
        web_search_queries: list[str] = []
        if needs_code and settings.web_search_enabled:
            should_search, search_query, search_profile = _should_search_supervisor(
                task_description=parsed.task_description or user_context,
                confidence=parsed.confidence,
                needs_code=needs_code,
            )
            if should_search:
                results = await search_client.search(search_query, profile=search_profile)
                web_search_results = format_search_results(results)
                if results:
                    web_search_queries.append(f"[{search_profile}] {search_query[:120]}")
                    logger.info(
                        "supervisor_web_search",
                        extra={
                            "profile": search_profile,
                            "query": search_query[:120],
                            "results_count": len(results),
                        },
                    )

        # Observability: log retrieval source distribution
        source_counts = Counter(r.retrieval_source for r in rag_results)

        latency = (time.monotonic() - start) * 1000
        trace = NodeTrace(
            node_name=node_name,
            reasoning=parsed.reasoning,
            assumptions=parsed.assumptions,
            confidence=parsed.confidence,
            outcome=NodeOutcome.SUCCESS,
            latency_ms=latency,
            tokens_used=response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0,
        )

        logger.info(
            "supervisor_decision",
            extra={
                "task_type": task_type,
                "next_node": next_node,
                "confidence": parsed.confidence,
                "iteration": iteration,
                "latency_ms": latency,
                "retrieval_strategy": strategy,
                "reranker": reranker,
                "rag_results_count": len(rag_results),
                "retrieval_sources": dict(source_counts),
                "fallback_to_bm25": fallback_to_bm25,
                "user_id": state.get("user_id", "anonymous"),
                "conversation_history_turns": len(conversation_history),
            },
        )

        existing_refs = state.get("tool_refs") or []
        tool_refs = [*existing_refs, rag_tool_ref.model_dump()] if rag_results else existing_refs

        # SupervisorGuard: preserve evidence_needed, strategy_candidates; do NOT overwrite with LLM output
        out: dict[str, Any] = {
            "task_type": task_type,
            "task_description": parsed.task_description,
            "target_language": target_language,
            "assumptions": parsed.assumptions,
            "defaults_used": getattr(parsed, "defaults_used", []),
            "assumptions_structured": getattr(parsed, "assumptions_structured", []),
            "deliverable_type": getattr(parsed, "deliverable_type", "single_file"),
            "interaction_mode": getattr(parsed, "interaction_mode", "do"),
            "include_tests": getattr(parsed, "include_tests", True),
            "include_run_commands": getattr(parsed, "include_run_commands", True),
            "allowed_tools": getattr(parsed, "allowed_tools", ["sandbox", "lsp"]),
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
            "node_traces": [trace],
        }
        if supervisor_guard and next_node == "worker":
            # Passthrough: preserve Critic's evidence context; Supervisor must not rewrite experiment
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
            "node_traces": [trace],
        }
