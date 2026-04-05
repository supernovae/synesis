from __future__ import annotations

from pathlib import Path

from synesis_power_cli.canary_pack import ab_scaffold_payload, checklist_payload, parse_prompt_ids


def test_parse_prompt_ids_extracts_fast_and_full_ids() -> None:
    pack = Path(__file__).resolve().parents[3] / "docs" / "clients" / "CANARY_PROMPT_PACK.md"
    prompts = parse_prompt_ids(pack)
    ids = {p["id"] for p in prompts}
    assert {"F1", "F2", "F3", "P1", "P2", "P10", "FB1", "FB2", "FB3"}.issubset(ids)


def test_checklist_and_ab_payload_shape() -> None:
    pack = Path(__file__).resolve().parents[3] / "docs" / "clients" / "CANARY_PROMPT_PACK.md"
    checklist = checklist_payload(pack)
    assert checklist["prompt_count"] >= 10
    assert "completion_gate_blocked_rate" in checklist["required_fields_per_run"]

    scaffold = ab_scaffold_payload(pack, run_a_name="A", run_b_name="B", model_id="x")
    assert len(scaffold["runs"]) == 2
    assert scaffold["runs"][0]["configuration"] == "synesis-stack"
    assert "first_pass_verify_rate_delta" in scaffold["compare"]["derived"]
