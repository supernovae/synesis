"""NornicDB content graph schema and catalog entity helpers."""

from __future__ import annotations

from typing import Any

from synesis_telemetry import get_logger

logger = get_logger("synesis.indexer.schema")

SYNESIS_CATALOG = "content_graph"
SCHEMA_VERSION = 18
EMBEDDING_DIM = 1024
EMBEDDING_MODEL = "BAAI/bge-m3"
EMBEDDING_PROFILE = "bge-m3-1024-cosine-v1"
CORPUS_VERSION = f"synesis-content-graph-v{SCHEMA_VERSION}-{EMBEDDING_PROFILE}"

GRAPH_NODE_LABELS = (
    "ContentNode",
    "Pack",
    "Document",
    "File",
    "Chunk",
    "Symbol",
    "Function",
    "Class",
    "Method",
    "Resource",
    "Concept",
    "Version",
)

GRAPH_EDGE_TYPES = (
    "CONTAINS",
    "DEFINES",
    "CALLS",
    "IMPORTS",
    "REFERENCES",
    "OVERRIDES",
    "IMPLEMENTS",
    "DOCUMENTS",
    "VALID_IN",
    "DERIVED_FROM",
)


def _trunc_bytes(s: str, max_bytes: int) -> str:
    encoded = s.encode("utf-8")
    if len(encoded) <= max_bytes:
        return s
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def ensure_synesis_catalog(client: Any | None = None, uri: str = "") -> Any:
    """Ensure NornicDB graph constraints and indexes exist.

    ``client`` may be a :class:`NornicGraphWriter` or any object exposing
    ``ensure_schema()``. The old collection-oriented return shape is preserved
    so existing pipeline callers can keep passing ``writer.client``.
    """
    if client is None:
        from .nornic_writer import NORNIC_URI, NornicGraphWriter

        client = NornicGraphWriter(uri=uri or NORNIC_URI)
    if hasattr(client, "ensure_schema"):
        client.ensure_schema()
    logger.info("indexer_graph_schema_ready", extra={"catalog": SYNESIS_CATALOG, "version": SCHEMA_VERSION})
    return client


def catalog_entity(
    chunk_id: str,
    text: str,
    embedding: list[float],
    *,
    doc_id: str = "",
    chunk_index: int = 0,
    context_prefix: str = "",
    chunk_summary: str = "",
    heading_path: str = "",
    section: str = "",
    document_name: str = "",
    source_type: str = "",
    handler: str = "",
    domain: str = "generalist",
    tags: str = "",
    keywords: str = "",
    origin_type: str = "",
    authority: str = "community",
    pack_id: str = "global",
    pack_version: str = "",
    pack_source_version: str = "",
    pack_artifact_hash: str = "",
    pack_partition: str = "",
    symbol_kind: str = "",
    symbol_fqn: str = "",
    package_name: str = "",
    doc_relation_ids: str = "",
    source_url: str = "",
    agent_hook: str = "",
    perf_tier: str = "",
    safety_contract: str = "",
    lifecycle_model: str = "",
    agent_enrichment_json: str = "",
    scan_status: str = "unscanned",
    content_format: str = "",
    symbol_type: str = "",
    approval_status: str = "auto_approved",
    language: str = "",
    repo_path: str = "",
    module_path: str = "",
    symbol_name: str = "",
    artifact_kind: str = "",
    has_code: bool = False,
    code_signal_count: int = 0,
    code_density: float = 0.0,
    code_language: str = "",
    visibility_scope: str = "global",
    org_id: str = "",
    tenant_id: str = "",
    owner_user_id: str = "",
    conversation_id: str = "",
    upload_batch_id: str = "",
    upload_mode: str = "",
    is_ephemeral: bool = False,
    expires_at_epoch: int = 0,
    acl_mode: str = "open",
    acl_groups: str = "",
    scan_signals: str = "",
    review_trace_id: str = "",
    effective_at_epoch: int = 0,
    corpus_class: str = "",
    constraint_kind: str = "",
    content_profile: str = "",
    scope_tags: str = "",
    constraint_source: str = "",
    constraint_confidence: float = -1.0,
    golden_path_id: str = "",
    novel_pattern: bool = False,
    novel_trace_level: str = "none",
    content_type: str = "",
    quality_score: float = -1.0,
    technical_depth: float = -1.0,
    domain_relevance: float = -1.0,
    index_decision: str = "index",
    spam_score: float = -1.0,
    simhash64: str = "",
    dup_cluster_id: str = "",
    topic_id: str = "",
    topic_keywords: str = "",
    crawl_timestamp: int = 0,
    entities_json: str = "",
    section_boundaries_json: str = "",
    raw_content_hash: str = "",
    clean_content_hash: str = "",
    enrichment_profile: str = "",
    source_version: str = "",
    commit: str = "",
    branch: str = "",
    valid_from: str = "",
    valid_to: str = "",
    node_kind: str = "Chunk",
) -> dict[str, Any]:
    """Build a graph node property dict for upsert."""
    pack = _trunc_bytes(pack_id or "global", 96)
    return {
        "id": _trunc_bytes(chunk_id, 128),
        "chunk_id": _trunc_bytes(chunk_id, 128),
        "doc_id": _trunc_bytes(doc_id or "", 128),
        "chunk_index": int(chunk_index),
        "text": _trunc_bytes(text, 8192),
        "content": _trunc_bytes(text, 8192),
        "context_prefix": _trunc_bytes(context_prefix or "", 512),
        "chunk_summary": _trunc_bytes(chunk_summary or "", 1024),
        "summary": _trunc_bytes(chunk_summary or "", 1024),
        "heading_path": _trunc_bytes(heading_path or "", 512),
        "section": _trunc_bytes(section or "", 256),
        "document_name": _trunc_bytes(document_name or "", 256),
        "name": _trunc_bytes(document_name or symbol_name or chunk_id, 256),
        "source_type": (source_type or "")[:32],
        "handler": (handler or "")[:32],
        "domain": (domain or "generalist")[:64],
        "tags": _trunc_bytes(tags or "", 512),
        "keywords": _trunc_bytes(keywords or "", 512),
        "origin_type": (origin_type or "")[:32],
        "authority": (authority or "community")[:32],
        "pack": pack,
        "pack_id": pack,
        "pack_version": _trunc_bytes(pack_version or "", 64),
        "source_version": _trunc_bytes(source_version or pack_source_version or "", 64),
        "pack_source_version": _trunc_bytes(pack_source_version or source_version or "", 64),
        "pack_artifact_hash": _trunc_bytes(pack_artifact_hash or "", 128),
        "pack_partition": _trunc_bytes(pack_partition or pack, 96),
        "symbol_kind": (symbol_kind or symbol_type or "")[:64],
        "kind": (node_kind or symbol_kind or symbol_type or "Chunk")[:64],
        "symbol_fqn": _trunc_bytes(symbol_fqn or "", 256),
        "package_name": _trunc_bytes(package_name or "", 128),
        "doc_relation_ids": _trunc_bytes(doc_relation_ids or "", 1024),
        "source_url": _trunc_bytes(source_url or "", 512),
        "url": _trunc_bytes(source_url or "", 512),
        "agent_hook": _trunc_bytes(agent_hook or "", 1024),
        "perf_tier": _trunc_bytes(perf_tier or "", 64),
        "safety_contract": _trunc_bytes(safety_contract or "", 2048),
        "lifecycle_model": _trunc_bytes(lifecycle_model or "", 2048),
        "agent_enrichment_json": _trunc_bytes(agent_enrichment_json or "", 8192),
        "scan_status": (scan_status or "unscanned")[:16],
        "content_format": (content_format or "")[:32],
        "symbol_type": (symbol_type or symbol_kind or "")[:64],
        "approval_status": (approval_status or "auto_approved")[:16],
        "language": (language or "")[:32],
        "repo_path": _trunc_bytes(repo_path or "", 256),
        "path": _trunc_bytes(module_path or repo_path or source_url or "", 512),
        "module_path": _trunc_bytes(module_path or "", 256),
        "symbol_name": _trunc_bytes(symbol_name or "", 128),
        "artifact_kind": (artifact_kind or "")[:32],
        "has_code": bool(has_code),
        "code_signal_count": int(code_signal_count),
        "code_density": float(code_density),
        "code_language": (code_language or "")[:32],
        "visibility_scope": (visibility_scope or "global")[:16],
        "org_id": _trunc_bytes(org_id or "", 64),
        "tenant_id": _trunc_bytes(tenant_id or "", 64),
        "owner_user_id": _trunc_bytes(owner_user_id or "", 64),
        "conversation_id": _trunc_bytes(conversation_id or "", 128),
        "upload_batch_id": _trunc_bytes(upload_batch_id or "", 64),
        "upload_mode": _trunc_bytes(upload_mode or "", 24),
        "is_ephemeral": bool(is_ephemeral),
        "expires_at_epoch": int(expires_at_epoch),
        "acl_mode": (acl_mode or "open")[:16],
        "acl_groups": _trunc_bytes(acl_groups or "", 1024),
        "scan_signals": _trunc_bytes(scan_signals or "", 1024),
        "review_trace_id": _trunc_bytes(review_trace_id or "", 128),
        "effective_at_epoch": int(effective_at_epoch),
        "corpus_class": (corpus_class or "")[:32],
        "constraint_kind": (constraint_kind or "")[:16],
        "content_profile": (content_profile or "")[:32],
        "scope_tags": _trunc_bytes(scope_tags or "", 256),
        "constraint_source": (constraint_source or "")[:64],
        "constraint_confidence": float(constraint_confidence),
        "golden_path_id": _trunc_bytes(golden_path_id or "", 128),
        "novel_pattern": bool(novel_pattern),
        "novel_trace_level": (novel_trace_level or "none")[:16],
        "content_type": _trunc_bytes(content_type or "", 64),
        "quality_score": float(quality_score),
        "technical_depth": float(technical_depth),
        "domain_relevance": float(domain_relevance),
        "index_decision": (index_decision or "index")[:16],
        "spam_score": float(spam_score),
        "simhash64": _trunc_bytes(simhash64 or "", 24),
        "dup_cluster_id": _trunc_bytes(dup_cluster_id or "", 64),
        "topic_id": _trunc_bytes(topic_id or "", 64),
        "topic_keywords": _trunc_bytes(topic_keywords or "", 512),
        "crawl_timestamp": int(crawl_timestamp),
        "entities_json": _trunc_bytes(entities_json or "", 4096),
        "section_boundaries_json": _trunc_bytes(section_boundaries_json or "", 2048),
        "raw_content_hash": _trunc_bytes(raw_content_hash or "", 64),
        "clean_content_hash": _trunc_bytes(clean_content_hash or "", 64),
        "enrichment_profile": _trunc_bytes(enrichment_profile or "", 64),
        "embedding": embedding,
        "commit": _trunc_bytes(commit or "", 64),
        "branch": _trunc_bytes(branch or "", 128),
        "valid_from": _trunc_bytes(valid_from or "", 64),
        "valid_to": _trunc_bytes(valid_to or "", 64),
        "corpus_version": CORPUS_VERSION,
        "graph_schema_version": SCHEMA_VERSION,
    }
