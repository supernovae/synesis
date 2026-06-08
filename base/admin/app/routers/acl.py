"""ACL group and policy management for per-document authorization."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import AclGroup, AclGroupMember, AclPolicy
from ..rbac import (
    Role,
    RouteGroup,
    can_access_route_group,
    can_manage_visibility_scope,
    require_platform_admin,
    resolve_role,
)
from ..services.admin_audit import record_admin_audit

router = APIRouter(prefix="/api/v1/acl", tags=["acl"])


def _ensure_org_content_admin(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_content_admin):
        raise HTTPException(status_code=403, detail="Requires route group access: org_content_admin")


def _target_org(user: UserInfo, requested: str = "") -> str:
    org_id = (requested or user.org_id or "").strip()
    if not can_manage_visibility_scope(user, visibility_scope="org", org_id=org_id):
        raise HTTPException(status_code=403, detail="Not authorized for org scope")
    return org_id


def _ensure_group_access(user: UserInfo, group: AclGroup) -> None:
    if resolve_role(user) >= Role.platform_admin:
        return
    if not user.org_id or group.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Group not found")


# ---------------------------------------------------------------------------
# ACL Groups
# ---------------------------------------------------------------------------


class GroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    description: str = ""
    org_id: str = Field("", max_length=64)
    keycloak_group_path: str | None = None


class GroupInfo(BaseModel):
    id: int
    group_id: str
    name: str
    description: str
    org_id: str
    source: str
    keycloak_group_path: str | None
    member_count: int = 0


@router.get("/groups")
async def list_groups(
    org_id: str = Query("", description="Filter by org"),
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        q = select(AclGroup).order_by(AclGroup.name)
        caller_org = (_user.org_id or "").strip()
        role = resolve_role(_user)
        if role < Role.platform_admin and caller_org:
            q = q.where((AclGroup.org_id == caller_org) | (AclGroup.org_id == ""))
        if org_id:
            if role < Role.platform_admin and org_id != caller_org:
                raise HTTPException(status_code=403, detail="Not authorized for org scope")
            q = q.where(AclGroup.org_id == org_id)
        rows = (await session.execute(q)).scalars().all()

        groups = []
        for r in rows:
            mc = (
                await session.execute(
                    select(func.count()).select_from(AclGroupMember).where(AclGroupMember.group_id == r.group_id)
                )
            ).scalar() or 0
            groups.append(
                GroupInfo(
                    id=r.id,
                    group_id=r.group_id,
                    name=r.name,
                    description=r.description,
                    org_id=r.org_id,
                    source=r.source,
                    keycloak_group_path=r.keycloak_group_path,
                    member_count=mc,
                ).model_dump()
            )
    return {"groups": groups}


@router.post("/groups", status_code=201)
async def create_group(
    body: GroupCreate,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    org_id = _target_org(_user, body.org_id)
    group_id = f"grp-{uuid.uuid4().hex[:12]}"
    async with async_session() as session:
        grp = AclGroup(
            group_id=group_id,
            name=body.name,
            description=body.description,
            org_id=org_id,
            source="admin",
            keycloak_group_path=body.keycloak_group_path,
        )
        session.add(grp)
        await session.commit()
    await record_admin_audit(
        action="acl.group.create",
        status="success",
        summary=f"Created ACL group {group_id}: {body.name}",
        detail={"group_id": group_id, "org_id": org_id},
        user=_user,
    )
    return {"group_id": group_id, "name": body.name}


@router.delete("/groups/{group_id}")
async def delete_group(
    group_id: str,
    _user: UserInfo = Depends(require_platform_admin),
):
    async with async_session() as session:
        row = (await session.execute(select(AclGroup).where(AclGroup.group_id == group_id))).scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Group not found")
        await session.execute(delete(AclGroupMember).where(AclGroupMember.group_id == group_id))
        await session.delete(row)
        await session.commit()
    await record_admin_audit(
        action="acl.group.delete",
        status="success",
        summary=f"Deleted ACL group {group_id}",
        detail={"group_id": group_id},
        user=_user,
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Group membership
# ---------------------------------------------------------------------------


class MemberAdd(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=256)


@router.get("/groups/{group_id}/members")
async def list_members(
    group_id: str,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        rows = (
            (await session.execute(select(AclGroupMember).where(AclGroupMember.group_id == group_id))).scalars().all()
        )
        grp = (await session.execute(select(AclGroup).where(AclGroup.group_id == group_id))).scalar_one_or_none()
        if not grp:
            raise HTTPException(status_code=404, detail="Group not found")
        _ensure_group_access(_user, grp)
    return {
        "members": [
            {"user_id": m.user_id, "granted_by": m.granted_by, "granted_at": m.granted_at.isoformat()} for m in rows
        ]
    }


@router.post("/groups/{group_id}/members", status_code=201)
async def add_member(
    group_id: str,
    body: MemberAdd,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        grp = (await session.execute(select(AclGroup).where(AclGroup.group_id == group_id))).scalar_one_or_none()
        if not grp:
            raise HTTPException(status_code=404, detail="Group not found")
        _ensure_group_access(_user, grp)
        group_org_id = grp.org_id
        existing = (
            await session.execute(
                select(AclGroupMember).where(
                    AclGroupMember.group_id == group_id,
                    AclGroupMember.user_id == body.user_id,
                )
            )
        ).scalar_one_or_none()
        if existing:
            return {"ok": True, "status": "already_member"}
        session.add(
            AclGroupMember(
                group_id=group_id,
                user_id=body.user_id,
                granted_by=_user.username or _user.user_id,
            )
        )
        await session.commit()
    await record_admin_audit(
        action="acl.group.member.add",
        status="success",
        summary=f"Added user {body.user_id} to ACL group {group_id}",
        detail={"group_id": group_id, "member_user_id": body.user_id, "org_id": group_org_id},
        user=_user,
    )
    return {"ok": True, "status": "added"}


@router.delete("/groups/{group_id}/members/{user_id}")
async def remove_member(
    group_id: str,
    user_id: str,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        grp = (await session.execute(select(AclGroup).where(AclGroup.group_id == group_id))).scalar_one_or_none()
        if not grp:
            raise HTTPException(status_code=404, detail="Group not found")
        _ensure_group_access(_user, grp)
        group_org_id = grp.org_id
        result = await session.execute(
            delete(AclGroupMember).where(
                AclGroupMember.group_id == group_id,
                AclGroupMember.user_id == user_id,
            )
        )
        await session.commit()
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Membership not found")
    await record_admin_audit(
        action="acl.group.member.remove",
        status="success",
        summary=f"Removed user {user_id} from ACL group {group_id}",
        detail={"group_id": group_id, "member_user_id": user_id, "org_id": group_org_id},
        user=_user,
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# ACL Policies
# ---------------------------------------------------------------------------


class PolicyCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    description: str = ""
    org_id: str = ""
    scope: str = Field("org", pattern="^(platform|org|tenant)$")
    target_type: str = Field("content", pattern="^(content|route|both)$")
    acl_groups: list[str] | None = None
    route_groups: list[str] | None = None
    effect: str = Field("allow", pattern="^(allow|deny)$")
    priority: int = 0


_VALID_ROUTE_GROUPS = {group.value for group in RouteGroup}


def _normalize_policy_route_groups(
    user: UserInfo,
    *,
    target_type: str,
    route_groups: list[str] | None,
) -> list[str] | None:
    target = (target_type or "content").strip().lower()
    raw_groups = route_groups or []
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in raw_groups:
        group = str(raw).strip()
        if not group or group in seen:
            continue
        seen.add(group)
        normalized.append(group)
    if len(normalized) > 50:
        raise HTTPException(status_code=400, detail="route_groups may include at most 50 entries")
    invalid = sorted(set(normalized) - _VALID_ROUTE_GROUPS)
    if invalid:
        raise HTTPException(status_code=400, detail=f"Invalid route_groups: {', '.join(invalid)}")
    if target in {"route", "both"} and not normalized:
        raise HTTPException(status_code=400, detail="route_groups is required for route ACL policies")
    if target == "content" and normalized:
        raise HTTPException(status_code=400, detail="route_groups is only valid for route ACL policies")
    if RouteGroup.platform_control.value in normalized and resolve_role(user) < Role.platform_admin:
        raise HTTPException(status_code=403, detail="platform_control route policies require platform_admin")
    return normalized or None


@router.get("/policies")
async def list_policies(
    org_id: str = Query("", description="Filter by org"),
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        q = select(AclPolicy).order_by(AclPolicy.priority.desc(), AclPolicy.name)
        if org_id:
            role = resolve_role(_user)
            if role < Role.platform_admin and org_id != (_user.org_id or "").strip():
                raise HTTPException(status_code=403, detail="Not authorized for org scope")
            q = q.where(AclPolicy.org_id == org_id)
        elif resolve_role(_user) < Role.platform_admin:
            q = q.where(AclPolicy.org_id == (_user.org_id or "").strip())
        rows = (await session.execute(q)).scalars().all()
    return {
        "policies": [
            {
                "id": p.id,
                "name": p.name,
                "description": p.description,
                "org_id": p.org_id,
                "scope": p.scope,
                "target_type": p.target_type,
                "acl_groups": p.acl_groups or [],
                "route_groups": p.route_groups or [],
                "effect": p.effect,
                "priority": p.priority,
                "created_by": p.created_by,
            }
            for p in rows
        ]
    }


@router.post("/policies", status_code=201)
async def create_policy(
    body: PolicyCreate,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    scope = (body.scope or "org").strip().lower()
    org_id = _target_org(_user, body.org_id)
    if scope == "platform" and resolve_role(_user) < Role.platform_admin:
        raise HTTPException(status_code=403, detail="Platform policies require platform_admin")
    route_groups = _normalize_policy_route_groups(_user, target_type=body.target_type, route_groups=body.route_groups)
    async with async_session() as session:
        pol = AclPolicy(
            name=body.name,
            description=body.description,
            org_id=org_id,
            scope=scope,
            target_type=body.target_type,
            acl_groups=body.acl_groups,
            route_groups=route_groups,
            effect=body.effect,
            priority=body.priority,
            created_by=_user.username or _user.user_id,
        )
        session.add(pol)
        await session.commit()
        await session.refresh(pol)
    await record_admin_audit(
        action="acl.policy.create",
        status="success",
        summary=f"Created ACL policy: {body.name}",
        detail={"policy_id": pol.id, "org_id": org_id},
        user=_user,
    )
    return {"ok": True, "id": pol.id, "name": body.name}


@router.delete("/policies/{policy_id}")
async def delete_policy(
    policy_id: int,
    _user: UserInfo = Depends(require_platform_admin),
):
    async with async_session() as session:
        row = await session.get(AclPolicy, policy_id)
        if not row:
            raise HTTPException(status_code=404, detail="Policy not found")
        await session.delete(row)
        await session.commit()
    await record_admin_audit(
        action="acl.policy.delete",
        status="success",
        summary=f"Deleted ACL policy {policy_id}",
        detail={"policy_id": policy_id},
        user=_user,
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Effective permissions view
# ---------------------------------------------------------------------------


@router.get("/effective-permissions/{user_id}")
async def effective_permissions(
    user_id: str,
    _user: UserInfo = Depends(get_current_user),
):
    """Show which ACL groups and policies apply to a given user."""
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        memberships = (
            (await session.execute(select(AclGroupMember).where(AclGroupMember.user_id == user_id))).scalars().all()
        )
        group_ids = [m.group_id for m in memberships]

        groups = []
        if group_ids:
            gq = select(AclGroup).where(AclGroup.group_id.in_(group_ids))
            if resolve_role(_user) < Role.platform_admin:
                gq = gq.where(AclGroup.org_id == (_user.org_id or "").strip())
            groups = (await session.execute(gq)).scalars().all()
            group_ids = [g.group_id for g in groups]

        pq = select(AclPolicy).order_by(AclPolicy.priority.desc())
        if resolve_role(_user) < Role.platform_admin:
            pq = pq.where(AclPolicy.org_id == (_user.org_id or "").strip())
        policies = (await session.execute(pq)).scalars().all()

        applicable = []
        for p in policies:
            if p.acl_groups and any(g in group_ids for g in p.acl_groups):
                applicable.append({"id": p.id, "name": p.name, "effect": p.effect, "scope": p.scope})

    return {
        "user_id": user_id,
        "groups": [{"group_id": g.group_id, "name": g.name, "org_id": g.org_id} for g in groups],
        "applicable_policies": applicable,
    }
