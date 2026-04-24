"""Roll up Yarn reducer telemetry snapshots into deltas and cumulative totals."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any


def _monotonic_delta(prev: int, curr: int) -> int:
    """Positive increment; if counters dropped (restart), treat curr as new baseline."""
    if curr >= prev:
        return curr - prev
    return curr


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _parse_captured_at(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def rollup_reducer_snapshots(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Sum deltas between consecutive snapshots (rows sorted ascending by captured_at).

    Each row: ``{"captured_at": iso, "payload": { ... toolResultReduction ... }}``.
    """
    empty = {
        "reduced_count_delta": 0,
        "reducer_failures_delta": 0,
        "tokens_saved_estimate_delta": 0,
        "fallback_to_artifact_delta": 0,
        "guided_truncation_delta": 0,
        "task_pruned_delta": 0,
        "task_pruned_lines_kept_delta": 0,
        "task_pruned_lines_dropped_delta": 0,
        "raw_chars_delta": 0,
        "reduced_chars_delta": 0,
        "net_chars_saved_delta": 0,
        "lifecycle": {},
    }
    if len(rows) < 2:
        return empty

    totals = {
        "reduced_count_delta": 0,
        "reducer_failures_delta": 0,
        "tokens_saved_estimate_delta": 0,
        "fallback_to_artifact_delta": 0,
        "guided_truncation_delta": 0,
        "task_pruned_delta": 0,
        "task_pruned_lines_kept_delta": 0,
        "task_pruned_lines_dropped_delta": 0,
        "raw_chars_delta": 0,
        "reduced_chars_delta": 0,
        "net_chars_saved_delta": 0,
        "lifecycle": defaultdict(lambda: {"success_delta": 0, "fail_delta": 0}),
    }

    for i in range(1, len(rows)):
        prev = rows[i - 1].get("payload") or {}
        curr = rows[i].get("payload") or {}
        totals["reduced_count_delta"] += _monotonic_delta(
            _as_int(prev.get("reducedCount")), _as_int(curr.get("reducedCount"))
        )
        totals["reducer_failures_delta"] += _monotonic_delta(
            _as_int(prev.get("reducerFailures")), _as_int(curr.get("reducerFailures"))
        )
        totals["tokens_saved_estimate_delta"] += _monotonic_delta(
            _as_int(prev.get("tokensSavedEstimateTotal")),
            _as_int(curr.get("tokensSavedEstimateTotal")),
        )
        totals["fallback_to_artifact_delta"] += _monotonic_delta(
            _as_int(prev.get("fallbackToArtifactCount")),
            _as_int(curr.get("fallbackToArtifactCount")),
        )
        totals["guided_truncation_delta"] += _monotonic_delta(
            _as_int(prev.get("guidedTruncationCount")),
            _as_int(curr.get("guidedTruncationCount")),
        )
        totals["task_pruned_delta"] += _monotonic_delta(
            _as_int(prev.get("taskPrunedCount")),
            _as_int(curr.get("taskPrunedCount")),
        )
        totals["task_pruned_lines_kept_delta"] += _monotonic_delta(
            _as_int(prev.get("taskPrunedLinesKept")),
            _as_int(curr.get("taskPrunedLinesKept")),
        )
        totals["task_pruned_lines_dropped_delta"] += _monotonic_delta(
            _as_int(prev.get("taskPrunedLinesDropped")),
            _as_int(curr.get("taskPrunedLinesDropped")),
        )
        totals["raw_chars_delta"] += _monotonic_delta(
            _as_int(prev.get("rawCharsTotal")), _as_int(curr.get("rawCharsTotal"))
        )
        totals["reduced_chars_delta"] += _monotonic_delta(
            _as_int(prev.get("reducedCharsTotal")), _as_int(curr.get("reducedCharsTotal"))
        )
        totals["net_chars_saved_delta"] += _monotonic_delta(
            _as_int(prev.get("netCharsSavedTotal")), _as_int(curr.get("netCharsSavedTotal"))
        )

        prev_l = prev.get("lifecycle") if isinstance(prev.get("lifecycle"), dict) else {}
        curr_l = curr.get("lifecycle") if isinstance(curr.get("lifecycle"), dict) else {}
        for fam in set(prev_l) | set(curr_l):
            ps = _as_int((prev_l.get(fam) or {}).get("successes"))
            pf = _as_int((prev_l.get(fam) or {}).get("failures"))
            cs = _as_int((curr_l.get(fam) or {}).get("successes"))
            cf = _as_int((curr_l.get(fam) or {}).get("failures"))
            totals["lifecycle"][fam]["success_delta"] += _monotonic_delta(ps, cs)
            totals["lifecycle"][fam]["fail_delta"] += _monotonic_delta(pf, cf)

    lifecycle_out = {k: dict(v) for k, v in sorted(totals["lifecycle"].items())}
    return {
        "reduced_count_delta": totals["reduced_count_delta"],
        "reducer_failures_delta": totals["reducer_failures_delta"],
        "tokens_saved_estimate_delta": totals["tokens_saved_estimate_delta"],
        "fallback_to_artifact_delta": totals["fallback_to_artifact_delta"],
        "guided_truncation_delta": totals["guided_truncation_delta"],
        "task_pruned_delta": totals["task_pruned_delta"],
        "task_pruned_lines_kept_delta": totals["task_pruned_lines_kept_delta"],
        "task_pruned_lines_dropped_delta": totals["task_pruned_lines_dropped_delta"],
        "raw_chars_delta": totals["raw_chars_delta"],
        "reduced_chars_delta": totals["reduced_chars_delta"],
        "net_chars_saved_delta": totals["net_chars_saved_delta"],
        "lifecycle": lifecycle_out,
    }


def cumulative_reducer_snapshots(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute cumulative totals from retained snapshots (restart-tolerant)."""
    empty = {
        "reduced_count_total": 0,
        "reducer_failures_total": 0,
        "tokens_saved_estimate_total": 0,
        "fallback_to_artifact_total": 0,
        "guided_truncation_total": 0,
        "task_pruned_total": 0,
        "task_pruned_lines_kept_total": 0,
        "task_pruned_lines_dropped_total": 0,
        "raw_chars_total": 0,
        "reduced_chars_total": 0,
        "net_chars_saved_total": 0,
        "lifecycle": {},
    }
    if not rows:
        return empty

    first_payload = rows[0].get("payload") or {}
    totals = {
        "reduced_count_total": _as_int(first_payload.get("reducedCount")),
        "reducer_failures_total": _as_int(first_payload.get("reducerFailures")),
        "tokens_saved_estimate_total": _as_int(first_payload.get("tokensSavedEstimateTotal")),
        "fallback_to_artifact_total": _as_int(first_payload.get("fallbackToArtifactCount")),
        "guided_truncation_total": _as_int(first_payload.get("guidedTruncationCount")),
        "task_pruned_total": _as_int(first_payload.get("taskPrunedCount")),
        "task_pruned_lines_kept_total": _as_int(first_payload.get("taskPrunedLinesKept")),
        "task_pruned_lines_dropped_total": _as_int(first_payload.get("taskPrunedLinesDropped")),
        "raw_chars_total": _as_int(first_payload.get("rawCharsTotal")),
        "reduced_chars_total": _as_int(first_payload.get("reducedCharsTotal")),
        "net_chars_saved_total": _as_int(first_payload.get("netCharsSavedTotal")),
        "lifecycle": defaultdict(lambda: {"success_total": 0, "fail_total": 0}),
    }

    first_lifecycle = first_payload.get("lifecycle") if isinstance(first_payload.get("lifecycle"), dict) else {}
    for fam, state in first_lifecycle.items():
        item = state if isinstance(state, dict) else {}
        totals["lifecycle"][fam]["success_total"] = _as_int(item.get("successes"))
        totals["lifecycle"][fam]["fail_total"] = _as_int(item.get("failures"))

    for i in range(1, len(rows)):
        prev = rows[i - 1].get("payload") or {}
        curr = rows[i].get("payload") or {}
        totals["reduced_count_total"] += _monotonic_delta(
            _as_int(prev.get("reducedCount")), _as_int(curr.get("reducedCount"))
        )
        totals["reducer_failures_total"] += _monotonic_delta(
            _as_int(prev.get("reducerFailures")),
            _as_int(curr.get("reducerFailures")),
        )
        totals["tokens_saved_estimate_total"] += _monotonic_delta(
            _as_int(prev.get("tokensSavedEstimateTotal")),
            _as_int(curr.get("tokensSavedEstimateTotal")),
        )
        totals["fallback_to_artifact_total"] += _monotonic_delta(
            _as_int(prev.get("fallbackToArtifactCount")),
            _as_int(curr.get("fallbackToArtifactCount")),
        )
        totals["guided_truncation_total"] += _monotonic_delta(
            _as_int(prev.get("guidedTruncationCount")),
            _as_int(curr.get("guidedTruncationCount")),
        )
        totals["task_pruned_total"] += _monotonic_delta(
            _as_int(prev.get("taskPrunedCount")),
            _as_int(curr.get("taskPrunedCount")),
        )
        totals["task_pruned_lines_kept_total"] += _monotonic_delta(
            _as_int(prev.get("taskPrunedLinesKept")),
            _as_int(curr.get("taskPrunedLinesKept")),
        )
        totals["task_pruned_lines_dropped_total"] += _monotonic_delta(
            _as_int(prev.get("taskPrunedLinesDropped")),
            _as_int(curr.get("taskPrunedLinesDropped")),
        )
        totals["raw_chars_total"] += _monotonic_delta(
            _as_int(prev.get("rawCharsTotal")), _as_int(curr.get("rawCharsTotal"))
        )
        totals["reduced_chars_total"] += _monotonic_delta(
            _as_int(prev.get("reducedCharsTotal")), _as_int(curr.get("reducedCharsTotal"))
        )
        totals["net_chars_saved_total"] += _monotonic_delta(
            _as_int(prev.get("netCharsSavedTotal")), _as_int(curr.get("netCharsSavedTotal"))
        )

        prev_l = prev.get("lifecycle") if isinstance(prev.get("lifecycle"), dict) else {}
        curr_l = curr.get("lifecycle") if isinstance(curr.get("lifecycle"), dict) else {}
        for fam in set(prev_l) | set(curr_l):
            ps = _as_int((prev_l.get(fam) or {}).get("successes"))
            pf = _as_int((prev_l.get(fam) or {}).get("failures"))
            cs = _as_int((curr_l.get(fam) or {}).get("successes"))
            cf = _as_int((curr_l.get(fam) or {}).get("failures"))
            totals["lifecycle"][fam]["success_total"] += _monotonic_delta(ps, cs)
            totals["lifecycle"][fam]["fail_total"] += _monotonic_delta(pf, cf)

    lifecycle_out = {k: dict(v) for k, v in sorted(totals["lifecycle"].items())}
    return {
        "reduced_count_total": totals["reduced_count_total"],
        "reducer_failures_total": totals["reducer_failures_total"],
        "tokens_saved_estimate_total": totals["tokens_saved_estimate_total"],
        "fallback_to_artifact_total": totals["fallback_to_artifact_total"],
        "guided_truncation_total": totals["guided_truncation_total"],
        "task_pruned_total": totals["task_pruned_total"],
        "task_pruned_lines_kept_total": totals["task_pruned_lines_kept_total"],
        "task_pruned_lines_dropped_total": totals["task_pruned_lines_dropped_total"],
        "raw_chars_total": totals["raw_chars_total"],
        "reduced_chars_total": totals["reduced_chars_total"],
        "net_chars_saved_total": totals["net_chars_saved_total"],
        "lifecycle": lifecycle_out,
    }


def reducer_snapshot_freshness(
    rows: list[dict[str, Any]],
    now: datetime | None = None,
    stale_after_minutes: int = 20,
) -> dict[str, Any]:
    """Return latest snapshot timestamp and stale indicator."""
    if not rows:
        return {"latest_snapshot_at": None, "stale": True}
    latest_raw = rows[-1].get("captured_at")
    latest = _parse_captured_at(latest_raw)
    if latest is None:
        return {"latest_snapshot_at": latest_raw if isinstance(latest_raw, str) else None, "stale": True}
    ref = now if now is not None else datetime.now(UTC)
    stale = (ref - latest) > timedelta(minutes=max(1, stale_after_minutes))
    return {"latest_snapshot_at": latest.isoformat(), "stale": stale}
