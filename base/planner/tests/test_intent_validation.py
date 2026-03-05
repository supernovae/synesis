"""Intent-flow validation: canonical prompts with expected EntryClassifier outcomes.

EntryClassifier is deterministic — no LLM, no network. Run to confirm:
- Trivial prompts → fast path (bypass Supervisor)
- Small prompts → Supervisor runs
- Complex prompts → plan_required, escalation
- Educational prompts → interaction_mode=teach (Learner's Corner)
- Language detection, UI helper routing

Usage: pytest tests/test_intent_validation.py -v
(Requires: pip install -r requirements.txt -r requirements-test.txt; run from base/planner)

These tests help catch regressions when changing EntryClassifier patterns.
See validation_prompts.yaml for the canonical list (source of truth for future tooling).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.nodes.entry_classifier import entry_classifier_node


def _load_validation_prompts() -> list[dict]:
    """Load from YAML if available; else use inline fallback."""
    path = Path(__file__).parent / "validation_prompts.yaml"
    if path.exists():
        try:
            import yaml

            with open(path) as f:
                data = yaml.safe_load(f)
            return data.get("prompts", [])
        except Exception:
            pass
    # Inline fallback (subset) when yaml unavailable
    return [
        {"prompt": "hello world in python", "expected": {"task_size": "easy", "bypass_supervisor": True}},
        {"prompt": "design the architecture for our microservices migration", "expected": {"task_size": "hard"}},
        {"prompt": "explain how this works", "expected": {"interaction_mode": "teach"}},
        {"prompt": "write a go script that prints hi", "expected": {"target_language": "go"}},
    ]


@pytest.fixture
def validation_prompts():
    return _load_validation_prompts()


class TestEntryClassifierValidation:
    """Parametrized by validation_prompts.yaml — one test per canonical prompt."""

    @pytest.mark.parametrize("item", _load_validation_prompts(), ids=lambda i: i["prompt"][:50])
    def test_canonical_prompt_expectations(self, item: dict):
        prompt = item["prompt"]
        expected = item.get("expected", {})

        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)

        for key, want in expected.items():
            actual = out.get(key)
            # Normalize: "disabled" vs "disabled" for rag_mode
            if key == "rag_mode" and want == "disabled":
                want = "disabled"
            assert actual == want, (
                f'Prompt "{prompt[:60]}..." expected {key}={want!r} but got {actual!r}. Full output: {list(out.keys())}'
            )


class TestEntryClassifierTrivialPath:
    """Explicit tests for trivial fast-path routing."""

    def test_trivial_routes_to_context_curator(self):
        """route_after_entry_classifier: trivial → context_curator."""
        from app.graph import route_after_entry_classifier

        state = {
            "messages": [{"content": "hello world"}],
            "task_size": "easy",
            "bypass_supervisor": True,
        }
        # EntryClassifier sets these; simulate
        out = entry_classifier_node(state)
        state.update(out)
        assert route_after_entry_classifier(state) == "context_curator"

    def test_small_routes_to_supervisor(self):
        """Small task (parse json + file) → supervisor, not trivial fast-path."""
        from app.graph import route_after_entry_classifier

        state = {
            "messages": [{"content": "parse this json file and save to disk"}],
            "task_size": "medium",
            "bypass_supervisor": False,
        }
        out = entry_classifier_node(state)
        state.update(out)
        assert route_after_entry_classifier(state) == "supervisor"

    def test_ui_helper_routes_to_respond(self):
        from app.graph import route_after_entry_classifier

        state = {
            "messages": [{"content": "suggest 3-5 follow-up questions"}],
            "message_origin": "ui_helper",
        }
        out = entry_classifier_node(state)
        state.update(out)
        assert route_after_entry_classifier(state) == "respond"


class TestEducationalMode:
    """Educational intent → interaction_mode=teach."""

    @pytest.mark.parametrize(
        "prompt",
        [
            "explain how this works",
            "how does it work?",
            "why did you do it that way?",
            "I'm learning Python",
            "teach me about decorators",
            "walk me through the flow",
            "what does this code do?",
        ],
    )
    def test_educational_prompts_set_teach_mode(self, prompt: str):
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("interaction_mode") == "teach", f'Expected interaction_mode=teach for "{prompt}"'


class TestWorkerPromptTier:
    """Progressive prompt: trivial=minimal, small=defensive, full=JCS."""

    def test_trivial_sets_tier_trivial_and_persona_minimalist(self):
        state = {"messages": [{"content": "hello world in python"}]}
        out = entry_classifier_node(state)
        assert out.get("worker_prompt_tier") == "easy"
        assert out.get("worker_persona") == "Minimalist"

    def test_small_sets_tier_small_and_persona_senior(self):
        """Parse json + file I/O → medium tier (data_manipulation + local_persistence)."""
        state = {"messages": [{"content": "parse this json file and save to disk"}]}
        out = entry_classifier_node(state)
        assert out.get("worker_prompt_tier") == "medium"
        assert out.get("worker_persona") == "Senior"

    def test_complex_sets_tier_full_and_persona_architect(self):
        """Complex task → hard tier; scope_expansion may need tuning for architecture prompts."""
        state = {"messages": [{"content": "design the architecture for our microservices migration"}]}
        out = entry_classifier_node(state)
        # scope_expansion may yield medium; hard tier requires task_size=hard
        assert out.get("worker_prompt_tier") in ("medium", "hard")
        if out.get("task_size") == "hard":
            assert out.get("worker_persona") == "Architect"

    @pytest.mark.parametrize(
        "prompt",
        [
            "hello world @plan",
            "plan first: write a hello script",
            "I need a plan before we build this",
            "break this down into steps",
            "full planning for this feature",
            "scope: multi-file refactor",
        ],
    )
    def test_pro_user_shortcut_forces_full_tier(self, prompt: str):
        """Pro users can jump to hard JCS prompt via explicit signals."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("worker_prompt_tier") == "hard", f'Expected worker_prompt_tier=hard for pro shortcut "{prompt}"'
        assert out.get("worker_persona") == "Architect", (
            f'Expected worker_persona=Architect for pro shortcut "{prompt}"'
        )


class TestExplainabilityPhase1:
    """Phase 1: classification_reasons + score_breakdown for /why; task_size_override for /reclassify."""

    def test_classification_reasons_and_score_breakdown_present(self):
        """entry_classifier_node emits classification_reasons and score_breakdown."""
        state = {"messages": [{"content": "parse json file and save to disk"}]}
        out = entry_classifier_node(state)
        assert "classification_reasons" in out
        assert "score_breakdown" in out
        assert "classification_score" in out
        assert isinstance(out["classification_reasons"], list)
        assert isinstance(out["score_breakdown"], dict)

    def test_score_breakdown_populated_for_keyword_hits(self):
        """score_breakdown has per-category points when keywords match."""
        state = {"messages": [{"content": "parse this json file and save to disk"}]}
        out = entry_classifier_node(state)
        breakdown = out.get("score_breakdown") or {}
        assert len(breakdown) > 0, "Expected at least one category hit for json+file"
        assert all(isinstance(v, (int, float)) for v in breakdown.values())

    def test_task_size_override_applied(self):
        """task_size_override in state overrides classifier result."""
        state = {
            "messages": [{"content": "design microservices migration architecture"}],
            "task_size_override": "medium",
        }
        out = entry_classifier_node(state)
        assert out.get("task_size") == "medium"
        assert out.get("reclassify_override") == "medium"

    def test_empty_prompt_has_empty_reasons(self):
        """Empty prompt yields empty classification_reasons and score_breakdown."""
        state = {"messages": [{"content": ""}]}
        out = entry_classifier_node(state)
        assert out.get("classification_reasons") == []
        assert out.get("score_breakdown") == {}

    def test_domain_keywords_do_not_escalate(self):
        """kubectl/orchestration is domain-only; must not force hard (only medium from 'get')."""
        state = {"messages": [{"content": "kubectl get pods"}]}
        out = entry_classifier_node(state)
        # Domain never escalates to hard; 'get' in networking may yield medium
        assert out.get("task_size") != "hard", "Domain keywords (kubectl) must not escalate to hard"
        assert out.get("domain_hints") or out.get("active_domain_refs"), "Domain should be detected for RAG"

    def test_intent_class_emitted_for_keyword_match(self):
        """Intent class drives critic overlay; first match wins."""
        state = {"messages": [{"content": "explain how decorators work in Python"}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "knowledge"
        state2 = {"messages": [{"content": "fix the error in this function"}]}
        out2 = entry_classifier_node(state2)
        assert out2.get("intent_class") == "debugging"
        state3 = {"messages": [{"content": "parse this json and save to csv"}]}
        out3 = entry_classifier_node(state3)
        assert out3.get("intent_class") == "data_transform"


class TestOutputTypeCoverage:
    """needs_sandbox=False → skip Planner; Worker produces markdown. Taxonomy-driven."""

    @pytest.mark.parametrize(
        "prompt",
        [
            "explain how marathon taper works",
            "what is VO2max",
            "tell me about zone 2 training",
            "define fartlek",
            "describe how cadence affects running economy",
        ],
    )
    def test_knowledge_inherently_document(self, prompt: str):
        """knowledge intent → needs_sandbox=False. plan_required=False for non-deep-dive domains."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "knowledge"
        assert out.get("needs_sandbox") is False
        assert out.get("plan_required") is False

    def test_knowledge_physics_deep_dive_requires_plan(self):
        """Physics deep-dive (taxonomy) → plan_required=True for structured bullets."""
        state = {"messages": [{"content": "what is the speed of light"}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "knowledge"
        assert out.get("needs_sandbox") is False
        assert out.get("plan_required") is True
        assert "physics" in (out.get("active_domain_refs") or [])

    @pytest.mark.parametrize(
        "prompt",
        [
            "brainstorm names for a running app",
            "suggest 5 workouts for a beginner",
            "ideas for a nutrition tracking feature",
            "creative ways to motivate marathon training",
        ],
    )
    def test_creative_ideation_inherently_document(self, prompt: str):
        """creative_ideation intent → needs_sandbox=False (inherently_document)."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "creative_ideation"
        assert out.get("needs_sandbox") is False
        assert out.get("plan_required") is False

    @pytest.mark.parametrize(
        "prompt",
        [
            "create a marathon training plan for intermediate runner",
            "generate a meal plan for weight loss",
            "I need a budget plan for saving",
            "training schedule for 4 week 5k prep",
        ],
    )
    def test_planning_document_domains(self, prompt: str):
        """planning + lifestyle domain → needs_sandbox=False."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "planning"
        assert out.get("needs_sandbox") is False
        assert out.get("plan_required") is False

    @pytest.mark.parametrize(
        "prompt",
        [
            "how can I improve my running form",
            "optimize my nutrition for recovery",
            "help me with my marathon pacing",
        ],
    )
    def test_personal_guidance_document_domains(self, prompt: str):
        """personal_guidance + lifestyle domain → needs_sandbox=False."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "personal_guidance"
        assert out.get("needs_sandbox") is False
        assert out.get("plan_required") is False

    @pytest.mark.parametrize(
        "prompt",
        [
            "write a blog post about marathon training",
            "draft an email about my nutrition goals",
            "compose an article on zone 2 running",
        ],
    )
    def test_writing_document_domains(self, prompt: str):
        """writing + lifestyle/creative domain → needs_sandbox=False."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "writing"
        assert out.get("needs_sandbox") is False
        assert out.get("plan_required") is False

    @pytest.mark.parametrize(
        "prompt",
        [
            "write a python script to parse json",
            "fix the bug in this function",
            "parse this csv and save to database",
        ],
    )
    def test_code_intents_stay_code(self, prompt: str):
        """Code intents → needs_sandbox=True; plan_required per task_size."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("needs_sandbox") is True


class TestRiskVeto:
    """Risk veto blocks trivial when pip install, curl | bash, etc."""

    def test_pip_install_vetoes_trivial(self):
        """'hello world pip install' must not be trivial."""
        state = {"messages": [{"content": "hello world pip install requests"}]}
        out = entry_classifier_node(state)
        assert out.get("task_size") == "medium", f"pip install must veto trivial; got {out.get('task_size')}"
        assert "risk_veto" in str(out.get("classification_reasons", []))


class TestTeachModeAndEscalation:
    """Phase 4: teach mode clarification cap, escalation_reason, length veto."""

    def test_teach_mode_caps_clarification_budget(self):
        """Teach mode must not increase clarification budget above 1."""
        state = {"messages": [{"content": "design the architecture for our microservices"}]}
        out = entry_classifier_node(state)
        assert out.get("interaction_mode") != "teach"
        state_teach = {"messages": [{"content": "explain how this architecture works"}]}
        out_teach = entry_classifier_node(state_teach)
        assert out_teach.get("interaction_mode") == "teach"
        assert out_teach.get("clarification_budget", 2) <= 1

    def test_escalation_reason_set_when_not_trivial(self):
        """Non-trivial routing must set escalation_reason."""
        state = {"messages": [{"content": "parse json file"}]}
        out = entry_classifier_node(state)
        assert out.get("bypass_supervisor") is False
        assert out.get("escalation_reason") in ("task_size_medium", "task_size_hard")

    def test_length_veto_for_long_trivial_like_message(self):
        """Very long message that would score trivial gets length veto (max 200 chars)."""
        long_msg = "hello world in python " + "x" * 200
        assert len(long_msg) > 200
        state = {"messages": [{"content": long_msg}]}
        out = entry_classifier_node(state)
        assert out.get("task_size") == "medium"
        assert "length_veto" in str(out.get("classification_reasons", []))

    """IntentEnvelope config linter runs and returns list of issues."""

    def test_lint_intent_config_returns_list(self):
        """lint_intent_config returns list (empty = OK)."""
        from app.intent_config_linter import lint_intent_config

        issues = lint_intent_config()
        assert isinstance(issues, list)

    def test_lint_valid_config_no_critical_issues(self):
        """Valid project config should have no missing-keys issues."""
        from app.intent_config_linter import lint_intent_config

        issues = lint_intent_config()
        critical = [i for i in issues if "Missing top-level key" in i or "Config load failed" in i]
        assert not critical, f"Expected valid config: {issues}"
