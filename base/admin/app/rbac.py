"""Role-based access control for the Synesis admin API.

Defines a four-tier role hierarchy and provides FastAPI dependency helpers
that routers use instead of ad-hoc ``user.role == "admin"`` checks.

Roles (highest → lowest privilege):
    platform_admin  –  Full control: model registry, secrets, ingestion,
                       user management, all traces/metrics across the system.
    org_admin       –  Read/manage traces, usage, and settings scoped to the
                       user's Keycloak organization.
    user            –  Read own traces, create/revoke own PATs, use the
                       assistant scoped to own data.
    readonly        –  Read-only access to own data and public health endpoints.

Keycloak mapping:
    realm role ``synesis-admin``         → platform_admin
    org claim  role ``admin``            → org_admin (for that org)
    any authenticated user without above → user
    legacy local user ``viewer``         → readonly
"""

from __future__ import annotations

from enum import IntEnum
from typing import Any

from fastapi import Depends, HTTPException

from .auth import UserInfo, get_current_user


class Role(IntEnum):
    """Privilege levels — higher numeric value = more privilege."""

    readonly = 0
    user = 10
    org_admin = 20
    platform_admin = 30


# Map string role labels (from Keycloak / PAT / legacy JWT) to enum values.
_ROLE_MAP: dict[str, Role] = {
    "platform_admin": Role.platform_admin,
    "admin": Role.platform_admin,
    "org_admin": Role.org_admin,
    "user": Role.user,
    "readonly": Role.readonly,
    "viewer": Role.readonly,
}


def resolve_role(user: UserInfo) -> Role:
    """Derive the effective ``Role`` for a ``UserInfo``.

    Checks both the top-level ``role`` field **and** org-level roles so
    that an ``org_admin`` inside Keycloak organizations is promoted.
    """
    base = _ROLE_MAP.get(user.role, Role.user)
    if base >= Role.org_admin:
        return base
    if "admin" in (user.org_roles or []):
        return Role.org_admin
    return base


def effective_role(user: UserInfo) -> Role:
    """Public alias kept for readability in non-Depends contexts."""
    return resolve_role(user)


# ── FastAPI dependency helpers ───────────────────────────────────────────────


def _require(minimum: Role):
    """Factory that returns a FastAPI dependency enforcing *minimum* role."""

    async def _dep(user: UserInfo = Depends(get_current_user)) -> UserInfo:
        if resolve_role(user) < minimum:
            raise HTTPException(
                status_code=403,
                detail=f"Requires {minimum.name} role or higher",
            )
        return user

    return _dep


require_platform_admin = _require(Role.platform_admin)
require_org_admin = _require(Role.org_admin)
require_user = _require(Role.user)
require_readonly = _require(Role.readonly)


# ── Data-scoping helpers ─────────────────────────────────────────────────────


def can_access_trace(user: UserInfo, trace: dict[str, Any]) -> bool:
    """Return True when *user* is allowed to view *trace*."""
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return True
    trace_user = trace.get("user_id", "")
    trace_org = trace.get("org_id", "")
    uid = user.user_id or user.username
    if role >= Role.org_admin and user.org_id and trace_org == user.org_id:
        return True
    return trace_user == uid


def trace_scope_filters(user: UserInfo) -> dict[str, str]:
    """Return keyword filters to pass into ``trace_store.list_traces``
    so only rows the user is authorized to see are returned.

    Platform admins get an empty dict (no restriction).
    """
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return {}
    if role >= Role.org_admin and user.org_id:
        return {"org_id": user.org_id}
    uid = user.user_id or user.username
    return {"user_id": uid}
