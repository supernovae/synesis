"""Structured client context for Yarn (optional OpenAI extension field).

Versioned so clients and the reducer can evolve without breaking parsing.
Aligned conceptually with planner ContextPack trust labeling; kept Yarn-local
to avoid coupling the IDE runtime to planner imports.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class EvidenceObject(BaseModel):
    """A single evidence blob from the IDE or pipeline (retrieval, file context, etc.)."""

    kind: str = "unknown"
    tier: Literal["trusted", "medium", "low", "untrusted"] = "low"
    label: str = ""
    body: str = ""


class SynesisCoderContext(BaseModel):
    """Optional `synesis_context` on chat completions — all fields optional."""

    version: Literal["1"] = "1"
    task_pack: dict[str, Any] | None = None
    taxonomy: list[str] | None = None
    trust_labels: dict[str, str] | None = None
    evidence_objects: list[EvidenceObject] = Field(default_factory=list)
    policy_requirements: list[str] | None = None
    validation_results: list[dict[str, Any]] | None = None
    open_questions: list[str] | None = None
    decision_trace: list[dict[str, Any]] | None = None
