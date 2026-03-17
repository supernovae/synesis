"""Admin LLM assistant — trace analysis, summarization, and review (configurable model)."""

from __future__ import annotations

import json
import logging

import httpx
from fastapi import APIRouter, Body, Depends

from ..auth import UserInfo, get_current_user
from ..deps import ASSISTANT_MODEL, LITELLM_URL
from ..services import trace_store

logger = logging.getLogger("synesis.admin.assistant")

router = APIRouter(prefix="/api/v1/assistant", tags=["assistant"])

SYSTEM_PROMPT = """You are the Synesis Admin Assistant. You help operators understand
system behavior, analyze traces, debug issues, and tune configuration.
Be concise and actionable. When analyzing data provided in context,
cite specific numbers and suggest next steps."""


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


@router.post("/chat")
async def assistant_chat(
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    """Send a message to the LLM. Optionally pass trace_id (and span_index) to load trace as context."""
    user_message = data.get("message", "")
    context = data.get("context", "")
    trace_id = data.get("trace_id")
    span_index = data.get("span_index")

    if not user_message:
        return {"error": "message is required"}

    if trace_id:
        record = await trace_store.get_trace(trace_id)
        if record:
            context = _trace_context_text(record, span_index if span_index is not None else None)
        else:
            context = (context or "") + "\n\n(Loaded trace_id not found.)"
    elif context:
        pass  # use provided context

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if context:
        messages.append(
            {"role": "user", "content": f"Context:\n{context}\n\n---\n\n{user_message}"}
        )
    else:
        messages.append({"role": "user", "content": user_message})

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{LITELLM_URL.rstrip('/')}/chat/completions",
                json={
                    "model": ASSISTANT_MODEL,
                    "messages": messages,
                    "max_tokens": 2048,
                    "temperature": 0.3,
                },
            )
            resp.raise_for_status()
            result = resp.json()
            content = result["choices"][0]["message"]["content"]
            usage = result.get("usage", {})
            return {
                "response": content,
                "tokens": usage.get("total_tokens", 0),
                "model": result.get("model", ASSISTANT_MODEL),
            }
    except Exception as exc:
        logger.warning("assistant_chat_failed error=%s", str(exc)[:200])
        return {
            "response": f"Failed to reach LLM: {str(exc)[:200]}",
            "tokens": 0,
            "model": "",
        }
