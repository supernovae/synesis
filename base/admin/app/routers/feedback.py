"""Feedback, knowledge gaps, and curator proposals."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import httpx
import yaml
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..db.models import FeedbackReview, KnowledgeGap, OpenWebUIFeedback
from ..deps import (
    CURATOR_PROPOSALS_PATH,
    OPENWEBUI_ADMIN_TOKEN,
    OPENWEBUI_URL,
    PLANNER_URL,
)

logger = logging.getLogger("synesis.admin.feedback")

router = APIRouter(prefix="/api/v1/feedback", tags=["feedback"])


def _coerce_openwebui_feedback_export(raw: Any) -> list[Any]:
    """Open WebUI usually returns a JSON array; some versions may wrap the list."""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in ("data", "feedbacks", "items", "results", "entries"):
            inner = raw.get(key)
            if isinstance(inner, list):
                return inner
    return []


def _openwebui_export_payload_ok(raw: Any) -> bool:
    """True if JSON looks like a feedback export (including empty [])."""
    if isinstance(raw, list):
        return True
    if isinstance(raw, dict):
        return any(isinstance(raw.get(k), list) for k in ("data", "feedbacks", "items", "results", "entries"))
    return False


def _parse_planner_feedback_payload(data: Any) -> list[dict[str, Any]]:
    """Planner returns {\"object\": \"list\", \"data\": [...]} — admin used to read \"entries\" only."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        inner = data.get("data")
        if isinstance(inner, list):
            return inner
        legacy = data.get("entries")
        if isinstance(legacy, list):
            return legacy
    return []


def _extract_run_id(obj: Any) -> str | None:
    if isinstance(obj, dict):
        rid = obj.get("run_id")
        if isinstance(rid, str) and rid.strip():
            return rid.strip()
        # Open WebUI stores planner trace on assistant message (middleware upsert)
        syn = obj.get("synesis_run_id")
        if isinstance(syn, str) and syn.strip():
            return syn.strip()
        for v in obj.values():
            found = _extract_run_id(v)
            if found:
                return found
    elif isinstance(obj, list):
        for x in obj:
            found = _extract_run_id(x)
            if found:
                return found
    return None


def _owui_snippets(meta: dict[str, Any], snapshot: dict[str, Any]) -> tuple[str, str]:
    """Best-effort prompt/response text from Open WebUI snapshot (see FeedbackModal.svelte)."""
    try:
        hist = snapshot.get("chat", {}) if isinstance(snapshot.get("chat"), dict) else {}
        inner = hist.get("chat", {}) if isinstance(hist.get("chat"), dict) else {}
        messages = inner.get("history", {}).get("messages", {}) if isinstance(inner.get("history"), dict) else {}
        if not isinstance(messages, dict):
            messages = {}
        mid = meta.get("message_id")
        if not mid and isinstance(snapshot.get("message_id"), str):
            mid = snapshot.get("message_id")
        if not isinstance(messages, dict) or not mid:
            # Fallback: some exports only store flat preview text
            p = snapshot.get("prompt") or snapshot.get("user_message") or meta.get("prompt")
            r = snapshot.get("response") or snapshot.get("assistant_message") or meta.get("response")
            return (str(p or "")[:2000], str(r or "")[:2000])
        msg = messages.get(mid) or {}
        parent_id = msg.get("parentId") or msg.get("parent_id")
        prompt = ""
        if parent_id and messages.get(parent_id):
            prompt = str((messages[parent_id] or {}).get("content") or "")[:2000]
        response = str(msg.get("content") or "")[:2000]
        return prompt, response
    except Exception:
        return "", ""


def _owui_rating_to_vote(data: dict[str, Any] | None) -> str:
    """Map Open WebUI evaluation payload to up/down (OWUI versions differ on shape)."""
    if not data:
        return ""
    inner = data.get("details") if isinstance(data.get("details"), dict) else data
    if not isinstance(inner, dict):
        inner = data
    r = inner.get("rating")
    if r is None:
        r = data.get("rating")
    if isinstance(r, bool):
        return "up" if r else "down"
    if isinstance(r, (int, float)):
        if r > 0:
            return "up"
        if r < 0:
            return "down"
    s = str(r).strip().lower() if r is not None else ""
    if s in ("1", "1.0") or r == 1:
        return "up"
    if s in ("-1", "-1.0") or r == -1:
        return "down"
    if s in ("positive", "up", "like", "thumbs_up", "good"):
        return "up"
    if s in ("negative", "down", "dislike", "thumbs_down", "bad"):
        return "down"
    return ""


def _planner_subject_key(run_id: str, message_id: str) -> str:
    return f"planner:{run_id}:{message_id}"[:512]


def _openwebui_subject_key(owui_id: str) -> str:
    return f"openwebui:{owui_id}"[:512]


def _parse_ts(ts: str) -> float:
    try:
        if not ts:
            return 0.0
        s = ts
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return 0.0


async def _fetch_planner_feedback(vote: str, limit: int) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        params: dict[str, Any] = {"limit": min(limit, 500)}
        if vote:
            params["vote"] = vote
        resp = await client.get(f"{PLANNER_URL.rstrip('/')}/v1/feedback", params=params)
        resp.raise_for_status()
        return _parse_planner_feedback_payload(resp.json())


async def _load_openwebui_rows(limit: int) -> list[OpenWebUIFeedback]:
    async with async_session() as session:
        stmt = select(OpenWebUIFeedback).order_by(OpenWebUIFeedback.created_at_epoch.desc()).limit(limit)
        result = await session.execute(stmt)
        return list(result.scalars().all())


async def _load_reviews(keys: list[str]) -> dict[str, FeedbackReview]:
    if not keys:
        return {}
    async with async_session() as session:
        stmt = select(FeedbackReview).where(FeedbackReview.subject_key.in_(keys))
        result = await session.execute(stmt)
        rows = result.scalars().all()
    return {r.subject_key: r for r in rows}


def _unified_from_planner(row: dict[str, Any]) -> dict[str, Any]:
    run_id = str(row.get("run_id") or "")
    message_id = str(row.get("message_id") or "")
    sk = _planner_subject_key(run_id, message_id)
    return {
        "id": sk,
        "source": "planner",
        "vote": row.get("vote") or "",
        "user_id": row.get("user_id") or "",
        "model": row.get("model") or "",
        "message_snippet": (row.get("message_snippet") or "")[:500],
        "response_snippet": (row.get("response_snippet") or "")[:500],
        "classification_reasons": row.get("classification_reasons") or [],
        "task_size": row.get("task_size") or "",
        "timestamp": row.get("timestamp") or "",
        "run_id": run_id,
        "message_id": message_id,
        "trace_href": f"/traces/{run_id}" if run_id else None,
        "feedback_type": "",
        "reason": "",
        "user_comment": "",
        "tags": [],
        "review_status": "pending",
        "internal_note": "",
        "updated_by": "",
        "_sort_ts": _parse_ts(str(row.get("timestamp") or "")),
        "_subject_key": sk,
    }


def _unified_from_openwebui(row: OpenWebUIFeedback) -> dict[str, Any]:
    sk = _openwebui_subject_key(row.owui_id)
    data = row.data if isinstance(row.data, dict) else {}
    meta = row.meta if isinstance(row.meta, dict) else {}
    snapshot = row.snapshot if isinstance(row.snapshot, dict) else {}
    prompt, response = _owui_snippets(meta, snapshot)
    vote = _owui_rating_to_vote(data)
    run_id = _extract_run_id(snapshot) or _extract_run_id(meta) or ""
    ow_message_id = str(meta.get("message_id") or "")
    tags = data.get("tags") if isinstance(data.get("tags"), list) else []
    tags_s = [str(t) for t in tags][:20]
    reason = str(data.get("reason") or "")
    comment = str(data.get("comment") or "")
    ts_iso = (
        datetime.fromtimestamp(row.created_at_epoch, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        if row.created_at_epoch
        else ""
    )
    return {
        "id": sk,
        "source": "openwebui",
        "vote": vote,
        "user_id": row.user_id,
        "model": str(data.get("model_id") or ""),
        "message_snippet": (prompt or "")[:500],
        "response_snippet": (response or "")[:500],
        "classification_reasons": [],
        "task_size": "",
        "timestamp": ts_iso,
        "run_id": run_id,
        "message_id": ow_message_id,
        "trace_href": f"/traces/{run_id}" if run_id else None,
        "feedback_type": row.feedback_type,
        "reason": reason[:500],
        "user_comment": comment[:2000],
        "tags": tags_s,
        "review_status": "pending",
        "internal_note": "",
        "updated_by": "",
        "_sort_ts": float(row.created_at_epoch or 0),
        "_subject_key": sk,
        "owui_id": row.owui_id,
        "chat_id": str(meta.get("chat_id") or ""),
    }


@router.get("")
async def list_feedback(
    _user: UserInfo = Depends(get_current_user),
    vote: str = Query("", description="Filter: up or down"),
    source: str = Query("all", description="all | planner | openwebui"),
    review_status: str = Query("", description="pending | reviewed | closed"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=10_000),
):
    fetch_limit = min(500, max(limit + offset, limit))
    planner_rows: list[dict[str, Any]] = []
    try:
        planner_rows = await _fetch_planner_feedback("", fetch_limit)
    except Exception as exc:
        logger.warning("feedback_planner_fetch_error error=%s", str(exc)[:120])

    owui_rows: list[OpenWebUIFeedback] = []
    try:
        owui_rows = await _load_openwebui_rows(fetch_limit)
    except Exception as exc:
        logger.warning("feedback_openwebui_load_error error=%s", str(exc)[:120])

    unified: list[dict[str, Any]] = []
    if source in ("all", "planner"):
        for r in planner_rows:
            unified.append(_unified_from_planner(r))
    if source in ("all", "openwebui"):
        for r in owui_rows:
            unified.append(_unified_from_openwebui(r))

    keys = [e["_subject_key"] for e in unified]
    reviews = await _load_reviews(keys)
    for e in unified:
        sk = e["_subject_key"]
        rev = reviews.get(sk)
        if rev:
            e["review_status"] = rev.status
            e["internal_note"] = rev.internal_note
            e["updated_by"] = rev.updated_by

    if vote in ("up", "down"):
        unified = [e for e in unified if e.get("vote") == vote]

    if review_status in ("pending", "reviewed", "closed"):
        unified = [e for e in unified if e.get("review_status") == review_status]

    unified.sort(key=lambda x: x.get("_sort_ts") or 0.0, reverse=True)
    total_count = len(unified)
    sliced = unified[offset : offset + limit]
    for e in sliced:
        e.pop("_sort_ts", None)
        e.pop("_subject_key", None)

    return {"entries": sliced, "total": total_count}


@router.get("/stats")
async def feedback_stats(_user: UserInfo = Depends(get_current_user)):
    result = await list_feedback(_user=_user, vote="", source="all", review_status="", limit=500, offset=0)
    entries = result["entries"]
    up = sum(1 for e in entries if e.get("vote") == "up")
    down = sum(1 for e in entries if e.get("vote") == "down")
    return {"up": up, "down": down, "total": len(entries)}


class WorkspaceUpdate(BaseModel):
    source: Literal["planner", "openwebui"]
    run_id: str = ""
    message_id: str = ""
    owui_id: str = ""
    review_status: Literal["pending", "reviewed", "closed"] = "pending"
    internal_note: str = Field("", max_length=8000)


@router.patch("/workspace")
async def patch_feedback_workspace(
    body: WorkspaceUpdate,
    user: UserInfo = Depends(require_admin),
):
    if body.source == "planner":
        if not body.run_id.strip() or not body.message_id.strip():
            raise HTTPException(status_code=400, detail="run_id and message_id required for planner")
        sk = _planner_subject_key(body.run_id.strip(), body.message_id.strip())
    else:
        if not body.owui_id.strip():
            raise HTTPException(status_code=400, detail="owui_id required for openwebui")
        sk = _openwebui_subject_key(body.owui_id.strip())

    now = datetime.now(UTC)
    async with async_session() as session:
        row = await session.get(FeedbackReview, sk)
        if row is None:
            row = FeedbackReview(subject_key=sk)
            session.add(row)
        row.status = body.review_status
        row.internal_note = body.internal_note.strip()
        row.updated_by = user.username
        row.updated_at = now
        await session.commit()
    return {"status": "ok", "subject_key": sk}


async def _upsert_openwebui_feedback_rows(items: list[Any]) -> int:
    n = 0
    async with async_session() as session:
        for row in items:
            if not isinstance(row, dict):
                continue
            owui_id = str(row.get("id") or "").strip()
            if not owui_id:
                continue
            existing = await session.get(OpenWebUIFeedback, owui_id)
            blob = OpenWebUIFeedback(
                owui_id=owui_id,
                user_id=str(row.get("user_id") or ""),
                feedback_type=str(row.get("type") or ""),
                data=row.get("data") if isinstance(row.get("data"), dict) else {},
                meta=row.get("meta") if isinstance(row.get("meta"), dict) else {},
                snapshot=row.get("snapshot") if isinstance(row.get("snapshot"), dict) else {},
                created_at_epoch=int(row.get("created_at") or 0),
                updated_at_epoch=int(row.get("updated_at") or 0),
            )
            if existing:
                existing.user_id = blob.user_id
                existing.feedback_type = blob.feedback_type
                existing.data = blob.data
                existing.meta = blob.meta
                existing.snapshot = blob.snapshot
                existing.created_at_epoch = blob.created_at_epoch
                existing.updated_at_epoch = blob.updated_at_epoch
            else:
                session.add(blob)
            n += 1
        await session.commit()
    return n


@router.post("/sync-openwebui")
async def sync_openwebui_feedback(_user: UserInfo = Depends(require_admin)):
    base = OPENWEBUI_URL.rstrip("/")
    token = OPENWEBUI_ADMIN_TOKEN
    if not base or not token:
        raise HTTPException(
            status_code=400,
            detail="Configure SYNESIS_OPENWEBUI_URL and SYNESIS_OPENWEBUI_ADMIN_TOKEN on synesis-admin",
        )
    export_url = f"{base}/api/v1/evaluations/feedbacks/all/export"
    fallback_url = f"{base}/api/v1/evaluations/feedbacks/all"
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.get(
                export_url,
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code == 404:
                logger.info("openwebui_sync_fallback export 404, trying /feedbacks/all")
                resp = await client.get(
                    fallback_url,
                    headers={"Authorization": f"Bearer {token}"},
                )
            resp.raise_for_status()
            raw = resp.json()
            if not _openwebui_export_payload_ok(raw):
                raise HTTPException(
                    status_code=502,
                    detail=(
                        "Open WebUI export returned unexpected JSON (expected a list or an object "
                        "with a list under data/feedbacks/items/results/entries). "
                        "Check Open WebUI version vs docs/FEEDBACK_API.md."
                    ),
                )
            items = _coerce_openwebui_feedback_export(raw)
    except httpx.HTTPStatusError as exc:
        err_body = (exc.response.text or "")[:500]
        logger.warning(
            "openwebui_sync_http status=%s body=%s",
            exc.response.status_code,
            err_body[:200],
        )
        detail = f"Open WebUI export failed: HTTP {exc.response.status_code}"
        if exc.response.status_code == 401:
            detail += (
                ". Authentication failed — the Bearer token is invalid or expired. "
                "Regenerate an API key in Open WebUI (Account → API keys) or obtain a fresh JWT via "
                "POST /api/v1/auths/signin, then update Kubernetes Secret synesis-openwebui-admin-token "
                "(or redeploy with SYNESIS_OPENWEBUI_ADMIN_TOKEN set)."
            )
        elif exc.response.status_code == 403 and "API key" in err_body and "not enabled" in err_body:
            detail += (
                ". Open WebUI rejected the sk- API key: set ENABLE_API_KEYS=true on the "
                "open-webui Deployment and rollout restart, or use a JWT from POST /api/v1/auths/signin "
                "instead of an API key."
            )
        elif exc.response.status_code == 403:
            detail += (
                ". Forbidden — evaluations export requires an admin-capable token (admin user API key or "
                "admin JWT). A non-admin API key will not work for GET .../feedbacks/all/export."
            )
            if err_body.strip():
                detail += f" Response: {err_body[:300]}"
        raise HTTPException(status_code=502, detail=detail) from exc
    except httpx.RequestError as exc:
        logger.warning("openwebui_sync_transport error=%s", str(exc)[:200])
        raise HTTPException(
            status_code=502,
            detail=(
                f"Could not reach Open WebUI at {base}: {exc!s}. "
                "Confirm SYNESIS_OPENWEBUI_URL (cluster DNS, port 8080, correct namespace), "
                "that the open-webui pods are Ready, and that NetworkPolicy allows traffic "
                "from synesis-admin to open-webui."
            ),
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("openwebui_sync_error error=%s", str(exc)[:120])
        raise HTTPException(status_code=502, detail=f"Open WebUI sync failed: {exc!s}") from exc

    n = await _upsert_openwebui_feedback_rows(items)
    return {"status": "synced", "rows": n}


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


class KnowledgeGapIngest(BaseModel):
    """Service-to-service knowledge gap from planner-ts (or any runtime)."""

    gap_id: str = Field(..., max_length=64)
    query: str = Field(..., max_length=4096)
    task_description: str = Field("", max_length=2048)
    collections_queried: str = Field("", max_length=256)
    max_score: float = 0.0
    platform_context: str = Field("generic", max_length=64)
    language: str = Field("python", max_length=32)
    web_search_fallback: bool = False


@router.post("/knowledge-gaps/ingest")
async def ingest_knowledge_gap(request: Request, body: KnowledgeGapIngest):
    """Accept a knowledge gap from a runtime service (service-token auth)."""
    from ..internal_auth import require_internal_service_token_request

    require_internal_service_token_request(request)

    import time

    async with async_session() as session:
        existing = (
            (await session.execute(select(KnowledgeGap).where(KnowledgeGap.gap_id == body.gap_id))).scalars().first()
        )
        if existing:
            return {"status": "duplicate", "gap_id": body.gap_id}

        session.add(
            KnowledgeGap(
                gap_id=body.gap_id,
                query=body.query,
                task_description=body.task_description or body.query,
                collections_queried=body.collections_queried,
                max_score=body.max_score,
                platform_context=body.platform_context,
                language=body.language,
                status="open",
                web_search_fallback=body.web_search_fallback,
                timestamp=int(time.time()),
            )
        )
        await session.commit()

    logger.info("knowledge_gap_ingested gap_id=%s", body.gap_id[:12])
    return {"status": "ok", "gap_id": body.gap_id}


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
