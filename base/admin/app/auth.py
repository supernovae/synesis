"""Keycloak OIDC + Personal Access Token authentication.

Validates bearer tokens against Keycloak JWKS (RS256) or looks up
Personal Access Tokens (PATs) in the admin database.

There is no local username/password or HS256 "dev" JWT path — configure
``SYNESIS_KEYCLOAK_ISSUER_URL`` for interactive login, or use PATs (``syn-...``)
for scripts and automation.
"""

from __future__ import annotations

import hmac
import logging
import os
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from hashlib import sha256

import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

logger = logging.getLogger("synesis.auth")

# ── Keycloak configuration ───────────────────────────────────────────────────

KEYCLOAK_ISSUER = os.getenv("SYNESIS_KEYCLOAK_ISSUER_URL", "")
# Optional internal issuer/JWKS base used only for server-side key fetches.
# Keep KEYCLOAK_ISSUER as the public issuer for JWT claim validation.
KEYCLOAK_INTERNAL_ISSUER = os.getenv("SYNESIS_KEYCLOAK_INTERNAL_ISSUER_URL", "")
# Keycloak access tokens usually have aud="account", not the OAuth client_id.
# Leave empty to skip aud verification; use SYNESIS_KEYCLOAK_EXPECTED_AZP instead.
KEYCLOAK_AUDIENCE = os.getenv("SYNESIS_KEYCLOAK_AUDIENCE", "")
KEYCLOAK_EXPECTED_AZP = os.getenv("SYNESIS_KEYCLOAK_EXPECTED_AZP", "synesis-admin")
SESSION_COOKIE_NAME = "synesis_admin_session"
CSRF_COOKIE_NAME = "synesis_admin_csrf"
CSRF_HEADER_NAME = "x-synesis-csrf"
SESSION_TTL_SECONDS = int(os.getenv("SYNESIS_ADMIN_SESSION_TTL_SECONDS", str(8 * 60 * 60)))
COOKIE_SECURE = os.getenv("SYNESIS_ADMIN_COOKIE_SECURE", "true").lower() not in {"0", "false", "no"}
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{32,256}$")

_jwks_client: jwt.PyJWKClient | None = None


def _get_jwks_client() -> jwt.PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        jwks_base = (KEYCLOAK_INTERNAL_ISSUER or KEYCLOAK_ISSUER).rstrip("/")
        jwks_url = f"{jwks_base}/protocol/openid-connect/certs"
        _jwks_client = jwt.PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=300)
        logger.info("jwks_client_initialized", extra={"jwks_url": jwks_url})
    return _jwks_client


# ── Data models ──────────────────────────────────────────────────────────────


class UserInfo(BaseModel):
    username: str
    role: str
    user_id: str = ""  # Keycloak sub or PAT user id
    email: str = ""  # Keycloak email claim (empty for PATs); used for audit / prompt_library.updated_by
    org_id: str = ""  # primary Keycloak organization ID
    org_name: str = ""  # primary organization display name
    org_roles: list[str] = Field(default_factory=list)  # roles within the organization
    tenant_ids: list[str] = Field(default_factory=list)  # PAT tenant scopes (JWT usually empty)
    token_scopes: list[str] = Field(default_factory=list)  # PAT scopes (empty for JWT sessions)


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
        email=str(payload.get("email", "") or "").strip()[:256],
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

    from sqlalchemy import select, update

    from .db.engine import async_session
    from .db.models import PersonalAccessToken
    from .pat_crypto import hash_token

    token_hash = hash_token(token)

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
            logger.warning("pat_auth_invalid_scope reason=tenant_ids_without_org")
            return None

        return UserInfo(
            username=pat.username,
            role=pat.role,
            user_id=pat.user_id,
            email="",
            org_id=org_id,
            tenant_ids=tenant_ids,
            token_scopes=scopes,
        )


def _hash_session_id(session_id: str) -> str:
    return sha256(session_id.encode()).hexdigest()


def _new_session_id() -> str:
    return secrets.token_urlsafe(32)


def _is_valid_session_id(session_id: str) -> bool:
    return bool(_SESSION_ID_RE.fullmatch(session_id))


def _client_ip(request: Request) -> str:
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",", 1)[0].strip()
    if forwarded:
        return forwarded[:128]
    return (request.client.host if request.client else "")[:128]


def _is_unsafe_method(request: Request) -> bool:
    return request.method.upper() not in {"GET", "HEAD", "OPTIONS", "TRACE"}


def _session_cookie_kwargs(max_age: int | None = None) -> dict:
    kwargs = {
        "httponly": True,
        "secure": COOKIE_SECURE,
        "samesite": "lax",
        "path": "/",
    }
    if max_age is not None:
        kwargs["max_age"] = max_age
    return kwargs


def _csrf_cookie_kwargs(max_age: int | None = None) -> dict:
    kwargs = {
        "httponly": False,
        "secure": COOKIE_SECURE,
        "samesite": "lax",
        "path": "/",
    }
    if max_age is not None:
        kwargs["max_age"] = max_age
    return kwargs


def _user_from_session_row(row) -> UserInfo:
    return UserInfo(
        username=row.username,
        role=row.role,
        user_id=row.user_id,
        email=row.email,
        org_id=row.org_id,
        org_name=row.org_name,
        org_roles=list(row.org_roles or []),
    )


async def create_admin_session(request: Request, response, token_data: dict) -> UserInfo:
    """Persist OIDC tokens server-side and set only opaque browser cookies."""
    from .db.engine import async_session
    from .db.models import AdminSession

    access = token_data.get("access_token")
    if not access or not isinstance(access, str):
        raise HTTPException(status_code=400, detail="Invalid token response")
    user = _verify_keycloak_token(access)
    refresh = str(token_data.get("refresh_token") or "")
    id_token = str(token_data.get("id_token") or "")
    session_id = _new_session_id()
    csrf_token = secrets.token_hex(32)
    ttl = max(300, min(SESSION_TTL_SECONDS, 7 * 24 * 60 * 60))
    expires_at = datetime.now(UTC) + timedelta(seconds=ttl)
    row = AdminSession(
        id=str(uuid.uuid4()),
        session_hash=_hash_session_id(session_id),
        csrf_token=csrf_token,
        username=user.username,
        role=user.role,
        user_id=user.user_id,
        email=user.email,
        org_id=user.org_id,
        org_name=user.org_name,
        org_roles=user.org_roles,
        access_token=access,
        refresh_token=refresh,
        id_token=id_token,
        user_agent=(request.headers.get("user-agent") or "")[:512],
        ip_address=_client_ip(request),
        expires_at=expires_at,
        last_seen_at=datetime.now(UTC),
    )
    async with async_session() as session:
        session.add(row)
        await session.commit()
    response.set_cookie(SESSION_COOKIE_NAME, session_id, **_session_cookie_kwargs(ttl))
    response.set_cookie(CSRF_COOKIE_NAME, csrf_token, **_csrf_cookie_kwargs(ttl))
    return user


async def refresh_admin_session(request: Request, response, token_data: dict) -> UserInfo:
    """Update a browser session after OIDC refresh."""
    from sqlalchemy import select

    from .db.engine import async_session
    from .db.models import AdminSession

    session_id = request.cookies.get(SESSION_COOKIE_NAME, "")
    if not session_id or not _is_valid_session_id(session_id):
        raise HTTPException(status_code=401, detail="Not authenticated")
    async with async_session() as session:
        row = (
            await session.execute(
                select(AdminSession).where(
                    AdminSession.session_hash == _hash_session_id(session_id),
                    AdminSession.revoked_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=401, detail="Not authenticated")
        access = token_data.get("access_token")
        if not access or not isinstance(access, str):
            raise HTTPException(status_code=400, detail="Invalid refresh response")
        user = _verify_keycloak_token(access)
        ttl = max(300, min(SESSION_TTL_SECONDS, 7 * 24 * 60 * 60))
        new_session_id = _new_session_id()
        new_csrf_token = secrets.token_hex(32)
        row.session_hash = _hash_session_id(new_session_id)
        row.csrf_token = new_csrf_token
        row.access_token = access
        if token_data.get("refresh_token"):
            row.refresh_token = str(token_data["refresh_token"])
        if token_data.get("id_token"):
            row.id_token = str(token_data["id_token"])
        row.username = user.username
        row.role = user.role
        row.user_id = user.user_id
        row.email = user.email
        row.org_id = user.org_id
        row.org_name = user.org_name
        row.org_roles = user.org_roles
        row.expires_at = datetime.now(UTC) + timedelta(seconds=ttl)
        row.last_seen_at = datetime.now(UTC)
        await session.commit()
    response.set_cookie(SESSION_COOKIE_NAME, new_session_id, **_session_cookie_kwargs(ttl))
    response.set_cookie(CSRF_COOKIE_NAME, new_csrf_token, **_csrf_cookie_kwargs(ttl))
    return user


async def revoke_current_admin_session(request: Request, response) -> None:
    from sqlalchemy import select

    from .db.engine import async_session
    from .db.models import AdminSession

    session_id = request.cookies.get(SESSION_COOKIE_NAME, "")
    if session_id and _is_valid_session_id(session_id):
        async with async_session() as session:
            row = (
                await session.execute(
                    select(AdminSession).where(AdminSession.session_hash == _hash_session_id(session_id))
                )
            ).scalar_one_or_none()
            if row:
                row.revoked_at = datetime.now(UTC)
                await session.commit()
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    response.delete_cookie(CSRF_COOKIE_NAME, path="/")


def validate_session_csrf(request: Request, csrf_token: str) -> None:
    if not _is_unsafe_method(request):
        return
    header = (request.headers.get(CSRF_HEADER_NAME) or "").strip()
    cookie = (request.cookies.get(CSRF_COOKIE_NAME) or "").strip()
    if (
        not header
        or not cookie
        or not hmac.compare_digest(header, cookie)
        or not hmac.compare_digest(header, csrf_token)
    ):
        raise HTTPException(status_code=403, detail="Invalid CSRF token")


async def _verify_session_cookie(request: Request) -> UserInfo | None:
    from sqlalchemy import select

    from .db.engine import async_session
    from .db.models import AdminSession

    session_id = request.cookies.get(SESSION_COOKIE_NAME, "")
    if not session_id or not _is_valid_session_id(session_id):
        return None
    async with async_session() as session:
        row = (
            await session.execute(
                select(AdminSession).where(
                    AdminSession.session_hash == _hash_session_id(session_id),
                    AdminSession.revoked_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if row.expires_at < datetime.now(UTC):
            return None
        validate_session_csrf(request, row.csrf_token)
        row.last_seen_at = datetime.now(UTC)
        await session.commit()
        request.state.auth_kind = "session"
        return _user_from_session_row(row)


# ── FastAPI dependencies ─────────────────────────────────────────────────────

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UserInfo:
    if not credentials:
        session_user = await _verify_session_cookie(request)
        if session_user is not None:
            return session_user
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = credentials.credentials

    # 1. Try Personal Access Token (starts with "syn-")
    try:
        pat_user = await _verify_pat(token, request)
        if pat_user is not None:
            return pat_user
    except Exception:
        logger.debug("pat_lookup_failed", exc_info=True)

    # 2. Keycloak JWKS validation
    if KEYCLOAK_ISSUER:
        try:
            requested_org_id = (
                request.headers.get("x-synesis-org-id") or request.headers.get("x-active-org-id") or ""
            ).strip()[:128]
            return _verify_keycloak_token(token, requested_org_id=requested_org_id)
        except jwt.ExpiredSignatureError as err:
            raise HTTPException(status_code=401, detail="Token expired") from err
        except jwt.InvalidTokenError as err:
            raise HTTPException(status_code=401, detail="Invalid token") from err

    # 3. No Keycloak — PAT-only (already tried above)
    raise HTTPException(
        status_code=401,
        detail=(
            "Authentication requires Keycloak (set SYNESIS_KEYCLOAK_ISSUER_URL) or a "
            "Personal Access Token (syn-...). Local JWT login has been removed."
        ),
    )


async def require_admin(user: UserInfo = Depends(get_current_user)) -> UserInfo:
    """Backward-compatible admin gate — delegates to the RBAC module."""
    from .rbac import Role, resolve_role

    if resolve_role(user) < Role.platform_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user
