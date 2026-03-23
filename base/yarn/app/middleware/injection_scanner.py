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


def _scan_tool_call_arguments(tool_calls: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    """Sanitize string arguments inside assistant tool_calls (untrusted client transcript)."""
    any_detected = False
    out: list[dict[str, Any]] = []
    for tc in tool_calls:
        tc_copy = dict(tc)
        fn = tc_copy.get("function")
        if isinstance(fn, dict) and isinstance(fn.get("arguments"), str):
            scan = scan_text(fn["arguments"])
            if scan.detected:
                any_detected = True
                fn = dict(fn)
                fn["arguments"] = scan.sanitized_text
                tc_copy["function"] = fn
        out.append(tc_copy)
    return out, any_detected


def scan_messages(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    """Scan untrusted client-supplied chat roles for injection patterns.

    Returns (possibly-sanitized messages, injection_detected).

    OpenAI-shaped clients may place IDE context in user, assistant, tool, or
    even system messages. None of these are server authority: scan and
    redact before they influence logging or any future merge paths. (Yarn
    still pins server system + tools separately from this transcript.)
    """
    injection_detected = False
    result: list[dict[str, Any]] = []

    untrusted_roles = frozenset({"user", "assistant", "tool", "system"})

    for msg in messages:
        role = msg.get("role", "")
        if role not in untrusted_roles:
            result.append(msg)
            continue

        new_msg = dict(msg)
        content = new_msg.get("content")
        if isinstance(content, str) and content:
            scan = scan_text(content)
            if scan.detected:
                injection_detected = True
                logger.warning("Injection patterns found (%s): %s", role, scan.patterns_found)
                new_msg["content"] = scan.sanitized_text

        if role == "assistant" and new_msg.get("tool_calls"):
            tcs, tc_detected = _scan_tool_call_arguments(new_msg["tool_calls"])
            if tc_detected:
                injection_detected = True
                new_msg["tool_calls"] = tcs

        result.append(new_msg)

    return result, injection_detected
