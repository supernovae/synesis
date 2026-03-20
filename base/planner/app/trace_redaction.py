"""Redact secrets and sensitive patterns from trace payloads before Postgres persist.

Defense in depth: callers should still avoid logging Authorization headers.
Configurable via SYNESIS_TRACE_REDACT_PATTERNS (pipe-separated regex, optional).
"""

from __future__ import annotations

import os
import re
from copy import deepcopy
from typing import Any

_DEFAULT_HEADER_KEYS = frozenset(
    {
        "authorization",
        "cookie",
        "x-api-key",
        "x-auth-token",
        "api-key",
        "openai-api-key",
        "proxy-authorization",
    }
)

# Mask values that look like Bearer tokens or long secrets in free text
_BEARER_RE = re.compile(r"(?i)(bearer\s+)([a-z0-9._\-]{16,})", re.I)
_SK_RE = re.compile(r"(?i)(sk-[a-z0-9]{16,})")
_PEM_BLOCK = re.compile(r"-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----")


def _extra_patterns() -> list[re.Pattern[str]]:
    raw = (os.environ.get("SYNESIS_TRACE_REDACT_PATTERNS") or "").strip()
    if not raw:
        return []
    out: list[re.Pattern[str]] = []
    for part in raw.split("|"):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(re.compile(part))
        except re.error:
            continue
    return out


def redact_string(s: str) -> str:
    if not s:
        return s
    t = _BEARER_RE.sub(r"\1[REDACTED]", s)
    t = _SK_RE.sub("[REDACTED]", t)
    t = _PEM_BLOCK.sub("[REDACTED PEM]", t)
    for pat in _extra_patterns():
        t = pat.sub("[REDACTED]", t)
    return t


def redact_trace_payload(obj: Any) -> Any:
    """Deep-copy and redact dict/list/str structures (e.g. trace full_record)."""
    if obj is None:
        return None
    if isinstance(obj, str):
        return redact_string(obj)
    if isinstance(obj, (int, float, bool)):
        return obj
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in deepcopy(obj).items():
            lk = str(k).lower()
            if lk in _DEFAULT_HEADER_KEYS or "secret" in lk or "password" in lk or "api_key" in lk:
                out[k] = "[REDACTED]"
            elif isinstance(v, str):
                out[k] = redact_string(v)
            else:
                out[k] = redact_trace_payload(v)
        return out
    if isinstance(obj, list):
        return [redact_trace_payload(x) for x in obj]
    return obj
