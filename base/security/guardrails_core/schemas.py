"""Unified data models for guardrail detection, policy decisions, and audit events.

These types are consumed by both Planner and Yarn runtimes and by the Admin
safety operations surface. Keep this module dependency-free (stdlib + enum only)
so it can be imported without pulling in web frameworks.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class EventType(str, Enum):
    SYSTEM_OVERRIDE = "system_override_attempt"
    JAILBREAK_ROLEPLAY = "jailbreak_roleplay"
    CONTEXT_CONFUSION = "context_confusion_attack"
    DATA_EXFILTRATION = "data_exfiltration_attempt"
    CODE_EXEC_RISK = "injected_code_execution_risk"
    CREDENTIAL_EXFIL = "credential_or_secret_exfil_pattern"
    REPEAT_OFFENDER = "repeat_offender_pattern"
    PROMPT_LEAKAGE = "prompt_leakage_attempt"
    TOOL_ABUSE = "tool_abuse"
    UNKNOWN = "unknown"


class Severity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ConfidenceBand(str, Enum):
    LOW = "low"  # < 0.60
    MEDIUM = "medium"  # 0.60 - 0.79
    HIGH = "high"  # >= 0.80

    @classmethod
    def from_score(cls, score: float) -> ConfidenceBand:
        if score >= 0.80:
            return cls.HIGH
        if score >= 0.60:
            return cls.MEDIUM
        return cls.LOW


class PolicyAction(str, Enum):
    ALLOW = "allow"
    WARN = "warn"
    SANITIZE = "sanitize"
    BLOCK = "block"
    ESCALATE = "escalate"
    FREEZE_TOKEN = "freeze_token"
    RESTRICT_TOOLS = "restrict_tools"
    CIRCUIT_BREAK = "circuit_break"


class Scope(str, Enum):
    REQUEST = "request"
    SESSION = "session"
    TOKEN = "token"
    ORG = "org"
    SERVICE = "service"


@dataclass
class ScanResult:
    """Result from a single scan pass (regex, classifier, or external detector)."""

    detected: bool = False
    patterns_found: list[str] = field(default_factory=list)
    source: str = ""
    excerpt: str = ""
    tier: str = "core"
    confidence: float = 0.0
    event_type: EventType = EventType.UNKNOWN
    scanner_name: str = "regex"
    latency_ms: float = 0.0


@dataclass
class GuardrailResult:
    """Aggregate result after all scan passes + policy lookup for one request."""

    detected: bool = False
    scans: list[ScanResult] = field(default_factory=list)
    action: PolicyAction = PolicyAction.ALLOW
    severity: Severity = Severity.LOW
    confidence_band: ConfidenceBand = ConfidenceBand.LOW
    scope: Scope = Scope.REQUEST
    sanitized_text: str = ""
    reason: str = ""
    ttl_seconds: int = 0
    requires_approval: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class PolicyDecision:
    """Output of the policy matrix lookup for a given event."""

    action: PolicyAction = PolicyAction.ALLOW
    severity: Severity = Severity.LOW
    scope: Scope = Scope.REQUEST
    ttl_seconds: int = 0
    requires_approval: bool = False
    notify_channels: list[str] = field(default_factory=list)
    reason: str = ""


@dataclass
class SecurityEvent:
    """Structured event emitted to audit log and alert routing."""

    event_id: str = ""
    timestamp: float = field(default_factory=time.time)
    event_type: EventType = EventType.UNKNOWN
    severity: Severity = Severity.LOW
    confidence: float = 0.0
    confidence_band: ConfidenceBand = ConfidenceBand.LOW
    action_taken: PolicyAction = PolicyAction.ALLOW
    scope: Scope = Scope.REQUEST

    service: str = ""  # "planner" or "yarn"
    request_id: str = ""
    session_id: str = ""
    user_id: str = ""
    token_id: str = ""
    org_id: str = ""

    patterns_found: list[str] = field(default_factory=list)
    excerpt: str = ""
    scanner_name: str = ""
    latency_ms: float = 0.0
    detail: dict[str, Any] = field(default_factory=dict)
