"""Tests for effort-mode auto routing matrix."""

from __future__ import annotations

from app.effort_router import recommend_effort_mode


def _mk_state(**overrides):
    base = {
        "task_description": "default request",
        "operational_health_score": 1.0,
    }
    base.update(overrides)
    return base


def _mk_classified(**overrides):
    base = {
        "difficulty": 0.5,
        "risk_score": 10,
        "rag_mode": "light",
        "taxonomy_metadata": {"taxonomy_key": "general"},
        "active_domain_refs": ["general"],
        "domain_ref_counts": {"general": 1},
        "task_description": "default request",
    }
    base.update(overrides)
    return base


def test_simple_low_risk_prompt_prefers_pulse():
    rec = recommend_effort_mode(
        _mk_state(task_description="write a short summary of this text"),
        _mk_classified(difficulty=0.15, risk_score=5, rag_mode="disabled"),
        None,
    )
    assert rec.recommended_mode == "pulse"


def test_moderate_general_prompt_prefers_core():
    rec = recommend_effort_mode(
        _mk_state(task_description="compare two API designs and list tradeoffs"),
        _mk_classified(difficulty=0.45, risk_score=20, rag_mode="light"),
        None,
    )
    assert rec.recommended_mode == "core"


def test_complex_ambiguous_architecture_prompt_prefers_horizon():
    rec = recommend_effort_mode(
        _mk_state(task_description="maybe design a production architecture for multi-tenant regulated workloads"),
        _mk_classified(
            difficulty=0.85,
            risk_score=78,
            rag_mode="normal",
            active_domain_refs=["cloud", "security", "governance"],
            domain_ref_counts={"cloud": 3, "security": 2, "governance": 2},
        ),
        {"semantic_frame": {"deliverable": "architecture"}},
    )
    assert rec.recommended_mode == "horizon"


def test_high_risk_not_complex_leans_core_or_horizon():
    rec = recommend_effort_mode(
        _mk_state(task_description="production rollback plan for payment migration"),
        _mk_classified(difficulty=0.28, risk_score=70, rag_mode="light"),
        None,
    )
    assert rec.recommended_mode in {"core", "horizon"}


def test_degraded_health_still_returns_stable_mode_with_reason():
    rec = recommend_effort_mode(
        _mk_state(task_description="design rollout plan", operational_health_score=0.35),
        _mk_classified(difficulty=0.55, risk_score=35, rag_mode="normal"),
        None,
    )
    assert rec.recommended_mode in {"core", "horizon"}
    assert "degraded_operational_health" in rec.reasons or "low_confidence_fallback_to_core" in rec.reasons

