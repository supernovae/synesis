"""Synesis error-sanitisation callback for LiteLLM proxy.

Intercepts upstream LLM provider failures and replaces raw error details
with safe, bucketed messages before they reach Open WebUI (or any other
client).  The original exception is logged at ERROR for ops visibility.

Canonical source: base/gateway/synesis_callbacks.py
Mounted into LiteLLM via ConfigMap (see base/gateway/helm/values-synesis.yaml).
"""

from __future__ import annotations

import logging
import uuid

from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy.proxy_server import UserAPIKeyAuth

logger = logging.getLogger("synesis.gateway.errors")

_AUTH_KEYWORDS = frozenset(
    ("401", "403", "unauthorized", "forbidden", "token", "oauth",
     "credential", "api_key", "api key", "authentication")
)
_TIMEOUT_KEYWORDS = frozenset(
    ("timeout", "timed out", "connect", "unreachable", "connection refused",
     "connection reset", "connection error")
)


def _classify(exc: Exception) -> tuple[int, str]:
    """Map an upstream exception to (HTTP status, safe user message)."""
    name = type(exc).__name__
    msg = str(exc).lower()

    if name == "AuthenticationError" or any(kw in msg for kw in _AUTH_KEYWORDS):
        return 502, (
            "The AI service is temporarily unavailable due to a provider "
            "authentication issue. Please try again later."
        )

    if name == "RateLimitError" or "429" in msg or "rate limit" in msg:
        return 429, "Rate limit reached. Please try again in a moment."

    if name == "ContextWindowExceededError" or (
        "context" in msg and "window" in msg
    ):
        return 400, (
            "Your request exceeded the model's context window. "
            "Please shorten your prompt and try again."
        )

    if name in ("Timeout", "APIConnectionError") or any(
        kw in msg for kw in _TIMEOUT_KEYWORDS
    ):
        return 504, (
            "The request timed out or the provider was unreachable. "
            "Please try again."
        )

    if name == "ContentPolicyViolationError" or "content policy" in msg:
        return 400, "The request was rejected by the provider's content policy."

    if name == "ServiceUnavailableError" or "503" in msg:
        return 503, (
            "The AI service is temporarily unavailable. "
            "Please try again shortly."
        )

    return 502, (
        "Something went wrong while contacting the AI service. "
        "If the problem persists, please contact support."
    )


class SynesisErrorSanitizer(CustomLogger):
    """LiteLLM CustomLogger that sanitises error responses for clients."""

    async def async_post_call_failure_hook(
        self,
        request_data: dict,
        original_exception: Exception,
        user_api_key_dict: UserAPIKeyAuth,
        traceback_str: str | None = None,
    ) -> HTTPException | None:
        incident_id = uuid.uuid4().hex[:12]
        model = request_data.get("model", "<unknown>")

        logger.error(
            "LLM call failed [incident=%s model=%s exc_type=%s]: %s",
            incident_id,
            model,
            type(original_exception).__name__,
            original_exception,
        )
        if traceback_str:
            logger.debug(
                "Traceback [incident=%s]:\n%s", incident_id, traceback_str
            )

        status, safe_message = _classify(original_exception)
        return HTTPException(
            status_code=status,
            detail=f"{safe_message} (ref: {incident_id})",
        )


proxy_handler_instance = SynesisErrorSanitizer()
