"""Admin LLM assistant — query a model for trace analysis, config research, etc."""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Body, Depends

from ..auth import UserInfo, get_current_user
from ..deps import LITELLM_URL

logger = logging.getLogger("synesis.admin.assistant")

router = APIRouter(prefix="/api/v1/assistant", tags=["assistant"])

SYSTEM_PROMPT = """You are the Synesis Admin Assistant. You help operators understand
system behavior, analyze traces, debug issues, and tune configuration.
Be concise and actionable. When analyzing data provided in context,
cite specific numbers and suggest next steps."""


@router.post("/chat")
async def assistant_chat(
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    """Send a message to the LLM with optional context (trace, config, etc.)."""
    user_message = data.get("message", "")
    context = data.get("context", "")

    if not user_message:
        return {"error": "message is required"}

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
                    "model": "synesis-general",
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
                "model": result.get("model", "synesis-general"),
            }
    except Exception as exc:
        logger.warning("assistant_chat_failed error=%s", str(exc)[:200])
        return {
            "response": f"Failed to reach LLM: {str(exc)[:200]}",
            "tokens": 0,
            "model": "",
        }
