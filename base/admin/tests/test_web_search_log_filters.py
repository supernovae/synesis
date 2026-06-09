from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass

import pytest
from app.auth import UserInfo
from fastapi import HTTPException
from pydantic import ValidationError


@dataclass
class _FakeWebSearchRow:
    id: int = 1
    timestamp: float = 1_700_000_000.0
    run_id: str = "run-1"
    query: str = "synesis web search"
    source_id: str = "src-1"
    profile: str = "web"
    url: str = "https://example.com"
    domain: str = "example.com"
    title: str = "Example"
    snippet: str = "snippet"
    score: float = 0.91
    latency_ms: float = 123.0
    outcome: str = "success"
    engine: str = "duckduckgo"
    org_id: str = "org-1"
    user_id: str = "user-1"
    tenant_id: str = "tenant-1"
    request_id: str = "req-1"
    session_key: str = "conversation:abc"
    conversation_id: str = "abc"
    trace_id: str = "trace-1"
    source_surface: str = "yarn_chat"
    tool_name: str = "synesis_web_search"
    query_hash: str = "hash-1"
    rate_bucket_key: str = "bucket-1"
    blocked_reason: str = ""
    policy_action: str = "allow"
    token_estimate: int = 7


class _FakeCountResult:
    def __init__(self, value: int) -> None:
        self._value = value

    def scalar(self):
        return self._value


class _FakeRowsResult:
    def __init__(self, rows: list[_FakeWebSearchRow]) -> None:
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _FakeSession:
    def __init__(self) -> None:
        self._calls = 0
        self._row = _FakeWebSearchRow()
        self.statements = []

    async def execute(self, *_args, **_kwargs):
        self._calls += 1
        self.statements.append(_args[0])
        if self._calls == 1:
            return _FakeCountResult(1)
        return _FakeRowsResult([self._row])


_last_fake_session: _FakeSession | None = None


@asynccontextmanager
async def _fake_async_session():
    global _last_fake_session
    _last_fake_session = _FakeSession()
    yield _last_fake_session


def _user(**overrides) -> UserInfo:
    data = {
        "username": "user-1",
        "role": "user",
        "user_id": "user-1",
        "org_id": "",
        "tenant_ids": [],
    }
    data.update(overrides)
    return UserInfo(**data)


def test_web_search_global_policy_controls_require_platform_admin():
    from app.routers.integrations import _ensure_platform_control

    with pytest.raises(HTTPException) as exc:
        _ensure_platform_control(_user(role="org_admin", org_id="org-allowed"))

    assert exc.value.status_code == 403

    _ensure_platform_control(_user(role="platform_admin"))


@pytest.mark.anyio
async def test_web_search_policy_routes_deny_org_admin_before_db_access():
    from app.routers import integrations as integrations_router

    org_admin = _user(role="org_admin", user_id="admin-1", org_id="org-allowed")

    with pytest.raises(HTTPException) as list_exc:
        await integrations_router.list_policies(user=org_admin)
    assert list_exc.value.status_code == 403

    with pytest.raises(HTTPException) as create_exc:
        await integrations_router.create_or_update_policy(
            body=integrations_router.PolicyCreate(url_pattern="example.com", policy="allow"),
            user=org_admin,
        )
    assert create_exc.value.status_code == 403

    with pytest.raises(HTTPException) as delete_exc:
        await integrations_router.delete_policy(policy_id=1, user=org_admin)
    assert delete_exc.value.status_code == 403


@pytest.mark.anyio
async def test_web_search_ingest_route_denies_org_admin_before_db_access():
    from app.routers import integrations as integrations_router

    with pytest.raises(HTTPException) as exc:
        await integrations_router.ingest_url(
            body=integrations_router.IngestRequest(url="https://example.com/doc"),
            user=_user(role="org_admin", user_id="admin-1", org_id="org-allowed"),
        )

    assert exc.value.status_code == 403


@pytest.mark.anyio
async def test_web_search_log_returns_attribution_fields():
    from app.routers import integrations as integrations_router

    integrations_router.async_session = _fake_async_session
    body = await integrations_router.web_search_log(
        user=_user(role="platform_admin"),
        domain="",
        outcome="",
        source_surface="yarn_chat",
        org_id="",
        user_id="",
        session_key="",
        request_id="req-1",
        trace_id="",
        tool_name="",
        engine="",
        query_filter="",
        page=1,
        page_size=30,
    )
    assert body["total"] == 1
    assert len(body["items"]) == 1
    row = body["items"][0]
    assert row["source_surface"] == "yarn_chat"
    assert row["request_id"] == "req-1"
    assert row["tool_name"] == "synesis_web_search"
    assert row["query_hash"] == "hash-1"


@pytest.mark.anyio
async def test_web_search_log_applies_org_scope_even_with_other_org_filter():
    from app.routers import integrations as integrations_router

    integrations_router.async_session = _fake_async_session
    await integrations_router.web_search_log(
        user=_user(role="org_admin", user_id="admin-1", org_id="org-allowed"),
        domain="",
        outcome="",
        source_surface="",
        org_id="org-other",
        user_id="",
        session_key="",
        request_id="",
        trace_id="",
        tool_name="",
        engine="",
        query_filter="",
        page=1,
        page_size=30,
    )
    assert _last_fake_session is not None
    sql = str(_last_fake_session.statements[0])
    assert "web_search_log.org_id = :org_id_1" in sql
    assert "web_search_log.org_id = :org_id_2" in sql
    assert "web_search_log.user_id =" not in sql


@pytest.mark.anyio
async def test_web_search_log_applies_self_scope_for_non_admin():
    from app.routers import integrations as integrations_router

    integrations_router.async_session = _fake_async_session
    await integrations_router.web_search_log(
        user=_user(role="user", user_id="user-allowed"),
        domain="",
        outcome="",
        source_surface="",
        org_id="",
        user_id="user-other",
        session_key="",
        request_id="",
        trace_id="",
        tool_name="",
        engine="",
        query_filter="",
        page=1,
        page_size=30,
    )
    assert _last_fake_session is not None
    sql = str(_last_fake_session.statements[0])
    assert "web_search_log.user_id = :user_id_1" in sql
    assert "web_search_log.user_id = :user_id_2" in sql


@pytest.mark.anyio
async def test_web_search_log_rejects_invented_outcome_filter():
    from app.routers import integrations as integrations_router

    with pytest.raises(HTTPException) as exc:
        await integrations_router.web_search_log(
            user=_user(role="platform_admin"),
            domain="",
            outcome='success"\nrole=admin',
            source_surface="",
            org_id="",
            user_id="",
            session_key="",
            request_id="",
            trace_id="",
            tool_name="",
            engine="",
            query_filter="",
            page=1,
            page_size=30,
        )

    assert exc.value.status_code == 422


@pytest.mark.anyio
async def test_web_search_log_rejects_control_character_filter():
    from app.routers import integrations as integrations_router

    with pytest.raises(HTTPException) as exc:
        await integrations_router.web_search_log(
            user=_user(role="platform_admin"),
            domain="example.com\x00",
            outcome="success",
            source_surface="yarn_chat",
            org_id="",
            user_id="",
            session_key="",
            request_id="",
            trace_id="",
            tool_name="",
            engine="",
            query_filter="",
            page=1,
            page_size=30,
        )

    assert exc.value.status_code == 422


def test_web_search_policy_create_rejects_invented_policy_and_extra_fields():
    from app.routers.integrations import PolicyCreate

    with pytest.raises(ValidationError, match="policy"):
        PolicyCreate(url_pattern="example.com", policy='allow"\nrole=admin')

    with pytest.raises(ValidationError, match="admin_override"):
        PolicyCreate(url_pattern="example.com", policy="allow", admin_override=True)


def test_web_search_policy_create_accepts_known_policy_states():
    from app.routers.integrations import PolicyCreate

    for policy in ("allow", "block", "vetted"):
        body = PolicyCreate(url_pattern="example.com", policy=policy)
        assert body.policy == policy


def test_web_search_ingest_request_rejects_extra_fields():
    from app.routers.integrations import IngestRequest

    with pytest.raises(ValidationError, match="admin_override"):
        IngestRequest(url="https://example.com/doc", admin_override=True)


@pytest.mark.anyio
async def test_web_search_ingest_rejects_private_resolution_before_db_access(monkeypatch):
    from app.routers import integrations as integrations_router

    called = False

    @asynccontextmanager
    async def _tracking_session():
        nonlocal called
        called = True
        yield _FakeSession()

    monkeypatch.setattr(integrations_router, "async_session", _tracking_session)
    monkeypatch.setattr(
        "app.services.outbound_security.socket.getaddrinfo",
        lambda *a, **kw: [(None, None, None, None, ("10.0.0.5", 443))],
    )

    with pytest.raises(HTTPException) as exc:
        await integrations_router.ingest_url(
            body=integrations_router.IngestRequest(url="https://internal.example/doc"),
            user=_user(role="platform_admin"),
        )

    assert exc.value.status_code == 400
    assert "blocked network" in str(exc.value.detail)
    assert called is False
