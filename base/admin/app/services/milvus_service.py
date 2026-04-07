"""Reusable Milvus query abstractions."""

from __future__ import annotations

import logging
import os
from typing import Any

from pymilvus import CollectionSchema, DataType, FieldSchema, Function, FunctionType, MilvusClient

from ..deps import get_resilient_milvus
from ..milvus_utils import with_retry

logger = logging.getLogger("synesis.admin.milvus")

SCHEMA_VERSION = 15


def expected_milvus_schema_version() -> int:
    """Integer schema generation the fleet expects (admin UI, drift detection, reset-catalog).

    Defaults to :data:`SCHEMA_VERSION` so it stays aligned with ``recreate_synesis_catalog_v12``
    and the indexer image. Override with env ``SYNESIS_EXPECTED_SCHEMA_VERSION`` only when
    rolling out a coordinated bump.
    """
    return int(os.environ.get("SYNESIS_EXPECTED_SCHEMA_VERSION", str(SCHEMA_VERSION)))


def recreate_synesis_catalog_v12(collection: str = "synesis_catalog") -> dict[str, Any]:
    """Drop and recreate synesis_catalog with the current unified schema (see :data:`SCHEMA_VERSION`).

    Function name kept as ``_v12`` for backward compatibility with callers.
    """
    embedding_dim = 384
    fields = [
        FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
        FieldSchema(name="doc_id", dtype=DataType.VARCHAR, max_length=128),
        FieldSchema(name="chunk_index", dtype=DataType.INT64),
        FieldSchema(
            name="text",
            dtype=DataType.VARCHAR,
            max_length=8192,
            enable_analyzer=True,
            analyzer_params={"type": "english"},
        ),
        FieldSchema(name="context_prefix", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="chunk_summary", dtype=DataType.VARCHAR, max_length=1024),
        FieldSchema(name="heading_path", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="section", dtype=DataType.VARCHAR, max_length=256),
        FieldSchema(name="document_name", dtype=DataType.VARCHAR, max_length=256),
        FieldSchema(name="source_type", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="handler", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="domain", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="tags", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="keywords", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="origin_type", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="authority", dtype=DataType.VARCHAR, max_length=32, is_partition_key=True),
        FieldSchema(name="source_url", dtype=DataType.VARCHAR, max_length=512),
        FieldSchema(name="scan_status", dtype=DataType.VARCHAR, max_length=16),
        FieldSchema(name="content_format", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="symbol_type", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="approval_status", dtype=DataType.VARCHAR, max_length=16),
        FieldSchema(name="language", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="repo_path", dtype=DataType.VARCHAR, max_length=256),
        FieldSchema(name="module_path", dtype=DataType.VARCHAR, max_length=256),
        FieldSchema(name="symbol_name", dtype=DataType.VARCHAR, max_length=128),
        FieldSchema(name="artifact_kind", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="has_code", dtype=DataType.BOOL),
        FieldSchema(name="code_signal_count", dtype=DataType.INT64),
        FieldSchema(name="code_density", dtype=DataType.FLOAT),
        FieldSchema(name="code_language", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="visibility_scope", dtype=DataType.VARCHAR, max_length=16),
        FieldSchema(name="org_id", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="tenant_id", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="acl_mode", dtype=DataType.VARCHAR, max_length=16),
        FieldSchema(name="acl_groups", dtype=DataType.VARCHAR, max_length=1024),
        FieldSchema(name="owner_user_id", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="conversation_id", dtype=DataType.VARCHAR, max_length=128),
        FieldSchema(name="upload_batch_id", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="upload_mode", dtype=DataType.VARCHAR, max_length=24),
        FieldSchema(name="is_ephemeral", dtype=DataType.BOOL),
        FieldSchema(name="expires_at_epoch", dtype=DataType.INT64),
        # v13 — trust attribution
        FieldSchema(name="scan_signals", dtype=DataType.VARCHAR, max_length=1024),
        FieldSchema(name="review_trace_id", dtype=DataType.VARCHAR, max_length=128),
        FieldSchema(name="effective_at_epoch", dtype=DataType.INT64),
        # v14 — constraint-aware retrieval (promoted from packed tags + new fields)
        FieldSchema(name="corpus_class", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="constraint_kind", dtype=DataType.VARCHAR, max_length=16),
        FieldSchema(name="content_profile", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="scope_tags", dtype=DataType.VARCHAR, max_length=256),
        FieldSchema(name="constraint_source", dtype=DataType.VARCHAR, max_length=64),
        FieldSchema(name="constraint_confidence", dtype=DataType.FLOAT),
        FieldSchema(name="golden_path_id", dtype=DataType.VARCHAR, max_length=128),
        FieldSchema(name="novel_pattern", dtype=DataType.BOOL),
        FieldSchema(name="novel_trace_level", dtype=DataType.VARCHAR, max_length=16),
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
        FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=embedding_dim),
        FieldSchema(name="sparse_text", dtype=DataType.SPARSE_FLOAT_VECTOR),
    ]
    bm25_fn = Function(
        name="bm25_text_fn",
        input_field_names=["text"],
        output_field_names=["sparse_text"],
        function_type=FunctionType.BM25,
    )
    schema = CollectionSchema(
        fields=fields, functions=[bm25_fn], description=f"Synesis unified catalog v{SCHEMA_VERSION}"
    )
    client = get_resilient_milvus().get()
    dropped = False
    try:
        if collection in client.list_collections():
            client.drop_collection(collection_name=collection)
            dropped = True
    except Exception as exc:
        return {"ok": False, "error": f"drop_failed: {str(exc)[:200]}", "dropped": dropped}
    try:
        client.create_collection(collection_name=collection, schema=schema)
        idx = MilvusClient.prepare_index_params()
        idx.add_index(
            field_name="embedding", index_type="HNSW", metric_type="COSINE", params={"M": 16, "efConstruction": 200}
        )
        idx.add_index(field_name="sparse_text", index_type="SPARSE_INVERTED_INDEX", metric_type="BM25")
        client.create_index(collection_name=collection, index_params=idx)
        client.load_collection(collection_name=collection)
        return {"ok": True, "collection": collection, "schema_version": SCHEMA_VERSION, "dropped": dropped}
    except Exception as exc:
        return {"ok": False, "error": f"recreate_failed: {str(exc)[:200]}", "dropped": dropped}


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
        return {"exists": False, "fields": [], "indexes": []}


def collection_domain_hierarchy(collection: str) -> list[dict[str, Any]]:
    """Return domain -> document_name -> chunk count hierarchy."""
    try:
        rows = with_retry(
            get_resilient_milvus(),
            lambda c: (
                []
                if collection not in c.list_collections()
                else c.query(
                    collection_name=collection,
                    filter="",
                    output_fields=["domain", "document_name"],
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
            s = r.get("document_name", "") or "unknown"
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
        return {"exists": False, "row_count": 0}
