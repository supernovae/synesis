from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from app.auth import UserInfo
from app.routers.tokens import TokenCreate, _effective_tenant_ids, create_token
from fastapi import HTTPException
from pydantic import ValidationError


def test_token_create_rejects_malformed_tenant_id() -> None:
    with pytest.raises(ValidationError, match="tenant_id"):
        TokenCreate(name="coder", tenant_ids=["tenant-1\nrole=admin"])


def test_token_create_rejects_oversized_tenant_id_without_truncating() -> None:
    with pytest.raises(ValidationError, match="tenant_id"):
        TokenCreate(name="coder", tenant_ids=["t" * 65])


def test_token_create_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError, match="org_id"):
        TokenCreate(name="coder", org_id="org-admin")


def test_token_create_dedupes_valid_tenant_ids() -> None:
    body = TokenCreate(name="coder", tenant_ids=["tenant-1", "tenant-1", "tenant-2"])

    assert body.tenant_ids == ["tenant-1", "tenant-2"]


def test_token_create_rejects_invented_scope_prefix() -> None:
    with pytest.raises(ValidationError, match="Invalid scopes"):
        TokenCreate(name="coder", scopes=["model-admin"])


def test_token_scope_contract_uses_exact_known_scopes() -> None:
    from app.token_scopes import has_token_scope, has_write_scope, invalid_token_scopes, normalize_token_scopes

    assert invalid_token_scopes(["model-admin", "coder:readonly"]) == ["model-admin"]
    assert normalize_token_scopes(["model-admin", "coder:readonly"], allow_legacy_default=False) == ["coder:readonly"]
    assert normalize_token_scopes(None) == ["model:readonly"]
    assert normalize_token_scopes([]) == []
    assert normalize_token_scopes(["model-admin"]) == []
    assert has_token_scope(["model-admin"], "model") is False
    assert has_token_scope(["model:readonly"], "model") is True
    assert has_write_scope(["model:readonly"], "model") is False
    assert has_write_scope(["model:readwrite"], "model") is True


def test_rbac_scope_checks_do_not_accept_prefix_only_scopes() -> None:
    from app.auth import UserInfo
    from app.rbac import has_token_scope, has_write_scope

    user = UserInfo(username="u1", role="user", user_id="u1", token_scopes=["model-admin", "coder_override"])

    assert has_token_scope(user, "model") is False
    assert has_token_scope(user, "coder") is False
    assert has_write_scope(user, "model") is False


def test_fga_contract_rejects_malformed_tuple_components() -> None:
    from app.routers.authz import CheckRequest, TupleWrite
    from app.services.fga_contract import fga_subject, fga_tuple_key

    assert fga_subject("org:org-a#member") == "org:org-a#member"
    assert fga_tuple_key("user:u1", "can_invoke", "planner_endpoint:chat_completions") == {
        "user": "user:u1",
        "relation": "can_invoke",
        "object": "planner_endpoint:chat_completions",
    }

    with pytest.raises(ValueError, match=r"user_id|subject_id"):
        fga_subject("user:u1\nadmin")

    with pytest.raises(ValueError, match="Unsupported FGA object type"):
        fga_tuple_key("user:u1", "can_invoke", "unknown:thing")

    with pytest.raises(ValidationError):
        TupleWrite(user="user:u1", relation="can_invoke", object="planner_endpoint:chat_completions", role="admin")

    with pytest.raises(ValidationError):
        CheckRequest(user="user:u1", relation="can_invoke\nadmin", object="planner_endpoint:chat_completions")


def test_effective_tenant_ids_drops_malformed_stored_values() -> None:
    assert _effective_tenant_ids(["tenant-1", "tenant-2\nrole=admin", "tenant-3"]) == ["tenant-1", "tenant-3"]


@pytest.mark.asyncio
async def test_fga_tuple_writer_uses_exact_scopes_and_safe_identity(monkeypatch) -> None:
    from app.services import fga_tuple_writer

    writes: list[dict[str, str]] = []

    async def _capture_writes(items: list[dict[str, str]]) -> bool:
        writes.extend(items)
        return True

    monkeypatch.setattr(fga_tuple_writer, "_write_tuples", _capture_writes)

    await fga_tuple_writer.on_pat_created(
        user_id="u1",
        org_id="org-a\nrole=admin",
        tenant_ids=["tenant-1", "tenant-2\nrole=admin"],
        role="org_admin",
        scopes=["model-admin", "coder:readonly"],
    )

    assert {"user": "user:u1", "relation": "can_invoke", "object": "planner_endpoint:chat_completions"} not in writes
    assert {"user": "user:u1", "relation": "can_invoke", "object": "yarn_endpoint:completions"} in writes
    assert {"user": "user:u1", "relation": "member", "object": "tenant:tenant-1"} in writes
    assert all("org:org-a" not in item["object"] for item in writes)
    assert all("tenant-2" not in item["object"] for item in writes)


@pytest.mark.asyncio
async def test_fga_tuple_writer_rejects_raw_user_and_object_injection(monkeypatch) -> None:
    from app.services import fga_tuple_writer

    writes: list[dict[str, str]] = []

    async def _capture_writes(items: list[dict[str, str]]) -> bool:
        writes.extend(items)
        return True

    monkeypatch.setattr(fga_tuple_writer, "_write_tuples", _capture_writes)

    await fga_tuple_writer.on_org_member_added("u1\nadmin", "org-a", is_admin=True)
    await fga_tuple_writer.on_feature_blocked("u1", "feature-a\nadmin")
    await fga_tuple_writer.on_tool_blocked("u1", "tool-a\nadmin")
    await fga_tuple_writer.on_platform_tool_blocked("tool-a\nadmin")
    await fga_tuple_writer.on_feature_enabled("org:org-a#member", "feature-a")

    assert writes == [{"user": "org:org-a#member", "relation": "enabled", "object": "feature:feature-a"}]


@pytest.mark.asyncio
async def test_fga_tuple_private_writers_validate_before_client_lookup(monkeypatch) -> None:
    from app.services import fga_tuple_writer

    def _unexpected_client():
        raise AssertionError("invalid tuples should fail before OpenFGA client lookup")

    monkeypatch.setattr(fga_tuple_writer, "_get_fga_client", _unexpected_client)

    assert (
        await fga_tuple_writer._write_tuples(
            [{"user": "user:u1\nadmin", "relation": "can_invoke", "object": "planner_endpoint:chat_completions"}]
        )
        is False
    )
    assert (
        await fga_tuple_writer._delete_tuples(
            [{"user": "user:u1", "relation": "can_invoke\nadmin", "object": "planner_endpoint:chat_completions"}]
        )
        is False
    )


class _FakeScalar:
    def __init__(self, value: object):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _FakeSession:
    def __init__(self, value: object):
        self._value = value

    async def execute(self, *_args, **_kwargs):
        return _FakeScalar(self._value)

    async def commit(self):
        pass


def _fake_session_factory(value: object):
    @asynccontextmanager
    async def _session():
        yield _FakeSession(value)

    return _session


class _FakeTokenWriteSession:
    def add(self, _value: object) -> None:
        raise AssertionError("token creation should fail before DB write")

    async def commit(self) -> None:
        raise AssertionError("token creation should fail before DB commit")


@pytest.mark.asyncio
async def test_token_create_rejects_malformed_authenticated_org_id() -> None:
    with pytest.raises(HTTPException) as exc:
        await create_token(
            TokenCreate(name="coder"),
            user=UserInfo(username="u1", role="user", user_id="u1", org_id="org-a\nrole=admin"),
            session=_FakeTokenWriteSession(),
        )

    assert exc.value.status_code == 403
    assert "org_id" in exc.value.detail


@pytest.mark.asyncio
async def test_pat_auth_rejects_unknown_stored_scopes(monkeypatch) -> None:
    from app.auth import _verify_pat

    pat = SimpleNamespace(
        id="pat-1",
        username="u1",
        role="user",
        user_id="u1",
        org_id="org-a",
        tenant_ids=[],
        scopes=["model-admin"],
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    monkeypatch.setattr("app.db.engine.async_session", _fake_session_factory(pat))

    assert await _verify_pat("syn-test-token", SimpleNamespace()) is None


@pytest.mark.asyncio
async def test_pat_auth_rejects_unknown_stored_role(monkeypatch) -> None:
    from app.auth import _verify_pat

    pat = SimpleNamespace(
        id="pat-1",
        username="u1",
        role="platform_admin\n",
        user_id="u1",
        org_id="org-a",
        tenant_ids=[],
        scopes=["model:readonly"],
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    monkeypatch.setattr("app.db.engine.async_session", _fake_session_factory(pat))

    assert await _verify_pat("syn-test-token", SimpleNamespace()) is None


@pytest.mark.asyncio
async def test_pat_auth_rejects_malformed_stored_org_id(monkeypatch) -> None:
    from app.auth import _verify_pat

    pat = SimpleNamespace(
        id="pat-1",
        username="u1",
        role="org_admin",
        user_id="u1",
        org_id="org-a\nrole=admin",
        tenant_ids=[],
        scopes=["model:readonly"],
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    monkeypatch.setattr("app.db.engine.async_session", _fake_session_factory(pat))

    assert await _verify_pat("syn-test-token", SimpleNamespace()) is None
