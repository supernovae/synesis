"""Admin LLM assistant — trace analysis, summarization, and review (configurable model)."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

from ..auth import UserInfo, get_current_user
from ..deps import ASSISTANT_MODEL, LITELLM_MASTER_KEY, LITELLM_URL
from ..rbac import Role, can_access_trace, resolve_role
from ..services import trace_store
from .admin_mcp import invoke_mcp_tool_for_chat, openai_function_tools_for_role

logger = logging.getLogger("synesis.admin.assistant")

router = APIRouter(prefix="/api/v1/assistant", tags=["assistant"])

MAX_ASSISTANT_TOOL_ROUNDS = 8

ADMIN_SYSTEM_PROMPT = """You are the Synesis Admin Assistant. You help operators understand
system behavior, analyze traces, debug issues, and tune configuration.
Be concise and actionable. When analyzing data provided in context,
cite specific numbers and suggest next steps.

You have tools that call the live Admin API (same RBAC as the signed-in user): traces
(including decision analytics), usage/cost summaries and hourly ``usage_time_series``,
``unified_usage_snapshot``, Yarn ops (``yarn_overview``, ``yarn_sessions``, ``yarn_performance``, …),
service health, model roles, and (for privileged users) cache metrics, circuit breakers, ingestion, etc.
When the user asks about current costs, usage, health, or live data, call the
appropriate tools instead of guessing. Prefer ``unified_usage_snapshot`` for
cost/spend questions when a broad picture is needed; use ``usage_time_series`` for
trends; use Yarn tools for IDE session utilization and performance."""

SUPPORT_SYSTEM_PROMPT = """You are the Synesis Support Assistant. You help authenticated
users with account-safe guidance, usage questions, and product assistance.
You do not perform admin operations, trace analysis, or privileged diagnostics.
Be concise, practical, and explicit about any limits.

When usage or account metrics are needed, call user-safe tools instead of guessing."""

SUPPORT_ALLOWED_TOOL_NAMES = {
    "service_health",
    "list_models",
    "unified_usage_snapshot",
    "synesis_search",
    "synesis_classify_intent",
    "synesis_retrieval_gaps",
}


def _trace_context_text(trace: dict, span_index: int | None = None) -> str:
    """Build a concise text representation of a trace (or one span) for assistant context."""
    if span_index is not None and 0 <= span_index < len(trace.get("spans") or []):
        span = trace["spans"][span_index]
        parts = [
            f"Span {span_index + 1}: {span.get('intent') or span.get('node_name', '')}",
            f"Latency: {span.get('latency_ms', 0):.0f}ms",
            f"Tokens: {span.get('tokens_used', 0)}",
        ]
        for i, call in enumerate(span.get("llm_calls") or []):
            parts.append(f"\nLLM call {i + 1}: {call.get('model', '')}")
            parts.append(f"  Tokens: {call.get('prompt_tokens', 0)} in / {call.get('completion_tokens', 0)} out")
            if call.get("prompt_full"):
                parts.append(f"  Prompt:\n{call['prompt_full'][:8000]}")
            elif call.get("prompt_snippet"):
                parts.append(f"  Prompt (snippet):\n{call['prompt_snippet']}")
            if call.get("completion_full"):
                parts.append(f"  Completion:\n{call['completion_full'][:8000]}")
            elif call.get("completion_snippet"):
                parts.append(f"  Completion (snippet):\n{call['completion_snippet']}")
        return "\n".join(parts)
    # Full trace summary
    parts = [
        f"Trace {trace.get('trace_id', '')}",
        f"Query: {trace.get('query_snippet', '')}",
        f"Duration: {trace.get('total_duration_ms', 0):.0f}ms, Tokens: {trace.get('total_tokens', 0)}",
        f"Difficulty: {trace.get('difficulty', 0)}, Error: {trace.get('has_error', False)}",
    ]
    if trace.get("phase_timings"):
        parts.append("Phase timings: " + json.dumps(trace["phase_timings"]))
    if trace.get("critic_scores"):
        parts.append("Critic: " + json.dumps(trace["critic_scores"]))
    if trace.get("evidence_summary"):
        parts.append("Evidence: " + json.dumps(trace["evidence_summary"]))
    parts.append("\nSpans:")
    for i, s in enumerate(trace.get("spans") or []):
        intent = s.get("intent") or s.get("node_name", "")
        parts.append(f"  {i + 1}. {intent} — {s.get('latency_ms', 0):.0f}ms, {s.get('tokens_used', 0)} tok")
    return "\n".join(parts)


def _litellm_headers() -> dict[str, str]:
    h: dict[str, str] = {"Content-Type": "application/json"}
    if LITELLM_MASTER_KEY:
        h["Authorization"] = f"Bearer {LITELLM_MASTER_KEY}"
    return h


def _message_content_text(msg: dict[str, Any]) -> str | None:
    """Normalize assistant message content (string or multimodal list) to plain text."""
    c = msg.get("content")
    if c is None:
        return None
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts: list[str] = []
        for block in c:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "\n".join(parts) if parts else None
    return str(c)


async def _assistant_chat_impl(
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
    *,
    support_mode: bool,
):
    """Send a message to the LLM. Optionally pass trace_id (and span_index) to load trace as context.

    When the model supports function calling, the assistant runs an MCP tool loop
    (same handlers as Admin MCP / synesis-admin-mcp-ts) under the caller's JWT.
    """
    user_message = data.get("message", "")
    context = data.get("context", "")
    trace_id = data.get("trace_id")
    span_index = data.get("span_index")

    if not user_message:
        return {"error": "message is required"}

    if trace_id and support_mode:
        context = (context or "") + "\n\n(trace_id context is only available in Admin Assistant mode.)"
    elif trace_id:
        record = await trace_store.get_trace(trace_id)
        if record and not can_access_trace(_user, record):
            record = None
        if record:
            context = _trace_context_text(record, span_index if span_index is not None else None)
        else:
            context = (context or "") + "\n\n(Loaded trace_id not found.)"
    elif context:
        pass  # use provided context

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SUPPORT_SYSTEM_PROMPT if support_mode else ADMIN_SYSTEM_PROMPT}
    ]
    if context:
        messages.append({"role": "user", "content": f"Context:\n{context}\n\n---\n\n{user_message}"})
    else:
        messages.append({"role": "user", "content": user_message})

    role = resolve_role(_user)
    tools = (
        openai_function_tools_for_role(role, allowed_tool_names=SUPPORT_ALLOWED_TOOL_NAMES)
        if support_mode
        else openai_function_tools_for_role(role)
    )
    tool_rounds = 0
    total_usage_tokens = 0
    last_model = ASSISTANT_MODEL
    tools_enabled = bool(tools)

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            for _ in range(32):
                payload: dict[str, Any] = {
                    "model": ASSISTANT_MODEL,
                    "messages": messages,
                    "max_tokens": 2048,
                    "temperature": 0.3,
                }
                if tools and tools_enabled:
                    payload["tools"] = tools
                    payload["tool_choice"] = "auto"

                resp = await client.post(
                    f"{LITELLM_URL.rstrip('/')}/chat/completions",
                    json=payload,
                    headers=_litellm_headers(),
                )
                resp.raise_for_status()
                result = resp.json()
                choice = result["choices"][0]
                msg = choice["message"]
                usage = result.get("usage") or {}
                total_usage_tokens += int(usage.get("total_tokens", 0) or 0)
                last_model = result.get("model", ASSISTANT_MODEL)

                tool_calls = msg.get("tool_calls") or []
                if tool_calls and tools_enabled:
                    if tool_rounds >= MAX_ASSISTANT_TOOL_ROUNDS:
                        tools_enabled = False
                        messages.append(
                            {
                                "role": "assistant",
                                "content": msg.get("content"),
                                "tool_calls": tool_calls,
                            }
                        )
                        messages.append(
                            {
                                "role": "user",
                                "content": (
                                    "Do not call more tools. Summarize and answer using the tool "
                                    "results already in this conversation."
                                ),
                            }
                        )
                        continue

                    tool_rounds += 1
                    messages.append(
                        {
                            "role": "assistant",
                            "content": msg.get("content"),
                            "tool_calls": tool_calls,
                        }
                    )
                    for tc in tool_calls:
                        fn = tc.get("function") or {}
                        tname = fn.get("name", "")
                        raw_args = fn.get("arguments", "{}")
                        try:
                            args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
                        except json.JSONDecodeError:
                            args = {}
                        tool_text = await invoke_mcp_tool_for_chat(_user, tname, args, audit_source="assistant")
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tc.get("id", ""),
                                "content": tool_text,
                            }
                        )
                    continue

                if tool_calls and not tools_enabled:
                    messages.append(
                        {
                            "role": "assistant",
                            "content": msg.get("content"),
                            "tool_calls": tool_calls,
                        }
                    )
                    messages.append(
                        {
                            "role": "user",
                            "content": "Tools are disabled. Answer in plain text using prior messages only.",
                        }
                    )
                    continue

                text = _message_content_text(msg)
                return {
                    "response": text or "",
                    "tokens": total_usage_tokens,
                    "model": last_model,
                    "tool_rounds": tool_rounds,
                }

            return {
                "response": "Assistant stopped after too many turns; try a narrower question.",
                "tokens": total_usage_tokens,
                "model": last_model,
                "tool_rounds": tool_rounds,
            }
    except Exception as exc:
        logger.warning("assistant_chat_failed", exc_info=True)
        return {
            "response": f"Failed to reach LLM ({type(exc).__name__}). Check admin service logs for details.",
            "tokens": 0,
            "model": "",
            "tool_rounds": tool_rounds,
        }


@router.post("/chat")
async def assistant_chat(
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    """Admin assistant chat endpoint (org_admin+)."""
    if resolve_role(_user) < Role.org_admin:
        raise HTTPException(status_code=403, detail="Admin assistant requires org_admin role or higher")
    return await _assistant_chat_impl(data=data, _user=_user, support_mode=False)


@router.post("/support/chat")
async def support_assistant_chat(
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    """Support assistant endpoint for authenticated user context."""
    if resolve_role(_user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    return await _assistant_chat_impl(data=data, _user=_user, support_mode=True)
