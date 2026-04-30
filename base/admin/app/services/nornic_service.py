"""Reusable NornicDB graph query abstractions for admin views."""

from __future__ import annotations

import logging
import os
from typing import Any

from ..deps import CATALOG_COLLECTION, NORNIC_DATABASE, get_nornic_driver

logger = logging.getLogger("synesis.admin.nornic")

SCHEMA_VERSION = 18


def expected_graph_schema_version() -> int:
    return int(os.environ.get("SYNESIS_EXPECTED_GRAPH_SCHEMA_VERSION", str(SCHEMA_VERSION)))


def recreate_content_graph(collection: str = CATALOG_COLLECTION) -> dict[str, Any]:
    del collection
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            session.run("MATCH (n:ContentNode) DETACH DELETE n")
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
                version=SCHEMA_VERSION,
            )
        return {"ok": True, "graph": CATALOG_COLLECTION, "schema_version": SCHEMA_VERSION, "dropped": True}
    except Exception as exc:
        return {"ok": False, "error": f"recreate_failed: {str(exc)[:200]}", "dropped": False}


def safe_query(
    collection: str,
    filter_expr: str = "",
    output_fields: list[str] | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    del collection, filter_expr
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
            return out
    except Exception as exc:
        logger.warning("nornic_query_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []


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
            node_count = session.run("MATCH (n:ContentNode) RETURN count(n) AS c").single()["c"]
            edge_count = session.run("MATCH (:ContentNode)-[r]->(:ContentNode) RETURN count(r) AS c").single()["c"]
            pack_count = session.run("MATCH (n:ContentNode) RETURN count(DISTINCT n.pack) AS c").single()["c"]
        return {"row_count": int(node_count), "node_count": int(node_count), "edge_count": int(edge_count), "pack_count": int(pack_count)}
    except Exception as exc:
        logger.warning("nornic_stats_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:80])
        return {"row_count": 0, "node_count": 0, "edge_count": 0, "pack_count": 0}


def collection_schema_info(collection: str) -> dict[str, Any]:
    del collection
    return {
        "collection": CATALOG_COLLECTION,
        "graph": CATALOG_COLLECTION,
        "schema_version": expected_graph_schema_version(),
        "node_labels": ["ContentNode", "Document", "File", "Chunk", "Symbol", "Function", "Class", "Method", "Resource", "Concept"],
        "edge_types": ["CONTAINS", "DEFINES", "CALLS", "IMPORTS", "REFERENCES", "OVERRIDES", "IMPLEMENTS", "DOCUMENTS", "VALID_IN", "DERIVED_FROM"],
        "vector_indexes": ["embeddings"],
    }


def collection_domain_hierarchy(collection: str) -> dict[str, Any]:
    del collection
    rows = safe_query(CATALOG_COLLECTION, output_fields=["domain", "source_type", "handler", "pack"], limit=5000)
    hierarchy: dict[str, Any] = {}
    for row in rows:
        domain = str(row.get("domain") or "generalist")
        entry = hierarchy.setdefault(domain, {"domain": domain, "count": 0, "packs": set()})
        entry["count"] += 1
        if row.get("pack"):
            entry["packs"].add(row["pack"])
    for entry in hierarchy.values():
        entry["packs"] = sorted(entry["packs"])
    return {"domains": sorted(hierarchy.values(), key=lambda x: x["domain"])}
