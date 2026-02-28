"""LLM response telemetry — capture x-* headers when SYNESIS_LOG_LEVEL=DEBUG.

Surfaces queue_time_ms, inference_time_ms, compute_tokens from model predictors
so we can identify bottlenecks (queue vs inference).
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("synesis.llm_telemetry")


def _parse_int(val: Any) -> int | None:
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def _log_model_response_headers_sync(response: Any) -> None:
    """Extract and log x-* headers from model/embedder HTTP responses."""
    try:
        headers = getattr(response, "headers", None)
        request = getattr(response, "request", None)
        if not headers:
            return
        url = str(getattr(request, "url", "")) if request else ""
        # Infer service from URL (supervisor-predictor, executor-predictor, critic-predictor, embedder)
        service = "unknown"
        if "supervisor-predictor" in url:
            service = "supervisor"
        elif "executor-predictor" in url:
            service = "executor"
        elif "critic-predictor" in url:
            service = "critic"
        elif "embedder" in url:
            service = "embedder"
        elif "planner" in url and "predictor" in url:
            service = "planner"

        # Header names are case-insensitive; httpx lowercases them
        def _get(name: str) -> int | None:
            v = headers.get(name) or headers.get(name.lower())
            if isinstance(v, bytes):
                v = v.decode("utf-8", errors="replace")
            return _parse_int(v)

        queue_ms = _get("x-queue-time") or _get("x-queue-time-ms")
        inference_ms = _get("x-inference-time") or _get("x-inference-time-ms")
        compute_ms = _get("x-compute-time") or _get("x-compute-time-ms")
        tokens = _get("x-compute-tokens")
        chars = _get("x-compute-characters")
        compute_type = headers.get("x-compute-type") or headers.get("X-Compute-Type")
        if isinstance(compute_type, bytes):
            compute_type = compute_type.decode("utf-8", errors="replace")

        parts = [f"service={service}"]
        if queue_ms is not None:
            parts.append(f"queue_ms={queue_ms}")
        if inference_ms is not None:
            parts.append(f"inference_ms={inference_ms}")
        if compute_ms is not None:
            parts.append(f"compute_ms={compute_ms}")
        if tokens is not None:
            parts.append(f"tokens={tokens}")
        if chars is not None:
            parts.append(f"chars={chars}")
        if compute_type:
            parts.append(f"type={compute_type}")

        if len(parts) > 1:
            logger.debug("llm_telemetry %s", " ".join(parts))
    except Exception as e:
        logger.debug("llm_telemetry_hook_error %s", e)


_http_client: Any = None


def get_llm_http_client() -> Any | None:
    """Return a shared httpx.Client for LLM calls to reduce connection churn across graph runs.

    LangChain passes http_client to openai.OpenAI (sync), which expects httpx.Client.
    Reusing the client avoids per-request connection overhead and improves latency.
    The response hook logs x-* telemetry when SYNESIS_LOG_LEVEL=DEBUG.
    """
    global _http_client

    if _http_client is not None:
        return _http_client

    try:
        import httpx

        _http_client = httpx.Client(
            event_hooks={"response": [_log_model_response_headers_sync]},
        )
        return _http_client
    except Exception as e:
        logger.debug("llm_telemetry_client_init_failed %s", e)
        return None
