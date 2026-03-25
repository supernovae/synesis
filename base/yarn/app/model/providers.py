"""Model provider implementations — DeepInfra, local vLLM, LiteLLM."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..config import Provider, settings

logger = logging.getLogger("yarn.model.providers")

_clients: dict[str, httpx.AsyncClient] = {}


def _get_client(provider: Provider) -> httpx.AsyncClient:
    key = provider.value
    if key not in _clients:
        base_url = settings.effective_base_url
        headers: dict[str, str] = {}
        api_key = settings.effective_api_key
        if api_key and api_key != "not-needed":
            headers["Authorization"] = f"Bearer {api_key}"

        _clients[key] = httpx.AsyncClient(
            base_url=base_url,
            headers=headers,
            timeout=httpx.Timeout(settings.request_timeout, connect=10.0),
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
        )
    return _clients[key]


async def stream_chat_completion(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    *,
    provider: Provider | None = None,
    model: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    tool_choice: str | dict[str, Any] | None = None,
) -> AsyncIterator[bytes]:
    """Stream a chat completion from the configured provider.

    Yields raw SSE bytes suitable for forwarding or parsing.
    """
    prov = provider or settings.provider
    client = _get_client(prov)

    payload: dict[str, Any] = {
        "model": model or settings.model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": temperature if temperature is not None else settings.temperature,
        "max_tokens": max_tokens or settings.max_tokens,
    }

    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice or "auto"

    async with client.stream(
        "POST",
        "/chat/completions",
        json=payload,
    ) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            yield (line + "\n").encode()


async def chat_completion(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    *,
    provider: Provider | None = None,
    model: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    tool_choice: str | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Non-streaming chat completion."""
    prov = provider or settings.provider
    client = _get_client(prov)

    payload: dict[str, Any] = {
        "model": model or settings.model,
        "messages": messages,
        "stream": False,
        "temperature": temperature if temperature is not None else settings.temperature,
        "max_tokens": max_tokens or settings.max_tokens,
    }

    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice or "auto"

    resp = await client.post("/chat/completions", json=payload)
    resp.raise_for_status()
    return resp.json()


async def close_all() -> None:
    for client in _clients.values():
        await client.aclose()
    _clients.clear()
