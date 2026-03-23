"""Synesis guardrails core — shared security layer for Planner and Yarn."""

from .pipeline import scan_batch, scan_input, scan_output
from .policy import default_severity
from .policy import lookup as policy_lookup
from .scanner import (
    redact_patterns,
    scan_and_filter_texts,
    scan_messages,
    scan_model_output,
    scan_text,
    scan_web_content,
)
from .schemas import (
    ConfidenceBand,
    EventType,
    GuardrailResult,
    PolicyAction,
    PolicyDecision,
    ScanResult,
    Scope,
    SecurityEvent,
    Severity,
)

__all__ = [
    "ConfidenceBand",
    "EventType",
    "GuardrailResult",
    "PolicyAction",
    "PolicyDecision",
    "ScanResult",
    "Scope",
    "SecurityEvent",
    "Severity",
    "default_severity",
    "policy_lookup",
    "redact_patterns",
    "scan_and_filter_texts",
    "scan_batch",
    "scan_input",
    "scan_messages",
    "scan_model_output",
    "scan_output",
    "scan_text",
    "scan_web_content",
]
