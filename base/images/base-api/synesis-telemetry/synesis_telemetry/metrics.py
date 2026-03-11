"""Thin metrics wrapper around prometheus_client.

Re-exports standard metric types so services don't import
prometheus_client directly. Gracefully degrades if prometheus_client
is unavailable.
"""

from __future__ import annotations

from typing import Any

try:
    from prometheus_client import (
        CONTENT_TYPE_LATEST,
        Counter,
        Gauge,
        Histogram,
        generate_latest,
    )
except ImportError:

    class _Stub:
        def __init__(self, *a: Any, **kw: Any) -> None:
            pass

        def labels(self, **kw: Any) -> _Stub:
            return self

        def inc(self, amount: float = 1) -> None:
            pass

        def set(self, value: float) -> None:
            pass

        def observe(self, value: float) -> None:
            pass

    Counter = _Stub  # type: ignore[misc,assignment]
    Gauge = _Stub  # type: ignore[misc,assignment]
    Histogram = _Stub  # type: ignore[misc,assignment]
    CONTENT_TYPE_LATEST = "text/plain"

    def generate_latest() -> bytes:  # type: ignore[misc]
        return b""


__all__ = [
    "CONTENT_TYPE_LATEST",
    "Counter",
    "Gauge",
    "Histogram",
    "generate_latest",
]
