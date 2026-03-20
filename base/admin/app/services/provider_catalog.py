"""Provider catalog — single source of truth for supported LLM providers.

Both the backend (role assignment, LiteLLM param building) and the frontend
(provider picklist, API key status) consume this catalog via
GET /api/v1/providers/catalog.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True, slots=True)
class ProviderInfo:
    key: str
    label: str
    litellm_prefix: str
    api_key_env: str
    needs_endpoint: bool
    placeholder: str
    is_local: bool = False


PROVIDER_CATALOG: dict[str, ProviderInfo] = {p.key: p for p in [
    ProviderInfo("vllm", "Local vLLM", "openai/", "", True, "synesis-router", is_local=True),
    ProviderInfo("kserve", "OpenShift AI (KServe)", "openai/", "", True, "synesis-router", is_local=True),
    ProviderInfo("openrouter", "OpenRouter", "openrouter/", "OPENROUTER_API_KEY", False, "x-ai/grok-4-fast"),
    ProviderInfo("groq", "Groq", "groq/", "GROQ_API_KEY", False, "llama-3.3-70b-versatile"),
    ProviderInfo("deepinfra", "DeepInfra", "deepinfra/", "DEEPINFRA_API_KEY", False, "meta-llama/Meta-Llama-3.1-70B"),
    ProviderInfo("together", "Together AI", "together_ai/", "TOGETHER_API_KEY", False, "meta-llama/Llama-3-70b"),
    ProviderInfo("fireworks", "Fireworks AI", "fireworks_ai/", "FIREWORKS_API_KEY", False, "llama-v3p1-70b-instruct"),
    ProviderInfo("openai", "OpenAI", "openai/", "OPENAI_API_KEY", False, "gpt-4o"),
    ProviderInfo("anthropic", "Anthropic", "anthropic/", "ANTHROPIC_API_KEY", False, "claude-sonnet-4-20250514"),
    ProviderInfo("mistral", "Mistral AI", "mistral/", "MISTRAL_API_KEY", False, "mistral-large-latest"),
    ProviderInfo("azure", "Azure OpenAI", "azure/", "AZURE_API_KEY", True, "gpt-4o"),
    ProviderInfo("custom", "Custom OpenAI-compatible", "openai/", "", True, "model-name"),
]}

KNOWN_ROLES = ("router", "general", "critic", "coder", "summarizer")

ROLE_DESCRIPTIONS = {
    "router": "Fast classification, planner, advisor",
    "general": "Writer synthesis, general reasoning",
    "critic": "Deep reasoning critic",
    "coder": "IDE direct endpoint (Cursor, Claude Code)",
    "summarizer": "Pivot history summarization",
}


def get_catalog() -> dict:
    """Return catalog payload for GET /providers/catalog."""
    return {
        "providers": {k: asdict(v) for k, v in PROVIDER_CATALOG.items()},
        "roles": [
            {"key": r, "served_name": f"synesis-{r}", "description": ROLE_DESCRIPTIONS.get(r, "")}
            for r in KNOWN_ROLES
        ],
    }


def build_litellm_params(
    provider: str,
    model: str,
    endpoint: str = "",
    api_key_env: str = "",
    *,
    max_tokens: int = 8192,
    temperature: float = 0.1,
) -> dict:
    """Construct the litellm_params dict for a deployment."""
    info = PROVIDER_CATALOG.get(provider, PROVIDER_CATALOG["custom"])
    params: dict = {
        "model": f"{info.litellm_prefix}{model}",
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    key_env = api_key_env or info.api_key_env
    if key_env:
        params["api_key"] = f"os.environ/{key_env}"
    elif info.needs_endpoint:
        params["api_key"] = "not-needed"
    if info.needs_endpoint and endpoint:
        params["api_base"] = endpoint
    return params
