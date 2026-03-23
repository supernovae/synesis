"""Yarn trust envelope: structured client context and cache-oriented reduction."""

from __future__ import annotations

from .reducer import build_user_turn_content, escape_evidence_text, wrap_tool_result_content
from .schemas import EvidenceObject, SynesisCoderContext

__all__ = [
    "EvidenceObject",
    "SynesisCoderContext",
    "build_user_turn_content",
    "escape_evidence_text",
    "wrap_tool_result_content",
]
