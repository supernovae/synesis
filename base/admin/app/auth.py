"""Keycloak OIDC + Personal Access Token authentication.

Validates bearer tokens against Keycloak JWKS (RS256) or looks up
Personal Access Tokens (PATs) in the admin database.  Falls back to
legacy local users when SYNESIS_KEYCLOAK_ISSUER_URL is not set, to
allow development without a running Keycloak instance.
"""

from __future__ import annotations

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
        "role": "platform_admin",
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
    tenant_ids: list[str] = []  # PAT tenant scopes (JWT usually empty)
    token_scopes: list[str] = []  # PAT scopes (empty for JWT sessions)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserInfo


# ── Token verification ───────────────────────────────────────────────────────


def _parse_org_claim(payload: dict, requested_org_id: str = "") -> tuple[str, str, list[str]]:
    """Extract active organization from Keycloak's ``organization`` JWT claim.

    Keycloak emits: ``{"<org-id>": {"name": "...", "roles": [...]}, ...}``
    Returns ``(org_id, org_name, org_roles)`` for an explicitly selected org.
    Selection precedence: requested_org_id header > token active-org claim >
    single org in claim. If multiple orgs exist and none is selected, reject.
    """
    org_claim = payload.get("organization")
    if not org_claim or not isinstance(org_claim, dict):
        return "", "", []
    org_map: dict[str, dict] = {str(k): v for k, v in org_claim.items() if isinstance(v, dict)}
    if not org_map:
        return "", "", []

    selected = requested_org_id.strip()
    if not selected:
        for claim_key in ("synesis_active_org_id", "active_org_id", "org_id"):
            raw = str(payload.get(claim_key) or "").strip()
            if raw:
                selected = raw
                break

    if selected:
        org_data = org_map.get(selected)
        if org_data is None:
            raise jwt.InvalidTokenError("Selected org is not present in organization claim")
        raw_roles = org_data.get("roles", [])
        roles = [str(r) for r in raw_roles] if isinstance(raw_roles, list) else []
        return selected, str(org_data.get("name", "")), roles

    if len(org_map) == 1:
        org_id, org_data = next(iter(org_map.items()))
        raw_roles = org_data.get("roles", [])
        roles = [str(r) for r in raw_roles] if isinstance(raw_roles, list) else []
        return org_id, str(org_data.get("name", "")), roles

    raise jwt.InvalidTokenError("Multiple organizations in token; active organization must be specified")


def _verify_keycloak_token(token: str, *, requested_org_id: str = "") -> UserInfo:
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
    username = payload.get("preferred_username", payload.get("sub", "unknown"))
    org_id, org_name, org_roles = _parse_org_claim(payload, requested_org_id=requested_org_id)

    if "synesis-admin" in roles:
        role = "platform_admin"
    elif "admin" in org_roles:
        role = "org_admin"
    else:
        role = "user"

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
    from .pat_crypto import hash_token

    token_hash = hash_token(token)

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
            update(PersonalAccessToken).where(PersonalAccessToken.id == pat.id).values(last_used_at=datetime.now(UTC))
        )
        await session.commit()

        raw_scopes = getattr(pat, "scopes", None)
        scopes = list(raw_scopes) if raw_scopes else ["model:readonly"]
        raw_tenants = getattr(pat, "tenant_ids", None)
        tenant_ids = [str(t).strip()[:64] for t in (raw_tenants or []) if str(t).strip()][:50]
        org_id = (getattr(pat, "org_id", "") or "").strip()
        if tenant_ids and not org_id:
            logger.warning("pat_auth_invalid_scope token_id=%s reason=tenant_ids_without_org", str(getattr(pat, "id", "")))  # nosemgrep: python-logger-credential-disclosure
            return None

        return UserInfo(
            username=pat.username,
            role=pat.role,
            user_id=pat.user_id,
            org_id=org_id,
            tenant_ids=tenant_ids,
            token_scopes=scopes,
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
            requested_org_id = (
                (request.headers.get("x-synesis-org-id") or request.headers.get("x-active-org-id") or "").strip()[:128]
            )
            return _verify_keycloak_token(token, requested_org_id=requested_org_id)
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
    """Backward-compatible admin gate — delegates to the RBAC module."""
    from .rbac import Role, resolve_role

    if resolve_role(user) < Role.platform_admin:
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
