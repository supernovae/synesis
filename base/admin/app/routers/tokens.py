"""Personal Access Token management — generate, list, revoke.

Users can manage their own tokens.  Admins can list/revoke any user's tokens.
Tokens are HMAC-SHA256 hashed (with server pepper) or SHA-256 hashed before
storage.  The plaintext token is returned exactly once at creation time.

Each token carries *scopes* that control which service endpoints it may reach:
  - ``model:readonly``  / ``model:readwrite``  → Planner / front-door LLM
  - ``coder:readonly``  / ``coder:readwrite``  → Yarn developer fabric
Tokens without explicit scopes (pre-migration) are treated as
``["model:readonly"]`` for backward compatibility.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserInfo, get_current_user
from ..db.engine import get_session
from ..db.models import PersonalAccessToken
from ..pat_crypto import generate as _generate_token
from ..rbac import require_platform_admin

router = APIRouter(prefix="/api/v1/tokens", tags=["tokens"])

VALID_SCOPES = frozenset({"model:readonly", "model:readwrite", "coder:readonly", "coder:readwrite"})
DEFAULT_SCOPES = ["model:readonly"]


# ── Request / response models ────────────────────────────────────────────────


class TokenCreate(BaseModel):
    name: str
    expires_in_days: int | None = None
    scopes: list[str] | None = None
    tenant_ids: list[str] | None = None

    @field_validator("scopes", mode="before")
    @classmethod
    def _validate_scopes(_cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        cleaned = list(dict.fromkeys(v))
        invalid = [s for s in cleaned if s not in VALID_SCOPES]
        if invalid:
            raise ValueError(f"Invalid scopes: {invalid}. Valid: {sorted(VALID_SCOPES)}")
        if not cleaned:
            raise ValueError("At least one scope is required")
        return cleaned

    @field_validator("tenant_ids", mode="before")
    @classmethod
    def _validate_tenant_ids(_cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        cleaned = [str(t).strip()[:64] for t in v if str(t).strip()]
        cleaned = list(dict.fromkeys(cleaned))
        if len(cleaned) > 50:
            raise ValueError("At most 50 tenant_ids are allowed")
        return cleaned


class TokenCreated(BaseModel):
    id: str
    name: str
    token: str
    token_prefix: str
    role: str
    scopes: list[str]
    tenant_ids: list[str]
    expires_at: datetime | None


class TokenInfo(BaseModel):
    id: str
    name: str
    token_prefix: str
    role: str
    scopes: list[str]
    tenant_ids: list[str]
    created_at: datetime
    expires_at: datetime | None
    last_used_at: datetime | None
    revoked: bool


def _effective_scopes(raw: list[str] | None) -> list[str]:
    """Normalize DB value — legacy NULL tokens get default scopes."""
    return list(raw) if raw else list(DEFAULT_SCOPES)


def _effective_tenant_ids(raw: list[str] | None) -> list[str]:
    return [str(t).strip()[:64] for t in (raw or []) if str(t).strip()][:50]


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.post("", response_model=TokenCreated, status_code=201)
async def create_token(
    body: TokenCreate,
    user: UserInfo = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Generate a new Personal Access Token.

    The plaintext token is returned in the response and is never stored.
    """
    scopes = body.scopes or list(DEFAULT_SCOPES)
    tenant_ids = _effective_tenant_ids(body.tenant_ids)
    if tenant_ids and not (user.org_id or "").strip():
        raise HTTPException(status_code=400, detail="tenant_ids require an organization-scoped identity")
    plaintext, token_hash, display_prefix = _generate_token()
    expires_at = datetime.now(UTC) + timedelta(days=body.expires_in_days) if body.expires_in_days else None
    pat_id = str(uuid.uuid4())
    pat = PersonalAccessToken(
        id=pat_id,
        user_id=user.user_id or user.username,
        username=user.username,
        org_id=user.org_id or "",
        tenant_ids=tenant_ids,
        token_hash=token_hash,
        token_prefix=display_prefix,
        name=body.name,
        role=user.role,
        scopes=scopes,
        expires_at=expires_at,
    )
    session.add(pat)
    await session.commit()

    from ..services.fga_tuple_writer import on_pat_created

    await on_pat_created(
        user_id=user.user_id or user.username,
        org_id=user.org_id or "",
        tenant_ids=tenant_ids,
        role=user.role,
        scopes=scopes,
    )

    return TokenCreated(
        id=pat_id,
        name=body.name,
        token=plaintext,
        token_prefix=display_prefix,
        role=user.role,
        scopes=scopes,
        tenant_ids=tenant_ids,
        expires_at=expires_at,
    )


@router.get("", response_model=list[TokenInfo])
async def list_tokens(
    user: UserInfo = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """List the current user's tokens (metadata only, no plaintext)."""
    user_id = user.user_id or user.username
    stmt = (
        select(PersonalAccessToken)
        .where(PersonalAccessToken.user_id == user_id)
        .order_by(PersonalAccessToken.created_at.desc())
    )
    result = await session.execute(stmt)
    return [
        TokenInfo(
            id=t.id,
            name=t.name,
            token_prefix=t.token_prefix,
            role=t.role,
            scopes=_effective_scopes(t.scopes),
            tenant_ids=_effective_tenant_ids(t.tenant_ids),
            created_at=t.created_at,
            expires_at=t.expires_at,
            last_used_at=t.last_used_at,
            revoked=t.revoked,
        )
        for t in result.scalars()
    ]


@router.delete("/{token_id}", status_code=204)
async def revoke_token(
    token_id: str,
    user: UserInfo = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Revoke a token.  Users can revoke their own; admins can revoke any."""
    stmt = select(PersonalAccessToken).where(PersonalAccessToken.id == token_id)
    result = await session.execute(stmt)
    pat = result.scalar_one_or_none()

    if pat is None:
        raise HTTPException(status_code=404, detail="Token not found")

    from ..rbac import Role, resolve_role

    owner_id = user.user_id or user.username
    if pat.user_id != owner_id and resolve_role(user) < Role.platform_admin:
        raise HTTPException(status_code=403, detail="Not authorized to revoke this token")

    await session.execute(update(PersonalAccessToken).where(PersonalAccessToken.id == token_id).values(revoked=True))
    await session.commit()

    from ..services.fga_tuple_writer import on_pat_revoked

    await on_pat_revoked(pat.user_id)


# ── Admin-only endpoints ─────────────────────────────────────────────────────


@router.get("/admin/all", response_model=list[TokenInfo])
async def list_all_tokens(
    _admin: UserInfo = Depends(require_platform_admin),
    session: AsyncSession = Depends(get_session),
):
    """List all tokens across all users (admin only)."""
    stmt = select(PersonalAccessToken).order_by(PersonalAccessToken.created_at.desc()).limit(200)
    result = await session.execute(stmt)
    return [
        TokenInfo(
            id=t.id,
            name=t.name,
            token_prefix=t.token_prefix,
            role=t.role,
            scopes=_effective_scopes(t.scopes),
            tenant_ids=_effective_tenant_ids(t.tenant_ids),
            created_at=t.created_at,
            expires_at=t.expires_at,
            last_used_at=t.last_used_at,
            revoked=t.revoked,
        )
        for t in result.scalars()
    ]


@router.delete("/admin/purge-revoked", status_code=204)
async def purge_revoked(
    _admin: UserInfo = Depends(require_platform_admin),
    session: AsyncSession = Depends(get_session),
):
    """Hard-delete all revoked tokens (admin only)."""
    await session.execute(delete(PersonalAccessToken).where(PersonalAccessToken.revoked.is_(True)))
    await session.commit()


@router.post("/admin/backfill-fga")
async def backfill_fga_tuples(
    _admin: UserInfo = Depends(require_platform_admin),
    session: AsyncSession = Depends(get_session),
):
    """Backfill OpenFGA tuples from existing PAT rows (platform admin only)."""
    from ..services.fga_tuple_writer import backfill_from_db

    result = await backfill_from_db(session)
    return result
