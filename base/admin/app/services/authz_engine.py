"""Authorization policy engine for admin — OpenFGA enforcement.

All authorization decisions go through OpenFGA. PAT scopes are a local
capability check (conjunction: scope allows verb AND FGA allows relation).
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("synesis.admin.authz_engine")

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


_fga_client = None


def _get_fga_client():
    global _fga_client
    if _fga_client is not None:
        return _fga_client
    if not SYNESIS_OPENFGA_API_URL or not SYNESIS_OPENFGA_STORE_ID:
        return None
    try:
        from openfga_sdk import ClientConfiguration, OpenFgaClient
        configuration = ClientConfiguration(
            api_url=SYNESIS_OPENFGA_API_URL,
            store_id=SYNESIS_OPENFGA_STORE_ID,
            authorization_model_id=SYNESIS_OPENFGA_MODEL_ID or None,
        )
        if SYNESIS_OPENFGA_AUTH_TOKEN:
            configuration.credentials = {
                "method": "api_token",
                "configuration": {"token": SYNESIS_OPENFGA_AUTH_TOKEN},
            }
        _fga_client = OpenFgaClient(configuration)
        return _fga_client
    except Exception:
        logger.exception("openfga_client_init_failed")
        return None


async def fga_check(user: str, relation: str, object_type: str, object_id: str) -> bool:
    """Run an OpenFGA check. Returns False on error or if not configured."""
    client = _get_fga_client()
    if client is None:
        return False
    try:
        from openfga_sdk import ClientCheckRequest
        body = ClientCheckRequest(user=user, relation=relation, object=f"{object_type}:{object_id}")
        response = await client.check(body)
        return bool(getattr(response, "allowed", False))
    except Exception:
        logger.exception("openfga_check_failed user=%s relation=%s object=%s:%s", user, relation, object_type, object_id)
        return False


class AuthorizationPolicyEngine:
    """OpenFGA-backed authorization engine."""

    engine_name = "openfga"

    def __init__(self) -> None:
        self._evaluations = 0
        self._rejections = 0
        self._recent: list[PolicyEvent] = []
        self._max_recent = 50

    async def authorize(
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

        fga_user = f"user:{user_id}" if user_id else ""
        if not fga_user:
            self._rejections += 1
            matched.append("deny_no_user_id")
            decision = PolicyDecision(allow=False, reject_reason="No user identity", matched_rules=matched)
            self._record(PolicyEvent(trace_id=trace_id, resource=resource, action=action, allow=False, matched_rules=matched, user_id=user_id, timestamp=time.time()))
            return decision

        fga_object_type = "admin_endpoint"
        fga_relation = "can_read" if action == "read" else "can_manage"
        fga_object_id = resource.replace(".", "_")

        allowed = await fga_check(fga_user, fga_relation, fga_object_type, fga_object_id)

        if allowed:
            matched.append(f"allow_openfga_{fga_relation}")
            decision = PolicyDecision(allow=True, matched_rules=matched)
        else:
            self._rejections += 1
            matched.append(f"deny_openfga_{fga_relation}")
            decision = PolicyDecision(allow=False, reject_reason=f"Authorization denied for {resource}:{action}", matched_rules=matched)

        self._record(PolicyEvent(trace_id=trace_id, resource=resource, action=action, allow=decision.allow, matched_rules=matched, user_id=user_id, timestamp=time.time()))
        return decision

    def get_stats(self) -> dict[str, Any]:
        return {
            "engine": self.engine_name,
            "evaluations": self._evaluations,
            "rejections": self._rejections,
            "openfga_configured": bool(SYNESIS_OPENFGA_API_URL and SYNESIS_OPENFGA_STORE_ID),
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


def create_authz_engine() -> AuthorizationPolicyEngine:
    """Factory: create the OpenFGA authorization engine."""
    return AuthorizationPolicyEngine()
