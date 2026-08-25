"""Validation and comparison policy for retrieval benchmark snapshots.

This module deliberately has no benchmark-runtime dependencies so the quality
gate can be unit tested without a live Milvus or embedding service.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

QUALITY_KEYS = ("recall@5", "recall@10", "mrr@10", "ndcg@10")


class BenchmarkContractError(ValueError):
    """Raised when a benchmark snapshot cannot support a real comparison."""


def _quality_metrics(snapshot: Mapping[str, Any], label: str) -> dict[str, float]:
    aggregate = snapshot.get("aggregate")
    if not isinstance(aggregate, Mapping):
        raise BenchmarkContractError(f"{label} has no aggregate metrics object")

    metrics: dict[str, float] = {}
    for key in QUALITY_KEYS:
        raw = aggregate.get(key)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise BenchmarkContractError(f"{label} metric {key} is missing or non-numeric")
        value = float(raw)
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise BenchmarkContractError(f"{label} metric {key} must be finite and between 0 and 1")
        metrics[key] = value
    return metrics


def validate_snapshot(snapshot: Any, label: str) -> set[str]:
    """Validate that a result has enough evidence to be used as a quality gate.

    A snapshot with no evaluated queries or no positive quality signal is not a
    baseline. Accepting either case would turn the regression lane into a
    false-green check.
    """

    if not isinstance(snapshot, Mapping):
        raise BenchmarkContractError(f"{label} must be a JSON object")

    aggregate = snapshot.get("aggregate")
    if not isinstance(aggregate, Mapping):
        raise BenchmarkContractError(f"{label} has no aggregate metrics object")

    query_count = aggregate.get("query_count")
    if isinstance(query_count, bool) or not isinstance(query_count, int) or query_count <= 0:
        raise BenchmarkContractError(f"{label} query_count must be a positive integer")

    per_query = snapshot.get("per_query")
    if not isinstance(per_query, list) or len(per_query) != query_count:
        raise BenchmarkContractError(f"{label} per_query length must equal query_count ({query_count})")

    query_ids: list[str] = []
    for index, result in enumerate(per_query):
        if not isinstance(result, Mapping):
            raise BenchmarkContractError(f"{label} per_query[{index}] must be an object")
        query_id = result.get("query_id")
        if not isinstance(query_id, str) or not query_id.strip():
            raise BenchmarkContractError(f"{label} per_query[{index}] has no query_id")
        query_ids.append(query_id)
    if len(set(query_ids)) != len(query_ids):
        raise BenchmarkContractError(f"{label} contains duplicate query_id values")

    metrics = _quality_metrics(snapshot, label)
    if not any(value > 0.0 for value in metrics.values()):
        raise BenchmarkContractError(f"{label} has zero signal across all gated quality metrics")

    return set(query_ids)


def find_regressions(
    current: Mapping[str, Any],
    baseline: Mapping[str, Any],
    tolerance: float,
) -> list[str]:
    """Return quality regressions after validating comparable query sets."""

    if not 0.0 <= tolerance < 1.0:
        raise BenchmarkContractError("tolerance must be at least 0 and less than 1")

    current_ids = validate_snapshot(current, "current results")
    baseline_ids = validate_snapshot(baseline, "baseline")
    if current_ids != baseline_ids:
        added = sorted(current_ids - baseline_ids)
        removed = sorted(baseline_ids - current_ids)
        detail = []
        if added:
            detail.append(f"added={','.join(added)}")
        if removed:
            detail.append(f"removed={','.join(removed)}")
        raise BenchmarkContractError(
            "current results and baseline use different query sets; "
            + "; ".join(detail)
            + ". Review the query change and promote a new baseline explicitly."
        )

    current_metrics = _quality_metrics(current, "current results")
    baseline_metrics = _quality_metrics(baseline, "baseline")
    regressions: list[str] = []
    for key in QUALITY_KEYS:
        base_value = baseline_metrics[key]
        current_value = current_metrics[key]
        # A non-negative metric cannot regress below a zero floor. The
        # snapshot-level validator already rejects an all-zero baseline, so
        # other gated metrics still carry a real comparison signal.
        if base_value == 0.0:
            continue
        relative_drop = (base_value - current_value) / base_value
        if relative_drop - tolerance > 1e-12:
            regressions.append(f"{key}: {current_value:.4f} < baseline {base_value:.4f} (>{tolerance * 100:.0f}% drop)")
    return regressions
