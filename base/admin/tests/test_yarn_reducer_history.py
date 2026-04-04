"""Unit tests for Yarn reducer snapshot rollups."""

from __future__ import annotations

from app.services.yarn_reducer_history import rollup_reducer_snapshots


def test_rollup_requires_two_snapshots() -> None:
    assert rollup_reducer_snapshots([])["reduced_count_delta"] == 0
    assert rollup_reducer_snapshots([{"payload": {"reducedCount": 5}}])["reduced_count_delta"] == 0


def test_rollup_consecutive_deltas() -> None:
    rows = [
        {
            "payload": {
                "reducedCount": 10,
                "reducerFailures": 1,
                "lifecycle": {"lint": {"successes": 5, "failures": 0}},
            }
        },
        {
            "payload": {
                "reducedCount": 14,
                "reducerFailures": 2,
                "lifecycle": {"lint": {"successes": 8, "failures": 1}},
            }
        },
    ]
    r = rollup_reducer_snapshots(rows)
    assert r["reduced_count_delta"] == 4
    assert r["reducer_failures_delta"] == 1
    assert r["lifecycle"]["lint"]["success_delta"] == 3
    assert r["lifecycle"]["lint"]["fail_delta"] == 1


def test_rollup_treats_drop_as_restart() -> None:
    rows = [
        {"payload": {"reducedCount": 100, "reducerFailures": 1}},
        {"payload": {"reducedCount": 3, "reducerFailures": 0}},
    ]
    r = rollup_reducer_snapshots(rows)
    assert r["reduced_count_delta"] == 3
    assert r["reducer_failures_delta"] == 0
