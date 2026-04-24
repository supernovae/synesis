"""Unit tests for Yarn reducer snapshot rollups."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.services.yarn_reducer_history import (
    cumulative_reducer_snapshots,
    reducer_snapshot_freshness,
    rollup_reducer_snapshots,
)


def test_rollup_requires_two_snapshots() -> None:
    assert rollup_reducer_snapshots([])["reduced_count_delta"] == 0
    assert rollup_reducer_snapshots([{"payload": {"reducedCount": 5}}])["reduced_count_delta"] == 0


def test_rollup_consecutive_deltas() -> None:
    rows = [
        {
            "payload": {
                "reducedCount": 10,
                "reducerFailures": 1,
                "guidedTruncationCount": 2,
                "taskPrunedCount": 1,
                "taskPrunedLinesKept": 8,
                "taskPrunedLinesDropped": 20,
                "rawCharsTotal": 1000,
                "reducedCharsTotal": 400,
                "netCharsSavedTotal": 600,
                "lifecycle": {"lint": {"successes": 5, "failures": 0}},
            }
        },
        {
            "payload": {
                "reducedCount": 14,
                "reducerFailures": 2,
                "guidedTruncationCount": 4,
                "taskPrunedCount": 3,
                "taskPrunedLinesKept": 16,
                "taskPrunedLinesDropped": 50,
                "rawCharsTotal": 4000,
                "reducedCharsTotal": 900,
                "netCharsSavedTotal": 3100,
                "lifecycle": {"lint": {"successes": 8, "failures": 1}},
            }
        },
    ]
    r = rollup_reducer_snapshots(rows)
    assert r["reduced_count_delta"] == 4
    assert r["reducer_failures_delta"] == 1
    assert r["guided_truncation_delta"] == 2
    assert r["task_pruned_delta"] == 2
    assert r["task_pruned_lines_kept_delta"] == 8
    assert r["task_pruned_lines_dropped_delta"] == 30
    assert r["lifecycle"]["lint"]["success_delta"] == 3
    assert r["lifecycle"]["lint"]["fail_delta"] == 1
    assert r["raw_chars_delta"] == 3000
    assert r["reduced_chars_delta"] == 500
    assert r["net_chars_saved_delta"] == 2500


def test_rollup_treats_drop_as_restart() -> None:
    rows = [
        {"payload": {"reducedCount": 100, "reducerFailures": 1}},
        {"payload": {"reducedCount": 3, "reducerFailures": 0}},
    ]
    r = rollup_reducer_snapshots(rows)
    assert r["reduced_count_delta"] == 3
    assert r["reducer_failures_delta"] == 0


def test_cumulative_uses_first_snapshot_plus_monotonic_deltas() -> None:
    rows = [
        {
            "captured_at": "2026-04-07T10:00:00+00:00",
            "payload": {
                "reducedCount": 10,
                "reducerFailures": 1,
                "tokensSavedEstimateTotal": 100,
                "fallbackToArtifactCount": 2,
                "guidedTruncationCount": 3,
                "taskPrunedCount": 1,
                "taskPrunedLinesKept": 12,
                "taskPrunedLinesDropped": 40,
                "rawCharsTotal": 800,
                "reducedCharsTotal": 200,
                "netCharsSavedTotal": 600,
                "lifecycle": {"lint": {"successes": 5, "failures": 1}},
            },
        },
        {
            "captured_at": "2026-04-07T10:05:00+00:00",
            "payload": {
                "reducedCount": 15,
                "reducerFailures": 1,
                "tokensSavedEstimateTotal": 160,
                "fallbackToArtifactCount": 3,
                "guidedTruncationCount": 5,
                "taskPrunedCount": 2,
                "taskPrunedLinesKept": 19,
                "taskPrunedLinesDropped": 66,
                "rawCharsTotal": 2000,
                "reducedCharsTotal": 500,
                "netCharsSavedTotal": 1500,
                "lifecycle": {"lint": {"successes": 9, "failures": 1}},
            },
        },
        {
            "captured_at": "2026-04-07T10:10:00+00:00",
            "payload": {
                "reducedCount": 2,  # restart
                "reducerFailures": 0,
                "tokensSavedEstimateTotal": 25,
                "fallbackToArtifactCount": 0,
                "guidedTruncationCount": 1,
                "taskPrunedCount": 1,
                "taskPrunedLinesKept": 6,
                "taskPrunedLinesDropped": 11,
                "rawCharsTotal": 100,
                "reducedCharsTotal": 40,
                "netCharsSavedTotal": 60,
                "lifecycle": {"lint": {"successes": 1, "failures": 0}},
            },
        },
    ]
    c = cumulative_reducer_snapshots(rows)
    assert c["reduced_count_total"] == 17  # 10 + 5 + 2
    assert c["reducer_failures_total"] == 1  # 1 + 0 + 0
    assert c["tokens_saved_estimate_total"] == 185  # 100 + 60 + 25
    assert c["fallback_to_artifact_total"] == 3  # 2 + 1 + 0
    assert c["guided_truncation_total"] == 6  # 3 + 2 + 1
    assert c["task_pruned_total"] == 3  # 1 + 1 + 1
    assert c["task_pruned_lines_kept_total"] == 25  # 12 + 7 + 6
    assert c["task_pruned_lines_dropped_total"] == 77  # 40 + 26 + 11
    assert c["lifecycle"]["lint"]["success_total"] == 10  # 5 + 4 + 1
    assert c["lifecycle"]["lint"]["fail_total"] == 1  # 1 + 0 + 0
    assert c["raw_chars_total"] == 2100  # 800 + (2000-800) + 100 restart increment
    assert c["reduced_chars_total"] == 540  # 200 + 300 + 40
    assert c["net_chars_saved_total"] == 1560  # 600 + 900 + 60


def test_reducer_snapshot_freshness_marks_stale() -> None:
    now = datetime(2026, 4, 7, 12, 0, tzinfo=UTC)
    rows = [
        {"captured_at": (now - timedelta(minutes=30)).isoformat(), "payload": {}},
    ]
    freshness = reducer_snapshot_freshness(rows, now=now, stale_after_minutes=20)
    assert freshness["latest_snapshot_at"] is not None
    assert freshness["stale"] is True


def test_reducer_snapshot_freshness_empty_rows() -> None:
    freshness = reducer_snapshot_freshness([])
    assert freshness["latest_snapshot_at"] is None
    assert freshness["stale"] is True
