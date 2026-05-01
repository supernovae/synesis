from __future__ import annotations

from unittest.mock import AsyncMock

from app.auth import UserInfo
from app.main import app
from app.rbac import require_platform_admin
from fastapi import HTTPException
from fastapi.testclient import TestClient


async def _platform_admin() -> UserInfo:
    return UserInfo(username="admin", role="platform_admin", user_id="admin")


async def _regular_user() -> UserInfo:
    raise HTTPException(status_code=403, detail="Requires platform_admin role")


def test_trace_archive_selected(monkeypatch):
    archive_result = {
        "dry_run": False,
        "delete_after_archive": True,
        "matched": 1,
        "selected": 1,
        "limited": False,
        "archive": {"key": "admin-archives/traces/test.jsonl.gz", "record_count": 2},
        "deleted": 1,
    }
    mock_archive = AsyncMock(return_value=archive_result)
    monkeypatch.setattr("app.services.trace_store.archive_traces", mock_archive)
    app.dependency_overrides[require_platform_admin] = _platform_admin
    try:
        client = TestClient(app)
        resp = client.post(
            "/api/v1/traces/archive",
            json={"trace_ids": ["trace-1"], "dry_run": False, "delete_after_archive": True},
        )
    finally:
        app.dependency_overrides.pop(require_platform_admin, None)

    assert resp.status_code == 200
    assert resp.json()["deleted"] == 1
    kwargs = mock_archive.await_args.kwargs
    assert kwargs["trace_ids"] == ["trace-1"]
    assert kwargs["delete_after_archive"] is True


def test_trace_archive_requires_platform_admin():
    app.dependency_overrides[require_platform_admin] = _regular_user
    try:
        client = TestClient(app)
        resp = client.post("/api/v1/traces/archive", json={"trace_ids": ["trace-1"], "dry_run": True})
    finally:
        app.dependency_overrides.pop(require_platform_admin, None)
    assert resp.status_code == 403
