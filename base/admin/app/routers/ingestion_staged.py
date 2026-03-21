"""Staged S3 ingestion API: claim-fetch, documents, enrich queue (worker-facing)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..db.engine import async_session
from ..db.models import IngestionDocument, IngestionEnrichQueue, IngestionItem, IngestionSource
from ..internal_auth import require_service_or_platform_admin

logger = logging.getLogger("synesis.admin.ingestion_staged")

router = APIRouter(
    prefix="/api/v1/ingestion/staged",
    tags=["ingestion-staged"],
    dependencies=[Depends(require_service_or_platform_admin)],
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class StagedItemStatusBody(BaseModel):
    status: str = Field(
        ...,
        pattern="^(staged_raw|staged_norm|enrich_queued|indexed|failed|dead_letter|running|pending)$",
    )
    error_message: str | None = None
    indexer_stats: dict[str, Any] | None = None
    chunk_count: int | None = None
    content_hash: str | None = None
    milvus_doc_id: str | None = None


class DocumentRegisterRow(BaseModel):
    ingestion_item_id: int
    doc_key: str = Field(..., max_length=64)
    canonical_uri: str
    title: str = ""
    domain: str = ""
    handler: str = ""
    authority: str = "vetted"
    origin_type: str = "curated"
    tags: list[str] | None = None
    config_snapshot: dict[str, Any] | None = None
    raw_s3_keys: dict[str, Any]
    raw_content_hash: str | None = None
    raw_status: str = "done"


class DocumentsRegisterBody(BaseModel):
    documents: list[DocumentRegisterRow]


class NormalizeResultBody(BaseModel):
    norm_content_hash: str | None = None
    norm_s3_md_key: str | None = None
    norm_s3_meta_key: str | None = None
    norm_status: str = Field(default="done", pattern="^(done|failed)$")
    error_message: str | None = None
    norm_version: str = "v1"
    enrich_version: str = "v1"
    enqueue_enrich: bool = True


class EnrichClaimBody(BaseModel):
    limit: int = Field(default=8, ge=1, le=256)
    worker_id: str = "worker"


class EnrichStatusBody(BaseModel):
    status: str = Field(..., pattern="^(done|failed)$")
    error: str | None = None
    chunk_count: int | None = None
    milvus_doc_id: str | None = None


class ItemRerunBody(BaseModel):
    phase: str = Field(default="all", pattern="^(all|fetch|normalize|enrich)$")
    reset_retries: bool = True


class RecoverLeasesBody(BaseModel):
    stale_minutes: int = Field(default=30, ge=1, le=1440)


class DocumentEditBody(BaseModel):
    title: str | None = None
    domain: str | None = None
    authority: str | None = None
    origin_type: str | None = None
    tags: list[str] | None = None
    config_snapshot: dict[str, Any] | None = None


def _item_dict(r: IngestionItem) -> dict[str, Any]:
    from .ingestion import _item_dict as base_item_dict

    return base_item_dict(r)


# ---------------------------------------------------------------------------
# Claim fetch (mirror ingestion claim for staged workers)
# ---------------------------------------------------------------------------


@router.post("/items/claim-fetch")
async def claim_fetch(response: Response):
    """Claim next pending ingestion item for staged fetch (S3 raw)."""
    from sqlalchemy import text as sql_text

    async with async_session() as session:
        q = (
            select(IngestionItem)
            .where(
                or_(
                    IngestionItem.status == "pending",
                    (
                        (IngestionItem.status == "failed")
                        & (IngestionItem.retry_count < IngestionItem.max_retries)
                        & (
                            IngestionItem.completed_at
                            <= sql_text("NOW() - INTERVAL '1 minute' * POWER(2, COALESCE(retry_count, 0))")
                        )
                    ),
                )
            )
            .order_by(
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
async def update_staged_item_status(item_id: int, body: StagedItemStatusBody):
    """Update ingestion item after staged fetch / final reconcile."""
    now = datetime.now(UTC)
    final_status = ""
    async with async_session() as session:
        item = await session.get(IngestionItem, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="not_found")

        if body.error_message is not None:
            item.error_message = body.error_message[:2000]
        if body.indexer_stats is not None:
            item.indexer_stats = body.indexer_stats
        if body.chunk_count is not None:
            item.chunk_count = body.chunk_count
        if body.content_hash is not None:
            item.content_hash = body.content_hash
        if body.milvus_doc_id is not None:
            item.milvus_doc_id = body.milvus_doc_id

        if body.status == "failed":
            item.retry_count = (item.retry_count or 0) + 1
            if item.retry_count >= item.max_retries:
                item.status = "dead_letter"
            else:
                item.status = "failed"
            item.completed_at = now
        elif body.status == "indexed":
            item.status = "indexed"
            item.completed_at = now
        elif body.status in ("staged_raw", "staged_norm", "enrich_queued", "running"):
            item.status = body.status
            if body.status == "staged_raw":
                item.completed_at = None
        elif body.status == "pending":
            item.status = "pending"
            item.started_at = None
            item.completed_at = None
        elif body.status == "dead_letter":
            item.status = "dead_letter"
            item.completed_at = now
        else:
            item.status = body.status

        final_status = item.status
        await session.commit()
    return {"ok": True, "status": final_status}


@router.post("/items/{item_id}/rerun")
async def rerun_item(item_id: int, body: ItemRerunBody):
    """Reset an item to rerun all or a specific staged phase."""
    now = datetime.now(UTC)
    async with async_session() as session:
        item = await session.get(IngestionItem, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="not_found")

        docs = (
            await session.execute(
                select(IngestionDocument).where(IngestionDocument.ingestion_item_id == item_id)
            )
        ).scalars().all()
        doc_ids = [d.id for d in docs]
        queue_deleted = 0

        if body.phase in ("all", "fetch"):
            if doc_ids:
                qres = await session.execute(
                    delete(IngestionEnrichQueue).where(IngestionEnrichQueue.document_id.in_(doc_ids))
                )
                queue_deleted = int(qres.rowcount or 0)
                await session.execute(
                    delete(IngestionDocument).where(IngestionDocument.ingestion_item_id == item_id)
                )
            item.status = "pending"
            item.error_message = ""
            item.indexer_stats = None
            item.content_hash = None
            item.milvus_doc_id = ""
            item.chunk_count = 0
            item.started_at = None
            item.completed_at = None
            item.queued_at = now
            if body.reset_retries:
                item.retry_count = 0
            await session.commit()
            return {
                "ok": True,
                "phase": body.phase,
                "status": item.status,
                "documents_deleted": len(doc_ids),
                "queue_deleted": queue_deleted,
            }

        if not docs:
            raise HTTPException(status_code=400, detail="no_documents_for_item")

        if body.phase == "normalize":
            if doc_ids:
                qres = await session.execute(
                    delete(IngestionEnrichQueue).where(IngestionEnrichQueue.document_id.in_(doc_ids))
                )
                queue_deleted = int(qres.rowcount or 0)
            for d in docs:
                d.norm_status = "pending"
                d.norm_content_hash = None
                d.norm_s3_md_key = None
                d.norm_s3_meta_key = None
                d.normalized_at = None
                d.enrich_status = "pending"
                d.milvus_doc_id = ""
                d.chunk_count = 0
                d.error_message = ""
                d.updated_at = now
            item.status = "staged_raw"
            item.error_message = ""
            item.started_at = None
            item.completed_at = None
            item.chunk_count = 0
            item.milvus_doc_id = ""
            await session.commit()
            return {
                "ok": True,
                "phase": body.phase,
                "status": item.status,
                "documents_reset": len(docs),
                "queue_deleted": queue_deleted,
            }

        # phase == enrich
        if doc_ids:
            qres = await session.execute(
                delete(IngestionEnrichQueue).where(IngestionEnrichQueue.document_id.in_(doc_ids))
            )
            queue_deleted = int(qres.rowcount or 0)
        enqueued = 0
        for d in docs:
            if d.norm_status != "done":
                continue
            d.enrich_status = "pending"
            d.milvus_doc_id = ""
            d.chunk_count = 0
            d.error_message = ""
            d.updated_at = now
            await session.execute(
                pg_insert(IngestionEnrichQueue)
                .values(
                    document_id=d.id,
                    norm_version=d.norm_version or "v1",
                    enrich_version="v1",
                    priority=0,
                    status="pending",
                )
                .on_conflict_do_nothing(constraint="uq_ingestion_enrich_doc_version")
            )
            enqueued += 1
        item.status = "enrich_queued" if enqueued > 0 else "staged_norm"
        item.error_message = ""
        item.started_at = None
        item.completed_at = None
        item.chunk_count = 0
        item.milvus_doc_id = ""
        await session.commit()
        return {
            "ok": True,
            "phase": body.phase,
            "status": item.status,
            "documents_requeued": enqueued,
            "queue_deleted": queue_deleted,
        }


# ---------------------------------------------------------------------------
# Register raw documents (after S3 put)
# ---------------------------------------------------------------------------


@router.post("/documents/register")
async def register_documents(body: DocumentsRegisterBody):
    """Upsert ingestion_documents rows by doc_key (idempotent)."""
    now = datetime.now(UTC)
    async with async_session() as session:
        for row in body.documents:
            stmt = (
                pg_insert(IngestionDocument)
                .values(
                    ingestion_item_id=row.ingestion_item_id,
                    doc_key=row.doc_key[:64],
                    canonical_uri=row.canonical_uri,
                    title=row.title or "",
                    domain=row.domain or "",
                    handler=row.handler or "",
                    authority=row.authority or "vetted",
                    origin_type=row.origin_type or "curated",
                    tags=row.tags,
                    config_snapshot=row.config_snapshot,
                    raw_s3_keys=row.raw_s3_keys,
                    raw_content_hash=row.raw_content_hash,
                    raw_status=row.raw_status,
                    raw_fetched_at=now if row.raw_status == "done" else None,
                    updated_at=now,
                )
                .on_conflict_do_update(
                    index_elements=["doc_key"],
                    set_={
                        "title": row.title or "",
                        "domain": row.domain or "",
                        "raw_s3_keys": row.raw_s3_keys,
                        "raw_content_hash": row.raw_content_hash,
                        "raw_status": row.raw_status,
                        **(
                            {"raw_fetched_at": now}
                            if row.raw_status == "done"
                            else {}
                        ),
                        "updated_at": now,
                    },
                )
            )
            await session.execute(stmt)
        await session.commit()
    return {"ok": True, "count": len(body.documents)}


# ---------------------------------------------------------------------------
# Normalize workers
# ---------------------------------------------------------------------------


@router.post("/documents/claim-normalize")
async def claim_normalize(response: Response, limit: int = 8):
    """Claim up to `limit` documents ready for normalization (SKIP LOCKED)."""
    if limit < 1 or limit > 256:
        raise HTTPException(status_code=400, detail="limit must be 1..256")

    sql = text("""
        WITH picked AS (
            SELECT id FROM ingestion_documents
            WHERE raw_status = 'done' AND norm_status = 'pending'
            ORDER BY id
            LIMIT :lim
            FOR UPDATE SKIP LOCKED
        )
        UPDATE ingestion_documents AS d
        SET norm_status = 'running', updated_at = NOW()
        FROM picked
        WHERE d.id = picked.id
        RETURNING d.id, d.ingestion_item_id, d.doc_key, d.canonical_uri, d.title, d.domain,
                  d.handler, d.authority, d.origin_type, d.tags, d.config_snapshot,
                  d.raw_s3_keys, d.raw_content_hash, d.norm_version
    """)

    async with async_session() as session:
        result = await session.execute(sql, {"lim": limit})
        rows = result.mappings().all()
        await session.commit()

    if not rows:
        response.status_code = 204
        return None

    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "ingestion_item_id": r["ingestion_item_id"],
                "doc_key": r["doc_key"],
                "canonical_uri": r["canonical_uri"],
                "title": r["title"],
                "domain": r["domain"],
                "handler": r["handler"],
                "authority": r["authority"],
                "origin_type": r["origin_type"],
                "tags": r["tags"],
                "config_snapshot": r["config_snapshot"],
                "raw_s3_keys": r["raw_s3_keys"],
                "raw_content_hash": r["raw_content_hash"],
                "norm_version": r["norm_version"],
            }
        )
    return {"documents": out}


@router.get("/items/{item_id}/documents")
async def list_item_documents(item_id: int):
    async with async_session() as session:
        rows = (
            await session.execute(
                select(IngestionDocument)
                .where(IngestionDocument.ingestion_item_id == item_id)
                .order_by(IngestionDocument.id)
            )
        ).scalars().all()
    return {
        "documents": [
            {
                "id": d.id,
                "doc_key": d.doc_key,
                "canonical_uri": d.canonical_uri,
                "title": d.title,
                "domain": d.domain,
                "authority": d.authority,
                "origin_type": d.origin_type,
                "tags": d.tags,
                "config_snapshot": d.config_snapshot,
                "raw_status": d.raw_status,
                "norm_status": d.norm_status,
                "enrich_status": d.enrich_status,
                "norm_version": d.norm_version,
                "chunk_count": d.chunk_count,
                "error_message": d.error_message,
                "raw_s3_keys": d.raw_s3_keys,
                "norm_s3_md_key": d.norm_s3_md_key,
                "norm_s3_meta_key": d.norm_s3_meta_key,
                "updated_at": d.updated_at.isoformat() if d.updated_at else None,
            }
            for d in rows
        ]
    }


@router.patch("/documents/{document_id}")
async def edit_document(document_id: int, body: DocumentEditBody):
    now = datetime.now(UTC)
    async with async_session() as session:
        doc = await session.get(IngestionDocument, document_id)
        if not doc:
            raise HTTPException(status_code=404, detail="not_found")
        if body.title is not None:
            doc.title = body.title
        if body.domain is not None:
            doc.domain = body.domain
        if body.authority is not None:
            doc.authority = body.authority
        if body.origin_type is not None:
            doc.origin_type = body.origin_type
        if body.tags is not None:
            doc.tags = body.tags
        if body.config_snapshot is not None:
            doc.config_snapshot = body.config_snapshot
        doc.updated_at = now
        await session.commit()
    return {"ok": True, "document_id": document_id}


@router.patch("/documents/{document_id}/normalize-result")
async def normalize_result(document_id: int, body: NormalizeResultBody):
    now = datetime.now(UTC)
    async with async_session() as session:
        doc = await session.get(IngestionDocument, document_id)
        if not doc:
            raise HTTPException(status_code=404, detail="not_found")

        doc.norm_version = body.norm_version
        if body.norm_status == "done":
            doc.norm_status = "done"
            doc.norm_content_hash = body.norm_content_hash
            doc.norm_s3_md_key = body.norm_s3_md_key
            doc.norm_s3_meta_key = body.norm_s3_meta_key
            doc.normalized_at = now
            doc.error_message = ""
            if body.enqueue_enrich:
                await session.execute(
                    pg_insert(IngestionEnrichQueue)
                    .values(
                        document_id=doc.id,
                        norm_version=body.norm_version,
                        enrich_version=body.enrich_version,
                        priority=0,
                        status="pending",
                    )
                    .on_conflict_do_nothing(constraint="uq_ingestion_enrich_doc_version")
                )
        else:
            doc.norm_status = "failed"
            doc.error_message = (body.error_message or "normalize failed")[:2000]

        doc.updated_at = now
        await session.flush()

        # Advance parent item when all docs normalized for this norm_version
        item_id = doc.ingestion_item_id
        total = (
            await session.execute(
                select(func.count()).select_from(IngestionDocument).where(
                    IngestionDocument.ingestion_item_id == item_id,
                    IngestionDocument.raw_status == "done",
                )
            )
        ).scalar() or 0
        done_norm = (
            await session.execute(
                select(func.count()).select_from(IngestionDocument).where(
                    IngestionDocument.ingestion_item_id == item_id,
                    IngestionDocument.norm_status == "done",
                    IngestionDocument.norm_version == body.norm_version,
                )
            )
        ).scalar() or 0

        if total > 0 and done_norm >= total:
            item = await session.get(IngestionItem, item_id)
            if item and item.status in ("running", "staged_raw"):
                item.status = "staged_norm"

        await session.commit()

    return {"ok": True, "document_id": document_id, "norm_status": body.norm_status}


# ---------------------------------------------------------------------------
# Enrich queue (GPU worker)
# ---------------------------------------------------------------------------


@router.post("/enrich/claim")
async def claim_enrich(response: Response, body: EnrichClaimBody):
    sql = text("""
        WITH picked AS (
            SELECT id FROM ingestion_enrich_queue
            WHERE status = 'pending'
              AND document_id IN (
                  SELECT id FROM ingestion_documents WHERE norm_status = 'done'
              )
            ORDER BY priority DESC, id
            LIMIT :lim
            FOR UPDATE SKIP LOCKED
        )
        UPDATE ingestion_enrich_queue AS q
        SET status = 'running', started_at = NOW(), worker_id = :wid,
            attempts = q.attempts + 1
        FROM picked
        WHERE q.id = picked.id
        RETURNING q.id, q.document_id, q.norm_version, q.enrich_version, q.priority, q.attempts
    """)

    async with async_session() as session:
        result = await session.execute(sql, {"lim": body.limit, "wid": body.worker_id[:128]})
        rows = result.mappings().all()
        await session.commit()

    if not rows:
        response.status_code = 204
        return None

    jobs = [dict(r) for r in rows]
    doc_ids = list({j["document_id"] for j in jobs})
    async with async_session() as session:
        docs = (await session.execute(select(IngestionDocument).where(IngestionDocument.id.in_(doc_ids)))).scalars().all()
        by_id = {d.id: d for d in docs}
        item_ids = {d.ingestion_item_id for d in docs}

        items: dict[int, IngestionItem] = {}
        if item_ids:
            ir = (await session.execute(select(IngestionItem).where(IngestionItem.id.in_(item_ids)))).scalars().all()
            items = {i.id: i for i in ir}

    payload_jobs = []
    for j in jobs:
        d = by_id.get(j["document_id"])
        if not d:
            continue
        it = items.get(d.ingestion_item_id)
        eff_h = d.handler or (it.handler if it else "")
        eff_cfg = d.config_snapshot or (it.config if it else {}) or {}
        eff_dom = d.domain or (it.domain if it else "")
        eff_auth = d.authority or (it.authority if it else "vetted")
        eff_tags = d.tags or (it.tags if it else [])
        payload_jobs.append(
            {
                "job_id": j["id"],
                "document_id": d.id,
                "norm_version": j["norm_version"],
                "enrich_version": j["enrich_version"],
                "doc_key": d.doc_key,
                "norm_s3_md_key": d.norm_s3_md_key,
                "norm_s3_meta_key": d.norm_s3_meta_key,
                "ingestion_item_id": d.ingestion_item_id,
                "canonical_uri": d.canonical_uri,
                "title": d.title,
                "effective_handler": eff_h,
                "effective_config": eff_cfg if isinstance(eff_cfg, dict) else {},
                "effective_domain": eff_dom,
                "effective_authority": eff_auth,
                "effective_tags": list(eff_tags) if eff_tags else [],
                "origin_type": d.origin_type or (it.origin_type if it else "curated"),
            }
        )

    return {"jobs": payload_jobs}


@router.patch("/enrich/{job_id}/status")
async def enrich_job_status(job_id: int, body: EnrichStatusBody):
    now = datetime.now(UTC)
    async with async_session() as session:
        job = await session.get(IngestionEnrichQueue, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="not_found")

        doc = await session.get(IngestionDocument, job.document_id)
        if not doc:
            raise HTTPException(status_code=404, detail="document_not_found")

        if body.status == "done":
            job.status = "done"
            job.done_at = now
            job.error = ""
            doc.enrich_status = "done"
            if body.chunk_count is not None:
                doc.chunk_count = body.chunk_count
            if body.milvus_doc_id:
                doc.milvus_doc_id = body.milvus_doc_id[:128]
        else:
            job.status = "failed"
            job.done_at = now
            job.error = (body.error or "enrich failed")[:2000]
            doc.enrich_status = "failed"
            doc.error_message = job.error

        doc.updated_at = now
        await session.flush()

        item_id = doc.ingestion_item_id
        total_docs = (
            await session.execute(
                select(func.count()).select_from(IngestionDocument).where(
                    IngestionDocument.ingestion_item_id == item_id,
                    IngestionDocument.norm_status == "done",
                )
            )
        ).scalar() or 0
        done_enrich = (
            await session.execute(
                select(func.count()).select_from(IngestionDocument).where(
                    IngestionDocument.ingestion_item_id == item_id,
                    IngestionDocument.enrich_status == "done",
                )
            )
        ).scalar() or 0

        item = await session.get(IngestionItem, item_id)
        if item and total_docs > 0 and done_enrich >= total_docs:
            sum_chunks = (
                await session.execute(
                    select(func.coalesce(func.sum(IngestionDocument.chunk_count), 0)).where(
                        IngestionDocument.ingestion_item_id == item_id,
                    )
                )
            ).scalar()
            item.status = "indexed"
            item.chunk_count = int(sum_chunks or 0)
            item.completed_at = now
            item.error_message = ""
            first_mid = (
                await session.execute(
                    select(IngestionDocument.milvus_doc_id)
                    .where(IngestionDocument.ingestion_item_id == item_id)
                    .order_by(IngestionDocument.id)
                    .limit(1)
                )
            ).scalar()
            if first_mid:
                item.milvus_doc_id = (first_mid or "")[:128]

        await session.commit()

    return {"ok": True, "job_id": job_id, "status": body.status}


@router.post("/leases/recover")
async def recover_stale_leases(body: RecoverLeasesBody):
    """Recover stale running leases back to pending for normalize/enrich/items."""
    async with async_session() as session:
        running_docs_sql = text("""
            UPDATE ingestion_documents
            SET norm_status = 'pending',
                error_message = 'lease_recovered: normalize claim stale',
                updated_at = NOW()
            WHERE norm_status = 'running'
              AND updated_at < NOW() - (:mins::text || ' minutes')::interval
        """)
        running_enrich_sql = text("""
            UPDATE ingestion_enrich_queue
            SET status = 'pending',
                worker_id = '',
                started_at = NULL,
                error = 'lease_recovered: enrich claim stale'
            WHERE status = 'running'
              AND started_at IS NOT NULL
              AND started_at < NOW() - (:mins::text || ' minutes')::interval
        """)
        running_items_sql = text("""
            UPDATE ingestion_items
            SET status = 'pending',
                started_at = NULL,
                queued_at = NOW(),
                error_message = 'lease_recovered: item claim stale'
            WHERE status = 'running'
              AND started_at IS NOT NULL
              AND started_at < NOW() - (:mins::text || ' minutes')::interval
        """)
        docs_res = await session.execute(running_docs_sql, {"mins": body.stale_minutes})
        enrich_res = await session.execute(running_enrich_sql, {"mins": body.stale_minutes})
        items_res = await session.execute(running_items_sql, {"mins": body.stale_minutes})
        await session.commit()
    return {
        "ok": True,
        "stale_minutes": body.stale_minutes,
        "documents_recovered": int(docs_res.rowcount or 0),
        "enrich_jobs_recovered": int(enrich_res.rowcount or 0),
        "items_recovered": int(items_res.rowcount or 0),
    }
