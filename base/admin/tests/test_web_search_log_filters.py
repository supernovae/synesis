from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass

import pytest


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

    async def execute(self, *_args, **_kwargs):
        self._calls += 1
        if self._calls == 1:
            return _FakeCountResult(1)
        return _FakeRowsResult([self._row])


@asynccontextmanager
async def _fake_async_session():
    yield _FakeSession()


@pytest.mark.anyio
async def test_web_search_log_returns_attribution_fields():
    from app.routers import integrations as integrations_router

    integrations_router.async_session = _fake_async_session
    body = await integrations_router.web_search_log(
        _user=None,  # Unused in handler; route auth is tested elsewhere.
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

