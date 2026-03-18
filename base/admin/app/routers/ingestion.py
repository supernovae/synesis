"""Ingestion queue: sources, items, runs, claim/status, and bootstrap."""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime

import yaml
from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import IngestionItem, IngestionRun, IngestionSource, MilvusSchemaSync

logger = logging.getLogger("synesis.admin.ingestion")

router = APIRouter(prefix="/api/v1/ingestion", tags=["ingestion"])


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class SourceCreate(BaseModel):
    name: str
    handler: str = "html_document"
    origin_type: str = "curated"
    authority: str = "vetted"
    domain: str = ""
    config: dict | None = None
    tags: list[str] | None = None


class ItemCreate(BaseModel):
    uri: str
    handler: str | None = None
    title: str = ""
    domain: str = ""
    authority: str = "vetted"
    origin_type: str = "curated"
    tags: list[str] | None = None
    priority: int = 0
    config: dict | None = None
    source_id: int | None = None


class BulkImport(BaseModel):
    items: list[ItemCreate]


class StatusUpdate(BaseModel):
    status: str = Field(..., pattern="^(indexed|failed|pending|dead_letter)$")
    chunk_count: int | None = None
    error_message: str | None = None
    milvus_doc_id: str | None = None
    content_hash: str | None = None


class RunCreate(BaseModel):
    trigger: str = "manual"
    source_id: int | None = None


class RunUpdate(BaseModel):
    status: str | None = None
    items_total: int | None = None
    items_indexed: int | None = None
    items_failed: int | None = None


# ---------------------------------------------------------------------------
# Helper: serialize an IngestionItem row to dict
# ---------------------------------------------------------------------------


def _item_dict(r: IngestionItem) -> dict:
    return {
        "id": r.id,
        "source_id": r.source_id,
        "uri": r.uri,
        "handler": r.handler,
        "title": r.title,
        "domain": r.domain,
        "authority": r.authority,
        "origin_type": r.origin_type,
        "tags": r.tags,
        "priority": r.priority,
        "config": r.config,
        "status": r.status,
        "content_hash": r.content_hash,
        "chunk_count": r.chunk_count,
        "error_message": r.error_message[:200] if r.error_message else "",
        "milvus_doc_id": r.milvus_doc_id,
        "retry_count": r.retry_count,
        "max_retries": r.max_retries,
        "queued_at": r.queued_at.isoformat() if r.queued_at else None,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


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
                await session.execute(select(func.count()).where(IngestionItem.source_id == r.id))
            ).scalar() or 0
            pending = (
                await session.execute(
                    select(func.count()).where(
                        IngestionItem.source_id == r.id,
                        IngestionItem.status == "pending",
                    )
                )
            ).scalar() or 0
            sources.append(
                {
                    "id": r.id,
                    "name": r.name,
                    "handler": r.handler,
                    "origin_type": r.origin_type,
                    "authority": r.authority,
                    "domain": r.domain,
                    "config": r.config,
                    "tags": r.tags,
                    "status": r.status,
                    "item_count": item_count,
                    "pending_count": pending,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
            )
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


# ---------------------------------------------------------------------------
# Items — CRUD
# ---------------------------------------------------------------------------


@router.get("/items")
async def list_items(
    _user: UserInfo = Depends(get_current_user),
    status: str = Query("", description="Filter by status"),
    handler: str = Query("", description="Filter by handler"),
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
        if handler:
            q = q.where(IngestionItem.handler == handler)
        if domain:
            q = q.where(IngestionItem.domain == domain)
        if source_id is not None:
            q = q.where(IngestionItem.source_id == source_id)

        total = (await session.execute(select(func.count()).select_from(q.subquery()))).scalar() or 0
        rows = (
            (await session.execute(q.order_by(IngestionItem.id.desc()).offset(offset).limit(page_size))).scalars().all()
        )

    return {"items": [_item_dict(r) for r in rows], "total": total, "page": page, "page_size": page_size}


@router.post("/items")
async def add_item(
    body: ItemCreate,
    _user: UserInfo = Depends(get_current_user),
):
    """Add a single URI to the ingestion queue (dedup by uri)."""
    async with async_session() as session:
        stmt = (
            pg_insert(IngestionItem)
            .values(
                source_id=body.source_id,
                uri=body.uri,
                handler=body.handler,
                title=body.title,
                domain=body.domain,
                authority=body.authority,
                origin_type=body.origin_type,
                tags=body.tags,
                priority=body.priority,
                config=body.config,
                status="pending",
                queued_at=datetime.now(UTC),
            )
            .on_conflict_do_nothing(index_elements=["uri"])
        )
        result = await session.execute(stmt)
        await session.commit()
        inserted = result.rowcount > 0  # type: ignore[union-attr]
        return {"ok": True, "inserted": inserted, "uri": body.uri}


@router.post("/items/bulk")
async def add_items_bulk(
    body: BulkImport,
    _user: UserInfo = Depends(get_current_user),
):
    """Bulk-add URIs to the ingestion queue (dedup by uri)."""
    now = datetime.now(UTC)
    added = 0
    skipped = 0
    async with async_session() as session:
        for item in body.items:
            stmt = (
                pg_insert(IngestionItem)
                .values(
                    source_id=item.source_id,
                    uri=item.uri,
                    handler=item.handler,
                    title=item.title,
                    domain=item.domain,
                    authority=item.authority,
                    origin_type=item.origin_type,
                    tags=item.tags,
                    priority=item.priority,
                    config=item.config,
                    status="pending",
                    queued_at=now,
                )
                .on_conflict_do_nothing(index_elements=["uri"])
            )
            result = await session.execute(stmt)
            if result.rowcount > 0:  # type: ignore[union-attr]
                added += 1
            else:
                skipped += 1
        await session.commit()
    return {"ok": True, "added": added, "skipped": skipped}


@router.delete("/items/{item_id}")
async def delete_item(
    item_id: int,
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        item = await session.get(IngestionItem, item_id)
        if not item:
            return {"ok": False, "error": "not_found"}
        await session.delete(item)
        await session.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Items — Claim + Status (indexer work queue)
# ---------------------------------------------------------------------------


@router.post("/items/claim")
async def claim_item(response: Response):
    """Atomically claim the next pending or retryable-failed item.

    Priority order: pending items first (by priority desc, then age),
    then failed items whose retry_count < max_retries (exponential backoff).
    Uses SELECT ... FOR UPDATE SKIP LOCKED for safe concurrent claiming.
    Returns 204 when nothing is claimable.
    No auth required — called by indexer pods within the cluster.
    """
    from sqlalchemy import or_, text

    async with async_session() as session:
        q = (
            select(IngestionItem)
            .where(
                or_(
                    IngestionItem.status == "pending",
                    # Auto-retry failed items that haven't exceeded max_retries,
                    # with exponential backoff: 2^retry_count minutes after last attempt
                    (
                        (IngestionItem.status == "failed")
                        & (IngestionItem.retry_count < IngestionItem.max_retries)
                        & (
                            IngestionItem.completed_at
                            <= text("NOW() - INTERVAL '1 minute' * POWER(2, COALESCE(retry_count, 0))")
                        )
                    ),
                )
            )
            .order_by(
                # pending items first, then retryable failed items
                (IngestionItem.status == "pending").desc(),
                IngestionItem.priority.desc(),
                IngestionItem.created_at,
            )
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        item = (await session.execute(q)).scalar_one_or_none()
        if not item:
            response.status_code = 204
            return None

        item.status = "running"
        item.started_at = datetime.now(UTC)
        item.retry_count = item.retry_count or 0

        # Resolve handler from source if not set on item
        effective_handler = item.handler
        effective_authority = item.authority
        effective_config = item.config
        effective_domain = item.domain
        effective_tags = item.tags

        if item.source_id:
            src = await session.get(IngestionSource, item.source_id)
            if src:
                if not effective_handler:
                    effective_handler = src.handler
                if not effective_config and src.config:
                    effective_config = src.config
                if not effective_domain and src.domain:
                    effective_domain = src.domain
                if effective_authority == "vetted" and src.authority:
                    effective_authority = src.authority
                if not effective_tags and src.tags:
                    effective_tags = src.tags

        await session.commit()
        await session.refresh(item)

        payload = _item_dict(item)
        payload["effective_handler"] = effective_handler
        payload["effective_authority"] = effective_authority
        payload["effective_config"] = effective_config
        payload["effective_domain"] = effective_domain
        payload["effective_tags"] = effective_tags
        return payload


@router.patch("/items/{item_id}/status")
async def update_item_status(
    item_id: int,
    body: StatusUpdate,
):
    """Update item status after processing. No auth — called by indexer pods.

    When status is 'failed' and retry_count reaches max_retries, the item is
    automatically escalated to 'dead_letter' so it won't be retried again.
    """
    now = datetime.now(UTC)
    async with async_session() as session:
        item = await session.get(IngestionItem, item_id)
        if not item:
            return {"ok": False, "error": "not_found"}

        if body.chunk_count is not None:
            item.chunk_count = body.chunk_count
        if body.error_message is not None:
            item.error_message = body.error_message
        if body.milvus_doc_id is not None:
            item.milvus_doc_id = body.milvus_doc_id
        if body.content_hash is not None:
            item.content_hash = body.content_hash

        if body.status in ("indexed", "failed", "dead_letter"):
            item.completed_at = now

        if body.status == "failed":
            item.retry_count = (item.retry_count or 0) + 1
            if item.retry_count >= item.max_retries:
                item.status = "dead_letter"
                logger.info(
                    "ingestion_item_dead_letter",
                    extra={"item_id": item_id, "uri": item.uri, "retries": item.retry_count},
                )
            else:
                item.status = "failed"
        else:
            item.status = body.status

        await session.commit()
    return {"ok": True, "status": item.status}


@router.post("/items/{item_id}/retry")
async def retry_item(
    item_id: int,
    reset_retries: bool = Query(False, description="Reset retry count (for dead_letter items)"),
    _user: UserInfo = Depends(get_current_user),
):
    """Reset a failed or dead_letter item back to pending for reprocessing.

    For dead_letter items, pass reset_retries=true to clear the retry counter.
    """
    async with async_session() as session:
        item = await session.get(IngestionItem, item_id)
        if not item:
            return {"ok": False, "error": "not_found"}
        if item.status not in ("failed", "dead_letter"):
            return {"ok": False, "error": f"cannot retry item with status '{item.status}'"}
        if item.status == "dead_letter" and not reset_retries:
            return {"ok": False, "error": "dead_letter items require reset_retries=true"}
        if reset_retries:
            item.retry_count = 0
        item.status = "pending"
        item.error_message = ""
        item.started_at = None
        item.completed_at = None
        item.queued_at = datetime.now(UTC)
        await session.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


@router.get("/runs")
async def list_runs(
    _user: UserInfo = Depends(get_current_user),
    limit: int = Query(20, ge=1, le=100),
):
    async with async_session() as session:
        rows = (
            (await session.execute(select(IngestionRun).order_by(IngestionRun.id.desc()).limit(limit))).scalars().all()
        )
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


@router.post("/runs")
async def create_run(body: RunCreate):
    """Create a new ingestion run record. No auth — called by indexer pods."""
    async with async_session() as session:
        run = IngestionRun(
            source_id=body.source_id,
            trigger=body.trigger,
            status="running",
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
        return {"ok": True, "id": run.id}


@router.patch("/runs/{run_id}")
async def update_run(run_id: int, body: RunUpdate):
    """Update run progress. No auth — called by indexer pods."""
    async with async_session() as session:
        run = await session.get(IngestionRun, run_id)
        if not run:
            return {"ok": False, "error": "not_found"}
        if body.status is not None:
            run.status = body.status
            if body.status in ("complete", "failed"):
                run.completed_at = datetime.now(UTC)
        if body.items_total is not None:
            run.items_total = body.items_total
        if body.items_indexed is not None:
            run.items_indexed = body.items_indexed
        if body.items_failed is not None:
            run.items_failed = body.items_failed
        await session.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


@router.get("/stats")
async def ingestion_stats(_user: UserInfo = Depends(get_current_user)):
    """Summary stats for the ingestion queue."""
    async with async_session() as session:
        total_sources = (await session.execute(select(func.count()).select_from(IngestionSource))).scalar() or 0
        total_items = (await session.execute(select(func.count()).select_from(IngestionItem))).scalar() or 0
        pending = (await session.execute(select(func.count()).where(IngestionItem.status == "pending"))).scalar() or 0
        running = (await session.execute(select(func.count()).where(IngestionItem.status == "running"))).scalar() or 0
        indexed = (await session.execute(select(func.count()).where(IngestionItem.status == "indexed"))).scalar() or 0
        failed = (await session.execute(select(func.count()).where(IngestionItem.status == "failed"))).scalar() or 0
        dead_letter = (
            await session.execute(select(func.count()).where(IngestionItem.status == "dead_letter"))
        ).scalar() or 0
        total_chunks = (await session.execute(select(func.sum(IngestionItem.chunk_count)))).scalar() or 0
    return {
        "total_sources": total_sources,
        "total_items": total_items,
        "pending": pending,
        "running": running,
        "indexed": indexed,
        "failed": failed,
        "dead_letter": dead_letter,
        "total_chunks": total_chunks,
    }


# ---------------------------------------------------------------------------
# Schema sync — detect Milvus schema drift and reset stale items
# ---------------------------------------------------------------------------


class SchemaReport(BaseModel):
    collection: str = "synesis_catalog"
    schema_version: int
    reporter: str = "indexer"


@router.post("/schema-sync")
async def report_schema_version(body: SchemaReport):
    """Called by the indexer after ensuring/recreating the Milvus collection.

    If the reported version differs from what's stored, all 'indexed' and
    'running' ingestion items are reset to 'pending' (since the old Milvus
    data is gone after a schema bump). This makes re-import automatic.

    No auth required — called by indexer pods within the cluster.
    """
    now = datetime.now(UTC)
    async with async_session() as session:
        row = (
            await session.execute(select(MilvusSchemaSync).where(MilvusSchemaSync.collection == body.collection))
        ).scalar_one_or_none()

        if row is None:
            row = MilvusSchemaSync(
                collection=body.collection,
                schema_version=body.schema_version,
                last_reported_by=body.reporter,
                updated_at=now,
            )
            session.add(row)
            await session.commit()
            logger.info(
                "schema_sync_initialized",
                extra={"collection": body.collection, "version": body.schema_version},
            )
            return {
                "ok": True,
                "action": "initialized",
                "schema_version": body.schema_version,
                "items_reset": 0,
            }

        if row.schema_version == body.schema_version:
            row.last_reported_by = body.reporter
            row.updated_at = now
            await session.commit()
            return {
                "ok": True,
                "action": "no_change",
                "schema_version": body.schema_version,
                "items_reset": 0,
            }

        old_version = row.schema_version
        row.schema_version = body.schema_version
        row.last_reported_by = body.reporter
        row.last_reset_at = now
        row.updated_at = now

        from sqlalchemy import update

        result = await session.execute(
            update(IngestionItem)
            .where(IngestionItem.status.in_(["indexed", "running", "failed", "dead_letter"]))
            .values(
                status="pending",
                chunk_count=0,
                error_message="",
                milvus_doc_id="",
                retry_count=0,
                started_at=None,
                completed_at=None,
                queued_at=now,
            )
        )
        items_reset = result.rowcount  # type: ignore[union-attr]
        await session.commit()

        logger.info(
            "schema_sync_reset",
            extra={
                "collection": body.collection,
                "old_version": old_version,
                "new_version": body.schema_version,
                "items_reset": items_reset,
                "reset_at": now.isoformat(),
            },
        )
        return {
            "ok": True,
            "action": "reset",
            "old_version": old_version,
            "new_version": body.schema_version,
            "items_reset": items_reset,
            "reset_at": now.isoformat(),
        }


EXPECTED_SCHEMA_VERSION = int(os.environ.get("SYNESIS_EXPECTED_SCHEMA_VERSION", "8"))


@router.get("/schema-sync")
async def get_schema_sync(_user: UserInfo = Depends(get_current_user)):
    """Get the current Milvus schema version tracked by the admin DB.

    Includes expected_version (from deploy config) and upgrade_pending flag
    so the UI can show a banner when the indexer hasn't run yet after a
    schema bump.
    """
    async with async_session() as session:
        rows = (await session.execute(select(MilvusSchemaSync))).scalars().all()

        syncs = []
        any_pending = False
        for r in rows:
            pending = r.schema_version < EXPECTED_SCHEMA_VERSION
            if pending:
                any_pending = True
            syncs.append(
                {
                    "collection": r.collection,
                    "schema_version": r.schema_version,
                    "expected_version": EXPECTED_SCHEMA_VERSION,
                    "upgrade_pending": pending,
                    "last_reset_at": r.last_reset_at.isoformat() if r.last_reset_at else None,
                    "last_reported_by": r.last_reported_by,
                    "updated_at": r.updated_at.isoformat() if r.updated_at else None,
                }
            )

        if not syncs:
            any_pending = True
            syncs.append(
                {
                    "collection": "synesis_catalog",
                    "schema_version": 0,
                    "expected_version": EXPECTED_SCHEMA_VERSION,
                    "upgrade_pending": True,
                    "last_reset_at": None,
                    "last_reported_by": None,
                    "updated_at": None,
                }
            )

        return {
            "expected_version": EXPECTED_SCHEMA_VERSION,
            "upgrade_pending": any_pending,
            "syncs": syncs,
        }


# ---------------------------------------------------------------------------
# Handlers — available handler types with metadata for the UI
# ---------------------------------------------------------------------------

HANDLER_METADATA = [
    {
        "handler_type": "github_code",
        "label": "GitHub Code Repository",
        "source_type": "code",
        "uri_pattern": "owner/repo",
        "uri_hint": "GitHub owner/repo (e.g. kubernetes/kubernetes)",
        "config_hints": {"branch": "main", "paths": ["src/"]},
        "artifact_kind": "code",
    },
    {
        "handler_type": "github_markdown",
        "label": "GitHub Markdown Docs",
        "source_type": "markdown",
        "uri_pattern": "owner/repo",
        "uri_hint": "GitHub owner/repo with markdown docs (e.g. langchain-ai/langchain)",
        "config_hints": {"branch": "main", "paths": ["docs/"]},
        "artifact_kind": "docs",
    },
    {
        "handler_type": "html_document",
        "label": "HTML Document",
        "source_type": "html",
        "uri_pattern": "https://...",
        "uri_hint": "Full URL to an HTML page",
        "config_hints": {},
        "artifact_kind": "docs",
    },
    {
        "handler_type": "web_page",
        "label": "Web Page (auto-crawl)",
        "source_type": "web_page",
        "uri_pattern": "https://...",
        "uri_hint": "URL to crawl (follows links within same domain)",
        "config_hints": {"max_depth": 2, "max_pages": 50},
        "artifact_kind": "docs",
    },
    {
        "handler_type": "pdf_document",
        "label": "PDF Document",
        "source_type": "pdf",
        "uri_pattern": "https://.../*.pdf",
        "uri_hint": "Direct URL to a PDF file",
        "config_hints": {},
        "artifact_kind": "docs",
    },
    {
        "handler_type": "arxiv_paper",
        "label": "arXiv Paper",
        "source_type": "paper",
        "uri_pattern": "2401.12345",
        "uri_hint": "arXiv paper ID (e.g. 2401.12345)",
        "config_hints": {},
        "artifact_kind": "docs",
    },
    {
        "handler_type": "openapi_spec",
        "label": "OpenAPI Specification",
        "source_type": "openapi",
        "uri_pattern": "https://.../*.yaml",
        "uri_hint": "URL to an OpenAPI/Swagger spec (YAML or JSON)",
        "config_hints": {},
        "artifact_kind": "api_spec",
    },
    {
        "handler_type": "markdown_file",
        "label": "Markdown File",
        "source_type": "markdown",
        "uri_pattern": "https://.../*.md",
        "uri_hint": "Direct URL to a Markdown file",
        "config_hints": {},
        "artifact_kind": "docs",
    },
    {
        "handler_type": "structured_data",
        "label": "Structured Data (YAML/JSON/TOML/XML)",
        "source_type": "structured",
        "uri_pattern": "https://.../*.(yaml|json|toml|xml)",
        "uri_hint": "URL to a structured data file",
        "config_hints": {"format": "yaml"},
        "artifact_kind": "config",
    },
    {
        "handler_type": "generic_text",
        "label": "Generic Text",
        "source_type": "text",
        "uri_pattern": "https://.../*.txt",
        "uri_hint": "URL to a plain-text file",
        "config_hints": {},
        "artifact_kind": "docs",
    },
    {
        "handler_type": "license_spdx",
        "label": "SPDX License",
        "source_type": "license",
        "uri_pattern": "MIT | Apache-2.0 | ...",
        "uri_hint": "SPDX license identifier",
        "config_hints": {},
        "artifact_kind": "docs",
    },
    {
        "handler_type": "seed_corpus",
        "label": "Seed Corpus (bootstrap YAML)",
        "source_type": "seed_corpus",
        "uri_pattern": "file:///path/to/corpus.yaml",
        "uri_hint": "Path to a seed corpus YAML file",
        "config_hints": {},
        "artifact_kind": "docs",
    },
]


@router.get("/handlers")
async def list_handler_types():
    """Return supported handler types with metadata for the UI."""
    return {"handlers": HANDLER_METADATA}


# ---------------------------------------------------------------------------
# Bootstrap — import normalized YAML into the queue
# ---------------------------------------------------------------------------


@router.post("/bootstrap")
async def bootstrap_from_yaml(
    file: UploadFile = File(...),
    status_override: str = Query("pending", description="Status for imported items (pending or indexed)"),
    _user: UserInfo = Depends(get_current_user),
):
    """Import a normalized bootstrap YAML file into the ingestion queue.

    Deduplicates by URI — existing items are skipped.
    """
    content = await file.read()
    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError as e:
        return {"ok": False, "error": f"YAML parse error: {e}"}

    items_list = data.get("items", [])
    if not items_list:
        return {"ok": False, "error": "No 'items' key found in YAML"}

    now = datetime.now(UTC)
    added = 0
    skipped = 0

    async with async_session() as session:
        for entry in items_list:
            uri = entry.get("uri", "").strip()
            if not uri:
                skipped += 1
                continue

            stmt = (
                pg_insert(IngestionItem)
                .values(
                    uri=uri,
                    handler=entry.get("handler"),
                    title=entry.get("title", ""),
                    domain=entry.get("domain", ""),
                    authority=entry.get("authority", "vetted"),
                    origin_type=entry.get("origin_type", "curated"),
                    tags=entry.get("tags"),
                    priority=entry.get("priority", 0),
                    config=entry.get("config"),
                    status=status_override,
                    queued_at=now if status_override == "pending" else None,
                )
                .on_conflict_do_nothing(index_elements=["uri"])
            )
            result = await session.execute(stmt)
            if result.rowcount > 0:  # type: ignore[union-attr]
                added += 1
            else:
                skipped += 1
        await session.commit()

    logger.info("bootstrap_import", extra={"added": added, "skipped": skipped, "file": file.filename})
    return {"ok": True, "added": added, "skipped": skipped, "total_in_file": len(items_list)}
