"""Shared Personal Access Token scope contract."""

from __future__ import annotations

from collections.abc import Iterable

VALID_TOKEN_SCOPES = frozenset({"model:readonly", "model:readwrite", "coder:readonly", "coder:readwrite"})
DEFAULT_TOKEN_SCOPES = ("model:readonly",)


def invalid_token_scopes(raw: Iterable[object] | None) -> list[str]:
    if raw is None:
        return []
    invalid: list[str] = []
    for raw_scope in raw:
        scope = str(raw_scope or "").strip()
        if scope not in VALID_TOKEN_SCOPES and scope not in invalid:
            invalid.append(scope)
    return invalid


def normalize_token_scopes(raw: Iterable[object] | None, *, allow_legacy_default: bool = True) -> list[str]:
    """Return de-duplicated known token scopes.

    Legacy tokens with NULL/empty scopes can keep their historical model-readonly
    behavior. Tokens with explicit but unknown values fail closed by dropping
    those values from the effective scope set.
    """
    if raw is None:
        return list(DEFAULT_TOKEN_SCOPES) if allow_legacy_default else []
    cleaned: list[str] = []
    for raw_scope in raw:
        scope = str(raw_scope or "").strip()
        if scope not in VALID_TOKEN_SCOPES:
            continue
        if scope not in cleaned:
            cleaned.append(scope)
    return cleaned


def has_token_scope(scopes: Iterable[str] | None, scope_prefix: str) -> bool:
    prefix = str(scope_prefix or "").strip()
    if prefix not in {"model", "coder"}:
        return False
    return any(
        scope in {f"{prefix}:readonly", f"{prefix}:readwrite"}
        for scope in normalize_token_scopes(scopes, allow_legacy_default=scopes is None)
    )


def has_write_scope(scopes: Iterable[str] | None, scope_prefix: str) -> bool:
    prefix = str(scope_prefix or "").strip()
    if prefix not in {"model", "coder"}:
        return False
    return f"{prefix}:readwrite" in normalize_token_scopes(scopes, allow_legacy_default=scopes is None)
