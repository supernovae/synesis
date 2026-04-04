"""Roll up Yarn reducer telemetry snapshots into interval deltas (handles process restarts)."""

from __future__ import annotations

from collections import defaultdict
from typing import Any


def _monotonic_delta(prev: int, curr: int) -> int:
    """Positive increment; if counters dropped (restart), treat curr as new baseline."""
    if curr >= prev:
        return curr - prev
    return curr


def rollup_reducer_snapshots(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Sum deltas between consecutive snapshots (rows sorted ascending by captured_at).

    Each row: ``{"captured_at": iso, "payload": { ... toolResultReduction ... }}``.
    """
    empty = {
        "reduced_count_delta": 0,
        "reducer_failures_delta": 0,
        "tokens_saved_estimate_delta": 0,
        "fallback_to_artifact_delta": 0,
        "lifecycle": {},
    }
    if len(rows) < 2:
        return empty

    totals = {
        "reduced_count_delta": 0,
        "reducer_failures_delta": 0,
        "tokens_saved_estimate_delta": 0,
        "fallback_to_artifact_delta": 0,
        "lifecycle": defaultdict(lambda: {"success_delta": 0, "fail_delta": 0}),
    }

    for i in range(1, len(rows)):
        prev = rows[i - 1].get("payload") or {}
        curr = rows[i].get("payload") or {}
        totals["reduced_count_delta"] += _monotonic_delta(
            int(prev.get("reducedCount", 0) or 0),
            int(curr.get("reducedCount", 0) or 0),
        )
        totals["reducer_failures_delta"] += _monotonic_delta(
            int(prev.get("reducerFailures", 0) or 0),
            int(curr.get("reducerFailures", 0) or 0),
        )
        totals["tokens_saved_estimate_delta"] += _monotonic_delta(
            int(prev.get("tokensSavedEstimateTotal", 0) or 0),
            int(curr.get("tokensSavedEstimateTotal", 0) or 0),
        )
        totals["fallback_to_artifact_delta"] += _monotonic_delta(
            int(prev.get("fallbackToArtifactCount", 0) or 0),
            int(curr.get("fallbackToArtifactCount", 0) or 0),
        )

        prev_l = prev.get("lifecycle") if isinstance(prev.get("lifecycle"), dict) else {}
        curr_l = curr.get("lifecycle") if isinstance(curr.get("lifecycle"), dict) else {}
        for fam in set(prev_l) | set(curr_l):
            ps = int((prev_l.get(fam) or {}).get("successes", 0) or 0)
            pf = int((prev_l.get(fam) or {}).get("failures", 0) or 0)
            cs = int((curr_l.get(fam) or {}).get("successes", 0) or 0)
            cf = int((curr_l.get(fam) or {}).get("failures", 0) or 0)
            totals["lifecycle"][fam]["success_delta"] += _monotonic_delta(ps, cs)
            totals["lifecycle"][fam]["fail_delta"] += _monotonic_delta(pf, cf)

    lifecycle_out = {k: dict(v) for k, v in sorted(totals["lifecycle"].items())}
    return {
        "reduced_count_delta": totals["reduced_count_delta"],
        "reducer_failures_delta": totals["reducer_failures_delta"],
        "tokens_saved_estimate_delta": totals["tokens_saved_estimate_delta"],
        "fallback_to_artifact_delta": totals["fallback_to_artifact_delta"],
        "lifecycle": lifecycle_out,
    }
