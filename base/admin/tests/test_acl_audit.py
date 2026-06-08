from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from app.auth import UserInfo


class _ScalarResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


class _DeleteResult:
    rowcount = 1


class _FakeSession:
    def __init__(self, results):
        self._results = list(results)
        self.added = []
        self.committed = False

    async def execute(self, *_args, **_kwargs):
        return self._results.pop(0)

    def add(self, row):
        self.added.append(row)

    async def commit(self):
        self.committed = True


def _user() -> UserInfo:
    return UserInfo(
        user_id="org-admin-1",
        username="org-admin",
        role="org_admin",
        org_id="org-1",
    )


@pytest.mark.anyio
async def test_add_acl_member_records_admin_audit(monkeypatch):
    from app.routers import acl

    session = _FakeSession(
        [
            _ScalarResult(SimpleNamespace(group_id="grp-1", org_id="org-1")),
            _ScalarResult(None),
        ]
    )

    @asynccontextmanager
    async def fake_session():
        yield session

    audit = AsyncMock()
    monkeypatch.setattr(acl, "async_session", fake_session)
    monkeypatch.setattr(acl, "record_admin_audit", audit)

    body = acl.MemberAdd(user_id="member-1")
    response = await acl.add_member(group_id="grp-1", body=body, _user=_user())

    assert response == {"ok": True, "status": "added"}
    audit.assert_awaited_once()
    kwargs = audit.await_args.kwargs
    assert kwargs["action"] == "acl.group.member.add"
    assert kwargs["detail"] == {"group_id": "grp-1", "member_user_id": "member-1", "org_id": "org-1"}


@pytest.mark.anyio
async def test_remove_acl_member_records_admin_audit(monkeypatch):
    from app.routers import acl

    session = _FakeSession(
        [
            _ScalarResult(SimpleNamespace(group_id="grp-1", org_id="org-1")),
            _DeleteResult(),
        ]
    )

    @asynccontextmanager
    async def fake_session():
        yield session

    audit = AsyncMock()
    monkeypatch.setattr(acl, "async_session", fake_session)
    monkeypatch.setattr(acl, "record_admin_audit", audit)

    response = await acl.remove_member(group_id="grp-1", user_id="member-1", _user=_user())

    assert response == {"ok": True}
    audit.assert_awaited_once()
    kwargs = audit.await_args.kwargs
    assert kwargs["action"] == "acl.group.member.remove"
    assert kwargs["detail"] == {"group_id": "grp-1", "member_user_id": "member-1", "org_id": "org-1"}
