"""Model provider transport — tier-based client routing.

Clients are cached by (base_url, api_key_prefix) for connection reuse.
All public functions accept a ModelTier which determines the upstream
endpoint and model ID.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..config import settings
from .tiers import ModelTier

logger = logging.getLogger("yarn.model.providers")

_clients: dict[str, httpx.AsyncClient] = {}


def _client_key(base_url: str, api_key: str) -> str:
    prefix = api_key[:8] if api_key else "none"
    return hashlib.sha256(f"{base_url}:{prefix}".encode()).hexdigest()[:16]


def _get_client(base_url: str, api_key: str) -> httpx.AsyncClient:
    key = _client_key(base_url, api_key)
    if key not in _clients:
        headers: dict[str, str] = {}
        if api_key and api_key != "not-needed":
            headers["Authorization"] = f"Bearer {api_key}"

        _clients[key] = httpx.AsyncClient(
            base_url=base_url,
            headers=headers,
            timeout=httpx.Timeout(settings.request_timeout, connect=10.0),
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
        )
    return _clients[key]


async def stream_chat(
    tier: ModelTier,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
    tool_choice: str | dict[str, Any] | None = None,
) -> AsyncIterator[bytes]:
    """Stream a chat completion using the tier's backend config."""
    client = _get_client(tier.base_url, tier.api_key)

    payload: dict[str, Any] = {
        "model": tier.backend_model,
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


async def chat(
    tier: ModelTier,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
    tool_choice: str | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Non-streaming chat completion using the tier's backend config."""
    client = _get_client(tier.base_url, tier.api_key)

    payload: dict[str, Any] = {
        "model": tier.backend_model,
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
