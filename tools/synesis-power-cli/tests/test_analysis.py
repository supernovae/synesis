from __future__ import annotations

from synesis_power_cli.analysis import build_kpi_snapshot, build_session_inspect


def test_build_kpi_snapshot_math() -> None:
    payload = build_kpi_snapshot(
        intelligence={"requests": 10, "completion_gate_blocked_rate": 0.2},
        performance=[
            {"requests": 5, "errors": 1, "avg_latency_ms": 100, "max_latency_ms": 180},
            {"requests": 15, "errors": 3, "avg_latency_ms": 200, "max_latency_ms": 350},
        ],
        usage_summary={"trace_count": 20},
        since_hours=24,
        bucket_minutes=15,
    )
    summary = payload["performance_summary"]
    assert summary["total_requests"] == 20
    assert summary["total_errors"] == 4
    assert summary["max_latency_ms"] == 350
    assert summary["error_rate"] == 0.2


def test_build_session_inspect_trajectory_rollup() -> None:
    detail = {
        "session": {"session_key": "abc"},
        "requests": [{"id": 1}],
        "events": [
            {
                "event_kind": "request_trajectory_v1",
                "metadata_json": {
                    "verification": {
                        "completion_gate_blocked": True,
                        "critic_blocked": False,
                        "first_pass_verify_ok": True,
                        "structured_error_coverage": 0.5,
                    }
                },
            },
            {
                "event_kind": "request_trajectory_v1",
                "metadata_json": {
                    "verification": {
                        "completion_gate_blocked": False,
                        "critic_blocked": True,
                        "first_pass_verify_ok": False,
                        "structured_error_coverage": 1.0,
                    }
                },
            },
        ],
    }
    out = build_session_inspect(detail)
    assert out["trajectory_events"] == 2
    assert out["completion_gate_blocked_events"] == 1
    assert out["critic_blocked_events"] == 1
    assert out["first_pass_verify_ok_rate"] == 0.5
    assert out["avg_structured_error_coverage"] == 0.75
