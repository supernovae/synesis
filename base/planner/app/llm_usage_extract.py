"""Normalize LLM usage dicts from OpenAI-compatible APIs, LiteLLM, and LangChain metadata.

Providers differ: OpenAI uses ``prompt_tokens_details.cached_tokens``; Anthropic
often uses ``cache_read_input_tokens``; LangChain may put cache reads under
``usage_metadata.input_token_details``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class NormalizedLLMUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cached_prompt_tokens: int = 0

    def merge(self, other: NormalizedLLMUsage) -> NormalizedLLMUsage:
        """Prefer larger token counts; cached_prompt_tokens uses max (both may report)."""
        pt = max(self.prompt_tokens, other.prompt_tokens)
        ct = max(self.completion_tokens, other.completion_tokens)
        tt = max(self.total_tokens, other.total_tokens)
        if tt == 0 and (pt or ct):
            tt = pt + ct
        cached = max(self.cached_prompt_tokens, other.cached_prompt_tokens)
        cached = min(max(0, cached), pt) if pt else max(0, cached)
        return NormalizedLLMUsage(
            prompt_tokens=pt,
            completion_tokens=ct,
            total_tokens=tt or (pt + ct),
            cached_prompt_tokens=cached,
        )


def _int_u(x: Any) -> int:
    try:
        return int(x or 0)
    except (TypeError, ValueError):
        return 0


def normalize_usage_dict(usage: dict[str, Any] | None) -> NormalizedLLMUsage:
    """Parse a flat or provider-shaped ``usage`` object (OpenAI completion.usage)."""
    if not usage or not isinstance(usage, dict):
        return NormalizedLLMUsage()

    inner = usage.get("usage")
    if isinstance(inner, dict) and (inner.get("prompt_tokens") or inner.get("input_tokens")):
        return normalize_usage_dict(inner)

    pt = _int_u(usage.get("prompt_tokens") or usage.get("input_tokens"))
    ct = _int_u(usage.get("completion_tokens") or usage.get("output_tokens"))
    tt = _int_u(usage.get("total_tokens"))
    if not tt:
        tt = pt + ct

    cached = 0
    ptd = usage.get("prompt_tokens_details")
    if isinstance(ptd, dict):
        cached = _int_u(ptd.get("cached_tokens"))
    if not cached:
        cached = _int_u(usage.get("cache_read_input_tokens"))
    if not cached:
        cached = _int_u(usage.get("cached_tokens"))

    cached = min(max(0, cached), pt) if pt else max(0, cached)
    return NormalizedLLMUsage(
        prompt_tokens=pt,
        completion_tokens=ct,
        total_tokens=tt,
        cached_prompt_tokens=cached,
    )


def normalize_usage_metadata(meta: dict[str, Any] | None) -> NormalizedLLMUsage:
    """Parse LangChain ``AIMessage.usage_metadata`` (OpenAI, some other providers)."""
    if not meta or not isinstance(meta, dict):
        return NormalizedLLMUsage()

    pt = _int_u(meta.get("input_tokens"))
    ct = _int_u(meta.get("output_tokens"))
    tt = _int_u(meta.get("total_tokens"))
    if not tt:
        tt = pt + ct
    cached = 0
    itd = meta.get("input_token_details")
    if isinstance(itd, dict):
        cached = _int_u(itd.get("cache_read") or itd.get("cached"))
    cached = min(max(0, cached), pt) if pt else max(0, cached)
    return NormalizedLLMUsage(
        prompt_tokens=pt,
        completion_tokens=ct,
        total_tokens=tt,
        cached_prompt_tokens=cached,
    )


def normalize_from_llm_result(
    llm_output: dict[str, Any] | None,
    message: Any | None,
) -> NormalizedLLMUsage:
    """Combine ``LLMResult.llm_output`` usage with ``AIMessage.usage_metadata``."""
    u = NormalizedLLMUsage()
    if llm_output and isinstance(llm_output, dict):
        raw = llm_output.get("token_usage") or llm_output.get("usage") or {}
        if isinstance(raw, dict):
            u = u.merge(normalize_usage_dict(raw))
    if message is not None:
        meta = getattr(message, "usage_metadata", None)
        if isinstance(meta, dict) and meta:
            u = u.merge(normalize_usage_metadata(meta))
        resp_meta = getattr(message, "response_metadata", None) or {}
        if isinstance(resp_meta, dict):
            ru = resp_meta.get("usage")
            if isinstance(ru, dict) and ru:
                u = u.merge(normalize_usage_dict(ru))
    return u
