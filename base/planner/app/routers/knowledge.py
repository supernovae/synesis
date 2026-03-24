"""Platform utility APIs for Synesis knowledge catalog (search + ingest).

These endpoints are **not** LangGraph graph nodes and are **not** OpenAI-compatible
chat endpoints.  They exist on the planner service because the planner already
manages Milvus connectivity (pool init, keepalive).  MCP tools and the admin UI
consume them for direct catalog access.

Architecture note: as the platform grows these may warrant extraction to a
dedicated knowledge-service so the planner image stays focused on the LangGraph
pipeline.  The module is self-contained to make that move straightforward.

Retrieval uses ``retrieve_multi_query_fused`` — the same primitive the Router
node uses — so MCP search results benefit from the same hybrid search, RRF
merge, and reranking quality as the pipeline.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import settings
from ..injection_scanner import scan_text
from ..rag_client import build_metadata_filter, retrieve_multi_query_fused, submit_user_knowledge

logger = logging.getLogger("synesis.knowledge")

router = APIRouter()
_scope_resolver: Callable[[Request], Awaitable[tuple[str, list[str]]]] | None = None


def set_knowledge_scope_resolver(
    resolver: Callable[[Request], Awaitable[tuple[str, list[str]]]],
) -> None:
    """Configure auth scope resolver from the planner API layer."""
    global _scope_resolver
    _scope_resolver = resolver


async def _require_scope(request: Request) -> tuple[str, list[str]]:
    if _scope_resolver is None:
        raise HTTPException(status_code=503, detail="Knowledge auth scope resolver is not configured")
    org_id, tenant_ids = await _scope_resolver(request)
    return (org_id or "").strip()[:128], [t.strip()[:64] for t in (tenant_ids or []) if t.strip()][:50]


class KnowledgeSearchRequest(BaseModel):
    """Label-scoped RAG search against the Synesis catalog."""

    query: str = Field(..., min_length=1, description="Search query")
    top_k: int = Field(default=5, ge=1, le=50, description="Number of results")
    language: str = Field(default="", description="Filter by language (e.g. python, go, rust)")
    artifact_kind: str = Field(default="", description="Filter by artifact kind (code, docs, config, api_spec)")
    domain: str = Field(default="", description="Filter by taxonomy domain (e.g. python, kubernetes)")
    repo_path: str = Field(default="", description="Filter by repository (e.g. owner/repo)")
    tags: str = Field(default="", description="Filter by tag substring (e.g. async, web)")
    content_format: str = Field(default="", description="Filter by content format (e.g. python, yaml)")


class KnowledgeSubmitRequest(BaseModel):
    """User-submitted knowledge to fill gaps. Self-heal flow."""

    domain: str = Field(..., description="Domain (e.g. openshift, python, generalist)")
    content: str = Field(..., min_length=1, description="Markdown or plain text content")
    visibility_scope: str = Field(default="global", description="Visibility tier: global, org, or tenant")
    tenant_id: str = Field(default="", description="Tenant ID (required for tenant scope)")


@router.post("/v1/knowledge/submit")
async def knowledge_submit(req: KnowledgeSubmitRequest, scope: tuple[str, list[str]] = Depends(_require_scope)):
    """Submit user knowledge to synesis_catalog. Fills gaps from knowledge backlog review."""
    caller_org_id, caller_tenant_ids = scope
    content = req.content.strip()
    if settings.injection_scan_enabled:
        result = scan_text(content, source="user_knowledge_submit")
        if result.detected:
            logger.warning(
                "knowledge_submit_injection_blocked",
                extra={"patterns": result.patterns_found[:5]},
            )
            raise HTTPException(status_code=422, detail="Content rejected: potential prompt injection detected")
    visibility_scope = (req.visibility_scope or "global").strip().lower()
    if visibility_scope not in {"global", "org", "tenant"}:
        raise HTTPException(status_code=400, detail="visibility_scope must be one of: global, org, tenant")

    tenant_id = (req.tenant_id or "").strip()[:64]
    if visibility_scope in {"org", "tenant"} and not caller_org_id:
        raise HTTPException(status_code=403, detail="Org-scoped submit requires authenticated org context")
    if visibility_scope == "tenant":
        if not tenant_id:
            raise HTTPException(status_code=400, detail="tenant_id is required when visibility_scope=tenant")
        if tenant_id not in set(caller_tenant_ids):
            raise HTTPException(status_code=403, detail="tenant_id is outside caller scope")

    chunk_id = await submit_user_knowledge(
        domain=req.domain.strip() or "generalist",
        content=content,
        source="user_submitted",
        visibility_scope=visibility_scope,
        org_id=caller_org_id if visibility_scope in {"org", "tenant"} else "",
        tenant_id=tenant_id if visibility_scope == "tenant" else "",
    )
    if chunk_id:
        return {"chunk_id": chunk_id, "status": "ingested"}
    raise HTTPException(status_code=500, detail="Failed to submit knowledge")


@router.post("/v1/knowledge/search")
async def knowledge_search(req: KnowledgeSearchRequest, scope: tuple[str, list[str]] = Depends(_require_scope)):
    """Label-scoped RAG search — Milvus pre-filtered by metadata signals.

    Supports filtering by language, artifact_kind, domain, repo_path, tags,
    and content_format.  Used by MCP tools (synesis_search, synesis_code_search,
    etc.) to give coding agents targeted corpus access.
    """
    caller_org_id, caller_tenant_ids = scope
    domain_filter = ""
    if req.domain:
        safe = req.domain.replace('"', "")[:64]
        domain_filter = f'domain == "{safe}"'

    filter_expr = build_metadata_filter(
        language=req.language,
        artifact_kind=req.artifact_kind,
        repo_path=req.repo_path,
        domain_filter=domain_filter,
        tags=req.tags,
        content_format=req.content_format,
        caller_org_id=caller_org_id,
        caller_tenant_ids=caller_tenant_ids or None,
    )

    try:
        results = await retrieve_multi_query_fused(
            queries=[req.query],
            final_top_k=req.top_k,
            domain_filter=filter_expr,
        )
    except Exception as e:
        logger.warning("knowledge_search_failed", extra={"error": str(e)[:200]})
        raise HTTPException(status_code=502, detail="Search backend unavailable") from e

    return {
        "results": [
            {
                "text": r.text,
                "source": r.source,
                "source_url": r.source_url,
                "document_name": r.document_name,
                "domain": r.domain,
                "language": r.language,
                "artifact_kind": r.artifact_kind,
                "repo_path": r.repo_path,
                "module_path": r.module_path,
                "symbol_name": r.symbol_name,
                "heading_path": r.heading_path,
                "authority": r.authority,
                "handler": r.handler,
                "source_type": r.source_type,
                "rrf_score": r.rrf_score,
                "rerank_score": r.rerank_score,
            }
            for r in results
        ],
        "count": len(results),
        "filters_applied": filter_expr or "(none)",
    }
