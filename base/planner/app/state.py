"""Synesis state model -- the typed contract shared by all graph nodes.

Every node reads from and writes to this state. Pydantic enforces
strict validation so malformed data crashes fast (Erlang-style)
rather than silently propagating garbage.

GraphState (TypedDict) is the schema for StateGraph; SynesisState (Pydantic)
is used for validation and documentation. Keys are kept in sync.
"""

from __future__ import annotations

import time
from enum import Enum
from typing import Annotated, Any, Literal, TypedDict

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel, ConfigDict, Field

from .reducers import (
    _append_only_ledger,
    _append_only_strings,
    _merge_critique_register,
    _merge_evidence_packets,
    _set_once_dict,
)

# ---------------------------------------------------------------------------
# Evidence Packet — the single retrieval contract
# ---------------------------------------------------------------------------


class EvidenceSource(BaseModel):
    """One source document referenced by an evidence packet."""

    uri: str
    type: Literal["doc", "code", "wiki", "web", "repo", "api"]
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvidenceSnippet(BaseModel):
    """A relevance-scored text excerpt tied back to its source."""

    text: str
    relevance: float = Field(ge=0.0, le=1.0)
    source_uri: str


class EvidencePacket(BaseModel):
    """Structured retrieval output produced exclusively by the Router node.

    This is the only form in which retrieved knowledge enters the graph.
    Planner, Executor, Writer, and Critic consume these packets from state
    and never touch retrieval backends directly.
    """

    query: str
    sources: list[EvidenceSource] = Field(default_factory=list)
    snippets: list[EvidenceSnippet] = Field(default_factory=list)
    summary: str = ""
    confidence: float = Field(ge=0.0, le=1.0, default=0.0)
    retrieval_notes: str = ""
    section_id: int | None = None


# ---------------------------------------------------------------------------
# Taxonomy
# ---------------------------------------------------------------------------


class TaxonomyNode(TypedDict, total=False):
    """Taxonomy-driven metadata for contextual injection. Set by Entry Classifier + TaxonomyResolver.

    Flows through all nodes; Planner/Executor/Critic use it to shape prompts and verify depth.
    """

    path: str  # e.g. "Science > Physics"
    complexity_score: float  # 0.0-1.0
    persona_instructions: str  # Persona label + depth guidance
    required_bullets: int  # Derived from len(required_elements)
    required_elements: list[str]  # e.g. ["Theoretical Basis", "Mathematical Context"]
    depth_instructions: str  # Appended to prompt when complexity > 0.7
    taxonomy_key: str  # e.g. "physics", "general_greeting"


# ---------------------------------------------------------------------------
# GraphState — the LangGraph typed schema
# ---------------------------------------------------------------------------


class GraphState(TypedDict, total=False):
    """Typed schema for LangGraph StateGraph. All keys optional for partial updates."""

    # --- Identity & messages ---
    taxonomy_metadata: dict[str, Any]
    task_frame: Annotated[dict[str, Any], _set_once_dict]
    messages: Annotated[list[BaseMessage], add_messages]
    user_id: str
    conversation_history: list[str]
    run_id: str
    attempt_id: str
    task_type: str
    task_description: str
    target_language: str

    # --- Clarification ---
    clarification_question: str
    clarification_options: list[str]
    needs_input_question: str

    # --- Plan ---
    execution_plan: dict[str, Any]
    assumptions: list[str]
    defaults_used: list[str]

    # --- Query normalization ---
    query_normalization: dict[str, Any]

    # --- Classification / routing ---
    is_code_task: bool  # always False in unified pipeline; kept for analytics
    rag_mode: str  # "normal" | "light" | "disabled" — set by entry_classifier
    include_tests: bool
    include_run_commands: bool
    allowed_tools: list[str]

    # --- Evidence (Router-governed) ---
    evidence_packets: Annotated[list[dict[str, Any]], _merge_evidence_packets]
    evidence_requests: list[dict[str, Any]]

    # --- Cohesion Lock (Router-set, consumed by Writer/Critic) ---
    cohesion_lock: Annotated[dict[str, Any], _set_once_dict]

    # --- Domain Profiling (set via TaskFrame.domain_profile) ---
    # DomainProfile is embedded in task_frame; no separate state key needed.

    # --- Domain Context (Entry Classifier + Strategic Advisor) ---
    domain_ref_counts: dict[str, int]
    platform_context: str
    active_domain_refs: list[str]
    advisory_message: str
    incomplete_knowledge: bool
    knowledge_gap_message: str

    # --- Per-request retrieval overrides (from API, consumed by Router) ---
    retrieval_params: Any

    # --- Workspace / files ---
    target_workspace: str
    touched_files: list[str]

    # --- Executor output ---
    generated_code: str
    code_explanation: str
    patch_ops: list[Any]

    # --- Sandbox execution ---
    execution_result: str
    execution_exit_code: int | None
    execution_lint_passed: bool
    execution_security_passed: bool
    execution_sandbox_pod: str
    stages_passed: list[str]

    # --- Failure context ---
    failure_context: list[str]
    failure_ids_seen: list[str]
    failure_type: str

    # --- LSP ---
    lsp_diagnostics: list[str]
    lsp_languages_analyzed: list[str]
    lsp_analysis_skipped: bool
    lsp_has_compile_errors: bool

    # --- Critic ---
    what_if_analyses: list[Any]
    critic_feedback: str
    critic_approved: bool
    critic_should_continue: bool
    critic_continue_reason: str | None
    residual_risks: list[dict[str, Any]]
    critic_nonblocking: list[dict[str, Any]]
    need_more_evidence: bool

    # --- Plan Gate (fast deterministic validation after planner) ---
    plan_gate_passed: bool
    plan_gate_errors: list[str]
    plan_gate_feedback: str

    # --- Iteration / budget ---
    iteration_count: int
    planner_error_count: int
    max_iterations: int
    strategy_candidates: list[dict[str, Any]]
    revision_strategy: str
    revision_strategies_tried: list[str]
    revision_constraints: dict[str, Any]
    strategy_violation: bool
    user_answer_to_clarification: str
    user_answer_to_needs_input: str
    token_budget_remaining: int
    sandbox_minutes_used: float
    lsp_calls_used: int
    evidence_experiments_count: int

    # --- Safety ---
    injection_detected: bool
    injection_scan_result: dict[str, Any]

    # --- Tool evidence / provenance ---
    tool_refs: list[dict[str, Any]]
    code_ref: dict[str, Any] | None
    evidence_queries_tried: list[str]
    evidence_results_tried: list[str]
    evidence_fingerprints_tried: list[str]

    # --- Critic policy ---
    retry: dict[str, Any]

    # --- Observability ---
    node_traces: list[Any]
    current_node: str
    next_node: str
    error: str | None

    # --- Routing-only (EntryClassifier, main) ---
    last_user_content: str
    is_pivot: bool
    domain_soft_shift: bool
    last_active_language: str
    pivot_summary: str
    pending_question_continue: bool
    pending_question_source: str
    task_size: str
    complexity_score: int
    difficulty: float
    explicit_deliverables: int
    intent_class: str
    bypass_supervisor: bool
    escalation_reason: str
    message_origin: str
    plan_pending_approval: bool

    # --- Executor / Gate ---
    stop_reason: str
    stop_reason_explanation: str
    integrity_passed: bool
    integrity_failure_reason: str
    integrity_failure: dict[str, Any] | None

    # --- Writer / compiler pipeline ---
    compiled_answer: str
    scrubbed_answer: str
    direct_stream_request: dict[str, Any]  # deferred SSE stream for trivial/text tasks
    final_answer_audit: dict[str, Any] | None

    # --- Task-faithful critic outputs ---
    repair_instructions: list[dict[str, Any]]
    requirement_coverage: list[dict[str, Any]]
    failure_modes_detected: list[str]

    # --- Always-plan routing ---
    plan_required: bool
    task_is_trivial: bool

    # --- Routing overrides ---
    task_size_override: str
    coding_client_detected: bool
    memory_scope: str

    # --- Entry classifier observability ---
    classification_reasons: list[str]
    score_breakdown: dict[str, Any]
    reclassify_override: str

    # --- Output controls (Phase 2) ---
    output_controls: dict[str, Any]

    # --- Anti-oscillation framework ---
    style_contract_locked: Annotated[dict[str, Any], _set_once_dict]
    decision_ledger: Annotated[list[dict[str, Any]], _append_only_ledger]
    critique_register: Annotated[dict[str, Any], _merge_critique_register]
    override_log: Annotated[list[dict[str, Any]], _append_only_ledger]
    draft_fingerprints: Annotated[list[str], _append_only_strings]
    oscillation_score: dict[str, float]


# ---------------------------------------------------------------------------
# Pydantic helpers
# ---------------------------------------------------------------------------


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
    """A single retrieved document chunk with full provenance metadata.

    Used internally by the Router node and retrieval backends. Never
    appears in GraphState — the Router converts these into EvidencePackets.
    """

    text: str
    source: str = "unknown"
    collection: str = ""
    retrieval_source: Literal["vector", "bm25", "both", "hybrid"] = "vector"
    vector_score: float = 0.0
    bm25_score: float = 0.0
    rrf_score: float = 0.0
    rerank_score: float = 0.0
    repo_license: str = ""
    origin_type: str = ""
    authority: str = ""
    domain: str = ""
    source_url: str = ""
    heading_path: str = ""
    context_prefix: str = ""
    chunk_summary: str = ""
    document_name: str = ""
    handler: str = ""
    source_type: str = ""
    # v8 metadata
    language: str = ""
    artifact_kind: str = ""
    repo_path: str = ""
    module_path: str = ""
    symbol_name: str = ""


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


# ---------------------------------------------------------------------------
# SynesisState (Pydantic) — validation / documentation mirror of GraphState
# ---------------------------------------------------------------------------


class SynesisState(BaseModel):
    """Primary state flowing through the LangGraph.

    Every field is explicitly typed. Nodes append to lists via
    LangGraph's reducer pattern (add_messages for chat history).
    """

    messages: Annotated[list[BaseMessage], add_messages] = Field(default_factory=list)

    taxonomy_metadata: dict[str, Any] = Field(default_factory=dict)

    user_id: str = "anonymous"
    conversation_history: list[str] = Field(default_factory=list)

    run_id: str = ""
    attempt_id: str = ""

    task_type: TaskType = TaskType.GENERAL
    task_description: str = ""
    target_language: str = ""

    clarification_question: str = ""
    clarification_options: list[str] = Field(default_factory=list)
    needs_input_question: str = ""

    execution_plan: dict[str, Any] = Field(default_factory=dict)
    assumptions: list[str] = Field(default_factory=list)
    defaults_used: list[str] = Field(default_factory=list)

    is_code_task: bool = True
    include_tests: bool = True
    include_run_commands: bool = True
    allowed_tools: list[str] = Field(default_factory=lambda: ["sandbox", "lsp"])

    # Evidence (Router-governed)
    evidence_packets: list[EvidencePacket] = Field(default_factory=list)
    evidence_requests: list[dict[str, Any]] = Field(default_factory=list)

    # Cohesion Lock (Router-set, consumed by Writer/Critic)
    cohesion_lock: dict[str, Any] = Field(default_factory=dict)

    # Domain Context + Strategic Advisor
    domain_ref_counts: dict[str, int] = Field(default_factory=dict)
    platform_context: str = ""
    active_domain_refs: list[str] = Field(default_factory=list)
    advisory_message: str = ""
    incomplete_knowledge: bool = False
    knowledge_gap_message: str = ""

    retrieval_params: RetrievalParams | None = None

    target_workspace: str = ""
    touched_files: list[str] = Field(default_factory=list)

    generated_code: str = ""
    code_explanation: str = ""

    execution_result: str = ""
    execution_exit_code: int | None = None
    execution_lint_passed: bool = True
    execution_security_passed: bool = True
    execution_sandbox_pod: str = ""

    stages_passed: list[str] = Field(default_factory=list)

    failure_context: list[str] = Field(default_factory=list)

    lsp_diagnostics: list[str] = Field(default_factory=list)
    lsp_languages_analyzed: list[str] = Field(default_factory=list)
    lsp_analysis_skipped: bool = False

    what_if_analyses: list[WhatIfAnalysis] = Field(default_factory=list)
    critic_feedback: str = ""
    critic_approved: bool = False
    residual_risks: list[dict[str, Any]] = Field(default_factory=list)

    plan_gate_passed: bool = True
    plan_gate_errors: list[str] = Field(default_factory=list)
    plan_gate_feedback: str = ""

    iteration_count: int = 0
    planner_error_count: int = 0
    max_iterations: int = 3

    strategy_candidates: list[dict[str, Any]] = Field(default_factory=list)
    revision_strategy: str = ""
    revision_strategies_tried: list[str] = Field(default_factory=list)
    revision_constraints: dict[str, Any] = Field(default_factory=dict)

    user_answer_to_clarification: str = ""

    token_budget_remaining: int = 100000
    sandbox_minutes_used: float = 0.0
    lsp_calls_used: int = 0
    evidence_experiments_count: int = 0

    critic_should_continue: bool = False
    critic_continue_reason: str | None = None

    injection_detected: bool = False
    injection_scan_result: dict[str, Any] = Field(default_factory=dict)

    tool_refs: list[dict[str, Any]] = Field(default_factory=list)
    code_ref: dict[str, Any] | None = None

    evidence_queries_tried: list[str] = Field(default_factory=list)
    evidence_results_tried: list[str] = Field(default_factory=list)
    evidence_fingerprints_tried: list[str] = Field(default_factory=list)

    retry: dict[str, Any] = Field(default_factory=dict)

    node_traces: list[NodeTrace] = Field(default_factory=list)

    current_node: str = ""
    next_node: str = ""

    error: str | None = None

    # Output controls (Phase 2)
    output_controls: dict[str, Any] = Field(default_factory=dict)

    # Anti-oscillation
    style_contract_locked: dict[str, Any] = Field(default_factory=dict)
    decision_ledger: list[dict[str, Any]] = Field(default_factory=list)
    critique_register: dict[str, Any] = Field(default_factory=dict)
    override_log: list[dict[str, Any]] = Field(default_factory=list)
    draft_fingerprints: list[str] = Field(default_factory=list)
    oscillation_score: dict[str, float] = Field(default_factory=dict)

    model_config = ConfigDict(arbitrary_types_allowed=True)
