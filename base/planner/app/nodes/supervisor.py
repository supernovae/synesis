"""Supervisor node -- the Erlang-style router that decides what happens next.

Uses the Mistral Nemo supervisor model to classify intent, fetch RAG context,
and route to the appropriate worker or directly to response.
"""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..failfast_cache import cache as failfast_cache
from ..failure_store import query_similar_failures
from ..rag_client import retrieve_context, select_collections_for_task
from ..state import NodeOutcome, NodeTrace, RetrievalParams
from ..web_search import format_search_results, search_client

logger = logging.getLogger("synesis.supervisor")

SUPERVISOR_SYSTEM_PROMPT = """\
You are the Supervisor in a Safety-II Joint Cognitive System called Synesis.
Your role is to analyze the user's request and decide the best course of action.

You MUST respond with valid JSON containing exactly these fields:
{
  "task_type": one of ["code_generation", "code_review", "explanation", "debugging", "shell_script", "general"],
  "task_description": "clear description of what needs to be done",
  "target_language": "the programming language (default: bash)",
  "needs_code_generation": true/false,
  "reasoning": "your reasoning for this classification",
  "assumptions": ["list", "of", "assumptions"],
  "confidence": 0.0 to 1.0
}

If the user is asking for shell/bash code, set task_type to "shell_script".
If this is a revision cycle, incorporate the critic's feedback into the task description.
"""

import re

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
    temperature=0.3,
    max_tokens=1024,
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

        revision_note = ""
        if iteration > 0 and critic_feedback:
            revision_note = (
                f"\n\nThis is revision iteration {iteration}. "
                f"The critic provided this feedback:\n{critic_feedback}\n"
                f"Please incorporate this feedback into the task description."
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
            HumanMessage(content=f"User request: {user_context}{history_block}{revision_note}"),
        ]

        response = await supervisor_llm.ainvoke(prompt_messages)

        try:
            parsed = json.loads(response.content)
        except json.JSONDecodeError:
            content = response.content
            json_start = content.find("{")
            json_end = content.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                parsed = json.loads(content[json_start:json_end])
            else:
                raise

        task_type = parsed.get("task_type", "general")
        target_language = parsed.get("target_language", "bash")
        needs_code = parsed.get("needs_code_generation", True)

        # Resolve retrieval params: per-request override > config defaults
        retrieval_params: RetrievalParams | None = state.get("retrieval_params")
        strategy = retrieval_params.strategy if retrieval_params else settings.rag_retrieval_strategy
        reranker = retrieval_params.reranker if retrieval_params else settings.rag_reranker
        top_k = retrieval_params.top_k if retrieval_params else settings.rag_top_k

        rag_results = []
        rag_context = []
        rag_collections = []
        fallback_to_bm25 = False

        if needs_code:
            task_desc = parsed.get("task_description", user_context)
            rag_collections = select_collections_for_task(
                task_type=task_type,
                target_language=target_language,
                task_description=task_desc,
            )
            if not rag_collections:
                rag_collections = [f"{target_language}_v1"]

            rag_results = await retrieve_context(
                query=task_desc,
                collections=rag_collections,
                top_k=top_k,
                strategy=strategy,
                reranker=reranker,
            )
            rag_context = [r.text for r in rag_results]
            fallback_to_bm25 = any(r.retrieval_source == "bm25" and strategy != "bm25" for r in rag_results)

        next_node = "worker" if needs_code else "respond"

        # Query failure knowledge base for similar past failures
        failure_context: list[str] = []
        if needs_code:
            task_desc = parsed.get("task_description", user_context)

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
                task_description=parsed.get("task_description", user_context),
                confidence=parsed.get("confidence", 0.5),
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
            reasoning=parsed.get("reasoning", ""),
            assumptions=parsed.get("assumptions", []),
            confidence=parsed.get("confidence", 0.5),
            outcome=NodeOutcome.SUCCESS,
            latency_ms=latency,
            tokens_used=response.usage_metadata.get("total_tokens", 0) if response.usage_metadata else 0,
        )

        logger.info(
            "supervisor_decision",
            extra={
                "task_type": task_type,
                "next_node": next_node,
                "confidence": parsed.get("confidence"),
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

        return {
            "task_type": task_type,
            "task_description": parsed.get("task_description", ""),
            "target_language": target_language,
            "rag_results": rag_results,
            "rag_context": rag_context,
            "rag_collections_queried": rag_collections,
            "rag_retrieval_strategy": strategy,
            "rag_reranker_used": reranker,
            "rag_vector_fallback_to_bm25": fallback_to_bm25,
            "failure_context": failure_context,
            "web_search_results": web_search_results,
            "web_search_queries": web_search_queries,
            "current_node": node_name,
            "next_node": next_node,
            "node_traces": [trace],
            "iteration_count": iteration,
        }

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
