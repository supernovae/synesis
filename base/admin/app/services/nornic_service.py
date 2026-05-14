"""Reusable NornicDB graph query abstractions for admin views."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from ..deps import CATALOG_COLLECTION, NORNIC_DATABASE, get_nornic_driver

logger = logging.getLogger("synesis.admin.nornic")

SCHEMA_VERSION = 18
DELETE_BATCH_SIZE = 500

_FILTER_EQ_RE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*==\s*"([^"]*)"\s*$')
_FILTER_NE_RE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*!=\s*"([^"]*)"\s*$')


def expected_graph_schema_version() -> int:
    return int(os.environ.get("SYNESIS_EXPECTED_GRAPH_SCHEMA_VERSION", str(SCHEMA_VERSION)))


def reported_graph_schema_version() -> int:
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            row = session.run(
                "MATCH (s:GraphSchema {name: $name}) RETURN s.version AS version LIMIT 1",
                name=CATALOG_COLLECTION,
            ).single()
            if not row:
                return 0
            return int(row["version"] or 0)
    except Exception as exc:
        logger.warning("nornic_schema_version_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return 0


def _delete_content_nodes_in_batches(session: Any, *, pack_id: str = "") -> int:
    deleted = 0
    while True:
        if pack_id:
            rows = session.run(
                """
                MATCH (n:ContentNode)
                WHERE n.pack = $pack_id OR n.pack_id = $pack_id
                RETURN n.id AS id
                LIMIT $limit
                """,
                pack_id=pack_id,
                limit=DELETE_BATCH_SIZE,
            )
        else:
            rows = session.run(
                """
                MATCH (n:ContentNode)
                RETURN n.id AS id
                LIMIT $limit
                """,
                limit=DELETE_BATCH_SIZE,
            )
        ids = [str(row["id"]) for row in rows if row.get("id")]
        if not ids:
            return deleted
        session.run("MATCH (n:ContentNode) WHERE n.id IN $ids DETACH DELETE n", ids=ids)
        deleted += len(ids)


def recreate_content_graph(collection: str = CATALOG_COLLECTION) -> dict[str, Any]:
    del collection
    try:
        schema_version = expected_graph_schema_version()
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            deleted = _delete_content_nodes_in_batches(session)
            session.run("CREATE CONSTRAINT content_node_id IF NOT EXISTS FOR (n:ContentNode) REQUIRE n.id IS UNIQUE")
            session.run("CREATE INDEX content_node_pack IF NOT EXISTS FOR (n:ContentNode) ON (n.pack)")
            session.run("CREATE INDEX content_node_version IF NOT EXISTS FOR (n:ContentNode) ON (n.source_version)")
            session.run("CREATE INDEX content_node_symbol IF NOT EXISTS FOR (n:ContentNode) ON (n.symbol_fqn)")
            session.run("CREATE VECTOR INDEX embeddings IF NOT EXISTS FOR (n:ContentNode) ON (n.embedding)")
            session.run(
                """
                MERGE (s:GraphSchema {name: $name})
                SET s.version = $version, s.updated_at_epoch = timestamp()
                """,
                name=CATALOG_COLLECTION,
                version=schema_version,
            )
        return {
            "ok": True,
            "graph": CATALOG_COLLECTION,
            "schema_version": schema_version,
            "dropped": True,
            "deleted_nodes": deleted,
        }
    except Exception as exc:
        return {"ok": False, "error": f"recreate_failed: {str(exc)[:200]}", "dropped": False}


def safe_query(
    collection: str,
    filter_expr: str = "",
    output_fields: list[str] | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    del collection
    fields = output_fields or []
    projection = "properties(n) AS props" if not fields else "n AS node"
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                f"""
                MATCH (n:ContentNode)
                RETURN {projection}
                SKIP $offset
                LIMIT $limit
                """,
                offset=max(0, offset),
                limit=max(1, min(limit, 5000)),
            )
            out: list[dict[str, Any]] = []
            for row in rows:
                props = dict(row["props"]) if "props" in row else dict(row["node"])
                if fields:
                    props = {field: props.get(field, "") for field in fields}
                out.append(props)
            return _apply_filter_expr(out, filter_expr)
    except Exception as exc:
        logger.warning("nornic_query_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []


def _apply_filter_expr(rows: list[dict[str, Any]], filter_expr: str) -> list[dict[str, Any]]:
    """Apply the tiny filter subset Admin uses for NornicDB-backed tables.

    This intentionally supports only equality/non-empty checks from existing
    Admin callers. Unknown expressions are ignored instead of becoming a
    string-injected Cypher clause.
    """
    expr = (filter_expr or "").strip()
    if not expr:
        return rows
    eq = _FILTER_EQ_RE.match(expr)
    if eq:
        field, expected = eq.groups()
        return [row for row in rows if str(row.get(field) or "") == expected]
    ne = _FILTER_NE_RE.match(expr)
    if ne:
        field, expected = ne.groups()
        return [row for row in rows if str(row.get(field) or "") != expected]
    logger.debug("nornic_filter_ignored expr=%s", expr[:80])
    return rows


def safe_upsert(collection: str, data: dict[str, Any]) -> bool:
    del collection
    try:
        driver = get_nornic_driver()
        node_id = str(data.get("id") or data.get("chunk_id") or "")
        if not node_id:
            return False
        data = {**data, "id": node_id}
        with driver.session(database=NORNIC_DATABASE) as session:
            session.run(
                "MERGE (n:ContentNode {id: $id}) SET n += $props",
                id=node_id,
                props=data,
            )
        return True
    except Exception as exc:
        logger.warning("nornic_upsert_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return False


def safe_delete(collection: str, chunk_id: str) -> bool:
    del collection
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            session.run("MATCH (n:ContentNode {id: $id}) DETACH DELETE n", id=chunk_id)
        return True
    except Exception as exc:
        logger.warning("nornic_delete_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return False


def safe_vector_search(
    collection: str,
    vector: list[float] | str,
    *,
    top_k: int = 5,
    filter_expr: str = "",
    output_fields: list[str] | None = None,
) -> list[dict[str, Any]]:
    del collection, filter_expr
    query = vector if isinstance(vector, str) else " ".join(str(x) for x in vector[:16])
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                """
                CALL db.index.vector.queryNodes('embeddings', $limit, $query)
                YIELD node, score
                RETURN node, score
                ORDER BY score DESC
                LIMIT $limit
                """,
                query=query,
                limit=max(1, min(top_k, 50)),
            )
            out: list[dict[str, Any]] = []
            for row in rows:
                props = dict(row["node"])
                if output_fields:
                    props = {field: props.get(field, "") for field in output_fields}
                props["score"] = row["score"]
                out.append(props)
            return out
    except Exception as exc:
        logger.warning("nornic_vector_search_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []


def collection_stats(collection: str) -> dict[str, Any]:
    del collection
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            stats = session.run(
                """
                MATCH (n:ContentNode)
                RETURN count(n) AS total_nodes,
                       count(n.text) AS chunk_count,
                       count(n.embedding) AS embedding_count,
                       count(DISTINCT n.pack) AS pack_count
                """
            ).single()
            edge_count = session.run("MATCH (:ContentNode)-[r]->(:ContentNode) RETURN count(r) AS c").single()["c"]
            node_count = int(stats["total_nodes"] or 0) if stats else 0
            chunk_count = int(stats["chunk_count"] or 0) if stats else 0
            embedding_count = int(stats["embedding_count"] or 0) if stats else 0
            pack_count = int(stats["pack_count"] or 0) if stats else 0
        return {
            "row_count": chunk_count,
            "chunk_count": chunk_count,
            "node_count": node_count,
            "malformed_node_count": max(0, node_count - chunk_count),
            "embedding_count": embedding_count,
            "edge_count": int(edge_count),
            "pack_count": pack_count,
        }
    except Exception as exc:
        logger.warning("nornic_stats_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:80])
        return {"row_count": 0, "node_count": 0, "edge_count": 0, "pack_count": 0}


def collection_corpus_summary(collection: str) -> dict[str, Any]:
    del collection
    stats = collection_stats(CATALOG_COLLECTION)
    domains: set[str] = set()
    documents: set[str] = set()
    sources: set[str] = set()
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                """
                MATCH (n:ContentNode)
                RETURN n.domain AS domain,
                       n.doc_id AS doc_id,
                       n.document_name AS document_name,
                       n.source_url AS source_url,
                       n.pack AS pack,
                       count(n.text) AS chunks
                """
            )
            for row in rows:
                if int(row["chunks"] or 0) <= 0:
                    continue
                domain = str(row.get("domain") or "").strip()
                doc_id = str(row.get("doc_id") or "").strip()
                source = str(
                    row.get("document_name") or row.get("source_url") or row.get("doc_id") or row.get("pack") or ""
                ).strip()
                if domain:
                    domains.add(domain)
                if doc_id:
                    documents.add(doc_id)
                if source:
                    sources.add(source)
    except Exception as exc:
        logger.warning("nornic_corpus_summary_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
    return {
        **stats,
        "total_chunks": int(stats.get("chunk_count", stats.get("row_count", 0)) or 0),
        "total_documents": len(documents),
        "total_sources": len(sources),
        "domains_covered": len(domains),
    }


def collection_installed_packs(collection: str) -> list[dict[str, Any]]:
    del collection
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                """
                MATCH (n:ContentNode)
                RETURN n.pack AS pack_id,
                       max(n.pack_version) AS pack_version,
                       max(n.pack_source_version) AS pack_source_version,
                       max(n.language) AS language,
                       max(n.domain) AS domain,
                       max(n.pack_artifact_hash) AS pack_artifact_hash,
                       count(n.text) AS row_count
                ORDER BY pack_id
                """
            )
            packs = []
            for row in rows:
                row_count = int(row["row_count"] or 0)
                pack_id = str(row.get("pack_id") or "").strip()
                if not pack_id or row_count <= 0:
                    continue
                packs.append(
                    {
                        "pack_id": pack_id,
                        "pack_version": row.get("pack_version", ""),
                        "pack_source_version": row.get("pack_source_version", ""),
                        "language": row.get("language", ""),
                        "domain": row.get("domain", ""),
                        "pack_artifact_hash": row.get("pack_artifact_hash", ""),
                        "row_count": row_count,
                    }
                )
            return packs
    except Exception as exc:
        logger.warning("nornic_installed_packs_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []


def collection_schema_info(collection: str) -> dict[str, Any]:
    del collection
    return {
        "collection": CATALOG_COLLECTION,
        "graph": CATALOG_COLLECTION,
        "schema_version": expected_graph_schema_version(),
        "exists": True,
        "fields": [
            {"name": "id", "type": "string", "is_primary": True, "max_length": 128},
            {"name": "doc_id", "type": "string", "is_primary": False, "max_length": 256},
            {"name": "text", "type": "text", "is_primary": False},
            {"name": "embedding", "type": "vector<float>", "is_primary": False},
            {"name": "domain", "type": "string", "is_primary": False, "max_length": 128},
            {"name": "source_url", "type": "string", "is_primary": False},
            {"name": "document_name", "type": "string", "is_primary": False},
            {"name": "authority", "type": "string", "is_primary": False, "max_length": 32},
            {"name": "visibility_scope", "type": "string", "is_primary": False, "max_length": 16},
            {"name": "acl_group_ids", "type": "list<string>", "is_primary": False},
            {"name": "pack_id", "type": "string", "is_primary": False},
            {"name": "pack_version", "type": "string", "is_primary": False},
            {"name": "symbol_fqn", "type": "string", "is_primary": False},
        ],
        "indexes": [
            {"name": "content_node_id", "field": "id", "type": "unique_constraint", "metric": "exact"},
            {"name": "content_node_pack", "field": "pack", "type": "range", "metric": "exact"},
            {"name": "content_node_version", "field": "source_version", "type": "range", "metric": "exact"},
            {"name": "content_node_symbol", "field": "symbol_fqn", "type": "range", "metric": "exact"},
            {"name": "embeddings", "field": "embedding", "type": "vector", "metric": "cosine"},
        ],
        "node_labels": [
            "ContentNode",
            "Document",
            "File",
            "Package",
            "Module",
            "Chunk",
            "Symbol",
            "Function",
            "Class",
            "Method",
            "Resource",
            "Concept",
            "Pattern",
            "Constraint",
            "Example",
            "ExternalRef",
        ],
        "edge_types": [
            "CONTAINS",
            "DEFINES",
            "CALLS",
            "IMPORTS",
            "REFERENCES",
            "OVERRIDES",
            "IMPLEMENTS",
            "DOCUMENTS",
            "HAS_CONSTRAINT",
            "HAS_EXAMPLE",
            "HAS_PATTERN",
            "APPLIES_TO",
            "DEPRECATED_BY",
            "RELATED_TO",
            "VALID_IN",
            "DERIVED_FROM",
        ],
        "vector_indexes": ["embeddings"],
    }


def collection_domain_hierarchy(collection: str) -> list[dict[str, Any]]:
    del collection
    hierarchy: dict[str, Any] = {}
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                """
                MATCH (n:ContentNode)
                RETURN n.domain AS domain,
                       n.source_url AS source_url,
                       n.document_name AS document_name,
                       n.doc_id AS doc_id,
                       n.pack AS pack,
                       count(n.text) AS chunks
                """
            )
            for row in rows:
                chunks = int(row["chunks"] or 0)
                if chunks <= 0:
                    continue
                domain = str(row.get("domain") or "generalist")
                source = str(
                    row.get("document_name")
                    or row.get("source_url")
                    or row.get("doc_id")
                    or row.get("pack")
                    or "unknown"
                )
                entry = hierarchy.setdefault(domain, {"domain": domain, "total_chunks": 0, "sources": {}})
                entry["total_chunks"] += chunks
                sources = entry["sources"]
                sources[source] = int(sources.get(source, 0)) + chunks
    except Exception as exc:
        logger.warning("nornic_hierarchy_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []

    shaped = []
    for entry in hierarchy.values():
        sources = [
            {"source": source, "chunks": chunks}
            for source, chunks in sorted(entry["sources"].items(), key=lambda item: (-item[1], item[0]))
        ]
        shaped.append({"domain": entry["domain"], "total_chunks": entry["total_chunks"], "sources": sources})
    return sorted(shaped, key=lambda item: item["domain"])
