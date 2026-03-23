"""Conditional model selection — resolve a physical LiteLLM model name per role.

A ModelPolicy is a list of ordered rules per role. Each rule has a condition
(difficulty threshold, account tier, etc.) and a target LiteLLM model name.
First matching rule wins; the last rule should be unconditional (``always``).

When no policy exists for a role, the module falls back to the static
``settings.*_model_name`` / ``settings.*_model_url`` values.

Policy source priority:
  1. Admin DB  (``model_policies`` table, TTL-cached)
  2. Env var   (``SYNESIS_{ROLE}_MODEL_POLICY`` JSON list)
  3. Static    (``settings.*_model_name``)
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from .config import settings

logger = logging.getLogger("synesis.model_policy")

# Condition type constants — extensible via new evaluators in _CONDITION_EVALUATORS.
COND_DIFFICULTY_LT = "difficulty_lt"
COND_DIFFICULTY_GTE = "difficulty_gte"
COND_ACCOUNT_TIER = "account_tier"
COND_USER_PREFERENCE = "user_preference"
COND_ALWAYS = "always"

CONDITION_TYPES = (
    COND_DIFFICULTY_LT,
    COND_DIFFICULTY_GTE,
    COND_ACCOUNT_TIER,
    COND_USER_PREFERENCE,
    COND_ALWAYS,
)


@dataclass(frozen=True)
class PolicyRule:
    """One conditional model selection rule."""

    condition_type: str
    condition_value: str = ""
    model: str = ""
    label: str = ""
    priority: int = 0


@dataclass
class ModelContext:
    """Runtime context evaluated against policy rules."""

    difficulty: float = 0.5
    account_tier: str = "standard"
    user_preference: str | None = None


@dataclass
class PolicyResolution:
    """Result of resolving a model policy — useful for tracing."""

    model_name: str
    base_url: str
    role: str
    matched_rule: PolicyRule | None = None
    source: str = "static"  # "policy", "env", "static"


# ---------------------------------------------------------------------------
# Role → settings attribute mapping
# ---------------------------------------------------------------------------

_ROLE_SETTINGS_MAP: dict[str, tuple[str, str, str]] = {
    "router": ("router_model_name", "router_model_url", "router_model_uds"),
    "general": ("general_model_name", "general_model_url", "general_model_uds"),
    "critic": ("critic_model_name", "critic_model_url", "critic_model_uds"),
    "summarizer": ("summarizer_model_name", "summarizer_model_url", ""),
}

# Planner/advisor/writer share the role's physical endpoint.
_ROLE_ALIASES: dict[str, str] = {
    "planner": "router",
    "advisor": "router",
    "writer": "general",
}


def _static_defaults(role: str) -> tuple[str, str]:
    """Return (model_name, base_url) from settings for a role."""
    canonical = _ROLE_ALIASES.get(role, role)
    name_attr, url_attr, _ = _ROLE_SETTINGS_MAP.get(canonical, ("", "", ""))
    if not name_attr:
        return "", ""
    model_name = getattr(settings, name_attr, "") or ""
    base_url = getattr(settings, url_attr, "") or ""
    if canonical == "general" and role == "writer":
        model_name = (settings.writer_model_name or model_name)
        base_url = (settings.writer_model_url or base_url)
    return model_name, base_url


# ---------------------------------------------------------------------------
# Condition evaluators
# ---------------------------------------------------------------------------

def _eval_difficulty_lt(value: str, ctx: ModelContext) -> bool:
    try:
        return ctx.difficulty < float(value)
    except (ValueError, TypeError):
        return False


def _eval_difficulty_gte(value: str, ctx: ModelContext) -> bool:
    try:
        return ctx.difficulty >= float(value)
    except (ValueError, TypeError):
        return False


def _eval_account_tier(value: str, ctx: ModelContext) -> bool:
    return ctx.account_tier.lower() == value.lower()


def _eval_user_preference(value: str, ctx: ModelContext) -> bool:
    return ctx.user_preference is not None and ctx.user_preference != ""


def _eval_always(_value: str, _ctx: ModelContext) -> bool:
    return True


_CONDITION_EVALUATORS: dict[str, Any] = {
    COND_DIFFICULTY_LT: _eval_difficulty_lt,
    COND_DIFFICULTY_GTE: _eval_difficulty_gte,
    COND_ACCOUNT_TIER: _eval_account_tier,
    COND_USER_PREFERENCE: _eval_user_preference,
    COND_ALWAYS: _eval_always,
}


# ---------------------------------------------------------------------------
# Policy loading (env var → DB in later iteration)
# ---------------------------------------------------------------------------

_policies_cache: dict[str, list[PolicyRule]] = {}
_cache_lock = threading.Lock()
_cache_loaded_at: float = 0.0
_CACHE_TTL_SECONDS = 300.0


def _parse_env_policy(role: str) -> list[PolicyRule] | None:
    """Parse SYNESIS_{ROLE}_MODEL_POLICY env var (JSON list of rules)."""
    env_key = f"SYNESIS_{role.upper()}_MODEL_POLICY"
    raw = os.environ.get(env_key, "").strip()
    if not raw:
        return None
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Invalid JSON in %s, ignoring", env_key)
        return None
    if not isinstance(items, list):
        logger.warning("%s must be a JSON array, ignoring", env_key)
        return None
    rules: list[PolicyRule] = []
    for idx, item in enumerate(items):
        cond = item.get("condition", {})
        for ctype in CONDITION_TYPES:
            if ctype in cond:
                rules.append(PolicyRule(
                    condition_type=ctype,
                    condition_value=str(cond[ctype]),
                    model=item.get("model", ""),
                    label=item.get("label", ""),
                    priority=idx,
                ))
                break
    return rules if rules else None


def _load_policies_from_db() -> dict[str, list[PolicyRule]] | None:
    """Load model policies from admin DB.

    Returns None when DB is unavailable or the table doesn't exist yet.
    Imported lazily to avoid hard dependency on DB at import time.
    """
    db_url = settings.trace_database_url or settings.admin_database_url
    if not db_url:
        return None
    try:
        import sqlalchemy as sa

        engine = sa.create_engine(db_url, pool_pre_ping=True, pool_size=1)
        with engine.connect() as conn:
            inspector = sa.inspect(engine)
            if not inspector.has_table("model_policies"):
                engine.dispose()
                return None
            rows = conn.execute(
                sa.text(
                    "SELECT role, condition_type, condition_value, model, label, priority "
                    "FROM model_policies WHERE enabled = true ORDER BY role, priority"
                )
            ).fetchall()
        engine.dispose()
    except Exception:
        logger.debug("Cannot load model_policies from DB (table may not exist yet)", exc_info=True)
        return None

    if not rows:
        return None

    policies: dict[str, list[PolicyRule]] = {}
    for row in rows:
        role = row[0]
        rule = PolicyRule(
            condition_type=row[1],
            condition_value=str(row[2]),
            model=row[3],
            label=row[4] or "",
            priority=row[5],
        )
        policies.setdefault(role, []).append(rule)
    return policies


def _load_policies() -> dict[str, list[PolicyRule]]:
    """Load policies: DB-first, env-var fallback, TTL-cached."""
    global _policies_cache, _cache_loaded_at
    now = time.monotonic()
    if _policies_cache and (now - _cache_loaded_at) < _CACHE_TTL_SECONDS:
        return _policies_cache

    with _cache_lock:
        if _policies_cache and (now - _cache_loaded_at) < _CACHE_TTL_SECONDS:
            return _policies_cache

        result: dict[str, list[PolicyRule]] = {}

        db_policies = _load_policies_from_db()
        if db_policies:
            result.update(db_policies)
            logger.info("Loaded model policies from DB for roles: %s", list(db_policies.keys()))

        for role in ("router", "general", "critic", "summarizer"):
            if role not in result:
                env_rules = _parse_env_policy(role)
                if env_rules:
                    result[role] = env_rules
                    logger.info("Loaded model policy for %s from env var", role)

        _policies_cache = result
        _cache_loaded_at = now
        return result


def invalidate_cache() -> None:
    """Force reload on next resolve_model() call (for tests / admin push)."""
    global _policies_cache, _cache_loaded_at
    with _cache_lock:
        _policies_cache = {}
        _cache_loaded_at = 0.0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def resolve_model(role: str, ctx: ModelContext) -> PolicyResolution:
    """Resolve the actual model name + base_url for a role given runtime context.

    Returns a PolicyResolution with the resolved model, base_url, and which
    rule matched (for tracing).
    """
    canonical = _ROLE_ALIASES.get(role, role)
    default_name, default_url = _static_defaults(role)

    policies = _load_policies()
    rules = policies.get(canonical, [])

    for rule in rules:
        evaluator = _CONDITION_EVALUATORS.get(rule.condition_type)
        if evaluator and evaluator(rule.condition_value, ctx):
            resolved_name = rule.model or default_name
            return PolicyResolution(
                model_name=resolved_name,
                base_url=default_url,
                role=canonical,
                matched_rule=rule,
                source="policy",
            )

    return PolicyResolution(
        model_name=default_name,
        base_url=default_url,
        role=canonical,
        matched_rule=None,
        source="static",
    )


def get_active_policies() -> dict[str, list[dict[str, Any]]]:
    """Return serializable dict of active policies (for pipeline graph API)."""
    policies = _load_policies()
    out: dict[str, list[dict[str, Any]]] = {}
    for role, rules in policies.items():
        out[role] = [
            {
                "condition_type": r.condition_type,
                "condition_value": r.condition_value,
                "model": r.model,
                "label": r.label,
                "priority": r.priority,
            }
            for r in rules
        ]
    return out


def preview_resolution(role: str, points: list[float] | None = None) -> dict[str, str]:
    """Preview which model is selected at various difficulty levels.

    Useful for the admin UI difficulty slider visualization.
    """
    if points is None:
        points = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    result: dict[str, str] = {}
    for d in points:
        res = resolve_model(role, ModelContext(difficulty=d))
        result[str(d)] = res.model_name
    return result
