"""Route-group enforcement tests for RAG endpoints."""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from fastapi import Request
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

_auth_ctx: dict[str, object] = {"user": None}


def _user(*, role: str, org_id: str = "", tenant_ids: list[str] | None = None):
    from app.auth import UserInfo

    return UserInfo(
        user_id="u1",
        username="alice",
        email="alice@test.local",
        role=role,
        org_id=org_id,
        org_name="",
        tenant_ids=tenant_ids or [],
        org_roles=[],
    )


async def _override_rag_get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = None,
):
    from app.auth import UserInfo

    user = _auth_ctx["user"]
    assert isinstance(user, UserInfo)
    return user


class _FakeScalar:
    def scalar_one_or_none(self):
        return None

    def scalars(self):
        return self

    def all(self):
        return []

    def first(self):
        return None


class _FakeSession:
    async def execute(self, *a, **kw):
        return _FakeScalar()

    async def commit(self):
        pass

    def add(self, obj):
        pass

    def add_all(self, objs):
        pass


@asynccontextmanager
async def _fake_async_session():
    yield _FakeSession()


@pytest.fixture(autouse=True)
def _patch_runtime(monkeypatch):
    monkeypatch.setattr("app.db.engine.async_session", _fake_async_session)
    monkeypatch.setattr("app.services.milvus_service.collection_domain_hierarchy", lambda *a, **kw: [])
    monkeypatch.setattr("app.services.milvus_service.safe_query", lambda *a, **kw: [])
    monkeypatch.setattr("app.services.milvus_service.collection_stats", lambda *a, **kw: {"row_count": 0})
    _auth_ctx["user"] = _user(role="org_admin", org_id="org-a")


@pytest.fixture()
def client():
    import app.routers.rag as rag_mod
    from app.main import app

    prev_user_dep = app.dependency_overrides.get(rag_mod.get_current_user)
    app.dependency_overrides[rag_mod.get_current_user] = _override_rag_get_current_user
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        if prev_user_dep is None:
            app.dependency_overrides.pop(rag_mod.get_current_user, None)
        else:
            app.dependency_overrides[rag_mod.get_current_user] = prev_user_dep


def test_rag_read_endpoint_denies_tenant_operator(client):
    _auth_ctx["user"] = _user(role="user", org_id="org-a", tenant_ids=["tenant-1"])
    resp = client.get("/api/v1/rag/quality")
    assert resp.status_code == 403
    assert "org_observability" in resp.text


def test_rag_write_endpoint_denies_tenant_operator(client):
    _auth_ctx["user"] = _user(role="user", org_id="org-a", tenant_ids=["tenant-1"])
    resp = client.post("/api/v1/rag/quality/refresh")
    assert resp.status_code == 403
    assert "org_content_admin" in resp.text


def test_rag_write_endpoint_allows_org_admin(client):
    _auth_ctx["user"] = _user(role="org_admin", org_id="org-a")
    resp = client.post("/api/v1/rag/quality/refresh")
    assert resp.status_code == 200
