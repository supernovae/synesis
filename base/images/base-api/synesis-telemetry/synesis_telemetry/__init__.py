"""Synesis Telemetry — shared structured logging, context, spans, and metrics.

Public API:
    configure_logging(service, level, fmt)  — call once at service startup
    get_logger(name)                        — stdlib logger with context injection
    set_request_context(run_id, user_id)    — set per-request context
    set_node(name)                          — set current node context
    span(name, **attrs)                     — OTel-ready span (no-op by default)
"""

from __future__ import annotations

import logging
import os
from typing import Literal

from .context import get_context, set_node, set_request_context, set_service_name
from .formatter import SynesisJSONFormatter, SynesisTextFormatter
from .metrics import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from .spans import span

_NOISY_LOGGERS = ("openai", "httpx", "httpcore")


def configure_logging(
    service: str = "",
    level: str | None = None,
    fmt: Literal["json", "text"] | None = None,
    suppress_noisy: bool = True,
) -> None:
    """Configure structured logging for a Synesis service. Call once at startup."""
    resolved_level = (level or os.environ.get("SYNESIS_LOG_LEVEL", "info")).upper()
    resolved_fmt = fmt or os.environ.get("SYNESIS_LOG_FORMAT", "json")

    if service:
        set_service_name(service)

    handler = logging.StreamHandler()
    if resolved_fmt == "json":
        handler.setFormatter(SynesisJSONFormatter(service=service))
    else:
        handler.setFormatter(SynesisTextFormatter())

    logging.basicConfig(
        level=getattr(logging, resolved_level, logging.INFO),
        handlers=[handler],
        force=True,
    )

    if suppress_noisy and resolved_level != "DEBUG":
        for name in _NOISY_LOGGERS:
            logging.getLogger(name).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Return a stdlib logger. Context (run_id, etc.) is injected by the formatter."""
    return logging.getLogger(name)


__all__ = [
    "CONTENT_TYPE_LATEST",
    "Counter",
    "Gauge",
    "Histogram",
    "configure_logging",
    "generate_latest",
    "get_context",
    "get_logger",
    "set_node",
    "set_request_context",
    "span",
]
