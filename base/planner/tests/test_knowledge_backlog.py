from __future__ import annotations

import os
import sys
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import knowledge_backlog


class _FakeCursor:
    def __init__(self) -> None:
        self.sql = ""
        self.params = ()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.sql = sql
        self.params = params or ()


class _FakeConn:
    def __init__(self) -> None:
        self.cursor_obj = _FakeCursor()
        self.autocommit = False

    def cursor(self):
        return self.cursor_obj


@pytest.mark.asyncio
async def test_publish_knowledge_gap_includes_resolution_columns(monkeypatch):
    fake_conn = _FakeConn()

    @contextmanager
    def _fake_pg_connection(*, autocommit=True):
        fake_conn.autocommit = autocommit
        yield fake_conn

    import app.pg_pool as pg_pool_mod

    monkeypatch.setattr(pg_pool_mod, "pg_connection", _fake_pg_connection)
    import app.config as cfg

    monkeypatch.setattr(cfg, "settings", SimpleNamespace(knowledge_backlog_enabled=True), raising=False)

    gap_id = await knowledge_backlog.publish_knowledge_gap(
        query="missing policy details",
        task_description="need docs",
        collections_queried=["docs"],
        max_score=0.1,
        platform_context="generic",
        target_language="python",
        web_search_fallback=False,
    )

    assert gap_id is not None
    assert "resolved_at" in fake_conn.cursor_obj.sql
    assert "resolved_by" in fake_conn.cursor_obj.sql
    assert "resolution_note" in fake_conn.cursor_obj.sql
    assert len(fake_conn.cursor_obj.params) == 12
    assert fake_conn.cursor_obj.params[7] == 0
    assert fake_conn.cursor_obj.params[8] == ""
    assert fake_conn.cursor_obj.params[9] == ""
