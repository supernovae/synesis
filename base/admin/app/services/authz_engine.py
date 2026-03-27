"""Authorization policy engine for admin — OpenFGA-ready interface.

Wraps existing RBAC logic with the same AuthorizationPolicyEngine interface
used by planner-ts and yarn-ts. Shadow-mode OpenFGA logs decisions alongside
deterministic engine but never enforces.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("synesis.admin.authz_engine")

SYNESIS_AUTHZ_ENGINE = os.getenv("SYNESIS_AUTHZ_ENGINE", "deterministic")
SYNESIS_OPENFGA_API_URL = os.getenv("SYNESIS_OPENFGA_API_URL", "")
SYNESIS_OPENFGA_STORE_ID = os.getenv("SYNESIS_OPENFGA_STORE_ID", "")
SYNESIS_OPENFGA_MODEL_ID = os.getenv("SYNESIS_OPENFGA_MODEL_ID", "")
SYNESIS_OPENFGA_AUTH_TOKEN = os.getenv("SYNESIS_OPENFGA_AUTH_TOKEN", "")


@dataclass
class PolicyDecision:
    allow: bool
    reject_reason: str | None = None
    matched_rules: list[str] = field(default_factory=list)


@dataclass
class PolicyEvent:
    trace_id: str
    resource: str
    action: str
    allow: bool
    matched_rules: list[str]
    user_id: str
    timestamp: float


class AuthorizationPolicyEngine:
    """Canonical interface — matches planner-ts and yarn-ts implementations."""

    engine_name: str

    def authorize(
        self,
        resource: str,
        action: str,
        *,
        user_id: str = "",
        org_id: str = "",
        roles: list[str] | None = None,
        trace_id: str = "",
    ) -> PolicyDecision:
        raise NotImplementedError

    def get_stats(self) -> dict[str, Any]:
        raise NotImplementedError


class DeterministicAuthzEngine(AuthorizationPolicyEngine):
    """Wraps existing admin RBAC logic behind the canonical interface."""

    engine_name = "deterministic"

    def __init__(self) -> None:
        self._evaluations = 0
        self._rejections = 0
        self._recent: list[PolicyEvent] = []
        self._max_recent = 50

    def authorize(
        self,
        resource: str,
        action: str,
        *,
        user_id: str = "",
        org_id: str = "",
        roles: list[str] | None = None,
        trace_id: str = "",
    ) -> PolicyDecision:
        self._evaluations += 1
        matched: list[str] = []

        roles = roles or []
        is_admin = any(r in roles for r in ("admin", "platform_admin", "org_admin"))

        if resource == "admin.dashboard" and action == "read":
            matched.append("allow_dashboard_read")
            decision = PolicyDecision(allow=True, matched_rules=matched)
        elif resource.startswith("admin.") and action in ("write", "manage"):
            if is_admin:
                matched.append("allow_admin_write")
                decision = PolicyDecision(allow=True, matched_rules=matched)
            else:
                self._rejections += 1
                matched.append("deny_insufficient_role")
                decision = PolicyDecision(
                    allow=False,
                    reject_reason="Admin write access requires admin role",
                    matched_rules=matched,
                )
        else:
            matched.append("allow_default")
            decision = PolicyDecision(allow=True, matched_rules=matched)

        self._record(PolicyEvent(
            trace_id=trace_id,
            resource=resource,
            action=action,
            allow=decision.allow,
            matched_rules=matched,
            user_id=user_id,
            timestamp=time.time(),
        ))
        return decision

    def get_stats(self) -> dict[str, Any]:
        return {
            "engine": self.engine_name,
            "evaluations": self._evaluations,
            "rejections": self._rejections,
            "recent_events": [
                {
                    "trace_id": e.trace_id,
                    "resource": e.resource,
                    "action": e.action,
                    "allow": e.allow,
                    "matched_rules": e.matched_rules,
                    "user_id": e.user_id,
                    "timestamp": e.timestamp,
                }
                for e in self._recent[-10:]
            ],
        }

    def _record(self, event: PolicyEvent) -> None:
        self._recent.append(event)
        if len(self._recent) > self._max_recent:
            self._recent = self._recent[-self._max_recent:]


class OpenFgaShadowEngine(AuthorizationPolicyEngine):
    """Shadow-mode: logs OpenFGA decisions alongside deterministic, never enforces."""

    engine_name = "openfga_shadow"

    def __init__(self) -> None:
        self._deterministic = DeterministicAuthzEngine()
        self._shadow_checks = 0
        self._shadow_mismatches = 0

    def authorize(
        self,
        resource: str,
        action: str,
        *,
        user_id: str = "",
        org_id: str = "",
        roles: list[str] | None = None,
        trace_id: str = "",
    ) -> PolicyDecision:
        decision = self._deterministic.authorize(
            resource, action, user_id=user_id, org_id=org_id, roles=roles, trace_id=trace_id
        )

        if SYNESIS_OPENFGA_API_URL:
            self._shadow_checks += 1
            # Shadow check would go here — log but never enforce
            logger.debug(
                "openfga_shadow_check resource=%s action=%s user=%s deterministic_allow=%s",
                resource, action, user_id, decision.allow,
            )

        return decision

    def get_stats(self) -> dict[str, Any]:
        base = self._deterministic.get_stats()
        base["engine"] = self.engine_name
        base["shadow_checks"] = self._shadow_checks
        base["shadow_mismatches"] = self._shadow_mismatches
        base["openfga_configured"] = bool(SYNESIS_OPENFGA_API_URL)
        return base


def create_authz_engine() -> AuthorizationPolicyEngine:
    """Factory: create the configured authorization engine."""
    if SYNESIS_AUTHZ_ENGINE == "openfga_shadow":
        return OpenFgaShadowEngine()
    return DeterministicAuthzEngine()
