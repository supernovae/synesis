"""Session manager — auth resolution, session lifecycle, rate-limit enforcement."""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

from ..config import settings
from .models import AuthUser, RateLimits, SessionState
from . import redis_store

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
