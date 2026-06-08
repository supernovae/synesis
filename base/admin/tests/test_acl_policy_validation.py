from __future__ import annotations

import pytest
from app.auth import UserInfo
from fastapi import HTTPException


def _org_admin() -> UserInfo:
    return UserInfo(
        user_id="org-admin-1",
        username="org-admin",
        role="org_admin",
        org_id="org-1",
    )


def _platform_admin() -> UserInfo:
    return UserInfo(
        user_id="platform-admin-1",
        username="platform-admin",
        role="platform_admin",
        org_id="",
    )


def test_acl_policy_route_groups_must_be_known_values():
    from app.routers.acl import _normalize_policy_route_groups

    with pytest.raises(HTTPException) as exc:
        _normalize_policy_route_groups(
            _org_admin(),
            target_type="route",
            route_groups=["org_content_admin", "not-a-real-group"],
        )

    assert exc.value.status_code == 400
    assert "Invalid route_groups" in str(exc.value.detail)


def test_acl_route_policy_requires_explicit_route_groups():
    from app.routers.acl import _normalize_policy_route_groups

    with pytest.raises(HTTPException) as exc:
        _normalize_policy_route_groups(_org_admin(), target_type="route", route_groups=[])

    assert exc.value.status_code == 400
    assert "route_groups is required" in str(exc.value.detail)


def test_acl_content_policy_rejects_route_groups():
    from app.routers.acl import _normalize_policy_route_groups

    with pytest.raises(HTTPException) as exc:
        _normalize_policy_route_groups(_org_admin(), target_type="content", route_groups=["org_content_admin"])

    assert exc.value.status_code == 400
    assert "only valid for route ACL policies" in str(exc.value.detail)


def test_acl_platform_control_route_group_requires_platform_admin():
    from app.routers.acl import _normalize_policy_route_groups

    with pytest.raises(HTTPException) as exc:
        _normalize_policy_route_groups(_org_admin(), target_type="route", route_groups=["platform_control"])

    assert exc.value.status_code == 403

    assert _normalize_policy_route_groups(
        _platform_admin(),
        target_type="route",
        route_groups=["platform_control"],
    ) == ["platform_control"]


def test_acl_policy_route_groups_are_normalized_and_deduplicated():
    from app.routers.acl import _normalize_policy_route_groups

    assert _normalize_policy_route_groups(
        _org_admin(),
        target_type="both",
        route_groups=["org_content_admin", " org_content_admin ", "org_observability"],
    ) == ["org_content_admin", "org_observability"]
