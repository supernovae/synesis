"""Validate Admin-issued PATs (syn-…) against the same Postgres store as Yarn.

Open WebUI continues to use the trusted gateway path (internal service / model API key +
forwarded headers). Direct API clients use ``Authorization: Bearer syn-…`` with
``model:readonly`` or ``model:readwrite`` scopes.

Database URL: ``SYNESIS_ADMIN_DATABASE_URL`` if set, otherwise ``SYNESIS_TRACE_DATABASE_URL``
(same ``synesis_admin`` DB as traces).
"""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime

from .config import settings

logger = logging.getLogger("synesis.pat_auth")

_PAT_PREFIX = "syn-"
_PAT_PEPPER = os.environ.get("SYNESIS_PAT_PEPPER", "")


def _hash_pat(plaintext: str) -> str:
    if _PAT_PEPPER:
        return hmac.new(_PAT_PEPPER.encode(), plaintext.encode(), hashlib.sha256).hexdigest()
    return hashlib.sha256(plaintext.encode()).hexdigest()


def pat_lookup_database_url() -> str:
    raw = (settings.admin_database_url or settings.trace_database_url or "").strip()
    return raw.replace("postgresql+asyncpg://", "postgresql://")


@dataclass(frozen=True)
class PatAuthContext:
    user_id: str
    org_id: str
    username: str
    role: str
    scopes: list[str]
    token_row_id: str


def pat_has_model_scope(scopes: list[str]) -> bool:
    if not scopes:
        return True
    return any(s.startswith("model") for s in scopes)


def resolve_pat_context_sync(token: str, dsn: str) -> PatAuthContext | None:
    """Blocking PAT lookup + last_used update. Run via asyncio.to_thread from async handlers."""
    if not token.startswith(_PAT_PREFIX):
        return None
    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
    except ImportError:
        logger.error("pat_auth_psycopg2_missing")
        return None

    token_hash = _hash_pat(token)
    try:
        conn = psycopg2.connect(dsn, connect_timeout=5)
    except Exception:
        logger.exception("pat_auth_db_connect_failed")
        return None

    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, user_id, org_id, username, role, scopes, expires_at
                FROM personal_access_tokens
                WHERE token_hash = %s
                  AND revoked = false
                LIMIT 1
                """,
                (token_hash,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            expires_at = row.get("expires_at")
            if expires_at is not None:
                now = datetime.now(UTC)
                if expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=UTC)
                if expires_at < now:
                    return None

            cur.execute(
                "UPDATE personal_access_tokens SET last_used_at = now() WHERE id = %s",
                (row["id"],),
            )
            conn.commit()

        raw_scopes = row.get("scopes")
        scopes = list(raw_scopes) if raw_scopes else ["model:readonly"]
        return PatAuthContext(
            user_id=str(row.get("user_id") or ""),
            org_id=str(row.get("org_id") or ""),
            username=str(row.get("username") or ""),
            role=str(row.get("role") or "user"),
            scopes=scopes,
            token_row_id=str(row["id"]),
        )
    except Exception:
        logger.exception("pat_auth_lookup_failed")
        with contextlib.suppress(Exception):
            conn.rollback()
        return None
    finally:
        conn.close()


async def resolve_pat_or_none(token: str) -> PatAuthContext | None:
    """If *token* is a PAT, validate against admin DB; return context or raise HTTPException."""
    from fastapi import HTTPException

    if not token.startswith(_PAT_PREFIX):
        return None

    dsn = pat_lookup_database_url()
    if not dsn:
        raise HTTPException(
            status_code=503,
            detail="PAT authentication is not configured (set SYNESIS_ADMIN_DATABASE_URL or SYNESIS_TRACE_DATABASE_URL)",
        )

    import asyncio

    ctx = await asyncio.to_thread(resolve_pat_context_sync, token, dsn)
    if ctx is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if not pat_has_model_scope(ctx.scopes):
        raise HTTPException(
            status_code=403,
            detail="Token missing model scope for planner API (need model:readonly or model:readwrite)",
        )
    return ctx
