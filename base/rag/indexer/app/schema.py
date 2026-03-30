"""Unified catalog schema for Synesis RAG.

Single collection with partition key on authority, enrichment fields for
Contextual Retrieval (context_prefix, chunk_summary, keywords, heading_path),
and proper decomposition of legacy overloaded fields.

SCHEMA_VERSION tracks breaking changes. When bumped, ensure_synesis_catalog
detects the mismatch and drops/recreates the collection automatically.

Version history:
  v3 → v4: Removed intended_roles (Router owns all retrieval; per-node
            role tagging is dead weight).
  v4 → v5: Added native Milvus BM25 (english analyzer on text field,
            sparse_text SPARSE_FLOAT_VECTOR auto-populated by BM25
            Function). Replaces the external bm25-service microservice.
  v5 → v6: Added scan_status for index-time injection scanning
            (clean/flagged/unscanned). Admin review queue uses this to
            surface suspicious documents for human vetting.
  v6 → v7: Added content_format (python/yaml/hcl/xml/...) for format-aware
            retrieval filtering; symbol_type (function/class/resource/module)
            for code/structured data semantic context; approval_status
            (auto_approved/pending/approved/rejected) for HITL review
            workflow — rejected chunks excluded from RAG retrieval.
  v7 → v8: Added language (python/go/english/...) for language-targeted
            retrieval; repo_path (owner/repo) for project scoping;
            module_path (path within repo/project) for file-level
            navigation; symbol_name (function/class/resource name) for
            direct symbol lookup; artifact_kind (code/docs/config/
            api_spec/architecture) for MCP/agent domain-targeted queries.
  v8 → v9: Semantic ingestion metadata — content_type, calibrated scores
            (quality_score, technical_depth, domain_relevance), index_decision,
            spam_score, dedupe/topic fields, crawl_timestamp, entities_json,
            section_boundaries_json, content hashes, enrichment_profile.
  v9 → v10: Multi-tenant isolation — visibility_scope (global/org/tenant),
            org_id (Keycloak organization), tenant_id (sub-org workspace).
            Three-tier access model: global content visible to all, org content
            scoped to members, tenant content restricted to sub-org scope.
            Fail-closed: non-global chunks require org/tenant match at retrieval.
  v10 → v11: Per-document ACL — acl_mode (open/restricted/private),
            acl_groups (comma-separated group IDs for restricted docs).
            Open: visible to anyone matching visibility_scope. Restricted:
            additionally requires caller to hold at least one listed group.
            Private: only visible to exact group membership match.
            Fail-closed: chunks with acl_mode=restricted/private and no
            matching groups are excluded from retrieval.
  v11 → v12: Personal/session upload ownership metadata — owner_user_id,
            conversation_id, upload_batch_id, upload_mode, is_ephemeral,
            expires_at_epoch. Enables scoped per-user collections and
            conversation-bound temporary corpora with TTL enforcement.
  v12 → v13: Trust attribution metadata — scan_signals (persisted injection
            pattern names from index-time scan), review_trace_id (links to
            HITL review event in admin), effective_at_epoch (content date
            for freshness pivots). Completes the ingestion→retrieval→planner
            attribution pipeline for TrustPacketV1/AttributionV1.

Research: arxiv 2601.11863 (metadata-prefixed embeddings), Anthropic Contextual
Retrieval (35-67% failure reduction), Milvus partition key docs v2.5.
"""

from __future__ import annotations

from typing import Any

from pymilvus import CollectionSchema, DataType, FieldSchema, Function, FunctionType, MilvusClient
from synesis_telemetry import get_logger

logger = get_logger("synesis.indexer.schema")

SYNESIS_CATALOG = "synesis_catalog"


def _trunc_bytes(s: str, max_bytes: int) -> str:
    """Truncate a string so its UTF-8 encoding fits within max_bytes."""
    encoded = s.encode("utf-8")
    if len(encoded) <= max_bytes:
        return s
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


EMBEDDING_DIM = 384

# Bump when fields are added/removed/renamed. Triggers automatic drop+recreate.
SCHEMA_VERSION = 13

# Canonical field names — used for schema validation on existing collections.
EXPECTED_FIELDS = frozenset(
    {
        "chunk_id",
        "doc_id",
        "chunk_index",
        "text",
        "context_prefix",
        "chunk_summary",
        "heading_path",
        "section",
        "document_name",
        "source_type",
        "handler",
        "domain",
        "tags",
        "keywords",
        "origin_type",
        "authority",
        "source_url",
        "scan_status",
        "content_format",
        "symbol_type",
        "approval_status",
        # v8 fields
        "language",
        "repo_path",
        "module_path",
        "symbol_name",
        "artifact_kind",
        # v10 — multi-tenant isolation
        "visibility_scope",
        "org_id",
        "tenant_id",
        # v11 — per-document ACL
        "acl_mode",
        "acl_groups",
        # v12 — personal/session upload ownership
        "owner_user_id",
        "conversation_id",
        "upload_batch_id",
        "upload_mode",
        "is_ephemeral",
        "expires_at_epoch",
        # v13 — trust attribution
        "scan_signals",
        "review_trace_id",
        "effective_at_epoch",
        # v9 — semantic ingestion / MCP filters
        "content_type",
        "quality_score",
        "technical_depth",
        "domain_relevance",
        "index_decision",
        "spam_score",
        "simhash64",
        "dup_cluster_id",
        "topic_id",
        "topic_keywords",
        "crawl_timestamp",
        "entities_json",
        "section_boundaries_json",
        "raw_content_hash",
        "clean_content_hash",
        "enrichment_profile",
        # vectors
        "embedding",
        "sparse_text",
    }
)

CATALOG_FIELDS = [
    # Identity
    FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
    FieldSchema(name="doc_id", dtype=DataType.VARCHAR, max_length=128),
    FieldSchema(name="chunk_index", dtype=DataType.INT64),
    # Content (english analyzer enables native Milvus BM25 full-text search)
    FieldSchema(
        name="text", dtype=DataType.VARCHAR, max_length=8192, enable_analyzer=True, analyzer_params={"type": "english"}
    ),
    FieldSchema(name="context_prefix", dtype=DataType.VARCHAR, max_length=512),
    FieldSchema(name="chunk_summary", dtype=DataType.VARCHAR, max_length=1024),
    # Structure
    FieldSchema(name="heading_path", dtype=DataType.VARCHAR, max_length=512),
    FieldSchema(name="section", dtype=DataType.VARCHAR, max_length=256),
    FieldSchema(name="document_name", dtype=DataType.VARCHAR, max_length=256),
    # Classification
    FieldSchema(name="source_type", dtype=DataType.VARCHAR, max_length=32),
    FieldSchema(name="handler", dtype=DataType.VARCHAR, max_length=32),
    FieldSchema(name="domain", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="tags", dtype=DataType.VARCHAR, max_length=512),
    FieldSchema(name="keywords", dtype=DataType.VARCHAR, max_length=512),
    # Provenance (two-axis trust)
    FieldSchema(name="origin_type", dtype=DataType.VARCHAR, max_length=32),
    FieldSchema(name="authority", dtype=DataType.VARCHAR, max_length=32, is_partition_key=True),
    FieldSchema(name="source_url", dtype=DataType.VARCHAR, max_length=512),
    # Injection scan status (index-time scanning; admin review queue)
    FieldSchema(name="scan_status", dtype=DataType.VARCHAR, max_length=16),
    # Format and structure (v7)
    FieldSchema(name="content_format", dtype=DataType.VARCHAR, max_length=32),
    FieldSchema(name="symbol_type", dtype=DataType.VARCHAR, max_length=64),
    # HITL approval status (v7): auto_approved, pending, approved, rejected
    FieldSchema(name="approval_status", dtype=DataType.VARCHAR, max_length=16),
    # v8 — language/project/symbol metadata for MCP and agent-targeted retrieval
    FieldSchema(name="language", dtype=DataType.VARCHAR, max_length=32),
    FieldSchema(name="repo_path", dtype=DataType.VARCHAR, max_length=256),
    FieldSchema(name="module_path", dtype=DataType.VARCHAR, max_length=256),
    FieldSchema(name="symbol_name", dtype=DataType.VARCHAR, max_length=128),
    FieldSchema(name="artifact_kind", dtype=DataType.VARCHAR, max_length=32),
    # v10 — multi-tenant isolation (three-tier: global / org / tenant)
    FieldSchema(name="visibility_scope", dtype=DataType.VARCHAR, max_length=16),
    FieldSchema(name="org_id", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="tenant_id", dtype=DataType.VARCHAR, max_length=64),
    # v11 — per-document ACL (hybrid Keycloak + Admin policy)
    FieldSchema(name="acl_mode", dtype=DataType.VARCHAR, max_length=16),
    FieldSchema(name="acl_groups", dtype=DataType.VARCHAR, max_length=1024),
    # v12 — personal/session upload ownership + lifecycle
    FieldSchema(name="owner_user_id", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="conversation_id", dtype=DataType.VARCHAR, max_length=128),
    FieldSchema(name="upload_batch_id", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="upload_mode", dtype=DataType.VARCHAR, max_length=24),
    FieldSchema(name="is_ephemeral", dtype=DataType.BOOL),
    FieldSchema(name="expires_at_epoch", dtype=DataType.INT64),
    # v13 — trust attribution (ingestion→retrieval→planner pipeline)
    FieldSchema(name="scan_signals", dtype=DataType.VARCHAR, max_length=1024),
    FieldSchema(name="review_trace_id", dtype=DataType.VARCHAR, max_length=128),
    FieldSchema(name="effective_at_epoch", dtype=DataType.INT64),
    # v9 — semantic ingestion (gatekeeper + future preprocess/batch jobs)
    FieldSchema(name="content_type", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="quality_score", dtype=DataType.FLOAT),
    FieldSchema(name="technical_depth", dtype=DataType.FLOAT),
    FieldSchema(name="domain_relevance", dtype=DataType.FLOAT),
    FieldSchema(name="index_decision", dtype=DataType.VARCHAR, max_length=16),
    FieldSchema(name="spam_score", dtype=DataType.FLOAT),
    FieldSchema(name="simhash64", dtype=DataType.VARCHAR, max_length=24),
    FieldSchema(name="dup_cluster_id", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="topic_id", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="topic_keywords", dtype=DataType.VARCHAR, max_length=512),
    FieldSchema(name="crawl_timestamp", dtype=DataType.INT64),
    FieldSchema(name="entities_json", dtype=DataType.VARCHAR, max_length=4096),
    FieldSchema(name="section_boundaries_json", dtype=DataType.VARCHAR, max_length=2048),
    FieldSchema(name="raw_content_hash", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="clean_content_hash", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="enrichment_profile", dtype=DataType.VARCHAR, max_length=64),
    # Vector
    FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
    # Sparse BM25 vector (auto-populated by BM25 Function from text field)
    FieldSchema(name="sparse_text", dtype=DataType.SPARSE_FLOAT_VECTOR),
]

# Native BM25 function: Milvus tokenises the text field at insert time and
# populates sparse_text automatically.  hybrid_search can then combine dense
# (embedding) and sparse (sparse_text) arms with RRFRanker.
BM25_FUNCTION = Function(
    name="bm25_text_fn",
    input_field_names=["text"],
    output_field_names=["sparse_text"],
    function_type=FunctionType.BM25,
)


def _validate_existing_schema(client: MilvusClient) -> bool:
    """Check if the existing collection has all expected fields. Returns True if valid."""
    try:
        desc = client.describe_collection(collection_name=SYNESIS_CATALOG)
        existing_fields = set()
        for field_info in desc.get("fields", []):
            existing_fields.add(field_info.get("name", ""))
        missing = EXPECTED_FIELDS - existing_fields
        extra = existing_fields - EXPECTED_FIELDS - {"$meta"}
        if missing:
            logger.warning(
                "indexer_schema_drift_missing",
                extra={"collection": SYNESIS_CATALOG, "missing_fields": list(missing)},
            )
            return False
        if extra:
            logger.info(
                "indexer_schema_drift_extra",
                extra={"collection": SYNESIS_CATALOG, "extra_fields": list(extra)},
            )
        return True
    except Exception as e:
        logger.warning(
            "indexer_schema_validate_failed",
            extra={"collection": SYNESIS_CATALOG, "error": str(e)},
        )
        return False


def ensure_synesis_catalog(
    client: MilvusClient | None = None,
    uri: str = "http://synesis-milvus.synesis-rag.svc.cluster.local:19530",
) -> MilvusClient:
    """Create or recreate synesis_catalog collection. Returns the client.

    Validates the existing schema against EXPECTED_FIELDS. If fields are
    missing (schema drift from older code), drops and recreates the collection.
    """
    if client is None:
        client = MilvusClient(uri=uri)

    if SYNESIS_CATALOG in client.list_collections():
        if _validate_existing_schema(client):
            logger.debug(
                "indexer_schema_valid",
                extra={"collection": SYNESIS_CATALOG, "version": SCHEMA_VERSION},
            )
            _ensure_index_and_load(client)
            return client

        logger.warning(
            "indexer_schema_stale_drop",
            extra={
                "collection": SYNESIS_CATALOG,
                "version": SCHEMA_VERSION,
                "detail": "Data will be re-indexed on next run",
            },
        )
        client.drop_collection(collection_name=SYNESIS_CATALOG)

    schema = CollectionSchema(
        fields=CATALOG_FIELDS,
        description=f"Synesis unified RAG catalog v{SCHEMA_VERSION}",
        enable_dynamic_field=False,
    )
    schema.add_function(BM25_FUNCTION)
    client.create_collection(collection_name=SYNESIS_CATALOG, schema=schema)
    _ensure_index_and_load(client)
    logger.info(
        "indexer_collection_created",
        extra={"collection": SYNESIS_CATALOG, "version": SCHEMA_VERSION},
    )
    return client


def _ensure_index_and_load(client: MilvusClient) -> None:
    """Create HNSW + sparse BM25 indexes if missing, then load collection."""
    try:
        indexes = client.list_indexes(collection_name=SYNESIS_CATALOG)
        index_strs = [str(idx).lower() for idx in indexes] if indexes else []
        has_embedding_index = any("embedding" in s for s in index_strs)
        has_sparse_index = any("sparse_text" in s for s in index_strs)
    except Exception:
        has_embedding_index = False
        has_sparse_index = False

    if not has_embedding_index or not has_sparse_index:
        try:
            index_params = MilvusClient.prepare_index_params()
            if not has_embedding_index:
                index_params.add_index(
                    field_name="embedding",
                    index_type="HNSW",
                    metric_type="COSINE",
                    params={"M": 16, "efConstruction": 200},
                )
            if not has_sparse_index:
                index_params.add_index(
                    field_name="sparse_text",
                    index_type="SPARSE_INVERTED_INDEX",
                    metric_type="BM25",
                )
            client.create_index(collection_name=SYNESIS_CATALOG, index_params=index_params)
            logger.info("indexer_indexes_created", extra={"collection": SYNESIS_CATALOG})
        except Exception as e:
            if "already" not in str(e).lower():
                raise

    client.load_collection(collection_name=SYNESIS_CATALOG)


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
    source_url: str = "",
    scan_status: str = "unscanned",
    content_format: str = "",
    symbol_type: str = "",
    approval_status: str = "auto_approved",
    language: str = "",
    repo_path: str = "",
    module_path: str = "",
    symbol_name: str = "",
    artifact_kind: str = "",
    # v10 — multi-tenant isolation
    visibility_scope: str = "global",
    org_id: str = "",
    tenant_id: str = "",
    # v11 — per-document ACL
    acl_mode: str = "open",
    acl_groups: str = "",
    # v12 — personal/session upload ownership
    owner_user_id: str = "",
    conversation_id: str = "",
    upload_batch_id: str = "",
    upload_mode: str = "",
    is_ephemeral: bool = False,
    expires_at_epoch: int = 0,
    # v13 — trust attribution
    scan_signals: str = "",
    review_trace_id: str = "",
    effective_at_epoch: int = 0,
    # v9
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
) -> dict[str, Any]:
    """Build a catalog entity dict for upsert. Truncates fields to schema byte limits."""
    return {
        "chunk_id": _trunc_bytes(chunk_id, 64),
        "doc_id": _trunc_bytes(doc_id or "", 128),
        "chunk_index": chunk_index,
        "text": _trunc_bytes(text, 8192),
        "context_prefix": _trunc_bytes(context_prefix or "", 512),
        "chunk_summary": _trunc_bytes(chunk_summary or "", 1024),
        "heading_path": _trunc_bytes(heading_path or "", 512),
        "section": _trunc_bytes(section or "", 256),
        "document_name": _trunc_bytes(document_name or "", 256),
        "source_type": (source_type or "")[:32],
        "handler": (handler or "")[:32],
        "domain": (domain or "generalist")[:64],
        "tags": _trunc_bytes(tags or "", 512),
        "keywords": _trunc_bytes(keywords or "", 512),
        "origin_type": (origin_type or "")[:32],
        "authority": (authority or "community")[:32],
        "source_url": _trunc_bytes(source_url or "", 512),
        "scan_status": (scan_status or "unscanned")[:16],
        "content_format": (content_format or "")[:32],
        "symbol_type": (symbol_type or "")[:64],
        "approval_status": (approval_status or "auto_approved")[:16],
        "language": (language or "")[:32],
        "repo_path": _trunc_bytes(repo_path or "", 256),
        "module_path": _trunc_bytes(module_path or "", 256),
        "symbol_name": _trunc_bytes(symbol_name or "", 128),
        "artifact_kind": (artifact_kind or "")[:32],
        "visibility_scope": (visibility_scope or "global")[:16],
        "org_id": _trunc_bytes(org_id or "", 64),
        "tenant_id": _trunc_bytes(tenant_id or "", 64),
        "acl_mode": (acl_mode or "open")[:16],
        "acl_groups": _trunc_bytes(acl_groups or "", 1024),
        "owner_user_id": _trunc_bytes(owner_user_id or "", 64),
        "conversation_id": _trunc_bytes(conversation_id or "", 128),
        "upload_batch_id": _trunc_bytes(upload_batch_id or "", 64),
        "upload_mode": _trunc_bytes(upload_mode or "", 24),
        "is_ephemeral": bool(is_ephemeral),
        "expires_at_epoch": int(expires_at_epoch),
        "scan_signals": _trunc_bytes(scan_signals or "", 1024),
        "review_trace_id": _trunc_bytes(review_trace_id or "", 128),
        "effective_at_epoch": int(effective_at_epoch),
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
    }
