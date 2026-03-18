"""Token estimation and budget tracking utilities.

Provides model-aware token counting when tiktoken is available,
with a fallback heuristic (len // 4) for unknown models.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("synesis.token_utils")

_tokenizer_cache: dict[str, Any] = {}


def estimate_tokens(text: str, model: str = "") -> int:
    """Estimate token count for *text*.

    Tries tiktoken encoding for known model families first.
    Falls back to ``len(text) // 4`` which averages ~25% error.
    """
    if not text:
        return 0

    enc = _get_tokenizer(model)
    if enc is not None:
        try:
            return len(enc.encode(text))
        except Exception:
            pass

    return len(text) // 4


def _get_tokenizer(model: str) -> Any:
    """Return a tiktoken encoding for *model*, or None."""
    if not model:
        return None

    if model in _tokenizer_cache:
        return _tokenizer_cache[model]

    try:
        import tiktoken

        try:
            enc = tiktoken.encoding_for_model(model)
        except KeyError:
            enc = tiktoken.get_encoding("cl100k_base")
        _tokenizer_cache[model] = enc
        return enc
    except ImportError:
        _tokenizer_cache[model] = None
        return None


def extract_usage_tokens(response: Any) -> int:
    """Extract total token usage from a LangChain AIMessage or response object."""
    meta = getattr(response, "usage_metadata", None)
    if meta:
        if isinstance(meta, dict):
            total = meta.get("total_tokens", 0)
            if not total:
                total = meta.get("input_tokens", 0) + meta.get("output_tokens", 0)
            return int(total or 0)
        total = int(getattr(meta, "total_tokens", 0) or 0)
        if not total:
            total = int(getattr(meta, "input_tokens", 0) or 0) + int(getattr(meta, "output_tokens", 0) or 0)
        return total
    resp_meta = getattr(response, "response_metadata", {})
    usage = resp_meta.get("usage", {}) if isinstance(resp_meta, dict) else {}
    total = int(usage.get("total_tokens", 0))
    if not total:
        total = int(usage.get("prompt_tokens", 0)) + int(usage.get("completion_tokens", 0))
    return total


def track_budget(state: dict, response: Any, role: str = "") -> int:
    """Decrement token_budget_remaining using actual usage from response.

    Returns the new budget value.
    """
    from .config import settings

    budget = state.get("token_budget_remaining", settings.max_tokens_per_request)
    used = extract_usage_tokens(response)
    new_budget = max(0, budget - used)

    if used > 0:
        logger.debug(
            "token_budget_update",
            extra={"role": role, "used": used, "remaining": new_budget},
        )

    return new_budget
