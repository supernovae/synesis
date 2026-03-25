"""Tests for model_policy.py — conditional model selection."""

from __future__ import annotations

import json
import os
from unittest.mock import patch

import pytest
from app.model_policy import (
    ModelContext,
    PolicyResolution,
    PolicyRule,
    get_active_policies,
    invalidate_cache,
    preview_resolution,
    resolve_model,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    """Ensure clean policy cache for each test."""
    invalidate_cache()
    yield
    invalidate_cache()


class TestResolveModelStatic:
    """When no policies are configured, resolve_model falls back to settings."""

    def test_general_returns_static_defaults(self):
        res = resolve_model("general", ModelContext(difficulty=0.5))
        assert isinstance(res, PolicyResolution)
        assert res.source == "static"
        assert res.matched_rule is None
        assert res.model_name != ""

    def test_router_returns_static(self):
        res = resolve_model("router", ModelContext())
        assert res.source == "static"
        assert "router" in res.model_name.lower() or res.model_name != ""

    def test_critic_returns_static(self):
        res = resolve_model("critic", ModelContext())
        assert res.source == "static"

    def test_writer_alias_resolves_to_general(self):
        """writer alias should resolve through general role."""
        res = resolve_model("writer", ModelContext())
        assert res.role == "general"
        assert res.source == "static"

    def test_planner_alias_resolves_to_router(self):
        """planner alias should resolve through router role."""
        res = resolve_model("planner", ModelContext())
        assert res.role == "router"

    def test_advisor_alias_resolves_to_router(self):
        res = resolve_model("advisor", ModelContext())
        assert res.role == "router"

    def test_unknown_role_returns_empty(self):
        res = resolve_model("nonexistent", ModelContext())
        assert res.model_name == ""
        assert res.source == "static"


class TestResolveModelWithEnvPolicy:
    """Test policy loading from environment variables."""

    def test_difficulty_lt_matches(self):
        policy = json.dumps([
            {"condition": {"difficulty_lt": 0.7}, "model": "cheap-model", "label": "Easy"},
            {"condition": {"always": True}, "model": "expensive-model", "label": "Hard"},
        ])
        with patch.dict(os.environ, {"SYNESIS_GENERAL_MODEL_POLICY": policy}):
            invalidate_cache()

            easy = resolve_model("general", ModelContext(difficulty=0.3))
            assert easy.model_name == "cheap-model"
            assert easy.source == "policy"
            assert easy.matched_rule is not None
            assert easy.matched_rule.label == "Easy"

            hard = resolve_model("general", ModelContext(difficulty=0.8))
            assert hard.model_name == "expensive-model"
            assert hard.source == "policy"
            assert hard.matched_rule is not None
            assert hard.matched_rule.label == "Hard"

    def test_difficulty_gte_matches(self):
        policy = json.dumps([
            {"condition": {"difficulty_gte": 0.7}, "model": "reasoning-model"},
            {"condition": {"always": True}, "model": "fast-model"},
        ])
        with patch.dict(os.environ, {"SYNESIS_ROUTER_MODEL_POLICY": policy}):
            invalidate_cache()

            fast = resolve_model("router", ModelContext(difficulty=0.5))
            assert fast.model_name == "fast-model"

            hard = resolve_model("router", ModelContext(difficulty=0.7))
            assert hard.model_name == "reasoning-model"

    def test_boundary_values(self):
        """Exact boundary: difficulty_lt 0.7 should NOT match at exactly 0.7."""
        policy = json.dumps([
            {"condition": {"difficulty_lt": 0.7}, "model": "below"},
            {"condition": {"always": True}, "model": "at-or-above"},
        ])
        with patch.dict(os.environ, {"SYNESIS_GENERAL_MODEL_POLICY": policy}):
            invalidate_cache()

            at = resolve_model("general", ModelContext(difficulty=0.7))
            assert at.model_name == "at-or-above"

            just_below = resolve_model("general", ModelContext(difficulty=0.6999))
            assert just_below.model_name == "below"

    def test_always_catches_all(self):
        policy = json.dumps([
            {"condition": {"always": True}, "model": "catch-all"},
        ])
        with patch.dict(os.environ, {"SYNESIS_GENERAL_MODEL_POLICY": policy}):
            invalidate_cache()

            res = resolve_model("general", ModelContext(difficulty=0.0))
            assert res.model_name == "catch-all"

    def test_invalid_json_ignored(self):
        with patch.dict(os.environ, {"SYNESIS_GENERAL_MODEL_POLICY": "not json"}):
            invalidate_cache()
            res = resolve_model("general", ModelContext())
            assert res.source == "static"

    def test_empty_env_falls_through(self):
        with patch.dict(os.environ, {"SYNESIS_GENERAL_MODEL_POLICY": ""}):
            invalidate_cache()
            res = resolve_model("general", ModelContext())
            assert res.source == "static"

    def test_router_policy_affects_planner_alias(self):
        """Planner alias routes through 'router' role policies."""
        policy = json.dumps([
            {"condition": {"difficulty_gte": 0.7}, "model": "reasoning-router"},
            {"condition": {"always": True}, "model": "fast-router"},
        ])
        with patch.dict(os.environ, {"SYNESIS_ROUTER_MODEL_POLICY": policy}):
            invalidate_cache()

            fast = resolve_model("planner", ModelContext(difficulty=0.3))
            assert fast.model_name == "fast-router"

            hard = resolve_model("planner", ModelContext(difficulty=0.9))
            assert hard.model_name == "reasoning-router"


class TestPreview:
    """Test the preview_resolution utility."""

    def test_preview_with_policy(self):
        policy = json.dumps([
            {"condition": {"difficulty_lt": 0.5}, "model": "cheap"},
            {"condition": {"always": True}, "model": "expensive"},
        ])
        with patch.dict(os.environ, {"SYNESIS_GENERAL_MODEL_POLICY": policy}):
            invalidate_cache()
            result = preview_resolution("general")
            assert result["0.3"] == "cheap"
            assert result["0.7"] == "expensive"
            assert result["0.5"] == "expensive"

    def test_preview_without_policy(self):
        result = preview_resolution("general")
        values = list(result.values())
        assert all(v == values[0] for v in values)


class TestGetActivePolicies:
    """Test serialization for pipeline graph API."""

    def test_returns_empty_without_policies(self):
        result = get_active_policies()
        assert result == {}

    def test_returns_env_policies(self):
        policy = json.dumps([
            {"condition": {"difficulty_lt": 0.7}, "model": "m1"},
            {"condition": {"always": True}, "model": "m2"},
        ])
        with patch.dict(os.environ, {"SYNESIS_GENERAL_MODEL_POLICY": policy}):
            invalidate_cache()
            result = get_active_policies()
            assert "general" in result
            assert len(result["general"]) == 2
            assert result["general"][0]["model"] == "m1"


class TestPolicyRule:
    """Test PolicyRule dataclass."""

    def test_frozen(self):
        rule = PolicyRule(condition_type="always", model="test")
        with pytest.raises(AttributeError):
            rule.model = "changed"  # type: ignore[misc]


class TestCacheInvalidation:
    """Verify cache lifecycle."""

    def test_invalidate_forces_reload(self):
        policy = json.dumps([
            {"condition": {"always": True}, "model": "v1"},
        ])
        with patch.dict(os.environ, {"SYNESIS_GENERAL_MODEL_POLICY": policy}):
            invalidate_cache()
            res1 = resolve_model("general", ModelContext())
            assert res1.model_name == "v1"

        with patch.dict(os.environ, {"SYNESIS_GENERAL_MODEL_POLICY": ""}):
            invalidate_cache()
            res2 = resolve_model("general", ModelContext())
            assert res2.source == "static"


class TestEffortModeResolution:
    def test_general_effort_mode_routes_to_effort_role(self):
        policy = json.dumps([
            {"condition": {"always": True}, "model": "general-pulse-model"},
        ])
        with patch.dict(os.environ, {"SYNESIS_GENERAL-PULSE_MODEL_POLICY": policy}):
            invalidate_cache()
            res = resolve_model("general", ModelContext(difficulty=0.2, selected_effort_mode="pulse"))
            assert res.role == "general-pulse"
            assert res.model_name == "general-pulse-model"

    def test_provider_degradation_falls_back_to_general_without_effort_change(self):
        """If effort-specific role has no configured route, resolver falls back to static general mapping."""
        with patch.dict(os.environ, {"SYNESIS_GENERAL-PULSE_MODEL_POLICY": ""}):
            invalidate_cache()
            res = resolve_model("general", ModelContext(difficulty=0.2, selected_effort_mode="pulse"))
            assert res.role == "general-pulse"
            # static fallback remains available (implementation detail hidden behind effort contract)
            assert res.model_name != ""
