"""Pattern Library CRUD API -- compositional code patterns for Layer 2 recall."""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from app.auth import UserInfo, get_current_user
from app.db.engine import async_session
from app.db.models import PatternEntry
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete, func, select

logger = logging.getLogger("synesis.admin.patterns")

router = APIRouter(prefix="/api/v1/patterns", tags=["patterns"])


def _require_admin(user: UserInfo) -> None:
    if user.role not in ("admin", "platform-admin"):
        raise HTTPException(403, "Admin role required")


class PatternCreate(BaseModel):
    pattern_id: str
    language: str
    skill_family: str
    code_block: str
    framework: str = ""
    description: str = ""
    constraints: str = ""
    test_snippet: str = ""
    tags: list[str] = []
    org_id: str = ""
    scope: str = "global"


class PatternUpdate(BaseModel):
    code_block: str | None = None
    description: str | None = None
    constraints: str | None = None
    test_snippet: str | None = None
    framework: str | None = None
    skill_family: str | None = None
    tags: list[str] | None = None
    enabled: bool | None = None
    trust_score: float | None = None


class PatternUsageFeedback(BaseModel):
    outcome: str = "pass"


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()[:16]


def _row_to_dict(p: PatternEntry) -> dict[str, Any]:
    return {
        "id": p.id,
        "pattern_id": p.pattern_id,
        "language": p.language,
        "framework": p.framework,
        "skill_family": p.skill_family,
        "code_block": p.code_block,
        "description": p.description,
        "constraints": p.constraints,
        "test_snippet": p.test_snippet,
        "trust_score": p.trust_score,
        "usage_count": p.usage_count,
        "last_validated": p.last_validated.isoformat() if p.last_validated else None,
        "org_id": p.org_id,
        "scope": p.scope,
        "enabled": p.enabled,
        "tags": p.tags or [],
        "content_hash": p.content_hash,
        "created_by": p.created_by,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


@router.post("/")
async def create_pattern(body: PatternCreate, user: UserInfo = Depends(get_current_user)):
    _require_admin(user)
    async with async_session() as session:
        existing = (
            await session.execute(
                select(PatternEntry).where(PatternEntry.pattern_id == body.pattern_id)
            )
        ).scalar_one_or_none()
        if existing:
            raise HTTPException(409, f"Pattern '{body.pattern_id}' already exists")

        row = PatternEntry(
            pattern_id=body.pattern_id,
            language=body.language.lower(),
            framework=body.framework,
            skill_family=body.skill_family.lower(),
            code_block=body.code_block,
            description=body.description,
            constraints=body.constraints,
            test_snippet=body.test_snippet,
            tags=body.tags,
            org_id=body.org_id or user.org_id,
            scope=body.scope,
            content_hash=_hash_code(body.code_block),
            created_by=user.username,
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return _row_to_dict(row)


@router.get("/")
async def list_patterns(
    language: str = Query("", description="Filter by language"),
    skill_family: str = Query("", description="Filter by skill family"),
    framework: str = Query("", description="Filter by framework"),
    enabled_only: bool = Query(True, description="Only enabled patterns"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        q = select(PatternEntry)
        if language:
            q = q.where(PatternEntry.language == language.lower())
        if skill_family:
            q = q.where(PatternEntry.skill_family == skill_family.lower())
        if framework:
            q = q.where(PatternEntry.framework == framework)
        if enabled_only:
            q = q.where(PatternEntry.enabled == True)
        q = q.order_by(PatternEntry.language, PatternEntry.skill_family).limit(limit).offset(offset)
        rows = (await session.execute(q)).scalars().all()
        return [_row_to_dict(r) for r in rows]


@router.get("/stats")
async def pattern_stats(_user: UserInfo = Depends(get_current_user)):
    async with async_session() as session:
        total = (await session.execute(select(func.count(PatternEntry.id)))).scalar() or 0
        enabled = (
            await session.execute(
                select(func.count(PatternEntry.id)).where(PatternEntry.enabled == True)
            )
        ).scalar() or 0

        by_language = (
            await session.execute(
                select(PatternEntry.language, func.count(PatternEntry.id))
                .where(PatternEntry.enabled == True)
                .group_by(PatternEntry.language)
            )
        ).all()

        by_skill = (
            await session.execute(
                select(PatternEntry.skill_family, func.count(PatternEntry.id))
                .where(PatternEntry.enabled == True)
                .group_by(PatternEntry.skill_family)
            )
        ).all()

        return {
            "total": total,
            "enabled": enabled,
            "by_language": {lang: cnt for lang, cnt in by_language},
            "by_skill_family": {sf: cnt for sf, cnt in by_skill},
        }


@router.get("/{pattern_id}")
async def get_pattern(pattern_id: str, _user: UserInfo = Depends(get_current_user)):
    async with async_session() as session:
        row = (
            await session.execute(
                select(PatternEntry).where(PatternEntry.pattern_id == pattern_id)
            )
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Pattern not found")
        return _row_to_dict(row)


@router.patch("/{pattern_id}")
async def update_pattern(pattern_id: str, body: PatternUpdate, user: UserInfo = Depends(get_current_user)):
    _require_admin(user)
    async with async_session() as session:
        row = (
            await session.execute(
                select(PatternEntry).where(PatternEntry.pattern_id == pattern_id)
            )
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Pattern not found")

        changed = False
        for field in ("code_block", "description", "constraints", "test_snippet", "framework", "skill_family", "tags", "enabled", "trust_score"):
            val = getattr(body, field, None)
            if val is not None:
                setattr(row, field, val)
                changed = True
        if body.code_block is not None:
            row.content_hash = _hash_code(body.code_block)

        if changed:
            await session.commit()
            await session.refresh(row)
        return _row_to_dict(row)


@router.delete("/{pattern_id}")
async def delete_pattern(pattern_id: str, user: UserInfo = Depends(get_current_user)):
    _require_admin(user)
    async with async_session() as session:
        result = await session.execute(
            delete(PatternEntry).where(PatternEntry.pattern_id == pattern_id)
        )
        await session.commit()
        if result.rowcount == 0:
            raise HTTPException(404, "Pattern not found")
        return {"deleted": pattern_id}


@router.post("/bulk-import")
async def bulk_import(patterns: list[PatternCreate], user: UserInfo = Depends(get_current_user)):
    _require_admin(user)
    created = 0
    skipped = 0
    async with async_session() as session:
        for p in patterns:
            existing = (
                await session.execute(
                    select(PatternEntry.id).where(PatternEntry.pattern_id == p.pattern_id)
                )
            ).scalar_one_or_none()
            if existing:
                skipped += 1
                continue
            row = PatternEntry(
                pattern_id=p.pattern_id,
                language=p.language.lower(),
                framework=p.framework,
                skill_family=p.skill_family.lower(),
                code_block=p.code_block,
                description=p.description,
                constraints=p.constraints,
                test_snippet=p.test_snippet,
                tags=p.tags,
                org_id=p.org_id or user.org_id,
                scope=p.scope,
                content_hash=_hash_code(p.code_block),
                created_by=user.username,
            )
            session.add(row)
            created += 1
        await session.commit()
    return {"created": created, "skipped": skipped}


@router.post("/sync")
async def sync_to_ingestion(user: UserInfo = Depends(get_current_user)):
    _require_admin(user)
    from app.services.pattern_sync import sync_patterns_to_ingestion

    result = await sync_patterns_to_ingestion()
    return result


@router.post("/bootstrap")
async def bootstrap_patterns(user: UserInfo = Depends(get_current_user)):
    """Load patterns from bootstrap/patterns/*.yaml files."""
    _require_admin(user)
    from pathlib import Path

    from app.services.pattern_loader import load_patterns_from_directory

    patterns_dir = Path(__file__).parent.parent.parent.parent.parent / "bootstrap" / "patterns"
    if not patterns_dir.is_dir():
        raise HTTPException(404, f"Bootstrap patterns directory not found: {patterns_dir}")
    result = await load_patterns_from_directory(patterns_dir)
    return result


@router.post("/{pattern_id}/usage")
async def record_usage(pattern_id: str, body: PatternUsageFeedback, _user: UserInfo = Depends(get_current_user)):
    """Record usage feedback and update trust score."""
    async with async_session() as session:
        row = (
            await session.execute(
                select(PatternEntry).where(PatternEntry.pattern_id == pattern_id)
            )
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Pattern not found")

        row.usage_count += 1
        if body.outcome == "pass":
            row.trust_score = 0.5 * row.trust_score + 0.5 * 1.0
        elif body.outcome == "fail":
            row.trust_score = 0.5 * row.trust_score + 0.5 * 0.0
        from datetime import UTC, datetime
        row.last_validated = datetime.now(UTC)

        await session.commit()
        return {"pattern_id": pattern_id, "usage_count": row.usage_count, "trust_score": round(row.trust_score, 4)}
