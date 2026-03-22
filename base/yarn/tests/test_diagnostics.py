from __future__ import annotations

from app.telemetry.diagnostics import SessionDiagnostics, _deterministic_sample, _hash_id


def test_hash_id_is_stable_and_truncated():
    assert _hash_id("abc") == _hash_id("abc")
    assert len(_hash_id("abc")) == 16


def test_deterministic_sample_rate_bounds():
    assert _deterministic_sample("req-1", 0.0) is False
    assert _deterministic_sample("req-1", 1.0) is True


def test_diagnostics_records_tool_events():
    d = SessionDiagnostics.create(
        request_id="req-1",
        session_key="s-1",
        user_id="u-1",
        conversation_id="c-1",
    )
    d.record_tool("list_traces", True)
    d.record_tool("list_models", False)
    assert d.tool_events[0]["status"] == "success"
    assert d.tool_events[1]["status"] == "error"
