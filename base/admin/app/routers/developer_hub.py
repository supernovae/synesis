"""Developer Hub / Backstage connector management API."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import AdminAuditEvent, DevHubConnector

logger = logging.getLogger("synesis.admin.developer_hub")

router = APIRouter(prefix="/api/v1/developer-hub", tags=["developer-hub"])

VALID_AUTH_TYPES = {"none", "bearer", "oauth"}
VALID_ENTITY_KINDS = {"Template", "Component", "API", "System", "Domain", "Resource", "Group", "User"}
DEFAULT_ENTITY_KINDS = ["Template", "Component", "API", "System"]


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
        "auth_token_ref": c.auth_token_ref,
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
    if body.auth_type not in VALID_AUTH_TYPES:
        raise HTTPException(400, f"auth_type must be one of {VALID_AUTH_TYPES}")
    entity_kinds = body.entity_kinds or list(DEFAULT_ENTITY_KINDS)
    for k in entity_kinds:
        if k not in VALID_ENTITY_KINDS:
            raise HTTPException(400, f"Invalid entity kind: {k}")

    url = body.base_url.rstrip("/")
    connector_id = f"devhub-{uuid.uuid4().hex[:12]}"

    async with async_session() as session:
        row = DevHubConnector(
            connector_id=connector_id,
            name=body.name,
            description=body.description,
            base_url=url,
            auth_type=body.auth_type,
            auth_token_ref=body.auth_token_ref,
            entity_kinds=entity_kinds,
            sync_interval_minutes=body.sync_interval_minutes,
            org_id=body.org_id,
            scope=body.scope,
            scope_value=body.scope_value,
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
    async with async_session() as session:
        q = select(DevHubConnector)
        if org_id is not None:
            q = q.where(DevHubConnector.org_id == org_id)
        if enabled is not None:
            q = q.where(DevHubConnector.enabled == enabled)
        q = q.order_by(DevHubConnector.updated_at.desc()).limit(limit).offset(offset)
        result = await session.execute(q)
        rows = result.scalars().all()

        count_q = select(func.count(DevHubConnector.id))
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
    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")
        return _connector_to_dict(row)


@router.patch("/connectors/{connector_id}")
async def update_connector(
    connector_id: str,
    body: ConnectorUpdate,
    user: UserInfo = Depends(get_current_user),
):
    updates: dict = {}
    if body.name is not None:
        updates["name"] = body.name
    if body.description is not None:
        updates["description"] = body.description
    if body.base_url is not None:
        updates["base_url"] = body.base_url.rstrip("/")
    if body.auth_type is not None:
        if body.auth_type not in VALID_AUTH_TYPES:
            raise HTTPException(400, f"auth_type must be one of {VALID_AUTH_TYPES}")
        updates["auth_type"] = body.auth_type
    if body.auth_token_ref is not None:
        updates["auth_token_ref"] = body.auth_token_ref
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

    async with async_session() as session:
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

    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")

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

    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")

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
    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")

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

    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")

    client = CatalogClient(
        base_url=row.base_url,
        auth_type=row.auth_type,
        auth_token_ref=row.auth_token_ref,
    )
    try:
        result = await client.health_check()
        return {"status": "ok", "connector_id": connector_id, "detail": result}
    except CatalogClientError as exc:
        return {"status": "error", "connector_id": connector_id, "error": str(exc)}
    finally:
        await client.close()


@router.get("/connectors/{connector_id}/health")
async def connector_health(
    connector_id: str,
    user: UserInfo = Depends(get_current_user),
):
    """Combined health status: connectivity + sync freshness."""
    from ..services.catalog_client import CatalogClient, CatalogClientError

    async with async_session() as session:
        row = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Connector not found")

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
        probe = await client.health_check()
        health["connectivity"] = probe
    except CatalogClientError as exc:
        health["connectivity"] = {"reachable": False, "error": str(exc)}
    finally:
        await client.close()

    return health
