"""Escalation bridge — forwards requests to the Synesis planner (LangGraph pipeline).

When the fast loop determines it cannot handle a request (RAG needed, context
overflow, model-requested escalation), this module transparently proxies to
the existing planner service and streams the response back.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..config import settings

logger = logging.getLogger("yarn.escalation.bridge")

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=settings.planner_url,
            timeout=httpx.Timeout(settings.request_timeout, connect=10.0),
        )
    return _client


async def escalate_to_langchain(
    messages: list[dict[str, Any]],
    *,
    user: str = "",
    conversation_id: str = "",
) -> AsyncIterator[bytes]:
    """Forward a request to the planner and stream the SSE response back.

    The planner exposes an OpenAI-compatible /v1/chat/completions endpoint.
    We send the full conversation context so the planner has everything it
    needs for RAG, planning, and multi-step reasoning.
    """
    client = _get_client()

    payload: dict[str, Any] = {
        "model": "Synesis",
        "messages": messages,
        "stream": True,
    }
    if user:
        payload["user"] = user
    if conversation_id:
        payload["conversation_id"] = conversation_id

    logger.info("Escalating to planner: %d messages", len(messages))

    async with client.stream(
        "POST",
        "/v1/chat/completions",
        json=payload,
    ) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            yield (line + "\n").encode()


async def escalate_sync(
    messages: list[dict[str, Any]],
    **kwargs: Any,
) -> dict[str, Any]:
    """Non-streaming escalation for cases where we need the full response."""
    client = _get_client()

    payload: dict[str, Any] = {
        "model": "Synesis",
        "messages": messages,
        "stream": False,
    }
    payload.update(kwargs)

    resp = await client.post("/v1/chat/completions", json=payload)
    resp.raise_for_status()
    return resp.json()


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
