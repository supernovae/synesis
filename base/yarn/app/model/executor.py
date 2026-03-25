"""Model execution layer — provider-agnostic streaming with retries and circuit breaker.

This is the core transport: it sends messages to the model, streams back chunks,
detects tool calls, and tracks usage. The agentic loop in main.py drives this.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from ..config import Provider, settings
from . import providers
from .circuit_breaker import CircuitBreaker
from .stream_handler import StreamChunk, ToolCallAccumulator, extract_chunk, parse_sse_line
from .usage_tracker import UsageRecord

logger = logging.getLogger("yarn.model.executor")

_MAX_BREAKERS = 2048
_breakers: dict[str, CircuitBreaker] = {}


def _get_breaker(name: str) -> CircuitBreaker:
    if name not in _breakers:
        if len(_breakers) >= _MAX_BREAKERS:
            oldest = next(iter(_breakers))
            del _breakers[oldest]
        _breakers[name] = CircuitBreaker(name)
    return _breakers[name]


async def run_model(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    *,
    provider: Provider | None = None,
    model: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    org_id: str = "",
) -> AsyncIterator[StreamChunk]:
    """Stream a model call with retries and circuit breaker.

    Yields StreamChunk objects. The final chunk contains usage data.
    Breakers are scoped per (provider, org_id) so one tenant's failures
    cannot deny service to other tenants.
    """
    prov = provider or settings.provider
    breaker_key = f"{prov.value}:{org_id}" if org_id else prov.value
    breaker = _get_breaker(breaker_key)

    for attempt in range(settings.model_retries + 1):
        if not breaker.allow_request():
            logger.warning("Circuit breaker OPEN for %s, skipping", prov.value)
            chunk = StreamChunk(content="[Service temporarily unavailable]", finish_reason="error")
            yield chunk
            return

        try:
            accumulator = ToolCallAccumulator()
            start = time.monotonic()

            async for raw_line in providers.stream_chat_completion(
                messages,
                tools,
                provider=prov,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
            ):
                line = raw_line.decode("utf-8", errors="replace").strip()
                data = parse_sse_line(line)
                if data is None:
                    continue
                if data.get("_done"):
                    break

                chunk = extract_chunk(data)

                if chunk.tool_calls:
                    accumulator.feed(chunk.tool_calls)

                if chunk.finish_reason == "tool_calls" and accumulator.has_pending:
                    chunk.tool_calls = accumulator.flush()

                if chunk.usage:
                    elapsed = (time.monotonic() - start) * 1000
                    record = UsageRecord(
                        provider=prov.value,
                        model=model or settings.model,
                        tokens_in=chunk.usage.get("prompt_tokens", 0),
                        tokens_out=chunk.usage.get("completion_tokens", 0),
                        tokens_cached=chunk.usage.get("prompt_tokens_details", {}).get("cached_tokens", 0),
                        latency_ms=elapsed,
                        finish_reason=chunk.finish_reason or "",
                    )
                    record.compute_cost()
                    chunk.raw["_usage_record"] = record

                yield chunk

            if accumulator.has_pending:
                final = StreamChunk(tool_calls=accumulator.flush(), finish_reason="tool_calls")
                yield final

            breaker.record_success()
            return

        except Exception as e:
            breaker.record_failure()
            if attempt < settings.model_retries:
                wait = 2**attempt
                logger.warning(
                    "Model call attempt %d failed (%s), retrying in %ds",
                    attempt + 1,
                    e,
                    wait,
                )
                await asyncio.sleep(wait)
            else:
                logger.error("Model call failed after %d attempts: %s", attempt + 1, e)
                yield StreamChunk(
                    content=f"[Model error after {attempt + 1} attempts: {e}]",
                    finish_reason="error",
                )


async def run_model_sync(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Non-streaming model call (for summarization, etc.)."""
    prov = kwargs.get("provider") or settings.provider
    org_id = kwargs.pop("org_id", "") or ""
    prov_str = prov.value if isinstance(prov, Provider) else prov
    breaker_key = f"{prov_str}:{org_id}" if org_id else prov_str
    breaker = _get_breaker(breaker_key)

    for attempt in range(settings.model_retries + 1):
        if not breaker.allow_request():
            return {"error": "Circuit breaker open"}
        try:
            result = await providers.chat_completion(messages, tools, **kwargs)
            breaker.record_success()
            return result
        except Exception as e:
            breaker.record_failure()
            if attempt < settings.model_retries:
                await asyncio.sleep(2**attempt)
            else:
                return {"error": str(e)}
    return {"error": "Exhausted retries"}
