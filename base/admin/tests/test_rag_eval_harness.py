from __future__ import annotations

from app.services.rag_eval_harness import RagEvalSuite, _aggregate


def test_aggregate_reports_synpack_value_add_lift() -> None:
    suite = RagEvalSuite(name="packs", description="", path="packs.yaml", cases=[])
    cases = [
        {
            "passed": True,
            "score": 0.9,
            "source_only_score": 0.6,
            "value_add_lift": 0.3,
            "latency_ms": 12.0,
            "checks": {"context_cards_present": True},
            "counts": {"source_chunks": 3},
            "failures": [],
        },
        {
            "passed": True,
            "score": 0.8,
            "source_only_score": 0.7,
            "value_add_lift": 0.1,
            "latency_ms": 18.0,
            "checks": {"context_cards_present": True},
            "counts": {"source_chunks": 2},
            "failures": [],
        },
    ]

    metrics = _aggregate(suite, cases, 40.0)

    assert metrics["avg_score"] == 0.85
    assert metrics["source_only_avg_score"] == 0.65
    assert metrics["value_add_lift"] == 0.2
    assert metrics["positive_lift_rate"] == 1.0
    assert metrics["paired_ablation_count"] == 2


def test_aggregate_excludes_failed_ablation_pair() -> None:
    suite = RagEvalSuite(name="packs", description="", path="packs.yaml", cases=[])
    cases = [
        {
            "passed": False,
            "score": 0.4,
            "source_only_score": None,
            "value_add_lift": None,
            "latency_ms": 5.0,
            "checks": {},
            "counts": {},
            "failures": ["control unavailable"],
        }
    ]

    metrics = _aggregate(suite, cases, 5.0)

    assert metrics["paired_ablation_count"] == 0
    assert metrics["source_only_avg_score"] == 0.0
    assert metrics["value_add_lift"] == 0.0
    assert metrics["positive_lift_rate"] == 0.0
