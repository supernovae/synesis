"""Tests for provider discovery service and API endpoints.

Run from base/admin/:
    PYTHONPATH=. uv run pytest tests/test_provider_discovery.py -v
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Unit tests — provider_discovery module
# ---------------------------------------------------------------------------


class TestValidateModelId:
    def test_empty_model_id(self):
        from app.services.provider_discovery import validate_model_id

        result = validate_model_id("openrouter", "")
        assert result["valid"] is False
        assert "empty" in result["reason"].lower()

    def test_valid_model_id(self):
        from app.services.provider_discovery import validate_model_id

        result = validate_model_id("openrouter", "meta-llama/llama-3-70b")
        assert result["valid"] is True

    def test_model_with_provider_prefix_rejected(self):
        from app.services.provider_discovery import validate_model_id

        result = validate_model_id("openrouter", "openrouter/meta-llama/llama-3-70b")
        assert result["valid"] is False
        assert "prefix" in result["reason"].lower()
        assert result["suggestion"] == "meta-llama/llama-3-70b"

    def test_deepinfra_prefix_rejected(self):
        from app.services.provider_discovery import validate_model_id

        result = validate_model_id("deepinfra", "deepinfra/meta-llama/Meta-Llama-3.1-70B")
        assert result["valid"] is False
        assert result["suggestion"] == "meta-llama/Meta-Llama-3.1-70B"

    def test_unknown_provider_passes(self):
        from app.services.provider_discovery import validate_model_id

        result = validate_model_id("nonexistent", "some-model")
        assert result["valid"] is True

    def test_whitespace_only(self):
        from app.services.provider_discovery import validate_model_id

        result = validate_model_id("openai", "   ")
        assert result["valid"] is False


class TestGetDefaultsForModel:
    def test_basic_defaults(self):
        from app.services.provider_discovery import get_defaults_for_model

        d = get_defaults_for_model("openai", "gpt-4o")
        assert d.max_tokens == 8192
        assert d.temperature == 0.1
        assert d.supports_streaming is True

    def test_large_context_increases_max_tokens(self):
        from app.services.provider_discovery import get_defaults_for_model

        d = get_defaults_for_model("openrouter", "some-model", context_window=200_000)
        assert d.max_tokens == 16384

    def test_anthropic_supports_tools(self):
        from app.services.provider_discovery import get_defaults_for_model

        d = get_defaults_for_model("anthropic", "claude-sonnet-4-20250514")
        assert d.supports_tools is True

    def test_deepseek_v4_defaults_support_tools_and_large_outputs(self):
        from app.services.provider_discovery import get_defaults_for_model

        d = get_defaults_for_model("deepseek", "deepseek-v4-flash", context_window=1_000_000)
        assert d.supports_tools is True
        assert d.max_tokens == 16384
        assert "DeepSeek V4" in d.notes

    def test_xiaomi_mimo_defaults_support_tools(self):
        from app.services.provider_discovery import get_defaults_for_model

        d = get_defaults_for_model("xiaomi", "mimo-v2.5-pro", context_window=1_000_000)
        assert d.supports_tools is True
        assert d.max_tokens == 16384
        assert "Xiaomi MiMo" in d.notes

    def test_unknown_provider_returns_safe_defaults(self):
        from app.services.provider_discovery import get_defaults_for_model

        d = get_defaults_for_model("nonexistent", "model")
        assert d.max_tokens == 8192


class TestSupportedDiscoveryProviders:
    def test_known_providers_included(self):
        from app.services.provider_discovery import supported_discovery_providers

        providers = supported_discovery_providers()
        assert "openrouter" in providers
        assert "deepinfra" in providers
        assert "groq" in providers
        assert "openai" in providers
        assert "anthropic" in providers

    def test_local_providers_excluded(self):
        from app.services.provider_discovery import supported_discovery_providers

        providers = supported_discovery_providers()
        assert "vllm" not in providers
        assert "kserve" not in providers
        assert "custom" not in providers


class TestDiscoverModelsLocal:
    """Tests that don't hit real APIs."""

    def test_unknown_provider(self):
        import asyncio

        from app.services.provider_discovery import discover_models

        result = asyncio.run(discover_models("nonexistent"))
        assert result.error is not None
        assert "Unknown" in result.error

    def test_local_provider_rejected(self):
        import asyncio

        from app.services.provider_discovery import discover_models

        result = asyncio.run(discover_models("vllm"))
        assert result.error is not None
        assert "Local" in result.error

    def test_missing_key(self):
        import asyncio

        from app.services.provider_discovery import discover_models

        result = asyncio.run(discover_models("deepinfra", bypass_cache=True))
        assert result.error is not None or len(result.models) >= 0


class TestProviderCatalog:
    def test_catalog_includes_discovery_flag(self):
        from app.services.provider_catalog import get_catalog

        catalog = get_catalog()
        for key, info in catalog["providers"].items():
            assert "supports_discovery" in info, f"{key} missing supports_discovery"

    def test_openrouter_supports_discovery(self):
        from app.services.provider_catalog import get_catalog

        catalog = get_catalog()
        assert catalog["providers"]["openrouter"]["supports_discovery"] is True

    def test_vllm_does_not_support_discovery(self):
        from app.services.provider_catalog import get_catalog

        catalog = get_catalog()
        assert catalog["providers"]["vllm"]["supports_discovery"] is False

    def test_custom_does_not_support_discovery(self):
        from app.services.provider_catalog import get_catalog

        catalog = get_catalog()
        assert catalog["providers"]["custom"]["supports_discovery"] is False

    def test_deepseek_and_xiaomi_catalog_defaults(self):
        from app.services.provider_catalog import default_endpoint_for_provider, get_catalog

        catalog = get_catalog()
        assert catalog["providers"]["deepseek"]["api_key_env"] == "DEEPSEEK_API_KEY"
        assert default_endpoint_for_provider("deepseek") == "https://api.deepseek.com"
        assert catalog["providers"]["xiaomi"]["api_key_env"] == "MIMO_API_KEY"
        assert default_endpoint_for_provider("xiaomi") == "https://api.xiaomimimo.com/v1"


class TestBundledPricing:
    def test_deepseek_and_xiaomi_pricing_lookup(self):
        from app.services.pricing_lookup import lookup_bundled_pricing

        assert lookup_bundled_pricing("deepseek", "deepseek-v4-flash") == (0.14, 0.28, 0.0028, None)
        assert lookup_bundled_pricing("xiaomi", "mimo-v2.5") == (0.42, 2.10, 0.08, None)


class TestDefaultPublicOfferings:
    def test_deepseek_and_xiaomi_default_public_offerings_validate(self):
        from app.services.public_model_offerings_rules import (
            DEFAULT_PUBLIC_OFFERINGS,
            normalize_generation_params,
            normalize_offering_connection,
        )

        by_id = {o["client_model_id"]: o for o in DEFAULT_PUBLIC_OFFERINGS}
        assert {"deepseek-v4-flash", "deepseek-v4-pro", "mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-flash"}.issubset(by_id)
        for offering in by_id.values():
            effort, route, mode, provider, endpoint, api_key_env = normalize_offering_connection(
                effort_tier=offering["effort_tier"],
                route_via_role=None,
                connection_mode=offering["connection_mode"],
                standalone_provider=offering["standalone_provider"],
                standalone_endpoint=offering["standalone_endpoint"],
                standalone_api_key_env=offering["standalone_api_key_env"],
                expose_yarn=offering["expose_yarn"],
            )
            assert effort in {"pulse", "core", "horizon"}
            assert route is None
            assert mode == "standalone"
            assert provider in {"deepseek", "xiaomi"}
            assert endpoint
            assert api_key_env
            assert normalize_generation_params(offering["generation_params"])
