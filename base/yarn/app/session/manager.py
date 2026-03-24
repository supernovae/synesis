"""Session manager — auth resolution, session lifecycle, rate-limit enforcement."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from typing import Any

from ..config import settings
from ..model.usage_tracker import UsageAggregator
from . import redis_store
from .db_writer import persist_session_upsert, persist_usage_log
from .models import AuthUser, RateLimits, SessionState

logger = logging.getLogger("yarn.session")


def _derive_user_id(bearer_token: str) -> str:
    """Derive a stable user ID from a bearer token when no explicit user is provided."""
    return hashlib.sha256(bearer_token.encode()).hexdigest()[:16]


def _session_key(user_id: str, conversation_id: str) -> str:
    if conversation_id:
        return f"{user_id}:{conversation_id}"
    return user_id


async def resolve_or_create_session(
    auth_user: AuthUser,
    conversation_id: str = "",
    extra_meta: dict[str, Any] | None = None,
) -> SessionState:
    """Load an existing session or create a new one."""
    key = _session_key(auth_user.user_id, conversation_id)
    session = await redis_store.load_session(key)

    if session is not None:
        session.last_active_at = time.time()
        await redis_store.save_session(session)
        return session

    session = SessionState(
        session_key=key,
        user_id=auth_user.user_id,
        org_id=auth_user.org_id,
        tenant_ids=list(auth_user.tenant_ids or []),
        username=auth_user.username,
        role=auth_user.role,
        conversation_id=conversation_id,
        rate_limits=RateLimits(
            tokens_per_minute=settings.rate_limit_tokens_per_minute,
            requests_per_minute=settings.rate_limit_requests_per_minute,
        ),
        metadata=extra_meta or {},
    )
    await redis_store.save_session(session)
    logger.info("Created session %s for user %s", key, auth_user.user_id)
    return session


def check_rate_limit(session: SessionState) -> bool:
    """Return True if the request is within rate limits. Resets window if expired."""
    now = time.time()
    rl = session.rate_limits
    if now - rl.window_start >= 60.0:
        rl.tokens_used_this_minute = 0
        rl.requests_used_this_minute = 0
        rl.window_start = now

    if rl.requests_used_this_minute >= rl.requests_per_minute:
        return False
    return True


async def record_usage(
    session: SessionState,
    tokens_in: int,
    tokens_out: int,
    tokens_cached: int = 0,
) -> None:
    """Update session counters after a request."""
    session.total_tokens_in += tokens_in
    session.total_tokens_out += tokens_out
    session.total_tokens_cached += tokens_cached
    session.request_count += 1
    session.rate_limits.tokens_used_this_minute += tokens_in + tokens_out
    session.rate_limits.requests_used_this_minute += 1
    session.last_active_at = time.time()
    await redis_store.save_session(session)
    if settings.persist_usage_to_db:
        try:
            asyncio.get_running_loop().create_task(persist_session_upsert(session))
        except RuntimeError:
            logger.debug("No running event loop; skipping yarn_sessions DB persist")


async def record_request_usage(
    session: SessionState,
    request_id: str,
    usage_agg: UsageAggregator,
    latency_ms: float,
    escalated: bool,
    tool_calls_count: int,
    finish_reason: str,
) -> None:
    """Log per-request usage to Postgres and refresh session cost in metadata."""
    if not settings.persist_usage_to_db:
        return

    prev = session.metadata.get("total_cost_usd", 0.0)
    try:
        base = float(prev)
    except (TypeError, ValueError):
        base = 0.0
    session.metadata["total_cost_usd"] = base + usage_agg.total_cost_usd
    await redis_store.save_session(session)

    prov = settings.provider.value
    mdl = settings.model
    if usage_agg.records:
        prov = usage_agg.records[0].provider or prov
        mdl = usage_agg.records[0].model or mdl

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(
            persist_usage_log(
                session.session_key,
                request_id,
                session.user_id,
                session.org_id,
                prov,
                mdl,
                usage_agg.total_tokens_in,
                usage_agg.total_tokens_out,
                usage_agg.total_tokens_cached,
                latency_ms,
                usage_agg.total_cost_usd,
                escalated,
                tool_calls_count,
                finish_reason,
            )
        )
        loop.create_task(persist_session_upsert(session))
    except RuntimeError:
        logger.debug("No running event loop; skipping yarn_usage_log DB persist")
