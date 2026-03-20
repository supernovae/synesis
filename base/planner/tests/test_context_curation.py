"""Tests for rank-first writer evidence budgeting."""

from __future__ import annotations

from unittest.mock import patch

from app.context_curation import curate_evidence_for_writer


def _pkt(conf: float, summary: str, section_id: int | None = 0) -> dict:
    return {
        "summary": summary,
        "confidence": conf,
        "section_id": section_id,
        "snippets": [],
        "sources": [],
    }


def test_keeps_higher_confidence_first_when_budget_tight():
    with patch("app.context_curation.settings") as s:
        s.curator_rag_max_tokens = 45
        s.curator_min_rerank_score = 0.0
        s.curator_budget_alert_threshold = 0.85
        s.scaled_evidence_budget = lambda _d: 50000
        s.compiler_model_context = 8192
        s.writer_budget_max = 4096
        s.long_context_reorder_enabled = False
        big_a = "AAA " * 200
        big_b = "BBB " * 200
        packets = [
            _pkt(0.9, big_a),
            _pkt(0.5, big_b),
        ]
        compiled, report = curate_evidence_for_writer(
            packets, difficulty=0.5, writer_model_name="", long_context_reorder=False
        )
        assert "AAA" in compiled
        assert report["packets_kept"] >= 1
        if "BBB" in compiled:
            assert compiled.find("AAA") < compiled.find("BBB")
        assert report["excluded_count"] >= 1 or report["packets_truncated"] >= 1


def test_drops_below_min_score():
    with patch("app.context_curation.settings") as s:
        s.curator_rag_max_tokens = 8000
        s.curator_min_rerank_score = 0.7
        s.curator_budget_alert_threshold = 0.85
        s.scaled_evidence_budget = lambda _d: 50000
        s.compiler_model_context = 8192
        s.writer_budget_max = 4096
        s.long_context_reorder_enabled = False
        packets = [_pkt(0.2, "low confidence only"), _pkt(0.95, "high confidence body")]
        _compiled, report = curate_evidence_for_writer(
            packets, difficulty=0.5, writer_model_name="", long_context_reorder=False
        )
        below = [e for e in report["excluded"] if e.get("reason") == "below_threshold"]
        assert len(below) >= 1


def test_empty_packets():
    with patch("app.context_curation.settings") as s:
        s.curator_rag_max_tokens = 1000
        s.curator_min_rerank_score = 0.0
        s.curator_budget_alert_threshold = 0.85
        s.scaled_evidence_budget = lambda _d: 10000
        s.compiler_model_context = 8192
        s.writer_budget_max = 4096
        s.long_context_reorder_enabled = False
        compiled, report = curate_evidence_for_writer(
            [], difficulty=0.5, writer_model_name="", long_context_reorder=False
        )
        assert compiled == ""
        assert report["packets_kept"] == 0
