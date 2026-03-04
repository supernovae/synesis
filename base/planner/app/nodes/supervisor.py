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
from ..llm_telemetry import get_llm_http_client
from ..rag_client import retrieve_context, select_collections_for_task
from ..schemas import SupervisorOut, make_tool_ref, parse_and_validate
from ..state import NodeOutcome, NodeTrace, RetrievalParams, TaskType
from ..web_search import format_search_results, search_client

logger = logging.getLogger("synesis.supervisor")

# Anemic Supervisor: ROUTING only. EntryClassifier handles complexity; Planner handles decomposition.
# Target: sub-500ms. Keep prompt static for vLLM prefix caching.
SUPERVISOR_SYSTEM_PROMPT = """\
You are the Supervisor — a ROUTER for a coding assistant. You do NOT reason about architecture or implementation. You route.

When "Pre-classified (EntryClassifier)" is present: use task_size and target_language. Do not re-classify.

Rules:
1. target_language: python|javascript|typescript|go|rust|java|bash|markdown|... Infer from user message. When target_language=infer: use "markdown" for plans, documents, explanations, how-tos; use "python" only when user clearly asks for code. Work from the prompt, do not assume code.
2. route_to: "worker" (single step or text output), "planner" (multi-step code), "respond" (clarification only).
3. UI-helper/meta ("suggest follow-up", "JSON array") → task_type="general", needs_code_generation=false, route_to="respond".
4. Trivial (hello world, simple print, unit test) → route_to=worker, bypass_planner=true, rag_mode=disabled, allowed_tools=["none"].
5. Plans, documents, explanations (training plan, nutrition plan, how-to) → needs_code_generation=true, deliverable_type=explain_only, allowed_tools=["none"], route_to=worker. NEVER route_to=respond for substantive output.
6. Clarification: ONE question max, only when required input is missing AND cannot be defaulted. Never ask for trivial.
7. allowed_tools: explain_only → ["none"]; code generation → ["sandbox","lsp"].

Return valid JSON (same schema). Keep reasoning to one sentence.
"""

import re

# Ordered: more specific patterns first (e.g. typescript before script)
_LANGUAGE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\btypescript\b", re.IGNORECASE), "typescript"),
    (re.compile(r"\bjavascript\b|\.js\b|\.jsx\b|\.mjs\b", re.IGNORECASE), "javascript"),
    (re.compile(r"\bpython\b|\.py\b|learning\s+python", re.IGNORECASE), "python"),
    (
        re.compile(r"\bgolang\b|\bgo\s+(?:lang|code|script|program)\b|in\s+go\b|using\s+go\b|\.go\b", re.IGNORECASE),
        "go",
    ),
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
    max_completion_tokens=1536,
    use_responses_api=False,
    http_client=get_llm_http_client(uds_path=settings.supervisor_model_uds or None),
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

        # Anemic Supervisor passthrough: EntryClassifier said complex+plan_required → skip LLM, route to Planner
        task_size = state.get("task_size", "small")
        plan_required = state.get("plan_required", False)
        interaction_mode = state.get("interaction_mode", "do")

        if task_size == "complex" and plan_required and iteration == 0:
            target_language = state.get("target_language") or _extract_language_from_text(user_context)
            task_desc = (user_context or "").strip()[:1000] or "Complex task requiring decomposition"
            latency = (time.monotonic() - start) * 1000
            trace = NodeTrace(
                node_name=node_name,
                reasoning="Protocol/system complexity detected by EntryClassifier; delegating to Planner (no LLM)",
                assumptions=[],
                confidence=1.0,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=latency,
            )
            logger.info(
                "supervisor_passthrough_complex",
                extra={"task_size": task_size, "latency_ms": latency},
            )
            return {
                "task_type": "code_generation",
                "task_description": task_desc,
                "target_language": target_language,
                "assumptions": [],
                "defaults_used": [],
                "assumptions_structured": [],
                "task_is_trivial": False,
                "deliverable_type": "multi_file_patch",
                "interaction_mode": state.get("interaction_mode", "do"),
                "include_tests": True,
                "include_run_commands": True,
                "allowed_tools": ["sandbox", "lsp"],
                "rag_mode": "normal",
                "rag_results": [],
                "rag_context": [],
                "rag_collections_queried": [],
                "tool_refs": state.get("tool_refs") or [],
                "failure_context": [],
                "web_search_results": [],
                "web_search_queries": [],
                "current_node": node_name,
                "next_node": "planner",
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
                "node_traces": [trace],
            }

        # Taxonomy-driven explain_only passthrough: output_type=document from intent_classes[].document_domains
        # Planner is for code decomposition; document output goes straight to Worker with explain_only
        if state.get("output_type") == "document" and iteration == 0:
            task_desc = (user_context or "").strip()[:1000] or state.get("task_description", "Create plan as requested")
            latency = (time.monotonic() - start) * 1000
            trace = NodeTrace(
                node_name=node_name,
                reasoning="Taxonomy: output_type=document → explain_only (no LLM)",
                assumptions=[],
                confidence=1.0,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=latency,
            )
            logger.info(
                "supervisor_passthrough_explain_only",
                extra={"output_type": "document", "latency_ms": latency},
            )
            return {
                "task_type": "general",
                "task_description": task_desc,
                "target_language": "markdown",
                "assumptions": [],
                "defaults_used": [],
                "assumptions_structured": [],
                "task_is_trivial": False,
                "deliverable_type": "explain_only",
                "interaction_mode": state.get("interaction_mode", "do"),
                "include_tests": False,
                "include_run_commands": False,
                "allowed_tools": ["none"],
                "rag_mode": "disabled",  # Document plans need no code-repo RAG; avoids CloudWatch/AWS junk
                "needs_code_generation": True,
                "rag_results": [],
                "rag_context": [],
                "rag_collections_queried": [],
                "tool_refs": state.get("tool_refs") or [],
                "failure_context": state.get("failure_context", []),
                "web_search_results": state.get("web_search_results", []),
                "web_search_queries": state.get("web_search_queries", []),
                "current_node": node_name,
                "next_node": "worker",
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
                "node_traces": [trace],
                "active_domain_refs": state.get("active_domain_refs"),
                "platform_context": state.get("platform_context"),
            }

        # Teach-mode passthrough: small + teach → skip Supervisor LLM, route to Worker (avoids timeout on educational prompts)
        if (
            task_size == "small"
            and interaction_mode == "teach"
            and iteration == 0
            and not state.get("scope_expansion_needed")
        ):
            target_language = state.get("target_language") or _extract_language_from_text(user_context)
            task_desc = (user_context or "").strip()[:1000] or "Educational task"
            latency = (time.monotonic() - start) * 1000
            trace = NodeTrace(
                node_name=node_name,
                reasoning="Small+teach detected by EntryClassifier; delegating to Worker (no LLM)",
                assumptions=[],
                confidence=1.0,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=latency,
            )
            logger.info(
                "supervisor_passthrough_teach",
                extra={"task_size": task_size, "interaction_mode": interaction_mode, "latency_ms": latency},
            )
            return {
                "task_type": "code_generation",
                "task_description": task_desc,
                "target_language": target_language,
                "assumptions": [],
                "defaults_used": [],
                "assumptions_structured": [],
                "task_is_trivial": False,
                "deliverable_type": "mixed",
                "interaction_mode": "teach",
                "include_tests": False,
                "include_run_commands": True,
                "allowed_tools": ["sandbox"],
                "rag_mode": "disabled",
                "rag_results": [],
                "rag_context": [],
                "rag_collections_queried": [],
                "tool_refs": state.get("tool_refs") or [],
                "failure_context": [],
                "web_search_results": [],
                "web_search_queries": [],
                "current_node": node_name,
                "next_node": "worker",
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
                "node_traces": [trace],
            }

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
        # Step 3: When EntryClassifier pre-classified, Supervisor validates and uses — does not re-classify
        intent_envelope_block = ""
        if state.get("intent_classifier_source") == "deterministic":
            task_size = state.get("task_size", "small")
            target_lang = state.get("target_language", "python")
            intent_class = state.get("intent_class", "code")
            active_refs = state.get("active_domain_refs") or []
            refs_str = ", ".join(str(r) for r in active_refs[:5]) if active_refs else "none"
            output_type = state.get("output_type", "code")
            intent_envelope_block = (
                f"\n\n## Pre-classified (EntryClassifier)\n"
                f"task_size={task_size}, target_language={target_lang}, intent_class={intent_class}, output_type={output_type}, active_domain_refs=[{refs_str}]. "
                f"Use these; do not re-classify. "
                f'When output_type=document, use deliverable_type=explain_only, route_to=worker, allowed_tools=["none"] — produce text/plan, not code. '
                f"Focus on: routing, RAG, planning_suggested, deliverable_type."
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

        # E) Avoid anchoring: do not paste assistant clarification prompts verbatim
        history_block = ""
        if conversation_history and iteration == 0:
            sanitized = []
            for h in conversation_history[-10:]:
                if isinstance(h, str) and "[assistant]:" in h.lower():
                    content = h.split(":", 1)[-1].strip()[:200]
                    if "need" in content.lower() and (
                        "information" in content.lower() or "details" in content.lower() or "clarif" in content.lower()
                    ):
                        sanitized.append("- [assistant]: (previously asked for more details)")
                        continue
                sanitized.append(f"- {h}" if not h.startswith("- ") else h)
            history_lines = "\n".join(sanitized)
            history_block = (
                f"\n\n## Conversation History\n"
                f"The user has had previous interactions. Recent context:\n"
                f"{history_lines}\n\n"
                f'Use this context to understand references like "it", "that script". '
                f'If the user repeats a trivial request (e.g. hello world), treat as "user insists" and proceed.'
            )

        prompt_messages = [
            SystemMessage(content=SUPERVISOR_SYSTEM_PROMPT),
            HumanMessage(
                content=f"User request: {user_context}{clarification_answer_block}{intent_envelope_block}{history_block}{revision_note}{scope_expansion_note}"
            ),
        ]

        response = await supervisor_llm.ainvoke(prompt_messages)
        try:
            parsed = parse_and_validate(response.content, SupervisorOut)
        except Exception as parse_err:
            logger.warning(f"Supervisor schema validation failed: {parse_err}, using fallback parse")
            user_msg = user_context if user_context else ""
            parsed = SupervisorOut(
                task_type=TaskType.GENERAL,
                task_description=user_msg or "Respond to user",
                target_language="markdown",
                needs_code_generation=True,
                needs_clarification=False,
                route_to="worker",
                task_is_trivial=True,
                bypass_planner=True,
                bypass_clarification=True,
                deliverable_type="explain_only",
                interaction_mode="do",
                rag_mode="disabled",
                allowed_tools=["none"],
                reasoning="Fallback: schema parse failed, document-first response",
                confidence=0.5,
            )

        task_type = parsed.task_type.value if isinstance(parsed.task_type, TaskType) else str(parsed.task_type)
        # Step 3: Prefer EntryClassifier's language when pre-classified; "infer" = let LLM decide (from prompt)
        # When infer: use parsed (LLM saw full prompt); never fall back to _extract (defaults to python)
        state_tlang = (state.get("target_language") or "").strip()
        if state.get("intent_classifier_source") == "deterministic" and state_tlang and state_tlang != "infer":
            target_language = state_tlang
        elif state_tlang == "infer":
            target_language = (parsed.target_language or "").strip() or "markdown"
            if target_language == "infer":
                target_language = "markdown"
        else:
            target_language = (parsed.target_language or "").strip() or _extract_language_from_text(user_context)
            if target_language in ("", "infer"):
                target_language = "markdown"
        needs_code = parsed.needs_code_generation

        # Policy: EntryClassifier sets clarification_budget; Supervisor must obey (0 = never ask)
        requires_clarification = state.get("requires_clarification", True)
        task_size = state.get("task_size", "small")
        clarification_budget = state.get("clarification_budget", 1)
        bypass_clarification = (
            getattr(parsed, "bypass_clarification", False)
            or (getattr(parsed, "task_is_trivial", False) and target_language)
            or not requires_clarification
            or task_size in ("trivial", "small")
            or clarification_budget == 0
        )
        if bypass_clarification and parsed.needs_clarification:
            parsed = parsed.model_copy(update={"needs_clarification": False, "clarification_question": None})
            logger.info("supervisor_bypass_clarification", extra={"reason": "entry_classifier_or_trivial"})

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
                tokens_used=response.usage_metadata.get("total_tokens", 0)
                if (response and response.usage_metadata)
                else 0,
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
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
                "node_traces": [trace],
            }

        # Resolve retrieval params: per-request override > config defaults
        retrieval_params: RetrievalParams | None = state.get("retrieval_params")
        strategy = retrieval_params.strategy if retrieval_params else settings.rag_retrieval_strategy
        reranker = retrieval_params.reranker if retrieval_params else settings.rag_reranker
        top_k = retrieval_params.top_k if retrieval_params else settings.rag_top_k
        fetch_count = getattr(settings, "rag_overfetch_count", None) or top_k
        # Adaptive Rigor: rag_gravity=light (generic/python_web) → lighter RAG, no heavy search
        if state.get("rag_gravity") == "light":
            fetch_count = min(fetch_count, 5)

        rag_results = []
        rag_context = []
        rag_collections = []
        fallback_to_bm25 = False
        rag_mode = getattr(parsed, "rag_mode", None) or (
            "disabled" if getattr(parsed, "task_is_trivial", False) else "normal"
        )

        if needs_code and rag_mode != "disabled":
            task_desc = parsed.task_description or user_context
            rag_collections, rag_domain_filter = select_collections_for_task(
                task_type=task_type,
                target_language=target_language,
                task_description=task_desc,
                platform_context=state.get("platform_context") or None,
                active_domain_refs=state.get("active_domain_refs") or None,
            )
            if not rag_collections:
                rag_collections = [f"{target_language}_v1"]

            rag_params = {
                "query": task_desc[:500],
                "collections": rag_collections,
                "domain_filter": rag_domain_filter or None,
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
                domain_filter=rag_domain_filter or "",
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
                next_node = (
                    "planner" if (needs_code and planning_suggested) else ("worker" if needs_code else "respond")
                )

        # Override: output_type=document → worker explain_only, never Planner. Taxonomy-driven.
        if next_node == "planner" and state.get("output_type") == "document":
            next_node = "worker"
            needs_code = True
            parsed = parsed.model_copy(
                update={
                    "deliverable_type": "explain_only",
                    "allowed_tools": ["none"],
                    "target_language": "markdown",
                }
            )
            logger.info(
                "supervisor_override_planner_to_explain_only",
                extra={"output_type": "document"},
            )

        # Override: substantive non-code requests (plans, docs, how-to) must go to worker, not respond.
        # Prevents "no output to show" when user asks for training plan, nutrition plan, etc.
        task_desc = (parsed.task_description or user_context or "").strip()
        if next_node == "respond" and not needs_code and len(task_desc) > 20:
            logger.info(
                "supervisor_override_substantive_to_worker",
                extra={"task_desc_preview": task_desc[:80], "reason": "substantive_non_code"},
            )
            next_node = "worker"
            needs_code = True
            target_language = "markdown"
            parsed = parsed.model_copy(
                update={
                    "deliverable_type": "explain_only",
                    "allowed_tools": ["none"],
                    "target_language": "markdown",
                }
            )

        # Query failure knowledge base (skip for trivial - no failure context needed)
        failure_context: list[str] = []
        if needs_code and rag_mode != "disabled":
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

        # Web search: context discovery (skip for trivial)
        web_search_results: list[str] = []
        web_search_queries: list[str] = []
        if needs_code and rag_mode != "disabled" and settings.web_search_enabled:
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
            tokens_used=response.usage_metadata.get("total_tokens", 0) if (response and response.usage_metadata) else 0,
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
            "task_is_trivial": getattr(parsed, "task_is_trivial", False),
            "deliverable_type": getattr(parsed, "deliverable_type", "single_file"),
            "interaction_mode": (
                state["interaction_mode"]
                if state.get("intent_classifier_source") == "deterministic" and state.get("interaction_mode") == "teach"
                else getattr(parsed, "interaction_mode", "do")
            ),
            "include_tests": getattr(parsed, "include_tests", True),
            "include_run_commands": getattr(parsed, "include_run_commands", True),
            "allowed_tools": getattr(parsed, "allowed_tools", ["sandbox", "lsp"]),
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
        # Trivial + scope_expansion: expand touched_files so Worker retry doesn't loop (bypass_planner skips Planner)
        if state.get("scope_expansion_needed") and next_node == "worker" and getattr(parsed, "task_is_trivial", False):
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
                logger.info("supervisor_expanded_scope", extra={"added": requested[:5], "touched_files": expanded[:10]})

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
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "node_traces": [trace],
        }
