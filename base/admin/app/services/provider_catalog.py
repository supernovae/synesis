"""Provider catalog — static defaults for built-in LLM providers.

Canonical routing for a role merges, in order:

1. **This module** — built-in defaults: route prefix, ``api_key_env``,
   ``needs_endpoint``, default base URLs in ``PROVIDER_DEFAULT_ENDPOINTS``.
2. **ProviderConfig** (Postgres) — per-provider overrides: ``default_endpoint``,
   ``api_key_env``, provider prefix (required for custom providers), enablement,
   policies. Loaded via ``load_provider_governance_maps()`` in ``model_registry``.
3. **ModelDeployment** — per-role binding: ``provider``, ``model``, optional
   ``endpoint`` / ``api_key_env`` overrides, and route parameters used for
   generation defaults (for example ``max_tokens``, ``temperature``, ``top_p``)
   when not supplied on assign.

Runtime routing and JSON APIs both use ``resolve_deployment_routing_for_deployment()``
so stored route parameters cannot drift from governance after a provider key or
prefix change.

The admin SPA merges catalog + governance in ``GET /api/v1/provider-governance``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True, slots=True)
class ProviderInfo:
    key: str
    label: str
    route_prefix: str
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
        ProviderInfo("xai", "xAI (Grok)", "xai/", "XAI_API_KEY", True, "grok-4-0709"),
        ProviderInfo("groq", "Groq", "groq/", "GROQ_API_KEY", False, "llama-3.3-70b-versatile"),
        ProviderInfo(
            "deepinfra", "DeepInfra", "deepinfra/", "DEEPINFRA_API_KEY", False, "meta-llama/Meta-Llama-3.1-70B"
        ),
        ProviderInfo("deepseek", "DeepSeek", "openai/", "DEEPSEEK_API_KEY", True, "deepseek-v4-flash"),
        ProviderInfo("xiaomi", "Xiaomi MiMo", "openai/", "MIMO_API_KEY", True, "mimo-v2.5-pro"),
        ProviderInfo(
            "dashscope",
            "DashScope (Alibaba Cloud, intl)",
            "openai/",
            "DASHSCOPE_API_KEY",
            True,
            "qwen3-coder-next",
        ),
        ProviderInfo(
            "dashscope-us",
            "DashScope (Alibaba Cloud, US)",
            "openai/",
            "DASHSCOPE_API_KEY",
            True,
            "qwen3-coder-next",
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
    "deepseek": "https://api.deepseek.com",
    "xiaomi": "https://api.xiaomimimo.com/v1",
    "xai": "https://api.x.ai/v1",
    "dashscope": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "dashscope-us": "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
}

KNOWN_ROLES = (
    "router",
    "planner",
    "writer",
    "writer-pulse",
    "writer-core",
    "writer-horizon",
    "ambiguity-scorer",
    "critic",
    "coder-pulse",
    "coder-core",
    "coder-horizon",
    "coder-compaction",
    "coder-normalizer",
    "summarizer",
    "indexer-enrich",
    "vision",
)

ROLE_DESCRIPTIONS = {
    "router": "Fast routing classifier — selects path, retrieval need, and effort without drafting the final answer",
    "planner": "Structured task planner — produces JSON plans/open questions before retrieval and writing",
    "writer": "Final answer writer — composes user-facing responses from plan, evidence, and conversation context",
    "writer-pulse": "Writer fast effort tier — lightweight synthesis and lower-latency responses",
    "writer-core": "Writer balanced effort tier — default quality/cost trade-off",
    "writer-horizon": "Writer deep effort tier — broad synthesis and deeper reasoning",
    "ambiguity-scorer": "Clarification scorer — cheap pre-plan ambiguity and follow-up question detection",
    "critic": "Critic verifier — evaluates drafts and evidence after writing; should only use the critic route",
    "coder-pulse": "Fast coder tier — lightweight completions, refactors, tab-complete (maps to Claude Haiku class)",
    "coder-core": "Balanced coder tier — multi-step agentic tasks, default for IDE sessions (maps to Claude Sonnet class)",
    "coder-horizon": "Deep reasoning coder tier — architecture decisions, complex debugging (maps to Claude Opus class)",
    "coder-compaction": "Context compaction — small fast model for sawtooth trajectory summarization in Yarn coder sessions",
    "coder-normalizer": "Validation normalizer Tier C — fast small model for structured extraction fallback when deterministic parsers miss",
    "summarizer": "Pivot history summarization — router evidence compression",
    "indexer-enrich": "Indexer chunk enrichment — small model for structured metadata extraction during corpus ingestion",
    "vision": "Multimodal model — UI verification, screenshot analysis, and visual debugging",
}

ROLE_SERVED_NAMES = {
    "router": "synesis-router",
    "planner": "synesis-planner",
    "writer": "synesis-writer",
    "writer-pulse": "synesis-writer-pulse",
    "writer-core": "synesis-writer-core",
    "writer-horizon": "synesis-writer-horizon",
    "ambiguity-scorer": "synesis-ambiguity-scorer",
    "critic": "synesis-critic",
    "coder-pulse": "synesis-pulse",
    "coder-core": "synesis-core",
    "coder-horizon": "synesis-horizon",
    "coder-compaction": "synesis-compaction",
    "coder-normalizer": "synesis-normalizer",
    "vision": "synesis-vision",
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


def build_route_params(
    provider: str,
    model: str,
    endpoint: str = "",
    api_key_env: str = "",
    *,
    max_tokens: int = 8192,
    temperature: float = 0.1,
    top_p: float | None = None,
    top_k: int | None = None,
    min_p: float | None = None,
    presence_penalty: float | None = None,
    repetition_penalty: float | None = None,
    enable_thinking: bool | None = None,
    reasoning_effort: str | None = None,
    model_capability_preset: str | None = None,
    route_prefix_override: str = "",
) -> dict:
    """Construct the direct-provider route params dict for a deployment.

    ``route_prefix_override`` comes from ProviderConfig (custom providers);
    when empty, the static catalog prefix is used.
    """
    info = PROVIDER_CATALOG.get(provider, PROVIDER_CATALOG["custom"])
    prefix = (route_prefix_override or "").strip() or info.route_prefix
    params: dict = {
        "model": f"{prefix}{model}",
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if top_p is not None:
        params["top_p"] = top_p
    if top_k is not None:
        params["top_k"] = top_k
    if min_p is not None:
        params["min_p"] = min_p
    if presence_penalty is not None:
        params["presence_penalty"] = presence_penalty
    if repetition_penalty is not None:
        params["repetition_penalty"] = repetition_penalty
    if enable_thinking is not None:
        params["enable_thinking"] = enable_thinking
    if reasoning_effort:
        params["reasoning_effort"] = reasoning_effort
    if model_capability_preset:
        params["model_capability_preset"] = model_capability_preset
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
