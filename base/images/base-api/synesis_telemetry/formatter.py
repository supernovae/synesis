"""JSON and text log formatters with automatic context injection.

SynesisJSONFormatter — production: one JSON object per line.
SynesisTextFormatter — dev: human-readable with trailing key=value pairs.

Both pull run_id / user_id / node from contextvars automatically.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

from .context import get_context

_BUILTIN_ATTRS = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__)


def _extract_extras(record: logging.LogRecord) -> dict[str, Any]:
    return {k: v for k, v in record.__dict__.items() if k not in _BUILTIN_ATTRS}


class SynesisJSONFormatter(logging.Formatter):
    """Emit one JSON object per log line, auto-injecting request context."""

    def __init__(self, service: str = ""):
        super().__init__()
        self._service = service

    def format(self, record: logging.LogRecord) -> str:
        ctx = get_context()
        extras = _extract_extras(record)

        obj: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname.lower(),
            "service": ctx.get("service", self._service),
            "logger": record.name,
            "event": record.getMessage(),
        }
        if ctx.get("run_id"):
            obj["run_id"] = ctx["run_id"]
        if ctx.get("user_id"):
            obj["user_id"] = ctx["user_id"]
        if ctx.get("node"):
            obj["node"] = ctx["node"]
        if extras:
            obj["data"] = extras

        if record.exc_info and not record.exc_text:
            record.exc_text = self.formatException(record.exc_info)
        if record.exc_text:
            obj["exception"] = record.exc_text

        return json.dumps(obj, default=str, ensure_ascii=False)


class SynesisTextFormatter(logging.Formatter):
    """Dev-friendly text formatter with trailing key=value pairs."""

    def format(self, record: logging.LogRecord) -> str:
        ctx = get_context()
        extras = _extract_extras(record)

        parts = [f"{self.formatTime(record)} {record.name} {record.levelname} {record.getMessage()}"]

        run_id = ctx.get("run_id", "")
        if run_id:
            parts.append(f"run_id={run_id[:12]}")

        if extras:
            parts.append(" ".join(f"{k}={v}" for k, v in extras.items()))

        msg = "  ".join(parts)

        if record.exc_info and not record.exc_text:
            record.exc_text = self.formatException(record.exc_info)
        if record.exc_text:
            msg = f"{msg}\n{record.exc_text}"

        return msg
