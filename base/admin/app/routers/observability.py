"""Observability: health, cache, circuit breakers, failures."""

from fastapi import APIRouter, Depends, Query

from ..auth import UserInfo, get_current_user
from ..deps import FAILURES_COLLECTION
from ..services import prometheus_client_svc as prom
from ..services.health_prober import probe_all
from ..services.milvus_service import safe_query

router = APIRouter(prefix="/api/v1/observability", tags=["observability"])


@router.get("/health")
async def service_health(_user: UserInfo = Depends(get_current_user)):
    services = await probe_all()
    return {"services": services}


@router.get("/cache")
async def cache_metrics(_user: UserInfo = Depends(get_current_user)):
    return await prom.get_cache_metrics()


@router.get("/circuit-breakers")
async def circuit_breakers(_user: UserInfo = Depends(get_current_user)):
    breakers = await prom.get_circuit_breaker_metrics()
    return {"breakers": breakers}


@router.get("/failures")
async def failure_list(
    _user: UserInfo = Depends(get_current_user),
    language: str = Query("", description="Filter by language"),
    error_type: str = Query("", description="Filter by error type"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    parts = []
    if language:
        parts.append(f'language == "{language}"')
    if error_type:
        parts.append(f'error_type == "{error_type}"')
    filter_expr = " and ".join(parts)
    offset = (page - 1) * page_size
    failures = safe_query(
        FAILURES_COLLECTION,
        filter_expr=filter_expr,
        output_fields=[
            "failure_id",
            "code",
            "error_output",
            "exit_code",
            "error_type",
            "language",
            "task_description",
            "resolution",
            "timestamp",
        ],
        limit=page_size,
        offset=offset,
    )
    return {"failures": failures, "total": len(failures)}


@router.get("/failures/stats")
async def failure_stats(_user: UserInfo = Depends(get_current_user)):
    all_failures = safe_query(
        FAILURES_COLLECTION,
        output_fields=["error_type", "language", "resolution"],
        limit=10000,
    )
    total = len(all_failures)
    by_language: dict[str, int] = {}
    by_error_type: dict[str, int] = {}
    resolved = 0
    for f in all_failures:
        lang = f.get("language", "unknown")
        etype = f.get("error_type", "unknown")
        by_language[lang] = by_language.get(lang, 0) + 1
        by_error_type[etype] = by_error_type.get(etype, 0) + 1
        if f.get("resolution"):
            resolved += 1
    return {
        "total_failures": total,
        "resolved": resolved,
        "unresolved": total - resolved,
        "by_language": by_language,
        "by_error_type": by_error_type,
    }


@router.get("/failures/{failure_id}")
async def failure_detail(
    failure_id: str,
    _user: UserInfo = Depends(get_current_user),
):
    results = safe_query(
        FAILURES_COLLECTION,
        filter_expr=f'failure_id == "{failure_id}"',
        output_fields=[
            "failure_id",
            "code",
            "error_output",
            "exit_code",
            "error_type",
            "language",
            "task_description",
            "resolution",
            "timestamp",
        ],
        limit=1,
    )
    if results:
        return results[0]
    return {"error": "not found"}
