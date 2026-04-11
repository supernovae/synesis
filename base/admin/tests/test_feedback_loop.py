from __future__ import annotations

from types import SimpleNamespace


def _row(**kwargs):
    defaults = {
        "detail": {},
        "candidate_verdict": "pass",
        "candidate_tokens": 100,
        "baseline_tokens": 150,
        "candidate_latency_ms": 100.0,
        "baseline_latency_ms": 120.0,
        "prompt_index": 1,
        "prompt_text": "Fix this issue",
        "prompt_category": "go",
        "candidate_response": "Applied focused fix",
        "baseline_response": "Try many things",
        "baseline_verdict": "fail",
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def _run(**kwargs):
    defaults = {"candidate_model": "synesis-agent"}
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def test_critic_scores_reward_prefers_success():
    from app.routers.feedback_loop import _critic_scores_for_result

    pass_row = _row(candidate_verdict="pass")
    fail_row = _row(candidate_verdict="fail")
    pass_score = _critic_scores_for_result(pass_row)["reward_score"]
    fail_score = _critic_scores_for_result(fail_row)["reward_score"]
    assert pass_score > fail_score


def test_dpo_pairs_emits_chosen_rejected():
    from app.routers.feedback_loop import _dpo_pairs

    run = _run()
    pairs = _dpo_pairs(run, "run-1", [_row()])
    assert len(pairs) == 1
    pair = pairs[0]
    assert pair["chosen"]
    assert pair["rejected"]
    assert pair["prompt"] == "Fix this issue"


def test_rlaif_record_contains_reward_score():
    from app.routers.feedback_loop import _rlaif_record

    run = _run()
    record = _rlaif_record(run, "run-1", _row())
    assert "reward_score" in record
    assert "rubric" in record
    assert record["meta"]["model_id"] == "synesis-agent"
