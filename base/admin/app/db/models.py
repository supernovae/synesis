"""SQLAlchemy ORM models for the admin database."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Trace(Base):
    __tablename__ = "traces"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trace_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    conversation_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    parent_trace_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    root_trace_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    user_id: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    query_snippet: Mapped[str] = mapped_column(Text, nullable=False, default="")
    timestamp: Mapped[float] = mapped_column(Float, nullable=False, index=True)
    total_duration_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    total_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    estimated_cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    actual_cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    difficulty: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    task_type: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    is_code_task: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    has_error: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    iteration_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    full_record: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_traces_user_id", "user_id"),
        Index("ix_traces_task_type", "task_type"),
        Index("ix_traces_has_error", "has_error"),
        Index("ix_traces_timestamp_desc", timestamp.desc()),
    )


class ModelCost(Base):
    __tablename__ = "model_costs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    role: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(256), nullable=False)
    profile: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="local")
    input_per_million: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    input_cached_per_million: Mapped[float | None] = mapped_column(Float, nullable=True)
    output_per_million: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    monthly_fixed_cost: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    cost_formula: Mapped[str] = mapped_column(Text, nullable=False, default="")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_model_costs_role_profile", "role", "profile"),)


class TaxonomyDomain(Base):
    __tablename__ = "taxonomy_domains"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    path: Mapped[str] = mapped_column(String(512), nullable=False, default="")
    complexity: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    persona: Mapped[str] = mapped_column(Text, nullable=False, default="")
    raw_config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class CostSnapshot(Base):
    __tablename__ = "cost_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    model: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    __table_args__ = (Index("ix_cost_snapshots_model_date", "model", "date"),)


class UsageRollup(Base):
    """Pre-aggregated usage buckets for fast dashboard charts.

    Populated by a periodic rollup task; one row per (bucket, model,
    user_id, org_id) tuple.  Bucket is truncated to 5 minutes by default.
    """

    __tablename__ = "usage_rollups"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    model: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    role: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    user_id: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    org_id: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    request_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cached_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    estimated_cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    actual_cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    avg_duration_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    error_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        Index("ix_usage_rollups_bucket", "bucket"),
        Index("ix_usage_rollups_user_org", "user_id", "org_id"),
        Index("ix_usage_rollups_model_bucket", "model", "bucket"),
    )


class Failure(Base):
    __tablename__ = "failures"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    failure_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    code: Mapped[str] = mapped_column(Text, nullable=False, default="")
    error_output: Mapped[str] = mapped_column(Text, nullable=False, default="")
    exit_code: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    error_type: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    language: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    task_description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    resolution: Mapped[str] = mapped_column(Text, nullable=False, default="")
    timestamp: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_failures_error_type", "error_type"),
        Index("ix_failures_language", "language"),
        Index("ix_failures_timestamp", timestamp.desc()),
    )


class KnowledgeGap(Base):
    __tablename__ = "knowledge_gaps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    gap_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    query: Mapped[str] = mapped_column(Text, nullable=False, default="")
    task_description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    collections_queried: Mapped[str] = mapped_column(Text, nullable=False, default="")
    max_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    platform_context: Mapped[str] = mapped_column(String(64), nullable=False, default="generic")
    language: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open")
    resolved_at: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    resolved_by: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    resolution_note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    web_search_fallback: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    timestamp: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_knowledge_gaps_status", "status"),
        Index("ix_knowledge_gaps_language", "language"),
        Index("ix_knowledge_gaps_timestamp", timestamp.desc()),
    )


class WebSearchLog(Base):
    __tablename__ = "web_search_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    timestamp: Mapped[float] = mapped_column(Float, nullable=False)
    run_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    query: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    profile: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    url: Mapped[str] = mapped_column(Text, nullable=False, default="")
    domain: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    title: Mapped[str] = mapped_column(Text, nullable=False, default="")
    snippet: Mapped[str] = mapped_column(Text, nullable=False, default="")
    score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    latency_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    outcome: Mapped[str] = mapped_column(String(16), nullable=False, default="success")
    engine: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_web_search_log_run_id", "run_id"),
        Index("ix_web_search_log_domain", "domain"),
        Index("ix_web_search_log_timestamp", timestamp.desc()),
        Index("ix_web_search_log_outcome", "outcome"),
    )


class WebUrlPolicy(Base):
    __tablename__ = "web_url_policy"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    url_pattern: Mapped[str] = mapped_column(Text, nullable=False)
    policy: Mapped[str] = mapped_column(String(16), nullable=False, default="allow")
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    reviewed_by: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    reviewed_at: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    boost_factor: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    auto_ingest: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_web_url_policy_policy", "policy"),)


class ModelDeployment(Base):
    __tablename__ = "model_deployments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    environment: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    role: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(256), nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False, default="")
    served_name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown")
    profile: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    gpu_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="local")
    provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    api_key_env: Mapped[str | None] = mapped_column(String(128), nullable=True)
    litellm_params: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    litellm_model_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    fallbacks: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_model_deployments_active_role", "role", unique=True, postgresql_where=(is_active == True)),  # noqa: E712
        Index("ix_model_deployments_is_active", "is_active"),
        Index("ix_model_deployments_source", "source"),
    )


class ModelRoleHistory(Base):
    __tablename__ = "model_role_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    role: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    model: Mapped[str] = mapped_column(String(256), nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False, default="")
    input_per_million: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    output_per_million: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    activated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CostRateSnapshot(Base):
    __tablename__ = "cost_rate_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    model: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    input_per_million: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    output_per_million: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="manual")
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (Index("ix_cost_rate_snapshots_model_captured", "model", "captured_at"),)


class QualitySnapshot(Base):
    __tablename__ = "quality_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    domain: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    health: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown")
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    doc_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    freshness_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    authority_mix: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    dead_weight_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    raw_scorecard: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    scored_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class BenchmarkResult(Base):
    __tablename__ = "benchmark_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    benchmark_type: Mapped[str] = mapped_column(String(64), nullable=False, default="hybrid")
    metrics: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    per_query: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    triggered_by: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DiscoveredConflictGroup(Base):
    __tablename__ = "discovered_conflict_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_name: Mapped[str] = mapped_column(Text, nullable=False)
    members: Mapped[dict] = mapped_column(JSONB, nullable=False)
    default_pick: Mapped[str] = mapped_column(Text, nullable=True, default="")
    exclusion_map: Mapped[dict] = mapped_column(JSONB, nullable=True, default=dict)
    source_query: Mapped[str] = mapped_column(Text, nullable=True, default="")
    source_run_id: Mapped[str] = mapped_column(Text, nullable=True, default="")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending_review")
    reviewer_note: Mapped[str] = mapped_column(Text, nullable=True, default="")
    discovered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_discovered_conflict_groups_status", "status"),
        Index("ix_discovered_conflict_groups_group_name", "group_name"),
    )


class MilvusSchemaSync(Base):
    """Tracks the last-known Milvus schema version for drift detection.

    On startup and when the indexer reports a schema change, the admin service
    compares stored vs. current version. If they differ, all 'indexed' ingestion
    items are reset to 'pending' for re-indexing, since the Milvus collection
    was dropped+recreated and all previous chunks are gone.
    """

    __tablename__ = "milvus_schema_sync"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    collection: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_reported_by: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class IngestionSource(Base):
    __tablename__ = "ingestion_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    handler: Mapped[str] = mapped_column(String(64), nullable=False, default="seed_corpus")
    origin_type: Mapped[str] = mapped_column(String(32), nullable=False, default="curated")
    authority: Mapped[str] = mapped_column(String(32), nullable=False, default="vetted")
    domain: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    tags: Mapped[list[str] | None] = mapped_column(ARRAY(String(64)), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_ingestion_sources_status", "status"),
        Index("ix_ingestion_sources_domain", "domain"),
    )


class IngestionItem(Base):
    __tablename__ = "ingestion_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("ingestion_sources.id"), nullable=True)
    uri: Mapped[str] = mapped_column(Text, nullable=False)
    handler: Mapped[str | None] = mapped_column(String(64), nullable=True)
    title: Mapped[str] = mapped_column(Text, nullable=False, default="")
    domain: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    authority: Mapped[str] = mapped_column(String(32), nullable=False, default="vetted")
    origin_type: Mapped[str] = mapped_column(String(32), nullable=False, default="curated")
    tags: Mapped[list[str] | None] = mapped_column(ARRAY(String(64)), nullable=True)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    milvus_doc_id: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    indexer_stats: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_retries: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    queued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_ingestion_items_uri_unique", "uri", unique=True),
        Index("ix_ingestion_items_status", "status"),
        Index("ix_ingestion_items_source_id", "source_id"),
        Index("ix_ingestion_items_domain", "domain"),
        Index("ix_ingestion_items_handler", "handler"),
    )


class IngestionDocument(Base):
    """Per-page (or per-logical-doc) artifact row for staged S3 ingestion."""

    __tablename__ = "ingestion_documents"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ingestion_item_id: Mapped[int] = mapped_column(Integer, ForeignKey("ingestion_items.id", ondelete="CASCADE"), nullable=False)
    doc_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    canonical_uri: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False, default="")
    domain: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    handler: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    authority: Mapped[str] = mapped_column(String(32), nullable=False, default="vetted")
    origin_type: Mapped[str] = mapped_column(String(32), nullable=False, default="curated")
    tags: Mapped[list[str] | None] = mapped_column(ARRAY(String(64)), nullable=True)
    config_snapshot: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    raw_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    raw_content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    raw_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    raw_s3_keys: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    norm_version: Mapped[str] = mapped_column(String(32), nullable=False, default="v1")
    norm_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    norm_content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    norm_s3_md_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    norm_s3_meta_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    normalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    enrich_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    milvus_doc_id: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_ingestion_documents_item_id", "ingestion_item_id"),
        Index("ix_ingestion_documents_canonical_uri", "canonical_uri"),
        Index("ix_ingestion_documents_raw_norm", "raw_status", "norm_status"),
    )


class IngestionEnrichQueue(Base):
    """GPU / Milvus enrichment work queue (SKIP LOCKED batch claims)."""

    __tablename__ = "ingestion_enrich_queue"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("ingestion_documents.id", ondelete="CASCADE"), nullable=False)
    norm_version: Mapped[str] = mapped_column(String(32), nullable=False, default="v1")
    enrich_version: Mapped[str] = mapped_column(String(32), nullable=False, default="v1")
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    worker_id: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")

    __table_args__ = (
        Index(
            "ix_ingestion_enrich_queue_pending",
            "status",
            "priority",
            "created_at",
            postgresql_where=text("status = 'pending'"),
        ),
    )


class IngestionRun(Base):
    __tablename__ = "ingestion_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("ingestion_sources.id"), nullable=True)
    trigger: Mapped[str] = mapped_column(String(16), nullable=False, default="manual")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="running")
    items_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    items_indexed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    items_failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_ingestion_runs_source_id", "source_id"),
        Index("ix_ingestion_runs_status", "status"),
    )


class YarnSession(Base):
    __tablename__ = "yarn_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_key: Mapped[str] = mapped_column(String(256), nullable=False)
    user_id: Mapped[str] = mapped_column(String(256), nullable=False)
    username: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="user")
    conversation_id: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    provider: Mapped[str] = mapped_column(String(64), nullable=False, default="deepinfra")
    model: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    total_tokens_in: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_tokens_out: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_tokens_cached: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    request_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    escalation_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_active_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_yarn_sessions_key", "session_key", unique=True),
        Index("ix_yarn_sessions_user_id", "user_id"),
        Index("ix_yarn_sessions_last_active", "last_active_at"),
    )


class YarnUsageLog(Base):
    __tablename__ = "yarn_usage_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_key: Mapped[str] = mapped_column(String(256), nullable=False)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[str] = mapped_column(String(256), nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(256), nullable=False)
    tokens_in: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tokens_cached: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    latency_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    escalated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tool_calls_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    finish_reason: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_yarn_usage_session", "session_key"),
        Index("ix_yarn_usage_user", "user_id"),
        Index("ix_yarn_usage_created", "created_at"),
        Index("ix_yarn_usage_provider", "provider"),
    )


class PersonalAccessToken(Base):
    """User-generated API tokens for programmatic access (Cursor, Claude Code, scripts)."""

    __tablename__ = "personal_access_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    username: Mapped[str] = mapped_column(String, nullable=False)
    org_id: Mapped[str] = mapped_column(String, nullable=False, default="")
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    token_prefix: Mapped[str] = mapped_column(String(12), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    role: Mapped[str] = mapped_column(String, nullable=False, default="user")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class AdminAuditEvent(Base):
    """Append-only log of admin UI actions and propagation (e.g. LiteLLM reconcile)."""

    __tablename__ = "admin_audit_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="api")
    actor_username: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    actor_user_id: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    actor_role: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    action: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    detail: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    __table_args__ = (
        Index("ix_admin_audit_events_created_at", "created_at"),
        Index("ix_admin_audit_events_action", "action"),
    )


class OpenWebUIFeedback(Base):
    """Mirrored rows from Open WebUI /api/v1/evaluations/feedbacks/all/export."""

    __tablename__ = "openwebui_feedback"

    owui_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    feedback_type: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    meta: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at_epoch: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    updated_at_epoch: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_openwebui_feedback_created", "created_at_epoch"),)


class ProviderConfig(Base):
    """Per-provider governance: enablement, default policies, notes.

    Rows only exist for providers that have been explicitly configured
    (toggled, had defaults overridden, etc.).  Absent rows inherit the
    static catalog defaults and are considered enabled.
    """

    __tablename__ = "provider_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    provider_key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    default_max_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=8192)
    default_temperature: Mapped[float] = mapped_column(Float, nullable=False, default=0.1)
    allowed_roles: Mapped[list[str] | None] = mapped_column(ARRAY(String(64)), nullable=True)
    policies: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ServingEndpoint(Base):
    """Curated model-serving entries that appear in the picklist.

    Admins can pin specific endpoint + model combos so that role
    assignment uses a governed set instead of free-form typing.
    """

    __tablename__ = "serving_endpoints"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(256), nullable=False)
    endpoint_url: Mapped[str] = mapped_column(Text, nullable=False, default="")
    api_key_env: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    allowed_roles: Mapped[list[str] | None] = mapped_column(ARRAY(String(64)), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_serving_endpoints_provider", "provider"),
        Index("ix_serving_endpoints_active", "is_active"),
    )


class FeedbackReview(Base):
    """Admin triage state for planner thumbs or mirrored Open WebUI feedback."""

    __tablename__ = "feedback_review"

    subject_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    internal_note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_by: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
