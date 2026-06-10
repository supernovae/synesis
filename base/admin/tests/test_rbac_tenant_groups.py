"""Tests for tenant-aware RBAC route-group helpers."""

from __future__ import annotations


def _user(
    *,
    role: str = "user",
    org_id: str = "",
    tenant_ids: list[str] | None = None,
):
    from app.auth import UserInfo

    return UserInfo(
        username="alice",
        role=role,
        user_id="u1",
        org_id=org_id,
        tenant_ids=tenant_ids or [],
    )


def test_is_tenant_content_operator_for_org_admin():
    from app.rbac import is_tenant_content_operator

    assert is_tenant_content_operator(_user(role="org_admin", org_id="org-a")) is True


def test_is_tenant_content_operator_platform_admin_without_org():
    """Platform PATs often omit org_id; bootstrap/global ingestion must still work."""
    from app.rbac import is_tenant_content_operator

    assert is_tenant_content_operator(_user(role="platform_admin", org_id="")) is True


def test_is_tenant_content_operator_for_tenant_granted_user():
    from app.rbac import is_tenant_content_operator

    assert is_tenant_content_operator(_user(role="user", org_id="org-a", tenant_ids=["tenant-1"])) is True


def test_tenant_granted_user_cannot_manage_other_tenant():
    from app.rbac import can_manage_visibility_scope

    allowed = can_manage_visibility_scope(
        _user(role="user", org_id="org-a", tenant_ids=["tenant-1"]),
        visibility_scope="tenant",
        org_id="org-a",
        tenant_id="tenant-2",
    )
    assert allowed is False


def test_trace_scope_filters_does_not_truncate_malformed_tenant_id():
    from app.rbac import trace_scope_filters

    scope = trace_scope_filters(_user(role="user", org_id="org-a", tenant_ids=["tenant-1\nrole=admin"]))

    assert scope == {"user_id": "u1"}


def test_trace_scope_filters_preserves_valid_tenant_id():
    from app.rbac import trace_scope_filters

    scope = trace_scope_filters(_user(role="user", org_id="org-a", tenant_ids=["tenant-1"]))

    assert scope == {"user_id": "u1", "scope_tenant_id": "tenant-1"}


def test_tenant_granted_user_cannot_manage_org_scope():
    from app.rbac import can_manage_visibility_scope

    allowed = can_manage_visibility_scope(
        _user(role="user", org_id="org-a", tenant_ids=["tenant-1"]),
        visibility_scope="org",
        org_id="org-a",
        tenant_id="",
    )
    assert allowed is False


def test_org_admin_can_manage_org_scope_in_own_org():
    from app.rbac import can_manage_visibility_scope

    allowed = can_manage_visibility_scope(
        _user(role="org_admin", org_id="org-a"),
        visibility_scope="org",
        org_id="org-a",
        tenant_id="",
    )
    assert allowed is True


def test_org_admin_cannot_manage_global_scope():
    from app.rbac import can_manage_visibility_scope

    allowed = can_manage_visibility_scope(
        _user(role="org_admin", org_id="org-a"),
        visibility_scope="global",
        org_id="",
        tenant_id="",
    )
    assert allowed is False


def test_platform_admin_can_manage_global_scope():
    from app.rbac import can_manage_visibility_scope

    allowed = can_manage_visibility_scope(
        _user(role="platform_admin", org_id=""),
        visibility_scope="global",
        org_id="",
        tenant_id="",
    )
    assert allowed is True


def test_tenant_operator_denied_org_observability_group():
    from app.rbac import RouteGroup, can_access_route_group

    allowed = can_access_route_group(
        _user(role="user", org_id="org-a", tenant_ids=["tenant-1"]),
        RouteGroup.org_observability,
    )
    assert allowed is False


def test_org_admin_allowed_org_observability_group():
    from app.rbac import RouteGroup, can_access_route_group

    allowed = can_access_route_group(
        _user(role="org_admin", org_id="org-a"),
        RouteGroup.org_observability,
    )
    assert allowed is True


def test_tenant_operator_denied_org_content_admin_group():
    from app.rbac import RouteGroup, can_access_route_group

    allowed = can_access_route_group(
        _user(role="user", org_id="org-a", tenant_ids=["tenant-1"]),
        RouteGroup.org_content_admin,
    )
    assert allowed is False


def test_org_admin_allowed_org_content_admin_group():
    from app.rbac import RouteGroup, can_access_route_group

    allowed = can_access_route_group(
        _user(role="org_admin", org_id="org-a"),
        RouteGroup.org_content_admin,
    )
    assert allowed is True
