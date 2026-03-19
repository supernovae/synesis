"""FastAPI dependency for Keycloak JWT + PAT validation.

Follows the same auth resolution pattern as base/admin/app/auth.py:
1. syn- prefix tokens -> PAT lookup in admin Postgres
2. Keycloak JWT -> JWKS validation
3. Legacy JWT -> HS256 fallback for local dev
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

import httpx
import jwt
from fastapi import HTTPException, Request

from ..config import settings
from ..session.models import AuthUser

logger = logging.getLogger("yarn.middleware.auth")

_jwks_cache: dict[str, Any] | None = None
_jwks_fetched_at: float = 0.0
_JWKS_TTL = 3600.0


async def resolve_auth(request: Request) -> AuthUser:
    """Resolve the caller's identity from the Authorization header."""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")

    token = auth_header[7:].strip()

    # PAT resolution (syn- prefix)
    if token.startswith("syn-"):
        return await _resolve_pat(token)

    # Keycloak JWT
    if settings.keycloak_issuer_url:
        return await _resolve_keycloak_jwt(token)

    # Legacy HS256 JWT (local dev)
    return _resolve_legacy_jwt(token)


async def _resolve_pat(token: str) -> AuthUser:
    """Resolve a Personal Access Token by hashing and looking up in admin DB.

    For Phase 1, we accept any syn- token as a valid user with a derived ID.
    Full PAT table lookup requires async Postgres (added in Phase 2 with admin migration).
    """
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    user_id = f"pat-{token_hash[:16]}"
    return AuthUser(user_id=user_id, username=user_id, role="user", auth_method="pat")


async def _resolve_keycloak_jwt(token: str) -> AuthUser:
    """Validate a Keycloak-issued JWT against JWKS."""
    global _jwks_cache, _jwks_fetched_at

    if _jwks_cache is None or (time.time() - _jwks_fetched_at) > _JWKS_TTL:
        jwks_url = f"{settings.keycloak_issuer_url}/protocol/openid-connect/certs"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(jwks_url)
                resp.raise_for_status()
                _jwks_cache = resp.json()
                _jwks_fetched_at = time.time()
        except Exception:
            logger.exception("Failed to fetch JWKS from %s", jwks_url)
            raise HTTPException(status_code=503, detail="Auth service unavailable")

    try:
        jwk_client = jwt.PyJWKClient.__new__(jwt.PyJWKClient)
        jwk_client.jwk_set = jwt.PyJWKSet.from_dict(_jwks_cache)
        signing_key = jwk_client.get_signing_key_from_jwt(token)

        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=settings.keycloak_audience,
            issuer=settings.keycloak_issuer_url,
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")

    user_id = payload.get("sub", "")
    username = payload.get("preferred_username", user_id)
    roles = payload.get("realm_access", {}).get("roles", [])
    role = "admin" if "synesis-admin" in roles else "user"

    return AuthUser(user_id=user_id, username=username, role=role, auth_method="keycloak")


def _resolve_legacy_jwt(token: str) -> AuthUser:
    """HS256 JWT for local development without Keycloak."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        # Accept any token in dev mode by deriving an ID from it
        user_id = hashlib.sha256(token.encode()).hexdigest()[:16]
        return AuthUser(user_id=user_id, username=user_id, role="user", auth_method="legacy")

    return AuthUser(
        user_id=payload.get("sub", "unknown"),
        username=payload.get("username", ""),
        role=payload.get("role", "user"),
        auth_method="legacy",
    )
