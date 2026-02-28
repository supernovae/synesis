"""Prompt-injection scanner for IDE/agent client coordination.

Scans user messages, RAG context, conversation history for known injection
patterns. Treat all injected repo text as untrusted; only system prompts
and graph state from our nodes are trusted.

Reference: OWASP LLM prompt injection, Cursor/Claude doc context risks.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("synesis.injection_scanner")

# Patterns that suggest prompt injection (case-insensitive)
# Sources: OWASP, documented attacks, common obfuscations
_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?", re.IGNORECASE),
    re.compile(r"disregard\s+(?:all\s+)?(?:previous|prior|above)", re.IGNORECASE),
    re.compile(r"forget\s+(?:everything|all)\s+(?:you\s+)?(?:were\s+)?told", re.IGNORECASE),
    re.compile(r"new\s+instructions?\s*:", re.IGNORECASE),
    re.compile(r"override\s+(?:your\s+)?(?:instructions?|prompt)", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(?:a|an)\s", re.IGNORECASE),
    re.compile(r"pretend\s+you\s+are", re.IGNORECASE),
    re.compile(r"act\s+as\s+if\s+you", re.IGNORECASE),
    re.compile(r"system\s*:\s*", re.IGNORECASE),
    re.compile(r"<\|im_start\|>\s*system", re.IGNORECASE),
    re.compile(r"###\s*human\s*:", re.IGNORECASE),
    re.compile(r"\[INST\]\s*", re.IGNORECASE),  # Llama chat template
    re.compile(r"<\/?s(?:ystem)?>", re.IGNORECASE),  # XML-style role tags
    re.compile(r"ignore\s+the\s+above", re.IGNORECASE),
    re.compile(r"follow\s+these\s+instructions?\s+instead", re.IGNORECASE),
    re.compile(r"output\s+(?:only|just)\s+the\s+following", re.IGNORECASE),
    re.compile(r"print\s+(?:exactly|only)\s+this\s*:", re.IGNORECASE),
]


@dataclass
class ScanResult:
    """Result of injection scan on a text block."""

    detected: bool
    patterns_found: list[str]
    source: str
    excerpt: str = ""


def scan_text(text: str, source: str = "unknown", max_scan_chars: int = 32_000) -> ScanResult:
    """Scan text for known prompt-injection patterns.

    Args:
        text: Raw input (user message, RAG chunk, conversation turn)
        source: Label for provenance ("user_message", "rag", "conversation_history")
        max_scan_chars: Limit scan to first N chars to avoid DoS

    Returns:
        ScanResult with detected=True if any pattern matched
    """
    if not text or not isinstance(text, str):
        return ScanResult(detected=False, patterns_found=[], source=source)

    to_scan = text[:max_scan_chars]
    patterns_found: list[str] = []

    for pat in _INJECTION_PATTERNS:
        match = pat.search(to_scan)
        if match:
            patterns_found.append(match.group(0)[:80])
            # Continue scanning for other patterns

    # Build excerpt around first match for logging
    excerpt = ""
    if patterns_found:
        first_match = next(
            (m for p in _INJECTION_PATTERNS for m in [p.search(to_scan)] if m),
            None,
        )
        if first_match:
            start = max(0, first_match.start() - 50)
            end = min(len(to_scan), first_match.end() + 50)
            excerpt = to_scan[start:end].replace("\n", " ")

    return ScanResult(
        detected=len(patterns_found) > 0,
        patterns_found=patterns_found,
        source=source,
        excerpt=excerpt,
    )


def reduce_context_on_injection(text: str, pattern_match: str) -> str:
    """Reduce context by redacting spans around injection patterns.

    Conservative: replace matching substring with [REDACTED].
    """
    for pat in _INJECTION_PATTERNS:
        text = pat.sub("[REDACTED]", text)
    return text


def scan_user_input(
    user_content: str,
    conversation_history: list[str],
) -> tuple[bool, dict[str, Any]]:
    """Scan all user-facing input at API entry.

    Returns (detected, scan_result_dict for state).
    """
    results: list[ScanResult] = []

    if user_content:
        r = scan_text(user_content, source="user_message")
        results.append(r)
        if r.detected:
            logger.warning(
                "injection_scan_user_message",
                extra={"patterns": r.patterns_found, "excerpt": r.excerpt[:200]},
            )

    for i, turn in enumerate(conversation_history[-5:]):  # Last 5 turns
        r = scan_text(turn, source=f"conversation_history_{i}")
        results.append(r)
        if r.detected:
            logger.warning(
                "injection_scan_conversation",
                extra={"patterns": r.patterns_found, "turn_index": i},
            )

    any_detected = any(r.detected for r in results)
    scan_result = {
        "detected": any_detected,
        "sources_scanned": [r.source for r in results],
        "patterns_found": list({p for r in results for p in r.patterns_found}),
        "details": [{"source": r.source, "patterns": r.patterns_found} for r in results if r.detected],
    }
    return any_detected, scan_result


def scan_and_filter_rag_context(
    rag_chunks: list[str],
    action: str = "reduce",
) -> tuple[list[str], bool, list[dict[str, Any]]]:
    """Scan RAG chunks for injection; filter or redact based on action.

    Returns (filtered_chunks, any_detected, details_for_logging).
    """
    filtered: list[str] = []
    any_detected = False
    details: list[dict[str, Any]] = []

    for i, chunk in enumerate(rag_chunks):
        if not chunk:
            filtered.append(chunk)
            continue
        r = scan_text(chunk, source=f"rag_chunk_{i}")
        if r.detected:
            any_detected = True
            details.append({"index": i, "patterns": r.patterns_found})
            if action == "reduce":
                filtered.append(reduce_context_on_injection(chunk, ""))
            elif action == "block":
                continue
            else:
                filtered.append(chunk)
        else:
            filtered.append(chunk)

    return filtered, any_detected, details
