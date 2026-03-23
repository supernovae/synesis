"""Prompt-injection scanner — thin shim over guardrails_core.

Preserves the existing API surface (scan_text, scan_web_content,
scan_model_output, scan_user_input, scan_and_filter_rag_context,
scan_and_sanitize_web_results, reduce_context_on_injection) so all
callers in the planner continue to work unchanged.

The heavy lifting is in the shared guardrails_core package at
base/security/guardrails_core/.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from guardrails_core import scanner as _gc_scanner
from guardrails_core.schemas import ScanResult as _CoreScanResult

logger = logging.getLogger("synesis.injection_scanner")


@dataclass
class ScanResult:
    """Planner-local scan result (compatible with existing state/telemetry)."""

    detected: bool = False
    patterns_found: list[str] = None  # type: ignore[assignment]
    source: str = ""
    excerpt: str = ""
    tier: str = "core"

    def __post_init__(self) -> None:
        if self.patterns_found is None:
            self.patterns_found = []


def _adapt(core: _CoreScanResult) -> ScanResult:
    return ScanResult(
        detected=core.detected,
        patterns_found=core.patterns_found,
        source=core.source,
        excerpt=core.excerpt,
        tier=core.tier,
    )


def scan_text(text: str, source: str = "unknown", max_scan_chars: int = 32_000) -> ScanResult:
    return _adapt(_gc_scanner.scan_text(text, source=source, max_scan_chars=max_scan_chars))


def scan_web_content(text: str, source: str = "web", max_scan_chars: int = 32_000) -> ScanResult:
    r = _adapt(_gc_scanner.scan_web_content(text, source=source, max_scan_chars=max_scan_chars))
    if r.detected:
        logger.warning(
            "injection_scan_web_content",
            extra={"source": source, "patterns": r.patterns_found[:5], "excerpt": r.excerpt[:200]},
        )
    return r


def scan_model_output(output: str, source: str = "model_output") -> ScanResult:
    return _adapt(_gc_scanner.scan_model_output(output, source=source))


def reduce_context_on_injection(text: str, _pattern_match: str = "") -> str:
    return _gc_scanner.redact_patterns(text, include_web=True)


def scan_user_input(
    user_content: str,
    conversation_history: list[str],
) -> tuple[bool, dict[str, Any]]:
    results: list[ScanResult] = []

    if user_content:
        r = scan_text(user_content, source="user_message")
        results.append(r)
        if r.detected:
            logger.warning(
                "injection_scan_user_message",
                extra={"patterns": r.patterns_found, "excerpt": r.excerpt[:200]},
            )

    for i, turn in enumerate(conversation_history[-5:]):
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
    return _gc_scanner.scan_and_filter_texts(rag_chunks, source_prefix="rag_chunk", action=action, web=False)


def scan_and_sanitize_web_results(
    texts: list[str],
    action: str = "reduce",
) -> tuple[list[str], bool, list[dict[str, Any]]]:
    return _gc_scanner.scan_and_filter_texts(texts, source_prefix="web_result", action=action, web=True)
