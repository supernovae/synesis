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
