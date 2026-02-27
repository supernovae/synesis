"""Synesis state model -- the typed contract shared by all graph nodes.

Every node reads from and writes to this state. Pydantic enforces
strict validation so malformed data crashes fast (Erlang-style)
rather than silently propagating garbage.
"""

from __future__ import annotations

import time
from enum import Enum
from typing import Annotated, Any, Literal

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel, ConfigDict, Field


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

    # Run/Attempt identity (§7.1): correlate logs, idempotency
    run_id: str = ""  # Per user request / conversation turn
    attempt_id: str = ""  # Per Worker→Gate→Sandbox loop

    task_type: TaskType = TaskType.GENERAL
    task_description: str = ""
    target_language: str = "python"

    # JCS: clarification request (Supervisor emits when ambiguous)
    clarification_question: str = ""
    clarification_options: list[str] = Field(default_factory=list)
    # JCS: Executor "I need more" (agentic model asks user instead of guessing)
    needs_input_question: str = ""

    # JCS: structured plan from Planner node
    execution_plan: dict[str, Any] = Field(default_factory=dict)
    assumptions: list[str] = Field(default_factory=list)
    defaults_used: list[str] = Field(default_factory=list)
    assumptions_structured: list[dict[str, Any]] = Field(default_factory=list)

    # Supervisor: intent + output shape
    deliverable_type: str = "single_file"
    interaction_mode: str = "do"
    include_tests: bool = True
    include_run_commands: bool = True
    allowed_tools: list[str] = Field(default_factory=lambda: ["sandbox", "lsp"])
    rag_mode: str = "normal"  # disabled | light | normal

    # RAG retrieval -- rich results with provenance
    rag_results: list[RetrievalResult] = Field(default_factory=list)
    rag_context: list[str] = Field(default_factory=list)
    rag_collections_queried: list[str] = Field(default_factory=list)
    rag_retrieval_strategy: str = "hybrid"
    rag_reranker_used: str = "flashrank"
    rag_vector_fallback_to_bm25: bool = False

    # Per-request retrieval overrides (set from API, consumed by supervisor)
    retrieval_params: RetrievalParams | None = None

    # Session-scoped workspace boundary (Planner/Supervisor sets; Gate enforces)
    target_workspace: str = ""  # e.g. /app/src/; Gate strict prefix check for multi-file
    touched_files: list[str] = Field(default_factory=list)  # Planner manifest; Gate scope validation

    generated_code: str = ""
    code_explanation: str = ""

    # Sandbox execution results
    execution_result: str = ""
    execution_exit_code: int | None = None
    execution_lint_passed: bool = True
    execution_security_passed: bool = True
    execution_sandbox_pod: str = ""

    # Monotonicity: stages that passed last run (do not regress)
    stages_passed: list[str] = Field(default_factory=list)  # e.g. ["lint", "security"]

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
    residual_risks: list[dict[str, Any]] = Field(default_factory=list)

    iteration_count: int = 0
    max_iterations: int = 3

    # Revision strategy (strategy-diverse retries)
    strategy_candidates: list[dict[str, Any]] = Field(default_factory=list)
    revision_strategy: str = ""
    revision_strategies_tried: list[str] = Field(default_factory=list)
    revision_constraints: dict[str, Any] = Field(default_factory=dict)

    # Unified pending question / clarification
    user_answer_to_clarification: str = ""

    # Budget accounting
    token_budget_remaining: int = 100000
    sandbox_minutes_used: float = 0.0
    lsp_calls_used: int = 0
    evidence_experiments_count: int = 0

    # Critic stop condition
    critic_should_continue: bool = False
    critic_continue_reason: str | None = None

    # IDE/agent coordination — prompt-injection safety
    injection_detected: bool = False
    injection_scan_result: dict[str, Any] = Field(default_factory=dict)

    # Tool evidence (LSP, Sandbox, RAG) for auditability
    tool_refs: list[dict[str, Any]] = Field(default_factory=list)
    # §7.6: code_ref for patch provenance (Worker → Critic)
    code_ref: dict[str, Any] | None = None

    # Evidence-gap: novelty check. Item 4: novelty = new query_hash OR new result_hash OR new result_fingerprint
    evidence_queries_tried: list[str] = Field(default_factory=list)
    evidence_results_tried: list[str] = Field(default_factory=list)  # result_hash, artifact_hashes
    evidence_fingerprints_tried: list[str] = Field(default_factory=list)  # result_fingerprint from Sandbox

    node_traces: list[NodeTrace] = Field(default_factory=list)

    current_node: str = ""
    next_node: str = ""

    error: str | None = None

    model_config = ConfigDict(arbitrary_types_allowed=True)
