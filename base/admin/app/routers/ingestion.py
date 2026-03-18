"""Ingestion queue: sources, items, and runs management."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import IngestionItem, IngestionRun, IngestionSource

logger = logging.getLogger("synesis.admin.ingestion")

router = APIRouter(prefix="/api/v1/ingestion", tags=["ingestion"])


class SourceCreate(BaseModel):
    name: str
    handler: str = "seed_corpus"
    origin_type: str = "curated"
    authority: str = "vetted"
    domain: str = ""
    config: dict | None = None
    tags: list[str] | None = None


class ItemCreate(BaseModel):
    url: str
    title: str = ""
    domain: str = ""
    tags: list[str] | None = None
    priority: int = 0
    source_id: int | None = None


class BulkImport(BaseModel):
    items: list[ItemCreate]


@router.get("/sources")
async def list_sources(
    _user: UserInfo = Depends(get_current_user),
    status: str = Query("", description="Filter by status"),
):
    async with async_session() as session:
        q = select(IngestionSource).order_by(IngestionSource.id.desc())
        if status:
            q = q.where(IngestionSource.status == status)
        rows = (await session.execute(q)).scalars().all()

        sources = []
        for r in rows:
            item_count = (
                await session.execute(
                    select(func.count()).where(IngestionItem.source_id == r.id)
                )
            ).scalar() or 0
            sources.append({
                "id": r.id,
                "name": r.name,
                "handler": r.handler,
                "origin_type": r.origin_type,
                "authority": r.authority,
                "domain": r.domain,
                "tags": r.tags,
                "status": r.status,
                "item_count": item_count,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            })
    return {"sources": sources}


@router.post("/sources")
async def create_source(
    body: SourceCreate,
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        src = IngestionSource(
            name=body.name,
            handler=body.handler,
            origin_type=body.origin_type,
            authority=body.authority,
            domain=body.domain,
            config=body.config,
            tags=body.tags,
        )
        session.add(src)
        await session.commit()
        await session.refresh(src)
        return {"ok": True, "id": src.id}


@router.get("/items")
async def list_items(
    _user: UserInfo = Depends(get_current_user),
    status: str = Query("", description="Filter by status"),
    domain: str = Query("", description="Filter by domain"),
    source_id: int | None = Query(None, description="Filter by source"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    offset = (page - 1) * page_size
    async with async_session() as session:
        q = select(IngestionItem)
        if status:
            q = q.where(IngestionItem.status == status)
        if domain:
            q = q.where(IngestionItem.domain == domain)
        if source_id is not None:
            q = q.where(IngestionItem.source_id == source_id)

        total = (await session.execute(select(func.count()).select_from(q.subquery()))).scalar() or 0
        rows = (
            await session.execute(
                q.order_by(IngestionItem.id.desc()).offset(offset).limit(page_size)
            )
        ).scalars().all()

        items = [
            {
                "id": r.id,
                "source_id": r.source_id,
                "url": r.url,
                "title": r.title,
                "domain": r.domain,
                "tags": r.tags,
                "priority": r.priority,
                "status": r.status,
                "chunk_count": r.chunk_count,
                "error_message": r.error_message[:200] if r.error_message else "",
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.post("/items")
async def add_item(
    body: ItemCreate,
    _user: UserInfo = Depends(get_current_user),
):
    """Add a single URL to the ingestion queue."""
    async with async_session() as session:
        item = IngestionItem(
            source_id=body.source_id,
            url=body.url,
            title=body.title,
            domain=body.domain,
            tags=body.tags,
            priority=body.priority,
            status="pending",
            queued_at=datetime.now(timezone.utc),
        )
        session.add(item)
        await session.commit()
        await session.refresh(item)
        return {"ok": True, "id": item.id}


@router.post("/items/bulk")
async def add_items_bulk(
    body: BulkImport,
    _user: UserInfo = Depends(get_current_user),
):
    """Bulk-add URLs to the ingestion queue."""
    now = datetime.now(timezone.utc)
    async with async_session() as session:
        items = [
            IngestionItem(
                source_id=item.source_id,
                url=item.url,
                title=item.title,
                domain=item.domain,
                tags=item.tags,
                priority=item.priority,
                status="pending",
                queued_at=now,
            )
            for item in body.items
        ]
        session.add_all(items)
        await session.commit()
        return {"ok": True, "added": len(items)}


@router.get("/runs")
async def list_runs(
    _user: UserInfo = Depends(get_current_user),
    limit: int = Query(20, ge=1, le=100),
):
    async with async_session() as session:
        rows = (
            await session.execute(
                select(IngestionRun).order_by(IngestionRun.id.desc()).limit(limit)
            )
        ).scalars().all()
        return {
            "runs": [
                {
                    "id": r.id,
                    "source_id": r.source_id,
                    "trigger": r.trigger,
                    "status": r.status,
                    "items_total": r.items_total,
                    "items_indexed": r.items_indexed,
                    "items_failed": r.items_failed,
                    "started_at": r.started_at.isoformat() if r.started_at else None,
                    "completed_at": r.completed_at.isoformat() if r.completed_at else None,
                }
                for r in rows
            ]
        }


@router.get("/stats")
async def ingestion_stats(_user: UserInfo = Depends(get_current_user)):
    """Summary stats for the ingestion queue."""
    async with async_session() as session:
        total_sources = (
            await session.execute(select(func.count()).select_from(IngestionSource))
        ).scalar() or 0
        total_items = (
            await session.execute(select(func.count()).select_from(IngestionItem))
        ).scalar() or 0
        pending = (
            await session.execute(
                select(func.count()).where(IngestionItem.status == "pending")
            )
        ).scalar() or 0
        indexed = (
            await session.execute(
                select(func.count()).where(IngestionItem.status == "indexed")
            )
        ).scalar() or 0
        failed = (
            await session.execute(
                select(func.count()).where(IngestionItem.status == "failed")
            )
        ).scalar() or 0
    return {
        "total_sources": total_sources,
        "total_items": total_items,
        "pending": pending,
        "indexed": indexed,
        "failed": failed,
    }
