"""Persist admin actions and propagation outcomes for the audit UI."""

from __future__ import annotations

import json
import logging
from typing import Any

from ..auth import UserInfo
from ..db.engine import async_session
from ..db.models import AdminAuditEvent

logger = logging.getLogger("synesis.admin.audit")

_MAX_DETAIL_BYTES = 48_000


def _sanitize_detail(detail: dict[str, Any] | None) -> dict[str, Any]:
    if not detail:
        return {}
    out: dict[str, Any] = {}
    for k, v in detail.items():
        key_lower = str(k).lower()
        if "secret" in key_lower or "password" in key_lower or "api_key" in key_lower or "token" in key_lower:
            out[k] = "[redacted]"
            continue
        out[k] = v
    raw = json.dumps(out, default=str)
    if len(raw) > _MAX_DETAIL_BYTES:
        return {"_truncated": True, "preview": raw[: _MAX_DETAIL_BYTES - 80] + "…"}
    return out


async def record_admin_audit(
    *,
    action: str,
    status: str,
    summary: str,
    detail: dict[str, Any] | None = None,
    user: UserInfo | None = None,
    source: str = "api",
) -> None:
    """Best-effort insert; never raises to callers."""
    actor_username = ""
    actor_user_id = ""
    actor_role = ""
    if user is not None:
        actor_username = (user.username or "")[:256]
        actor_user_id = (user.user_id or user.username or "")[:256]
        actor_role = (user.role or "")[:64]
    if source == "system":
        actor_username = actor_username or "system"
    try:
        row = AdminAuditEvent(
            source=(source or "api")[:32],
            actor_username=actor_username,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
            action=action[:128],
            status=status[:32],
            summary=summary[:8000],
            detail=_sanitize_detail(detail),
        )
        async with async_session() as session:
            session.add(row)
            await session.commit()
    except Exception:
        logger.warning("admin_audit_write_failed action=%s", action, exc_info=True)
