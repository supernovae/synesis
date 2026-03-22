"""FastAPI dependency for strict Keycloak JWT + PAT validation."""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from datetime import UTC, datetime
from typing import Any

import httpx
import jwt
from fastapi import HTTPException, Request
from sqlalchemy import text

from ..config import settings
from ..db import get_session_factory
from ..session.models import AuthUser

logger = logging.getLogger("yarn.middleware.auth")

_jwks_cache: dict[str, Any] | None = None
_jwks_fetched_at: float = 0.0
_JWKS_TTL = 3600.0


async def resolve_auth(request: Request) -> AuthUser:
    """Resolve the caller's identity from the Authorization header."""
    token = extract_bearer_token(request)

    # PAT resolution (syn- prefix)
    if token.startswith("syn-"):
        try:
            return await _resolve_pat(token)
        except RuntimeError as exc:
            logger.warning("PAT auth misconfigured: %s", exc)
            raise HTTPException(status_code=503, detail="PAT auth unavailable") from exc

    # Keycloak JWT
    if settings.keycloak_issuer_url:
        return await _resolve_keycloak_jwt(token)

    # Optional legacy HS256 JWT fallback (local dev only).
    if not settings.auth_allow_legacy_fallback:
        raise HTTPException(
            status_code=401,
            detail="Unsupported token type for this environment",
        )
    return _resolve_legacy_jwt(token)


async def _resolve_pat(token: str) -> AuthUser:
    """Resolve a Personal Access Token by hash lookup in admin DB."""
    token_hash = _hash_pat(token)
    session_factory = get_session_factory()
    now = datetime.now(UTC)
    async with session_factory() as session:
        row = (
            (
                await session.execute(
                    text(
                        """
                    SELECT id, user_id, org_id, username, role, expires_at
                    FROM personal_access_tokens
                    WHERE token_hash = :token_hash
                      AND revoked = false
                    LIMIT 1
                    """
                    ),
                    {"token_hash": token_hash},
                )
            )
            .mappings()
            .first()
        )
        if row is None:
            raise HTTPException(status_code=401, detail="Invalid token")

        expires_at = row.get("expires_at")
        if expires_at is not None and expires_at < now:
            raise HTTPException(status_code=401, detail="Token expired")

        await session.execute(
            text(
                """
                UPDATE personal_access_tokens
                SET last_used_at = now()
                WHERE id = :id
                """
            ),
            {"id": row["id"]},
        )
        await session.commit()

    return AuthUser(
        user_id=row.get("user_id", ""),
        org_id=row.get("org_id", "") or "",
        username=row.get("username", ""),
        role=row.get("role", "user"),
        auth_method="pat",
    )


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
            audience=(settings.keycloak_audience or None),
            issuer=settings.keycloak_issuer_url,
            options={"verify_aud": bool(settings.keycloak_audience)},
        )
        if not settings.keycloak_audience:
            azp = payload.get("azp")
            if azp and azp != settings.keycloak_expected_azp:
                raise HTTPException(status_code=401, detail="Invalid token")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_id = payload.get("sub", "")
    username = payload.get("preferred_username", user_id)
    roles = payload.get("realm_access", {}).get("roles", [])
    org_id = ""
    org_claim = payload.get("organization")
    org_roles: list[str] = []
    if isinstance(org_claim, dict) and org_claim:
        org_id, org_data = next(iter(org_claim.items()))
        if isinstance(org_data, dict):
            raw_roles = org_data.get("roles", [])
            if isinstance(raw_roles, list):
                org_roles = [str(r) for r in raw_roles]
    if "synesis-admin" in roles:
        role = "platform_admin"
    elif "admin" in org_roles:
        role = "org_admin"
    else:
        role = "user"

    return AuthUser(
        user_id=user_id,
        org_id=org_id,
        username=username,
        role=role,
        auth_method="keycloak",
    )


def _resolve_legacy_jwt(token: str) -> AuthUser:
    """HS256 JWT for local development without Keycloak."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    return AuthUser(
        user_id=payload.get("sub", "unknown"),
        org_id=payload.get("org_id", "") or "",
        username=payload.get("username", ""),
        role=payload.get("role", "user"),
        auth_method="legacy",
    )


def extract_bearer_token(request: Request) -> str:
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = auth_header[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    return token


def _hash_pat(token: str) -> str:
    if settings.pat_pepper:
        return hmac.new(
            settings.pat_pepper.encode(),
            token.encode(),
            hashlib.sha256,
        ).hexdigest()
    return hashlib.sha256(token.encode()).hexdigest()
