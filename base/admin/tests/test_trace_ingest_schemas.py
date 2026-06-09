from __future__ import annotations

import pytest
from app.routers.traces import TraceArchiveRequest, TraceIngestBody
from fastapi import HTTPException
from pydantic import ValidationError


def test_trace_ingest_accepts_known_payload() -> None:
    body = TraceIngestBody(
        service="planner",
        trace_id="trace-1",
        request_id="req-1",
        user_id="u1",
        org_id="o1",
        tenant_id="t1",
        model="synesis-agent",
        tokens={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        cost={
            "estimated_usd": 0.0001,
            "actual_usd": 0.0,
            "rates_snapshot": {
                "input_per_million": 1.0,
                "output_per_million": 2.0,
                "cached_input_per_million": 0.1,
            },
        },
        latency_ms=100.0,
        classification={"difficulty": 0.5, "taxonomy_key": "programming"},
        spans=[
            {
                "node_name": "planner",
                "start_time": 1,
                "end_time": 2,
                "latency_ms": 100,
                "tokens_used": 15,
                "confidence": 0.9,
                "outcome": "ok",
                "llm_calls": [{"model": "m", "node": "planner", "total_tokens": 15}],
            }
        ],
    )

    payload = body.model_dump(exclude_none=True)
    assert payload["trace_id"] == "trace-1"
    assert payload["classification"]["taxonomy_key"] == "programming"
    assert payload["spans"][0]["llm_calls"][0]["model"] == "m"


def test_trace_ingest_rejects_unknown_top_level_field() -> None:
    with pytest.raises(ValidationError, match="admin_override"):
        TraceIngestBody(trace_id="trace-1", admin_override=True)


def test_trace_ingest_requires_trace_or_request_id() -> None:
    with pytest.raises(ValidationError, match="trace_id or request_id is required"):
        TraceIngestBody(service="planner")


def test_trace_ingest_rejects_unknown_nested_token_field() -> None:
    with pytest.raises(ValidationError, match="token_admin"):
        TraceIngestBody(trace_id="trace-1", tokens={"total_tokens": 10, "token_admin": True})


def test_trace_ingest_rejects_unknown_span_field() -> None:
    with pytest.raises(ValidationError, match="tool_override"):
        TraceIngestBody(
            trace_id="trace-1",
            spans=[
                {
                    "node_name": "planner",
                    "llm_calls": [],
                    "tool_override": "service_health",
                }
            ],
        )


def test_trace_archive_request_rejects_invented_trace_service() -> None:
    with pytest.raises(ValidationError, match="trace_service"):
        TraceArchiveRequest(trace_ids=["trace-1"], trace_service='planner"\nadmin=true')


def test_trace_archive_request_rejects_invalid_trace_id() -> None:
    with pytest.raises(ValidationError, match="control characters"):
        TraceArchiveRequest(trace_ids=["trace-1", "bad\ntrace"])


@pytest.mark.anyio
async def test_trace_bulk_delete_rejects_invalid_trace_id_before_db_access() -> None:
    from app.routers import traces as traces_router

    with pytest.raises(HTTPException) as exc:
        await traces_router.bulk_delete_traces(trace_ids=["trace-1", "bad\ntrace"])

    assert exc.value.status_code == 422


@pytest.mark.anyio
async def test_trace_session_delete_rejects_oversized_conversation_before_store(monkeypatch) -> None:
    from app.routers import traces as traces_router

    called = False

    async def _delete(_conversation_id: str) -> int:
        nonlocal called
        called = True
        return 0

    monkeypatch.setattr(traces_router.trace_store, "delete_traces_for_conversation", _delete)

    with pytest.raises(HTTPException) as exc:
        await traces_router.delete_traces_for_session(conversation_id="c" * 129)

    assert exc.value.status_code == 422
    assert called is False


def test_trace_store_clean_trace_ids_does_not_truncate_to_prefix() -> None:
    from app.services.trace_store import _clean_trace_ids

    assert _clean_trace_ids(["trace-1", "trace-1" + "x" * 64, "trace-2"]) == ["trace-1", "trace-2"]
