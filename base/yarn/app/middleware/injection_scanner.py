"""Prompt-injection scanner — thin shim over guardrails_core.

Preserves the existing Yarn API surface (scan_text, scan_messages)
while delegating to the shared guardrails_core scanner.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from guardrails_core import scanner as _gc_scanner

logger = logging.getLogger("yarn.middleware.injection")


@dataclass
class ScanResult:
    """Yarn-local result shape (backward compatible)."""

    detected: bool = False
    patterns_found: list[str] = field(default_factory=list)
    sanitized_text: str = ""


def scan_text(text: str) -> ScanResult:
    """Scan text for injection patterns. Returns sanitized text with matches redacted."""
    if not text:
        return ScanResult(sanitized_text=text or "")
    core = _gc_scanner.scan_text(text, source="yarn_input")
    if core.detected:
        sanitized = _gc_scanner.redact_patterns(text)
        return ScanResult(detected=True, patterns_found=core.patterns_found, sanitized_text=sanitized)
    return ScanResult(sanitized_text=text)


def scan_messages(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    """Scan untrusted client-supplied chat roles for injection patterns.

    Returns (possibly-sanitized messages, injection_detected).
    """
    scanned, detected, _results = _gc_scanner.scan_messages(messages)
    if detected:
        logger.warning("Injection patterns detected in client messages")
    return scanned, detected
