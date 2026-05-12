"""Provider model discovery — fetch available models from external provider APIs.

Each supported provider has an adapter that normalises the upstream model list
into a common ``DiscoveredModel`` shape.  Adapters degrade gracefully: if the
provider API is unreachable or the key is missing the caller gets an error
string instead of a model list.
"""

from __future__ import annotations

import base64
import logging
import os
from dataclasses import asdict, dataclass, field
from typing import Any

import httpx

from .provider_catalog import PROVIDER_CATALOG

logger = logging.getLogger("synesis.admin.provider_discovery")

_HTTP_TIMEOUT = 12

# ---------------------------------------------------------------------------
# Shared types
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DiscoveredModel:
    id: str
    name: str
    context_window: int | None = None
    max_output_tokens: int | None = None
    supports_streaming: bool = True
    supports_tools: bool = False
    pricing_input_per_million: float | None = None
    pricing_output_per_million: float | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(slots=True)
class ProviderDefaults:
    """Recommended route parameters for a provider + model pair."""

    max_tokens: int = 8192
    temperature: float = 0.1
    supports_streaming: bool = True
    supports_tools: bool = False
    context_window: int | None = None
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(slots=True)
class DiscoveryResult:
    provider: str
    models: list[DiscoveredModel] = field(default_factory=list)
    error: str | None = None
    cached: bool = False

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "models": [m.to_dict() for m in self.models],
            "error": self.error,
            "cached": self.cached,
            "count": len(self.models),
        }


# ---------------------------------------------------------------------------
# K8s secret reader (reusable helper)
# ---------------------------------------------------------------------------

_SECRET_NAME = "provider-api-keys"
_SECRET_NAMESPACE = os.environ.get("SYNESIS_GATEWAY_NAMESPACE", "synesis-gateway")
_SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
_SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
_K8S_HOST = os.environ.get("KUBERNETES_SERVICE_HOST", "")
_K8S_PORT = os.environ.get("KUBERNETES_SERVICE_PORT", "443")


async def _read_api_key(env_name: str) -> str | None:
    """Try env var first, then fall back to the K8s secret."""
    val = os.environ.get(env_name)
    if val:
        return val
    if not _K8S_HOST:
        return None
    try:
        token_path = _SA_TOKEN_PATH
        with open(token_path) as f:
            token = f.read().strip()
        url = f"https://{_K8S_HOST}:{_K8S_PORT}/api/v1/namespaces/{_SECRET_NAMESPACE}/secrets/{_SECRET_NAME}"
        if not os.path.exists(_SA_CA_PATH):
            logger.debug("k8s_api_env_lookup_skipped reason=missing_service_account_ca")
            return None
        verify: str | bool = _SA_CA_PATH
        async with httpx.AsyncClient(verify=verify) as client:
            resp = await client.get(
                url,
                headers={"Authorization": f"Bearer {token}"},
                timeout=6,
            )
            if resp.status_code != 200:
                return None
            data = resp.json().get("data", {})
            encoded = data.get(env_name)
            if encoded:
                return base64.b64decode(encoded).decode()
    except Exception:
        logger.debug("k8s_api_env_lookup_failed env=%s", env_name, exc_info=True)
    return None


# ---------------------------------------------------------------------------
# Per-provider adapters
# ---------------------------------------------------------------------------


def _pick(obj: dict, *keys: str) -> Any:
    for k in keys:
        if k in obj:
            return obj[k]
    return None


async def _openai_compat_models(
    base_url: str,
    api_key: str,
    *,
    _provider_name: str,
) -> list[DiscoveredModel]:
    """Generic adapter for OpenAI-compatible /v1/models endpoints."""
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        resp = await client.get(f"{base_url}/v1/models", headers=headers)
        resp.raise_for_status()
    raw = resp.json().get("data", [])
    models: list[DiscoveredModel] = []
    for m in raw:
        mid = m.get("id", "")
        if not mid:
            continue
        ctx = _pick(m, "context_window", "context_length", "max_model_len")
        models.append(
            DiscoveredModel(
                id=mid,
                name=m.get("name", mid),
                context_window=int(ctx) if ctx else None,
                supports_tools=bool(_pick(m, "supports_tool_calls", "tool_use")),
            )
        )
    models.sort(key=lambda m: m.id)
    return models


async def _discover_openrouter() -> DiscoveryResult:
    """OpenRouter — public API, no key needed for model listing."""
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get("https://openrouter.ai/api/v1/models")
            resp.raise_for_status()
        raw = resp.json().get("data", [])
        models: list[DiscoveredModel] = []
        for m in raw:
            mid = m.get("id", "")
            if not mid:
                continue
            pricing = m.get("pricing", {})
            inp = _safe_float(pricing.get("prompt"))
            out = _safe_float(pricing.get("completion"))
            models.append(
                DiscoveredModel(
                    id=mid,
                    name=m.get("name", mid),
                    context_window=_safe_int(m.get("context_length")),
                    supports_tools=bool(m.get("supports_tool_calls")),
                    pricing_input_per_million=inp * 1_000_000 if inp is not None else None,
                    pricing_output_per_million=out * 1_000_000 if out is not None else None,
                )
            )
        models.sort(key=lambda m: m.id)
        return DiscoveryResult(provider="openrouter", models=models)
    except Exception as exc:
        return DiscoveryResult(provider="openrouter", error=str(exc)[:300])


async def _discover_deepinfra() -> DiscoveryResult:
    key = await _read_api_key("DEEPINFRA_API_KEY")
    if not key:
        return DiscoveryResult(provider="deepinfra", error="DEEPINFRA_API_KEY not configured")
    try:
        models = await _openai_compat_models(
            "https://api.deepinfra.com",
            key,
            _provider_name="deepinfra",
        )
        return DiscoveryResult(provider="deepinfra", models=models)
    except Exception as exc:
        return DiscoveryResult(provider="deepinfra", error=str(exc)[:300])


async def _discover_groq() -> DiscoveryResult:
    key = await _read_api_key("GROQ_API_KEY")
    if not key:
        return DiscoveryResult(provider="groq", error="GROQ_API_KEY not configured")
    try:
        models = await _openai_compat_models(
            "https://api.groq.com/openai",
            key,
            _provider_name="groq",
        )
        return DiscoveryResult(provider="groq", models=models)
    except Exception as exc:
        return DiscoveryResult(provider="groq", error=str(exc)[:300])


async def _discover_together() -> DiscoveryResult:
    key = await _read_api_key("TOGETHER_API_KEY")
    if not key:
        return DiscoveryResult(provider="together", error="TOGETHER_API_KEY not configured")
    try:
        models = await _openai_compat_models(
            "https://api.together.xyz",
            key,
            _provider_name="together",
        )
        return DiscoveryResult(provider="together", models=models)
    except Exception as exc:
        return DiscoveryResult(provider="together", error=str(exc)[:300])


async def _discover_fireworks() -> DiscoveryResult:
    key = await _read_api_key("FIREWORKS_API_KEY")
    if not key:
        return DiscoveryResult(provider="fireworks", error="FIREWORKS_API_KEY not configured")
    try:
        models = await _openai_compat_models(
            "https://api.fireworks.ai/inference",
            key,
            _provider_name="fireworks",
        )
        return DiscoveryResult(provider="fireworks", models=models)
    except Exception as exc:
        return DiscoveryResult(provider="fireworks", error=str(exc)[:300])


async def _discover_openai() -> DiscoveryResult:
    key = await _read_api_key("OPENAI_API_KEY")
    if not key:
        return DiscoveryResult(provider="openai", error="OPENAI_API_KEY not configured")
    try:
        models = await _openai_compat_models(
            "https://api.openai.com",
            key,
            _provider_name="openai",
        )
        return DiscoveryResult(provider="openai", models=models)
    except Exception as exc:
        return DiscoveryResult(provider="openai", error=str(exc)[:300])


async def _discover_xai() -> DiscoveryResult:
    key = await _read_api_key("XAI_API_KEY")
    if not key:
        return DiscoveryResult(provider="xai", error="XAI_API_KEY not configured")
    try:
        models = await _openai_compat_models(
            "https://api.x.ai",
            key,
            _provider_name="xai",
        )
        return DiscoveryResult(provider="xai", models=models)
    except Exception as exc:
        return DiscoveryResult(provider="xai", error=str(exc)[:300])


async def _discover_mistral() -> DiscoveryResult:
    key = await _read_api_key("MISTRAL_API_KEY")
    if not key:
        return DiscoveryResult(provider="mistral", error="MISTRAL_API_KEY not configured")
    try:
        models = await _openai_compat_models(
            "https://api.mistral.ai",
            key,
            _provider_name="mistral",
        )
        return DiscoveryResult(provider="mistral", models=models)
    except Exception as exc:
        return DiscoveryResult(provider="mistral", error=str(exc)[:300])


async def _discover_anthropic() -> DiscoveryResult:
    key = await _read_api_key("ANTHROPIC_API_KEY")
    if not key:
        return DiscoveryResult(provider="anthropic", error="ANTHROPIC_API_KEY not configured")
    try:
        headers = {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        }
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get("https://api.anthropic.com/v1/models", headers=headers)
            resp.raise_for_status()
        raw = resp.json().get("data", [])
        models: list[DiscoveredModel] = []
        for m in raw:
            mid = m.get("id", "")
            if not mid:
                continue
            models.append(
                DiscoveredModel(
                    id=mid,
                    name=m.get("display_name", mid),
                    context_window=_safe_int(m.get("context_window")),
                    supports_tools=True,
                )
            )
        models.sort(key=lambda m: m.id)
        return DiscoveryResult(provider="anthropic", models=models)
    except Exception as exc:
        return DiscoveryResult(provider="anthropic", error=str(exc)[:300])


# Adapter registry
_ADAPTERS: dict[str, Any] = {
    "openrouter": _discover_openrouter,
    "deepinfra": _discover_deepinfra,
    "groq": _discover_groq,
    "together": _discover_together,
    "fireworks": _discover_fireworks,
    "openai": _discover_openai,
    "xai": _discover_xai,
    "mistral": _discover_mistral,
    "anthropic": _discover_anthropic,
}


# ---------------------------------------------------------------------------
# Simple in-memory cache (TTL-based)
# ---------------------------------------------------------------------------

import time

_cache: dict[str, tuple[float, DiscoveryResult]] = {}
_CACHE_TTL = 300  # 5 min


def _get_cached(provider: str) -> DiscoveryResult | None:
    entry = _cache.get(provider)
    if entry and (time.time() - entry[0]) < _CACHE_TTL:
        result = entry[1]
        result.cached = True
        return result
    return None


def _set_cached(provider: str, result: DiscoveryResult) -> None:
    _cache[provider] = (time.time(), result)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def discover_models(provider_key: str, *, bypass_cache: bool = False) -> DiscoveryResult:
    """Fetch the model list for a single provider."""
    if provider_key not in PROVIDER_CATALOG:
        return DiscoveryResult(provider=provider_key, error=f"Unknown provider: {provider_key}")

    adapter = _ADAPTERS.get(provider_key)
    if adapter is None:
        info = PROVIDER_CATALOG[provider_key]
        if info.is_local:
            return DiscoveryResult(
                provider=provider_key,
                error="Local providers (vLLM/KServe) do not support remote model discovery",
            )
        return DiscoveryResult(
            provider=provider_key,
            error=f"No discovery adapter for provider: {provider_key}",
        )

    if not bypass_cache:
        cached = _get_cached(provider_key)
        if cached is not None:
            return cached

    result = await adapter()
    if not result.error:
        _set_cached(provider_key, result)
    return result


def get_defaults_for_model(
    provider_key: str,
    model_id: str,
    context_window: int | None = None,
) -> ProviderDefaults:
    """Return recommended route defaults for a provider + model pair."""
    info = PROVIDER_CATALOG.get(provider_key)
    if not info:
        return ProviderDefaults()

    max_tok = 8192
    if context_window and context_window >= 128_000:
        max_tok = 16384
    elif context_window and context_window >= 32_000:
        max_tok = 8192

    notes_parts: list[str] = []
    supports_tools = False

    # Provider-specific heuristics
    if provider_key == "anthropic":
        supports_tools = True
        max_tok = 8192
        notes_parts.append("Anthropic models support tool use natively")
    elif provider_key == "openai":
        supports_tools = True
        notes_parts.append("OpenAI models support function/tool calling")
    elif provider_key == "xai":
        supports_tools = True

    return ProviderDefaults(
        max_tokens=max_tok,
        temperature=0.1,
        supports_streaming=True,
        supports_tools=supports_tools,
        context_window=context_window,
        notes="; ".join(notes_parts) if notes_parts else "",
    )


def validate_model_id(provider_key: str, model_id: str) -> dict:
    """Return validation hints for a typed model ID.

    Returns ``{"valid": True}`` or ``{"valid": False, "suggestion": "...", "reason": "..."}``.
    """
    if not model_id or not model_id.strip():
        return {"valid": False, "reason": "Model ID is empty"}

    info = PROVIDER_CATALOG.get(provider_key)
    if not info:
        return {"valid": True}

    prefix = info.route_prefix
    if prefix and model_id.startswith(prefix):
        return {
            "valid": False,
            "reason": f"Do not include the provider prefix '{prefix}' — it is added automatically",
            "suggestion": model_id[len(prefix) :],
        }

    return {"valid": True}


def supported_discovery_providers() -> list[str]:
    """Return provider keys that have a discovery adapter."""
    return sorted(_ADAPTERS.keys())


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (ValueError, TypeError):
        return None


def _safe_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None
