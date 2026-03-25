"""Model tier registry — three-tier abstraction for Yarn coder models.

Tiers are the only model routing mechanism. Each tier maps a stable
client-facing model ID (synesis-pulse, synesis-core, synesis-horizon)
to a backend model + endpoint + API key + cost rates.

The TierRegistry can be built from admin API responses (authoritative)
or from env-var config (fallback for local dev / admin-down).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("yarn.model.tiers")

TIER_PULSE = "synesis-pulse"
TIER_CORE = "synesis-core"
TIER_HORIZON = "synesis-horizon"
TIER_NAMES = (TIER_PULSE, TIER_CORE, TIER_HORIZON)

ROLE_TO_TIER: dict[str, str] = {
    "coder-pulse": TIER_PULSE,
    "coder-core": TIER_CORE,
    "coder-horizon": TIER_HORIZON,
}

_DEFAULT_CLAUDE_FAMILY_MAP: dict[str, str] = {
    "haiku": TIER_PULSE,
    "sonnet": TIER_CORE,
    "opus": TIER_HORIZON,
}

_TIER_DISPLAY: dict[str, tuple[str, str]] = {
    TIER_PULSE: ("Synesis Pulse", "Fast coder — lightweight completions, refactors, tab-complete"),
    TIER_CORE: ("Synesis Core", "Balanced coder — multi-step agentic tasks, default for IDE sessions"),
    TIER_HORIZON: ("Synesis Horizon", "Deep reasoning coder — architecture decisions, complex debugging"),
}

_PROVIDER_DEFAULT_BASE_URLS: dict[str, str] = {
    "openrouter": "https://openrouter.ai/api/v1",
    "deepinfra": "https://api.deepinfra.com/v1/openai",
}


@dataclass
class ModelTier:
    name: str
    display_name: str
    description: str
    backend_model: str
    base_url: str
    api_key: str
    input_per_m: float = 0.0
    output_per_m: float = 0.0
    cached_per_m: float = 0.0


class TierRegistry:
    """Immutable tier catalog. Built once, swapped atomically on config change."""

    def __init__(
        self,
        tiers: dict[str, ModelTier],
        default_tier: str,
        claude_family_map: dict[str, str] | None = None,
    ) -> None:
        self._tiers = dict(tiers)
        self._default = default_tier
        self._claude_family = dict(claude_family_map or _DEFAULT_CLAUDE_FAMILY_MAP)

    def resolve(self, model_id: str) -> ModelTier:
        """Resolve a client model ID to a tier. Raises ValueError for unknown IDs."""
        tier = self._tiers.get(model_id)
        if tier is not None:
            return tier
        raise ValueError(
            f"Unknown model: {model_id!r}. Available: {', '.join(self.available_ids)}"
        )

    def resolve_claude(self, model_id: str) -> ModelTier:
        """Resolve a Claude model ID by family pattern, then by direct lookup.

        Matches substrings: 'claude-3-5-haiku-20241022' contains 'haiku' -> Pulse.
        Falls back to the default tier if no family matches.
        """
        model_lower = model_id.lower()
        for family, tier_name in self._claude_family.items():
            if family in model_lower:
                tier = self._tiers.get(tier_name)
                if tier is not None:
                    return tier
        if model_id in self._tiers:
            return self._tiers[model_id]
        default = self._tiers.get(self._default)
        if default is not None:
            logger.warning(
                "claude_model_unmapped model=%s defaulting_to=%s", model_id, self._default
            )
            return default
        raise ValueError(
            f"Cannot resolve Claude model {model_id!r} and no default tier configured. "
            f"Available: {', '.join(self.available_ids)}"
        )

    @property
    def default(self) -> ModelTier:
        return self._tiers[self._default]

    @property
    def available_ids(self) -> list[str]:
        return list(self._tiers.keys())

    def list_models(self) -> dict[str, Any]:
        """OpenAI-compatible /v1/models response payload."""
        data = []
        for name in TIER_NAMES:
            tier = self._tiers.get(name)
            if tier is None:
                continue
            data.append(
                {
                    "id": tier.name,
                    "object": "model",
                    "created": 1704067200,
                    "owned_by": "synesis",
                    "description": tier.description,
                }
            )
        return {"object": "list", "data": data}

    @classmethod
    def from_admin_response(
        cls,
        roles: list[dict[str, Any]],
        costs: list[dict[str, Any]],
        *,
        fallback_url: str = "",
        fallback_key: str = "",
        default_tier: str = TIER_CORE,
        claude_family_overrides: dict[str, str] | None = None,
    ) -> TierRegistry:
        """Build registry from admin ``GET /api/v1/models/roles`` + ``GET /api/v1/models/costs/active``."""
        cost_by_role: dict[str, dict[str, Any]] = {}
        for c in costs:
            r = c.get("role", "")
            if r in ROLE_TO_TIER:
                cost_by_role[r] = c

        tiers: dict[str, ModelTier] = {}
        for assignment in roles:
            role = assignment.get("role", "")
            tier_name = ROLE_TO_TIER.get(role)
            if tier_name is None:
                continue
            if not assignment.get("assigned"):
                continue

            display, desc = _TIER_DISPLAY.get(tier_name, (tier_name, ""))
            provider = str(assignment.get("provider", "") or "").strip().lower()
            lp = assignment.get("litellm_params") if isinstance(assignment.get("litellm_params"), dict) else {}
            endpoint = (
                str(assignment.get("endpoint", "") or "").strip()
                or str(lp.get("api_base", "") or "").strip()
                or _PROVIDER_DEFAULT_BASE_URLS.get(provider, "")
                or fallback_url
            )
            api_key_env = str(assignment.get("api_key_env", "") or "").strip()
            api_key = os.environ.get(api_key_env, "").strip() if api_key_env else ""
            if not api_key:
                api_key = fallback_key
            cost_info = cost_by_role.get(role, {})

            tiers[tier_name] = ModelTier(
                name=tier_name,
                display_name=display,
                description=desc,
                backend_model=assignment.get("model", ""),
                base_url=endpoint,
                api_key=api_key,
                input_per_m=cost_info.get("input_per_million", 0.0),
                output_per_m=cost_info.get("output_per_million", 0.0),
                cached_per_m=cost_info.get("input_cached_per_million") or 0.0,
            )

        claude_map = dict(_DEFAULT_CLAUDE_FAMILY_MAP)
        if claude_family_overrides:
            claude_map.update(claude_family_overrides)

        return cls(tiers, default_tier, claude_map)

    @classmethod
    def from_env(cls, settings: Any, *, claude_family_overrides: dict[str, str] | None = None) -> TierRegistry:
        """Build registry from Pydantic settings (env-var fallback)."""
        fallback_url = settings.effective_base_url
        fallback_key = settings.effective_api_key

        tiers: dict[str, ModelTier] = {}
        tier_specs = [
            (TIER_PULSE, "pulse", settings.pulse_model, settings.pulse_url, settings.pulse_api_key),
            (TIER_CORE, "core", settings.core_model, settings.core_url, settings.core_api_key),
            (TIER_HORIZON, "horizon", settings.horizon_model, settings.horizon_url, settings.horizon_api_key),
        ]
        for tier_name, _short, model, url, key in tier_specs:
            if not model:
                continue
            display, desc = _TIER_DISPLAY.get(tier_name, (tier_name, ""))
            tiers[tier_name] = ModelTier(
                name=tier_name,
                display_name=display,
                description=desc,
                backend_model=model,
                base_url=url or fallback_url,
                api_key=key or fallback_key,
            )

        claude_map = dict(_DEFAULT_CLAUDE_FAMILY_MAP)
        if claude_family_overrides:
            claude_map.update(claude_family_overrides)

        return cls(tiers, settings.default_tier, claude_map)
