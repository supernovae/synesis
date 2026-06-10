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


def test_acl_group_create_rejects_extra_and_malformed_org_id():
    from app.routers.acl import GroupCreate
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="admin_override"):
        GroupCreate(name="Engineering", admin_override=True)

    with pytest.raises(ValidationError, match="org_id"):
        GroupCreate(name="Engineering", org_id="org-1\nrole=admin")


def test_acl_member_add_rejects_control_characters():
    from app.routers.acl import MemberAdd
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="user_id"):
        MemberAdd(user_id="member-1\nrole=admin")


def test_acl_policy_create_rejects_malformed_acl_group_id():
    from app.routers.acl import PolicyCreate
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="acl_groups"):
        PolicyCreate(name="Policy", acl_groups=["grp-1\nrole=admin"])


@pytest.mark.anyio
async def test_acl_routes_reject_malformed_ids_before_db_access():
    from app.routers import acl

    with pytest.raises(HTTPException) as group_exc:
        await acl.add_member(group_id="grp-1\nrole=admin", body=acl.MemberAdd(user_id="member-1"), _user=_org_admin())

    assert group_exc.value.status_code == 422

    with pytest.raises(HTTPException) as user_exc:
        await acl.remove_member(group_id="grp-1", user_id="member-1\nrole=admin", _user=_org_admin())

    assert user_exc.value.status_code == 422

    with pytest.raises(HTTPException) as effective_exc:
        await acl.effective_permissions(user_id="member-1\nrole=admin", _user=_org_admin())

    assert effective_exc.value.status_code == 422


@pytest.mark.anyio
async def test_acl_list_routes_reject_malformed_org_filter_before_db_access():
    from app.routers import acl

    with pytest.raises(HTTPException) as group_exc:
        await acl.list_groups(org_id="org-1\nrole=admin", _user=_org_admin())

    assert group_exc.value.status_code == 422

    with pytest.raises(HTTPException) as policy_exc:
        await acl.list_policies(org_id="org-1\nrole=admin", _user=_org_admin())

    assert policy_exc.value.status_code == 422
