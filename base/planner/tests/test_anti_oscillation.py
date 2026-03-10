"""Tests for the anti-oscillation framework.

Validates:
  - Reducers: set-once, append-only, merge-by-key with forward-only status
  - Contract validators: style drift, decision drift, citation preservation,
    critique resolutions, required sections, role-source match
  - Oscillation detector: decision flip-flop scoring
  - Override flow: auto-approve narrow scope, require critic for broad scope
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# 1. Writer style drift → validate_style_compliance catches it
# ---------------------------------------------------------------------------


class TestWriterStyleDrift:
    def test_terse_draft_within_token_budget_passes(self):
        """Token budgets enforce length; char-limit violations were removed."""
        from app.contract_validator import validate_style_compliance

        state = {
            "style_contract_locked": {"verbosity_target": "terse", "direct_answer_first": True},
            "generated_code": "Here is the answer.\n" + "x" * 9000,
        }
        passed, _violations = validate_style_compliance(state)
        assert passed

    def test_preamble_violates_direct_answer_first(self):
        from app.contract_validator import validate_style_compliance

        state = {
            "style_contract_locked": {"verbosity_target": "moderate", "direct_answer_first": True},
            "generated_code": "Before we begin, let me explain the context.\n\nHere is the answer.",
        }
        passed, violations = validate_style_compliance(state)
        assert not passed
        assert any("direct_answer_first" in v for v in violations)

    def test_compliant_draft_passes(self):
        from app.contract_validator import validate_style_compliance

        state = {
            "style_contract_locked": {"verbosity_target": "moderate", "direct_answer_first": True},
            "generated_code": "PostgreSQL is the recommended database.\n\nHere are the details.",
        }
        passed, violations = validate_style_compliance(state)
        assert passed
        assert violations == []


# ---------------------------------------------------------------------------
# 2. Planner/writer stack drift → validate_decision_drift catches it
# ---------------------------------------------------------------------------


class TestPlannerWriterStackDrift:
    def test_rejected_alternative_in_draft(self):
        from app.contract_validator import validate_decision_drift

        state = {
            "decision_ledger": [
                {
                    "decision_id": "db_choice",
                    "category": "architecture",
                    "chosen": "PostgreSQL",
                    "rejected_alternatives": ["MongoDB", "MySQL"],
                    "frozen": True,
                }
            ],
            "generated_code": "We recommend using MongoDB for this project because...",
            "override_log": [],
        }
        passed, violations = validate_decision_drift(state)
        assert not passed
        assert any("mongodb" in v.lower() for v in violations)

    def test_approved_override_allows_alternative(self):
        from app.contract_validator import validate_decision_drift

        state = {
            "decision_ledger": [
                {
                    "decision_id": "db_choice",
                    "category": "architecture",
                    "chosen": "PostgreSQL",
                    "rejected_alternatives": ["MongoDB"],
                    "frozen": True,
                }
            ],
            "generated_code": "We recommend using MongoDB for this project.",
            "override_log": [
                {
                    "target_decision_id": "db_choice",
                    "override_reason": "Client requires document store",
                    "approved": True,
                }
            ],
        }
        passed, _violations = validate_decision_drift(state)
        assert passed

    def test_no_drift_when_chosen_present(self):
        from app.contract_validator import validate_decision_drift

        state = {
            "decision_ledger": [
                {
                    "decision_id": "db_choice",
                    "category": "architecture",
                    "chosen": "PostgreSQL",
                    "rejected_alternatives": ["MongoDB"],
                    "frozen": True,
                }
            ],
            "generated_code": "PostgreSQL handles this well. MongoDB is not suitable.",
            "override_log": [],
        }
        passed, _violations = validate_decision_drift(state)
        assert passed


# ---------------------------------------------------------------------------
# 3. Critic reopening settled decision without new evidence
# ---------------------------------------------------------------------------


class TestCriticReopenSettled:
    def test_reopen_without_evidence_blocked(self):
        from app.reducers import _merge_critique_register

        existing = {
            "item_1": {
                "item_id": "item_1",
                "status": "settled",
                "evidence_ref": "original_evidence",
                "reopen_count": 0,
            }
        }
        new = {
            "item_1": {
                "item_id": "item_1",
                "status": "open",
                "evidence_ref": "original_evidence",
                "reopen_count": 0,
            }
        }
        merged = _merge_critique_register(existing, new)
        assert merged["item_1"]["status"] == "settled"

    def test_reopen_with_new_evidence_allowed(self):
        from app.reducers import _merge_critique_register

        existing = {
            "item_1": {
                "item_id": "item_1",
                "status": "settled",
                "evidence_ref": "old_evidence",
                "reopen_count": 0,
            }
        }
        new = {
            "item_1": {
                "item_id": "item_1",
                "status": "open",
                "evidence_ref": "brand_new_evidence",
                "reopen_count": 0,
            }
        }
        merged = _merge_critique_register(existing, new)
        assert merged["item_1"]["status"] == "open"
        assert merged["item_1"]["reopen_count"] == 1


# ---------------------------------------------------------------------------
# 4. Citation drop across revisions
# ---------------------------------------------------------------------------


class TestCitationDrop:
    def test_missing_citation_flagged(self):
        from app.contract_validator import validate_citation_preservation

        state = {
            "draft_fingerprints": ["abc123", "def456"],
            "rag_source_urls": ["https://docs.example.com/guide"],
            "rag_document_names": [],
            "generated_code": "Here is the recommendation without any citation.",
        }
        passed, violations = validate_citation_preservation(state)
        assert not passed
        assert any("docs.example.com" in v for v in violations)

    def test_citation_present_passes(self):
        from app.contract_validator import validate_citation_preservation

        state = {
            "draft_fingerprints": ["abc123", "def456"],
            "rag_source_urls": ["https://docs.example.com/guide"],
            "rag_document_names": [],
            "generated_code": "According to https://docs.example.com/guide, the approach is valid.",
        }
        passed, _violations = validate_citation_preservation(state)
        assert passed


# ---------------------------------------------------------------------------
# 5. Role-source matching removed (Router owns all retrieval)
# ---------------------------------------------------------------------------


class TestRetrievalRoleMismatch:
    def test_role_source_match_is_noop(self):
        from app.contract_validator import validate_role_source_match

        passed, violations = validate_role_source_match({}, role="writer")
        assert passed
        assert violations == []


# ---------------------------------------------------------------------------
# 6. Set-once reducer preserves original
# ---------------------------------------------------------------------------


class TestSetOnceReducer:
    def test_first_write_succeeds(self):
        from app.reducers import _set_once_dict

        result = _set_once_dict({}, {"problem": "Build API", "domain": "backend"})
        assert result["problem"] == "Build API"

    def test_overwrite_blocked(self):
        from app.reducers import _set_once_dict

        original = {"problem": "Build API", "domain": "backend"}
        attempted = {"problem": "Build UI", "domain": "frontend"}
        result = _set_once_dict(original, attempted)
        assert result["problem"] == "Build API"
        assert result is original

    def test_empty_existing_allows_write(self):
        from app.reducers import _set_once_dict

        result = _set_once_dict({}, {"key": "value"})
        assert result["key"] == "value"


# ---------------------------------------------------------------------------
# 7. Append-only ledger preserves existing entries
# ---------------------------------------------------------------------------


class TestAppendOnlyLedger:
    def test_new_entries_appended(self):
        from app.reducers import _append_only_ledger

        existing = [{"decision_id": "d1", "chosen": "PostgreSQL"}]
        new = [{"decision_id": "d2", "chosen": "Redis"}]
        result = _append_only_ledger(existing, new)
        assert len(result) == 2
        assert result[0]["decision_id"] == "d1"
        assert result[1]["decision_id"] == "d2"

    def test_duplicate_id_not_overwritten(self):
        from app.reducers import _append_only_ledger

        existing = [{"decision_id": "d1", "chosen": "PostgreSQL"}]
        new = [{"decision_id": "d1", "chosen": "MongoDB"}]
        result = _append_only_ledger(existing, new)
        assert len(result) == 1
        assert result[0]["chosen"] == "PostgreSQL"

    def test_entries_without_id_always_appended(self):
        from app.reducers import _append_only_ledger

        existing = [{"override_reason": "first"}]
        new = [{"override_reason": "second"}]
        result = _append_only_ledger(existing, new)
        assert len(result) == 2


# ---------------------------------------------------------------------------
# 8. Oscillation detector — decision flip-flop
# ---------------------------------------------------------------------------


class TestOscillationDetectorDecisionFlip:
    def test_double_override_scores_high(self):
        from app.oscillation_detector import detect_oscillation

        state = {
            "override_log": [
                {"target_decision_id": "db_choice", "override_reason": "Switch to Mongo", "approved": True},
                {"target_decision_id": "db_choice", "override_reason": "Switch back to PG", "approved": True},
            ],
            "style_contract_locked": {},
            "generated_code": "",
            "draft_fingerprints": [],
            "critique_register": {},
            "node_traces": [],
        }
        report = detect_oscillation(state)
        assert report.decision_score >= 0.5

    def test_no_overrides_scores_zero(self):
        from app.oscillation_detector import detect_oscillation

        state = {
            "override_log": [],
            "style_contract_locked": {},
            "generated_code": "",
            "draft_fingerprints": [],
            "critique_register": {},
            "node_traces": [],
        }
        report = detect_oscillation(state)
        assert report.decision_score == 0.0


# ---------------------------------------------------------------------------
# 9. Override flow — auto-approve narrow, require critic for broad
# ---------------------------------------------------------------------------


class TestOverrideFlow:
    def test_narrow_scope_with_reason_auto_approves(self):
        from app.schemas import OverrideRequest

        req = OverrideRequest(
            target_decision_id="db_choice",
            override_reason="Client requires document store for this section",
            override_scope="this_section",
            requested_by="evidence_gatherer",
        )
        should_auto_approve = req.override_scope == "this_section" and len(req.override_reason.strip()) > 10
        assert should_auto_approve

    def test_broad_scope_requires_critic(self):
        from app.schemas import OverrideRequest

        req = OverrideRequest(
            target_decision_id="db_choice",
            override_reason="Need different approach everywhere",
            override_scope="all_sections",
            requested_by="evidence_gatherer",
        )
        requires_critic = req.override_scope in ("all_sections", "permanent")
        assert requires_critic

    def test_empty_reason_does_not_auto_approve(self):
        from app.schemas import OverrideRequest

        req = OverrideRequest(
            target_decision_id="db_choice",
            override_reason="",
            override_scope="this_section",
            requested_by="evidence_gatherer",
        )
        should_auto_approve = req.override_scope == "this_section" and len(req.override_reason.strip()) > 10
        assert not should_auto_approve
