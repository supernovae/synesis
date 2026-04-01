"""Governance control plane — constitutions, clauses, and standalone policy definitions."""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, select, update

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import (
    AdminAuditEvent,
    GovernanceClause,
    GovernanceConstitution,
    GovernancePolicyDef,
)

logger = logging.getLogger("synesis.admin.governance")

router = APIRouter(prefix="/api/v1/governance", tags=["governance"])

VALID_STATUSES = {"draft", "active", "deprecated", "archived"}
VALID_SCOPES = {"platform", "org", "tenant", "project", "team"}
VALID_MATURITY_MODES = {"base", "guided", "governed", "assured"}
VALID_CATEGORIES = {"safety", "compliance", "quality", "style", "architecture", "tooling", "process"}
VALID_CONSTRAINT_KINDS = {"hard", "guiding", "advisory"}
VALID_RULE_TYPES = {"threshold", "escalation", "boundary", "routing", "reducer_config", "feature_toggle"}

SCOPE_PRECEDENCE = {"platform": 0, "org": 1, "tenant": 2, "project": 3, "team": 4}


def _audit(user: UserInfo, action: str, status: str, summary: str, detail: dict | None = None) -> AdminAuditEvent:
    return AdminAuditEvent(
        source="api",
        actor_username=user.username,
        actor_user_id=getattr(user, "user_id", ""),
        actor_role=user.role,
        action=action,
        status=status,
        summary=summary,
        detail=detail or {},
    )


# ---------------------------------------------------------------------------
# Constitution CRUD
# ---------------------------------------------------------------------------


class ConstitutionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    scope: str = Field("org")
    scope_value: str = Field("")
    precedence: int = Field(0)
    description: str = Field("")
    provenance_source: str = Field("")
    provenance_owner: str = Field("")
    maturity_mode: str = Field("base")
    effective_from: datetime | None = None
    effective_until: datetime | None = None


class ConstitutionUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    precedence: int | None = None
    maturity_mode: str | None = None
    effective_from: datetime | None = None
    effective_until: datetime | None = None


def _constitution_to_dict(c: GovernanceConstitution) -> dict:
    return {
        "id": c.id,
        "constitution_id": c.constitution_id,
        "name": c.name,
        "version": c.version,
        "status": c.status,
        "scope": c.scope,
        "scope_value": c.scope_value,
        "precedence": c.precedence,
        "description": c.description,
        "provenance_source": c.provenance_source,
        "provenance_owner": c.provenance_owner,
        "provenance_checksum": c.provenance_checksum,
        "effective_from": c.effective_from.isoformat() if c.effective_from else None,
        "effective_until": c.effective_until.isoformat() if c.effective_until else None,
        "maturity_mode": c.maturity_mode,
        "created_by": c.created_by,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


@router.get("/constitutions")
async def list_constitutions(
    user: UserInfo = Depends(get_current_user),
    scope: str | None = Query(None),
    status: str | None = Query(None),
    maturity_mode: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    async with async_session() as session:
        q = select(GovernanceConstitution)
        if scope:
            q = q.where(GovernanceConstitution.scope == scope)
        if status:
            q = q.where(GovernanceConstitution.status == status)
        if maturity_mode:
            q = q.where(GovernanceConstitution.maturity_mode == maturity_mode)
        q = q.order_by(GovernanceConstitution.updated_at.desc()).limit(limit).offset(offset)
        result = await session.execute(q)
        rows = result.scalars().all()
    return {"constitutions": [_constitution_to_dict(r) for r in rows]}


@router.post("/constitutions", status_code=201)
async def create_constitution(body: ConstitutionCreate, user: UserInfo = Depends(get_current_user)):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")
    if body.scope not in VALID_SCOPES:
        raise HTTPException(400, f"Invalid scope: {body.scope}")
    if body.maturity_mode not in VALID_MATURITY_MODES:
        raise HTTPException(400, f"Invalid maturity_mode: {body.maturity_mode}")

    cid = str(uuid.uuid4())
    row = GovernanceConstitution(
        constitution_id=cid,
        name=body.name,
        version=1,
        status="draft",
        scope=body.scope,
        scope_value=body.scope_value,
        precedence=body.precedence,
        description=body.description,
        provenance_source=body.provenance_source,
        provenance_owner=body.provenance_owner,
        maturity_mode=body.maturity_mode,
        effective_from=body.effective_from,
        effective_until=body.effective_until,
        created_by=user.username,
    )
    async with async_session() as session:
        session.add(row)
        session.add(
            _audit(
                user,
                "governance.constitution.create",
                "ok",
                f"Created constitution '{body.name}'",
                {"constitution_id": cid},
            )
        )
        await session.commit()
        await session.refresh(row)
    return _constitution_to_dict(row)


@router.get("/constitutions/{constitution_id}")
async def get_constitution(constitution_id: str, user: UserInfo = Depends(get_current_user)):
    async with async_session() as session:
        q = select(GovernanceConstitution).where(GovernanceConstitution.constitution_id == constitution_id)
        q = q.order_by(GovernanceConstitution.version.desc()).limit(1)
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Constitution not found")

        cq = (
            select(GovernanceClause)
            .where(GovernanceClause.constitution_id == constitution_id)
            .order_by(GovernanceClause.priority.desc())
        )
        clause_result = await session.execute(cq)
        clauses = clause_result.scalars().all()

    return {
        **_constitution_to_dict(row),
        "clauses": [_clause_to_dict(c) for c in clauses],
    }


@router.put("/constitutions/{constitution_id}")
async def update_constitution(
    constitution_id: str, body: ConstitutionUpdate, user: UserInfo = Depends(get_current_user)
):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")

    async with async_session() as session:
        q = (
            select(GovernanceConstitution)
            .where(
                GovernanceConstitution.constitution_id == constitution_id,
            )
            .order_by(GovernanceConstitution.version.desc())
            .limit(1)
        )
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Constitution not found")
        if row.status != "draft":
            raise HTTPException(409, "Only draft constitutions can be edited")

        if body.name is not None:
            row.name = body.name
        if body.description is not None:
            row.description = body.description
        if body.precedence is not None:
            row.precedence = body.precedence
        if body.maturity_mode is not None:
            if body.maturity_mode not in VALID_MATURITY_MODES:
                raise HTTPException(400, f"Invalid maturity_mode: {body.maturity_mode}")
            row.maturity_mode = body.maturity_mode
        if body.effective_from is not None:
            row.effective_from = body.effective_from
        if body.effective_until is not None:
            row.effective_until = body.effective_until
        row.updated_at = datetime.now(UTC)

        session.add(
            _audit(
                user,
                "governance.constitution.update",
                "ok",
                f"Updated constitution '{row.name}'",
                {"constitution_id": constitution_id},
            )
        )
        await session.commit()
        await session.refresh(row)
    return _constitution_to_dict(row)


@router.post("/constitutions/{constitution_id}/activate")
async def activate_constitution(
    constitution_id: str, user: UserInfo = Depends(get_current_user), dry_run: bool = Query(False)
):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")

    async with async_session() as session:
        q = (
            select(GovernanceConstitution)
            .where(
                GovernanceConstitution.constitution_id == constitution_id,
            )
            .order_by(GovernanceConstitution.version.desc())
            .limit(1)
        )
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Constitution not found")
        if row.status not in ("draft", "deprecated"):
            raise HTTPException(409, f"Cannot activate constitution in status '{row.status}'")

        cq = select(GovernanceClause).where(GovernanceClause.constitution_id == constitution_id)
        clause_result = await session.execute(cq)
        clauses = clause_result.scalars().all()

        checksum = hashlib.sha256("|".join(sorted(c.clause_id for c in clauses)).encode()).hexdigest()[:32]

        if dry_run:
            return {
                "dry_run": True,
                "constitution_id": constitution_id,
                "clause_count": len(clauses),
                "checksum": checksum,
                "current_status": row.status,
                "would_activate": True,
            }

        await session.execute(
            update(GovernanceConstitution)
            .where(
                and_(
                    GovernanceConstitution.constitution_id == constitution_id,
                    GovernanceConstitution.status == "active",
                    GovernanceConstitution.id != row.id,
                )
            )
            .values(status="deprecated", updated_at=datetime.now(UTC))
        )

        row.status = "active"
        row.provenance_checksum = checksum
        row.updated_at = datetime.now(UTC)
        session.add(
            _audit(
                user,
                "governance.constitution.activate",
                "ok",
                f"Activated constitution '{row.name}' v{row.version}",
                {"constitution_id": constitution_id, "checksum": checksum},
            )
        )
        await session.commit()
        await session.refresh(row)
    return _constitution_to_dict(row)


@router.post("/constitutions/{constitution_id}/deprecate")
async def deprecate_constitution(constitution_id: str, user: UserInfo = Depends(get_current_user)):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")

    async with async_session() as session:
        q = (
            select(GovernanceConstitution)
            .where(
                GovernanceConstitution.constitution_id == constitution_id,
            )
            .order_by(GovernanceConstitution.version.desc())
            .limit(1)
        )
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Constitution not found")
        if row.status != "active":
            raise HTTPException(409, "Only active constitutions can be deprecated")

        row.status = "deprecated"
        row.updated_at = datetime.now(UTC)
        session.add(
            _audit(
                user,
                "governance.constitution.deprecate",
                "ok",
                f"Deprecated constitution '{row.name}' v{row.version}",
                {"constitution_id": constitution_id},
            )
        )
        await session.commit()
        await session.refresh(row)
    return _constitution_to_dict(row)


@router.get("/constitutions/{constitution_id}/versions")
async def list_constitution_versions(constitution_id: str, user: UserInfo = Depends(get_current_user)):
    async with async_session() as session:
        q = (
            select(GovernanceConstitution)
            .where(GovernanceConstitution.constitution_id == constitution_id)
            .order_by(GovernanceConstitution.version.desc())
        )
        result = await session.execute(q)
        rows = result.scalars().all()
    if not rows:
        raise HTTPException(404, "Constitution not found")
    return {"versions": [_constitution_to_dict(r) for r in rows]}


@router.post("/constitutions/{constitution_id}/clone", status_code=201)
async def clone_constitution(constitution_id: str, user: UserInfo = Depends(get_current_user)):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")

    async with async_session() as session:
        q = (
            select(GovernanceConstitution)
            .where(
                GovernanceConstitution.constitution_id == constitution_id,
            )
            .order_by(GovernanceConstitution.version.desc())
            .limit(1)
        )
        result = await session.execute(q)
        src = result.scalar_one_or_none()
        if not src:
            raise HTTPException(404, "Constitution not found")

        max_ver_q = select(func.max(GovernanceConstitution.version)).where(
            GovernanceConstitution.constitution_id == constitution_id
        )
        max_ver = (await session.execute(max_ver_q)).scalar() or 0

        new_row = GovernanceConstitution(
            constitution_id=constitution_id,
            name=src.name,
            version=max_ver + 1,
            status="draft",
            scope=src.scope,
            scope_value=src.scope_value,
            precedence=src.precedence,
            description=src.description,
            provenance_source=src.provenance_source,
            provenance_owner=src.provenance_owner,
            maturity_mode=src.maturity_mode,
            effective_from=src.effective_from,
            effective_until=src.effective_until,
            created_by=user.username,
        )
        session.add(new_row)

        cq = select(GovernanceClause).where(GovernanceClause.constitution_id == constitution_id)
        clause_result = await session.execute(cq)
        for c in clause_result.scalars().all():
            session.add(
                GovernanceClause(
                    clause_id=str(uuid.uuid4()),
                    constitution_id=constitution_id,
                    category=c.category,
                    constraint_kind=c.constraint_kind,
                    statement=c.statement,
                    machine_rule=c.machine_rule,
                    applicability=c.applicability,
                    evidence_requirements=c.evidence_requirements,
                    actions=c.actions,
                    validation_recipe_id=c.validation_recipe_id,
                    enabled=c.enabled,
                    priority=c.priority,
                )
            )

        session.add(
            _audit(
                user,
                "governance.constitution.clone",
                "ok",
                f"Cloned constitution '{src.name}' to v{max_ver + 1}",
                {"constitution_id": constitution_id, "new_version": max_ver + 1},
            )
        )
        await session.commit()
        await session.refresh(new_row)
    return _constitution_to_dict(new_row)


# ---------------------------------------------------------------------------
# Clause CRUD
# ---------------------------------------------------------------------------


class ClauseCreate(BaseModel):
    category: str = Field("quality")
    constraint_kind: str = Field("guiding")
    statement: str = Field("")
    machine_rule: dict | None = None
    applicability: dict | None = None
    evidence_requirements: dict | None = None
    actions: dict | None = None
    validation_recipe_id: str | None = None
    enabled: bool = Field(True)
    priority: int = Field(0)


class ClauseUpdate(BaseModel):
    category: str | None = None
    constraint_kind: str | None = None
    statement: str | None = None
    machine_rule: dict | None = None
    applicability: dict | None = None
    evidence_requirements: dict | None = None
    actions: dict | None = None
    validation_recipe_id: str | None = None
    enabled: bool | None = None
    priority: int | None = None


def _clause_to_dict(c: GovernanceClause) -> dict:
    return {
        "id": c.id,
        "clause_id": c.clause_id,
        "constitution_id": c.constitution_id,
        "category": c.category,
        "constraint_kind": c.constraint_kind,
        "statement": c.statement,
        "machine_rule": c.machine_rule,
        "applicability": c.applicability,
        "evidence_requirements": c.evidence_requirements,
        "actions": c.actions,
        "validation_recipe_id": c.validation_recipe_id,
        "enabled": c.enabled,
        "priority": c.priority,
    }


@router.get("/constitutions/{constitution_id}/clauses")
async def list_clauses(constitution_id: str, user: UserInfo = Depends(get_current_user)):
    async with async_session() as session:
        q = (
            select(GovernanceClause)
            .where(GovernanceClause.constitution_id == constitution_id)
            .order_by(GovernanceClause.priority.desc())
        )
        result = await session.execute(q)
        rows = result.scalars().all()
    return {"clauses": [_clause_to_dict(r) for r in rows]}


@router.post("/constitutions/{constitution_id}/clauses", status_code=201)
async def create_clause(constitution_id: str, body: ClauseCreate, user: UserInfo = Depends(get_current_user)):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")
    if body.category not in VALID_CATEGORIES:
        raise HTTPException(400, f"Invalid category: {body.category}")
    if body.constraint_kind not in VALID_CONSTRAINT_KINDS:
        raise HTTPException(400, f"Invalid constraint_kind: {body.constraint_kind}")

    cid = str(uuid.uuid4())
    row = GovernanceClause(
        clause_id=cid,
        constitution_id=constitution_id,
        category=body.category,
        constraint_kind=body.constraint_kind,
        statement=body.statement,
        machine_rule=body.machine_rule,
        applicability=body.applicability,
        evidence_requirements=body.evidence_requirements,
        actions=body.actions,
        validation_recipe_id=body.validation_recipe_id,
        enabled=body.enabled,
        priority=body.priority,
    )
    async with async_session() as session:
        session.add(row)
        session.add(
            _audit(
                user,
                "governance.clause.create",
                "ok",
                f"Created clause in constitution {constitution_id}",
                {"clause_id": cid, "constitution_id": constitution_id},
            )
        )
        await session.commit()
        await session.refresh(row)
    return _clause_to_dict(row)


@router.put("/clauses/{clause_id}")
async def update_clause(clause_id: str, body: ClauseUpdate, user: UserInfo = Depends(get_current_user)):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")

    async with async_session() as session:
        q = select(GovernanceClause).where(GovernanceClause.clause_id == clause_id)
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Clause not found")

        if body.category is not None:
            if body.category not in VALID_CATEGORIES:
                raise HTTPException(400, f"Invalid category: {body.category}")
            row.category = body.category
        if body.constraint_kind is not None:
            if body.constraint_kind not in VALID_CONSTRAINT_KINDS:
                raise HTTPException(400, f"Invalid constraint_kind: {body.constraint_kind}")
            row.constraint_kind = body.constraint_kind
        if body.statement is not None:
            row.statement = body.statement
        if body.machine_rule is not None:
            row.machine_rule = body.machine_rule
        if body.applicability is not None:
            row.applicability = body.applicability
        if body.evidence_requirements is not None:
            row.evidence_requirements = body.evidence_requirements
        if body.actions is not None:
            row.actions = body.actions
        if body.validation_recipe_id is not None:
            row.validation_recipe_id = body.validation_recipe_id
        if body.enabled is not None:
            row.enabled = body.enabled
        if body.priority is not None:
            row.priority = body.priority

        session.add(
            _audit(user, "governance.clause.update", "ok", f"Updated clause {clause_id}", {"clause_id": clause_id})
        )
        await session.commit()
        await session.refresh(row)
    return _clause_to_dict(row)


@router.delete("/clauses/{clause_id}")
async def delete_clause(clause_id: str, user: UserInfo = Depends(get_current_user)):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")

    async with async_session() as session:
        q = select(GovernanceClause).where(GovernanceClause.clause_id == clause_id)
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Clause not found")
        await session.delete(row)
        session.add(
            _audit(user, "governance.clause.delete", "ok", f"Deleted clause {clause_id}", {"clause_id": clause_id})
        )
        await session.commit()
    return {"deleted": clause_id}


# ---------------------------------------------------------------------------
# Standalone Policy CRUD
# ---------------------------------------------------------------------------


class PolicyDefCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    description: str = Field("")
    scope: str = Field("org")
    scope_value: str = Field("")
    org_id: str = Field("")
    category: str = Field("quality")
    constraint_kind: str = Field("guiding")
    rule_type: str = Field("threshold")
    rule_config: dict = Field(default_factory=dict)
    enabled: bool = Field(True)
    priority: int = Field(0)


class PolicyDefUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    rule_config: dict | None = None
    enabled: bool | None = None
    priority: int | None = None
    category: str | None = None
    constraint_kind: str | None = None


def _policy_to_dict(p: GovernancePolicyDef) -> dict:
    return {
        "id": p.id,
        "policy_id": p.policy_id,
        "name": p.name,
        "description": p.description,
        "scope": p.scope,
        "scope_value": p.scope_value,
        "org_id": p.org_id,
        "category": p.category,
        "constraint_kind": p.constraint_kind,
        "rule_type": p.rule_type,
        "rule_config": p.rule_config,
        "enabled": p.enabled,
        "priority": p.priority,
        "created_by": p.created_by,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


@router.get("/policies")
async def list_policies(
    user: UserInfo = Depends(get_current_user),
    scope: str | None = Query(None),
    category: str | None = Query(None),
    rule_type: str | None = Query(None),
    org_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    async with async_session() as session:
        q = select(GovernancePolicyDef)
        if scope:
            q = q.where(GovernancePolicyDef.scope == scope)
        if category:
            q = q.where(GovernancePolicyDef.category == category)
        if rule_type:
            q = q.where(GovernancePolicyDef.rule_type == rule_type)
        if org_id:
            q = q.where(GovernancePolicyDef.org_id == org_id)
        q = q.order_by(GovernancePolicyDef.priority.desc()).limit(limit).offset(offset)
        result = await session.execute(q)
        rows = result.scalars().all()
    return {"policies": [_policy_to_dict(r) for r in rows]}


@router.post("/policies", status_code=201)
async def create_policy(body: PolicyDefCreate, user: UserInfo = Depends(get_current_user)):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")
    if body.scope not in VALID_SCOPES:
        raise HTTPException(400, f"Invalid scope: {body.scope}")
    if body.category not in VALID_CATEGORIES:
        raise HTTPException(400, f"Invalid category: {body.category}")
    if body.constraint_kind not in VALID_CONSTRAINT_KINDS:
        raise HTTPException(400, f"Invalid constraint_kind: {body.constraint_kind}")
    if body.rule_type not in VALID_RULE_TYPES:
        raise HTTPException(400, f"Invalid rule_type: {body.rule_type}")

    pid = str(uuid.uuid4())
    row = GovernancePolicyDef(
        policy_id=pid,
        name=body.name,
        description=body.description,
        scope=body.scope,
        scope_value=body.scope_value,
        org_id=body.org_id,
        category=body.category,
        constraint_kind=body.constraint_kind,
        rule_type=body.rule_type,
        rule_config=body.rule_config,
        enabled=body.enabled,
        priority=body.priority,
        created_by=user.username,
    )
    async with async_session() as session:
        session.add(row)
        session.add(_audit(user, "governance.policy.create", "ok", f"Created policy '{body.name}'", {"policy_id": pid}))
        await session.commit()
        await session.refresh(row)
    return _policy_to_dict(row)


@router.put("/policies/{policy_id}")
async def update_policy(policy_id: str, body: PolicyDefUpdate, user: UserInfo = Depends(get_current_user)):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")

    async with async_session() as session:
        q = select(GovernancePolicyDef).where(GovernancePolicyDef.policy_id == policy_id)
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Policy not found")

        if body.name is not None:
            row.name = body.name
        if body.description is not None:
            row.description = body.description
        if body.rule_config is not None:
            row.rule_config = body.rule_config
        if body.enabled is not None:
            row.enabled = body.enabled
        if body.priority is not None:
            row.priority = body.priority
        if body.category is not None:
            if body.category not in VALID_CATEGORIES:
                raise HTTPException(400, f"Invalid category: {body.category}")
            row.category = body.category
        if body.constraint_kind is not None:
            if body.constraint_kind not in VALID_CONSTRAINT_KINDS:
                raise HTTPException(400, f"Invalid constraint_kind: {body.constraint_kind}")
            row.constraint_kind = body.constraint_kind
        row.updated_at = datetime.now(UTC)

        session.add(
            _audit(user, "governance.policy.update", "ok", f"Updated policy '{row.name}'", {"policy_id": policy_id})
        )
        await session.commit()
        await session.refresh(row)
    return _policy_to_dict(row)


@router.delete("/policies/{policy_id}")
async def delete_policy(policy_id: str, user: UserInfo = Depends(get_current_user)):
    if user.role not in ("platform_admin", "org_admin", "admin"):
        raise HTTPException(403, "Requires org_admin or higher")

    async with async_session() as session:
        q = select(GovernancePolicyDef).where(GovernancePolicyDef.policy_id == policy_id)
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Policy not found")
        await session.delete(row)
        session.add(
            _audit(user, "governance.policy.delete", "ok", f"Deleted policy '{row.name}'", {"policy_id": policy_id})
        )
        await session.commit()
    return {"deleted": policy_id}


# ---------------------------------------------------------------------------
# Effective governance — runtime query endpoint
# ---------------------------------------------------------------------------


@router.get("/effective")
async def get_effective_governance(
    request: Request,
    response: Response,
    user: UserInfo = Depends(get_current_user),
    org_id: str | None = Query(None),
    scope: str | None = Query(None),
    category: str | None = Query(None),
    language: str | None = Query(None),
):
    """Merged active constitutions + standalone policies for a given org/scope.

    Returns a flat, prioritized list of active rules. Supports ETag for
    efficient polling by runtime consumers (Yarn, Planner, MCP-TS).
    """
    async with async_session() as session:
        cq = select(GovernanceConstitution).where(GovernanceConstitution.status == "active")
        if org_id:
            cq = cq.where((GovernanceConstitution.scope == "platform") | (GovernanceConstitution.scope_value == org_id))
        if scope:
            cq = cq.where(GovernanceConstitution.scope == scope)
        const_result = await session.execute(cq)
        constitutions = const_result.scalars().all()

        rules: list[dict] = []

        for c in constitutions:
            clq = select(GovernanceClause).where(
                GovernanceClause.constitution_id == c.constitution_id,
                GovernanceClause.enabled == True,
            )
            if category:
                clq = clq.where(GovernanceClause.category == category)
            cl_result = await session.execute(clq)
            for cl in cl_result.scalars().all():
                if language and cl.applicability:
                    langs = cl.applicability.get("languages", [])
                    if langs and language.lower() not in [l.lower() for l in langs]:
                        continue
                rules.append(
                    {
                        "source": "constitution",
                        "constitution_id": c.constitution_id,
                        "constitution_name": c.name,
                        "maturity_mode": c.maturity_mode,
                        "scope": c.scope,
                        "scope_precedence": SCOPE_PRECEDENCE.get(c.scope, 99),
                        "precedence": c.precedence,
                        "clause_id": cl.clause_id,
                        "category": cl.category,
                        "constraint_kind": cl.constraint_kind,
                        "statement": cl.statement,
                        "machine_rule": cl.machine_rule,
                        "applicability": cl.applicability,
                        "evidence_requirements": cl.evidence_requirements,
                        "actions": cl.actions,
                        "priority": cl.priority,
                    }
                )

        pq = select(GovernancePolicyDef).where(GovernancePolicyDef.enabled == True)
        if org_id:
            pq = pq.where((GovernancePolicyDef.org_id == "") | (GovernancePolicyDef.org_id == org_id))
        if scope:
            pq = pq.where(GovernancePolicyDef.scope == scope)
        if category:
            pq = pq.where(GovernancePolicyDef.category == category)
        pol_result = await session.execute(pq)
        for p in pol_result.scalars().all():
            rules.append(
                {
                    "source": "policy",
                    "policy_id": p.policy_id,
                    "policy_name": p.name,
                    "scope": p.scope,
                    "scope_precedence": SCOPE_PRECEDENCE.get(p.scope, 99),
                    "precedence": p.priority,
                    "category": p.category,
                    "constraint_kind": p.constraint_kind,
                    "rule_type": p.rule_type,
                    "rule_config": p.rule_config,
                    "priority": p.priority,
                }
            )

    rules.sort(
        key=lambda r: (
            0 if r["constraint_kind"] == "hard" else (1 if r["constraint_kind"] == "guiding" else 2),
            r["scope_precedence"],
            -r["precedence"],
            -r["priority"],
        )
    )

    etag_src = "|".join(r.get("clause_id", r.get("policy_id", "")) for r in rules)
    etag = hashlib.sha256(etag_src.encode()).hexdigest()[:16]
    response.headers["ETag"] = f'"{etag}"'

    if_none_match = request.headers.get("if-none-match", "").strip('"')
    if if_none_match == etag:
        response.status_code = 304
        return None

    return {
        "rules": rules,
        "total": len(rules),
        "etag": etag,
    }


# ---------------------------------------------------------------------------
# Overview / summary
# ---------------------------------------------------------------------------


@router.get("/summary")
async def governance_summary(user: UserInfo = Depends(get_current_user)):
    """Dashboard summary: counts by status, maturity mode distribution, recent changes."""
    async with async_session() as session:
        status_q = select(
            GovernanceConstitution.status,
            func.count(GovernanceConstitution.id),
        ).group_by(GovernanceConstitution.status)
        status_result = await session.execute(status_q)
        status_counts = {row[0]: row[1] for row in status_result.all()}

        maturity_q = (
            select(
                GovernanceConstitution.maturity_mode,
                func.count(GovernanceConstitution.id),
            )
            .where(GovernanceConstitution.status == "active")
            .group_by(GovernanceConstitution.maturity_mode)
        )
        maturity_result = await session.execute(maturity_q)
        maturity_counts = {row[0]: row[1] for row in maturity_result.all()}

        policy_count_q = select(func.count(GovernancePolicyDef.id))
        policy_count = (await session.execute(policy_count_q)).scalar() or 0

        recent_q = select(GovernanceConstitution).order_by(GovernanceConstitution.updated_at.desc()).limit(5)
        recent_result = await session.execute(recent_q)
        recent = recent_result.scalars().all()

    return {
        "constitution_status_counts": status_counts,
        "active_maturity_modes": maturity_counts,
        "total_policies": policy_count,
        "recent_constitutions": [_constitution_to_dict(r) for r in recent],
    }
