"""OTel-ready span wrapper. No-op by default; activates when SYNESIS_OTEL_ENABLED=true.

Usage:
    with span("router", mode="initial", requests=6):
        ...
"""

from __future__ import annotations

import os
import time
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

_otel_enabled = os.environ.get("SYNESIS_OTEL_ENABLED", "false").lower() == "true"
_tracer = None


def _get_tracer():
    global _tracer
    if _tracer is not None:
        return _tracer
    try:
        from opentelemetry import trace

        _tracer = trace.get_tracer("synesis")
    except ImportError:
        _tracer = None
    return _tracer


class _NoOpSpan:
    """Placeholder span when OTel is disabled."""

    def set_attribute(self, key: str, value: Any) -> None:
        pass

    def add_event(self, name: str, attributes: dict[str, Any] | None = None) -> None:
        pass

    def set_status(self, *args: Any, **kwargs: Any) -> None:
        pass

    def record_exception(self, exc: BaseException) -> None:
        pass


@contextmanager
def span(name: str, **attributes: Any) -> Generator[_NoOpSpan | Any, None, None]:
    """Context manager wrapping a pipeline hop in an optional OTel span."""
    if not _otel_enabled:
        yield _NoOpSpan()
        return

    tracer = _get_tracer()
    if tracer is None:
        yield _NoOpSpan()
        return

    with tracer.start_as_current_span(name) as otel_span:
        for k, v in attributes.items():
            otel_span.set_attribute(f"synesis.{k}", v)
        start = time.monotonic()
        try:
            yield otel_span
        except Exception as exc:
            otel_span.record_exception(exc)
            raise
        finally:
            otel_span.set_attribute("synesis.duration_ms", round((time.monotonic() - start) * 1000, 1))
