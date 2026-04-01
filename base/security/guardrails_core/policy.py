"""Policy matrix engine — deterministic event-to-action mapping.

Looks up (event_type, severity, confidence_band) in a table of rules and
returns the prescribed action, scope, TTL, approval requirements, and
notification channels. Configurable defaults can be overridden at runtime.
"""

from __future__ import annotations

from .schemas import (
    ConfidenceBand,
    EventType,
    PolicyAction,
    PolicyDecision,
    Scope,
    Severity,
)

_MatrixKey = tuple[Severity, ConfidenceBand]

_SEVERITY_DEFAULTS: dict[EventType, Severity] = {
    EventType.SYSTEM_OVERRIDE: Severity.MEDIUM,
    EventType.JAILBREAK_ROLEPLAY: Severity.MEDIUM,
    EventType.CONTEXT_CONFUSION: Severity.MEDIUM,
    EventType.DATA_EXFILTRATION: Severity.HIGH,
    EventType.CODE_EXEC_RISK: Severity.HIGH,
    EventType.CREDENTIAL_EXFIL: Severity.CRITICAL,
    EventType.REPEAT_OFFENDER: Severity.HIGH,
    EventType.PROMPT_LEAKAGE: Severity.MEDIUM,
    EventType.TOOL_ABUSE: Severity.HIGH,
    EventType.UNKNOWN: Severity.LOW,
}

_ACTION_MATRIX: dict[_MatrixKey, PolicyDecision] = {
    # LOW severity
    (Severity.LOW, ConfidenceBand.LOW): PolicyDecision(
        action=PolicyAction.ALLOW,
        severity=Severity.LOW,
        scope=Scope.REQUEST,
        notify_channels=[],
        reason="Low confidence, log only",
    ),
    (Severity.LOW, ConfidenceBand.MEDIUM): PolicyDecision(
        action=PolicyAction.WARN,
        severity=Severity.LOW,
        scope=Scope.REQUEST,
        notify_channels=["dashboard"],
        reason="Low severity, warn",
    ),
    (Severity.LOW, ConfidenceBand.HIGH): PolicyDecision(
        action=PolicyAction.WARN,
        severity=Severity.LOW,
        scope=Scope.REQUEST,
        notify_channels=["dashboard"],
        reason="Low severity, high confidence",
    ),
    # MEDIUM severity
    (Severity.MEDIUM, ConfidenceBand.LOW): PolicyDecision(
        action=PolicyAction.WARN,
        severity=Severity.MEDIUM,
        scope=Scope.REQUEST,
        notify_channels=["dashboard"],
        reason="Medium severity, low confidence",
    ),
    (Severity.MEDIUM, ConfidenceBand.MEDIUM): PolicyDecision(
        action=PolicyAction.SANITIZE,
        severity=Severity.MEDIUM,
        scope=Scope.SESSION,
        notify_channels=["dashboard"],
        reason="Medium severity and confidence; sanitize",
    ),
    (Severity.MEDIUM, ConfidenceBand.HIGH): PolicyDecision(
        action=PolicyAction.SANITIZE,
        severity=Severity.MEDIUM,
        scope=Scope.SESSION,
        notify_channels=["dashboard"],
        reason="Medium severity, high confidence; sanitize + monitor",
    ),
    # HIGH severity
    (Severity.HIGH, ConfidenceBand.LOW): PolicyDecision(
        action=PolicyAction.SANITIZE,
        severity=Severity.HIGH,
        scope=Scope.SESSION,
        notify_channels=["dashboard"],
        reason="High severity, low confidence; sanitize and watch",
    ),
    (Severity.HIGH, ConfidenceBand.MEDIUM): PolicyDecision(
        action=PolicyAction.BLOCK,
        severity=Severity.HIGH,
        scope=Scope.SESSION,
        notify_channels=["dashboard", "webhook"],
        reason="High severity, medium confidence; block request",
    ),
    (Severity.HIGH, ConfidenceBand.HIGH): PolicyDecision(
        action=PolicyAction.RESTRICT_TOOLS,
        severity=Severity.HIGH,
        scope=Scope.SESSION,
        ttl_seconds=1800,
        notify_channels=["dashboard", "webhook"],
        reason="High severity+confidence; block + restrict tools (30 min)",
    ),
    # CRITICAL severity
    (Severity.CRITICAL, ConfidenceBand.LOW): PolicyDecision(
        action=PolicyAction.BLOCK,
        severity=Severity.CRITICAL,
        scope=Scope.SESSION,
        notify_channels=["dashboard", "webhook"],
        reason="Critical severity, low confidence; block pending review",
    ),
    (Severity.CRITICAL, ConfidenceBand.MEDIUM): PolicyDecision(
        action=PolicyAction.FREEZE_TOKEN,
        severity=Severity.CRITICAL,
        scope=Scope.TOKEN,
        ttl_seconds=3600,
        notify_channels=["dashboard", "webhook", "pager"],
        reason="Critical severity, medium confidence; freeze token (60 min)",
    ),
    (Severity.CRITICAL, ConfidenceBand.HIGH): PolicyDecision(
        action=PolicyAction.FREEZE_TOKEN,
        severity=Severity.CRITICAL,
        scope=Scope.TOKEN,
        ttl_seconds=3600,
        requires_approval=False,
        notify_channels=["dashboard", "webhook", "pager"],
        reason="Critical severity+confidence; immediate token freeze + incident",
    ),
}

# Circuit breaker threshold (org/service scope)
CIRCUIT_BREAKER_THRESHOLD = 10  # high/critical events
CIRCUIT_BREAKER_WINDOW_SECONDS = 300  # 5 minutes
CIRCUIT_BREAKER_TTL = 900  # 15 minutes


def default_severity(event_type: EventType) -> Severity:
    return _SEVERITY_DEFAULTS.get(event_type, Severity.LOW)


def lookup(
    event_type: EventType,
    confidence: float,
    severity_override: Severity | None = None,
) -> PolicyDecision:
    """Look up the policy decision for an event.

    Returns a *copy* so callers can mutate without affecting the matrix.
    """
    severity = severity_override or default_severity(event_type)
    band = ConfidenceBand.from_score(confidence)
    key: _MatrixKey = (severity, band)

    template = _ACTION_MATRIX.get(key)
    if template is None:
        return PolicyDecision(
            action=PolicyAction.WARN,
            severity=severity,
            scope=Scope.REQUEST,
            reason=f"No matrix entry for {key}",
        )

    return PolicyDecision(
        action=template.action,
        severity=template.severity,
        scope=template.scope,
        ttl_seconds=template.ttl_seconds,
        requires_approval=template.requires_approval,
        notify_channels=list(template.notify_channels),
        reason=template.reason,
    )
