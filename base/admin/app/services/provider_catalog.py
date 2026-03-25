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


PROVIDER_CATALOG: dict[str, ProviderInfo] = {
    p.key: p
    for p in [
        ProviderInfo("vllm", "Local vLLM", "openai/", "", True, "synesis-router", is_local=True),
        ProviderInfo("kserve", "OpenShift AI (KServe)", "openai/", "", True, "synesis-router", is_local=True),
        ProviderInfo("openrouter", "OpenRouter", "openrouter/", "OPENROUTER_API_KEY", False, "x-ai/grok-4-fast"),
        ProviderInfo("xai", "xAI (Grok)", "xai/", "XAI_API_KEY", False, "grok-4-0709"),
        ProviderInfo("groq", "Groq", "groq/", "GROQ_API_KEY", False, "llama-3.3-70b-versatile"),
        ProviderInfo(
            "deepinfra", "DeepInfra", "deepinfra/", "DEEPINFRA_API_KEY", False, "meta-llama/Meta-Llama-3.1-70B"
        ),
        ProviderInfo("together", "Together AI", "together_ai/", "TOGETHER_API_KEY", False, "meta-llama/Llama-3-70b"),
        ProviderInfo(
            "fireworks", "Fireworks AI", "fireworks_ai/", "FIREWORKS_API_KEY", False, "llama-v3p1-70b-instruct"
        ),
        ProviderInfo("openai", "OpenAI", "openai/", "OPENAI_API_KEY", False, "gpt-4o"),
        ProviderInfo("anthropic", "Anthropic", "anthropic/", "ANTHROPIC_API_KEY", False, "claude-sonnet-4-20250514"),
        ProviderInfo("mistral", "Mistral AI", "mistral/", "MISTRAL_API_KEY", False, "mistral-large-latest"),
        ProviderInfo("azure", "Azure OpenAI", "azure/", "AZURE_API_KEY", True, "gpt-4o"),
        ProviderInfo("custom", "Custom OpenAI-compatible", "openai/", "", True, "model-name"),
    ]
}

PROVIDER_DEFAULT_ENDPOINTS: dict[str, str] = {
    # OpenAI-compatible base URLs used when a role assignment omits endpoint.
    "openrouter": "https://openrouter.ai/api/v1",
    "deepinfra": "https://api.deepinfra.com/v1/openai",
}

KNOWN_ROLES = (
    "router",
    "general",
    "general-pulse",
    "general-core",
    "general-horizon",
    "critic",
    "coder-pulse",
    "coder-core",
    "coder-horizon",
    "summarizer",
)

ROLE_DESCRIPTIONS = {
    "router": "Fast LLM — entry_pipeline, planner, plan_gate, router nodes",
    "general": "Writer + final_scrubber — general reasoning & synthesis",
    "general-pulse": "Front-end fast effort tier — lightweight synthesis and lower-latency responses",
    "general-core": "Front-end balanced effort tier — default quality/cost trade-off",
    "general-horizon": "Front-end deep effort tier — broad synthesis and deeper reasoning",
    "critic": "Deep reasoning — critic node evaluates drafts",
    "coder-pulse": "Fast coder tier — lightweight completions, refactors, tab-complete (maps to Claude Haiku class)",
    "coder-core": "Balanced coder tier — multi-step agentic tasks, default for IDE sessions (maps to Claude Sonnet class)",
    "coder-horizon": "Deep reasoning coder tier — architecture decisions, complex debugging (maps to Claude Opus class)",
    "summarizer": "Pivot history summarization — router evidence compression",
}

ROLE_SERVED_NAMES = {
    "general-pulse": "synesis-general-pulse",
    "general-core": "synesis-general-core",
    "general-horizon": "synesis-general-horizon",
    "coder-pulse": "synesis-pulse",
    "coder-core": "synesis-core",
    "coder-horizon": "synesis-horizon",
}


_DISCOVERY_PROVIDERS = frozenset(
    [
        "openrouter",
        "deepinfra",
        "groq",
        "together",
        "fireworks",
        "openai",
        "xai",
        "mistral",
        "anthropic",
    ]
)


def get_catalog() -> dict:
    """Return catalog payload for GET /providers/catalog."""
    providers_out: dict[str, dict] = {}
    for k, v in PROVIDER_CATALOG.items():
        d = asdict(v)
        d["supports_discovery"] = k in _DISCOVERY_PROVIDERS
        providers_out[k] = d
    return {
        "providers": providers_out,
        "roles": [
            {
                "key": r,
                "served_name": ROLE_SERVED_NAMES.get(r, f"synesis-{r}"),
                "description": ROLE_DESCRIPTIONS.get(r, ""),
            }
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


def default_endpoint_for_provider(provider: str) -> str:
    """Return the canonical OpenAI-compatible base URL for known providers."""
    return PROVIDER_DEFAULT_ENDPOINTS.get((provider or "").strip().lower(), "")
