"""Role-based access control for the Synesis admin API.

Defines a four-tier role hierarchy and provides FastAPI dependency helpers
that routers use instead of ad-hoc ``user.role == "admin"`` checks.

Roles (highest → lowest privilege):
    platform_admin  –  Full control: model registry, secrets, ingestion,
                       user management, all traces/metrics across the system.
    org_admin       –  Read/manage traces, usage, and settings scoped to the
                       user's Keycloak organization.
    user            –  Self-service account features and support assistant.
                       Does not include trace visibility.
    readonly        –  Read-only access to own data and public health endpoints.

Keycloak mapping:
    realm role ``synesis-admin``         → platform_admin
    org claim  role ``admin``            → org_admin (for that org)
    any authenticated user without above → user
    legacy local user ``viewer``         → readonly
"""

from __future__ import annotations

from enum import IntEnum, StrEnum
from typing import Any

from fastapi import Depends, HTTPException

from .auth import UserInfo, get_current_user
from .route_validation import validate_safe_identifier
from .token_scopes import has_token_scope as token_scope_matches
from .token_scopes import has_write_scope as token_scope_allows_write


class Role(IntEnum):
    """Privilege levels — higher numeric value = more privilege."""

    readonly = 0
    user = 10
    org_admin = 20
    platform_admin = 30


# Map string role labels (from Keycloak / PAT) to enum values.
_ROLE_MAP: dict[str, Role] = {
    "platform_admin": Role.platform_admin,
    "admin": Role.platform_admin,
    "org_admin": Role.org_admin,
    "user": Role.user,
    "readonly": Role.readonly,
    "viewer": Role.readonly,
}


def _safe_org_id(value: str | None, *, max_length: int = 128) -> str:
    if not value:
        return ""
    try:
        return validate_safe_identifier(value, field_name="org_id", max_length=max_length)
    except ValueError:
        return ""


def _safe_tenant_ids(values: list[str] | None, *, max_length: int = 64) -> list[str]:
    cleaned: list[str] = []
    for raw_value in values or []:
        try:
            tenant_id = validate_safe_identifier(raw_value, field_name="tenant_id", max_length=max_length)
        except ValueError:
            continue
        if tenant_id not in cleaned:
            cleaned.append(tenant_id)
    return cleaned


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


class RouteGroup(StrEnum):
    """Logical route groups for multi-tenant authorization design."""

    platform_control = "platform_control"
    org_observability = "org_observability"
    org_content_admin = "org_content_admin"
    tenant_content_admin = "tenant_content_admin"
    self_service = "self_service"


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


def can_access_route_group(user: UserInfo, group: RouteGroup) -> bool:
    """Return True when user can access the logical API route group."""
    role = resolve_role(user)
    if group == RouteGroup.platform_control:
        return role >= Role.platform_admin
    if group == RouteGroup.org_observability:
        if role >= Role.platform_admin:
            return True
        return role >= Role.org_admin and bool(_safe_org_id(user.org_id))
    if group == RouteGroup.org_content_admin:
        if role >= Role.platform_admin:
            return True
        return role >= Role.org_admin and bool(_safe_org_id(user.org_id))
    if group == RouteGroup.tenant_content_admin:
        return is_tenant_content_operator(user)
    if group == RouteGroup.self_service:
        return role >= Role.user
    return False


def require_caller_org_id(user: UserInfo, *, surface: str = "org-scoped access", max_length: int = 128) -> str:
    """Return the server-derived caller org id or fail closed.

    Use this before passing org-scoped service filters. An empty org filter is
    commonly interpreted as platform/global scope by data services, so org-level
    callers must never degrade to an empty scope silently.
    """
    if not user.org_id:
        raise HTTPException(status_code=403, detail=f"{surface} requires org_id")
    try:
        return validate_safe_identifier(user.org_id, field_name="org_id", max_length=max_length)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=f"Invalid org_id for {surface}") from exc


def require_route_group(group: RouteGroup):
    """FastAPI dependency factory enforcing logical route-group access."""

    async def _dep(user: UserInfo = Depends(get_current_user)) -> UserInfo:
        if not can_access_route_group(user, group):
            raise HTTPException(status_code=403, detail=f"Requires route group access: {group.value}")
        return user

    return _dep


require_org_observability = require_route_group(RouteGroup.org_observability)
require_org_content_admin = require_route_group(RouteGroup.org_content_admin)


def is_tenant_content_operator(user: UserInfo) -> bool:
    """True when user can operate on tenant-scoped content in own org."""
    role = resolve_role(user)
    # Platform admins often have no Keycloak org selected (empty org_id on PAT).
    # They must still reach ingestion bootstrap and other content-operator routes
    # so global corpus loads (visibility_scope=global) can proceed.
    if role >= Role.platform_admin:
        return True
    if role >= Role.org_admin:
        return bool(_safe_org_id(user.org_id))
    return bool(_safe_org_id(user.org_id) and _safe_tenant_ids(user.tenant_ids))


async def require_tenant_content_operator(user: UserInfo = Depends(get_current_user)) -> UserInfo:
    """Allow org_admin+ or tenant-scoped users with explicit tenant grants."""
    if not is_tenant_content_operator(user):
        raise HTTPException(
            status_code=403,
            detail="Requires org_admin role or tenant content grants",
        )
    return user


def can_manage_visibility_scope(
    user: UserInfo,
    *,
    visibility_scope: str,
    org_id: str = "",
    tenant_id: str = "",
) -> bool:
    """Check whether caller may create/update content with the requested scope."""
    scope = (visibility_scope or "global").strip().lower()
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return True
    caller_org = _safe_org_id(user.org_id)
    if scope == "global":
        # Global content is cross-org by design; restrict writes to platform admin.
        return False
    raw_target_org = (org_id or "").strip()
    if raw_target_org and not _safe_org_id(raw_target_org):
        return False
    if scope == "org":
        target_org = _safe_org_id(raw_target_org) or caller_org
        return role >= Role.org_admin and bool(caller_org) and target_org == caller_org
    if scope == "tenant":
        if not caller_org or not tenant_id:
            return False
        target_org = _safe_org_id(raw_target_org) or caller_org
        if target_org != caller_org:
            return False
        target_tenant = _safe_tenant_ids([tenant_id])
        if not target_tenant:
            return False
        if role >= Role.org_admin:
            return True
        return target_tenant[0] in set(_safe_tenant_ids(user.tenant_ids))
    if scope in {"user", "session"}:
        target_org = _safe_org_id(raw_target_org) or caller_org
        return role >= Role.org_admin and bool(caller_org) and target_org == caller_org
    return False


# ── Data-scoping helpers ─────────────────────────────────────────────────────


def can_access_trace(user: UserInfo, trace: dict[str, Any]) -> bool:
    """Return True when *user* is allowed to view *trace*."""
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return True
    trace_user = trace.get("user_id", "")
    trace_org = trace.get("org_id", "")
    uid = user.user_id or user.username
    caller_org = _safe_org_id(user.org_id)
    if role >= Role.org_admin and caller_org and trace_org == caller_org:
        return True
    return trace_user == uid


def has_token_scope(user: UserInfo, scope_prefix: str) -> bool:
    """Check whether *user* has a known PAT scope for *scope_prefix*.

    JWT sessions (no token_scopes) are always allowed — scope enforcement only
    applies to PAT-authenticated calls.  Legacy PATs without scopes are treated
    as ``model:readonly`` by the token resolution layer.
    """
    scopes = user.token_scopes
    if not scopes:
        return True
    return token_scope_matches(scopes, scope_prefix)


def has_write_scope(user: UserInfo, scope_prefix: str) -> bool:
    """True when user has ``<scope_prefix>:readwrite``."""
    scopes = user.token_scopes
    if not scopes:
        return True
    return token_scope_allows_write(scopes, scope_prefix)


def require_scope(scope_prefix: str):
    """FastAPI dependency that rejects PATs missing the required scope."""

    async def _dep(user: UserInfo = Depends(get_current_user)) -> UserInfo:
        if not has_token_scope(user, scope_prefix):
            raise HTTPException(
                status_code=403,
                detail=f"Token missing required scope: {scope_prefix}",
            )
        return user

    return _dep


require_model_scope = require_scope("model")
require_coder_scope = require_scope("coder")


# ── OpenFGA-backed dependency ─────────────────────────────────────────────────


def require_fga(object_type: str, object_id: str, relation: str):
    """FastAPI dependency that enforces an OpenFGA check on the current user."""

    async def _dep(user: UserInfo = Depends(get_current_user)) -> UserInfo:
        from .services.authz_engine import fga_check
        from .services.fga_contract import fga_user_for_id

        try:
            fga_user = fga_user_for_id(user.user_id or user.username)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Invalid FGA user identity") from exc
        allowed = await fga_check(fga_user, relation, object_type, object_id)
        if not allowed:
            raise HTTPException(
                status_code=403,
                detail=f"Authorization denied: {object_type}:{object_id}#{relation}",
            )
        return user

    return _dep


def trace_scope_filters(user: UserInfo) -> dict[str, str]:
    """Return keyword filters to pass into ``trace_store.list_traces``
    so only rows the user is authorized to see are returned.

    Platform admins get an empty dict (no restriction). Non-org-admin users with
    ``tenant_ids`` also get ``scope_tenant_id`` (first id).
    """
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return {}
    caller_org = _safe_org_id(user.org_id)
    if role >= Role.org_admin and caller_org:
        return {"org_id": caller_org}
    uid = user.user_id or user.username
    out: dict[str, str] = {"user_id": uid}
    tenant_ids = user.tenant_ids or []
    if tenant_ids and role < Role.org_admin:
        try:
            tid = validate_safe_identifier(tenant_ids[0], field_name="tenant_id", max_length=64)
            out["scope_tenant_id"] = tid
        except ValueError:
            pass
    return out
