"""Reusable Milvus query abstractions."""

from __future__ import annotations

import logging
from typing import Any

from ..deps import get_milvus

logger = logging.getLogger("synesis.admin.milvus")


def safe_query(
    collection: str,
    filter_expr: str = "",
    output_fields: list[str] | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    try:
        client = get_milvus()
        if collection not in client.list_collections():
            return []
        try:
            return client.query(
                collection_name=collection,
                filter=filter_expr or "",
                output_fields=output_fields or [],
                limit=limit,
                offset=offset,
            )
        except Exception as exc:
            if "collection not loaded" in str(exc).lower():
                client.load_collection(collection_name=collection)
                return client.query(
                    collection_name=collection,
                    filter=filter_expr or "",
                    output_fields=output_fields or [],
                    limit=limit,
                    offset=offset,
                )
            raise
    except Exception as exc:
        logger.warning("milvus_query_error collection=%s error=%s", collection, str(exc)[:120])
        return []


def safe_upsert(collection: str, data: dict[str, Any]) -> bool:
    """Upsert a single entity into a Milvus collection. Returns True on success."""
    try:
        client = get_milvus()
        if collection not in client.list_collections():
            _ensure_status_collection(client, collection)
        try:
            client.upsert(collection_name=collection, data=[data])
        except Exception as exc:
            if "collection not loaded" in str(exc).lower():
                client.load_collection(collection_name=collection)
                client.upsert(collection_name=collection, data=[data])
            else:
                raise
        return True
    except Exception as exc:
        logger.warning("milvus_upsert_error collection=%s error=%s", collection, str(exc)[:120])
        return False


def safe_delete(collection: str, chunk_id: str) -> bool:
    """Delete a single entity by chunk_id from a Milvus collection."""
    try:
        client = get_milvus()
        if collection not in client.list_collections():
            return True
        try:
            client.delete(collection_name=collection, filter=f'chunk_id == "{chunk_id}"')
        except Exception as exc:
            if "collection not loaded" in str(exc).lower():
                client.load_collection(collection_name=collection)
                client.delete(collection_name=collection, filter=f'chunk_id == "{chunk_id}"')
            else:
                raise
        return True
    except Exception as exc:
        logger.warning("milvus_delete_error collection=%s error=%s", collection, str(exc)[:120])
        return False


def _ensure_status_collection(client: Any, collection: str) -> None:
    """Create the gap status collection if it doesn't exist."""
    if collection != "synesis_knowledge_gap_status":
        return
    if collection in client.list_collections():
        return
    try:
        from pymilvus import CollectionSchema, DataType, FieldSchema
        schema = CollectionSchema(
            fields=[
                FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
                FieldSchema(name="status", dtype=DataType.VARCHAR, max_length=20),
                FieldSchema(name="resolved_at", dtype=DataType.INT64),
                FieldSchema(name="resolved_by", dtype=DataType.VARCHAR, max_length=128),
                FieldSchema(name="resolution_note", dtype=DataType.VARCHAR, max_length=1024),
                FieldSchema(name="updated_at", dtype=DataType.INT64),
            ],
            description="Synesis knowledge gap lifecycle status",
        )
        client.create_collection(collection_name=collection, schema=schema)
        logger.info("milvus_collection_created collection=%s", collection)
        try:
            client.load_collection(collection_name=collection)
        except Exception:
            pass
    except Exception as exc:
        logger.warning("ensure_status_collection_error error=%s", str(exc)[:120])


def collection_stats(collection: str) -> dict[str, Any]:
    try:
        client = get_milvus()
        if collection not in client.list_collections():
            return {"exists": False, "row_count": 0}
        stats = client.get_collection_stats(collection_name=collection)
        row_count = int(stats.get("row_count", 0))
        return {"exists": True, "row_count": row_count}
    except Exception as exc:
        logger.warning("milvus_stats_error collection=%s error=%s", collection, str(exc)[:80])
        return {"exists": False, "row_count": 0, "error": str(exc)[:80]}
