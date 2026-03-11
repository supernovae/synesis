"""Unified catalog schema for Synesis RAG.

Single collection with partition key on authority, enrichment fields for
Contextual Retrieval (context_prefix, chunk_summary, keywords, heading_path),
and proper decomposition of legacy overloaded fields.

SCHEMA_VERSION tracks breaking changes. When bumped, ensure_synesis_catalog
detects the mismatch and drops/recreates the collection automatically.

Version history:
  v3 → v4: Removed intended_roles (Router owns all retrieval; per-node
            role tagging is dead weight).

Research: arxiv 2601.11863 (metadata-prefixed embeddings), Anthropic Contextual
Retrieval (35-67% failure reduction), Milvus partition key docs v2.5.
"""

from __future__ import annotations

from typing import Any

from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient
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
SCHEMA_VERSION = 4

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
        "embedding",
    }
)

CATALOG_FIELDS = [
    # Identity
    FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
    FieldSchema(name="doc_id", dtype=DataType.VARCHAR, max_length=128),
    FieldSchema(name="chunk_index", dtype=DataType.INT64),
    # Content
    FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=8192),
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
    # Vector
    FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
]


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
                "message": "Data will be re-indexed on next run",
            },
        )
        client.drop_collection(collection_name=SYNESIS_CATALOG)

    schema = CollectionSchema(
        fields=CATALOG_FIELDS,
        description=f"Synesis unified RAG catalog v{SCHEMA_VERSION}",
        enable_dynamic_field=False,
    )
    client.create_collection(collection_name=SYNESIS_CATALOG, schema=schema)
    _ensure_index_and_load(client)
    logger.info(
        "indexer_collection_created",
        extra={"collection": SYNESIS_CATALOG, "version": SCHEMA_VERSION},
    )
    return client


def _ensure_index_and_load(client: MilvusClient) -> None:
    """Create HNSW index on embedding if missing, then load collection."""
    try:
        indexes = client.list_indexes(collection_name=SYNESIS_CATALOG)
        has_embedding_index = indexes and any("embedding" in str(idx).lower() for idx in indexes)
    except Exception:
        has_embedding_index = False

    if not has_embedding_index:
        try:
            index_params = MilvusClient.prepare_index_params()
            index_params.add_index(
                field_name="embedding",
                index_type="HNSW",
                metric_type="COSINE",
                params={"M": 16, "efConstruction": 200},
            )
            client.create_index(collection_name=SYNESIS_CATALOG, index_params=index_params)
            logger.info("indexer_hnsw_index_created", extra={"collection": SYNESIS_CATALOG})
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
) -> dict[str, Any]:
    """Build a catalog entity dict for upsert. Truncates fields to schema byte limits."""
    return {
        "chunk_id": chunk_id[:64],
        "doc_id": (doc_id or "")[:128],
        "chunk_index": chunk_index,
        "text": _trunc_bytes(text, 8192),
        "context_prefix": _trunc_bytes(context_prefix or "", 512),
        "chunk_summary": _trunc_bytes(chunk_summary or "", 1024),
        "heading_path": (heading_path or "")[:512],
        "section": (section or "")[:256],
        "document_name": (document_name or "")[:256],
        "source_type": (source_type or "")[:32],
        "handler": (handler or "")[:32],
        "domain": (domain or "generalist")[:64],
        "tags": (tags or "")[:512],
        "keywords": _trunc_bytes(keywords or "", 512),
        "origin_type": (origin_type or "")[:32],
        "authority": (authority or "community")[:32],
        "source_url": (source_url or "")[:512],
        "embedding": embedding,
    }
