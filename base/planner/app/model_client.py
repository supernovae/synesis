"""Resilient LLM call wrapper — retry, circuit breaker, fallback model support.

All graph nodes should use ``create_chat_model()`` or ``resilient_ainvoke()``
instead of constructing ChatOpenAI directly, so we get uniform retry,
circuit-breaker, and (optional) fallback behavior across every LLM role.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger("synesis.model_client")

_metrics_registered = False
_cb_open_counter = None
_cb_half_open_counter = None
_retry_counter = None
_fallback_counter = None


def _ensure_metrics() -> None:
    global _metrics_registered, _cb_open_counter, _cb_half_open_counter
    global _retry_counter, _fallback_counter
    if _metrics_registered:
        return
    try:
        from prometheus_client import Counter

        _cb_open_counter = Counter(
            "synesis_circuit_breaker_open_total",
            "Times circuit breaker opened for an LLM role",
            ["role"],
        )
        _cb_half_open_counter = Counter(
            "synesis_circuit_breaker_half_open_total",
            "Times circuit breaker transitioned to half-open",
            ["role"],
        )
        _retry_counter = Counter(
            "synesis_llm_retry_total",
            "LLM call retries by role",
            ["role"],
        )
        _fallback_counter = Counter(
            "synesis_llm_fallback_total",
            "Times fallback model was used by role",
            ["role"],
        )
    except Exception:
        pass
    _metrics_registered = True


class CircuitBreaker:
    """Per-role circuit breaker for LLM endpoints.

    States: closed (normal) -> open (all calls rejected) -> half-open (probe).
    """

    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

    def __init__(
        self,
        role: str,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        half_open_max: int = 1,
    ) -> None:
        self.role = role
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.half_open_max = half_open_max
        self._state = self.CLOSED
        self._failure_count = 0
        self._last_failure_time = 0.0
        self._half_open_calls = 0

    @property
    def state(self) -> str:
        if self._state == self.OPEN:
            if time.monotonic() - self._last_failure_time >= self.recovery_timeout:
                self._state = self.HALF_OPEN
                self._half_open_calls = 0
                _ensure_metrics()
                if _cb_half_open_counter:
                    _cb_half_open_counter.labels(role=self.role).inc()
                logger.info("circuit_breaker_half_open", extra={"role": self.role})
        return self._state

    def allow_request(self) -> bool:
        s = self.state
        if s == self.CLOSED:
            return True
        if s == self.HALF_OPEN:
            if self._half_open_calls < self.half_open_max:
                self._half_open_calls += 1
                return True
            return False
        return False

    def record_success(self) -> None:
        if self._state in (self.HALF_OPEN, self.OPEN):
            logger.info("circuit_breaker_closed", extra={"role": self.role})
        self._state = self.CLOSED
        self._failure_count = 0

    def record_failure(self) -> None:
        self._failure_count += 1
        self._last_failure_time = time.monotonic()
        if self._failure_count >= self.failure_threshold:
            self._state = self.OPEN
            _ensure_metrics()
            if _cb_open_counter:
                _cb_open_counter.labels(role=self.role).inc()
            logger.warning(
                "circuit_breaker_open",
                extra={"role": self.role, "failures": self._failure_count},
            )


_breakers: dict[str, CircuitBreaker] = {}


def get_breaker(role: str) -> CircuitBreaker:
    if role not in _breakers:
        _breakers[role] = CircuitBreaker(role=role)
    return _breakers[role]


def create_chat_model(
    *,
    base_url: str,
    model: str,
    role: str = "general",
    temperature: float = 0.3,
    max_completion_tokens: int | None = None,
    streaming: bool = False,
    guided_json_enabled: bool = False,
    max_retries: int = 2,
    **kwargs: Any,
) -> Any:
    """Factory for ChatOpenAI with standard retry and telemetry wiring."""
    from langchain_openai import ChatOpenAI

    from .llm_telemetry import get_llm_http_client

    model_kwargs = kwargs.pop("model_kwargs", {})
    if guided_json_enabled:
        model_kwargs.setdefault("extra_body", {}).setdefault("chat_template_kwargs", {"enable_thinking": False})

    return ChatOpenAI(
        base_url=base_url,
        api_key="not-needed",
        model=model,
        temperature=temperature,
        max_completion_tokens=max_completion_tokens,
        streaming=streaming,
        max_retries=max_retries,
        use_responses_api=False,
        model_kwargs=model_kwargs or {},
        http_client=get_llm_http_client(),
        **kwargs,
    )


_RETRIABLE_STATUS = {429, 500, 502, 503, 504}


def _is_retriable(exc: Exception) -> bool:
    """Check if an exception represents a transient/retriable failure."""
    msg = str(exc).lower()
    for code in _RETRIABLE_STATUS:
        if str(code) in msg:
            return True
    return any(signal in msg for signal in ("timeout", "connection", "reset by peer", "broken pipe"))


async def resilient_ainvoke(
    llm: Any,
    messages: list,
    *,
    role: str = "general",
    fallback_llm: Any | None = None,
    max_retries: int = 1,
    backoff_base: float = 2.0,
) -> Any:
    """Invoke an LLM with circuit breaker, retry, and optional fallback.

    Raises the original exception if all attempts (primary + fallback) fail.
    """
    _ensure_metrics()
    breaker = get_breaker(role)

    if not breaker.allow_request():
        if fallback_llm is not None:
            logger.info("circuit_open_using_fallback", extra={"role": role})
            if _fallback_counter:
                _fallback_counter.labels(role=role).inc()
            return await fallback_llm.ainvoke(messages)
        raise RuntimeError(f"Circuit breaker open for role '{role}', no fallback configured")

    last_exc: Exception | None = None
    for attempt in range(1 + max_retries):
        try:
            result = await llm.ainvoke(messages)
            breaker.record_success()
            return result
        except Exception as exc:
            last_exc = exc
            if attempt < max_retries and _is_retriable(exc):
                wait = backoff_base**attempt
                if _retry_counter:
                    _retry_counter.labels(role=role).inc()
                logger.warning(
                    "llm_call_retry",
                    extra={"role": role, "attempt": attempt + 1, "wait_s": wait, "error": str(exc)[:120]},
                )
                await asyncio.sleep(wait)
            else:
                break

    breaker.record_failure()

    if fallback_llm is not None:
        logger.warning("primary_failed_using_fallback", extra={"role": role, "error": str(last_exc)[:120]})
        if _fallback_counter:
            _fallback_counter.labels(role=role).inc()
        try:
            result = await fallback_llm.ainvoke(messages)
            return result
        except Exception as fb_exc:
            logger.error("fallback_also_failed", extra={"role": role, "error": str(fb_exc)[:120]})
            raise fb_exc from last_exc

    raise last_exc  # type: ignore[misc]
