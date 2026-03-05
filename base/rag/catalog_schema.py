"""Unified catalog schema for Synesis RAG.

All indexers write to synesis_catalog with a common schema. Single BM25 index,
metadata-driven gravity, no per-collection complexity.
"""

from __future__ import annotations

import logging
from typing import Any

from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

logger = logging.getLogger("synesis.catalog")

SYNESIS_CATALOG = "synesis_catalog"
EMBEDDING_DIM = 384

# Common schema: all indexers must populate chunk_id, text, source, language, embedding.
# domain, expertise_level, indexer_source enable metadata filtering and gravity.
CATALOG_FIELDS = [
    FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
    FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=8192),
    FieldSchema(name="source", dtype=DataType.VARCHAR, max_length=512),
    FieldSchema(name="language", dtype=DataType.VARCHAR, max_length=32),
    FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
    FieldSchema(name="domain", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="expertise_level", dtype=DataType.VARCHAR, max_length=32),
    FieldSchema(name="indexer_source", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="section", dtype=DataType.VARCHAR, max_length=256),
    FieldSchema(name="document_name", dtype=DataType.VARCHAR, max_length=256),
    FieldSchema(name="tags", dtype=DataType.VARCHAR, max_length=512),
]


def ensure_synesis_catalog(
    client: MilvusClient | None = None,
    uri: str = "http://synesis-milvus.synesis-rag.svc.cluster.local:19530",
) -> None:
    """Create synesis_catalog collection if it does not exist. Idempotent."""
    if client is None:
        client = MilvusClient(uri=uri)

    if SYNESIS_CATALOG in client.list_collections():
        logger.debug(f"Collection '{SYNESIS_CATALOG}' already exists")
        _ensure_index_and_load(client)
        return

    schema = CollectionSchema(
        fields=CATALOG_FIELDS,
        description="Synesis unified RAG catalog — all domain knowledge",
    )
    client.create_collection(collection_name=SYNESIS_CATALOG, schema=schema)
    _ensure_index_and_load(client)
    logger.info(f"Created collection '{SYNESIS_CATALOG}'")


def _ensure_index_and_load(client: MilvusClient) -> None:
    """Create index on embedding if missing, then load collection."""
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
                index_type="IVF_FLAT",
                metric_type="COSINE",
                params={"nlist": 128},
            )
            client.create_index(collection_name=SYNESIS_CATALOG, index_params=index_params)
            logger.info(f"Created index on '{SYNESIS_CATALOG}'")
        except Exception as e:
            if "already" not in str(e).lower():
                raise

    client.load_collection(collection_name=SYNESIS_CATALOG)


def catalog_entity(
    chunk_id: str,
    text: str,
    source: str,
    language: str,
    embedding: list[float],
    domain: str = "generalist",
    expertise_level: str = "",
    indexer_source: str = "",
    section: str = "",
    document_name: str = "",
    tags: str = "",
) -> dict[str, Any]:
    """Build a catalog entity dict for upsert. All required fields + optional metadata."""
    return {
        "chunk_id": chunk_id[:64],
        "text": text[:8192],
        "source": source[:512],
        "language": (language or "")[:32],
        "embedding": embedding,
        "domain": (domain or "generalist")[:64],
        "expertise_level": (expertise_level or "")[:32],
        "indexer_source": (indexer_source or "")[:64],
        "section": (section or "")[:256],
        "document_name": (document_name or "")[:256],
        "tags": (tags or "")[:512],
    }
