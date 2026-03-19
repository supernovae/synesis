"""Feedback, knowledge gaps, and curator proposals."""

from __future__ import annotations

import logging
from pathlib import Path

import httpx
import yaml
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..db.models import KnowledgeGap
from ..deps import CURATOR_PROPOSALS_PATH, PLANNER_URL

logger = logging.getLogger("synesis.admin.feedback")

router = APIRouter(prefix="/api/v1/feedback", tags=["feedback"])


@router.get("/")
async def list_feedback(
    _user: UserInfo = Depends(get_current_user),
    vote: str = Query("", description="Filter: up or down"),
    limit: int = Query(100, ge=1, le=500),
):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            params = {"limit": limit}
            if vote:
                params["vote"] = vote
            resp = await client.get(
                f"{PLANNER_URL.rstrip('/')}/v1/feedback",
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            entries = data if isinstance(data, list) else data.get("entries", [])
            return {"entries": entries, "total": len(entries)}
    except Exception as exc:
        logger.warning("feedback_fetch_error error=%s", str(exc)[:80])
        return {"entries": [], "total": 0}


@router.get("/stats")
async def feedback_stats(_user: UserInfo = Depends(get_current_user)):
    result = await list_feedback(_user=_user, vote="", limit=500)
    entries = result["entries"]
    up = sum(1 for e in entries if e.get("vote") == "up")
    down = sum(1 for e in entries if e.get("vote") == "down")
    return {"up": up, "down": down, "total": len(entries)}


@router.get("/knowledge-gaps")
async def knowledge_gaps(
    _user: UserInfo = Depends(get_current_user),
    domain: str = Query("", description="Filter by domain"),
    status: str = Query("", description="Filter by status: open, resolved, reopened"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """List knowledge gaps from Postgres (canonical store)."""
    offset = (page - 1) * page_size
    async with async_session() as session:
        base = select(KnowledgeGap)
        if domain:
            base = base.where(KnowledgeGap.platform_context == domain)
        if status:
            base = base.where(KnowledgeGap.status == status)

        total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
        stmt = base.order_by(KnowledgeGap.timestamp.desc()).offset(offset).limit(page_size)
        result = await session.execute(stmt)
        rows = result.scalars().all()

    gaps = [
        {
            "chunk_id": g.gap_id,
            "gap_id": g.gap_id,
            "query": g.query,
            "task_description": g.task_description,
            "max_score": g.max_score,
            "platform_context": g.platform_context,
            "language": g.language,
            "status": g.status,
            "resolved_by": g.resolved_by,
            "resolution_note": g.resolution_note,
            "timestamp": g.timestamp,
        }
        for g in rows
    ]
    return {"gaps": gaps, "total": total}


class KnowledgeSubmit(BaseModel):
    domain: str
    content: str


@router.post("/knowledge-gaps/submit")
async def submit_knowledge(
    req: KnowledgeSubmit,
    _user: UserInfo = Depends(require_admin),
):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{PLANNER_URL.rstrip('/')}/v1/knowledge/submit",
            json={"domain": req.domain.strip() or "generalist", "content": req.content.strip()},
        )
        resp.raise_for_status()
        return {"status": "submitted"}


def _load_curator_proposals() -> list[dict]:
    if not CURATOR_PROPOSALS_PATH:
        return []
    p = Path(CURATOR_PROPOSALS_PATH)
    if not p.exists():
        return []
    try:
        raw = yaml.safe_load(p.read_text()) or {}
        proposals = []
        for i, prop in enumerate(raw.get("proposals", [])):
            for src in prop.get("sources", []):
                proposals.append(
                    {
                        "id": f"{prop.get('domain', 'unk')}_{i}_{src.get('name', '')[:20]}",
                        "domain": prop.get("domain", ""),
                        "path": prop.get("path", ""),
                        "source_name": src.get("name", ""),
                        "handler": src.get("handler", ""),
                        "url": src.get("config", {}).get("url", ""),
                        "quality_score": src.get("_curator_metadata", {}).get("quality_score", 0),
                        "rationale": src.get("_curator_metadata", {}).get("rationale", ""),
                        "status": "pending",
                    }
                )
        return proposals
    except Exception as exc:
        logger.warning("curator_load_error error=%s", str(exc)[:80])
        return []


@router.get("/curator")
async def curator_proposals(_user: UserInfo = Depends(get_current_user)):
    return {"proposals": _load_curator_proposals()}


@router.post("/curator/{proposal_id}/approve")
async def approve_proposal(
    proposal_id: str,
    _user: UserInfo = Depends(require_admin),
):
    return {"status": "approved", "id": proposal_id}


@router.post("/curator/{proposal_id}/reject")
async def reject_proposal(
    proposal_id: str,
    _user: UserInfo = Depends(require_admin),
):
    return {"status": "rejected", "id": proposal_id}
