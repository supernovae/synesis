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

    # Model endpoints (OpenShift AI 3 — deploy synesis-supervisor, synesis-planner, synesis-executor, synesis-critic)
    supervisor_model_url: str = "http://synesis-supervisor-predictor.synesis-models.svc.cluster.local:8080/v1"
    # Micro model for summarization (pivot history, Tier 3 manifest). Empty = use stub/truncation.
    summarizer_model_url: str = ""
    summarizer_model_name: str = "synesis-summarizer"
    supervisor_model_name: str = "synesis-supervisor"
    planner_model_url: str = "http://synesis-supervisor-predictor.synesis-models.svc.cluster.local:8080/v1"
    planner_model_name: str = "synesis-supervisor"
    executor_model_url: str = "http://synesis-executor-predictor.synesis-models.svc.cluster.local:8080/v1"
    executor_model_name: str = "synesis-executor"
    critic_model_url: str = "http://synesis-critic-predictor.synesis-models.svc.cluster.local:8080/v1"
    critic_model_name: str = "synesis-critic"

    # RAG / Milvus (service from milvus-standalone.yaml or LlamaStack)
    milvus_host: str = "synesis-milvus.synesis-rag.svc.cluster.local"
    milvus_port: int = 19530
    embedder_url: str = "http://embedder.synesis-rag.svc.cluster.local:8080/v1"

    @field_validator(
        "embedder_url",
        "web_search_url",
        "lsp_gateway_url",
        "sandbox_warm_pool_url",
        "rag_bge_reranker_url",
        "supervisor_model_url",
        "planner_model_url",
        "executor_model_url",
        "critic_model_url",
        "summarizer_model_url",
        mode="before",
    )
    @classmethod
    def normalize_url_protocol(cls, v: str) -> str:
        return ensure_url_protocol(v) if isinstance(v, str) else v
    embedder_model: str = "all-MiniLM-L6-v2"
    rag_top_k: int = 5
    rag_overfetch_count: int = 30  # Over-fetch for excluded telemetry (Q1.3); Curator trims to top_k
    rag_score_threshold: float = 0.5

    # Retrieval strategy: "hybrid" (BM25 + vector), "vector", or "bm25"
    rag_retrieval_strategy: Literal["hybrid", "vector", "bm25"] = "hybrid"

    # Cross-encoder re-ranker: "flashrank", "bge", or "none"
    rag_reranker: Literal["flashrank", "bge", "none"] = "flashrank"
    rag_reranker_model: str = "ms-marco-MiniLM-L-12-v2"

    # BM25 in-memory index settings
    rag_bm25_refresh_interval_seconds: int = 600

    # Reciprocal Rank Fusion constant (higher = more weight to lower-ranked docs)
    rag_rrf_k: int = 60

    # BGE reranker service URL (only used when rag_reranker="bge")
    rag_bge_reranker_url: str = ""

    # Multi-collection RAG (knowledge indexers)
    rag_code_collections_enabled: bool = True
    rag_apispec_collections: list[str] = []
    rag_arch_collections: list[str] = []
    rag_multi_collection_max: int = 3
    rag_critic_arch_enabled: bool = True
    rag_license_collection_enabled: bool = True
    rag_critic_license_enabled: bool = True

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

    # Worker: Qwen3 Thinking Mode for complex tasks (deliberate reasoning, higher latency)
    worker_thinking_mode_enabled: bool = True

    # Web search (SearXNG)
    web_search_enabled: bool = True
    web_search_url: str = "http://searxng.synesis-search.svc.cluster.local:8080"
    web_search_timeout_seconds: int = 5
    web_search_max_results: int = 5
    web_search_supervisor_enabled: bool = True
    web_search_worker_error_enabled: bool = True
    web_search_critic_enabled: bool = False

    # LSP deep analysis
    lsp_enabled: bool = True
    lsp_mode: Literal["on_failure", "always", "disabled"] = "on_failure"
    lsp_gateway_url: str = "http://lsp-gateway.synesis-lsp.svc:8000"
    lsp_timeout_seconds: int = 30

    # Graph behavior
    max_iterations: int = 3
    require_plan_approval: bool = True
    node_timeout_seconds: float = 90.0  # Critic can be verbose; was 60s, caused timeouts on fibonacci
    critic_max_tokens: int = 4096  # CriticOut can exceed 2048 with what_if_analyses + assessment
    critic_stop_sequence: str = ""  # e.g. '],"nonblocking":' to stop after blocking_issues (saves 30-40s)

    # Budget limits
    max_tokens_per_request: int = 100000
    max_sandbox_minutes: float = 5.0
    max_lsp_calls: int = 5
    max_evidence_experiments: int = 3
    # Evidence experiments: max blast radius (§8.4)
    experiment_timeout_seconds: int = 120
    experiment_max_stdout_bytes: int = 1_000_000  # 1MB
    experiment_max_files_created: int = 50  # under .synesis/experiments/<attempt_id>
    experiment_max_commands: int = 10  # max commands per experiment_plan
    # Per-node-class (optional; 0 = use global)
    max_executor_tokens: int = 0
    max_controller_tokens: int = 0
    max_retrieval_tokens: int = 0

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
    integrity_path_allowlist: list[str] = Field(default_factory=list)
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
    curator_arch_standards_collections: list[str] = Field(default_factory=lambda: ["arch_standards_v1"])
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

    # Context refs: use hash→text cache to reduce payload between nodes (context_curator → worker)
    context_refs_enabled: bool = True

    # IDE/agent client coordination — prompt-injection safety
    injection_scan_enabled: bool = True
    injection_action: Literal["reduce", "block", "log"] = "reduce"

    # JCS UX: Decision Summary ("why this approach")
    decision_summary_enabled: bool = True

    # DefaultsPolicy YAML override path (optional; /etc/synesis/defaults.yaml)
    defaults_policy_path: str = ""

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "info"

    @property
    def build_version(self) -> str:
        """Build identifier for logs — verify you're running the latest container."""
        return _build_info()


settings = Settings()
