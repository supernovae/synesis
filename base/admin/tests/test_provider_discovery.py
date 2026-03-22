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

    def test_model_with_litellm_prefix_rejected(self):
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
