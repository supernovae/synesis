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

    def test_bills_cache_creation_at_input_when_write_rate_unset(self):
        from app.services.token_cost import estimate_llm_call_cost_from_payload

        cost = estimate_llm_call_cost_from_payload(
            {
                "prompt_tokens": 500_000,
                "completion_tokens": 0,
                "cached_prompt_tokens": 0,
                "cache_creation_tokens": 1_000_000,
            },
            input_per_million=2.0,
            output_per_million=0.0,
            input_cached_per_million=None,
            input_cache_write_per_million=None,
        )
        assert cost == 3.0

    def test_bills_cache_creation_at_explicit_write_rate(self):
        from app.services.token_cost import estimate_llm_call_cost_from_payload

        cost = estimate_llm_call_cost_from_payload(
            {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "cached_prompt_tokens": 0,
                "cache_creation_tokens": 1_000_000,
            },
            input_per_million=3.0,
            output_per_million=0.0,
            input_cached_per_million=None,
            input_cache_write_per_million=0.5,
        )
        assert cost == 0.5

    def test_breakdown_reports_cache_read_write_and_savings(self):
        from app.services.token_cost import estimate_llm_cost_breakdown

        breakdown = estimate_llm_cost_breakdown(
            prompt_tokens=1_000_000,
            completion_tokens=100_000,
            cached_prompt_tokens=800_000,
            cache_creation_tokens=50_000,
            input_per_million=1.0,
            output_per_million=5.0,
            input_cached_per_million=0.1,
            input_cache_write_per_million=1.25,
        )

        assert breakdown["tokens_uncached_input"] == 200_000
        assert breakdown["tokens_cache_read"] == 800_000
        assert breakdown["tokens_cache_write"] == 50_000
        assert breakdown["input_cost_usd"] == 0.2
        assert breakdown["cache_read_cost_usd"] == 0.08
        assert breakdown["cache_write_cost_usd"] == 0.0625
        assert breakdown["output_cost_usd"] == 0.5
        assert breakdown["estimated_no_cache_cost_usd"] == 1.5
        assert breakdown["cache_savings_usd"] == 0.6575
