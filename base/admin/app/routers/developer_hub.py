"""Developer Hub / Backstage connector management API."""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import AdminAuditEvent, DevHubConnector
from ..rbac import Role, RouteGroup, can_access_route_group, can_manage_visibility_scope, resolve_role
from ..services.outbound_security import validate_public_https_url

logger = logging.getLogger("synesis.admin.developer_hub")

router = APIRouter(prefix="/api/v1/developer-hub", tags=["developer-hub"])

VALID_AUTH_TYPES = {"none", "bearer", "oauth"}
VALID_ENTITY_KINDS = {"Template", "Component", "API", "System", "Domain", "Resource", "Group", "User"}
DEFAULT_ENTITY_KINDS = ["Template", "Component", "API", "System"]
VALID_SCOPES = {"global", "org", "tenant", "platform"}
_ENV_REF_RE = re.compile(r"^[A-Z_][A-Z0-9_]{0,255}$")


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


def _connector_to_dict(c: DevHubConnector) -> dict:
    return {
        "id": c.id,
        "connector_id": c.connector_id,
        "name": c.name,
        "description": c.description,
        "base_url": c.base_url,
        "auth_type": c.auth_type,
        "auth_token_ref": "",
        "has_auth_token_ref": bool(c.auth_token_ref),
        "entity_kinds": c.entity_kinds or DEFAULT_ENTITY_KINDS,
        "sync_interval_minutes": c.sync_interval_minutes,
        "last_sync_at": c.last_sync_at.isoformat() if c.last_sync_at else None,
        "last_sync_status": c.last_sync_status,
        "last_sync_summary": c.last_sync_summary,
        "org_id": c.org_id,
        "scope": c.scope,
        "scope_value": c.scope_value,
        "enabled": c.enabled,
        "has_cached_snapshot": c.cached_entity_snapshot is not None,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


def _ensure_connector_admin(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_content_admin):
        raise HTTPException(403, "Requires org content admin access")


def _scope_for_rbac(scope: str) -> str:
    return "global" if scope in {"global", "platform"} else scope


def _normalize_connector_scope(user: UserInfo, scope: str, org_id: str, scope_value: str) -> tuple[str, str, str]:
    normalized_scope = (scope or "org").strip().lower()
    if normalized_scope not in VALID_SCOPES:
        raise HTTPException(400, f"scope must be one of {sorted(VALID_SCOPES)}")
    target_org = (org_id or scope_value or user.org_id or "").strip()
    if not can_manage_visibility_scope(user, visibility_scope=_scope_for_rbac(normalized_scope), org_id=target_org):
        raise HTTPException(403, "Not authorized for connector scope")
    if resolve_role(user) < Role.platform_admin:
        target_org = (user.org_id or "").strip()
        normalized_scope = "org"
        scope_value = target_org
    elif normalized_scope == "org" and not target_org:
        raise HTTPException(400, "org_id is required for org-scoped connectors")
    return normalized_scope, target_org, (scope_value or target_org).strip()


def _validate_auth_config(auth_type: str, auth_token_ref: str) -> str:
    if auth_type not in VALID_AUTH_TYPES:
        raise HTTPException(400, f"auth_type must be one of {VALID_AUTH_TYPES}")
    token_ref = auth_token_ref.strip()
    if auth_type == "none":
        return ""
    if auth_type == "bearer" and not _ENV_REF_RE.fullmatch(token_ref):
        raise HTTPException(400, "auth_token_ref must be an environment variable name for bearer auth")
    return token_ref


def _can_read_connector(user: UserInfo, row: DevHubConnector) -> bool:
    if resolve_role(user) >= Role.platform_admin:
        return True
    caller_org = (user.org_id or "").strip()
    return bool(caller_org and row.org_id == caller_org)


def _ensure_can_read_connector(user: UserInfo, row: DevHubConnector) -> None:
    if not _can_read_connector(user, row):
        raise HTTPException(404, "Connector not found")


def _ensure_can_manage_connector(user: UserInfo, row: DevHubConnector) -> None:
    if not can_manage_visibility_scope(user, visibility_scope=_scope_for_rbac(row.scope), org_id=row.org_id):
        raise HTTPException(403, "Not authorized for connector scope")


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class ConnectorCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    base_url: str = Field(..., min_length=1, max_length=512)
    description: str = Field("")
    auth_type: str = Field("none")
    auth_token_ref: str = Field("")
    entity_kinds: list[str] | None = None
    sync_interval_minutes: int = Field(0, ge=0, le=10080)
    org_id: str = Field("")
    scope: str = Field("org")
    scope_value: str = Field("")


class ConnectorUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    base_url: str | None = None
    auth_type: str | None = None
    auth_token_ref: str | None = None
    entity_kinds: list[str] | None = None
    sync_interval_minutes: int | None = None
    enabled: bool | None = None


# ---------------------------------------------------------------------------
# CRUD endpoints
# ---------------------------------------------------------------------------


@router.post("/connectors")
async def create_connector(
    body: ConnectorCreate,
    user: UserInfo = Depends(get_current_user),
):
    _ensure_connector_admin(user)
    auth_token_ref = _validate_auth_config(body.auth_type, body.auth_token_ref)
    entity_kinds = body.entity_kinds or list(DEFAULT_ENTITY_KINDS)
    for k in entity_kinds:
        if k not in VALID_ENTITY_KINDS:
            raise HTTPException(400, f"Invalid entity kind: {k}")

    url = validate_public_https_url(body.base_url, field_name="base_url")
    scope, org_id, scope_value = _normalize_connector_scope(user, body.scope, body.org_id, body.scope_value)
    connector_id = f"devhub-{uuid.uuid4().hex[:12]}"

    async with async_session() as session:
        row = DevHubConnector(
            connector_id=connector_id,
            name=body.name,
            description=body.description,
            base_url=url,
            auth_type=body.auth_type,
            auth_token_ref=auth_token_ref,
            entity_kinds=entity_kinds,
            sync_interval_minutes=body.sync_interval_minutes,
            org_id=org_id,
            scope=scope,
            scope_value=scope_value,
        )
        session.add(row)
        session.add(_audit(user, "devhub.connector.create", "ok", f"Created connector {connector_id}"))
        await session.commit()
        await session.refresh(row)
        return _connector_to_dict(row)


@router.get("/connectors")
async def list_connectors(
    user: UserInfo = Depends(get_current_user),
    org_id: str | None = Query(None),
    enabled: bool | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    _ensure_connector_admin(user)
    async with async_session() as session:
        q = select(DevHubConnector)
        role = resolve_role(user)
        if role < Role.platform_admin:
            caller_org = (user.org_id or "").strip()
            q = q.where(DevHubConnector.org_id == caller_org)
        if org_id is not None:
            if role < Role.platform_admin and org_id != (user.org_id or "").strip():
                raise HTTPException(403, "Not authorized for connector org")
            q = q.where(DevHubConnector.org_id == org_id)
        if enabled is not None:
            q = q.where(DevHubConnector.enabled == enabled)
        q = q.order_by(DevHubConnector.updated_at.desc()).limit(limit).offset(offset)
        result = await session.execute(q)
        rows = result.scalars().all()

        count_q = select(func.count(DevHubConnector.id))
        if role < Role.platform_admin:
            count_q = count_q.where(DevHubConnector.org_id == (user.org_id or "").strip())
        if org_id is not None:
            count_q = count_q.where(DevHubConnector.org_id == org_id)
        if enabled is not None:
            count_q = count_q.where(DevHubConnector.enabled == enabled)
        total = (await session.execute(count_q)).scalar() or 0

        return {"connectors": [_connector_to_dict(r) for r in rows], "total": total}


@router.get("/connectors/{connector_id}")
async def get_connector(
    connector_id: str,
    user: UserInfo = Depends(get_current_user),
):
    _ensure_connector_admin(user)
    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")
        _ensure_can_read_connector(user, row)
        return _connector_to_dict(row)


@router.patch("/connectors/{connector_id}")
async def update_connector(
    connector_id: str,
    body: ConnectorUpdate,
    user: UserInfo = Depends(get_current_user),
):
    _ensure_connector_admin(user)
    updates: dict = {}
    if body.name is not None:
        updates["name"] = body.name
    if body.description is not None:
        updates["description"] = body.description
    if body.base_url is not None:
        updates["base_url"] = validate_public_https_url(body.base_url, field_name="base_url")
    if body.auth_type is not None:
        token_ref = body.auth_token_ref or ""
        if body.auth_token_ref is None:
            async with async_session() as session:
                existing = (
                    await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
                ).scalar_one_or_none()
                if not existing:
                    raise HTTPException(404, "Connector not found")
                _ensure_can_manage_connector(user, existing)
                token_ref = existing.auth_token_ref
        token_ref = _validate_auth_config(body.auth_type, token_ref)
        updates["auth_type"] = body.auth_type
        updates["auth_token_ref"] = token_ref
    if body.auth_token_ref is not None:
        auth_type = body.auth_type
        if auth_type is None:
            async with async_session() as session:
                existing = (
                    await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
                ).scalar_one_or_none()
                if not existing:
                    raise HTTPException(404, "Connector not found")
                _ensure_can_manage_connector(user, existing)
                auth_type = existing.auth_type
        updates["auth_token_ref"] = _validate_auth_config(auth_type, body.auth_token_ref)
    if body.entity_kinds is not None:
        for k in body.entity_kinds:
            if k not in VALID_ENTITY_KINDS:
                raise HTTPException(400, f"Invalid entity kind: {k}")
        updates["entity_kinds"] = body.entity_kinds
    if body.sync_interval_minutes is not None:
        updates["sync_interval_minutes"] = max(0, min(body.sync_interval_minutes, 10080))
    if body.enabled is not None:
        updates["enabled"] = body.enabled

    if not updates:
        raise HTTPException(400, "No fields to update")

    updates["updated_at"] = datetime.now(UTC)

    async with async_session() as session:
        existing = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not existing:
            raise HTTPException(404, "Connector not found")
        _ensure_can_manage_connector(user, existing)
        result = await session.execute(
            update(DevHubConnector)
            .where(DevHubConnector.connector_id == connector_id)
            .values(**updates)
            .returning(DevHubConnector.id)
        )
        if result.rowcount == 0:
            raise HTTPException(404, "Connector not found")
        session.add(_audit(user, "devhub.connector.update", "ok", f"Updated connector {connector_id}"))
        await session.commit()

        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one()
        return _connector_to_dict(row)


@router.delete("/connectors/{connector_id}")
async def delete_connector(
    connector_id: str,
    user: UserInfo = Depends(get_current_user),
):
    from sqlalchemy import delete as sa_delete

    _ensure_connector_admin(user)
    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")
        _ensure_can_manage_connector(user, row)
        result = await session.execute(sa_delete(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        if result.rowcount == 0:
            raise HTTPException(404, "Connector not found")
        session.add(_audit(user, "devhub.connector.delete", "ok", f"Deleted connector {connector_id}"))
        await session.commit()
        return {"status": "deleted", "connector_id": connector_id}


@router.post("/connectors/{connector_id}/sync")
async def trigger_sync(
    connector_id: str,
    user: UserInfo = Depends(get_current_user),
):
    """Trigger a sync from the configured Developer Hub instance."""
    from ..services.devhub_sync import sync_connector

    _ensure_connector_admin(user)
    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")
        _ensure_can_manage_connector(user, row)

    try:
        result = await sync_connector(connector_id)
        async with async_session() as session:
            session.add(
                _audit(
                    user,
                    "devhub.connector.sync",
                    "ok",
                    f"Synced connector {connector_id}",
                    detail=result.to_dict(),
                )
            )
            await session.commit()
        return {"status": "ok", "connector_id": connector_id, "result": result.to_dict()}
    except Exception as exc:
        logger.error("devhub_sync_error connector=%s error=%s", connector_id, exc)
        raise HTTPException(500, "Sync failed")


@router.get("/connectors/{connector_id}/sync/preview")
async def preview_sync(
    connector_id: str,
    user: UserInfo = Depends(get_current_user),
):
    """Dry-run sync showing what would be created/updated."""
    from ..services.devhub_sync import sync_connector

    _ensure_connector_admin(user)
    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")
        _ensure_can_manage_connector(user, row)

    try:
        preview = await sync_connector(connector_id, dry_run=True)
        return {
            "connector_id": connector_id,
            "items": [p.to_dict() for p in preview],
            "total": len(preview),
            "summary": {
                "create": sum(1 for p in preview if p.action == "create"),
                "update": sum(1 for p in preview if p.action == "update"),
                "unchanged": sum(1 for p in preview if p.action == "unchanged"),
            },
        }
    except Exception as exc:
        logger.error("devhub_preview_error connector=%s error=%s", connector_id, exc)
        raise HTTPException(500, "Preview failed")


@router.get("/connectors/{connector_id}/cache")
async def get_connector_cache(
    connector_id: str,
    user: UserInfo = Depends(get_current_user),
):
    """Inspect the cached entity snapshot for a connector."""
    _ensure_connector_admin(user)
    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")
        _ensure_can_read_connector(user, row)

    snapshot = row.cached_entity_snapshot
    if not snapshot:
        return {"connector_id": connector_id, "has_cache": False, "entities": [], "synced_at": None}

    entities = snapshot.get("entities", [])
    return {
        "connector_id": connector_id,
        "has_cache": True,
        "entity_count": len(entities),
        "synced_at": snapshot.get("synced_at"),
        "entity_kinds": list({e.get("kind", "") for e in entities}),
    }


@router.post("/connectors/{connector_id}/test")
async def test_connector(
    connector_id: str,
    user: UserInfo = Depends(get_current_user),
):
    """Test connection to a Backstage/Developer Hub instance."""
    from ..services.catalog_client import CatalogClient, CatalogClientError

    _ensure_connector_admin(user)
    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")
        _ensure_can_manage_connector(user, row)

    client = CatalogClient(
        base_url=row.base_url,
        auth_type=row.auth_type,
        auth_token_ref=row.auth_token_ref,
    )
    try:
        await client.health_check()
        return {"status": "ok", "connector_id": connector_id}
    except CatalogClientError:
        return {"status": "error", "connector_id": connector_id, "error": "connector_health_check_failed"}
    finally:
        await client.close()


@router.get("/connectors/{connector_id}/health")
async def connector_health(
    connector_id: str,
    user: UserInfo = Depends(get_current_user),
):
    """Combined health status: connectivity + sync freshness."""
    from ..services.catalog_client import CatalogClient, CatalogClientError

    _ensure_connector_admin(user)
    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")
        _ensure_can_read_connector(user, row)

    health: dict = {
        "connector_id": connector_id,
        "enabled": row.enabled,
        "last_sync_status": row.last_sync_status,
        "last_sync_at": row.last_sync_at.isoformat() if row.last_sync_at else None,
        "has_cached_snapshot": row.cached_entity_snapshot is not None,
    }

    if row.last_sync_at and row.sync_interval_minutes > 0:
        age_minutes = (datetime.now(UTC) - row.last_sync_at).total_seconds() / 60
        health["sync_age_minutes"] = round(age_minutes, 1)
        health["sync_overdue"] = age_minutes > row.sync_interval_minutes * 1.5

    client = CatalogClient(
        base_url=row.base_url,
        auth_type=row.auth_type,
        auth_token_ref=row.auth_token_ref,
        timeout_s=5,
    )
    try:
        await client.health_check()
        health["connectivity"] = {"reachable": True}
    except CatalogClientError:
        health["connectivity"] = {"reachable": False, "error": "connector_health_check_failed"}
    finally:
        await client.close()

    return health
