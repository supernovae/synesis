"""RAG pipeline: corpus stats, quality, benchmarks."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
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
from ..rbac import Role, RouteGroup, can_access_route_group, resolve_role
from ..services.admin_audit import record_admin_audit
from ..services.nornic_service import (
    collection_corpus_summary,
    collection_domain_hierarchy,
    collection_installed_packs,
    collection_pack_quality_reports,
    collection_schema_info,
    expected_graph_schema_version,
    reported_graph_schema_version,
    safe_count,
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


def _nornic_scope_kwargs(user: UserInfo) -> dict:
    """Extract org-scope kwargs for safe_query / safe_vector_search."""
    return {
        "caller_org_id": (user.org_id or "").strip(),
        "is_platform_admin": resolve_role(user) >= Role.platform_admin,
    }


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
_CATALOG_MAX_BYTES = 2 * 1024 * 1024
DEFAULT_CONTENT_PACK_CATALOG_URL = os.getenv(
    "SYNESIS_CONTENT_PACK_CATALOG_URL",
    "https://r2.kybern.dev/synesis-pack-catalog.json",
).strip()
LEGACY_CONTENT_PACK_CATALOG_URLS = {
    "https://r2.kybern.dev/synpacks/synesis-pack-catalog.json",
}


def _float_env(name: str, default: float) -> float:
    try:
        return max(0.5, float(os.getenv(name, str(default)) or default))
    except (TypeError, ValueError):
        return default


_CATALOG_TIMEOUT_SECONDS = _float_env("SYNESIS_CONTENT_PACK_CATALOG_TIMEOUT_SECONDS", 6.0)
_CONTENT_PACK_RUNNING_STALE_MINUTES = _float_env("SYNESIS_CONTENT_PACK_RUNNING_STALE_MINUTES", 180.0)
_NORNIC_ADMIN_TIMEOUT_SECONDS = _float_env("SYNESIS_ADMIN_NORNIC_QUERY_TIMEOUT_SECONDS", 3.0)
_NORNIC_ADMIN_CACHE_SECONDS = _float_env("SYNESIS_ADMIN_NORNIC_CACHE_SECONDS", 30.0)
_NORNIC_ADMIN_BACKOFF_SECONDS = _float_env("SYNESIS_ADMIN_NORNIC_BACKOFF_SECONDS", 10.0)
_BEST_EFFORT_CACHE: dict[str, tuple[float, Any]] = {}
_BEST_EFFORT_BACKOFF_UNTIL: dict[str, float] = {}


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
    configured_url = config.catalog_url if config else ""
    using_default = not configured_url or configured_url in LEGACY_CONTENT_PACK_CATALOG_URLS
    catalog_url = DEFAULT_CONTENT_PACK_CATALOG_URL if using_default else configured_url
    return {
        "catalog_url": catalog_url,
        "configured_catalog_url": configured_url,
        "default_catalog_url": DEFAULT_CONTENT_PACK_CATALOG_URL,
        "using_default": using_default,
        "updated_by": config.updated_by if config else "",
        "updated_at": config.updated_at.isoformat() if config and config.updated_at else None,
    }


def _effective_content_pack_catalog_url(config: ContentPackConfig | None) -> str:
    configured_url = (config.catalog_url if config and config.catalog_url else "").strip()
    if configured_url and configured_url not in LEGACY_CONTENT_PACK_CATALOG_URLS:
        return configured_url
    return DEFAULT_CONTENT_PACK_CATALOG_URL


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


def _degraded_warning(component: str, operation: str, message: str) -> dict[str, str]:
    return {"component": component, "operation": operation, "message": message}


async def _run_best_effort(
    operation: str,
    fn: Callable[[], Any],
    fallback: Any,
    *,
    timeout_seconds: float = _NORNIC_ADMIN_TIMEOUT_SECONDS,
    force_refresh: bool = False,
) -> tuple[Any, dict[str, str] | None]:
    now = time.monotonic()
    cached = _BEST_EFFORT_CACHE.get(operation)
    if not force_refresh and cached and now - cached[0] <= _NORNIC_ADMIN_CACHE_SECONDS:
        return cached[1], None
    if not force_refresh and _BEST_EFFORT_BACKOFF_UNTIL.get(operation, 0.0) > now:
        return (cached[1] if cached else fallback), _degraded_warning(
            "nornicdb",
            operation,
            "NornicDB is busy; briefly backing off and showing cached or partial admin data.",
        )
    try:
        value = await asyncio.wait_for(asyncio.to_thread(fn), timeout=timeout_seconds)
        _BEST_EFFORT_CACHE[operation] = (time.monotonic(), value)
        _BEST_EFFORT_BACKOFF_UNTIL.pop(operation, None)
        return value, None
    except TimeoutError:
        logger.warning("admin_rag_best_effort_timeout operation=%s timeout_seconds=%s", operation, timeout_seconds)
        _BEST_EFFORT_BACKOFF_UNTIL[operation] = time.monotonic() + _NORNIC_ADMIN_BACKOFF_SECONDS
        stale = _BEST_EFFORT_CACHE.get(operation)
        return (stale[1] if stale else fallback), _degraded_warning(
            "nornicdb",
            operation,
            "NornicDB is busy; showing cached or partial admin data.",
        )
    except Exception:
        logger.warning("admin_rag_best_effort_failed operation=%s", operation, exc_info=True)
        _BEST_EFFORT_BACKOFF_UNTIL[operation] = time.monotonic() + _NORNIC_ADMIN_BACKOFF_SECONDS
        stale = _BEST_EFFORT_CACHE.get(operation)
        return (stale[1] if stale else fallback), _degraded_warning(
            "nornicdb",
            operation,
            "NornicDB query failed; showing cached or partial admin data.",
        )


def _empty_catalog(catalog_url: str, *, error: str = "") -> dict[str, Any]:
    errors = [error] if error else []
    return {
        "catalog_url": catalog_url,
        "name": "",
        "version": "",
        "packs": [],
        "errors": errors,
        "ok": False,
        "degraded": bool(errors),
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
    try:
        node_count = max(0, int(raw.get("node_count", 0) or 0))
        edge_count = max(0, int(raw.get("edge_count", 0) or 0))
    except Exception:
        return None, f"packs[{index}].node_count and edge_count must be integers"
    tags = raw.get("tags")
    if not isinstance(tags, list):
        tags = []

    def _safe_count(key: str) -> int:
        try:
            return max(0, int(raw.get(key, 0) or 0))
        except Exception:
            return 0

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
        "install_profile": str(raw.get("install_profile") or "")[:128],
        "node_count": node_count,
        "edge_count": edge_count,
        "requires_bulk_import": bool(raw.get("requires_bulk_import", False)),
        "content_type": str(raw.get("content_type") or "")[:64],
        "source_version": str(raw.get("source_version") or "")[:64],
        "source_release": str(raw.get("source_release") or "")[:64],
        "example_count": _safe_count("example_count"),
        "context_card_count": _safe_count("context_card_count"),
        "pack_card_count": _safe_count("pack_card_count"),
        "anti_pattern_count": _safe_count("anti_pattern_count"),
        "endpoint": raw.get("endpoint") if isinstance(raw.get("endpoint"), dict) else {},
        "endpoints": raw.get("endpoints") if isinstance(raw.get("endpoints"), list) else [],
        "delivery_modes": [
            str(mode).strip()[:32]
            for mode in (raw.get("delivery_modes") if isinstance(raw.get("delivery_modes"), list) else [])
            if str(mode).strip()
        ][:8],
        "taxonomy_domains": [
            str(domain).strip()[:64]
            for domain in (raw.get("taxonomy_domains") if isinstance(raw.get("taxonomy_domains"), list) else [])
            if str(domain).strip()
        ][:32],
        "routing_aliases": [
            str(alias).strip()[:128]
            for alias in (raw.get("routing_aliases") if isinstance(raw.get("routing_aliases"), list) else [])
            if str(alias).strip()
        ][:64],
        "pack_type": str(raw.get("pack_type") or raw.get("type") or "")[:64],
        "quality_score": raw.get("quality_score"),
        "trust_score": raw.get("trust_score"),
        "freshness_score": raw.get("freshness_score"),
        "tags": [str(t).strip()[:64] for t in tags if str(t).strip()][:32],
        "created_at": raw.get("created_at") or "",
        "requires_synesis_version": str(raw.get("requires_synesis_version") or "")[:64],
        "schema_version": raw.get("schema_version") or raw.get("content_graph_schema_version"),
    }
    return entry, None


async def _fetch_catalog(catalog_url: str) -> dict[str, Any]:
    url = _validate_https_url(catalog_url, field_name="catalog_url")
    try:
        timeout = httpx.Timeout(
            _CATALOG_TIMEOUT_SECONDS,
            connect=min(2.0, _CATALOG_TIMEOUT_SECONDS),
            read=_CATALOG_TIMEOUT_SECONDS,
            write=min(2.0, _CATALOG_TIMEOUT_SECONDS),
            pool=min(2.0, _CATALOG_TIMEOUT_SECONDS),
        )
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            if resp.url.scheme != "https":
                raise HTTPException(status_code=400, detail="Content pack catalog redirected to a non-https URL")
            content = resp.content
    except httpx.TimeoutException as exc:
        logger.warning("content_pack_catalog_fetch_timeout url=%s", url)
        raise HTTPException(status_code=502, detail="Content pack catalog timed out") from exc
    except httpx.HTTPStatusError as exc:
        logger.warning("content_pack_catalog_fetch_status_failed url=%s status=%s", url, exc.response.status_code)
        raise HTTPException(status_code=502, detail="Content pack catalog is unavailable") from exc
    except httpx.HTTPError as exc:
        logger.warning("content_pack_catalog_fetch_failed url=%s error=%s", url, str(exc)[:120])
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


async def _fetch_catalog_soft(catalog_url: str) -> tuple[dict[str, Any], dict[str, str] | None]:
    if not catalog_url:
        return _empty_catalog("", error="No content pack catalog URL configured"), _degraded_warning(
            "catalog",
            "fetch",
            "No content pack catalog URL is configured.",
        )
    try:
        return await _fetch_catalog(catalog_url), None
    except HTTPException as exc:
        detail = str(exc.detail or "Content pack catalog unavailable")
        return _empty_catalog(catalog_url, error=detail), _degraded_warning(
            "catalog",
            "fetch",
            detail,
        )


def _installed_doc_packs() -> list[dict[str, Any]]:
    return collection_installed_packs(CATALOG_COLLECTION)


@router.get("/corpus")
async def corpus_overview(_user: UserInfo = Depends(get_current_user)):
    _ensure_org_observability(_user)
    from ..db.engine import async_session as _async_session
    from ..db.models import GraphSchemaSync

    warnings: list[dict[str, str]] = []
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
        schema_version, warning = await _run_best_effort(
            "reported_graph_schema_version",
            reported_graph_schema_version,
            0,
        )
        if warning:
            warnings.append(warning)

    expected_sv = expected_graph_schema_version()
    schema_upgrade_pending = schema_version < expected_sv

    stats, warning = await _run_best_effort(
        "collection_corpus_summary",
        lambda: collection_corpus_summary(CATALOG_COLLECTION),
        {},
    )
    if warning:
        warnings.append(warning)
    return {
        "collection": CATALOG_COLLECTION,
        "total_chunks": int(stats.get("total_chunks", 0) or 0),
        "total_documents": int(stats.get("total_documents", 0) or 0),
        "total_sources": int(stats.get("total_sources", 0) or 0),
        "domains_covered": int(stats.get("domains_covered", 0) or 0),
        "total_graph_nodes": int(stats.get("node_count", 0) or 0),
        "malformed_graph_nodes": int(stats.get("malformed_node_count", 0) or 0),
        "schema_version": schema_version,
        "expected_schema_version": expected_sv,
        "schema_upgrade_pending": schema_upgrade_pending,
        "degraded": bool(warnings),
        "warnings": warnings,
    }


@router.get("/corpus/schema")
async def corpus_schema(_user: UserInfo = Depends(get_current_user)):
    """Content graph collection schema: fields, indexes, domain->source hierarchy."""
    _ensure_org_observability(_user)
    schema, schema_warning = await _run_best_effort(
        "collection_schema_info",
        lambda: collection_schema_info(CATALOG_COLLECTION),
        {"exists": False},
    )
    hierarchy, hierarchy_warning = await _run_best_effort(
        "collection_domain_hierarchy",
        lambda: collection_domain_hierarchy(CATALOG_COLLECTION),
        [],
    )
    warnings = [w for w in (schema_warning, hierarchy_warning) if w]
    return {
        "collection": CATALOG_COLLECTION,
        "schema": _sanitize_schema_info(schema),
        "hierarchy": _drop_error_fields(hierarchy),
        "degraded": bool(warnings),
        "warnings": warnings,
    }


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
    catalog_url = _effective_content_pack_catalog_url(config)
    catalog, warning = await _fetch_catalog_soft(catalog_url)
    if warning:
        catalog["warnings"] = [warning]
    return catalog


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

    catalog_url = _effective_content_pack_catalog_url(config)
    warnings: list[dict[str, str]] = []
    catalog, warning = await _fetch_catalog_soft(catalog_url)
    if warning:
        warnings.append(warning)

    installed_result, quality_result = await asyncio.gather(
        _run_best_effort("collection_installed_packs", _installed_doc_packs, []),
        _run_best_effort(
            "collection_pack_quality_reports",
            lambda: collection_pack_quality_reports(CATALOG_COLLECTION),
            [],
        ),
    )
    installed, installed_warning = installed_result
    quality_reports, quality_warning = quality_result
    warnings.extend(w for w in (installed_warning, quality_warning) if w)

    quality_by_id = {str(report["pack_id"]): report for report in quality_reports}
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
        available.append(
            {
                **pack,
                "install_status": status,
                "installed": installed_pack,
                "quality": quality_by_id.get(str(pack["pack_id"])),
            }
        )
    return {
        "config": _content_pack_config_dict(config),
        "catalog": {**catalog, "packs": available},
        "installed": [{**pack, "quality": quality_by_id.get(str(pack["pack_id"]))} for pack in installed],
        "quality_reports": quality_reports,
        "jobs": [_content_pack_job_dict(job) for job in jobs],
        "degraded": bool(warnings),
        "warnings": warnings,
    }


@router.post("/content-packs/install")
async def install_content_pack(
    body: ContentPackInstallBody,
    _user: UserInfo = Depends(get_current_user),
):
    _ensure_org_content_admin(_user)
    async with async_session() as session:
        config = await session.get(ContentPackConfig, 1)
    catalog_url = _effective_content_pack_catalog_url(config)
    if not catalog_url:
        raise HTTPException(status_code=400, detail="No content pack catalog URL configured")
    catalog = await _fetch_catalog(catalog_url)
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
        existing_installed_job = (
            (
                await session.execute(
                    select(ContentPackInstallJob.id)
                    .where(
                        ContentPackInstallJob.pack_id == selected["pack_id"],
                        ContentPackInstallJob.status == "installed",
                    )
                    .limit(1)
                )
            )
            .scalars()
            .first()
        )
        replace_existing = body.replace or existing_installed_job is not None
        job = ContentPackInstallJob(
            pack_id=selected["pack_id"],
            pack_version=selected["version"],
            catalog_url=catalog_url,
            download_url=selected["download_url"],
            sha256=selected["sha256"],
            size_bytes=selected["size_bytes"],
            replace_existing=replace_existing,
            status="pending",
            requested_by=_user.email or _user.username or _user.user_id,
            result={
                "catalog": {
                    "install_profile": selected.get("install_profile") or "",
                    "node_count": selected.get("node_count") or 0,
                    "edge_count": selected.get("edge_count") or 0,
                    "requires_bulk_import": bool(selected.get("requires_bulk_import")),
                }
            },
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
        detail={"pack_id": selected["pack_id"], "version": selected["version"], "replace": replace_existing},
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
    now = datetime.now(UTC)
    stale_started_before = now - timedelta(minutes=_CONTENT_PACK_RUNNING_STALE_MINUTES)
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
        stale_jobs = (
            (
                await session.execute(
                    select(ContentPackInstallJob)
                    .where(
                        ContentPackInstallJob.status == "running",
                        ContentPackInstallJob.started_at.is_not(None),
                        ContentPackInstallJob.started_at <= stale_started_before,
                    )
                    .with_for_update(skip_locked=True)
                )
            )
            .scalars()
            .all()
        )
        for stale in stale_jobs:
            next_attempt = (stale.attempt_count or 0) + 1
            stale.attempt_count = next_attempt
            stale.status = "dead_letter" if next_attempt >= stale.max_attempts else "failed"
            stale.completed_at = now
            stale.error_message = (
                f"content pack install lease expired after {_CONTENT_PACK_RUNNING_STALE_MINUTES:g} minutes"
            )
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
            await session.commit()
            return None
        job.status = "running"
        job.started_at = now
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
            job.error_message = body.error_message[:8000] or "content pack install failed"
            job.status = "dead_letter" if job.attempt_count >= job.max_attempts else "failed"
        await session.commit()
        await session.refresh(job)
    return {"ok": True, "job": _content_pack_job_dict(job)}


@router.get("/packs")
async def list_doc_packs(_user: UserInfo = Depends(get_current_user)):
    """List installed SynPack partitions from Content graph catalog metadata."""
    _ensure_org_observability(_user)
    return {"packs": _installed_doc_packs()}


def _as_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _score_float(value: Any) -> float | None:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return None
    if score < 0:
        return None
    return max(0.0, min(score, 1.0))


def _health_from_pack_quality(
    *,
    chunk_count: int,
    node_count: int,
    embedding_coverage: float,
    edge_count: int,
    quality_score: float | None,
    trust_score: float | None,
    freshness_score: float | None,
) -> str:
    if chunk_count <= 0:
        return "empty"
    explicit_scores = [score for score in (quality_score, trust_score, freshness_score) if score is not None]
    if explicit_scores:
        aggregate = sum(explicit_scores) / len(explicit_scores)
    elif chunk_count >= 1000 and embedding_coverage >= 0.8 and (edge_count > 0 or node_count > chunk_count):
        aggregate = 0.85
    elif chunk_count >= 100 and embedding_coverage >= 0.5:
        aggregate = 0.7
    else:
        aggregate = 0.4
    if aggregate >= 0.8:
        return "strong"
    if aggregate >= 0.6:
        return "adequate"
    return "weak"


def _quality_summary_payload(
    scorecards: list[dict[str, Any]],
    *,
    source: str,
    warnings: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    counts: dict[str, int] = {"strong": 0, "adequate": 0, "weak": 0, "empty": 0}
    for scorecard in scorecards:
        health = str(scorecard.get("health") or "empty")
        counts[health] = counts.get(health, 0) + 1
    return {
        **counts,
        "scorecards": scorecards,
        "source": source,
        "degraded": bool(warnings),
        "warnings": warnings or [],
    }


def _scorecard_from_pack_quality_report(raw: dict[str, Any]) -> dict[str, Any] | None:
    pack_id = str(raw.get("pack_id") or "").strip()
    domain = str(raw.get("domain") or "").strip()
    language = str(raw.get("language") or "").strip()
    key = pack_id or (domain if domain and domain != "generalist" else "") or language or "generalist"
    if not key:
        return None

    chunk_count = _as_int(raw.get("chunk_count") or raw.get("row_count"))
    node_count = _as_int(raw.get("node_count"))
    embedding_count = _as_int(raw.get("embedding_count"))
    doc_count = _as_int(raw.get("doc_count"))
    source_count = _as_int(raw.get("source_count"))
    edge_count = _as_int(raw.get("edge_count"))
    quality_score = _score_float(raw.get("quality_score"))
    trust_score = _score_float(raw.get("trust_score"))
    freshness_score = _score_float(raw.get("freshness_score"))
    embedding_coverage = round(embedding_count / chunk_count, 4) if chunk_count else 0.0
    health = _health_from_pack_quality(
        chunk_count=chunk_count,
        node_count=node_count,
        embedding_coverage=embedding_coverage,
        edge_count=edge_count,
        quality_score=quality_score,
        trust_score=trust_score,
        freshness_score=freshness_score,
    )

    path_parts = []
    if pack_id:
        path_parts.append(f"pack: {pack_id}")
    if domain:
        path_parts.append(f"domain: {domain}")
    if language:
        path_parts.append(f"language: {language}")
    return {
        "domain": key,
        "display_name": pack_id or domain or language or key,
        "path": " · ".join(path_parts),
        "scope": "pack" if pack_id else "domain",
        "pack_id": pack_id,
        "language": language,
        "health": health,
        "chunk_count": chunk_count,
        "doc_count": doc_count,
        "freshness_pct": round((freshness_score or 0.0) * 100, 1),
        "authority_mix": {},
        "dead_weight_count": 0,
        "inventory": {
            "total_chunks": chunk_count,
            "total_documents": doc_count,
            "total_sources": source_count,
            "total_nodes": node_count,
        },
        "coverage": {
            "hit_rate": embedding_coverage,
            "mean_mrr": quality_score or 0.0,
        },
        "dead_weight": {"unretrieved_documents": 0},
        "quality_score": quality_score,
        "trust_score": trust_score,
        "freshness_score": freshness_score,
        "node_count": node_count,
        "embedding_count": embedding_count,
        "embedding_coverage": embedding_coverage,
        "edge_count": edge_count,
        "example_count": _as_int(raw.get("example_count")),
        "context_card_count": _as_int(raw.get("context_card_count")),
        "pack_card_count": _as_int(raw.get("pack_card_count")),
        "anti_pattern_count": _as_int(raw.get("anti_pattern_count")),
        "constraint_count": _as_int(raw.get("constraint_count")),
        "external_ref_count": _as_int(raw.get("external_ref_count")),
        "node_kind_counts": raw.get("node_kind_counts") if isinstance(raw.get("node_kind_counts"), dict) else {},
        "edge_type_counts": raw.get("edge_type_counts") if isinstance(raw.get("edge_type_counts"), dict) else {},
        "source_version": raw.get("source_version") or "",
        "source_release": raw.get("source_release") or "",
        "source": "nornicdb_pack_report",
    }


async def _current_quality_scorecards(
    user: UserInfo,
    *,
    force_refresh: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    del user
    reports_result, installed_result = await asyncio.gather(
        _run_best_effort(
            "quality_pack_reports_current",
            lambda: collection_pack_quality_reports(CATALOG_COLLECTION),
            [],
            timeout_seconds=max(_NORNIC_ADMIN_TIMEOUT_SECONDS, 5.0),
            force_refresh=force_refresh,
        ),
        _run_best_effort(
            "quality_installed_packs_current",
            _installed_doc_packs,
            [],
            timeout_seconds=max(_NORNIC_ADMIN_TIMEOUT_SECONDS, 5.0),
            force_refresh=force_refresh,
        ),
    )
    reports, report_warning = reports_result
    installed, installed_warning = installed_result
    warnings = [w for w in (report_warning, installed_warning) if w]

    reports_by_id = {str(report.get("pack_id") or ""): dict(report) for report in reports if isinstance(report, dict)}
    for pack in installed:
        pack_id = str(pack.get("pack_id") or "")
        if not pack_id:
            continue
        report = reports_by_id.setdefault(
            pack_id,
            {
                "pack_id": pack_id,
                "chunk_count": pack.get("row_count", 0),
                "node_count": pack.get("row_count", 0),
            },
        )
        for field in ("domain", "language", "pack_version", "pack_source_version"):
            if not report.get(field) and pack.get(field):
                report[field] = pack[field]

    scorecards = [
        scorecard
        for scorecard in (_scorecard_from_pack_quality_report(report) for report in reports_by_id.values())
        if scorecard is not None
    ]
    scorecards.sort(key=lambda item: (str(item.get("scope") or ""), str(item.get("domain") or "")))
    return scorecards, warnings


async def _latest_snapshot_scorecards() -> list[dict[str, Any]]:
    from ..db.engine import async_session
    from ..db.models import QualitySnapshot

    async with async_session() as session:
        latest_scored_at = (await session.execute(select(func.max(QualitySnapshot.scored_at)))).scalar_one_or_none()
        if latest_scored_at is None:
            return []
        rows = (
            (
                await session.execute(
                    select(QualitySnapshot)
                    .where(QualitySnapshot.scored_at == latest_scored_at)
                    .order_by(QualitySnapshot.domain)
                )
            )
            .scalars()
            .all()
        )
    return [_scorecard_from_snapshot(row) for row in rows]


@router.get("/quality")
async def quality_summary(_user: UserInfo = Depends(get_current_user)):
    """Quality summary from the current NornicDB graph, with stored snapshots as fallback."""
    _ensure_org_observability(_user)
    live_scorecards, warnings = await _current_quality_scorecards(_user)
    if live_scorecards:
        return _quality_summary_payload(live_scorecards, source="nornicdb", warnings=warnings)

    try:
        snapshot_scorecards = await _latest_snapshot_scorecards()
        if snapshot_scorecards:
            fallback_warning = _degraded_warning(
                "nornicdb",
                "quality_pack_reports_current",
                "Showing latest stored quality snapshot because current NornicDB pack reports are unavailable.",
            )
            return _quality_summary_payload(
                snapshot_scorecards,
                source="quality_snapshots",
                warnings=[*warnings, fallback_warning],
            )
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
        "source": "quality_report_file",
        "degraded": bool(warnings),
        "warnings": warnings,
    }


@router.post("/quality/refresh")
async def quality_refresh(_user: UserInfo = Depends(get_current_user)):
    """Compute pack/domain health scores from NornicDB Content graph and store in quality_snapshots."""
    _ensure_org_content_admin(_user)
    scorecards, warnings = await _current_quality_scorecards(_user, force_refresh=True)
    if not scorecards:
        return {
            "ok": False,
            "error": "no corpus data",
            "degraded": bool(warnings),
            "warnings": warnings,
        }

    from datetime import datetime

    from ..db.engine import async_session
    from ..db.models import QualitySnapshot

    now = datetime.now(UTC)
    snapshots = []
    for scorecard in scorecards:
        snapshots.append(
            QualitySnapshot(
                domain=str(scorecard.get("domain") or ""),
                health=str(scorecard.get("health") or "empty"),
                chunk_count=_as_int(scorecard.get("chunk_count")),
                doc_count=_as_int(scorecard.get("doc_count")),
                freshness_pct=float(scorecard.get("freshness_pct") or 0.0),
                authority_mix=scorecard.get("authority_mix")
                if isinstance(scorecard.get("authority_mix"), dict)
                else {},
                dead_weight_count=0,
                raw_scorecard=scorecard,
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

    return {
        "ok": True,
        "domains": len(snapshots),
        "summary": counts,
        "scorecards": scorecards,
        "source": "nornicdb",
        "degraded": bool(warnings),
        "warnings": warnings,
    }


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
    scorecards, warnings = await _current_quality_scorecards(_user)
    source = "nornicdb"
    if not scorecards:
        try:
            scorecards = await _latest_snapshot_scorecards()
            source = "quality_snapshots"
        except Exception:
            logger.debug("quality_domains_db_fallback_failed", exc_info=True)
    if not scorecards:
        report = _load_quality_report()
        scorecards = report.get("scorecards", [])
        source = "quality_report_file"

    if health:
        scorecards = [s for s in scorecards if s.get("health") == health]
    with contextlib.suppress(Exception):
        scorecards.sort(key=lambda s: s.get(sort, ""))
    return {"domains": scorecards, "source": source, "degraded": bool(warnings), "warnings": warnings}


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
        if raw.get("source") == "nornicdb_pack_report":
            return raw
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
    live_scorecards, _warnings = await _current_quality_scorecards(_user)
    for scorecard in live_scorecards:
        if key in {str(scorecard.get("domain") or ""), str(scorecard.get("pack_id") or "")}:
            return scorecard

    try:
        for scorecard in await _latest_snapshot_scorecards():
            if key in {str(scorecard.get("domain") or ""), str(scorecard.get("pack_id") or "")}:
                return scorecard
    except Exception:
        logger.debug("quality_domain_db_read_failed", exc_info=True)

    report = _load_quality_report()
    for sc in report.get("scorecards", []):
        if sc.get("domain") == key:
            return sc

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
                    .where(BenchmarkResult.benchmark_type != "synpack_retrieval_eval")
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
                        select(BenchmarkResult)
                        .where(BenchmarkResult.benchmark_type != "synpack_retrieval_eval")
                        .order_by(BenchmarkResult.started_at.desc())
                        .limit(limit)
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
        "How does planner-ts implement multi-node orchestration?",
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
            **_nornic_scope_kwargs(_user),
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
    "id",
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
    raw_ts = row.get("effective_at_epoch") or row.get("crawl_timestamp") or 0
    try:
        ts = float(raw_ts or 0)
    except (TypeError, ValueError):
        return 0.0
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


def _string_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list | tuple | set):
        return ", ".join(_string_value(item) for item in value if item is not None)
    if isinstance(value, dict):
        try:
            return json.dumps(value, sort_keys=True)
        except (TypeError, ValueError):
            return str(value)
    return str(value)


def _clean_review_filter_value(value: str, *, name: str) -> str:
    value = (value or "").strip()
    if '"' in value:
        raise HTTPException(status_code=400, detail=f"{name} cannot contain double quotes")
    return value


def _review_node_for_action(chunk_id: str, user: UserInfo) -> dict[str, Any] | None:
    chunk_id = _clean_review_filter_value(chunk_id, name="chunk_id")
    if not chunk_id:
        return None
    fields = ["id", "chunk_id", "authority", "scan_status", "approval_status"]
    scope = _nornic_scope_kwargs(user)
    for field in ("chunk_id", "id"):
        rows = safe_query(
            CATALOG_COLLECTION,
            filter_expr=f'{field} == "{chunk_id}"',
            output_fields=fields,
            limit=1,
            **scope,
        )
        if rows:
            return rows[0]
    return None


def _review_update_identity(row: dict[str, Any], fallback: str) -> tuple[str, str]:
    node_id = _string_value(row.get("id") or row.get("chunk_id") or fallback)
    chunk_id = _string_value(row.get("chunk_id") or node_id)
    return node_id, chunk_id


@router.get("/review/stats")
async def review_stats(_user: UserInfo = Depends(get_current_user)):
    """Counts by scan_status and approval_status for the review queue badge."""
    _ensure_org_observability(_user)
    scope = _nornic_scope_kwargs(_user)
    return {
        "flagged": safe_count(CATALOG_COLLECTION, filter_expr='scan_status == "flagged"', **scope),
        "unscanned": safe_count(CATALOG_COLLECTION, filter_expr='scan_status == "unscanned"', **scope),
        "pending_approval": safe_count(CATALOG_COLLECTION, filter_expr='approval_status == "pending"', **scope),
    }


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
    if status not in {"flagged", "unscanned", "all"}:
        raise HTTPException(status_code=400, detail="status must be flagged, unscanned, or all")
    if sort and sort not in {"freshness", "authority", "scan_status"}:
        raise HTTPException(status_code=400, detail="sort must be freshness, authority, or scan_status")
    if status == "all":
        expr = 'scan_status in ["flagged", "unscanned"]'
    else:
        expr = f'scan_status == "{status}"'
    if domain:
        safe_domain = _clean_review_filter_value(domain, name="domain")[:128]
        expr = f'({expr}) and domain == "{safe_domain}"'
    rows = safe_query(
        CATALOG_COLLECTION,
        filter_expr=expr,
        output_fields=_REVIEW_FIELDS,
        limit=limit,
        offset=offset,
        **_nornic_scope_kwargs(_user),
    )
    for r in rows:
        node_id = _string_value(r.get("id") or r.get("chunk_id"))
        chunk_id = _string_value(r.get("chunk_id") or node_id)
        r["id"] = node_id or chunk_id
        r["chunk_id"] = chunk_id or node_id
        for key in (
            "doc_id",
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
            "scan_signals",
            "review_trace_id",
        ):
            r[key] = _string_value(r.get(key))
        r["scan_status"] = r["scan_status"] or "unscanned"
        r["approval_status"] = r["approval_status"] or "auto_approved"
        r["authority"] = r["authority"] or "community"
        full_text = _string_value(r.pop("text", ""))
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

    from ..services.nornic_service import safe_upsert

    row = _review_node_for_action(chunk_id, _user)
    if not row:
        return {"ok": False, "error": "chunk not found"}
    node_id, effective_chunk_id = _review_update_identity(row, chunk_id)

    trace_id = f"review-{uuid.uuid4().hex[:12]}"
    try:
        ok = safe_upsert(
            CATALOG_COLLECTION,
            {
                "id": node_id,
                "chunk_id": effective_chunk_id,
                "scan_status": "vetted",
                "authority": "vetted",
                "approval_status": "approved",
                "review_trace_id": trace_id,
            },
        )
    except Exception:
        logger.warning("review_vet_nornic_update_failed", extra={"chunk_id": chunk_id}, exc_info=True)
        return {"ok": False, "error": "graph update failed"}
    if not ok:
        return {"ok": False, "error": "graph update failed"}
    logger.info(
        "review_vet_chunk",
        extra={"chunk_id": effective_chunk_id, "node_id": node_id, "user": _user.username, "review_trace_id": trace_id},
    )
    return {"ok": True, "chunk_id": effective_chunk_id, "action": "vetted", "review_trace_id": trace_id}


@router.post("/review/{chunk_id}/reject")
async def reject_chunk(chunk_id: str, _user: UserInfo = Depends(get_current_user)):
    """Mark a chunk as rejected: set approval_status to 'rejected' (excluded from RAG retrieval)."""
    _ensure_org_content_admin(_user)
    import uuid

    row = _review_node_for_action(chunk_id, _user)
    if not row:
        return {"ok": False, "error": "chunk not found"}
    node_id, effective_chunk_id = _review_update_identity(row, chunk_id)
    trace_id = f"review-{uuid.uuid4().hex[:12]}"
    try:
        from ..services.nornic_service import safe_upsert

        ok = safe_upsert(
            CATALOG_COLLECTION,
            {
                "id": node_id,
                "chunk_id": effective_chunk_id,
                "scan_status": "rejected",
                "approval_status": "rejected",
                "review_trace_id": trace_id,
            },
        )
    except Exception:
        logger.warning("review_reject_nornic_update_failed", extra={"chunk_id": chunk_id}, exc_info=True)
        ok = False
    logger.info(
        "review_reject_chunk",
        extra={
            "chunk_id": effective_chunk_id,
            "node_id": node_id,
            "user": _user.username,
            "ok": ok,
            "review_trace_id": trace_id,
        },
    )
    return {"ok": ok, "chunk_id": effective_chunk_id, "action": "rejected", "review_trace_id": trace_id}


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
            row = _review_node_for_action(str(chunk_id), _user)
            if not row:
                results["errors"] += 1
                continue
            node_id, effective_chunk_id = _review_update_identity(row, str(chunk_id))
            if action == "vet":
                ok = safe_upsert(
                    CATALOG_COLLECTION,
                    {
                        "id": node_id,
                        "chunk_id": effective_chunk_id,
                        "scan_status": "vetted",
                        "authority": "vetted",
                        "approval_status": "approved",
                        "review_trace_id": batch_trace_id,
                    },
                )
            else:
                ok = safe_upsert(
                    CATALOG_COLLECTION,
                    {
                        "id": node_id,
                        "chunk_id": effective_chunk_id,
                        "scan_status": "rejected",
                        "approval_status": "rejected",
                        "review_trace_id": batch_trace_id,
                    },
                )
            if ok:
                results["processed"] += 1
            else:
                results["errors"] += 1
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
    results["ok"] = results["errors"] == 0
    return results
