"""SQLAlchemy ORM models for the admin database."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Trace(Base):
    __tablename__ = "traces"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trace_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    query_snippet: Mapped[str] = mapped_column(Text, nullable=False, default="")
    timestamp: Mapped[float] = mapped_column(Float, nullable=False, index=True)
    total_duration_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    total_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    estimated_cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
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
    environment: Mapped[str] = mapped_column(String(32), nullable=False)
    role: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(256), nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False, default="")
    served_name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown")
    profile: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    gpu_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_model_deployments_env_role", "environment", "role", unique=True),)


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
    scored_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class BenchmarkResult(Base):
    __tablename__ = "benchmark_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    benchmark_type: Mapped[str] = mapped_column(String(64), nullable=False, default="hybrid")
    metrics: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    per_query: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    triggered_by: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
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
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_retries: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    queued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_ingestion_items_uri_unique", "uri", unique=True),
        Index("ix_ingestion_items_status", "status"),
        Index("ix_ingestion_items_source_id", "source_id"),
        Index("ix_ingestion_items_domain", "domain"),
        Index("ix_ingestion_items_handler", "handler"),
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
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_ingestion_runs_source_id", "source_id"),
        Index("ix_ingestion_runs_status", "status"),
    )
