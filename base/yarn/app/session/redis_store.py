"""Redis-backed session persistence (DB 3)."""

from __future__ import annotations

import logging

import msgpack
import redis.asyncio as aioredis

from ..config import settings
from .models import SessionState

logger = logging.getLogger("yarn.session.redis")

_pool: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    global _pool
    if _pool is None:
        _pool = aioredis.from_url(
            settings.session_redis_url,
            decode_responses=False,
            max_connections=20,
        )
    return _pool


def _key(session_key: str) -> str:
    return f"yarn:session:{session_key}"


async def load_session(session_key: str) -> SessionState | None:
    r = await get_redis()
    raw = await r.get(_key(session_key))
    if raw is None:
        return None
    try:
        data = msgpack.unpackb(raw, raw=False)
        return SessionState.model_validate(data)
    except Exception:
        logger.warning("Corrupt session %s, discarding", session_key)
        await r.delete(_key(session_key))
        return None


async def save_session(session: SessionState) -> None:
    r = await get_redis()
    raw = msgpack.packb(session.model_dump(), use_bin_type=True)
    await r.set(_key(session.session_key), raw, ex=settings.session_ttl_seconds)


async def delete_session(session_key: str) -> None:
    r = await get_redis()
    await r.delete(_key(session_key))


async def close() -> None:
    global _pool
    if _pool is not None:
        await _pool.aclose()
        _pool = None
