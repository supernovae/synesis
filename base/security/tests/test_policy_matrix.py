"""Comprehensive coverage test for the policy matrix — validates the plan's thresholds."""

from __future__ import annotations

from guardrails_core.policy import (
    CIRCUIT_BREAKER_THRESHOLD,
    CIRCUIT_BREAKER_TTL,
    CIRCUIT_BREAKER_WINDOW_SECONDS,
    default_severity,
    lookup,
)
from guardrails_core.schemas import (
    ConfidenceBand,
    EventType,
    PolicyAction,
    Severity,
)


class TestDefaultSeverities:
    """Per plan: severity defaults by event type."""

    def test_system_override_medium(self):
        assert default_severity(EventType.SYSTEM_OVERRIDE) == Severity.MEDIUM

    def test_jailbreak_roleplay_medium(self):
        assert default_severity(EventType.JAILBREAK_ROLEPLAY) == Severity.MEDIUM

    def test_context_confusion_medium(self):
        assert default_severity(EventType.CONTEXT_CONFUSION) == Severity.MEDIUM

    def test_data_exfiltration_high(self):
        assert default_severity(EventType.DATA_EXFILTRATION) == Severity.HIGH

    def test_code_exec_risk_high(self):
        assert default_severity(EventType.CODE_EXEC_RISK) == Severity.HIGH

    def test_credential_exfil_critical(self):
        assert default_severity(EventType.CREDENTIAL_EXFIL) == Severity.CRITICAL

    def test_repeat_offender_high(self):
        assert default_severity(EventType.REPEAT_OFFENDER) == Severity.HIGH

    def test_prompt_leakage_medium(self):
        assert default_severity(EventType.PROMPT_LEAKAGE) == Severity.MEDIUM


class TestConfidenceBands:
    """Per plan: low <0.60, medium 0.60-0.79, high >=0.80."""

    def test_low_band(self):
        assert ConfidenceBand.from_score(0.3) == ConfidenceBand.LOW
        assert ConfidenceBand.from_score(0.59) == ConfidenceBand.LOW

    def test_medium_band(self):
        assert ConfidenceBand.from_score(0.60) == ConfidenceBand.MEDIUM
        assert ConfidenceBand.from_score(0.79) == ConfidenceBand.MEDIUM

    def test_high_band(self):
        assert ConfidenceBand.from_score(0.80) == ConfidenceBand.HIGH
        assert ConfidenceBand.from_score(0.99) == ConfidenceBand.HIGH


class TestMediumSeverityActions:
    """Per plan: medium+high confidence -> sanitize + warn + increased monitoring."""

    def test_medium_sev_low_conf_warns(self):
        d = lookup(EventType.SYSTEM_OVERRIDE, 0.4)
        assert d.action == PolicyAction.WARN

    def test_medium_sev_medium_conf_sanitizes(self):
        d = lookup(EventType.SYSTEM_OVERRIDE, 0.7)
        assert d.action == PolicyAction.SANITIZE

    def test_medium_sev_high_conf_sanitizes(self):
        d = lookup(EventType.SYSTEM_OVERRIDE, 0.9)
        assert d.action == PolicyAction.SANITIZE


class TestHighSeverityActions:
    """Per plan: high+high confidence -> block + restrict tools (30 min TTL)."""

    def test_high_sev_medium_conf_blocks(self):
        d = lookup(EventType.DATA_EXFILTRATION, 0.7)
        assert d.action == PolicyAction.BLOCK

    def test_high_sev_high_conf_restricts_tools(self):
        d = lookup(EventType.DATA_EXFILTRATION, 0.9)
        assert d.action == PolicyAction.RESTRICT_TOOLS
        assert d.ttl_seconds == 1800  # 30 minutes

    def test_high_sev_high_conf_notifies_webhook(self):
        d = lookup(EventType.DATA_EXFILTRATION, 0.9)
        assert "webhook" in d.notify_channels


class TestCriticalSeverityActions:
    """Per plan: critical+high confidence -> freeze token (60 min), pager."""

    def test_critical_high_conf_freezes_token(self):
        d = lookup(EventType.CREDENTIAL_EXFIL, 0.9)
        assert d.action == PolicyAction.FREEZE_TOKEN
        assert d.ttl_seconds == 3600  # 60 minutes

    def test_critical_high_conf_pages(self):
        d = lookup(EventType.CREDENTIAL_EXFIL, 0.9)
        assert "pager" in d.notify_channels

    def test_critical_medium_conf_freezes(self):
        d = lookup(EventType.CREDENTIAL_EXFIL, 0.7)
        assert d.action == PolicyAction.FREEZE_TOKEN


class TestNotificationRouting:
    """Per plan: high -> dashboard+webhook, critical -> dashboard+webhook+pager."""

    def test_low_dashboard_only(self):
        d = lookup(EventType.UNKNOWN, 0.7)  # low severity, medium conf
        assert d.notify_channels == ["dashboard"]

    def test_high_sev_high_conf_has_webhook(self):
        d = lookup(EventType.DATA_EXFILTRATION, 0.9)
        assert "dashboard" in d.notify_channels
        assert "webhook" in d.notify_channels

    def test_critical_has_pager(self):
        d = lookup(EventType.CREDENTIAL_EXFIL, 0.9)
        assert "pager" in d.notify_channels


class TestCircuitBreakerDefaults:
    """Per plan: >=10 events in 5 min, 15 min TTL."""

    def test_threshold(self):
        assert CIRCUIT_BREAKER_THRESHOLD == 10

    def test_window(self):
        assert CIRCUIT_BREAKER_WINDOW_SECONDS == 300

    def test_ttl(self):
        assert CIRCUIT_BREAKER_TTL == 900


class TestSeverityOverride:
    def test_override_escalates_action(self):
        d = lookup(EventType.UNKNOWN, 0.9, severity_override=Severity.CRITICAL)
        assert d.action == PolicyAction.FREEZE_TOKEN


class TestReturnsCopy:
    def test_mutations_dont_affect_matrix(self):
        d1 = lookup(EventType.CREDENTIAL_EXFIL, 0.9)
        d1.notify_channels.append("custom")
        d2 = lookup(EventType.CREDENTIAL_EXFIL, 0.9)
        assert "custom" not in d2.notify_channels
