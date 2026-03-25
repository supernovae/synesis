"""Tests for the tier registry, Claude family matching, admin-fed config, and cost tracking."""

from __future__ import annotations

import pytest

from app.model.tiers import (
    TIER_CORE,
    TIER_HORIZON,
    TIER_NAMES,
    TIER_PULSE,
    ModelTier,
    TierRegistry,
)
from app.model.usage_tracker import UsageAggregator, UsageRecord


def _make_tier(name: str, **kw) -> ModelTier:
    defaults = dict(
        display_name=name.title(),
        description=f"Test {name}",
        backend_model=f"test/{name}",
        base_url="http://localhost:8080/v1",
        api_key="test-key",
    )
    defaults.update(kw)
    return ModelTier(name=name, **defaults)


def _three_tier_registry(**kw) -> TierRegistry:
    tiers = {
        TIER_PULSE: _make_tier(TIER_PULSE),
        TIER_CORE: _make_tier(TIER_CORE),
        TIER_HORIZON: _make_tier(TIER_HORIZON),
    }
    return TierRegistry(tiers, default_tier=kw.get("default_tier", TIER_CORE))


class TestTierRegistry:
    def test_resolve_exact_id(self):
        reg = _three_tier_registry()
        assert reg.resolve(TIER_PULSE).name == TIER_PULSE
        assert reg.resolve(TIER_CORE).name == TIER_CORE
        assert reg.resolve(TIER_HORIZON).name == TIER_HORIZON

    def test_resolve_unknown_raises(self):
        reg = _three_tier_registry()
        with pytest.raises(ValueError, match="Unknown model"):
            reg.resolve("nonexistent-model")

    def test_available_ids(self):
        reg = _three_tier_registry()
        assert set(reg.available_ids) == set(TIER_NAMES)

    def test_default_tier(self):
        reg = _three_tier_registry(default_tier=TIER_HORIZON)
        assert reg.default.name == TIER_HORIZON


class TestClaudeFamilyMatching:
    def test_haiku_maps_to_pulse(self):
        reg = _three_tier_registry()
        assert reg.resolve_claude("claude-3-5-haiku-20241022").name == TIER_PULSE

    def test_sonnet_maps_to_core(self):
        reg = _three_tier_registry()
        assert reg.resolve_claude("claude-sonnet-4-6").name == TIER_CORE

    def test_opus_maps_to_horizon(self):
        reg = _three_tier_registry()
        assert reg.resolve_claude("claude-opus-4-6").name == TIER_HORIZON

    def test_unknown_claude_model_falls_back_to_default(self):
        reg = _three_tier_registry()
        tier = reg.resolve_claude("claude-unknown-model-99")
        assert tier.name == TIER_CORE

    def test_direct_tier_id_via_claude_resolve(self):
        reg = _three_tier_registry()
        assert reg.resolve_claude(TIER_PULSE).name == TIER_PULSE

    def test_custom_claude_family_map(self):
        reg = TierRegistry(
            {
                TIER_PULSE: _make_tier(TIER_PULSE),
                TIER_CORE: _make_tier(TIER_CORE),
                TIER_HORIZON: _make_tier(TIER_HORIZON),
            },
            default_tier=TIER_CORE,
            claude_family_map={"sonnet": TIER_HORIZON, "haiku": TIER_CORE},
        )
        assert reg.resolve_claude("claude-sonnet-4-6").name == TIER_HORIZON
        assert reg.resolve_claude("claude-3-5-haiku-20241022").name == TIER_CORE


class TestListModels:
    def test_v1_models_shape(self):
        reg = _three_tier_registry()
        resp = reg.list_models()
        assert resp["object"] == "list"
        assert len(resp["data"]) == 3
        ids = [m["id"] for m in resp["data"]]
        assert ids == [TIER_PULSE, TIER_CORE, TIER_HORIZON]

    def test_v1_models_fields(self):
        reg = _three_tier_registry()
        model = reg.list_models()["data"][0]
        assert model["object"] == "model"
        assert model["owned_by"] == "synesis"
        assert "description" in model

    def test_partial_registry_lists_available_only(self):
        reg = TierRegistry(
            {TIER_CORE: _make_tier(TIER_CORE)},
            default_tier=TIER_CORE,
        )
        resp = reg.list_models()
        assert len(resp["data"]) == 1
        assert resp["data"][0]["id"] == TIER_CORE


class TestFromAdminResponse:
    def test_builds_from_roles_and_costs(self):
        roles = [
            {"role": "coder-pulse", "assigned": True, "model": "test/pulse", "endpoint": "http://pulse:8080/v1"},
            {"role": "coder-core", "assigned": True, "model": "test/core", "endpoint": "http://core:8080/v1"},
            {"role": "coder-horizon", "assigned": True, "model": "test/horizon", "endpoint": ""},
        ]
        costs = [
            {"role": "coder-pulse", "input_per_million": 0.1, "output_per_million": 0.5, "input_cached_per_million": 0.01},
            {"role": "coder-core", "input_per_million": 0.5, "output_per_million": 2.0, "input_cached_per_million": 0.05},
        ]
        reg = TierRegistry.from_admin_response(
            roles, costs,
            fallback_url="http://fallback:4000/v1",
            fallback_key="fallback-key",
        )
        pulse = reg.resolve(TIER_PULSE)
        assert pulse.backend_model == "test/pulse"
        assert pulse.base_url == "http://pulse:8080/v1"
        assert pulse.input_per_m == 0.1

        horizon = reg.resolve(TIER_HORIZON)
        assert horizon.base_url == "http://fallback:4000/v1"
        assert horizon.output_per_m == 0.0

    def test_skips_unassigned_roles(self):
        roles = [
            {"role": "coder-pulse", "assigned": False, "model": "test/pulse"},
            {"role": "coder-core", "assigned": True, "model": "test/core", "endpoint": "http://core:8080/v1"},
        ]
        reg = TierRegistry.from_admin_response(roles, [], fallback_url="http://f:4000/v1", fallback_key="k")
        assert TIER_PULSE not in reg.available_ids
        assert TIER_CORE in reg.available_ids


class TestPerTierCost:
    def test_usage_record_computes_cost(self):
        rec = UsageRecord(
            provider=TIER_CORE,
            model=TIER_CORE,
            tokens_in=1_000_000,
            tokens_out=500_000,
            tokens_cached=200_000,
            input_per_m=0.50,
            output_per_m=2.00,
            cached_per_m=0.05,
        )
        cost = rec.compute_cost()
        expected = (200_000 / 1e6) * 0.05 + (800_000 / 1e6) * 0.50 + (500_000 / 1e6) * 2.00
        assert abs(cost - expected) < 0.001

    def test_zero_rates_give_zero_cost(self):
        rec = UsageRecord(tokens_in=1000, tokens_out=500)
        assert rec.compute_cost() == 0.0

    def test_aggregator_sums_across_records(self):
        agg = UsageAggregator()
        r1 = UsageRecord(tokens_in=100, tokens_out=50, input_per_m=1.0, output_per_m=2.0)
        r2 = UsageRecord(tokens_in=200, tokens_out=100, input_per_m=1.0, output_per_m=2.0)
        agg.add(r1)
        agg.add(r2)
        assert agg.total_tokens_in == 300
        assert agg.total_tokens_out == 150
        assert agg.total_cost_usd > 0
