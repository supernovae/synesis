"""RAG pipeline: corpus stats, quality, benchmarks."""

from __future__ import annotations

import contextlib
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, text

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import ContentPackConfig, ContentPackInstallJob
from ..deps import CATALOG_COLLECTION, QUALITY_REPORT_PATH
from ..internal_auth import ServicePrincipal, require_service_or_platform_admin
from ..rbac import RouteGroup, can_access_route_group
from ..services.admin_audit import record_admin_audit
from ..services.nornic_service import (
    collection_domain_hierarchy,
    collection_schema_info,
    collection_stats,
    expected_graph_schema_version,
    reported_graph_schema_version,
    safe_query,
)
from ..services.outbound_security import validate_public_https_url

logger = logging.getLogger("synesis.admin.rag")

router = APIRouter(prefix="/api/v1/rag", tags=["rag"])


def _ensure_org_observability(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_observability):
        raise HTTPException(status_code=403, detail="Requires route group access: org_observability")


def _ensure_org_content_admin(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_content_admin):
        raise HTTPException(status_code=403, detail="Requires route group access: org_content_admin")


def _load_quality_report() -> dict:
    if not QUALITY_REPORT_PATH:
        return {}
    p = Path(QUALITY_REPORT_PATH)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _drop_error_fields(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _drop_error_fields(v) for k, v in value.items() if k != "error"}
    if isinstance(value, list):
        return [_drop_error_fields(v) for v in value]
    return value


def _sanitize_schema_info(schema: Any) -> dict[str, Any]:
    if not isinstance(schema, dict):
        return {"exists": False, "fields": [], "indexes": []}
    exists = bool(schema.get("exists", False))
    fields = schema.get("fields")
    indexes = schema.get("indexes")
    node_labels = schema.get("node_labels")
    edge_types = schema.get("edge_types")
    vector_indexes = schema.get("vector_indexes")
    return {
        "exists": exists,
        "fields": fields if isinstance(fields, list) else [],
        "indexes": indexes if isinstance(indexes, list) else [],
        "node_labels": node_labels if isinstance(node_labels, list) else [],
        "edge_types": edge_types if isinstance(edge_types, list) else [],
        "vector_indexes": vector_indexes if isinstance(vector_indexes, list) else [],
    }


_SHA256_RE = re.compile(r"^[a-fA-F0-9]{64}$")
_CATALOG_TIMEOUT_SECONDS = 20.0
_CATALOG_MAX_BYTES = 2 * 1024 * 1024


class ContentPackCatalogConfigBody(BaseModel):
    catalog_url: str = Field("", max_length=2048)


class ContentPackInstallBody(BaseModel):
    pack_id: str = Field(..., min_length=1, max_length=96)
    version: str = Field("", max_length=64)
    replace: bool = False


class ContentPackJobStatusBody(BaseModel):
    status: str = Field(..., pattern="^(installed|failed)$")
    result: dict[str, Any] | None = None
    error_message: str = ""


def _validate_https_url(value: str, *, field_name: str = "url") -> str:
    return validate_public_https_url(value, field_name=field_name)


def _content_pack_config_dict(config: ContentPackConfig | None) -> dict[str, Any]:
    return {
        "catalog_url": config.catalog_url if config else "",
        "updated_by": config.updated_by if config else "",
        "updated_at": config.updated_at.isoformat() if config and config.updated_at else None,
    }


def _content_pack_job_dict(job: ContentPackInstallJob) -> dict[str, Any]:
    return {
        "id": job.id,
        "pack_id": job.pack_id,
        "pack_version": job.pack_version,
        "catalog_url": job.catalog_url,
        "download_url": job.download_url,
        "sha256": job.sha256,
        "size_bytes": job.size_bytes,
        "replace_existing": job.replace_existing,
        "status": job.status,
        "requested_by": job.requested_by,
        "claimed_by": job.claimed_by,
        "result": job.result,
        "error_message": job.error_message,
        "attempt_count": job.attempt_count,
        "max_attempts": job.max_attempts,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
    }


def _normalize_catalog_entry(raw: Any, index: int) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(raw, dict):
        return None, f"packs[{index}] must be an object"
    pack_id = str(raw.get("pack_id") or raw.get("id") or "").strip().lower()
    pack_id = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in pack_id).strip("-_")[:96]
    if not pack_id:
        return None, f"packs[{index}] missing pack_id"
    version = str(raw.get("version") or raw.get("pack_version") or "").strip()[:64]
    download_url = str(raw.get("download_url") or raw.get("url") or "").strip()
    try:
        download_url = _validate_https_url(download_url, field_name=f"packs[{index}].download_url")
    except HTTPException as exc:
        return None, str(exc.detail)
    sha256 = str(raw.get("sha256") or raw.get("artifact_sha256") or "").strip().lower()
    if not _SHA256_RE.match(sha256):
        return None, f"packs[{index}] must include a sha256 checksum"
    try:
        size_bytes = max(0, int(raw.get("size_bytes", 0) or 0))
    except Exception:
        return None, f"packs[{index}].size_bytes must be an integer"
    tags = raw.get("tags")
    if not isinstance(tags, list):
        tags = []
    entry = {
        "pack_id": pack_id,
        "name": str(raw.get("name") or pack_id)[:256],
        "description": str(raw.get("description") or "")[:4000],
        "version": version,
        "download_url": download_url,
        "sha256": sha256,
        "size_bytes": size_bytes,
        "domain": str(raw.get("domain") or "")[:128],
        "language": str(raw.get("language") or "")[:64],
        "tags": [str(t).strip()[:64] for t in tags if str(t).strip()][:32],
        "created_at": raw.get("created_at") or "",
        "requires_synesis_version": str(raw.get("requires_synesis_version") or "")[:64],
        "schema_version": raw.get("schema_version") or raw.get("content_graph_schema_version"),
    }
    return entry, None


async def _fetch_catalog(catalog_url: str) -> dict[str, Any]:
    url = _validate_https_url(catalog_url, field_name="catalog_url")
    try:
        async with httpx.AsyncClient(timeout=_CATALOG_TIMEOUT_SECONDS, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            if resp.url.scheme != "https":
                raise HTTPException(status_code=400, detail="Content pack catalog redirected to a non-https URL")
            content = resp.content
    except httpx.HTTPError as exc:
        logger.warning("content_pack_catalog_fetch_failed", exc_info=True)
        raise HTTPException(status_code=502, detail="Could not fetch content pack catalog") from exc
    if len(content) > _CATALOG_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Content pack catalog is too large")
    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Content pack catalog is not valid JSON: {exc}") from exc
    raw_packs = data.get("packs") if isinstance(data, dict) else data
    if not isinstance(raw_packs, list):
        raise HTTPException(status_code=400, detail="Content pack catalog must contain a packs array")
    packs: list[dict[str, Any]] = []
    errors: list[str] = []
    seen: set[tuple[str, str]] = set()
    for idx, raw in enumerate(raw_packs):
        entry, error = _normalize_catalog_entry(raw, idx)
        if error:
            errors.append(error)
            continue
        if entry is None:
            errors.append(f"pack entry {idx} could not be parsed")
            continue
        key = (entry["pack_id"], entry["version"])
        if key in seen:
            errors.append(f"duplicate pack entry: {entry['pack_id']}@{entry['version']}")
            continue
        seen.add(key)
        packs.append(entry)
    return {
        "catalog_url": url,
        "name": data.get("name", "") if isinstance(data, dict) else "",
        "version": data.get("version", "") if isinstance(data, dict) else "",
        "packs": packs,
        "errors": errors,
        "ok": not errors,
    }


def _installed_doc_packs() -> list[dict[str, Any]]:
    rows = safe_query(
        CATALOG_COLLECTION,
        filter_expr='pack_id != ""',
        output_fields=[
            "pack_id",
            "pack_version",
            "pack_source_version",
            "language",
            "domain",
            "pack_artifact_hash",
        ],
        limit=16384,
    )
    packs: dict[str, dict[str, Any]] = {}
    for row in rows:
        pack_id = str(row.get("pack_id") or "global")
        entry = packs.setdefault(
            pack_id,
            {
                "pack_id": pack_id,
                "pack_version": row.get("pack_version", ""),
                "pack_source_version": row.get("pack_source_version", ""),
                "language": row.get("language", ""),
                "domain": row.get("domain", ""),
                "pack_artifact_hash": row.get("pack_artifact_hash", ""),
                "row_count": 0,
            },
        )
        entry["row_count"] += 1
    return sorted(packs.values(), key=lambda item: str(item["pack_id"]))


@router.get("/corpus")
async def corpus_overview(_user: UserInfo = Depends(get_current_user)):
    _ensure_org_observability(_user)
    from ..db.engine import async_session as _async_session
    from ..db.models import GraphSchemaSync

    schema_version = 0
    try:
        async with _async_session() as session:
            from sqlalchemy import select as _select

            row = (
                await session.execute(_select(GraphSchemaSync).where(GraphSchemaSync.collection == CATALOG_COLLECTION))
            ).scalar_one_or_none()
            if row:
                schema_version = row.schema_version
    except Exception:
        logger.debug("corpus_overview_schema_version_read_failed", exc_info=True)
    if schema_version <= 0:
        schema_version = reported_graph_schema_version()

    expected_sv = expected_graph_schema_version()
    schema_upgrade_pending = schema_version < expected_sv

    try:
        stats = collection_stats(CATALOG_COLLECTION)
        meta_rows = safe_query(
            CATALOG_COLLECTION,
            output_fields=["domain", "doc_id", "document_name"],
            limit=16384,
        )
        unique_domains = len({r.get("domain", "") for r in meta_rows if r.get("domain")})
        unique_docs = len({r.get("doc_id", "") for r in meta_rows if r.get("doc_id")})
        unique_sources = len({r.get("document_name", "") for r in meta_rows if r.get("document_name")})
        return {
            "collection": CATALOG_COLLECTION,
            "total_chunks": int(stats.get("row_count", 0) or 0),
            "total_documents": unique_docs,
            "total_sources": unique_sources,
            "domains_covered": unique_domains,
            "schema_version": schema_version,
            "expected_schema_version": expected_sv,
            "schema_upgrade_pending": schema_upgrade_pending,
        }
    except Exception:
        logger.warning("corpus_overview_failed", exc_info=True)
        return {
            "collection": CATALOG_COLLECTION,
            "total_chunks": 0,
            "total_documents": 0,
            "total_sources": 0,
            "domains_covered": 0,
            "schema_version": schema_version,
            "expected_schema_version": expected_sv,
            "schema_upgrade_pending": schema_upgrade_pending,
        }


@router.get("/corpus/schema")
async def corpus_schema(_user: UserInfo = Depends(get_current_user)):
    """Content graph collection schema: fields, indexes, domain->source hierarchy."""
    _ensure_org_observability(_user)
    try:
        schema = collection_schema_info(CATALOG_COLLECTION)
        hierarchy = collection_domain_hierarchy(CATALOG_COLLECTION)
        return {
            "collection": CATALOG_COLLECTION,
            "schema": _sanitize_schema_info(schema),
            "hierarchy": _drop_error_fields(hierarchy),
        }
    except Exception:
        logger.warning("corpus_schema_failed", exc_info=True)
        return {"collection": CATALOG_COLLECTION, "schema": {"exists": False}, "hierarchy": []}


@router.get("/content-packs/config")
async def content_pack_config(_user: UserInfo = Depends(get_current_user)):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        row = await session.get(ContentPackConfig, 1)
    return _content_pack_config_dict(row)


@router.put("/content-packs/config")
async def update_content_pack_config(
    body: ContentPackCatalogConfigBody,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    catalog_url = _validate_https_url(body.catalog_url, field_name="catalog_url") if body.catalog_url.strip() else ""
    async with async_session() as session:
        row = await session.get(ContentPackConfig, 1)
        if row is None:
            row = ContentPackConfig(id=1)
            session.add(row)
        row.catalog_url = catalog_url
        row.updated_by = _user.email or _user.username or _user.user_id
        await session.commit()
        await session.refresh(row)
    await record_admin_audit(
        user=_user,
        action="rag.content_pack_config.update",
        status="success",
        summary="Updated RAG content pack catalog URL",
        detail={"catalog_url": catalog_url},
    )
    return _content_pack_config_dict(row)


@router.get("/content-packs/catalog")
async def content_pack_catalog(_user: UserInfo = Depends(get_current_user)):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        config = await session.get(ContentPackConfig, 1)
    catalog_url = config.catalog_url if config else ""
    if not catalog_url:
        return {"catalog_url": "", "packs": [], "errors": ["No content pack catalog URL configured"], "ok": False}
    return await _fetch_catalog(catalog_url)


@router.get("/content-packs")
async def content_packs_overview(_user: UserInfo = Depends(get_current_user)):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        config = await session.get(ContentPackConfig, 1)
        jobs = (
            (await session.execute(select(ContentPackInstallJob).order_by(ContentPackInstallJob.id.desc()).limit(50)))
            .scalars()
            .all()
        )

    catalog_url = config.catalog_url if config else ""
    catalog: dict[str, Any] = {"catalog_url": catalog_url, "packs": [], "errors": [], "ok": False}
    if catalog_url:
        try:
            catalog = await _fetch_catalog(catalog_url)
        except HTTPException as exc:
            catalog["errors"] = [str(exc.detail)]

    installed = _installed_doc_packs()
    installed_by_id = {str(p["pack_id"]): p for p in installed}
    available = []
    for pack in catalog.get("packs", []):
        installed_pack = installed_by_id.get(str(pack["pack_id"]))
        installed_version = str((installed_pack or {}).get("pack_version") or "")
        status = "not_installed"
        if installed_pack and installed_version == str(pack.get("version") or ""):
            status = "installed"
        elif installed_pack:
            status = "update_available"
        available.append({**pack, "install_status": status, "installed": installed_pack})
    return {
        "config": _content_pack_config_dict(config),
        "catalog": {**catalog, "packs": available},
        "installed": installed,
        "jobs": [_content_pack_job_dict(job) for job in jobs],
    }


@router.post("/content-packs/install")
async def install_content_pack(
    body: ContentPackInstallBody,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        config = await session.get(ContentPackConfig, 1)
    if not config or not config.catalog_url:
        raise HTTPException(status_code=400, detail="No content pack catalog URL configured")
    catalog = await _fetch_catalog(config.catalog_url)
    candidates = [
        p
        for p in catalog.get("packs", [])
        if p["pack_id"] == body.pack_id.strip().lower()
        and (not body.version.strip() or p["version"] == body.version.strip())
    ]
    if not candidates:
        raise HTTPException(status_code=404, detail="Pack not found in configured catalog")
    selected = candidates[0]
    now = datetime.now(UTC)
    async with async_session() as session:
        job = ContentPackInstallJob(
            pack_id=selected["pack_id"],
            pack_version=selected["version"],
            catalog_url=config.catalog_url,
            download_url=selected["download_url"],
            sha256=selected["sha256"],
            size_bytes=selected["size_bytes"],
            replace_existing=body.replace,
            status="pending",
            requested_by=_user.email or _user.username or _user.user_id,
            created_at=now,
        )
        session.add(job)
        await session.commit()
        await session.refresh(job)
    await record_admin_audit(
        user=_user,
        action="rag.content_pack.install",
        status="success",
        summary=f"Queued RAG content pack install for {selected['pack_id']}@{selected['version']}",
        detail={"pack_id": selected["pack_id"], "version": selected["version"], "replace": body.replace},
    )
    return {"ok": True, "job": _content_pack_job_dict(job)}


@router.get("/content-packs/install-jobs")
async def content_pack_install_jobs(
    limit: int = Query(50, ge=1, le=200),
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        rows = (
            (
                await session.execute(
                    select(ContentPackInstallJob).order_by(ContentPackInstallJob.id.desc()).limit(limit)
                )
            )
            .scalars()
            .all()
        )
    return {"jobs": [_content_pack_job_dict(job) for job in rows]}


@router.post("/content-packs/install-jobs/{job_id}/retry")
async def retry_content_pack_install_job(
    job_id: int,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        job = await session.get(ContentPackInstallJob, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Content pack install job not found")
        if job.status == "running":
            raise HTTPException(status_code=409, detail="Cannot retry a running content pack install")
        job.status = "pending"
        job.error_message = ""
        job.claimed_by = ""
        job.started_at = None
        job.completed_at = None
        job.attempt_count = 0
        await session.commit()
        await session.refresh(job)
    await record_admin_audit(
        user=_user,
        action="rag.content_pack.retry",
        status="success",
        summary=f"Retried RAG content pack install job {job_id}",
        detail={"job_id": job_id},
    )
    return {"ok": True, "job": _content_pack_job_dict(job)}


@router.post("/content-packs/install-jobs/claim")
async def claim_content_pack_install_job(
    response: Response,
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    status_clause = or_(
        ContentPackInstallJob.status == "pending",
        (
            (ContentPackInstallJob.status == "failed")
            & (ContentPackInstallJob.attempt_count < ContentPackInstallJob.max_attempts)
            & (
                ContentPackInstallJob.completed_at
                <= text("NOW() - INTERVAL '1 minute' * POWER(2, COALESCE(attempt_count, 0))")
            )
        ),
    )
    async with async_session() as session:
        job = (
            (
                await session.execute(
                    select(ContentPackInstallJob)
                    .where(status_clause)
                    .order_by(
                        (ContentPackInstallJob.status == "pending").desc(),
                        ContentPackInstallJob.created_at,
                    )
                    .limit(1)
                    .with_for_update(skip_locked=True)
                )
            )
            .scalars()
            .first()
        )
        if job is None:
            response.status_code = 204
            return None
        job.status = "running"
        job.started_at = datetime.now(UTC)
        job.completed_at = None
        job.error_message = ""
        job.claimed_by = getattr(_principal, "service", "") or getattr(_principal, "username", "admin")
        await session.commit()
        await session.refresh(job)
    return _content_pack_job_dict(job)


@router.patch("/content-packs/install-jobs/{job_id}/status")
async def update_content_pack_install_job_status(
    job_id: int,
    body: ContentPackJobStatusBody,
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    del _principal
    async with async_session() as session:
        job = await session.get(ContentPackInstallJob, job_id)
        if not job:
            return {"ok": False, "error": "not_found"}
        job.completed_at = datetime.now(UTC)
        if body.status == "installed":
            job.status = "installed"
            job.result = body.result or {}
            job.error_message = ""
        else:
            job.attempt_count = (job.attempt_count or 0) + 1
            job.error_message = body.error_message[:2000] or "content pack install failed"
            job.status = "dead_letter" if job.attempt_count >= job.max_attempts else "failed"
        await session.commit()
        await session.refresh(job)
    return {"ok": True, "job": _content_pack_job_dict(job)}


@router.get("/packs")
async def list_doc_packs(_user: UserInfo = Depends(get_current_user)):
    """List installed SynPack partitions from Content graph catalog metadata."""
    _ensure_org_observability(_user)
    return {"packs": _installed_doc_packs()}


@router.get("/quality")
async def quality_summary(_user: UserInfo = Depends(get_current_user)):
    """Quality summary — try DB snapshots first, fall back to JSON file."""
    _ensure_org_observability(_user)
    try:
        from sqlalchemy import select
        from sqlalchemy.orm import aliased

        from ..db.engine import async_session
        from ..db.models import QualitySnapshot

        async with async_session() as session:
            # Window-based latest-per-domain: pick the newest scored_at per domain.
            sub = select(
                QualitySnapshot.id,
                func.row_number()
                .over(partition_by=QualitySnapshot.domain, order_by=QualitySnapshot.scored_at.desc())
                .label("rn"),
            ).subquery()
            qs = aliased(QualitySnapshot)
            rows = (
                (
                    await session.execute(
                        select(qs).join(sub, qs.id == sub.c.id).where(sub.c.rn == 1).order_by(qs.domain)
                    )
                )
                .scalars()
                .all()
            )
            if rows:
                scorecards = []
                counts: dict[str, int] = {"strong": 0, "adequate": 0, "weak": 0, "empty": 0}
                for r in rows:
                    h = r.health
                    counts[h] = counts.get(h, 0) + 1
                    scorecards.append(
                        {
                            "domain": r.domain,
                            "health": r.health,
                            "chunk_count": r.chunk_count,
                            "doc_count": r.doc_count,
                            "freshness_pct": r.freshness_pct,
                            "authority_mix": r.authority_mix,
                            "dead_weight_count": r.dead_weight_count,
                            "scored_at": r.scored_at.isoformat() if r.scored_at else None,
                            "raw_scorecard": r.raw_scorecard if hasattr(r, "raw_scorecard") else None,
                        }
                    )
                return {**counts, "scorecards": scorecards}
    except Exception:
        logger.debug("quality_db_read_failed", exc_info=True)

    report = _load_quality_report()
    summary = report.get("summary", {})
    scorecards = report.get("scorecards", [])
    return {
        "strong": summary.get("strong", 0),
        "adequate": summary.get("adequate", 0),
        "weak": summary.get("weak", 0),
        "empty": summary.get("empty", 0),
        "scorecards": scorecards,
    }


@router.post("/quality/refresh")
async def quality_refresh(_user: UserInfo = Depends(get_current_user)):
    """Compute per-domain health scores from NornicDB Content graph and store in quality_snapshots."""
    _ensure_org_content_admin(_user)
    try:
        hierarchy = collection_domain_hierarchy(CATALOG_COLLECTION)
    except Exception:
        logger.warning("quality_refresh_hierarchy_failed", exc_info=True)
        hierarchy = []
    if not hierarchy:
        return {"ok": False, "error": "no corpus data"}

    from datetime import datetime

    from ..db.engine import async_session
    from ..db.models import QualitySnapshot

    now = datetime.now(UTC)
    snapshots = []
    for entry in hierarchy:
        domain = entry["domain"]
        chunk_count = entry["total_chunks"]
        sources = entry.get("sources", [])
        doc_count = len(sources)

        authority_mix: dict[str, int] = {}
        fresh_count = 0
        domain_rows = safe_query(
            CATALOG_COLLECTION,
            filter_expr=f'domain == "{domain}"',
            output_fields=["domain", "authority", "effective_at_epoch", "crawl_timestamp"],
            limit=16384,
        )
        for row in domain_rows:
            auth = row.get("authority", "unknown") or "unknown"
            authority_mix[auth] = authority_mix.get(auth, 0) + 1
            if _compute_freshness(row) >= 0.5:
                fresh_count += 1

        freshness_pct = round(fresh_count / max(len(domain_rows), 1) * 100, 1)

        if chunk_count == 0:
            health = "empty"
        elif chunk_count < 10:
            health = "weak"
        elif chunk_count < 50:
            health = "adequate"
        else:
            health = "strong"

        snapshots.append(
            QualitySnapshot(
                domain=domain,
                health=health,
                chunk_count=chunk_count,
                doc_count=doc_count,
                freshness_pct=freshness_pct,
                authority_mix=authority_mix,
                dead_weight_count=0,
                scored_at=now,
            )
        )

    try:
        async with async_session() as session:
            session.add_all(snapshots)
            await session.commit()
    except Exception:
        logger.warning("quality_refresh_persist_failed", exc_info=True)
        return {"ok": False, "error": "persist failed"}

    counts = {"strong": 0, "adequate": 0, "weak": 0, "empty": 0}
    for s in snapshots:
        counts[s.health] = counts.get(s.health, 0) + 1

    return {"ok": True, "domains": len(snapshots), "summary": counts}


@router.post("/quality/import-report")
async def quality_import_report(
    body: dict,
    _user: UserInfo = Depends(get_current_user),
):
    """Import a corpus audit JSON report into ``quality_snapshots``.

    Accepts the same shape as ``corpus_audit_report.json``:
    ``{"summary": {...}, "scorecards": [...]}``.  Each scorecard is
    persisted as a ``QualitySnapshot`` row with the full scorecard
    stored in ``raw_scorecard`` so that domain-detail pages get
    MRR / hit-rate / dead-weight data without needing the JSON file.
    """
    _ensure_org_content_admin(_user)
    from datetime import datetime

    from ..db.engine import async_session
    from ..db.models import QualitySnapshot

    scorecards = body.get("scorecards", [])
    if not scorecards:
        return {"ok": False, "error": "no scorecards in payload"}

    now = datetime.now(UTC)
    snapshots = []
    for sc in scorecards:
        domain = sc.get("domain", "")
        if not domain:
            continue
        inv = sc.get("inventory", {})
        cov = sc.get("coverage", {})
        dw = sc.get("dead_weight", {})

        health = sc.get("health", "unknown")
        chunk_count = inv.get("total_chunks", 0)
        doc_count = inv.get("total_documents", 0)
        freshness_pct = round(float(cov.get("hit_rate", 0)) * 100, 2)
        dead_weight_count = dw.get("unretrieved_documents", 0)

        snapshots.append(
            QualitySnapshot(
                domain=domain,
                health=health,
                chunk_count=chunk_count,
                doc_count=doc_count,
                freshness_pct=freshness_pct,
                authority_mix=sc.get("authority_mix", {}),
                dead_weight_count=dead_weight_count,
                raw_scorecard=sc,
                scored_at=now,
            )
        )

    try:
        async with async_session() as session:
            session.add_all(snapshots)
            await session.commit()
    except Exception:
        logger.warning("quality_import_report_failed", exc_info=True)
        return {"ok": False, "error": "persist failed"}

    return {"ok": True, "imported": len(snapshots)}


@router.get("/quality/domains")
async def quality_domains(
    _user: UserInfo = Depends(get_current_user),
    health: str = Query("", description="Filter by health"),
    sort: str = Query("domain", description="Sort field"),
):
    _ensure_org_observability(_user)
    report = _load_quality_report()
    scorecards = report.get("scorecards", [])

    if not scorecards:
        try:
            from sqlalchemy import select
            from sqlalchemy.orm import aliased

            from ..db.engine import async_session
            from ..db.models import QualitySnapshot

            async with async_session() as session:
                sub = select(
                    QualitySnapshot.id,
                    func.row_number()
                    .over(
                        partition_by=QualitySnapshot.domain,
                        order_by=QualitySnapshot.scored_at.desc(),
                    )
                    .label("rn"),
                ).subquery()
                qs = aliased(QualitySnapshot)
                rows = (
                    (await session.execute(select(qs).join(sub, qs.id == sub.c.id).where(sub.c.rn == 1)))
                    .scalars()
                    .all()
                )
                scorecards = [_scorecard_from_snapshot(r) for r in rows]
        except Exception:
            logger.debug("quality_domains_db_fallback_failed", exc_info=True)

    if health:
        scorecards = [s for s in scorecards if s.get("health") == health]
    with contextlib.suppress(Exception):
        scorecards.sort(key=lambda s: s.get(sort, ""))
    return {"domains": scorecards}


def _scorecard_from_snapshot(row: Any) -> dict:
    """Shape stored Content graph-derived snapshots for the Domain Health React page.

    If the snapshot carries a ``raw_scorecard`` (imported audit JSON), we merge
    that data so the UI can surface MRR, hit-rate, and dead-weight samples even
    without the JSON file mounted.
    """
    base: dict[str, Any] = {
        "domain": row.domain,
        "path": "",
        "health": row.health,
        "inventory": {
            "total_chunks": row.chunk_count,
            "total_documents": row.doc_count,
        },
        "coverage": {
            "hit_rate": (row.freshness_pct or 0.0) / 100.0,
            "mean_mrr": 0.0,
        },
        "dead_weight": {"unretrieved_documents": row.dead_weight_count},
        "authority_mix": row.authority_mix or {},
        "scored_at": row.scored_at.isoformat() if getattr(row, "scored_at", None) else None,
        "source": "quality_snapshots",
    }
    raw = getattr(row, "raw_scorecard", None)
    if raw and isinstance(raw, dict):
        base["coverage"] = raw.get("coverage", base["coverage"])
        base["dead_weight"] = raw.get("dead_weight", base["dead_weight"])
        if raw.get("inventory"):
            base["inventory"] = raw["inventory"]
    return base


@router.get("/quality/domains/{key}")
async def quality_domain_detail(
    key: str,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_observability(_user)
    report = _load_quality_report()
    for sc in report.get("scorecards", []):
        if sc.get("domain") == key:
            return sc
    try:
        from sqlalchemy import select

        from ..db.engine import async_session
        from ..db.models import QualitySnapshot

        async with async_session() as session:
            row = (
                (
                    await session.execute(
                        select(QualitySnapshot)
                        .where(QualitySnapshot.domain == key)
                        .order_by(QualitySnapshot.scored_at.desc())
                        .limit(1)
                    )
                )
                .scalars()
                .first()
            )
        if row is not None:
            return _scorecard_from_snapshot(row)
    except Exception:
        logger.debug("quality_domain_db_read_failed", exc_info=True)

    return {"domain": key, "health": "unknown", "inventory": {}, "coverage": {}, "dead_weight": {}}


@router.get("/benchmarks")
async def benchmarks(_user: UserInfo = Depends(get_current_user)):
    """Return latest benchmark results — try DB first, fall back to JSON file."""
    _ensure_org_observability(_user)
    try:
        from sqlalchemy import select

        from ..db.engine import async_session
        from ..db.models import BenchmarkResult

        async with async_session() as session:
            row = (
                await session.execute(
                    select(BenchmarkResult)
                    .where(BenchmarkResult.completed_at.isnot(None))
                    .order_by(BenchmarkResult.started_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if row and row.metrics:
                return {
                    "aggregate": row.metrics,
                    "per_query": row.per_query or [],
                    "run_id": row.run_id,
                    "benchmark_type": row.benchmark_type,
                    "backend": "nornicdb",
                    "triggered_by": row.triggered_by,
                    "started_at": row.started_at.isoformat() if row.started_at else None,
                }
    except Exception:
        logger.debug("benchmark_db_read_failed", exc_info=True)

    p = Path("benchmarks/retrieval/results_hybrid.json")
    if not p.exists():
        return {"aggregate": {}, "per_query": []}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {"aggregate": {}, "per_query": []}


@router.get("/benchmarks/history")
async def benchmark_history(
    _user: UserInfo = Depends(get_current_user),
    limit: int = Query(10, ge=1, le=50),
):
    """List recent benchmark runs."""
    _ensure_org_observability(_user)
    try:
        from sqlalchemy import select

        from ..db.engine import async_session
        from ..db.models import BenchmarkResult

        async with async_session() as session:
            rows = (
                (
                    await session.execute(
                        select(BenchmarkResult).order_by(BenchmarkResult.started_at.desc()).limit(limit)
                    )
                )
                .scalars()
                .all()
            )
            return {
                "runs": [
                    {
                        "run_id": r.run_id,
                        "benchmark_type": r.benchmark_type,
                        "triggered_by": r.triggered_by,
                        "started_at": r.started_at.isoformat() if r.started_at else None,
                        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
                        "aggregate": r.metrics or {},
                    }
                    for r in rows
                ]
            }
    except Exception:
        return {"runs": []}


@router.post("/benchmarks/import")
async def benchmark_import(
    body: dict,
    _user: UserInfo = Depends(get_current_user),
):
    """Import a full regression benchmark result (e.g. from ``bench_hybrid.py``).

    Accepts ``{"run_id": "...", "aggregate": {...}, "per_query": [...]}``.
    """
    _ensure_org_content_admin(_user)
    import hashlib
    import time as _time
    from datetime import datetime

    from ..db.engine import async_session
    from ..db.models import BenchmarkResult

    run_id = body.get("run_id") or hashlib.sha256(f"bench-{_time.time()}".encode()).hexdigest()[:16]
    now = datetime.now(UTC)
    try:
        async with async_session() as session:
            session.add(
                BenchmarkResult(
                    run_id=run_id,
                    benchmark_type="regression",
                    metrics=body.get("aggregate", {}),
                    per_query=body.get("per_query", []),
                    triggered_by=_user.username,
                    started_at=now,
                    completed_at=datetime.now(UTC),
                )
            )
            await session.commit()
    except Exception:
        logger.warning("benchmark_import_failed", exc_info=True)
        return {"ok": False, "error": "persist failed"}
    return {"ok": True, "run_id": run_id, "benchmark_type": "regression"}


@router.post("/benchmarks/run")
async def benchmark_run(_user: UserInfo = Depends(get_current_user)):
    """Trigger a lightweight connectivity benchmark (quick probe).

    This is NOT the full regression benchmark from ``bench_hybrid.py``.
    For full benchmarks, use ``POST /benchmarks/import`` or run the
    quality-runner CronJob.
    """
    _ensure_org_content_admin(_user)
    import hashlib
    import time as _time
    from datetime import datetime

    from ..db.engine import async_session
    from ..db.models import BenchmarkResult

    run_id = hashlib.sha256(f"bench-{_time.time()}".encode()).hexdigest()[:16]
    now = datetime.now(UTC)

    test_queries = [
        "How does NornicDB support graph-native retrieval with metadata filtering?",
        "What is the best graph-native architecture for production RAG systems?",
        "How does LangGraph implement multi-agent orchestration?",
        "What are the tradeoffs between BM25 and dense retrieval?",
        "How to deploy vLLM on Kubernetes with GPU sharing?",
    ]

    per_query = []
    total_hits = 0
    total_time = 0.0

    for q in test_queries:
        start = _time.time()
        results = safe_query(
            CATALOG_COLLECTION,
            output_fields=["chunk_id", "id", "text", "domain", "authority", "doc_id"],
            limit=10,
        )
        elapsed = (_time.time() - start) * 1000
        total_time += elapsed
        hits = len(results)
        total_hits += hits
        per_query.append(
            {
                "query": q,
                "hits": hits,
                "latency_ms": round(elapsed, 1),
            }
        )

    aggregate = {
        "total_queries": len(test_queries),
        "avg_hits": round(total_hits / max(len(test_queries), 1), 1),
        "avg_latency_ms": round(total_time / max(len(test_queries), 1), 1),
        "p95_ms": round(
            sorted([p["latency_ms"] for p in per_query])[int(len(per_query) * 0.95)] if per_query else 0, 1
        ),
    }

    try:
        async with async_session() as session:
            session.add(
                BenchmarkResult(
                    run_id=run_id,
                    benchmark_type="nornicdb_lightweight",
                    metrics=aggregate,
                    per_query=per_query,
                    triggered_by=_user.username,
                    started_at=now,
                    completed_at=datetime.now(UTC),
                )
            )
            await session.commit()
    except Exception:
        logger.warning("benchmark_persist_failed", exc_info=True)

    return {
        "ok": True,
        "run_id": run_id,
        "backend": "nornicdb",
        "benchmark_type": "nornicdb_lightweight",
        "aggregate": aggregate,
        "per_query": per_query,
    }


# ---------------------------------------------------------------------------
# Review Queue — surface flagged/unscanned chunks for human vetting
# ---------------------------------------------------------------------------

_REVIEW_FIELDS = [
    "chunk_id",
    "doc_id",
    "text",
    "document_name",
    "source_url",
    "authority",
    "origin_type",
    "domain",
    "scan_status",
    "heading_path",
    "content_format",
    "symbol_type",
    "approval_status",
    # v13 trust attribution
    "scan_signals",
    "review_trace_id",
    "effective_at_epoch",
    "crawl_timestamp",
]

# Lightweight copy of the indexer's named patterns for on-the-fly reason extraction.
# Kept in sync with base/rag/indexer/app/injection_scan.py.
import re as _re

_FLAG_PATTERNS: list[tuple[str, str, _re.Pattern[str]]] = [
    (
        "ignore_previous_instructions",
        "Ignore previous instructions",
        _re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?", _re.IGNORECASE),
    ),
    (
        "disregard_previous",
        "Disregard previous context",
        _re.compile(r"disregard\s+(?:all\s+)?(?:previous|prior|above)", _re.IGNORECASE),
    ),
    (
        "forget_everything",
        "Forget everything told",
        _re.compile(r"forget\s+(?:everything|all)\s+(?:you\s+)?(?:were\s+)?told", _re.IGNORECASE),
    ),
    ("new_instructions", "New instructions block", _re.compile(r"new\s+instructions?\s*:", _re.IGNORECASE)),
    (
        "override_instructions",
        "Override instructions/prompt",
        _re.compile(r"override\s+(?:your\s+)?(?:instructions?|prompt)", _re.IGNORECASE),
    ),
    (
        "role_hijack_you_are_now",
        "Role hijack: 'you are now'",
        _re.compile(r"you\s+are\s+now\s+(?:a|an)\s", _re.IGNORECASE),
    ),
    ("role_hijack_pretend", "Role hijack: 'pretend you are'", _re.compile(r"pretend\s+you\s+are", _re.IGNORECASE)),
    ("role_hijack_act_as", "Role hijack: 'act as if'", _re.compile(r"act\s+as\s+if\s+you", _re.IGNORECASE)),
    ("system_prompt_marker", "System prompt marker (system:)", _re.compile(r"system\s*:\s*", _re.IGNORECASE)),
    ("chatml_system_tag", "ChatML system tag", _re.compile(r"<\|im_start\|>\s*system", _re.IGNORECASE)),
    ("markdown_human_prompt", "Markdown human prompt (### human:)", _re.compile(r"###\s*human\s*:", _re.IGNORECASE)),
    ("llama_inst_tag", "Llama [INST] tag", _re.compile(r"\[INST\]\s*", _re.IGNORECASE)),
    ("xml_system_tag", "XML system/s tag", _re.compile(r"<\/?s(?:ystem)?>", _re.IGNORECASE)),
    ("ignore_the_above", "Ignore the above", _re.compile(r"ignore\s+the\s+above", _re.IGNORECASE)),
    ("ignore_above", "Ignore above", _re.compile(r"ignore\s+above\b", _re.IGNORECASE)),
    (
        "follow_instead",
        "Follow these instructions instead",
        _re.compile(r"follow\s+these\s+instructions?\s+instead", _re.IGNORECASE),
    ),
    (
        "output_only_following",
        "Output only the following",
        _re.compile(r"output\s+(?:only|just)\s+the\s+following", _re.IGNORECASE),
    ),
    ("print_exactly_this", "Print exactly this", _re.compile(r"print\s+(?:exactly|only)\s+this\s*:", _re.IGNORECASE)),
]


import math as _math
import time as _time

_FRESHNESS_HALF_LIFE_DAYS = 90
_ONE_DAY_S = 86400


def _compute_freshness(row: dict) -> float:
    """Compute a 0.0–1.0 freshness score from epoch-second timestamps."""
    ts = row.get("effective_at_epoch") or row.get("crawl_timestamp") or 0
    if not ts or ts <= 0:
        return 0.0
    age_days = max(0, (_time.time() - ts) / _ONE_DAY_S)
    return _math.exp((-0.693 * age_days) / _FRESHNESS_HALF_LIFE_DAYS)


def _detect_flag_reasons(text: str) -> list[dict[str, str]]:
    """Return list of {id, label} for each injection pattern matched in text."""
    sample = text[:32_000].lower()
    reasons = []
    for pid, label, pat in _FLAG_PATTERNS:
        if pat.search(sample):
            reasons.append({"id": pid, "label": label})
    return reasons


@router.get("/review/stats")
async def review_stats(_user: UserInfo = Depends(get_current_user)):
    """Counts by scan_status and approval_status for the review queue badge."""
    _ensure_org_observability(_user)
    flagged = safe_query(
        CATALOG_COLLECTION, filter_expr='scan_status == "flagged"', output_fields=["chunk_id"], limit=10000
    )
    unscanned = safe_query(
        CATALOG_COLLECTION, filter_expr='scan_status == "unscanned"', output_fields=["chunk_id"], limit=10000
    )
    pending = safe_query(
        CATALOG_COLLECTION, filter_expr='approval_status == "pending"', output_fields=["chunk_id"], limit=10000
    )
    return {"flagged": len(flagged), "unscanned": len(unscanned), "pending_approval": len(pending)}


@router.get("/review")
async def review_queue(
    _user: UserInfo = Depends(get_current_user),
    status: str = Query("flagged", description="Filter: flagged | unscanned | all"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    sort: str = Query("", description="Sort pivot: freshness | authority | scan_status"),
    domain: str = Query("", description="Filter by domain"),
):
    """List chunks needing review with optional sort pivots and domain filter."""
    _ensure_org_observability(_user)
    if status == "all":
        expr = 'scan_status in ["flagged", "unscanned"]'
    else:
        expr = f'scan_status == "{status}"'
    if domain:
        safe_domain = domain.replace('"', '\\"')
        expr = f'({expr}) and domain == "{safe_domain}"'
    rows = safe_query(CATALOG_COLLECTION, filter_expr=expr, output_fields=_REVIEW_FIELDS, limit=limit, offset=offset)
    for r in rows:
        full_text = r.pop("text", "")
        r["text_preview"] = full_text[:500]
        if r.get("scan_status") == "flagged" and full_text:
            r["flag_reasons"] = _detect_flag_reasons(full_text)
        else:
            r["flag_reasons"] = []
        r["freshness_score"] = _compute_freshness(r)

    if sort == "freshness":
        rows.sort(key=lambda r: r.get("freshness_score", 0), reverse=True)
    elif sort == "authority":
        tier_order = {"canonical": 0, "vetted": 1, "community": 2, "external": 3}
        rows.sort(key=lambda r: tier_order.get(r.get("authority", ""), 99))
    elif sort == "scan_status":
        status_order = {"flagged": 0, "unscanned": 1, "clean": 2, "vetted": 3}
        rows.sort(key=lambda r: status_order.get(r.get("scan_status", ""), 99))

    return {"chunks": rows, "offset": offset, "limit": limit}


@router.post("/review/{chunk_id}/vet")
async def vet_chunk(chunk_id: str, _user: UserInfo = Depends(get_current_user)):
    """Mark a chunk as vetted: set scan_status to 'vetted', approval_status to 'approved'."""
    _ensure_org_content_admin(_user)
    import uuid

    from ..services.nornic_service import safe_query as sq
    from ..services.nornic_service import safe_upsert

    rows = sq(
        CATALOG_COLLECTION, filter_expr=f'chunk_id == "{chunk_id}"', output_fields=["authority", "scan_status"], limit=1
    )
    if not rows:
        return {"ok": False, "error": "chunk not found"}

    trace_id = f"review-{uuid.uuid4().hex[:12]}"
    try:
        safe_upsert(
            CATALOG_COLLECTION,
            {
                "id": chunk_id,
                "chunk_id": chunk_id,
                "scan_status": "vetted",
                "authority": "vetted",
                "approval_status": "approved",
                "review_trace_id": trace_id,
            },
        )
    except Exception:
        logger.warning("review_vet_nornic_update_failed", extra={"chunk_id": chunk_id}, exc_info=True)
        return {"ok": False, "error": "graph update failed"}
    logger.info("review_vet_chunk", extra={"chunk_id": chunk_id, "user": _user.username, "review_trace_id": trace_id})
    return {"ok": True, "chunk_id": chunk_id, "action": "vetted", "review_trace_id": trace_id}


@router.post("/review/{chunk_id}/reject")
async def reject_chunk(chunk_id: str, _user: UserInfo = Depends(get_current_user)):
    """Mark a chunk as rejected: set approval_status to 'rejected' (excluded from RAG retrieval)."""
    _ensure_org_content_admin(_user)
    import uuid

    trace_id = f"review-{uuid.uuid4().hex[:12]}"
    try:
        from ..services.nornic_service import safe_upsert

        safe_upsert(
            CATALOG_COLLECTION,
            {
                "id": chunk_id,
                "chunk_id": chunk_id,
                "scan_status": "rejected",
                "approval_status": "rejected",
                "review_trace_id": trace_id,
            },
        )
        ok = True
    except Exception:
        logger.warning("review_reject_nornic_update_failed", extra={"chunk_id": chunk_id}, exc_info=True)
        ok = False
    logger.info(
        "review_reject_chunk",
        extra={"chunk_id": chunk_id, "user": _user.username, "ok": ok, "review_trace_id": trace_id},
    )
    return {"ok": ok, "chunk_id": chunk_id, "action": "rejected", "review_trace_id": trace_id}


@router.post("/review/bulk/{action}")
async def bulk_review_action(
    action: str,
    request: dict,
    _user: UserInfo = Depends(get_current_user),
):
    """Bulk approve or reject multiple chunks.

    POST /review/bulk/vet   {"chunk_ids": ["id1", "id2"]}
    POST /review/bulk/reject {"chunk_ids": ["id1", "id2"]}
    """
    _ensure_org_content_admin(_user)
    import uuid

    chunk_ids = request.get("chunk_ids", [])
    if not chunk_ids:
        return {"ok": False, "error": "no chunk_ids provided"}
    if action not in ("vet", "reject"):
        return {"ok": False, "error": "action must be 'vet' or 'reject'"}

    batch_trace_id = f"review-batch-{uuid.uuid4().hex[:12]}"
    results: dict[str, Any] = {"ok": True, "processed": 0, "errors": 0, "review_trace_id": batch_trace_id}
    from ..services.nornic_service import safe_upsert

    for chunk_id in chunk_ids:
        try:
            if action == "vet":
                safe_upsert(
                    CATALOG_COLLECTION,
                    {
                        "id": chunk_id,
                        "chunk_id": chunk_id,
                        "scan_status": "vetted",
                        "authority": "vetted",
                        "approval_status": "approved",
                        "review_trace_id": batch_trace_id,
                    },
                )
            else:
                safe_upsert(
                    CATALOG_COLLECTION,
                    {
                        "id": chunk_id,
                        "chunk_id": chunk_id,
                        "scan_status": "rejected",
                        "approval_status": "rejected",
                        "review_trace_id": batch_trace_id,
                    },
                )
            results["processed"] += 1
        except Exception:
            logger.warning("review_bulk_%s_failed", action, extra={"chunk_id": chunk_id}, exc_info=True)
            results["errors"] += 1

    logger.info(
        "review_bulk_action",
        extra={
            "action": action,
            "count": len(chunk_ids),
            "processed": results["processed"],
            "user": _user.username,
            "review_trace_id": batch_trace_id,
        },
    )
    return results
