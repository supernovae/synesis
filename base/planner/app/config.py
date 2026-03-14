"""Centralized configuration via environment variables.

Every tunable knob lives here. Override via ConfigMap env vars in K8s.
"""

import os
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .url_utils import ensure_url_protocol


def _build_info() -> str:
    """Build version string for log/debug — verify deployed image is current."""
    sha = os.environ.get("SYNESIS_GIT_SHA", "dev")[:12]
    ts = os.environ.get("SYNESIS_BUILD_TIMESTAMP", "dev")
    return f"{sha}@{ts}"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SYNESIS_")

    # Model Endpoints — see models.yaml for profile-specific assignments.
    #
    # Role mapping (1:1 with models.yaml roles):
    #   Router  (synesis-router)  → router node, planner, advisor
    #   General (synesis-general) → executor node, writer node
    #   Critic  (synesis-critic)  → critic node
    #   Coder   (synesis-coder)   → direct IDE endpoint (not used by planner)
    #   Summarizer (synesis-summarizer) → pivot history summarization

    # Router model (serves router node, planner, advisor)
    router_model_url: str = "http://synesis-router.synesis-models.svc.cluster.local:8080/v1"
    router_model_name: str = "synesis-router"
    planner_model_url: str = "http://synesis-router.synesis-models.svc.cluster.local:8080/v1"
    planner_model_name: str = "synesis-router"
    advisor_model_url: str = "http://synesis-router.synesis-models.svc.cluster.local:8080/v1"
    advisor_model_name: str = "synesis-router"
    advisor_enabled: bool = True

    # General model (serves executor and writer nodes)
    general_model_url: str = "http://synesis-general.synesis-models.svc.cluster.local:8080/v1"
    general_model_name: str = "synesis-general"

    # Critic model
    critic_model_url: str = "http://synesis-critic.synesis-models.svc.cluster.local:8080/v1"
    critic_model_name: str = "synesis-critic"

    # Writer model (defaults to general model endpoint; same physical model)
    writer_model_url: str = ""
    writer_model_name: str = ""

    # Summarizer (micro model for pivot history)
    summarizer_model_url: str = ""
    summarizer_model_name: str = "synesis-summarizer"

    # UDS paths (bypass HTTP; for co-located vLLM)
    router_model_uds: str = ""
    planner_model_uds: str = ""
    general_model_uds: str = ""
    critic_model_uds: str = ""
    advisor_model_uds: str = ""

    # RAG / Milvus (operator-managed, service: synesis-milvus)
    milvus_host: str = "synesis-milvus.synesis-rag.svc.cluster.local"
    milvus_port: int = 19530
    embedder_url: str = "http://embedder.synesis-rag.svc.cluster.local:8080/v1"
    keyword_service_url: str = "http://keyword-service.synesis-rag.svc.cluster.local:8080/v1"
    gliner_service_url: str = "http://gliner-service.synesis-rag.svc.cluster.local:8080/v1"

    @field_validator(
        "embedder_url",
        "keyword_service_url",
        "gliner_service_url",
        "web_search_url",
        "lsp_gateway_url",
        "sandbox_warm_pool_url",
        "rag_bge_reranker_url",
        "router_model_url",
        "planner_model_url",
        "general_model_url",
        "critic_model_url",
        "advisor_model_url",
        "summarizer_model_url",
        mode="before",
    )
    @classmethod
    def normalize_url_protocol(cls, v: str) -> str:
        return ensure_url_protocol(v) if isinstance(v, str) else v

    embedder_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    rag_top_k: int = 5
    rag_overfetch_count: int = 30  # Legacy fixed overfetch; prefer rag_overfetch_min/max below
    # Adaptive overfetch: wider net for complex queries, reranker handles the extra noise.
    rag_overfetch_min: int = 30  # candidates at difficulty=0
    rag_overfetch_max: int = 50  # candidates at difficulty=1
    # CAR-style similarity-gap cliff detection (arXiv:2511.14769)
    rag_adaptive_gap_multiplier: float = 1.5  # gap > mean_gap * this triggers cliff cutoff
    rag_score_threshold: float = 0.55

    # Post-retrieval coherence gate (CRAG/Self-RAG pattern, arXiv 2401.15884 / 2310.11511).
    # Drops chunks whose cosine similarity to the query embedding falls below
    # this threshold.  Catches polysemous-term false positives (e.g. "architecture"
    # in consensus algorithms vs AI system design).  0.25 is conservative; raise
    # to 0.3-0.35 if off-topic chunks persist.
    coherence_gate_threshold: float = 0.25

    # Cohesion Lock: post-retrieval inter-document coherence filtering.
    # Detects the dominant entity/theme from top results and evicts
    # documents that conflict with it (e.g. mixing cloud providers).
    cohesion_lock_enabled: bool = True
    cohesion_lock_llm_fallback: bool = True
    cohesion_lock_min_results: int = 3  # need at least this many results to lock
    cohesion_embedding_threshold: float = 0.15  # below this → evict
    cohesion_llm_borderline_low: float = 0.15  # embedding sim floor for LLM re-check
    cohesion_llm_borderline_high: float = 0.30  # embedding sim ceiling for LLM re-check
    cohesion_micro_critic_enabled: bool = True
    cohesion_compression_enabled: bool = True
    cohesion_compression_threshold: float = 0.20  # sentence-level similarity to lock
    long_context_reorder_enabled: bool = True

    # Retrieval strategy: "hybrid" (BM25 + vector), "vector", or "bm25"
    rag_retrieval_strategy: Literal["hybrid", "vector", "bm25"] = "hybrid"

    # Re-ranker: "flashrank" (fast single-vector, inline), "bge" (external
    # cross-encoder service, high accuracy), or "none"
    rag_reranker: Literal["flashrank", "bge", "none"] = "bge"
    rag_reranker_model: str = "ms-marco-MiniLM-L-12-v2"  # only used for flashrank

    # Reciprocal Rank Fusion constant for Milvus RRFRanker
    rag_rrf_k: int = 60

    # BGE reranker service URL (only used when rag_reranker="bge")
    rag_bge_reranker_url: str = ""

    # Sandbox execution
    sandbox_enabled: bool = True
    sandbox_namespace: str = "synesis-sandbox"
    sandbox_image: str = "synesis-sandbox:latest"
    sandbox_timeout_seconds: int = 30
    sandbox_cpu_limit: str = "2"
    sandbox_memory_limit: str = "1Gi"

    # Warm pool (pre-warmed sandbox pods for low-latency execution)
    sandbox_warm_pool_enabled: bool = True
    sandbox_warm_pool_url: str = "http://synesis-warm-pool.synesis-sandbox.svc.cluster.local:8080"

    # Failure store
    failure_store_enabled: bool = True
    failfast_cache_max_size: int = 1000
    failfast_cache_ttl_seconds: float = 86400.0

    # Context pivot: summarize old era before flush (micro model; stubbed)
    pivot_summary_enabled: bool = True  # When True, call summarizer (stub until model deployed)

    # Conversation memory (L1 in-memory)
    memory_enabled: bool = True
    memory_max_turns_per_user: int = 20
    memory_max_users: int = 5000
    memory_ttl_seconds: float = 14400.0

    # Worker: Thinking Mode for complex tasks (deliberate reasoning, higher latency).
    # executor_thinking_param: "enable_thinking" (Qwen3 general model), "thinking" (DeepSeek-V3),
    # "" (R1-Distill / DeepSeek-Coder — R1-Distill always thinks via <think> tags, no param needed)
    # Note: only applies to the executor/general model, not the router (Qwen2.5-14B).
    worker_thinking_mode_enabled: bool = True
    executor_thinking_param: str = ""

    # Model capability tier: "small" (8B), "medium" (30B), "large" (70B+).
    # When "large", taxonomy prompt shaping is disabled — the model handles tone/depth natively.
    model_capability_tier: Literal["small", "medium", "large"] = "small"

    # Web search (SearXNG behind SearchProvider protocol)
    web_search_enabled: bool = True
    web_search_url: str = "http://searxng.synesis-search.svc.cluster.local:8080"
    web_search_timeout_seconds: int = 5
    web_search_max_results: int = 5
    # Engine-to-authority map: SearXNG engine names -> trust tiers.
    # Results from mapped engines are treated as trusted internal sources
    # with the specified authority/origin_type. Unmapped engines default
    # to authority=external, origin_type=external (untrusted web).
    # Format: JSON dict, e.g. '{"internal-wiki": {"authority": "canonical", "origin_type": "internal"}}'
    engine_authority_map: dict[str, dict[str, str]] = Field(default_factory=dict)

    # LSP deep analysis
    lsp_enabled: bool = True
    lsp_mode: Literal["on_failure", "always", "disabled"] = "on_failure"
    lsp_gateway_url: str = "http://lsp-gateway.synesis-lsp.svc:8000"
    lsp_timeout_seconds: int = 30

    # Always-plan architecture: all non-trivial knowledge tasks go through
    # planner -> evidence_gatherers -> compile_evidence -> structured_writer -> critic. Complexity scales depth
    # (section count, token budgets, critic strictness) rather than whether
    # to use the pipeline at all.
    #
    # Research basis:
    #   Compute-optimal inference (ICLR 2025): per-prompt adaptive allocation
    #   CRAG (arxiv 2401.15884): confidence-triggered corrective web search
    #   Self-RAG (arxiv 2310.11511): adaptive retrieval on-demand
    #   MAgICoRe (arxiv 2409.12147): multi-agent refinement with stopping
    #   BATS (arxiv 2511.17006): budget-aware tool-use scaling

    # Frame extractor: GLiNER2 3-stage pipeline.
    # Stage 1: GLiNER2 microservice extracts spans (always runs).
    # Stage 2: Deterministic normalizer (always runs).
    # Stage 3: LLM repair (only if Stage 2 flags issues).
    frame_gliner_threshold: float = 0.4  # GLiNER2 entity confidence threshold
    frame_repair_max_tokens: int = 1024  # Stage 3 LLM repair output budget

    # Depth mode: "always" = all knowledge tasks use section workers (recommended).
    # "disabled" = monolithic single-call generation (fallback).
    depth_mode: Literal["always", "disabled"] = "always"
    depth_mode_max_parallel: int = 12  # cap concurrent section workers (Qwen2.5-14B FP8 + chunked prefill)

    # Continuous budget scaling: difficulty (0.0-1.0) drives budgets.
    # Actual budget = base + (difficulty * (max - base))
    section_budget_base: int = 1024  # tokens per section at difficulty=0
    section_budget_max: int = 6144  # tokens per section at difficulty=1

    # Multi-query fan-out: for high-difficulty sections, decompose into
    # parallel sub-queries to cover distinct sub-topics.
    multi_query_min_difficulty: float = 0.6
    multi_query_max_queries: int = 3
    writer_budget_base: int = 2048  # writer synthesis budget at difficulty=0
    writer_budget_max: int = 12288  # writer synthesis budget at difficulty=1
    compiler_model_context: int = 16384  # max context length of the compiler/writer model
    evidence_budget_chars: int = 24000  # evidence budget at difficulty=0
    evidence_budget_chars_max: int = 40000  # evidence budget at difficulty=1

    # Sources section: max sources shown and whether to wrap in collapsible <details>
    max_cited_sources: int = 5
    sources_collapsible: bool = True

    # CRAG-style corrective retrieval: critic triggers web search on low-confidence sections.
    # Web budget = web_budget_base + int(difficulty * (crag_max_web_queries - web_budget_base)).
    # The base floor ensures even simple queries get at least 1 web search.
    crag_web_trigger_threshold: float = 0.6  # critic confidence below this triggers web augmentation
    crag_max_web_queries: int = 8  # ceiling on total web searches per run
    web_budget_base: int = 1  # minimum web queries even for simple tasks
    crag_proportionality_enabled: bool = True  # critic flags over-engineering for simple tasks

    # Unified retrieval: adaptive web gating (L-RAG pattern, arxiv 2601.06551).
    # When RAG returns 3+ results above this score, web slots are capped so
    # RAG dominates.  When RAG is empty/weak, web fills the context budget.
    rag_confidence_gate: float = 0.7

    # Critic scaling by difficulty
    critic_skip_below_difficulty: float = 0.15  # skip critic entirely for trivial tasks
    critic_lenient_below_difficulty: float = 0.4  # lenient critic (fast rubber-stamp) below this
    critic_approval_threshold: float = 7.0  # weighted_overall score for auto-approval
    critic_retry_threshold: float = 5.0  # below this, reject and retry with repair instructions
    critic_rag_context_enabled: bool = True  # inject RAG summaries into critic prompt for grounding
    critic_rag_context_budget: int = 4000  # max chars for the RAG reference block in critic prompt
    critic_background: bool = (
        True  # when True, skip critic in graph; SSE closes after writer and critic runs as background task
    )

    # Planner RAG context: scale chunk count by difficulty
    planner_rag_base_chunks: int = 5  # chunks visible to planner at difficulty=0
    planner_rag_max_chunks: int = 10  # chunks visible to planner at difficulty=1

    # Retrieval cache (Router-governed evidence caching)
    retrieval_cache_ttl: float = 86_400.0  # 24 hours
    retrieval_cache_max_entries: int = 512
    retrieval_cache_similarity_threshold: float = 0.85
    retrieval_cache_tool_similarity_threshold: float = 0.95  # stricter threshold for pre-retrieval cache check
    retrieval_cache_confidence_threshold: float = 0.6
    retrieval_cache_backend: str = "numpy"  # "numpy" | "redis" (shared, for horizontal scaling)
    retrieval_cache_warm_on_startup: bool = True
    retrieval_cache_model_version: str = ""  # auto-invalidate cache when model changes; defaults to general_model_name

    # Redis shared cache (used when retrieval_cache_backend="redis", session, and L2 archive)
    retrieval_cache_redis_url: str = ""  # e.g. "redis://synesis-redis.synesis-rag.svc.cluster.local:6379/0"
    retrieval_cache_redis_prefix: str = "synesis:cache:"

    # Session persistence (LangGraph checkpointer)
    session_checkpointer_backend: str = "memory"  # "memory" | "redis"
    session_redis_url: str = ""  # reuses synesis-redis; e.g. "redis://synesis-redis.synesis-rag.svc.cluster.local:6379/1"

    # L2 conversation archive (durable history store)
    l2_archive_redis_url: str = ""  # e.g. "redis://synesis-redis.synesis-rag.svc.cluster.local:6379/2"
    l2_archive_ttl_seconds: int = 604_800  # 7 days

    # Router summarizer: max tokens for evidence packet summaries
    router_max_summary_tokens: int = 2000

    # Router multi-query expansion (Retrieval Enrichment Pipeline)
    router_multi_query_enabled: bool = True  # 3 variants per evidence request
    router_hyde_enabled: bool = True  # HyDE variant (hypothetical document embedding)
    taxonomy_query_expansion_enabled: bool = True  # expand queries with taxonomy hints

    # Opik LLM observability (tracing, evaluation, annotation queues)
    opik_enabled: bool = False
    opik_url: str = "http://opik-backend.synesis-opik.svc.cluster.local:8080"

    # Query normalizer — deterministic typo correction before classification
    query_normalizer_enabled: bool = True
    query_normalizer_max_corrected_tokens: int = 3
    query_normalizer_edit_distance_cutoff: float = 0.7
    query_normalizer_confidence_threshold: float = 0.6
    query_normalizer_search_both: bool = True  # search original + corrected via RRF
    query_normalizer_clarification_on_ambiguity: bool = True

    # Guided JSON decoding — constrains vLLM output to match JSON schema
    guided_json_enabled: bool = True

    # Graph behavior
    max_iterations: int = 3
    oscillation_threshold: float = 0.7  # force-terminate retry loop when oscillation score exceeds this
    require_plan_approval: bool = False  # Plan auto-proceeds to executor; set True for human-in-loop approval
    stream_debug_chatter: bool = False  # Emit plan/router/critic/executor outputs as labeled SSE events (dev mode)
    node_timeout_seconds: float = 180.0  # Supervisor/critic/planner LLM calls; complex tasks need >90s
    critic_max_tokens: int = 4096  # CriticOut can exceed 2048 with what_if_analyses + assessment
    critic_stop_sequence: str = ""  # e.g. '],"nonblocking":' to stop after blocking_issues (saves 30-40s)

    # Budget limits
    max_tokens_per_request: int = 100000
    max_sandbox_minutes: float = 5.0
    max_lsp_calls: int = 5
    max_evidence_experiments: int = 3
    # Evidence experiments: max blast radius (§8.4)
    experiment_max_commands: int = 10  # max commands per experiment_plan
    # Per-node-class (optional; 0 = use global)
    max_executor_tokens: int = 0
    max_controller_tokens: int = 0

    # Patch Integrity Gate — path and file policy
    integrity_path_denylist: list[str] = Field(
        default_factory=lambda: ["**/package-lock.json", "**/yarn.lock", "**/*.lock"]
    )
    integrity_evidence_command_allowlist: list[str] = Field(
        default_factory=lambda: [
            "python",
            "pytest",
            "bash",
            "sh",
            "node",
            "npm",
            "cargo",
            "go",
            "ruff",
            "mypy",
            "shellcheck",
        ]
    )
    integrity_max_code_chars: int = 100_000
    integrity_max_patch_file_chars: int = 50_000  # §7.4: per-file limit for patch_ops
    integrity_target_workspace: str = ""  # Default workspace prefix; Planner can override
    integrity_trusted_packages: list[str] = Field(
        default_factory=lambda: [
            "requests",
            "urllib3",
            "httpx",
            "os",
            "sys",
            "json",
            "re",
            "pathlib",
            "subprocess",
            "typing",
        ]
    )  # Import Integrity: block packages not in this list or requirements.txt

    # Pending question (concurrency / multi-tab safety)
    pending_question_ttl_seconds: int = 86400  # expires_at = now + ttl; stale answer detection

    # Erlang-style supervision
    circuit_breaker_threshold: int = 5
    circuit_breaker_reset_seconds: float = 60.0

    # Context Curator — trusted sources (policy smuggling prevention)
    curator_trusted_sources: list[str] = Field(
        default_factory=lambda: ["tool_contract", "output_format", "embedded_policy", "admin_policy"]
    )
    curator_recurate_on_retry: bool = True  # Re-fetch RAG with execution error on retries (Q1.1)
    curator_curation_mode: Literal["stable", "adaptive"] = (
        "adaptive"  # §8.7: stable=reuse pack; adaptive=pivot on stderr
    )
    curator_budget_alert_threshold: float = 0.85  # Excluded chunk score > this + budget_exceeded → Budget Alert
    curator_context_drift_jaccard_threshold: float = 0.2  # If similarity < this, trigger Re-sync

    # Token budget partitioning (rank-and-evict; see docs/performance.md)
    curator_tier1_2_max_tokens: int = 2000  # Tier 1+2 (Global/Org): never trim; cap for sizing
    curator_tier3_max_tokens: int = 1000  # Tier 3 (Project Manifest): summarize if over
    curator_tier4_max_tokens: int = 2000  # Tier 4 (Session/History): LIFO trim
    curator_rag_max_tokens: int = 3000  # Retrieved RAG: rank-and-evict
    curator_max_total_tokens: int = 8192  # Hard cap for Worker prompt (A10G prefill target)
    curator_min_rerank_score: float = 0.6  # Drop RAG chunks below this score
    curator_tiktoken_enabled: bool = False  # Use tiktoken for accurate counts (optional dep)
    curator_knowledge_gap_threshold: float = 0.6  # Max RAG score < this → incomplete_knowledge, backlog
    knowledge_backlog_enabled: bool = True  # Publish knowledge gaps to Milvus

    # Context refs: use hash→text cache to reduce payload between nodes (context_curator → worker)
    context_refs_enabled: bool = True

    # IDE/agent client coordination — prompt-injection safety
    injection_scan_enabled: bool = True
    injection_action: Literal["reduce", "block", "log"] = "reduce"

    # Decision Summary ("why this approach")
    decision_summary_enabled: bool = True

    # Streaming: use astream_events(v2) for richer status; Open WebUI status + plan bullets
    streaming_events_enabled: bool = True  # astream_events(version='v2') when True

    # DefaultsPolicy YAML override path (optional; /etc/synesis/defaults.yaml)
    defaults_policy_path: str = ""

    # Server
    host: str = "0.0.0.0"  # nosec B104
    port: int = 8000
    log_level: str = "info"
    cors_origins: str = "*"

    def scaled_section_budget(self, difficulty: float) -> int:
        """Per-section token budget scaled by continuous difficulty (0.0-1.0)."""
        d = max(0.0, min(1.0, difficulty))
        return int(self.section_budget_base + d * (self.section_budget_max - self.section_budget_base))

    def scaled_evidence_budget(self, difficulty: float) -> int:
        """Evidence character budget scaled by continuous difficulty."""
        d = max(0.0, min(1.0, difficulty))
        return int(self.evidence_budget_chars + d * (self.evidence_budget_chars_max - self.evidence_budget_chars))

    def scaled_writer_budget(self, difficulty: float) -> int:
        """Writer synthesis token budget scaled by continuous difficulty."""
        d = max(0.0, min(1.0, difficulty))
        return int(self.writer_budget_base + d * (self.writer_budget_max - self.writer_budget_base))

    def scaled_web_budget(self, difficulty: float) -> int:
        """Maximum web search queries for this run, scaled by difficulty.

        Guarantees at least web_budget_base queries (default 1) so even
        simple tasks get some web grounding.
        """
        d = max(0.0, min(1.0, difficulty))
        return self.web_budget_base + int(d * (self.crag_max_web_queries - self.web_budget_base))

    @property
    def build_version(self) -> str:
        """Build identifier for logs — verify you're running the latest container."""
        return _build_info()


settings = Settings()
