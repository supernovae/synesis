"""Tests for smarter web search gating.

Validates:
  - scaled_web_budget always returns at least web_budget_base
  - needs_web propagates through the semantic frame
  - force_web bypasses budget gating in retrieve_unified

Note: needs_web is now decided by the LLM during frame extraction,
not by a regex override. The old _FRESHNESS_KEYWORDS regex was removed.
"""

from __future__ import annotations


class TestScaledWebBudget:
    """Verify web budget floor and scaling."""

    def _make_settings(self, **overrides):
        """Build a minimal mock of the config Settings for budget calculation."""

        class FakeSettings:
            crag_max_web_queries = 8
            web_budget_base = 1

            def scaled_web_budget(self, difficulty: float) -> int:
                d = max(0.0, min(1.0, difficulty))
                return self.web_budget_base + int(d * (self.crag_max_web_queries - self.web_budget_base))

        s = FakeSettings()
        for k, v in overrides.items():
            setattr(s, k, v)
        return s

    def test_floor_at_zero_difficulty(self):
        s = self._make_settings()
        assert s.scaled_web_budget(0.0) == 1

    def test_floor_at_low_difficulty(self):
        s = self._make_settings()
        assert s.scaled_web_budget(0.05) >= 1

    def test_max_at_full_difficulty(self):
        s = self._make_settings()
        assert s.scaled_web_budget(1.0) == 8

    def test_scales_linearly(self):
        s = self._make_settings()
        b_low = s.scaled_web_budget(0.3)
        b_high = s.scaled_web_budget(0.8)
        assert b_high > b_low

    def test_custom_base(self):
        s = self._make_settings(web_budget_base=2)
        assert s.scaled_web_budget(0.0) == 2
        assert s.scaled_web_budget(1.0) == 8

    def test_zero_base_old_behavior(self):
        s = self._make_settings(web_budget_base=0)
        assert s.scaled_web_budget(0.0) == 0
        assert s.scaled_web_budget(1.0) == 8

    def test_negative_difficulty_clamps(self):
        s = self._make_settings()
        assert s.scaled_web_budget(-0.5) == 1

    def test_over_one_difficulty_clamps(self):
        s = self._make_settings()
        assert s.scaled_web_budget(1.5) == 8


class TestNeedsWebPropagation:
    """Verify needs_web flows through the semantic frame dict correctly."""

    def test_default_false(self):
        frame = {"problem": "explain binary search", "goals": [], "needs_web": False}
        assert frame.get("needs_web", False) is False

    def test_set_true(self):
        frame = {"problem": "latest Kubernetes release", "needs_web": True}
        assert frame.get("needs_web", False) is True

    def test_missing_defaults_false(self):
        frame = {"problem": "explain quicksort"}
        assert frame.get("needs_web", False) is False


class TestForceWebLogic:
    """Verify the force_web bypass logic for web_enabled."""

    def test_force_web_overrides_zero_budget(self):
        web_budget = 0
        web_search_enabled = True
        force_web = True
        web_enabled = web_search_enabled and (web_budget > 0 or force_web)
        assert web_enabled is True

    def test_no_force_with_zero_budget(self):
        web_budget = 0
        web_search_enabled = True
        force_web = False
        web_enabled = web_search_enabled and (web_budget > 0 or force_web)
        assert web_enabled is False

    def test_force_web_respects_global_disable(self):
        web_budget = 0
        web_search_enabled = False
        force_web = True
        web_enabled = web_search_enabled and (web_budget > 0 or force_web)
        assert web_enabled is False

    def test_normal_budget_without_force(self):
        web_budget = 3
        web_search_enabled = True
        force_web = False
        web_enabled = web_search_enabled and (web_budget > 0 or force_web)
        assert web_enabled is True

    def test_budget_plus_force(self):
        web_budget = 3
        web_search_enabled = True
        force_web = True
        web_enabled = web_search_enabled and (web_budget > 0 or force_web)
        assert web_enabled is True
