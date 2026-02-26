"""Centralized configuration via environment variables.

Every tunable knob lives here. Override via ConfigMap env vars in K8s.
"""

from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Model endpoints (KServe InferenceService URLs)
    coder_model_url: str = "http://qwen-coder-32b.synesis-models.svc.cluster.local:8080/v1"
    coder_model_name: str = "qwen-coder-32b"
    supervisor_model_url: str = "http://mistral-nemo-12b.synesis-models.svc.cluster.local:8080/v1"
    supervisor_model_name: str = "mistral-nemo-12b"

    # RAG / Milvus
    milvus_host: str = "milvus.synesis-rag.svc.cluster.local"
    milvus_port: int = 19530
    embedder_url: str = "http://embedder.synesis-rag.svc.cluster.local:8080/v1"
    embedder_model: str = "all-MiniLM-L6-v2"
    rag_top_k: int = 5
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
    sandbox_cpu_limit: str = "1"
    sandbox_memory_limit: str = "512Mi"

    # Warm pool (pre-warmed sandbox pods for low-latency execution)
    sandbox_warm_pool_enabled: bool = True
    sandbox_warm_pool_url: str = "http://synesis-warm-pool.synesis-sandbox.svc.cluster.local:8080"

    # Failure store
    failure_store_enabled: bool = True
    failfast_cache_max_size: int = 1000
    failfast_cache_ttl_seconds: float = 86400.0

    # Conversation memory (L1 in-memory)
    memory_enabled: bool = True
    memory_max_turns_per_user: int = 20
    memory_max_users: int = 5000
    memory_ttl_seconds: float = 14400.0

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
    node_timeout_seconds: float = 60.0

    # Erlang-style supervision
    circuit_breaker_threshold: int = 5
    circuit_breaker_reset_seconds: float = 60.0

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "info"

    class Config:
        env_prefix = "SYNESIS_"


settings = Settings()
