"""Ingestion queue: sources, items, runs, claim/status, and bootstrap."""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import UTC, datetime, timedelta
from typing import Any

import yaml
from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import and_, delete, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..db.models import (
    GraphSchemaSync,
    IngestionDocument,
    IngestionEnrichQueue,
    IngestionItem,
    IngestionRun,
    IngestionSource,
)
from ..internal_auth import ServicePrincipal, require_service_or_platform_admin
from ..rbac import (
    Role,
    can_manage_visibility_scope,
    require_org_admin,
    require_platform_admin,
    require_tenant_content_operator,
    resolve_role,
)
from ..services import ingestion_discovery as _ingestion_discovery
from ..services.admin_audit import record_admin_audit
from ..services.nornic_service import (
    expected_graph_schema_version,
    recreate_content_graph,
    reported_graph_schema_version,
)

EXPECTED_SCHEMA_VERSION = expected_graph_schema_version()

logger = logging.getLogger("synesis.admin.ingestion")

router = APIRouter(prefix="/api/v1/ingestion", tags=["ingestion"])

_CORPUS_HEURISTICS = _ingestion_discovery.CORPUS_HEURISTICS
_TAG_SIGNALS = _ingestion_discovery.TAG_SIGNALS
_is_public_discovery_host = _ingestion_discovery.is_public_discovery_host
_run_heuristic_discovery = _ingestion_discovery.run_heuristic_discovery
_validate_discovery_target_url = _ingestion_discovery.validate_discovery_target_url

_DISCOVERY_HINT_ALIASES = {
    "api": "api-reference",
    "api-reference": "api-reference",
    "docs": "documentation",
    "documentation": "documentation",
}
_DISCOVERY_HINT_VALUES = frozenset(_DISCOVERY_HINT_ALIASES.values())
_DISCOVERY_HANDLER_VALUES = frozenset(
    {
        "arxiv_paper",
        "generic_text",
        "github_code",
        "github_markdown",
        "github_repo",
        "html_document",
        "license_spdx",
        "markdown_file",
        "openapi_spec",
        "pdf_document",
        "seed_corpus",
        "structured_data",
        "web_page",
    }
)
_DEFAULT_INGESTION_HANDLER = "html_document"
_MODEL_ID_PATTERN = r"^[A-Za-z0-9_.:/@-]*$"
_DISCOVERY_TAG_PATTERN = re.compile(r"^[a-z0-9_.@/+:-]{1,64}$")


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class IngestionDiscoveryReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    handler: str | None = Field(None, max_length=64)
    domain: str | None = Field(None, max_length=128)
    title: str | None = Field(None, max_length=512)
    tags: list[str] | None = Field(None, max_length=50)
    risk_flags: list[str] | None = Field(None, max_length=50)
    recommended_mode: str | None = Field(None, max_length=64)
    notes: list[str] | None = Field(None, max_length=50)
    suggested_corpus_class: str | None = Field(None, max_length=32)


class IngestionSynesisMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: str | None = Field(None, max_length=32)
    languages: list[str] | None = Field(None, max_length=20)
    artifact_kind: str | None = Field(None, max_length=32)
    corpus_class: str | None = Field(None, max_length=32)
    content_profile: str | None = Field(None, max_length=32)
    freshness_sla_days: int | None = Field(None, ge=1, le=3650)
    scope_tags: list[str] | None = Field(None, max_length=20)
    golden_path_id: str | None = Field(None, max_length=128)
    validation_recipe_id: str | None = Field(None, max_length=128)
    source_owner: str | None = Field(None, max_length=128)
    review_status: str | None = Field(None, max_length=32, pattern="^(pending|reviewed|closed)$")
    backstage_entity_ref: str | None = Field(None, max_length=256)
    constraint_domain: str | None = Field(None, max_length=64)
    constraint_kind: str | None = Field(None, max_length=16)
    constraint_source: str | None = Field(None, max_length=64)
    constraint_confidence: float | None = Field(None, ge=0, le=1)


class IngestionArxivPaper(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., max_length=64)
    title: str | None = Field(None, max_length=512)


class IngestionSpdxLicenseConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    licenses_url: str = Field(..., max_length=2048)
    details_base_url: str | None = Field(None, max_length=2048)


class IngestionFedoraLicenseConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repo_url: str = Field(..., max_length=2048)
    common_licenses: list[str] = Field(default_factory=list, max_length=500)


class IngestionChooseALicenseConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repo: str = Field(..., max_length=256)
    branch: str | None = Field(None, max_length=128)
    licenses_path: str | None = Field(None, max_length=512)


class IngestionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str | None = Field(None, max_length=2048)
    path: str | None = Field(None, max_length=2048)
    branch: str | None = Field(None, max_length=128)
    paths: list[str] | None = Field(None, max_length=100)
    discovery: str | None = Field(None, max_length=64)
    follow_links: bool | None = None
    max_depth: int | None = Field(None, ge=0, le=25)
    max_pages: int | None = Field(None, ge=1, le=10000)
    respect_robots: bool | None = None
    min_request_interval: float | None = Field(None, ge=0, le=60)
    allowed_prefixes: list[str] | None = Field(None, max_length=200)
    blocked_prefixes: list[str] | None = Field(None, max_length=200)
    allow_blog: bool | None = None
    disallow_dotted_first_path_segment: bool | None = None
    max_sitemap_expand: int | None = Field(None, ge=1, le=10000)
    max_links_per_page: int | None = Field(None, ge=1, le=5000)
    profile: str | None = Field(None, max_length=64)
    user_agent: str | None = Field(None, max_length=256)
    format: str | None = Field(None, max_length=32)
    tags: list[str] | None = Field(None, max_length=50)
    repo: str | None = Field(None, max_length=256)
    language: str | None = Field(None, max_length=32)
    doc_id_prefix: str | None = Field(None, max_length=128)
    context_prefix: str | None = Field(None, max_length=2000)
    inline_content: str | None = Field(None, max_length=200000)
    devhub_entity_ref: str | None = Field(None, max_length=256)
    papers: list[IngestionArxivPaper] | None = Field(None, max_length=500)
    spdx: IngestionSpdxLicenseConfig | None = None
    fedora: IngestionFedoraLicenseConfig | None = None
    choosealicense: IngestionChooseALicenseConfig | None = None
    compat_path: str | None = Field(None, max_length=2048)
    synesis_meta: IngestionSynesisMeta | None = None
    discovery_report: IngestionDiscoveryReport | None = None
    preflight_at: str | None = Field(None, max_length=64)


def _config_payload(config: IngestionConfig | None) -> dict[str, Any] | None:
    return config.model_dump(exclude_none=True) if config is not None else None


def _config_validation_messages(exc: ValidationError) -> list[str]:
    messages: list[str] = []
    for err in exc.errors():
        loc = ".".join(str(part) for part in err.get("loc", ()))
        suffix = f".{loc}" if loc else ""
        messages.append(f"invalid config{suffix}: {err.get('msg', 'validation failed')}")
    return messages


def _validate_config_payload(config: dict[str, Any] | None) -> tuple[dict[str, Any] | None, list[str]]:
    if not config:
        return None, []
    try:
        return _config_payload(IngestionConfig.model_validate(config)), []
    except ValidationError as exc:
        return None, _config_validation_messages(exc)


def _normalize_handler(value: Any, *, allow_empty: bool = False) -> str | None:
    raw = "" if value is None else str(value).strip().lower()
    if not raw:
        return None if allow_empty else _DEFAULT_INGESTION_HANDLER
    if raw not in _DISCOVERY_HANDLER_VALUES:
        allowed = ", ".join(sorted(_DISCOVERY_HANDLER_VALUES))
        raise ValueError(f"handler must be one of: {allowed}")
    return raw


class SourceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    handler: str = "html_document"
    origin_type: str = "curated"
    authority: str = "vetted"
    domain: str = ""
    config: IngestionConfig | None = None
    tags: list[str] | None = None
    visibility_scope: str = "global"
    org_id: str = ""
    tenant_id: str = ""
    acl_mode: str = "open"
    acl_groups: str = ""

    def model_post_init(self, __context: Any) -> None:
        self.handler = _normalize_handler(self.handler) or _DEFAULT_INGESTION_HANDLER


class ItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    uri: str
    handler: str | None = None
    title: str = ""
    domain: str = ""
    authority: str = "vetted"
    origin_type: str = "curated"
    tags: list[str] | None = None
    visibility_scope: str = "global"
    org_id: str = ""
    tenant_id: str = ""
    acl_mode: str = "open"
    acl_groups: str = ""
    priority: int = 0
    config: IngestionConfig | None = None
    source_id: int | None = None

    def model_post_init(self, __context: Any) -> None:
        self.handler = _normalize_handler(self.handler, allow_empty=True)


class BulkImport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ItemCreate]


class StatusUpdate(BaseModel):
    status: str = Field(..., pattern="^(indexed|failed|pending|dead_letter)$")
    chunk_count: int | None = None
    error_message: str | None = None
    graph_node_id: str | None = None
    content_hash: str | None = None
    indexer_stats: dict[str, Any] | None = None


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
        "visibility_scope": r.visibility_scope,
        "org_id": r.org_id,
        "tenant_id": r.tenant_id,
        "acl_mode": r.acl_mode,
        "acl_groups": r.acl_groups,
        "priority": r.priority,
        "config": r.config,
        "status": r.status,
        "content_hash": r.content_hash,
        "chunk_count": r.chunk_count,
        "error_message": r.error_message[:200] if r.error_message else "",
        "graph_node_id": r.graph_node_id,
        "indexer_stats": r.indexer_stats,
        "retry_count": r.retry_count,
        "max_retries": r.max_retries,
        "queued_at": r.queued_at.isoformat() if r.queued_at else None,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


def _scope_clauses(model: Any, user: UserInfo) -> list[Any]:
    """Return SQLAlchemy scope clauses for the caller."""
    role = resolve_role(user)
    if role >= Role.platform_admin:
        return []
    caller_org = (user.org_id or "").strip()
    if not caller_org:
        return [model.visibility_scope == "global"]
    if role >= Role.org_admin:
        return [
            model.visibility_scope == "global",
            and_(model.visibility_scope == "org", model.org_id == caller_org),
            and_(model.visibility_scope == "tenant", model.org_id == caller_org),
            and_(model.visibility_scope == "user", model.org_id == caller_org),
            and_(model.visibility_scope == "session", model.org_id == caller_org),
        ]
    tenant_ids = [t for t in (user.tenant_ids or []) if t]
    if not tenant_ids:
        return [model.visibility_scope == "global"]
    return [
        model.visibility_scope == "global",
        and_(
            model.visibility_scope == "tenant",
            model.org_id == caller_org,
            model.tenant_id.in_(tenant_ids),
        ),
    ]


def _apply_scope_filter(query: Any, model: Any, user: UserInfo) -> Any:
    clauses = _scope_clauses(model, user)
    if not clauses:
        return query
    return query.where(or_(*clauses))


def _normalize_and_authorize_scope(
    user: UserInfo,
    *,
    visibility_scope: str,
    org_id: str,
    tenant_id: str,
    acl_mode: str = "open",
    acl_groups: str = "",
) -> tuple[str, str, str, str, str]:
    scope = (visibility_scope or "global").strip().lower()
    target_org = (org_id or "").strip()[:64]
    target_tenant = (tenant_id or "").strip()[:64]
    acl_m = (acl_mode or "open").strip().lower()[:16]
    if acl_m not in ("open", "restricted", "private"):
        raise HTTPException(status_code=400, detail="acl_mode must be one of: open, restricted, private")
    acl_g = (acl_groups or "").strip()[:1024]
    if acl_m in ("restricted", "private") and not acl_g:
        raise HTTPException(status_code=400, detail=f"acl_mode={acl_m} requires at least one acl_groups entry")
    if scope not in {"global", "org", "tenant", "user", "session"}:
        raise HTTPException(
            status_code=400,
            detail="visibility_scope must be one of: global, org, tenant, user, session",
        )
    if not can_manage_visibility_scope(
        user,
        visibility_scope=scope,
        org_id=target_org,
        tenant_id=target_tenant,
    ):
        raise HTTPException(status_code=403, detail="Not authorized for requested visibility scope")
    caller_org = (user.org_id or "").strip()[:64]
    if scope == "global":
        return scope, "", "", acl_m, acl_g
    if scope == "org":
        return scope, (target_org or caller_org), "", acl_m, acl_g
    if scope == "tenant":
        return scope, (target_org or caller_org), target_tenant, acl_m, acl_g
    # user/session currently carry owner/conversation in config payload for indexer mapping.
    return scope, (target_org or caller_org), target_tenant, acl_m, acl_g


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


@router.get("/sources")
async def list_sources(
    _user: UserInfo = Depends(require_tenant_content_operator),
    status: str = Query("", description="Filter by status"),
):
    async with async_session() as session:
        q = select(IngestionSource).order_by(IngestionSource.id.desc())
        q = _apply_scope_filter(q, IngestionSource, _user)
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
                    "visibility_scope": r.visibility_scope,
                    "org_id": r.org_id,
                    "tenant_id": r.tenant_id,
                    "acl_mode": r.acl_mode,
                    "acl_groups": r.acl_groups,
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
    _user: UserInfo = Depends(require_tenant_content_operator),
):
    vis_scope, org_id, tenant_id, norm_acl_mode, norm_acl_groups = _normalize_and_authorize_scope(
        _user,
        visibility_scope=body.visibility_scope,
        org_id=body.org_id,
        tenant_id=body.tenant_id,
        acl_mode=body.acl_mode,
        acl_groups=body.acl_groups,
    )
    async with async_session() as session:
        src = IngestionSource(
            name=body.name,
            handler=body.handler,
            origin_type=body.origin_type,
            authority=body.authority,
            domain=body.domain,
            config=_config_payload(body.config),
            tags=body.tags,
            visibility_scope=vis_scope,
            org_id=org_id,
            tenant_id=tenant_id,
            acl_mode=norm_acl_mode,
            acl_groups=norm_acl_groups,
        )
        session.add(src)
        await session.commit()
        await session.refresh(src)
        return {"ok": True, "id": src.id}


# ---------------------------------------------------------------------------
# Discovery — URL preflight (heuristic + optional LLM)
# ---------------------------------------------------------------------------


class DiscoverRequest(BaseModel):
    url: str
    hints: str = Field("", max_length=256)
    use_llm: bool = False
    model_id: str = Field("", max_length=128, pattern=_MODEL_ID_PATTERN)


def _normalize_discovery_hints(hints: str) -> str:
    raw = (hints or "").strip().lower()
    if not raw:
        return ""
    normalized: list[str] = []
    rejected: list[str] = []
    for token in re.split(r"[\s,;]+", raw):
        if not token:
            continue
        mapped = _DISCOVERY_HINT_ALIASES.get(token)
        if mapped is None:
            rejected.append(token[:64])
            continue
        if mapped not in normalized:
            normalized.append(mapped)
    if rejected:
        allowed = ", ".join(sorted(_DISCOVERY_HINT_VALUES))
        raise HTTPException(status_code=400, detail=f"hints must contain only known values: {allowed}")
    return " ".join(normalized)


def _safe_llm_text(value: Any, *, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\r\n\t<>`]+", " ", value).strip()[:limit].strip()


def _safe_llm_tag(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    tag = value.strip().lower()[:64]
    return tag if _DISCOVERY_TAG_PATTERN.fullmatch(tag) else ""


def _validated_llm_config_overrides(value: Any) -> tuple[dict[str, Any] | None, list[str]]:
    if not isinstance(value, dict):
        return None, []
    try:
        return _config_payload(IngestionConfig.model_validate(value)) or {}, []
    except ValidationError as exc:
        return None, _config_validation_messages(exc)


@router.post("/discover")
async def discover_url(
    body: DiscoverRequest,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Analyse a URL and return a suggested ingestion config draft.

    Pure heuristic by default. Optional LLM enrichment with ``use_llm=true``.
    """
    raw_url = body.url.strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="url is required")

    raw_url, _parsed = _validate_discovery_target_url(raw_url)

    normalized_hints = _normalize_discovery_hints(body.hints)
    result = await _run_heuristic_discovery(raw_url, hints=normalized_hints)

    if body.use_llm:
        import httpx

        from ..deps import INTERNAL_SERVICE_TOKEN, PLANNER_URL

        llm_model = body.model_id or os.getenv("SYNESIS_DISCOVER_MODEL", "synesis-writer")
        llm_prompt = (
            "You are a content classification assistant for a RAG ingestion system.\n"
            "Given the following URL and heuristic analysis, return a JSON object with:\n"
            '  "title": a concise human-readable title,\n'
            '  "domain": the knowledge domain (e.g. "kubernetes", "python", "networking"),\n'
            '  "tags": array of relevant taxonomy tags,\n'
            '  "handler": the recommended handler type,\n'
            '  "config_overrides": any config keys to add/override,\n'
            '  "risk_notes": any concerns about content quality or RAG suitability.\n'
            "Return ONLY valid JSON, no markdown fences.\n\n"
            f"URL: {raw_url}\n"
            f"Heuristic handler: {result['handler']}\n"
            f"Heuristic domain: {result['domain']}\n"
            f"Heuristic tags: {result['tags']}\n"
            f"Content-Type: {result.get('_content_type', '')}\n"
            f"Suggested corpus class: {result['suggested_corpus_class']}\n"
        )
        if normalized_hints:
            llm_prompt += f"User hints: {normalized_hints}\n"

        notes_parts = [result["notes"]] if result["notes"] else []
        try:
            async with httpx.AsyncClient(timeout=30.0) as llm_client:
                llm_resp = await llm_client.post(
                    f"{PLANNER_URL.rstrip('/')}/v1/chat/completions",
                    json={
                        "model": llm_model,
                        "messages": [{"role": "user", "content": llm_prompt}],
                        "max_tokens": 512,
                        "temperature": 0.2,
                    },
                    headers=(
                        {
                            "Authorization": f"Bearer {INTERNAL_SERVICE_TOKEN}",
                            "x-synesis-service-token": INTERNAL_SERVICE_TOKEN,
                            "x-synesis-service-name": "synesis-admin",
                        }
                        if INTERNAL_SERVICE_TOKEN
                        else None
                    ),
                )
                llm_resp.raise_for_status()
                llm_text = llm_resp.json()["choices"][0]["message"]["content"]
                llm_data = json.loads(llm_text)
                llm_title = _safe_llm_text(llm_data.get("title"), limit=512)
                if llm_title:
                    result["title"] = llm_title
                llm_domain = _safe_llm_tag(llm_data.get("domain"))
                if llm_domain:
                    result["domain"] = llm_domain
                if isinstance(llm_data.get("tags"), list):
                    extra_tags = [
                        tag for tag in (_safe_llm_tag(t) for t in llm_data["tags"]) if tag and tag not in result["tags"]
                    ][:20]
                    result["tags"].extend(extra_tags)
                llm_handler = _safe_llm_tag(llm_data.get("handler"))
                if llm_handler:
                    if llm_handler in _DISCOVERY_HANDLER_VALUES:
                        result["handler"] = llm_handler
                    else:
                        result["risk_flags"].append("llm_handler_rejected")
                        notes_parts.append("LLM handler recommendation rejected")
                overrides, override_errors = _validated_llm_config_overrides(llm_data.get("config_overrides"))
                if overrides is not None:
                    result["config"].update(overrides)
                elif override_errors:
                    result["risk_flags"].append("llm_config_overrides_rejected")
                    notes_parts.append("LLM config overrides rejected")
                risk_notes = _safe_llm_text(llm_data.get("risk_notes"), limit=512)
                if risk_notes:
                    notes_parts.append(f"LLM: {risk_notes}")
                result["deterministic"] = False
                result["recommendation_reasons"].append("LLM enrichment applied")
        except Exception as exc:
            notes_parts.append(f"LLM enrichment failed: {type(exc).__name__}: {str(exc)[:200]}")
            result["risk_flags"].append("llm_enrichment_failed")
        result["notes"] = "; ".join(notes_parts) if notes_parts else result["notes"]

    await record_admin_audit(
        action="ingestion.discover",
        status="success",
        summary=f"URL discovery: {raw_url}",
        detail={
            "url": raw_url,
            "handler": result["handler"],
            "risk_flags": result["risk_flags"],
            "recommended_mode": result["recommended_mode"],
            "use_llm": body.use_llm,
        },
        user=_user,
        source="admin_api",
    )

    return result


# ---------------------------------------------------------------------------
# Discovery — deterministic preview (no LLM, no DB, no auth side-effects)
# ---------------------------------------------------------------------------


class DiscoverPreviewRequest(BaseModel):
    url: str
    hints: str = Field("", max_length=256)


@router.post("/discover/preview")
async def discover_preview(
    body: DiscoverPreviewRequest,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Return a deterministic heuristic preview for a URL.

    No LLM calls, no DB writes. Returns the heuristic analysis plus
    ``suggested_corpus_class``, ``recommendation_reasons``, and
    ``required_missing_fields`` for the intake wizard.
    """
    raw_url = body.url.strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="url is required")

    raw_url, _parsed = _validate_discovery_target_url(raw_url)

    return await _run_heuristic_discovery(raw_url, hints=_normalize_discovery_hints(body.hints))


# ---------------------------------------------------------------------------
# Batch preflight discovery
# ---------------------------------------------------------------------------


class BatchPreflightRequest(BaseModel):
    status_filter: str = "pending"
    limit: int = Field(50, ge=1, le=200)
    use_llm: bool = False
    model_id: str = Field("", max_length=128, pattern=_MODEL_ID_PATTERN)
    dry_run: bool = False


@router.post("/discover/batch")
async def batch_preflight(
    body: BatchPreflightRequest,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Run heuristic (or LLM) discovery on a batch of pending items.

    With ``dry_run=true`` returns previews only — no DB writes.
    Default behaviour writes ``discovery_report`` into each item's config.
    """

    async with async_session() as session:
        q = (
            select(IngestionItem)
            .where(IngestionItem.status == body.status_filter)
            .order_by(IngestionItem.queued_at.asc())
            .limit(body.limit)
        )
        items = list((await session.execute(q)).scalars().all())

    processed = 0
    flagged = 0
    errors = 0
    previews: list[dict[str, Any]] = []

    for item in items:
        try:
            req = DiscoverRequest(
                url=item.uri,
                hints="",
                use_llm=body.use_llm,
                model_id=body.model_id,
            )
            result = await discover_url(req, _user)

            if body.dry_run:
                previews.append({"item_id": item.id, "uri": item.uri, **result})
                processed += 1
                if result.get("risk_flags"):
                    flagged += 1
                continue

            async with async_session() as session:
                db_item = await session.get(IngestionItem, item.id)
                if db_item is None:
                    continue
                cfg = dict(db_item.config or {})
                cfg["discovery_report"] = {
                    "handler": result["handler"],
                    "domain": result["domain"],
                    "title": result["title"],
                    "tags": result["tags"],
                    "risk_flags": result["risk_flags"],
                    "recommended_mode": result["recommended_mode"],
                    "notes": result["notes"],
                    "suggested_corpus_class": result.get("suggested_corpus_class", ""),
                }
                cfg["preflight_at"] = datetime.now(UTC).isoformat()
                db_item.config = cfg
                if result["risk_flags"]:
                    flagged += 1
                processed += 1
                await session.commit()
        except Exception:
            logger.warning("batch_preflight_item_error item=%d", item.id, exc_info=True)
            errors += 1

    await record_admin_audit(
        action="ingestion.discover.batch",
        status="success",
        summary=f"Batch preflight on {processed} items ({flagged} flagged, {errors} errors)",
        detail={
            "status_filter": body.status_filter,
            "processed": processed,
            "flagged": flagged,
            "errors": errors,
            "dry_run": body.dry_run,
        },
        user=_user,
        source="admin_api",
    )

    payload: dict[str, Any] = {"processed": processed, "flagged": flagged, "errors": errors}
    if body.dry_run:
        payload["previews"] = previews
    return payload


# ---------------------------------------------------------------------------
# Items — CRUD
# ---------------------------------------------------------------------------


@router.get("/items")
async def list_items(
    _user: UserInfo = Depends(require_tenant_content_operator),
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
        q = _apply_scope_filter(q, IngestionItem, _user)
        if status:
            q = q.where(IngestionItem.status == status)
        if handler:
            try:
                q = q.where(IngestionItem.handler == _normalize_handler(handler))
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
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
    _user: UserInfo = Depends(require_tenant_content_operator),
):
    """Add a single URI to the ingestion queue (dedup by uri)."""
    vis_scope, org_id, tenant_id, norm_acl_mode, norm_acl_groups = _normalize_and_authorize_scope(
        _user,
        visibility_scope=body.visibility_scope,
        org_id=body.org_id,
        tenant_id=body.tenant_id,
        acl_mode=body.acl_mode,
        acl_groups=body.acl_groups,
    )
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
                visibility_scope=vis_scope,
                org_id=org_id,
                tenant_id=tenant_id,
                acl_mode=norm_acl_mode,
                acl_groups=norm_acl_groups,
                priority=body.priority,
                config=_config_payload(body.config),
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
    _user: UserInfo = Depends(require_tenant_content_operator),
):
    """Bulk-add URIs to the ingestion queue (dedup by uri)."""
    now = datetime.now(UTC)
    added = 0
    skipped = 0
    async with async_session() as session:
        for item in body.items:
            vis_scope, org_id, tenant_id, norm_acl_mode, norm_acl_groups = _normalize_and_authorize_scope(
                _user,
                visibility_scope=item.visibility_scope,
                org_id=item.org_id,
                tenant_id=item.tenant_id,
                acl_mode=item.acl_mode,
                acl_groups=item.acl_groups,
            )
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
                    visibility_scope=vis_scope,
                    org_id=org_id,
                    tenant_id=tenant_id,
                    acl_mode=norm_acl_mode,
                    acl_groups=norm_acl_groups,
                    priority=item.priority,
                    config=_config_payload(item.config),
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
    _user: UserInfo = Depends(require_tenant_content_operator),
):
    async with async_session() as session:
        item = await session.get(IngestionItem, item_id)
        if not item:
            return {"ok": False, "error": "not_found"}
        if not can_manage_visibility_scope(
            _user,
            visibility_scope=item.visibility_scope,
            org_id=item.org_id,
            tenant_id=item.tenant_id,
        ):
            raise HTTPException(status_code=403, detail="Not authorized to delete this item")
        await session.delete(item)
        await session.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Items — Admin edit (authenticated, platform_admin)
# ---------------------------------------------------------------------------

# Statuses an admin may set directly; excludes 'running' (owned by indexer).
_ADMIN_SETTABLE_STATUSES = frozenset(
    {"pending", "failed", "dead_letter", "indexed", "staged_raw", "staged_norm", "enrich_queued"}
)


class ItemPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    handler: str | None = None
    domain: str | None = None
    authority: str | None = None
    origin_type: str | None = None
    tags: list[str] | None = None
    visibility_scope: str | None = None
    org_id: str | None = None
    tenant_id: str | None = None
    priority: int | None = None
    config: IngestionConfig | None = None
    source_id: int | None = None
    status: str | None = Field(None, description="Admin-driven status transition")

    def model_post_init(self, __context: Any) -> None:
        if self.handler is not None:
            self.handler = _normalize_handler(self.handler)


@router.patch("/items/{item_id}")
async def patch_item(
    item_id: int,
    body: ItemPatch,
    _user: UserInfo = Depends(require_platform_admin),
):
    """Edit item metadata and/or trigger a controlled status transition.

    Requires platform_admin. Does not overlap with the indexer's
    service-authenticated ``PATCH .../status`` callback.
    """
    async with async_session() as session:
        item = await session.get(IngestionItem, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")

        if body.title is not None:
            item.title = body.title
        if body.handler is not None:
            item.handler = _normalize_handler(body.handler)
        if body.domain is not None:
            item.domain = body.domain
        if body.authority is not None:
            item.authority = body.authority
        if body.origin_type is not None:
            item.origin_type = body.origin_type
        if body.tags is not None:
            item.tags = body.tags
        if body.visibility_scope is not None:
            item.visibility_scope = body.visibility_scope
        if body.org_id is not None:
            item.org_id = body.org_id
        if body.tenant_id is not None:
            item.tenant_id = body.tenant_id
        if body.priority is not None:
            item.priority = body.priority
        if body.config is not None:
            item.config = _config_payload(body.config)
        if body.source_id is not None:
            item.source_id = body.source_id

        if body.status is not None:
            if body.status not in _ADMIN_SETTABLE_STATUSES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Cannot set status to '{body.status}' — allowed: {sorted(_ADMIN_SETTABLE_STATUSES)}",
                )
            old_status = item.status
            item.status = body.status
            if body.status == "pending":
                item.error_message = ""
                item.started_at = None
                item.completed_at = None
                item.queued_at = datetime.now(UTC)
            logger.info(
                "admin_item_status_change",
                extra={"item_id": item_id, "from": old_status, "to": body.status, "user": _user.username},
            )

        await session.commit()
        await session.refresh(item)

    await record_admin_audit(
        action="ingestion.item.patch",
        status="success",
        summary=f"Edited ingestion item {item_id}",
        detail=body.model_dump(exclude_none=True),
        user=_user,
        source="admin_api",
    )
    return {"ok": True, "item": _item_dict(item)}


@router.post("/items/{item_id}/requeue")
async def requeue_item(
    item_id: int,
    reset_retries: bool = Query(False, description="Also reset retry counter"),
    _user: UserInfo = Depends(require_platform_admin),
):
    """Re-queue any item back to pending regardless of current status.

    Unlike ``/retry`` (which only works on failed/dead_letter), this allows
    re-running already-indexed or staged items.
    """
    async with async_session() as session:
        item = await session.get(IngestionItem, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        if item.status == "running":
            raise HTTPException(
                status_code=409, detail="Item is currently being processed — wait or recover stale leases first"
            )
        old_status = item.status
        item.status = "pending"
        item.error_message = ""
        item.indexer_stats = None
        item.started_at = None
        item.completed_at = None
        item.queued_at = datetime.now(UTC)
        if reset_retries:
            item.retry_count = 0
        await session.commit()

    await record_admin_audit(
        action="ingestion.item.requeue",
        status="success",
        summary=f"Requeued item {item_id} (was {old_status})",
        detail={"item_id": item_id, "old_status": old_status, "reset_retries": reset_retries},
        user=_user,
        source="admin_api",
    )
    return {"ok": True, "old_status": old_status}


# ---------------------------------------------------------------------------
# Items — Claim + Status (indexer work queue)
# ---------------------------------------------------------------------------


@router.post("/items/purge-pending")
async def purge_pending_ingestion_items(
    domain: str | None = Query(
        None,
        max_length=128,
        description="If set, only delete pending rows whose domain matches (exact, case-insensitive).",
    ),
    release_stale_running_minutes: int = Query(
        0,
        ge=0,
        le=10_080,
        description="If >0, reset items stuck in running longer than this many minutes back to pending.",
    ),
    user: UserInfo = Depends(require_platform_admin),
):
    """Delete all pending ingestion queue rows (optional domain filter).

    Use before a focused bootstrap (e.g. Go-only) so the queue indexer does not
    drain unrelated pending work. Requires **platform_admin**.

    Related child rows (``ingestion_documents``, enrich queue) cascade on delete.
    """
    now = datetime.now(UTC)
    released = 0
    deleted = 0
    async with async_session() as session:
        if release_stale_running_minutes > 0:
            cutoff = now - timedelta(minutes=release_stale_running_minutes)
            res = await session.execute(
                update(IngestionItem)
                .where(
                    IngestionItem.status == "running",
                    IngestionItem.started_at.is_not(None),
                    IngestionItem.started_at < cutoff,
                )
                .values(
                    status="pending",
                    started_at=None,
                    completed_at=None,
                    queued_at=now,
                    error_message="released_stale_running",
                )
            )
            released = res.rowcount or 0  # type: ignore[union-attr]

        stmt = delete(IngestionItem).where(IngestionItem.status == "pending")
        if domain and domain.strip():
            stmt = stmt.where(IngestionItem.domain == domain.strip().lower()[:128])
        res = await session.execute(stmt)
        deleted = res.rowcount or 0  # type: ignore[union-attr]
        await session.commit()

    await record_admin_audit(
        action="ingestion.queue.purge_pending",
        status="success",
        summary=f"Purged {deleted} pending ingestion item(s)"
        + (f" (domain filter={domain.strip()[:64]!r})" if domain and domain.strip() else ""),
        detail={
            "deleted": deleted,
            "domain_filter": (domain.strip().lower()[:128] if domain and domain.strip() else None),
            "released_stale_running": released,
            "release_stale_running_minutes": release_stale_running_minutes,
        },
        user=user,
        source="admin_api",
    )
    return {"ok": True, "deleted": deleted, "released_stale_running": released}


@router.post("/items/claim")
async def claim_item(
    response: Response,
    domain: str | None = Query(
        None,
        max_length=128,
        description="Only consider items with this domain (e.g. go). Matches bootstrap corpus domain field.",
    ),
    tag: str | None = Query(
        None,
        max_length=64,
        description="Only consider items whose tags array contains this string.",
    ),
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    """Atomically claim the next pending or retryable-failed item.

    Priority order: pending items first (by priority desc, then age),
    then failed items whose retry_count < max_retries (exponential backoff).
    Uses SELECT ... FOR UPDATE SKIP LOCKED for safe concurrent claiming.
    Returns 204 when nothing is claimable.
    Requires internal service token or platform_admin token.

    Optional ``domain`` / ``tag`` narrow the queue so a job can process a slice
    (e.g. Go corpus only) without draining the full backlog.
    """
    status_clause = or_(
        IngestionItem.status == "pending",
        (
            (IngestionItem.status == "failed")
            & (IngestionItem.retry_count < IngestionItem.max_retries)
            & (IngestionItem.completed_at <= text("NOW() - INTERVAL '1 minute' * POWER(2, COALESCE(retry_count, 0))"))
        ),
    )
    filter_parts: list[Any] = [status_clause]
    if domain and domain.strip():
        filter_parts.append(IngestionItem.domain == domain.strip().lower()[:128])
    if tag and tag.strip():
        tag_clean = tag.strip().lower()[:64]
        filter_parts.append(
            text(
                "CAST(:claim_tag AS varchar(64)) = ANY(COALESCE(ingestion_items.tags, ARRAY[]::varchar[]))"
            ).bindparams(claim_tag=tag_clean)
        )
    where_clause = and_(*filter_parts) if len(filter_parts) > 1 else filter_parts[0]

    async with async_session() as session:
        q = (
            select(IngestionItem)
            .where(where_clause)
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
        effective_visibility_scope = item.visibility_scope
        effective_org_id = item.org_id
        effective_tenant_id = item.tenant_id
        effective_acl_mode = item.acl_mode or "open"
        effective_acl_groups = item.acl_groups or ""

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
                if effective_visibility_scope == "global" and src.visibility_scope != "global":
                    effective_visibility_scope = src.visibility_scope
                if not effective_org_id and src.org_id:
                    effective_org_id = src.org_id
                if not effective_tenant_id and src.tenant_id:
                    effective_tenant_id = src.tenant_id
                if effective_acl_mode == "open" and (src.acl_mode or "open") != "open":
                    effective_acl_mode = src.acl_mode or "open"
                    effective_acl_groups = src.acl_groups or ""

        await session.commit()
        await session.refresh(item)

        payload = _item_dict(item)
        payload["effective_handler"] = effective_handler
        payload["effective_authority"] = effective_authority
        payload["effective_config"] = effective_config
        payload["effective_domain"] = effective_domain
        payload["effective_tags"] = effective_tags
        payload["effective_visibility_scope"] = effective_visibility_scope
        payload["effective_org_id"] = effective_org_id
        payload["effective_tenant_id"] = effective_tenant_id
        payload["effective_acl_mode"] = effective_acl_mode
        payload["effective_acl_groups"] = effective_acl_groups
        payload["acl_mode"] = item.acl_mode or "open"
        payload["acl_groups"] = item.acl_groups or ""
        return payload


@router.patch("/items/{item_id}/status")
async def update_item_status(
    item_id: int,
    body: StatusUpdate,
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    """Update item status after processing.

    Requires internal service token or platform_admin token.

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
        if body.graph_node_id is not None:
            item.graph_node_id = body.graph_node_id
        if body.content_hash is not None:
            item.content_hash = body.content_hash
        if body.indexer_stats is not None:
            item.indexer_stats = body.indexer_stats

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
    _user: UserInfo = Depends(require_tenant_content_operator),
):
    """Reset a failed or dead_letter item back to pending for reprocessing.

    For dead_letter items, pass reset_retries=true to clear the retry counter.
    """
    async with async_session() as session:
        item = await session.get(IngestionItem, item_id)
        if not item:
            return {"ok": False, "error": "not_found"}
        if not can_manage_visibility_scope(
            _user,
            visibility_scope=item.visibility_scope,
            org_id=item.org_id,
            tenant_id=item.tenant_id,
        ):
            raise HTTPException(status_code=403, detail="Not authorized to retry this item")
        if item.status not in ("failed", "dead_letter"):
            return {"ok": False, "error": f"cannot retry item with status '{item.status}'"}
        if item.status == "dead_letter" and not reset_retries:
            return {"ok": False, "error": "dead_letter items require reset_retries=true"}
        if reset_retries:
            item.retry_count = 0
        item.status = "pending"
        item.error_message = ""
        item.indexer_stats = None
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
    _user: UserInfo = Depends(require_org_admin),
    limit: int = Query(20, ge=1, le=100),
):
    async with async_session() as session:
        role = resolve_role(_user)
        if role >= Role.platform_admin:
            q = select(IngestionRun).order_by(IngestionRun.id.desc()).limit(limit)
        else:
            # Scope runs through their source's org/visibility
            scoped_sources = _apply_scope_filter(select(IngestionSource.id), IngestionSource, _user).subquery()
            q = (
                select(IngestionRun)
                .where(IngestionRun.source_id.in_(select(scoped_sources.c.id)))
                .order_by(IngestionRun.id.desc())
                .limit(limit)
            )
        rows = (await session.execute(q)).scalars().all()
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


@router.delete("/runs/{run_id}")
async def delete_run(
    run_id: int,
    _user: UserInfo = Depends(require_admin),
):
    async with async_session() as session:
        run = await session.get(IngestionRun, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        if run.status == "running":
            raise HTTPException(status_code=409, detail="Cannot delete a running ingestion run")
        await session.delete(run)
        await session.commit()
    return {"deleted": run_id}


@router.delete("/runs")
async def purge_runs(
    _user: UserInfo = Depends(require_admin),
    status: str = Query("", description="Optional status to purge; empty purges all non-running runs"),
    keep_latest: int = Query(0, ge=0, le=1000, description="Keep this many newest matching runs"),
):
    async with async_session() as session:
        clauses = []
        if status:
            clauses.append(IngestionRun.status == status)
        else:
            clauses.append(IngestionRun.status != "running")

        keep_ids: list[int] = []
        if keep_latest > 0:
            keep_stmt = select(IngestionRun.id).where(*clauses).order_by(IngestionRun.id.desc()).limit(keep_latest)
            keep_ids = [int(r[0]) for r in (await session.execute(keep_stmt)).all()]

        delete_stmt = delete(IngestionRun).where(*clauses)
        if keep_ids:
            delete_stmt = delete_stmt.where(IngestionRun.id.notin_(keep_ids))
        result = await session.execute(delete_stmt)
        await session.commit()

    return {"deleted": result.rowcount or 0, "status": status or "non_running", "kept": len(keep_ids)}


@router.post("/runs")
async def create_run(
    body: RunCreate,
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    """Create a new ingestion run record.

    Requires internal service token or platform_admin token.
    """
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
async def update_run(
    run_id: int,
    body: RunUpdate,
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    """Update run progress.

    Requires internal service token or platform_admin token.
    """
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
async def ingestion_stats(_user: UserInfo = Depends(require_org_admin)):
    """Summary stats for the ingestion queue, scoped to the caller's org."""
    async with async_session() as session:
        src_q = _apply_scope_filter(select(func.count()).select_from(IngestionSource), IngestionSource, _user)
        total_sources = (await session.execute(src_q)).scalar() or 0

        def _item_count(extra_where=None):
            q = _apply_scope_filter(select(func.count()).select_from(IngestionItem), IngestionItem, _user)
            if extra_where is not None:
                q = q.where(extra_where)
            return q

        total_items = (await session.execute(_item_count())).scalar() or 0
        pending = (await session.execute(_item_count(IngestionItem.status == "pending"))).scalar() or 0
        running = (await session.execute(_item_count(IngestionItem.status == "running"))).scalar() or 0
        indexed = (await session.execute(_item_count(IngestionItem.status == "indexed"))).scalar() or 0
        failed = (await session.execute(_item_count(IngestionItem.status == "failed"))).scalar() or 0
        dead_letter = (await session.execute(_item_count(IngestionItem.status == "dead_letter"))).scalar() or 0
        staged_raw = (await session.execute(_item_count(IngestionItem.status == "staged_raw"))).scalar() or 0
        staged_norm = (await session.execute(_item_count(IngestionItem.status == "staged_norm"))).scalar() or 0
        enrich_queued = (await session.execute(_item_count(IngestionItem.status == "enrich_queued"))).scalar() or 0

        chunks_q = _apply_scope_filter(
            select(func.sum(IngestionItem.chunk_count)).select_from(IngestionItem), IngestionItem, _user
        )
        total_chunks = (await session.execute(chunks_q)).scalar() or 0

        # IngestionDocument + IngestionEnrichQueue: scope via item -> source join
        role = resolve_role(_user)
        if role >= Role.platform_admin:
            staged_documents = (
                await session.execute(select(func.count()).select_from(IngestionDocument))
            ).scalar() or 0
            enrich_pending = (
                await session.execute(select(func.count()).where(IngestionEnrichQueue.status == "pending"))
            ).scalar() or 0
        else:
            # Join through item -> source for org scoping
            doc_q = (
                select(func.count())
                .select_from(IngestionDocument)
                .join(IngestionItem, IngestionDocument.ingestion_item_id == IngestionItem.id)
            )
            doc_q = _apply_scope_filter(doc_q, IngestionItem, _user)
            staged_documents = (await session.execute(doc_q)).scalar() or 0

            enrich_q = (
                select(func.count())
                .select_from(IngestionEnrichQueue)
                .join(IngestionDocument, IngestionEnrichQueue.document_id == IngestionDocument.id)
                .join(IngestionItem, IngestionDocument.ingestion_item_id == IngestionItem.id)
                .where(IngestionEnrichQueue.status == "pending")
            )
            enrich_q = _apply_scope_filter(enrich_q, IngestionItem, _user)
            enrich_pending = (await session.execute(enrich_q)).scalar() or 0

        # Semantic metrics: scope via item visibility/org
        if role >= Role.platform_admin:
            sem_sql = text("""
                SELECT
                    COUNT(*) FILTER (
                        WHERE indexer_stats IS NOT NULL
                          AND indexer_stats ? 'semantic_contract'
                    ) AS semantic_contract_items,
                    COALESCE(SUM(COALESCE(
                        NULLIF(indexer_stats->'semantic_contract'->>'chunks_enriched', '')::bigint, 0
                    )), 0) AS semantic_chunks_enriched,
                    COUNT(*) FILTER (
                        WHERE COALESCE(indexer_stats->'semantic_contract'->>'enrich_full', 'false') = 'true'
                    ) AS enrich_full_items
                FROM ingestion_items
            """)
        else:
            caller_org = (_user.org_id or "").strip()
            sem_sql = text("""
                SELECT
                    COUNT(*) FILTER (
                        WHERE indexer_stats IS NOT NULL
                          AND indexer_stats ? 'semantic_contract'
                    ) AS semantic_contract_items,
                    COALESCE(SUM(COALESCE(
                        NULLIF(indexer_stats->'semantic_contract'->>'chunks_enriched', '')::bigint, 0
                    )), 0) AS semantic_chunks_enriched,
                    COUNT(*) FILTER (
                        WHERE COALESCE(indexer_stats->'semantic_contract'->>'enrich_full', 'false') = 'true'
                    ) AS enrich_full_items
                FROM ingestion_items
                WHERE visibility_scope = 'global'
                   OR (org_id = :caller_org)
            """).bindparams(caller_org=caller_org)

        semantic_metrics = (await session.execute(sem_sql)).mappings().one()
    return {
        "total_sources": total_sources,
        "total_items": total_items,
        "pending": pending,
        "running": running,
        "indexed": indexed,
        "failed": failed,
        "dead_letter": dead_letter,
        "staged_raw": staged_raw,
        "staged_norm": staged_norm,
        "enrich_queued": enrich_queued,
        "total_chunks": total_chunks,
        "staged_documents": staged_documents,
        "enrich_queue_pending": enrich_pending,
        "semantic_contract_items": int(semantic_metrics.get("semantic_contract_items") or 0),
        "semantic_chunks_enriched": int(semantic_metrics.get("semantic_chunks_enriched") or 0),
        "enrich_full_items": int(semantic_metrics.get("enrich_full_items") or 0),
    }


# ---------------------------------------------------------------------------
# Schema sync — detect Content graph schema drift and reset stale items
# ---------------------------------------------------------------------------


class SchemaReport(BaseModel):
    collection: str = "synesis_catalog"
    schema_version: int
    reporter: str = "indexer"


@router.post("/schema-sync")
async def report_schema_version(
    body: SchemaReport,
    _principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin),
):
    """Called by the indexer after ensuring/recreating the Content graph collection.

    If the reported version differs from what's stored, all 'indexed' and
    'running' ingestion items are reset to 'pending' (since the old Content graph
    data is gone after a schema bump). This makes re-import automatic.

    Requires internal service token or platform_admin token.
    """
    now = datetime.now(UTC)
    async with async_session() as session:
        row = (
            await session.execute(select(GraphSchemaSync).where(GraphSchemaSync.collection == body.collection))
        ).scalar_one_or_none()

        if row is None:
            row = GraphSchemaSync(
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

        from sqlalchemy import delete, update

        await session.execute(delete(IngestionEnrichQueue))
        await session.execute(delete(IngestionDocument))

        result = await session.execute(
            update(IngestionItem)
            .where(
                IngestionItem.status.in_(
                    [
                        "indexed",
                        "running",
                        "failed",
                        "dead_letter",
                        "staged_raw",
                        "staged_norm",
                        "enrich_queued",
                    ]
                )
            )
            .values(
                status="pending",
                chunk_count=0,
                error_message="",
                graph_node_id="",
                indexer_stats=None,
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


SYNESIS_CATALOG_NAME = "synesis_catalog"

_GRAPH_RESET_CONFIRM_PHRASES = frozenset(
    {
        "DELETE_SYNESIS_CATALOG",
        "DELETE_CONTENT_GRAPH",
    }
)


def _graph_reset_confirm_ok(raw: str) -> bool:
    return (raw or "").strip() in _GRAPH_RESET_CONFIRM_PHRASES


class ResetCatalogRequest(BaseModel):
    """Dangerous: drops NornicDB content graph nodes. Requires exact confirm phrase."""

    confirm: str = Field(
        ...,
        description="Must be DELETE_SYNESIS_CATALOG or DELETE_CONTENT_GRAPH (after trim)",
    )
    reset_queue: bool = Field(True, description="Reset ingestion items to pending")
    recreate_now: bool = Field(
        True, description="Immediately recreate graph schema from admin at expected schema version"
    )


@router.post("/graph/reset-catalog")
async def reset_graph_catalog(
    body: ResetCatalogRequest,
    user: UserInfo = Depends(require_admin),
):
    """Drop the unified RAG collection and optionally reset the ingestion queue.

    By default, recreate happens immediately at the expected graph schema version.
    """
    if not _graph_reset_confirm_ok(body.confirm):
        raise HTTPException(
            status_code=400,
            detail='confirm must be "DELETE_SYNESIS_CATALOG" or "DELETE_CONTENT_GRAPH"',
        )
    now = datetime.now(UTC)
    drop_err = ""
    recreate_err = ""
    recreated = False
    reported_schema_version = 0
    if body.recreate_now:
        recreate_result = recreate_content_graph(SYNESIS_CATALOG_NAME)
        recreated = bool(recreate_result.get("ok"))
        if recreated:
            reported_schema_version = int(recreate_result.get("schema_version") or EXPECTED_SCHEMA_VERSION)
        if not recreated:
            recreate_err = str(recreate_result.get("error") or "unknown")[:500]
            logger.warning("graph_reset_catalog_recreate_failed", extra={"error": recreate_err})

    from sqlalchemy import delete, update

    async with async_session() as session:
        row = (
            await session.execute(select(GraphSchemaSync).where(GraphSchemaSync.collection == SYNESIS_CATALOG_NAME))
        ).scalar_one_or_none()
        if row is None:
            session.add(
                GraphSchemaSync(
                    collection=SYNESIS_CATALOG_NAME,
                    schema_version=reported_schema_version if recreated else 0,
                    last_reported_by="admin_reset",
                    last_reset_at=now,
                    updated_at=now,
                )
            )
        else:
            row.schema_version = reported_schema_version if recreated else 0
            row.last_reported_by = "admin_reset"
            row.last_reset_at = now
            row.updated_at = now

        items_reset: int = 0
        if body.reset_queue:
            await session.execute(delete(IngestionEnrichQueue))
            await session.execute(delete(IngestionDocument))
            result = await session.execute(
                update(IngestionItem)
                .where(
                    IngestionItem.status.in_(
                        [
                            "indexed",
                            "running",
                            "failed",
                            "dead_letter",
                            "staged_raw",
                            "staged_norm",
                            "enrich_queued",
                        ]
                    )
                )
                .values(
                    status="pending",
                    chunk_count=0,
                    error_message="",
                    graph_node_id="",
                    indexer_stats=None,
                    retry_count=0,
                    started_at=None,
                    completed_at=None,
                    queued_at=now,
                )
            )
            items_reset = result.rowcount  # type: ignore[union-attr]
        await session.commit()

    await record_admin_audit(
        user=user,
        source="api",
        action="ingestion.graph.reset_catalog",
        status="success" if not drop_err and not recreate_err else "partial",
        summary=f"Dropped {SYNESIS_CATALOG_NAME}; recreated={recreated}; queue_reset={body.reset_queue}",
        detail={
            "items_reset": items_reset,
            "drop_error": bool(drop_err),
            "recreate_error": bool(recreate_err),
        },
    )
    return {
        "ok": True,
        "collection": SYNESIS_CATALOG_NAME,
        "items_reset": items_reset,
        "drop_error": "drop_failed" if drop_err else None,
        "recreated": recreated,
        "recreate_error": "recreate_failed" if recreate_err else None,
        "schema_version": reported_schema_version if recreated else 0,
    }


@router.get("/schema-sync")
async def get_schema_sync(_user: UserInfo = Depends(get_current_user)):
    """Get the current content graph schema version tracked by the admin DB.

    Includes expected_version from the NornicDB graph schema service
    and upgrade_pending so the UI can show a banner when the indexer has not reported the latest
    schema yet (or the DB row is behind code).
    """
    exp = expected_graph_schema_version()
    async with async_session() as session:
        rows = (await session.execute(select(GraphSchemaSync))).scalars().all()

        syncs = []
        any_pending = False
        for r in rows:
            pending = r.schema_version < exp
            if pending:
                any_pending = True
            syncs.append(
                {
                    "collection": r.collection,
                    "schema_version": r.schema_version,
                    "expected_version": exp,
                    "upgrade_pending": pending,
                    "last_reset_at": r.last_reset_at.isoformat() if r.last_reset_at else None,
                    "last_reported_by": r.last_reported_by,
                    "updated_at": r.updated_at.isoformat() if r.updated_at else None,
                }
            )

        if not syncs:
            reported = reported_graph_schema_version()
            any_pending = reported < exp
            syncs.append(
                {
                    "collection": "content_graph",
                    "schema_version": reported,
                    "expected_version": exp,
                    "upgrade_pending": reported < exp,
                    "last_reset_at": None,
                    "last_reported_by": "nornicdb_catalog" if reported else None,
                    "updated_at": None,
                }
            )

        return {
            "expected_version": exp,
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
        "uri_hint": "GitHub owner/repo with markdown docs (e.g. vercel/ai)",
        "config_hints": {"branch": "main", "paths": ["docs/"]},
        "artifact_kind": "docs",
    },
    {
        "handler_type": "html_document",
        "label": "HTML (single page)",
        "source_type": "html",
        "uri_pattern": "https://...",
        "uri_hint": "One URL = one fetch (blogs, articles). Use web_page for multi-page docs sites.",
        "config_hints": {},
        "artifact_kind": "docs",
    },
    {
        "handler_type": "web_page",
        "label": "Web / docs (sitemap + robots)",
        "source_type": "web_page",
        "uri_pattern": "https://...",
        "uri_hint": "Seed URL; sitemap-first, robots.txt crawl-delay, then same-host BFS fallback",
        "config_hints": {
            "discovery": "sitemap_first",
            "follow_links": True,
            "max_depth": 5,
            "max_pages": 100,
            "respect_robots": True,
            "min_request_interval": 0.4,
            "allowed_prefixes": ["https://example.com/docs/section/"],
        },
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
async def list_handler_types(_user: UserInfo = Depends(get_current_user)):
    """Return supported handler types with metadata for the UI."""
    return {"handlers": HANDLER_METADATA}


# ---------------------------------------------------------------------------
# Bootstrap — import normalized YAML into the queue
# ---------------------------------------------------------------------------


def _config_canonical(config: dict | list | None) -> str:
    """Stable string for comparing handler config JSON."""
    if config is None:
        return ""
    return json.dumps(config, sort_keys=True, separators=(",", ":"), default=str)


def _tags_equal(a: list[str] | None, b: list[str] | None) -> bool:
    return list(a or []) == list(b or [])


_VALID_CORPUS_CLASSES = {"coder_enriched", "general", "hybrid"}
_VALID_CONSTRAINT_KINDS = {"hard", "guiding", "advisory"}


def _string_or_empty(v: Any, *, limit: int = 256) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    return s[:limit]


def _string_list(v: Any, *, item_limit: int = 64, max_items: int = 20) -> list[str]:
    if not isinstance(v, list):
        return []
    out: list[str] = []
    for raw in v:
        s = _string_or_empty(raw, limit=item_limit)
        if s:
            out.append(s)
        if len(out) >= max_items:
            break
    return out


def _normalize_bootstrap_meta(
    entry: dict[str, Any], config: dict[str, Any] | None
) -> tuple[dict[str, Any] | None, list[str], list[str]]:
    """Normalize optional corpus metadata into config.synesis_meta.

    This keeps ingestion backward compatible while allowing richer corpus
    annotations for downstream queue/indexer processing.
    """
    warnings: list[str] = []
    cfg: dict[str, Any] = dict(config or {})
    existing_meta = cfg.get("synesis_meta")
    meta: dict[str, Any] = dict(existing_meta) if isinstance(existing_meta, dict) else {}

    corpus_class = _string_or_empty(entry.get("corpus_class"), limit=32).lower()
    if corpus_class:
        if corpus_class not in _VALID_CORPUS_CLASSES:
            warnings.append(f"invalid corpus_class={corpus_class}")
        else:
            meta["corpus_class"] = corpus_class

    content_profile = _string_or_empty(entry.get("content_profile"), limit=32).lower()
    if content_profile:
        meta["content_profile"] = content_profile

    languages = _string_list(entry.get("languages"), item_limit=32, max_items=20)
    if languages:
        meta["languages"] = languages

    artifact_kind = _string_or_empty(entry.get("artifact_kind"), limit=32).lower()
    if artifact_kind:
        meta["artifact_kind"] = artifact_kind

    freshness_sla_days = entry.get("freshness_sla_days")
    if freshness_sla_days is not None:
        try:
            meta["freshness_sla_days"] = max(1, int(freshness_sla_days))
        except Exception:
            warnings.append(f"invalid freshness_sla_days={freshness_sla_days}")

    scope_tags = _string_list(entry.get("scope_tags"), item_limit=64, max_items=20)
    if scope_tags:
        meta["scope_tags"] = scope_tags

    for key in ("golden_path_id", "validation_recipe_id", "source_owner", "review_status", "backstage_entity_ref"):
        val = _string_or_empty(entry.get(key), limit=128 if key != "backstage_entity_ref" else 256)
        if val:
            meta[key] = val

    constraint_domain = _string_or_empty(entry.get("constraint_domain"), limit=64).lower()
    if constraint_domain:
        meta["constraint_domain"] = constraint_domain
    constraint_kind = _string_or_empty(entry.get("constraint_kind"), limit=16).lower()
    if constraint_kind:
        if constraint_kind not in _VALID_CONSTRAINT_KINDS:
            warnings.append(f"invalid constraint_kind={constraint_kind}")
        else:
            meta["constraint_kind"] = constraint_kind
    constraint_source = _string_or_empty(entry.get("constraint_source"), limit=64).lower()
    if constraint_source:
        meta["constraint_source"] = constraint_source

    if meta:
        cfg["synesis_meta"] = meta
    if cfg:
        normalized_config, errors = _validate_config_payload(cfg)
        return normalized_config, warnings, errors
    return None, warnings, []


@router.get("/bootstrap/metadata-guide")
async def bootstrap_metadata_guide(
    _user: UserInfo = Depends(get_current_user),
):
    """Enumerate accepted annotation values for the intake wizard."""
    return {
        "corpus_class": sorted(_VALID_CORPUS_CLASSES),
        "constraint_kind": sorted(_VALID_CONSTRAINT_KINDS),
        "authority": ["canonical", "vetted", "community", "untrusted"],
        "origin_type": ["curated", "official", "community", "generated"],
        "visibility_scope": ["global", "org", "tenant", "user", "session"],
        "acl_mode": ["open", "restricted", "private"],
        "artifact_kind_examples": [
            "docs",
            "api-reference",
            "tutorial",
            "blog",
            "source-code",
            "specification",
            "runbook",
            "changelog",
        ],
        "content_profile_examples": [
            "reference",
            "conceptual",
            "procedural",
            "troubleshooting",
        ],
    }


@router.post("/bootstrap/validate")
async def bootstrap_validate(
    file: UploadFile = File(...),
    _user: UserInfo = Depends(require_tenant_content_operator),
):
    """Validate a bootstrap YAML file without inserting anything.

    Returns per-item diagnostics (errors + warnings) and a normalized
    preview payload for the admin intake wizard.
    """
    content = await file.read()
    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError:
        logger.warning("bootstrap_validate_yaml_parse_failed", exc_info=True)
        return {"ok": False, "error": "YAML parse error", "items": []}

    items_list = data.get("items", [])
    if not items_list:
        return {"ok": False, "error": "No 'items' key found in YAML", "items": []}

    item_reports: list[dict[str, Any]] = []
    total_errors = 0
    total_warnings = 0

    for idx, entry in enumerate(items_list):
        item_errors: list[str] = []
        item_warnings: list[str] = []

        uri = (entry.get("uri") or "").strip()
        if not uri:
            item_errors.append("missing required field: uri")

        handler_raw = entry.get("handler")
        try:
            handler = _normalize_handler(handler_raw, allow_empty=True)
        except ValueError as exc:
            handler = ""
            item_errors.append(str(exc))
        title = entry.get("title", "") or ""
        domain = entry.get("domain", "") or ""

        if not title:
            item_warnings.append("title is empty — will be inferred from URL")
        if not domain:
            item_warnings.append("domain is empty — discovery may need to guess")

        config_raw = entry.get("config")
        if config_raw is not None and not isinstance(config_raw, dict):
            config = None
            meta_warnings = []
            config_errors = ["invalid config: expected object"]
        else:
            config, meta_warnings, config_errors = _normalize_bootstrap_meta(entry, config_raw)
        item_warnings.extend(meta_warnings)
        item_errors.extend(config_errors)

        corpus_class = _string_or_empty(entry.get("corpus_class"), limit=32).lower()
        if corpus_class and corpus_class not in _VALID_CORPUS_CLASSES:
            item_errors.append(f"invalid corpus_class: {corpus_class}")

        constraint_kind = _string_or_empty(entry.get("constraint_kind"), limit=16).lower()
        if constraint_kind and constraint_kind not in _VALID_CONSTRAINT_KINDS:
            item_errors.append(f"invalid constraint_kind: {constraint_kind}")

        raw_tags = entry.get("tags")
        tags = raw_tags if isinstance(raw_tags, list) else None

        total_errors += len(item_errors)
        total_warnings += len(item_warnings)

        meta = (config or {}).get("synesis_meta", {}) if isinstance(config, dict) else {}

        item_reports.append(
            {
                "index": idx,
                "uri": uri,
                "handler": handler,
                "title": title,
                "domain": domain,
                "tags": tags,
                "synesis_meta": meta,
                "errors": item_errors,
                "warnings": item_warnings,
            }
        )

    return {
        "ok": total_errors == 0,
        "total_items": len(items_list),
        "total_errors": total_errors,
        "total_warnings": total_warnings,
        "items": item_reports,
    }


@router.post("/bootstrap")
async def bootstrap_from_yaml(
    file: UploadFile = File(...),
    status_override: str = Query("pending", description="Status for newly inserted items (pending or indexed)"),
    upsert: bool = Query(
        False,
        description="Update existing rows by uri. Metadata-only changes keep status; handler/config changes requeue as pending.",
    ),
    _user: UserInfo = Depends(require_tenant_content_operator),
):
    """Import a normalized bootstrap YAML file into the ingestion queue.

    Default: deduplicate by URI — existing items are skipped.

    With ``upsert=true``: update existing rows. If ``handler`` or ``config`` changed,
    reset to ``pending`` and clear index fields so the indexer picks it up again.
    If only title/domain/tags/priority/authority/origin_type change, update those
    columns and leave ``status`` (and Content graph bookkeeping) unchanged.
    """
    content = await file.read()
    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError:
        logger.warning("bootstrap_import_yaml_parse_failed", exc_info=True)
        return {"ok": False, "error": "YAML parse error"}

    items_list = data.get("items", [])
    if not items_list:
        return {"ok": False, "error": "No 'items' key found in YAML"}

    now = datetime.now(UTC)
    added = 0
    skipped_empty = 0
    skipped_duplicate = 0
    skipped_invalid_config = 0
    unchanged = 0
    updated_meta = 0
    requeued = 0
    metadata_warnings = 0

    async with async_session() as session:
        for entry in items_list:
            uri = entry.get("uri", "").strip()
            if not uri:
                skipped_empty += 1
                continue

            handler_raw = entry.get("handler")
            try:
                handler = _normalize_handler(handler_raw, allow_empty=True)
            except ValueError as exc:
                logger.info("bootstrap_entry_invalid_handler", extra={"uri": uri, "error": str(exc)})
                skipped_invalid_config += 1
                continue
            title = entry.get("title", "") or ""
            domain = entry.get("domain", "") or ""
            authority = entry.get("authority", "vetted") or "vetted"
            origin_type = entry.get("origin_type", "curated") or "curated"
            raw_tags = entry.get("tags")
            tags = raw_tags if isinstance(raw_tags, list) else None
            visibility_scope = entry.get("visibility_scope", "global") or "global"
            bootstrap_org_id = entry.get("org_id", "") or ""
            bootstrap_tenant_id = entry.get("tenant_id", "") or ""
            entry_acl_mode = entry.get("acl_mode", "open") or "open"
            entry_acl_groups = entry.get("acl_groups", "") or ""
            visibility_scope, bootstrap_org_id, bootstrap_tenant_id, norm_acl_mode, norm_acl_groups = (
                _normalize_and_authorize_scope(
                    _user,
                    visibility_scope=visibility_scope,
                    org_id=bootstrap_org_id,
                    tenant_id=bootstrap_tenant_id,
                    acl_mode=entry_acl_mode,
                    acl_groups=entry_acl_groups,
                )
            )
            priority = int(entry.get("priority") or 0)
            config_raw = entry.get("config")
            if config_raw is not None and not isinstance(config_raw, dict):
                logger.info(
                    "bootstrap_entry_invalid_config",
                    extra={"uri": uri, "errors": ["invalid config: expected object"]},
                )
                skipped_invalid_config += 1
                continue
            config, entry_warnings, config_errors = _normalize_bootstrap_meta(entry, config_raw)
            if config_errors:
                logger.info("bootstrap_entry_invalid_config", extra={"uri": uri, "errors": config_errors[:5]})
                skipped_invalid_config += 1
                continue
            metadata_warnings += len(entry_warnings)
            if entry_warnings:
                logger.info(
                    "bootstrap_entry_metadata_warnings",
                    extra={"uri": uri, "warnings": entry_warnings[:5]},
                )

            if not upsert:
                stmt_ins = (
                    pg_insert(IngestionItem)
                    .values(
                        uri=uri,
                        handler=handler,
                        title=title,
                        domain=domain,
                        authority=authority,
                        origin_type=origin_type,
                        tags=tags,
                        visibility_scope=visibility_scope,
                        org_id=bootstrap_org_id,
                        tenant_id=bootstrap_tenant_id,
                        acl_mode=norm_acl_mode,
                        acl_groups=norm_acl_groups,
                        priority=priority,
                        config=config,
                        status=status_override,
                        queued_at=now if status_override == "pending" else None,
                    )
                    .on_conflict_do_nothing(index_elements=["uri"])
                )
                result = await session.execute(stmt_ins)
                if result.rowcount > 0:  # type: ignore[union-attr]
                    added += 1
                else:
                    skipped_duplicate += 1
                continue

            q = await session.execute(select(IngestionItem).where(IngestionItem.uri == uri))
            row = q.scalar_one_or_none()

            if row is None:
                session.add(
                    IngestionItem(
                        uri=uri,
                        handler=handler,
                        title=title,
                        domain=domain,
                        authority=authority,
                        origin_type=origin_type,
                        tags=tags,
                        visibility_scope=visibility_scope,
                        org_id=bootstrap_org_id,
                        tenant_id=bootstrap_tenant_id,
                        acl_mode=norm_acl_mode,
                        acl_groups=norm_acl_groups,
                        priority=priority,
                        config=config,
                        status=status_override,
                        queued_at=now if status_override == "pending" else None,
                    )
                )
                added += 1
                continue

            ingest_unchanged = (row.handler == handler) and (_config_canonical(row.config) == _config_canonical(config))
            meta_unchanged = (
                (row.title or "") == title
                and (row.domain or "") == domain
                and (row.authority or "") == authority
                and (row.origin_type or "") == origin_type
                and row.priority == priority
                and _tags_equal(row.tags, tags)
                and (row.acl_mode or "open") == norm_acl_mode
                and (row.acl_groups or "") == norm_acl_groups
            )

            if ingest_unchanged and meta_unchanged:
                unchanged += 1
                continue

            if ingest_unchanged:
                row.title = title
                row.domain = domain
                row.authority = authority
                row.origin_type = origin_type
                row.tags = tags
                row.priority = priority
                row.acl_mode = norm_acl_mode
                row.acl_groups = norm_acl_groups
                updated_meta += 1
                continue

            row.handler = handler
            row.title = title
            row.domain = domain
            row.authority = authority
            row.origin_type = origin_type
            row.tags = tags
            row.priority = priority
            row.acl_mode = norm_acl_mode
            row.acl_groups = norm_acl_groups
            row.config = config
            row.status = "pending"
            row.content_hash = None
            row.chunk_count = 0
            row.error_message = ""
            row.graph_node_id = ""
            row.indexer_stats = None
            row.retry_count = 0
            row.started_at = None
            row.completed_at = None
            row.queued_at = now
            requeued += 1

        await session.commit()

    skipped_total = skipped_empty + skipped_invalid_config + (skipped_duplicate if not upsert else 0)
    logger.info(
        "bootstrap_import",
        extra={
            "added": added,
            "skipped": skipped_total,
            "skipped_invalid_config": skipped_invalid_config,
            "metadata_warnings": metadata_warnings,
            "upsert": upsert,
            "unchanged": unchanged if upsert else None,
            "updated_meta": updated_meta if upsert else None,
            "requeued": requeued if upsert else None,
            "file": file.filename,
        },
    )
    payload: dict = {
        "ok": True,
        "added": added,
        "skipped": skipped_total,
        "upsert": upsert,
        "metadata_warnings": metadata_warnings,
        "skipped_invalid_config": skipped_invalid_config,
        "total_in_file": len(items_list),
    }
    if upsert:
        payload["unchanged"] = unchanged
        payload["updated_meta"] = updated_meta
        payload["requeued"] = requeued
    else:
        payload["skipped_duplicates"] = skipped_duplicate
    return payload
