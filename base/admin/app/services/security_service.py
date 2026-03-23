"""Security events service — CRUD for guardrail detections and operator actions."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select

from ..db.engine import async_session
from ..db.models import SecurityEvent

logger = logging.getLogger("synesis.admin.security")


async def list_events(
    *,
    limit: int = 100,
    before_id: int | None = None,
    severity: str | None = None,
    event_type: str | None = None,
    service: str | None = None,
    resolved: bool | None = None,
    since_hours: int | None = None,
    scope_org_id: str = "",
) -> list[dict[str, Any]]:
    async with async_session() as session:
        q = select(SecurityEvent)
        if before_id is not None:
            q = q.where(SecurityEvent.id < before_id)
        if severity:
            q = q.where(SecurityEvent.severity == severity)
        if event_type:
            q = q.where(SecurityEvent.event_type == event_type)
        if service:
            q = q.where(SecurityEvent.service == service)
        if resolved is not None:
            q = q.where(SecurityEvent.resolved == resolved)
        if since_hours:
            cutoff = datetime.now(UTC) - timedelta(hours=since_hours)
            q = q.where(SecurityEvent.created_at >= cutoff)
        if scope_org_id:
            q = q.where(SecurityEvent.org_id == scope_org_id)
        q = q.order_by(SecurityEvent.id.desc()).limit(limit)
        result = await session.execute(q)
        rows = result.scalars().all()

    return [_row_to_dict(r) for r in rows]


async def get_summary(
    *,
    since_hours: int = 24,
    scope_org_id: str = "",
) -> dict[str, Any]:
    cutoff = datetime.now(UTC) - timedelta(hours=since_hours)
    async with async_session() as session:
        base = select(SecurityEvent).where(SecurityEvent.created_at >= cutoff)
        if scope_org_id:
            base = base.where(SecurityEvent.org_id == scope_org_id)

        total_q = select(func.count()).select_from(base.subquery())
        total = (await session.execute(total_q)).scalar() or 0

        by_severity_q = (
            select(SecurityEvent.severity, func.count())
            .where(SecurityEvent.created_at >= cutoff)
            .group_by(SecurityEvent.severity)
        )
        if scope_org_id:
            by_severity_q = by_severity_q.where(SecurityEvent.org_id == scope_org_id)
        by_severity = dict((await session.execute(by_severity_q)).all())

        by_type_q = (
            select(SecurityEvent.event_type, func.count())
            .where(SecurityEvent.created_at >= cutoff)
            .group_by(SecurityEvent.event_type)
        )
        if scope_org_id:
            by_type_q = by_type_q.where(SecurityEvent.org_id == scope_org_id)
        by_type = dict((await session.execute(by_type_q)).all())

        unresolved_q = select(func.count()).select_from(
            base.where(SecurityEvent.resolved == False).subquery()
        )
        unresolved = (await session.execute(unresolved_q)).scalar() or 0

    return {
        "total": total,
        "unresolved": unresolved,
        "by_severity": by_severity,
        "by_type": by_type,
        "since_hours": since_hours,
    }


async def resolve_event(
    *,
    event_id: str,
    action: str,
    reason: str,
    actor: str,
) -> dict[str, Any] | None:
    async with async_session() as session:
        q = select(SecurityEvent).where(SecurityEvent.event_id == event_id)
        result = await session.execute(q)
        row = result.scalar_one_or_none()
        if row is None:
            return None

        row.resolved = True
        row.resolved_by = actor[:256]
        row.resolved_action = action[:64]
        row.resolved_reason = reason[:8000]
        row.resolved_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(row)
        return _row_to_dict(row)


async def ingest_event(data: dict[str, Any]) -> str:
    """Write a SecurityEvent from Planner/Yarn webhook payload."""
    async with async_session() as session:
        row = SecurityEvent(
            event_id=str(data.get("event_id", ""))[:64],
            event_type=str(data.get("event_type", "unknown"))[:64],
            severity=str(data.get("severity", "low"))[:16],
            confidence=float(data.get("confidence", 0.0)),
            confidence_band=str(data.get("confidence_band", "low"))[:16],
            action_taken=str(data.get("action_taken", "allow"))[:32],
            scope=str(data.get("scope", "request"))[:16],
            service=str(data.get("service", ""))[:32],
            request_id=str(data.get("request_id", ""))[:128],
            session_id=str(data.get("session_id", ""))[:256],
            user_id=str(data.get("user_id", ""))[:256],
            token_id=str(data.get("token_id", ""))[:64],
            org_id=str(data.get("org_id", ""))[:256],
            patterns_found=data.get("patterns_found"),
            excerpt=str(data.get("excerpt", ""))[:4000],
            scanner_name=str(data.get("scanner_name", ""))[:64],
            latency_ms=float(data.get("latency_ms", 0.0)),
            detail=data.get("detail") or {},
        )
        session.add(row)
        await session.commit()
    return row.event_id


def _row_to_dict(r: SecurityEvent) -> dict[str, Any]:
    return {
        "id": r.id,
        "event_id": r.event_id,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "event_type": r.event_type,
        "severity": r.severity,
        "confidence": r.confidence,
        "confidence_band": r.confidence_band,
        "action_taken": r.action_taken,
        "scope": r.scope,
        "service": r.service,
        "request_id": r.request_id,
        "session_id": r.session_id,
        "user_id": r.user_id,
        "token_id": r.token_id,
        "org_id": r.org_id,
        "patterns_found": r.patterns_found or [],
        "excerpt": r.excerpt,
        "scanner_name": r.scanner_name,
        "latency_ms": r.latency_ms,
        "detail": r.detail or {},
        "resolved": r.resolved,
        "resolved_by": r.resolved_by,
        "resolved_action": r.resolved_action,
        "resolved_reason": r.resolved_reason,
        "resolved_at": r.resolved_at.isoformat() if r.resolved_at else None,
    }
