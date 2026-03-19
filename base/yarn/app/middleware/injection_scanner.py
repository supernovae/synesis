"""Prompt-injection scanner — ported from base/planner/app/injection_scanner.py.

Scans untrusted input for known injection patterns. Returns a scan result
with matched patterns and a sanitized version of the text.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("yarn.middleware.injection")

_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?", re.IGNORECASE),
    re.compile(r"disregard\s+(?:all\s+)?(?:previous|prior|above)", re.IGNORECASE),
    re.compile(r"forget\s+(?:everything|all)\s+(?:you\s+)?(?:were\s+)?told", re.IGNORECASE),
    re.compile(r"new\s+instructions?\s*:", re.IGNORECASE),
    re.compile(r"override\s+(?:your\s+)?(?:instructions?|prompt)", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(?:a|an)\s", re.IGNORECASE),
    re.compile(r"pretend\s+you\s+are", re.IGNORECASE),
    re.compile(r"system\s*:\s*", re.IGNORECASE),
    re.compile(r"<\|im_start\|>\s*system", re.IGNORECASE),
    re.compile(r"###\s*human\s*:", re.IGNORECASE),
    re.compile(r"\[INST\]\s*", re.IGNORECASE),
    re.compile(r"ignore\s+the\s+above", re.IGNORECASE),
    re.compile(r"follow\s+these\s+instructions?\s+instead", re.IGNORECASE),
    re.compile(r"(?:DAN|developer)\s+mode\s+(?:enabled|activated|on)", re.IGNORECASE),
    re.compile(r"(?:do\s+anything\s+now|unlimited\s+mode)", re.IGNORECASE),
]


@dataclass
class ScanResult:
    detected: bool = False
    patterns_found: list[str] = field(default_factory=list)
    sanitized_text: str = ""


def scan_text(text: str) -> ScanResult:
    """Scan text for injection patterns. Returns sanitized text with matches redacted."""
    if not text:
        return ScanResult(sanitized_text=text)

    found: list[str] = []
    sanitized = text

    for pattern in _INJECTION_PATTERNS:
        matches = pattern.findall(text)
        if matches:
            found.extend(matches)
            sanitized = pattern.sub("[REDACTED]", sanitized)

    return ScanResult(
        detected=bool(found),
        patterns_found=found,
        sanitized_text=sanitized,
    )


def scan_messages(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    """Scan all user messages for injection patterns.

    Returns (possibly-sanitized messages, injection_detected).
    Only user messages are scanned; system/assistant messages are trusted.
    """
    injection_detected = False
    result: list[dict[str, Any]] = []

    for msg in messages:
        if msg.get("role") == "user" and msg.get("content"):
            scan = scan_text(msg["content"])
            if scan.detected:
                injection_detected = True
                logger.warning(
                    "Injection patterns found: %s", scan.patterns_found
                )
                result.append({**msg, "content": scan.sanitized_text})
            else:
                result.append(msg)
        else:
            result.append(msg)

    return result, injection_detected
