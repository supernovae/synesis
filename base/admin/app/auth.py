"""Keycloak OIDC + Personal Access Token authentication.

Validates bearer tokens against Keycloak JWKS (RS256) or looks up
Personal Access Tokens (PATs) in the admin database.  Falls back to
legacy local users when SYNESIS_KEYCLOAK_ISSUER_URL is not set, to
allow development without a running Keycloak instance.
"""

from __future__ import annotations

import hashlib
import logging
import os
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

logger = logging.getLogger("synesis.auth")

# ── Keycloak configuration ───────────────────────────────────────────────────

KEYCLOAK_ISSUER = os.getenv("SYNESIS_KEYCLOAK_ISSUER_URL", "")
# Keycloak access tokens usually have aud="account", not the OAuth client_id.
# Leave empty to skip aud verification; use SYNESIS_KEYCLOAK_EXPECTED_AZP instead.
KEYCLOAK_AUDIENCE = os.getenv("SYNESIS_KEYCLOAK_AUDIENCE", "")
KEYCLOAK_EXPECTED_AZP = os.getenv("SYNESIS_KEYCLOAK_EXPECTED_AZP", "synesis-admin")

_jwks_client: jwt.PyJWKClient | None = None


def _get_jwks_client() -> jwt.PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        jwks_url = f"{KEYCLOAK_ISSUER}/protocol/openid-connect/certs"
        _jwks_client = jwt.PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=300)
        logger.info("jwks_client_initialized", extra={"jwks_url": jwks_url})
    return _jwks_client


# ── Legacy local auth (fallback when Keycloak is not configured) ─────────────

SECRET_KEY = os.getenv("SYNESIS_JWT_SECRET", "synesis-dev-secret-change-me")
TOKEN_EXPIRY_HOURS = int(os.getenv("SYNESIS_TOKEN_EXPIRY_HOURS", "24"))

_LEGACY_USERS: dict[str, dict] = {
    "admin": {
        "password": os.getenv("SYNESIS_ADMIN_PASSWORD", "admin"),
        "role": "admin",
    },
    "viewer": {
        "password": os.getenv("SYNESIS_VIEWER_PASSWORD", "viewer"),
        "role": "readonly",
    },
}


# ── Data models ──────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class UserInfo(BaseModel):
    username: str
    role: str
    user_id: str = ""  # Keycloak sub or legacy username
    org_id: str = ""  # primary Keycloak organization ID
    org_name: str = ""  # primary organization display name
    org_roles: list[str] = []  # roles within the organization


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105 — standard OAuth2 field
    user: UserInfo


# ── Token verification ───────────────────────────────────────────────────────

def _parse_org_claim(payload: dict) -> tuple[str, str, list[str]]:
    """Extract primary organization from Keycloak's ``organization`` JWT claim.

    Keycloak emits: ``{"<org-id>": {"name": "...", "roles": [...]}, ...}``
    Returns ``(org_id, org_name, org_roles)`` for the first org, or empty
    values when the user has no organization membership.
    """
    org_claim = payload.get("organization")
    if not org_claim or not isinstance(org_claim, dict):
        return "", "", []
    org_id, org_data = next(iter(org_claim.items()))
    if isinstance(org_data, dict):
        return org_id, org_data.get("name", ""), org_data.get("roles", [])
    return org_id, "", []


def _verify_keycloak_token(token: str) -> UserInfo:
    """Decode and verify a Keycloak-issued JWT using JWKS."""
    client = _get_jwks_client()
    signing_key = client.get_signing_key_from_jwt(token)
    verify_aud = bool(KEYCLOAK_AUDIENCE)
    audience = KEYCLOAK_AUDIENCE or None
    payload = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        issuer=KEYCLOAK_ISSUER,
        audience=audience,
        options={"verify_aud": verify_aud},
    )
    if not verify_aud:
        azp = payload.get("azp")
        if azp and azp != KEYCLOAK_EXPECTED_AZP:
            logger.warning(
                "keycloak_azp_mismatch",
                extra={"azp": azp, "expected": KEYCLOAK_EXPECTED_AZP},
            )
            raise jwt.InvalidTokenError("Token not issued for Synesis Admin client")
    roles = payload.get("realm_access", {}).get("roles", [])
    role = "admin" if "synesis-admin" in roles else "user"
    username = payload.get("preferred_username", payload.get("sub", "unknown"))
    org_id, org_name, org_roles = _parse_org_claim(payload)
    return UserInfo(
        username=username,
        role=role,
        user_id=payload.get("sub", ""),
        org_id=org_id,
        org_name=org_name,
        org_roles=org_roles,
    )


async def _verify_pat(token: str, request: Request) -> UserInfo | None:
    """Look up a Personal Access Token in the database.

    Returns UserInfo if valid, None if not a PAT or not found.
    """
    if not token.startswith("syn-"):
        return None

    from .db.engine import async_session
    from .db.models import PersonalAccessToken

    token_hash = hashlib.sha256(token.encode()).hexdigest()

    from sqlalchemy import select, update

    async with async_session() as session:
        stmt = select(PersonalAccessToken).where(
            PersonalAccessToken.token_hash == token_hash,
            PersonalAccessToken.revoked.is_(False),
        )
        result = await session.execute(stmt)
        pat = result.scalar_one_or_none()

        if pat is None:
            return None

        if pat.expires_at and pat.expires_at < datetime.now(UTC):
            return None

        await session.execute(
            update(PersonalAccessToken)
            .where(PersonalAccessToken.id == pat.id)
            .values(last_used_at=datetime.now(UTC))
        )
        await session.commit()

        return UserInfo(
            username=pat.username,
            role=pat.role,
            user_id=pat.user_id,
        )


def _verify_legacy_token(token: str) -> UserInfo:
    """Verify a locally-issued HS256 JWT (fallback for dev without Keycloak)."""
    payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
    return UserInfo(
        username=payload["sub"],
        role=payload["role"],
        user_id=payload["sub"],
    )


# ── FastAPI dependencies ─────────────────────────────────────────────────────

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UserInfo:
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = credentials.credentials

    # 1. Try Personal Access Token (starts with "syn-")
    try:
        pat_user = await _verify_pat(token, request)
        if pat_user is not None:
            return pat_user
    except Exception:
        logger.debug("pat_lookup_failed", exc_info=True)

    # 2. Try Keycloak JWKS validation
    if KEYCLOAK_ISSUER:
        try:
            return _verify_keycloak_token(token)
        except jwt.ExpiredSignatureError as err:
            raise HTTPException(status_code=401, detail="Token expired") from err
        except jwt.InvalidTokenError as err:
            raise HTTPException(status_code=401, detail="Invalid token") from err

    # 3. Fallback to legacy local JWT
    try:
        return _verify_legacy_token(token)
    except jwt.ExpiredSignatureError as err:
        raise HTTPException(status_code=401, detail="Token expired") from err
    except jwt.InvalidTokenError as err:
        raise HTTPException(status_code=401, detail="Invalid token") from err


async def require_admin(user: UserInfo = Depends(get_current_user)) -> UserInfo:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# ── Legacy login (only available when Keycloak is NOT configured) ────────────

def create_token(username: str, role: str) -> str:
    payload = {
        "sub": username,
        "role": role,
        "exp": datetime.now(UTC) + timedelta(hours=TOKEN_EXPIRY_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def authenticate(username: str, password: str) -> TokenResponse:
    """Local password authentication — disabled when Keycloak is active."""
    if KEYCLOAK_ISSUER:
        raise HTTPException(
            status_code=400,
            detail="Local login is disabled. Use Keycloak SSO to authenticate.",
        )
    entry = _LEGACY_USERS.get(username)
    if not entry or entry["password"] != password:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_token(username, entry["role"])
    return TokenResponse(
        access_token=token,
        user=UserInfo(username=username, role=entry["role"], user_id=username),
    )
