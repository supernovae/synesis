"""Intent-flow validation: canonical prompts with expected EntryClassifier outcomes.

EntryClassifier is deterministic — no LLM, no network. Run to confirm:
- Trivial prompts → fast path (difficulty < 0.15, bypass supervisor)
- Mid-range prompts → context_curator bypass (0.15 ≤ difficulty < 0.7)
- Complex prompts → plan_required (difficulty ≥ 0.7), supervisor/planner path
- Language detection, UI helper routing

Routing thresholds (from intent_weights.yaml):
  trivial_below: 0.15
  bypass_supervisor_below: 0.20
  plan_required_above: 0.70

Usage: pytest tests/test_intent_validation.py -v
(Requires: pip install -r requirements.txt -r requirements-test.txt; run from base/planner)
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (container-only)")

from app.nodes.entry_classifier import entry_classifier_node

TRIVIAL_CEILING = 0.15


def _embedder_available() -> bool:
    """Check if the TEI embedder is reachable (required for semantic is_code_task)."""
    try:
        import httpx

        r = httpx.get("http://embedder.synesis-rag.svc.cluster.local:8080/health", timeout=1)
        return r.status_code == 200
    except Exception:
        return False


PLAN_FLOOR = 0.70


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
    return [
        {"prompt": "hello world in python", "expected": {"bypass_supervisor": True, "task_is_trivial": True}},
        {"prompt": "design the architecture for our microservices migration", "expected": {"plan_required": True}},
        {"prompt": "explain how this works", "expected": {"is_code_task": False}},
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
            if key == "rag_mode" and want == "disabled":
                want = "disabled"
            assert actual == want, (
                f'Prompt "{prompt[:60]}..." expected {key}={want!r} but got {actual!r}. '
                f"difficulty={out.get('difficulty', '?')}  Full keys: {list(out.keys())}"
            )


class TestEntryPipelineTrivialPath:
    """Explicit tests for trivial fast-path routing via route_after_entry_pipeline."""

    def test_trivial_routes_to_writer(self):
        """route_after_entry_pipeline: trivial non-code → writer."""
        from app.graph import route_after_entry_pipeline

        state = {"messages": [{"content": "hello world"}]}
        out = entry_classifier_node(state)
        state.update(out)
        assert out["difficulty"] < TRIVIAL_CEILING
        assert route_after_entry_pipeline(state) == "writer"

    def test_ui_helper_routes_to_respond(self):
        from app.graph import route_after_entry_pipeline

        state = {
            "messages": [{"content": "suggest 3-5 follow-up questions"}],
            "message_origin": "ui_helper",
        }
        out = entry_classifier_node(state)
        state.update(out)
        assert route_after_entry_pipeline(state) == "respond"


class TestEducationalPrompts:
    """Educational prompts route as explain-only (is_code_task=False), not special teach mode."""

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
    def test_educational_prompts_are_text_mode(self, prompt: str):
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert "interaction_mode" not in out, f'interaction_mode should not be set for "{prompt}"'


class TestDifficultyScaling:
    """Difficulty is a continuous 0.0-1.0 scale driving routing thresholds."""

    def test_trivial_prompt_below_threshold(self):
        """Trivial prompt → difficulty < 0.15, bypass supervisor."""
        state = {"messages": [{"content": "hello world in python"}]}
        out = entry_classifier_node(state)
        assert out["difficulty"] < TRIVIAL_CEILING
        assert out.get("bypass_supervisor") is True
        assert out.get("task_is_trivial") is True

    def test_mid_range_prompt(self):
        """Parse json + file I/O → mid-range difficulty, bypass supervisor."""
        state = {"messages": [{"content": "parse this json file and save to disk"}]}
        out = entry_classifier_node(state)
        assert TRIVIAL_CEILING <= out["difficulty"] < PLAN_FLOOR
        assert out.get("bypass_supervisor") is True
        assert out.get("plan_required") is False

    def test_complex_prompt_above_plan_threshold(self):
        """Architecture design → difficulty ≥ 0.7, plan_required."""
        state = {"messages": [{"content": "design the architecture for our microservices migration"}]}
        out = entry_classifier_node(state)
        assert out["difficulty"] >= PLAN_FLOOR
        assert out.get("plan_required") is True
        assert out.get("bypass_supervisor") is False

    def test_difficulty_monotonic_with_complexity(self):
        """Increasing complexity → increasing difficulty."""
        prompts_ascending = [
            "hello world",
            "parse this json",
            "write a script that fetches data from an API and saves to csv",
            "design the architecture for our microservices migration",
        ]
        difficulties = []
        for p in prompts_ascending:
            out = entry_classifier_node({"messages": [{"content": p}]})
            difficulties.append(out["difficulty"])
        for i in range(len(difficulties) - 1):
            assert difficulties[i] <= difficulties[i + 1], (
                f"Expected monotonic difficulty but {prompts_ascending[i]!r} "
                f"({difficulties[i]}) > {prompts_ascending[i + 1]!r} ({difficulties[i + 1]})"
            )

    @pytest.mark.parametrize(
        "prompt",
        [
            "hello world @plan",
            "/plan create a simple script that prints hello",
            "scope: multi-file refactor",
            "plan first: write a hello script",
            "break it down into smaller steps",
        ],
    )
    def test_plan_session_forces_planning(self, prompt: str):
        """plan_session triggers → plan_required=True, bypass_supervisor=False."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("plan_session") is True, f'Expected plan_session=True for "{prompt}"'
        assert out.get("plan_required") is True, f'Expected plan_required=True for "{prompt}"'
        assert out.get("bypass_supervisor") is False, f'Expected bypass_supervisor=False for "{prompt}"'


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
        assert out.get("reclassify_override") == "medium"

    def test_empty_prompt_has_empty_reasons(self):
        """Empty prompt yields empty classification_reasons and score_breakdown."""
        state = {"messages": [{"content": ""}]}
        out = entry_classifier_node(state)
        assert out.get("classification_reasons") == []
        assert out.get("score_breakdown") == {}

    def test_domain_keywords_do_not_escalate_to_plan(self):
        """kubectl/orchestration is domain-only; must not force plan_required."""
        state = {"messages": [{"content": "kubectl get pods"}]}
        out = entry_classifier_node(state)
        assert out["difficulty"] < PLAN_FLOOR, "Domain keywords (kubectl) must not push difficulty to plan threshold"
        assert out.get("domain_hints") or out.get("active_domain_refs"), "Domain should be detected for RAG"

    def test_intent_class_emitted_for_keyword_match(self):
        """Intent class drives critic overlay; BM25-scored, highest score wins."""
        state = {"messages": [{"content": "explain how decorators work in Python"}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "knowledge"
        state2 = {"messages": [{"content": "fix the error in this function"}]}
        out2 = entry_classifier_node(state2)
        assert out2.get("intent_class") == "debugging"
        state3 = {"messages": [{"content": "parse this json and save to csv"}]}
        out3 = entry_classifier_node(state3)
        assert out3.get("intent_class") == "data_transform"

    def test_bm25_long_prompt_picks_dominant_intent(self):
        """BM25 scoring: long prompt with many planning/knowledge keywords
        must not be hijacked by a single 'review' keyword match."""
        architecture_prompt = (
            "You are helping me design a production-ready AI assistant for a small "
            "engineering organization.\n"
            "Propose a practical architecture for an internal coding assistant that can:\n"
            "1. answer questions about company docs,\n"
            "2. help write and review code,\n"
            "3. avoid confidently making up facts.\n"
            "What I want from you:\n"
            "- State the main design goals\n"
            "- Propose a concrete architecture\n"
            "- Explain model choices\n"
            "- Explain how retrieval should work\n"
            "- Describe failure modes and mitigations\n"
            "- Give a phased rollout plan for 30, 60, and 90 days"
        )
        state = {"messages": [{"content": architecture_prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") != "review", (
            "BM25 should not let a single 'review' keyword hijack intent "
            f"when planning/knowledge keywords dominate. Got: {out.get('intent_class')}"
        )
        assert out.get("is_code_task") is False, "Architecture proposal is a text/knowledge task, not code"


class TestOutputTypeCoverage:
    """is_code_task=False → Worker produces markdown. Taxonomy-driven."""

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
        """knowledge intent → is_code_task=False."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "knowledge"
        assert out.get("is_code_task") is False

    def test_knowledge_trivial_fast_path(self):
        """Trivial knowledge question → fast path (difficulty < threshold)."""
        state = {"messages": [{"content": "what is the speed of light"}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "knowledge"
        assert out.get("is_code_task") is False
        assert out["difficulty"] < TRIVIAL_CEILING

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
        """creative_ideation intent → is_code_task=False."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "creative_ideation"
        assert out.get("is_code_task") is False

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
        """planning + lifestyle domain → is_code_task=False."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "planning"
        assert out.get("is_code_task") is False

    @pytest.mark.parametrize(
        "prompt",
        [
            "how can I improve my running form",
            "optimize my nutrition for recovery",
            "help me with my marathon pacing",
        ],
    )
    def test_personal_guidance_document_domains(self, prompt: str):
        """personal_guidance + lifestyle domain → is_code_task=False."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "personal_guidance"
        assert out.get("is_code_task") is False

    @pytest.mark.parametrize(
        "prompt",
        [
            "write a blog post about marathon training",
            "draft an email about my nutrition goals",
            "compose an article on zone 2 running",
        ],
    )
    def test_writing_document_domains(self, prompt: str):
        """writing + lifestyle/creative domain → is_code_task=False."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("intent_class") == "writing"
        assert out.get("is_code_task") is False

    @pytest.mark.parametrize(
        "prompt",
        [
            "write a python script to parse json",
            "fix the bug in this function",
            "parse this csv and save to database",
        ],
    )
    @pytest.mark.skipif(
        not _embedder_available(),
        reason="is_code_task relies on TEI embedder for semantic intent",
    )
    def test_code_intents_stay_code(self, prompt: str):
        """Code intents → is_code_task=True (requires running TEI embedder)."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("is_code_task") is True


class TestRiskVeto:
    """Risk veto fires for pip install, curl | bash, etc."""

    def test_pip_install_triggers_risk_veto(self):
        """'hello world pip install' triggers risk_veto classification reason."""
        state = {"messages": [{"content": "hello world pip install requests"}]}
        out = entry_classifier_node(state)
        assert "risk_veto" in str(out.get("classification_reasons", []))


class TestEscalation:
    """Escalation reason and length veto."""

    def test_escalation_reason_set_for_complex_task(self):
        """Complex routing (plan_required) must set escalation_reason."""
        state = {"messages": [{"content": "design the architecture for our microservices migration"}]}
        out = entry_classifier_node(state)
        assert out.get("bypass_supervisor") is False
        assert out.get("plan_required") is True
        assert out.get("escalation_reason") != ""

    def test_length_veto_for_long_trivial_like_message(self):
        """Very long message that would score trivial gets length veto reason."""
        long_msg = "hello world in python " + "x" * 200
        assert len(long_msg) > 200
        state = {"messages": [{"content": long_msg}]}
        out = entry_classifier_node(state)
        assert "length_veto" in str(out.get("classification_reasons", []))


class TestIntentConfigLinter:
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
