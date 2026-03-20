"""Pricing lookup — resolve per-token costs for API providers.

Tries the running LiteLLM proxy first (/model/info contains cost data when
available), then falls back to a bundled snapshot of common model prices.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("synesis.admin.pricing")

# ---------------------------------------------------------------------------
# Bundled pricing snapshot ($/million tokens).
# Kept deliberately compact — only models users are likely to assign.
# Updated 2026-03 from provider pricing pages.
# ---------------------------------------------------------------------------

_BUNDLED_PRICES: dict[str, tuple[float, float]] = {
    # OpenRouter (aggregator — prices vary; these are representative)
    "openrouter/x-ai/grok-4-fast": (3.0, 15.0),
    "openrouter/x-ai/grok-3-mini": (0.30, 0.50),
    "openrouter/meta-llama/llama-3.3-70b-instruct": (0.39, 0.40),
    "openrouter/meta-llama/llama-4-maverick": (0.20, 0.60),
    "openrouter/meta-llama/llama-4-scout": (0.15, 0.40),
    "openrouter/qwen/qwen3-235b-a22b": (0.20, 0.60),
    "openrouter/qwen/qwen3-32b": (0.10, 0.30),
    "openrouter/deepseek/deepseek-r1": (0.55, 2.19),
    "openrouter/deepseek/deepseek-chat-v3-0324": (0.27, 1.10),
    "openrouter/google/gemini-2.5-pro-preview": (1.25, 10.0),
    "openrouter/anthropic/claude-sonnet-4": (3.0, 15.0),
    # Groq
    "groq/llama-3.3-70b-versatile": (0.59, 0.79),
    "groq/llama-3.1-8b-instant": (0.05, 0.08),
    "groq/meta-llama/llama-4-scout-17b-16e-instruct": (0.11, 0.34),
    "groq/deepseek-r1-distill-llama-70b": (0.75, 0.99),
    "groq/qwen-qwq-32b": (0.29, 0.39),
    "groq/gemma2-9b-it": (0.20, 0.20),
    # DeepInfra
    "deepinfra/meta-llama/Meta-Llama-3.1-70B": (0.35, 0.40),
    "deepinfra/meta-llama/Llama-4-Maverick-17B-128E-Instruct": (0.20, 0.60),
    "deepinfra/Qwen/Qwen3-235B-A22B": (0.20, 0.60),
    "deepinfra/deepseek-ai/DeepSeek-R1": (0.55, 2.19),
    # Together AI
    "together_ai/meta-llama/Llama-3-70b": (0.54, 0.54),
    "together_ai/meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo": (0.54, 0.54),
    "together_ai/Qwen/Qwen2.5-72B-Instruct-Turbo": (0.60, 0.60),
    # Fireworks AI
    "fireworks_ai/llama-v3p1-70b-instruct": (0.90, 0.90),
    "fireworks_ai/qwen2p5-72b-instruct": (0.90, 0.90),
    # OpenAI
    "openai/gpt-4o": (2.50, 10.0),
    "openai/gpt-4o-mini": (0.15, 0.60),
    "openai/gpt-4.1": (2.0, 8.0),
    "openai/gpt-4.1-mini": (0.40, 1.60),
    "openai/gpt-4.1-nano": (0.10, 0.40),
    "openai/o3": (10.0, 40.0),
    "openai/o3-mini": (1.10, 4.40),
    "openai/o4-mini": (1.10, 4.40),
    # Anthropic
    "anthropic/claude-sonnet-4-20250514": (3.0, 15.0),
    "anthropic/claude-3.5-sonnet-20241022": (3.0, 15.0),
    "anthropic/claude-3-haiku-20240307": (0.25, 1.25),
    "anthropic/claude-3.5-haiku-20241022": (0.80, 4.0),
    # Mistral
    "mistral/mistral-large-latest": (2.0, 6.0),
    "mistral/mistral-small-latest": (0.10, 0.30),
    "mistral/codestral-latest": (0.30, 0.90),
    # Azure (same as OpenAI, model names without prefix)
    "azure/gpt-4o": (2.50, 10.0),
    "azure/gpt-4o-mini": (0.15, 0.60),
}

# Build a secondary index by bare model name for fallback matching.
_BARE_NAME_INDEX: dict[str, tuple[float, float]] = {}
for _key, _val in _BUNDLED_PRICES.items():
    _bare = _key.split("/", 1)[1] if "/" in _key else _key
    if _bare not in _BARE_NAME_INDEX:
        _BARE_NAME_INDEX[_bare] = _val


def _litellm_prefixed_key(provider: str, model: str) -> str:
    """Build the LiteLLM-style key for bundled lookup."""
    from .provider_catalog import PROVIDER_CATALOG

    info = PROVIDER_CATALOG.get(provider)
    if info:
        return f"{info.litellm_prefix}{model}"
    return model


def lookup_bundled_pricing(provider: str, model: str) -> tuple[float, float] | None:
    """Look up pricing from the bundled snapshot.

    Returns (input_per_million, output_per_million) or None.
    """
    key = _litellm_prefixed_key(provider, model)
    if key in _BUNDLED_PRICES:
        return _BUNDLED_PRICES[key]
    # Try bare model name.
    if model in _BARE_NAME_INDEX:
        return _BARE_NAME_INDEX[model]
    # Fuzzy: strip org prefix from model (e.g. "meta-llama/Llama-3-70b" -> "Llama-3-70b").
    if "/" in model:
        short = model.rsplit("/", 1)[1]
        if short in _BARE_NAME_INDEX:
            return _BARE_NAME_INDEX[short]
    return None


async def lookup_litellm_pricing(model_name: str) -> tuple[float, float] | None:
    """Query the running LiteLLM proxy for pricing on a served model name.

    LiteLLM's /model/info response includes model_info.input_cost_per_token
    and model_info.output_cost_per_token when pricing is known.
    """
    try:
        from . import litellm_client

        models = await litellm_client.list_models(timeout=5.0)
        for m in models:
            info = m.get("model_info", {}) or {}
            if m.get("model_name") == model_name or info.get("id") == model_name:
                inp = info.get("input_cost_per_token", 0)
                out = info.get("output_cost_per_token", 0)
                if inp or out:
                    return (float(inp) * 1_000_000, float(out) * 1_000_000)
    except Exception:
        logger.debug("litellm_pricing_lookup_failed model=%s", model_name, exc_info=True)
    return None


async def resolve_pricing(
    provider: str,
    model: str,
    served_name: str = "",
) -> tuple[tuple[float, float], str] | None:
    """Resolve pricing for a provider + model combination.

    Returns ((input_per_million, output_per_million), source) or None.
    source is one of: "litellm", "bundled", or None on miss.
    """
    # 1. Try LiteLLM proxy (it may have actual pricing from the provider).
    if served_name:
        result = await lookup_litellm_pricing(served_name)
        if result:
            return result, "litellm"

    # 2. Bundled snapshot.
    result = lookup_bundled_pricing(provider, model)
    if result:
        return result, "bundled"

    return None


def get_bundled_prices_for_catalog() -> dict[str, dict[str, Any]]:
    """Return a summary dict for GET /providers/catalog pricing hints."""
    out: dict[str, dict[str, Any]] = {}
    for key, (inp, outp) in _BUNDLED_PRICES.items():
        out[key] = {"input_per_million": inp, "output_per_million": outp}
    return out
