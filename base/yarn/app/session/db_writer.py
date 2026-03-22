"""PostgreSQL persistence for Yarn session aggregates and per-request usage logs."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import text

from ..config import settings
from ..db import get_session_factory
from .models import SessionState

logger = logging.getLogger("yarn.session.db_writer")


def _session_total_cost_usd(session: SessionState) -> float:
    raw = session.metadata.get("total_cost_usd", 0.0)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


async def persist_session_upsert(session: SessionState) -> None:
    """Upsert session aggregate into ``yarn_sessions`` (never raises)."""
    try:
        if not settings.admin_db_url:
            logger.debug("Skipping yarn_sessions upsert: admin_db_url not set")
            return
        if not settings.persist_usage_to_db:
            return

        factory = get_session_factory()
        created_at = datetime.fromtimestamp(session.created_at, tz=UTC)
        last_active_at = datetime.fromtimestamp(session.last_active_at, tz=UTC)
        provider = settings.provider.value
        model = settings.model
        total_cost = _session_total_cost_usd(session)

        async with factory() as db:
            await db.execute(
                text(
                    """
                    INSERT INTO yarn_sessions (
                        session_key, user_id, username, role, conversation_id,
                        provider, model,
                        total_tokens_in, total_tokens_out, total_tokens_cached, total_cost_usd,
                        request_count, escalation_count,
                        created_at, last_active_at
                    ) VALUES (
                        :session_key, :user_id, :username, :role, :conversation_id,
                        :provider, :model,
                        :total_tokens_in, :total_tokens_out, :total_tokens_cached, :total_cost_usd,
                        :request_count, :escalation_count,
                        :created_at, :last_active_at
                    )
                    ON CONFLICT (session_key) DO UPDATE SET
                        user_id = EXCLUDED.user_id,
                        username = EXCLUDED.username,
                        role = EXCLUDED.role,
                        conversation_id = EXCLUDED.conversation_id,
                        provider = EXCLUDED.provider,
                        model = EXCLUDED.model,
                        total_tokens_in = EXCLUDED.total_tokens_in,
                        total_tokens_out = EXCLUDED.total_tokens_out,
                        total_tokens_cached = EXCLUDED.total_tokens_cached,
                        total_cost_usd = EXCLUDED.total_cost_usd,
                        request_count = EXCLUDED.request_count,
                        escalation_count = EXCLUDED.escalation_count,
                        last_active_at = EXCLUDED.last_active_at
                    """
                ),
                {
                    "session_key": session.session_key,
                    "user_id": session.user_id,
                    "username": session.username or "",
                    "role": session.role or "user",
                    "conversation_id": session.conversation_id or "",
                    "provider": provider,
                    "model": model,
                    "total_tokens_in": session.total_tokens_in,
                    "total_tokens_out": session.total_tokens_out,
                    "total_tokens_cached": session.total_tokens_cached,
                    "total_cost_usd": total_cost,
                    "request_count": session.request_count,
                    "escalation_count": session.escalation_count,
                    "created_at": created_at,
                    "last_active_at": last_active_at,
                },
            )
            await db.commit()
    except Exception:
        logger.exception(
            "yarn_sessions upsert failed for session_key=%s",
            getattr(session, "session_key", "?"),
        )


async def persist_usage_log(
    session_key: str,
    request_id: str,
    user_id: str,
    provider: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    tokens_cached: int,
    latency_ms: float,
    cost_usd: float,
    escalated: bool,
    tool_calls_count: int,
    finish_reason: str,
) -> None:
    """Append one row to ``yarn_usage_log`` (never raises)."""
    try:
        if not settings.admin_db_url:
            logger.debug("Skipping yarn_usage_log insert: admin_db_url not set")
            return
        if not settings.persist_usage_to_db:
            return

        factory = get_session_factory()
        fr = (finish_reason or "")[:32]
        rid = (request_id or "")[:64]

        async with factory() as db:
            await db.execute(
                text(
                    """
                    INSERT INTO yarn_usage_log (
                        session_key, request_id, user_id, provider, model,
                        tokens_in, tokens_out, tokens_cached, latency_ms, cost_usd,
                        escalated, tool_calls_count, finish_reason
                    ) VALUES (
                        :session_key, :request_id, :user_id, :provider, :model,
                        :tokens_in, :tokens_out, :tokens_cached, :latency_ms, :cost_usd,
                        :escalated, :tool_calls_count, :finish_reason
                    )
                    """
                ),
                {
                    "session_key": session_key[:256],
                    "request_id": rid,
                    "user_id": user_id[:256],
                    "provider": provider[:64],
                    "model": model[:256],
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "tokens_cached": tokens_cached,
                    "latency_ms": float(latency_ms),
                    "cost_usd": float(cost_usd),
                    "escalated": bool(escalated),
                    "tool_calls_count": int(tool_calls_count),
                    "finish_reason": fr,
                },
            )
            await db.commit()
    except Exception:
        logger.exception(
            "yarn_usage_log insert failed for session_key=%s request_id=%s",
            session_key,
            request_id,
        )
