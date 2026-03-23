"""Unit tests for planner PAT validation (syn- tokens)."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import HTTPException

pytest.importorskip("fastapi")

from app.pat_auth import (
    PatAuthContext,
    pat_has_model_scope,
    resolve_pat_or_none,
)


def test_pat_has_model_scope():
    assert pat_has_model_scope([]) is True
    assert pat_has_model_scope(["model:readonly"]) is True
    assert pat_has_model_scope(["model:readwrite"]) is True
    assert pat_has_model_scope(["coder:readonly", "model:readonly"]) is True
    assert pat_has_model_scope(["coder:readonly"]) is False


@pytest.mark.asyncio
async def test_resolve_pat_or_none_skips_non_pat():
    assert await resolve_pat_or_none("") is None
    assert await resolve_pat_or_none("sk-not-a-pat") is None


@pytest.mark.asyncio
async def test_resolve_pat_or_none_503_when_no_database_url():
    with patch("app.pat_auth.pat_lookup_database_url", return_value=""):
        with pytest.raises(HTTPException) as exc_info:
            await resolve_pat_or_none("syn-deadbeef")
        assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_resolve_pat_or_none_401_when_lookup_misses():
    with patch("app.pat_auth.pat_lookup_database_url", return_value="postgresql://localhost/test"):
        with patch("app.pat_auth.resolve_pat_context_sync", return_value=None):
            with pytest.raises(HTTPException) as exc_info:
                await resolve_pat_or_none("syn-deadbeef")
            assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_resolve_pat_or_none_403_coder_only():
    ctx = PatAuthContext(
        user_id="u1",
        org_id="o1",
        username="alice",
        role="user",
        scopes=["coder:readonly"],
        token_row_id="tid",
    )
    with patch("app.pat_auth.pat_lookup_database_url", return_value="postgresql://localhost/test"):
        with patch("app.pat_auth.resolve_pat_context_sync", return_value=ctx):
            with pytest.raises(HTTPException) as exc_info:
                await resolve_pat_or_none("syn-deadbeef")
            assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_resolve_pat_or_none_ok():
    ctx = PatAuthContext(
        user_id="u1",
        org_id="o1",
        username="alice",
        role="user",
        scopes=["model:readonly"],
        token_row_id="tid",
    )
    with patch("app.pat_auth.pat_lookup_database_url", return_value="postgresql://localhost/test"):
        with patch("app.pat_auth.resolve_pat_context_sync", return_value=ctx):
            out = await resolve_pat_or_none("syn-deadbeef")
            assert out is not None and out.user_id == "u1"
