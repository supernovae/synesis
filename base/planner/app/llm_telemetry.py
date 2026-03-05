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


_default_client: Any = None
_uds_clients: dict[str, Any] = {}


def get_llm_http_client(*, uds_path: str | None = None) -> Any | None:
    """Return httpx.Client for LLM calls. Reused per uds_path to reduce connection churn.

    When uds_path is set, uses Unix domain socket transport (for co-located vLLM).
    Otherwise uses default TCP client. Both support x-* telemetry when DEBUG.
    """
    try:
        import httpx

        if uds_path and uds_path.strip():
            path = uds_path.strip()
            if path not in _uds_clients:
                transport = httpx.HTTPTransport(uds=path)
                _uds_clients[path] = httpx.Client(
                    transport=transport,
                    event_hooks={"response": [_log_model_response_headers_sync]},
                )
            return _uds_clients[path]
        global _default_client
        if _default_client is None:
            _default_client = httpx.Client(
                event_hooks={"response": [_log_model_response_headers_sync]},
            )
        return _default_client
    except Exception as e:
        logger.debug("llm_telemetry_client_init_failed %s", e)
        return None
