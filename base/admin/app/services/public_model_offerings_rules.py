"""Pure validation rules for public model offerings (no DB imports)."""

from __future__ import annotations

import re

VALID_EFFORT_TIERS = frozenset({"pulse", "core", "horizon"})

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
        raise ValueError(
            "client_model_id must be 1–128 chars, start with alphanumeric, "
            "and contain only [a-z0-9._/-]"
        )
    if norm in RESERVED_CLIENT_MODEL_IDS:
        raise ValueError(f"client_model_id '{norm}' is reserved")
    return norm


def validate_effort_tier(tier: str) -> str:
    t = (tier or "").strip().lower()
    if t not in VALID_EFFORT_TIERS:
        raise ValueError(f"effort_tier must be one of: {', '.join(sorted(VALID_EFFORT_TIERS))}")
    return t


def effort_to_coder_role(effort: str) -> str:
    return f"coder-{validate_effort_tier(effort)}"


def effort_to_general_role(effort: str) -> str:
    return f"general-{validate_effort_tier(effort)}"
