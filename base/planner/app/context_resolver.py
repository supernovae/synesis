"""Resolve RAG context from refs+cache or legacy rag_context for lighter state payloads."""

from __future__ import annotations


def get_resolved_rag_context(state: dict) -> list[str]:
    """Return RAG context text list, resolving from refs+cache when context_refs_enabled.

    When context_refs_enabled, context_curator outputs rag_context_refs + context_cache
    instead of duplicating full text in rag_context. Worker/Planner call this to get
    the actual strings for prompt building.
    """
    refs = state.get("rag_context_refs") or []
    cache = state.get("context_cache") or {}
    if refs and cache:
        return [cache.get(r, "") for r in refs]
    return list(state.get("rag_context") or [])
