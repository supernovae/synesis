"""Pure validation rules for public model offerings (no DB imports)."""

from __future__ import annotations

import re

VALID_EFFORT_TIERS = frozenset({"pulse", "core", "horizon"})

ROUTE_VIA_CODER_ROLES = frozenset({"coder-pulse", "coder-core", "coder-horizon"})

VALID_CONNECTION_MODES = frozenset({"role_clone", "standalone"})

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
        "synesis-general-pulse",
        "synesis-general-core",
        "synesis-general-horizon",
        "synesis-auto",
        "router",
        "general",
        "critic",
        "coder-pulse",
        "coder-core",
        "coder-horizon",
        "coder-compaction",
        "coder-normalizer",
        "summarizer",
        "indexer-enrich",
        "general-pulse",
        "general-core",
        "general-horizon",
    }
)

CLIENT_ID_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9._/-]{0,127})$")


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


def effort_to_general_role(effort: str) -> str:
    return f"general-{validate_effort_tier(effort)}"
