"""Synesis state model -- the typed contract shared by all graph nodes.

Every node reads from and writes to this state. Pydantic enforces
strict validation so malformed data crashes fast (Erlang-style)
rather than silently propagating garbage.
"""

from __future__ import annotations

import time
from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, Field
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage


class Confidence(float):
    """Confidence score clamped to [0.0, 1.0]."""

    def __new__(cls, value: float) -> Confidence:
        if not 0.0 <= value <= 1.0:
            raise ValueError(f"Confidence must be between 0.0 and 1.0, got {value}")
        return super().__new__(cls, value)


class TaskType(str, Enum):
    CODE_GENERATION = "code_generation"
    CODE_REVIEW = "code_review"
    EXPLANATION = "explanation"
    DEBUGGING = "debugging"
    SHELL_SCRIPT = "shell_script"
    GENERAL = "general"


class NodeOutcome(str, Enum):
    SUCCESS = "success"
    NEEDS_REVISION = "needs_revision"
    ERROR = "error"
    TIMEOUT = "timeout"


class WhatIfAnalysis(BaseModel):
    scenario: str
    risk_level: str = Field(pattern=r"^(low|medium|high|critical)$")
    explanation: str
    suggested_mitigation: str | None = None


class RetrievalResult(BaseModel):
    """A single retrieved document chunk with full provenance metadata."""
    text: str
    source: str = "unknown"
    collection: str = ""
    retrieval_source: Literal["vector", "bm25", "both"] = "vector"
    vector_score: float = 0.0
    bm25_score: float = 0.0
    rrf_score: float = 0.0
    rerank_score: float = 0.0
    repo_license: str = ""


class RetrievalParams(BaseModel):
    """Per-request retrieval configuration, overridable from the API."""
    strategy: Literal["hybrid", "vector", "bm25"] = "hybrid"
    reranker: Literal["flashrank", "bge", "none"] = "flashrank"
    top_k: int = 5


class NodeTrace(BaseModel):
    """Audit trail for a single node execution -- observability requirement."""
    node_name: str
    reasoning: str
    assumptions: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    outcome: NodeOutcome
    latency_ms: float = 0.0
    tokens_used: int = 0
    timestamp: float = Field(default_factory=time.time)


class SynesisState(BaseModel):
    """Primary state flowing through the LangGraph.

    Every field is explicitly typed. Nodes append to lists via
    LangGraph's reducer pattern (add_messages for chat history).
    """

    messages: Annotated[list[BaseMessage], add_messages] = Field(default_factory=list)

    # User identity and conversation memory
    user_id: str = "anonymous"
    conversation_history: list[str] = Field(default_factory=list)

    task_type: TaskType = TaskType.GENERAL
    task_description: str = ""
    target_language: str = "bash"

    # RAG retrieval -- rich results with provenance
    rag_results: list[RetrievalResult] = Field(default_factory=list)
    rag_context: list[str] = Field(default_factory=list)
    rag_collections_queried: list[str] = Field(default_factory=list)
    rag_retrieval_strategy: str = "hybrid"
    rag_reranker_used: str = "flashrank"
    rag_vector_fallback_to_bm25: bool = False

    # Per-request retrieval overrides (set from API, consumed by supervisor)
    retrieval_params: RetrievalParams | None = None

    generated_code: str = ""
    code_explanation: str = ""

    # Sandbox execution results
    execution_result: str = ""
    execution_exit_code: int | None = None
    execution_lint_passed: bool = True
    execution_security_passed: bool = True
    execution_sandbox_pod: str = ""

    # Failure knowledge base context (injected by supervisor)
    failure_context: list[str] = Field(default_factory=list)

    # Web search context (SearXNG results injected by supervisor/worker/critic)
    web_search_results: list[str] = Field(default_factory=list)
    web_search_queries: list[str] = Field(default_factory=list)

    # LSP deep analysis diagnostics (enriches failure recovery)
    lsp_diagnostics: list[str] = Field(default_factory=list)
    lsp_languages_analyzed: list[str] = Field(default_factory=list)
    lsp_analysis_skipped: bool = False

    what_if_analyses: list[WhatIfAnalysis] = Field(default_factory=list)
    critic_feedback: str = ""
    critic_approved: bool = False

    iteration_count: int = 0
    max_iterations: int = 3

    node_traces: list[NodeTrace] = Field(default_factory=list)

    current_node: str = ""
    next_node: str = ""

    error: str | None = None

    class Config:
        arbitrary_types_allowed = True
