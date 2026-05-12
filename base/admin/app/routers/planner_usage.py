"""Planner usage log ingest (service token) — metering without traces."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Request

from ..internal_auth import require_internal_service_token_request
from ..services.planner_usage_service import upsert_metering_row

logger = logging.getLogger("synesis.admin.planner_usage_router")

router = APIRouter(prefix="/api/v1/planner/usage", tags=["planner-usage"])


@router.post("/metering")
async def ingest_planner_metering(request: Request, body: dict[str, Any] = Body(...)):
    """Accept one planner pipeline metering row from planner-ts (fire-and-forget)."""
    require_internal_service_token_request(request)
    await upsert_metering_row(body)
    rid = (body.get("request_id") or body.get("trace_id") or "")[:64]
    return {"status": "ok", "request_id": rid}
