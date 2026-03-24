"""Tests for token-cost helper utilities used by cost dashboards."""

from __future__ import annotations


class TestParseRecordedEstimatedCost:
    def test_parses_numeric_estimated_cost(self):
        from app.services.token_cost import parse_recorded_estimated_cost

        assert parse_recorded_estimated_cost({"estimated_cost": 0.1234}) == 0.1234

    def test_rejects_negative_estimated_cost(self):
        from app.services.token_cost import parse_recorded_estimated_cost

        assert parse_recorded_estimated_cost({"estimated_cost": -0.01}) is None

    def test_returns_none_when_missing(self):
        from app.services.token_cost import parse_recorded_estimated_cost

        assert parse_recorded_estimated_cost({}) is None


class TestEstimateLlmCallCostFromPayload:
    def test_estimates_from_payload_tokens(self):
        from app.services.token_cost import estimate_llm_call_cost_from_payload

        cost = estimate_llm_call_cost_from_payload(
            {
                "prompt_tokens": 1_000_000,
                "completion_tokens": 500_000,
                "cached_prompt_tokens": 0,
            },
            input_per_million=0.2,
            output_per_million=0.5,
            input_cached_per_million=None,
        )
        assert cost == 0.45

    def test_uses_cached_rate_when_present(self):
        from app.services.token_cost import estimate_llm_call_cost_from_payload

        cost = estimate_llm_call_cost_from_payload(
            {
                "prompt_tokens": 1_000_000,
                "completion_tokens": 0,
                "cached_prompt_tokens": 1_000_000,
            },
            input_per_million=1.0,
            output_per_million=0.0,
            input_cached_per_million=0.2,
        )
        assert cost == 0.2
