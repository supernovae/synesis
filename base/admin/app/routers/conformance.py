"""Conformance tracking API: rollup summaries, history, and manual scrape trigger."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import UserInfo, get_current_user
from ..rbac import RouteGroup, can_access_route_group, require_platform_admin
from ..services import conformance_tracker

logger = logging.getLogger("synesis.admin.conformance")

router = APIRouter(prefix="/api/v1/conformance", tags=["conformance"])


def _ensure_observability(user: UserInfo) -> None:
    if not can_access_route_group(user, RouteGroup.org_observability):
        raise HTTPException(status_code=403, detail="Requires route group access: org_observability")


@router.get("/summary")
async def conformance_summary(
    _user: UserInfo = Depends(get_current_user),
):
    """Latest per-language conformance with deltas vs previous scrape."""
    _ensure_observability(_user)
    return await conformance_tracker.get_conformance_summary()


@router.get("/history")
async def conformance_history(
    language: str = Query("_global", description="Language pack name or _global"),
    limit: int = Query(100, ge=1, le=1000),
    _user: UserInfo = Depends(get_current_user),
):
    """Time-series rollups for dashboard charts."""
    _ensure_observability(_user)
    data = await conformance_tracker.get_conformance_history(language=language, limit=limit)
    return {"language": language, "rollups": data, "total": len(data)}


@router.post("/scrape")
async def trigger_scrape(
    _user: UserInfo = Depends(require_platform_admin),
):
    """Manually trigger a Yarn telemetry scrape (platform-admin only)."""
    result = await conformance_tracker.scrape_yarn_telemetry()
    if result.get("status") == "error":
        logger.warning("conformance_scrape_failed", extra={"status": result.get("status")})
        raise HTTPException(status_code=502, detail="Scrape failed")
    return result
