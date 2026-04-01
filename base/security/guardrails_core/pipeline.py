"""Request-level guardrail pipeline — scan, classify, decide, emit event.

This is the single entry point that both Planner and Yarn call. It runs
the fast-path regex scanner, classifies severity, looks up the policy
matrix, and returns a GuardrailResult ready for enforcement.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from .metrics import record_detection, record_scan_latency
from .policy import lookup as policy_lookup
from .scanner import redact_patterns, scan_model_output, scan_text, scan_web_content
from .schemas import (
    ConfidenceBand,
    GuardrailResult,
    PolicyAction,
    ScanResult,
    Scope,
    SecurityEvent,
    Severity,
)


def scan_input(
    text: str,
    source: str = "user",
    web: bool = False,
    service: str = "",
    request_id: str = "",
    session_id: str = "",
    user_id: str = "",
    token_id: str = "",
    org_id: str = "",
) -> tuple[GuardrailResult, SecurityEvent | None]:
    """Run the full input guardrail pipeline on a single text block.

    Returns (result, event). event is None when nothing was detected.
    """
    scan_fn = scan_web_content if web else scan_text
    scan = scan_fn(text, source=source)

    if not scan.detected:
        return GuardrailResult(sanitized_text=text), None

    decision = policy_lookup(scan.event_type, scan.confidence)

    sanitized = text
    if decision.action in (
        PolicyAction.SANITIZE,
        PolicyAction.BLOCK,
        PolicyAction.RESTRICT_TOOLS,
        PolicyAction.FREEZE_TOKEN,
        PolicyAction.CIRCUIT_BREAK,
    ):
        sanitized = redact_patterns(text, include_web=web)

    result = GuardrailResult(
        detected=True,
        scans=[scan],
        action=decision.action,
        severity=decision.severity,
        confidence_band=ConfidenceBand.from_score(scan.confidence),
        scope=decision.scope,
        sanitized_text=sanitized,
        reason=decision.reason,
        ttl_seconds=decision.ttl_seconds,
        requires_approval=decision.requires_approval,
    )

    event = SecurityEvent(
        event_id=f"grd-{uuid.uuid4().hex[:12]}",
        timestamp=time.time(),
        event_type=scan.event_type,
        severity=decision.severity,
        confidence=scan.confidence,
        confidence_band=ConfidenceBand.from_score(scan.confidence),
        action_taken=decision.action,
        scope=decision.scope,
        service=service,
        request_id=request_id,
        session_id=session_id,
        user_id=user_id,
        token_id=token_id,
        org_id=org_id,
        patterns_found=scan.patterns_found,
        excerpt=scan.excerpt[:200],
        scanner_name=scan.scanner_name,
        latency_ms=scan.latency_ms,
    )

    record_detection(service, scan.event_type.value, decision.severity.value, decision.action.value)
    record_scan_latency(service, scan.scanner_name, scan.latency_ms / 1000)

    return result, event


def scan_output(
    text: str,
    service: str = "",
    request_id: str = "",
) -> tuple[ScanResult, SecurityEvent | None]:
    """Run the output guardrail on model-generated text."""
    scan = scan_model_output(text)
    if not scan.detected:
        return scan, None

    event = SecurityEvent(
        event_id=f"grd-{uuid.uuid4().hex[:12]}",
        timestamp=time.time(),
        event_type=scan.event_type,
        severity=Severity.MEDIUM,
        confidence=scan.confidence,
        confidence_band=ConfidenceBand.from_score(scan.confidence),
        action_taken=PolicyAction.WARN,
        scope=Scope.REQUEST,
        service=service,
        request_id=request_id,
        scanner_name=scan.scanner_name,
        latency_ms=scan.latency_ms,
        patterns_found=scan.patterns_found,
        excerpt=scan.excerpt[:200],
    )
    return scan, event


def scan_batch(
    texts: list[str],
    source_prefix: str = "chunk",
    web: bool = False,
    action: str = "reduce",
) -> tuple[list[str], bool, list[dict[str, Any]]]:
    """Scan a batch (RAG chunks, web results); filter per action."""
    from .scanner import scan_and_filter_texts

    return scan_and_filter_texts(texts, source_prefix=source_prefix, action=action, web=web)
