"""Pure validation rules for public model offerings (no DB imports)."""

from __future__ import annotations

import re
from typing import Any

VALID_EFFORT_TIERS = frozenset({"pulse", "core", "horizon"})

ROUTE_VIA_CODER_ROLES = frozenset({"coder-pulse", "coder-core", "coder-horizon"})

VALID_CONNECTION_MODES = frozenset({"role_clone", "standalone"})

GENERATION_PARAM_KEYS = {
    "max_tokens",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "presence_penalty",
    "repetition_penalty",
    "enable_thinking",
    "reasoning_effort",
}

RESERVED_CLIENT_MODEL_IDS = frozenset(
    {
        "auto",
        "pulse",
        "core",
        "horizon",
        "compaction",
        "synesis",
        "synesis-pulse",
        "synesis-core",
        "synesis-horizon",
        "synesis-compaction",
        "synesis-planner",
        "synesis-writer",
        "synesis-writer-pulse",
        "synesis-writer-core",
        "synesis-writer-horizon",
        "synesis-ambiguity-scorer",
        "synesis-auto",
        "router",
        "planner",
        "writer",
        "critic",
        "ambiguity-scorer",
        "coder-pulse",
        "coder-core",
        "coder-horizon",
        "coder-compaction",
        "coder-normalizer",
        "summarizer",
        "indexer-enrich",
    }
)

CLIENT_ID_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9._/-]{0,127})$")

DEFAULT_PUBLIC_OFFERINGS: tuple[dict[str, Any], ...] = (
    {
        "client_model_id": "deepseek-v4-flash",
        "label": "DeepSeek V4 Flash",
        "effort_tier": "pulse",
        "connection_mode": "standalone",
        "standalone_provider": "deepseek",
        "standalone_endpoint": "https://api.deepseek.com",
        "standalone_api_key_env": "DEEPSEEK_API_KEY",
        "backend_model_override": "deepseek-v4-flash",
        "generation_params": {"max_tokens": 8192, "temperature": 0.3, "top_p": 0.95},
        "expose_planner": True,
        "expose_yarn": True,
    },
    {
        "client_model_id": "deepseek-v4-pro",
        "label": "DeepSeek V4 Pro",
        "effort_tier": "horizon",
        "connection_mode": "standalone",
        "standalone_provider": "deepseek",
        "standalone_endpoint": "https://api.deepseek.com",
        "standalone_api_key_env": "DEEPSEEK_API_KEY",
        "backend_model_override": "deepseek-v4-pro",
        "generation_params": {"max_tokens": 32768, "temperature": 0.3, "top_p": 0.95},
        "expose_planner": True,
        "expose_yarn": True,
    },
    {
        "client_model_id": "mimo-v2.5-pro",
        "label": "Xiaomi MiMo V2.5 Pro",
        "effort_tier": "horizon",
        "connection_mode": "standalone",
        "standalone_provider": "xiaomi",
        "standalone_endpoint": "https://api.xiaomimimo.com/v1",
        "standalone_api_key_env": "MIMO_API_KEY",
        "backend_model_override": "mimo-v2.5-pro",
        "generation_params": {"max_tokens": 32768, "temperature": 1.0, "top_p": 0.95},
        "expose_planner": True,
        "expose_yarn": True,
    },
    {
        "client_model_id": "mimo-v2.5",
        "label": "Xiaomi MiMo V2.5",
        "effort_tier": "core",
        "connection_mode": "standalone",
        "standalone_provider": "xiaomi",
        "standalone_endpoint": "https://api.xiaomimimo.com/v1",
        "standalone_api_key_env": "MIMO_API_KEY",
        "backend_model_override": "mimo-v2.5",
        "generation_params": {"max_tokens": 16384, "temperature": 1.0, "top_p": 0.95},
        "expose_planner": True,
        "expose_yarn": True,
    },
    {
        "client_model_id": "mimo-v2-flash",
        "label": "Xiaomi MiMo V2 Flash",
        "effort_tier": "pulse",
        "connection_mode": "standalone",
        "standalone_provider": "xiaomi",
        "standalone_endpoint": "https://api.xiaomimimo.com/v1",
        "standalone_api_key_env": "MIMO_API_KEY",
        "backend_model_override": "mimo-v2-flash",
        "generation_params": {"max_tokens": 8192, "temperature": 0.3, "top_p": 0.95},
        "expose_planner": True,
        "expose_yarn": True,
    },
)


def normalize_client_model_id(raw: str) -> str:
    return (raw or "").strip().lower()


def validate_client_model_id(client_model_id: str) -> str:
    norm = normalize_client_model_id(client_model_id)
    if not norm:
        raise ValueError("client_model_id is required")
    if not CLIENT_ID_PATTERN.match(norm):
        raise ValueError("client_model_id must be 1-128 chars, start with alphanumeric, and contain only [a-z0-9._/-]")
    if norm in RESERVED_CLIENT_MODEL_IDS:
        raise ValueError(f"client_model_id '{norm}' is reserved")
    return norm


def validate_effort_tier(tier: str) -> str:
    t = (tier or "").strip().lower()
    if t not in VALID_EFFORT_TIERS:
        raise ValueError(f"effort_tier must be one of: {', '.join(sorted(VALID_EFFORT_TIERS))}")
    return t


def validate_route_via_role(role: str) -> str:
    r = (role or "").strip().lower()
    if r not in ROUTE_VIA_CODER_ROLES:
        raise ValueError(
            "route_via_role must be one of: coder-pulse, coder-core, coder-horizon "
            "(which coder deployment supplies base URL and API keys)"
        )
    return r


def validate_connection_mode(mode: str) -> str:
    m = (mode or "").strip().lower()
    if m not in VALID_CONNECTION_MODES:
        raise ValueError("connection_mode must be one of: role_clone, standalone")
    return m


def normalize_generation_params(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("generation_params must be an object")
    out: dict[str, Any] = {}
    for key, raw in value.items():
        if key not in GENERATION_PARAM_KEYS:
            continue
        if raw is None or raw == "":
            continue
        if key == "enable_thinking":
            if not isinstance(raw, bool):
                raise ValueError("generation_params.enable_thinking must be boolean")
            out[key] = raw
            continue
        if key == "reasoning_effort":
            effort = str(raw).strip()
            if effort:
                out[key] = effort
            continue
        try:
            num = float(raw)
        except (TypeError, ValueError):
            raise ValueError(f"generation_params.{key} must be finite") from None
        if not (num == num and num not in (float("inf"), float("-inf"))):
            raise ValueError(f"generation_params.{key} must be finite")
        if key in {"max_tokens", "top_k"}:
            if num < 0 or int(num) != num:
                raise ValueError(f"generation_params.{key} must be a non-negative integer")
            out[key] = int(num)
        else:
            out[key] = num
    return out or None


def normalize_route_and_effort(
    effort_tier: str | None,
    route_via_role: str | None,
) -> tuple[str, str]:
    """Return (effort_tier, route_via_role) both set and consistent."""
    r_raw = (route_via_role or "").strip().lower() or None
    e_raw = (effort_tier or "").strip().lower() or None
    if r_raw:
        r = validate_route_via_role(r_raw)
        e = r.removeprefix("coder-")
        if e not in VALID_EFFORT_TIERS:
            raise ValueError("invalid route_via_role suffix")
        return e, r
    if e_raw:
        e = validate_effort_tier(e_raw)
        return e, f"coder-{e}"
    raise ValueError(
        "Set route_via_role (coder-pulse, coder-core, coder-horizon) or effort_tier (pulse, core, horizon)"
    )


def normalize_offering_connection(
    *,
    effort_tier: str | None,
    route_via_role: str | None,
    connection_mode: str | None,
    standalone_provider: str | None,
    standalone_endpoint: str | None,
    standalone_api_key_env: str | None,
    expose_yarn: bool,
) -> tuple[str, str | None, str, str | None, str | None, str | None]:
    """Normalize public-offering routing fields.

    Returns:
      (effort_tier, route_via_role, connection_mode,
       standalone_provider, standalone_endpoint, standalone_api_key_env)
    """
    mode = validate_connection_mode(connection_mode or "role_clone")
    provider = (standalone_provider or "").strip().lower() or None
    endpoint = (standalone_endpoint or "").strip() or None
    api_key_env = (standalone_api_key_env or "").strip() or None

    if mode == "role_clone":
        effort, route = normalize_route_and_effort(effort_tier, route_via_role)
        return effort, route, mode, None, None, None

    # standalone
    if effort_tier:
        effort = validate_effort_tier(effort_tier)
    elif route_via_role:
        route = validate_route_via_role(route_via_role)
        effort = route.removeprefix("coder-")
        if effort not in VALID_EFFORT_TIERS:
            raise ValueError("invalid route_via_role suffix")
    else:
        raise ValueError("effort_tier is required for standalone connection_mode")

    if expose_yarn:
        missing: list[str] = []
        if not provider:
            missing.append("standalone_provider")
        if not endpoint:
            missing.append("standalone_endpoint")
        if not api_key_env:
            missing.append("standalone_api_key_env")
        if missing:
            raise ValueError("standalone offerings exposed to yarn require: " + ", ".join(missing))

    return effort, None, mode, provider, endpoint, api_key_env


def effort_to_coder_role(effort: str) -> str:
    return f"coder-{validate_effort_tier(effort)}"


def effort_to_writer_role(effort: str) -> str:
    return f"writer-{validate_effort_tier(effort)}"
