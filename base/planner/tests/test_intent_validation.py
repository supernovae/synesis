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
        {"prompt": "hello world in python", "expected": {"task_size": "trivial", "bypass_supervisor": True}},
        {"prompt": "design the architecture for our microservices migration", "expected": {"task_size": "complex"}},
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
            "task_size": "trivial",
            "bypass_supervisor": True,
        }
        # EntryClassifier sets these; simulate
        out = entry_classifier_node(state)
        state.update(out)
        assert route_after_entry_classifier(state) == "context_curator"

    def test_small_routes_to_supervisor(self):
        from app.graph import route_after_entry_classifier

        state = {
            "messages": [{"content": "write a data fetcher script"}],
            "task_size": "small",
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

    def test_trivial_sets_tier_trivial(self):
        state = {"messages": [{"content": "hello world in python"}]}
        out = entry_classifier_node(state)
        assert out.get("worker_prompt_tier") == "trivial"

    def test_small_sets_tier_small(self):
        state = {"messages": [{"content": "write a data fetcher script"}]}
        out = entry_classifier_node(state)
        assert out.get("worker_prompt_tier") == "small"

    def test_complex_sets_tier_full(self):
        state = {"messages": [{"content": "design the architecture for our microservices migration"}]}
        out = entry_classifier_node(state)
        assert out.get("worker_prompt_tier") == "full"

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
        """Pro users can jump to full JCS prompt via explicit signals."""
        state = {"messages": [{"content": prompt}]}
        out = entry_classifier_node(state)
        assert out.get("worker_prompt_tier") == "full", f'Expected worker_prompt_tier=full for pro shortcut "{prompt}"'
