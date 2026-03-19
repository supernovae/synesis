"""Reusable Milvus query abstractions."""

from __future__ import annotations

import logging
from typing import Any

from ..deps import get_resilient_milvus
from ..milvus_utils import with_retry

logger = logging.getLogger("synesis.admin.milvus")


def safe_query(
    collection: str,
    filter_expr: str = "",
    output_fields: list[str] | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    def _do(client):
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

    try:
        return with_retry(get_resilient_milvus(), _do)
    except Exception as exc:
        logger.warning("milvus_query_error collection=%s error=%s", collection, str(exc)[:120])
        return []


def safe_upsert(collection: str, data: dict[str, Any]) -> bool:
    """Upsert a single entity into a Milvus collection. Returns True on success."""

    def _do(client):
        try:
            client.upsert(collection_name=collection, data=[data])
        except Exception as exc:
            if "collection not loaded" in str(exc).lower():
                client.load_collection(collection_name=collection)
                client.upsert(collection_name=collection, data=[data])
            else:
                raise

    try:
        with_retry(get_resilient_milvus(), _do)
        return True
    except Exception as exc:
        logger.warning("milvus_upsert_error collection=%s error=%s", collection, str(exc)[:120])
        return False


def safe_delete(collection: str, chunk_id: str) -> bool:
    """Delete a single entity by chunk_id from a Milvus collection."""

    def _do(client):
        if collection not in client.list_collections():
            return
        try:
            client.delete(collection_name=collection, filter=f'chunk_id == "{chunk_id}"')
        except Exception as exc:
            if "collection not loaded" in str(exc).lower():
                client.load_collection(collection_name=collection)
                client.delete(collection_name=collection, filter=f'chunk_id == "{chunk_id}"')
            else:
                raise

    try:
        with_retry(get_resilient_milvus(), _do)
        return True
    except Exception as exc:
        logger.warning("milvus_delete_error collection=%s error=%s", collection, str(exc)[:120])
        return False




def safe_vector_search(
    collection: str,
    vector: list[float],
    top_k: int = 5,
    output_fields: list[str] | None = None,
    filter_expr: str = "",
) -> list[dict[str, Any]]:
    """Run a vector similarity search against a Milvus collection.

    Returns list of dicts with requested output_fields plus 'distance'.
    """

    def _do(client):
        if collection not in client.list_collections():
            return []
        try:
            results = client.search(
                collection_name=collection,
                data=[vector],
                limit=top_k,
                output_fields=output_fields or [],
                filter=filter_expr or "",
                anns_field="embedding",
            )
        except Exception as exc:
            if "collection not loaded" in str(exc).lower():
                client.load_collection(collection_name=collection)
                results = client.search(
                    collection_name=collection,
                    data=[vector],
                    limit=top_k,
                    output_fields=output_fields or [],
                    filter=filter_expr or "",
                    anns_field="embedding",
                )
            else:
                raise

        if not results or not results[0]:
            return []
        out: list[dict[str, Any]] = []
        for hit in results[0]:
            entry = dict(hit.get("entity", hit) if isinstance(hit, dict) else {})
            entry["distance"] = (
                getattr(hit, "distance", hit.get("distance", 0.0))
                if isinstance(hit, dict)
                else getattr(hit, "distance", 0.0)
            )
            out.append(entry)
        return out

    try:
        return with_retry(get_resilient_milvus(), _do)
    except Exception as exc:
        logger.warning("milvus_vector_search_error collection=%s error=%s", collection, str(exc)[:120])
        return []


def collection_schema_info(collection: str) -> dict[str, Any]:
    """Return field definitions, index info, and domain->source hierarchy."""

    def _do(client):
        if collection not in client.list_collections():
            return {"exists": False}

        desc = client.describe_collection(collection_name=collection)
        fields = []
        for f in desc.get("fields", []):
            fields.append(
                {
                    "name": f.get("name", ""),
                    "type": str(f.get("type", "")),
                    "is_primary": f.get("is_primary", False),
                    "max_length": f.get("params", {}).get("max_length"),
                    "dim": f.get("params", {}).get("dim"),
                }
            )

        indexes = []
        try:
            idx_list = client.list_indexes(collection_name=collection)
            for idx_name in idx_list:
                idx_desc = client.describe_index(collection_name=collection, index_name=idx_name)
                indexes.append(
                    {
                        "name": idx_name,
                        "field": idx_desc.get("field_name", ""),
                        "type": idx_desc.get("index_type", ""),
                        "metric": idx_desc.get("metric_type", ""),
                    }
                )
        except Exception:
            pass

        return {"exists": True, "fields": fields, "indexes": indexes}

    try:
        return with_retry(get_resilient_milvus(), _do)
    except Exception as exc:
        logger.warning("milvus_schema_info_error collection=%s error=%s", collection, str(exc)[:80])
        return {"exists": False, "error": str(exc)[:80]}


def collection_domain_hierarchy(collection: str) -> list[dict[str, Any]]:
    """Return domain -> source_name -> chunk count hierarchy."""
    try:
        rows = with_retry(
            get_resilient_milvus(),
            lambda c: (
                []
                if collection not in c.list_collections()
                else c.query(
                    collection_name=collection,
                    filter="",
                    output_fields=["domain", "source_name"],
                    limit=16384,
                )
            ),
        )
        if not rows:
            return []
        from collections import Counter

        pair_counts: Counter[tuple[str, str]] = Counter()
        for r in rows:
            d = r.get("domain", "") or "unknown"
            s = r.get("source_name", "") or "unknown"
            pair_counts[(d, s)] += 1

        domain_map: dict[str, list[dict]] = {}
        for (d, s), cnt in pair_counts.items():
            if d not in domain_map:
                domain_map[d] = []
            domain_map[d].append({"source": s, "chunks": cnt})

        return [
            {
                "domain": d,
                "total_chunks": sum(s["chunks"] for s in sources),
                "sources": sorted(sources, key=lambda x: x["chunks"], reverse=True),
            }
            for d, sources in sorted(domain_map.items())
        ]
    except Exception as exc:
        logger.warning("milvus_hierarchy_error error=%s", str(exc)[:80])
        return []


def collection_stats(collection: str) -> dict[str, Any]:
    def _do(client):
        if collection not in client.list_collections():
            return {"exists": False, "row_count": 0}
        stats = client.get_collection_stats(collection_name=collection)
        row_count = int(stats.get("row_count", 0))
        return {"exists": True, "row_count": row_count}

    try:
        return with_retry(get_resilient_milvus(), _do)
    except Exception as exc:
        logger.warning("milvus_stats_error collection=%s error=%s", collection, str(exc)[:80])
        return {"exists": False, "row_count": 0, "error": str(exc)[:80]}
