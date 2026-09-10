from __future__ import annotations

from app.services.rag_eval_harness import RagEvalCase, RagEvalSuite, _aggregate, _score_case


def test_enrichment_metadata_does_not_improve_retrieval_score() -> None:
    case = RagEvalCase(id="source", query="find parseConfig", expect={"symbols": ["parseConfig"]})
    source = {"source_chunks": [{"text": "parseConfig"}]}
    enriched = {
        **source,
        "context_cards": [{"text": "generated summary"}],
        "quality": {"quality_score": 1.0, "trust_score": 1.0, "freshness_score": 1.0},
    }
    # Check both a successful retrieval and one missing the requested symbol;
    # score saturation must not hide an enrichment bonus on failed retrieval.
    for selected in [case, RagEvalCase(id="missing", query="missing", expect={"symbols": ["absentSymbol"]})]:
        plain = _score_case(selected, source, 1.0)
        with_cards = _score_case(selected, enriched, 1.0)
        assert plain["score"] == with_cards["score"]
        assert plain["passed"] == with_cards["passed"]
        assert plain["warnings"] == with_cards["warnings"]
        assert not plain["checks"]["context_cards_present"]
        assert with_cards["checks"]["context_cards_present"]


def test_missing_expectations_do_not_award_free_points() -> None:
    missing = RagEvalCase(id="missing", query="parseConfig", expect={"symbols": ["parseConfig"]})
    result = _score_case(missing, {}, 1.0)
    assert result["score"] == 0.0
    assert not result["passed"]

    unspecified = _score_case(RagEvalCase(id="unspecified", query="anything"), {}, 1.0)
    assert unspecified["score"] == 0.0
    assert not unspecified["passed"]
    assert "no retrieval expectations configured" in unspecified["failures"]


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
