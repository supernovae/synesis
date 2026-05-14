"""NornicDB graph writer with idempotent content-node upserts."""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any

from neo4j import GraphDatabase
from neo4j.exceptions import Neo4jError
from synesis_telemetry import get_logger

from .schema import GRAPH_EDGE_TYPES, SCHEMA_VERSION, SYNESIS_CATALOG

logger = get_logger("synesis.indexer.nornic")

NORNIC_URI = os.getenv("SYNESIS_NORNIC_URI", "bolt://synesis-nornicdb.synesis-rag.svc.cluster.local:7687")
NORNIC_USER = os.getenv("SYNESIS_NORNIC_USER", "neo4j")
NORNIC_PASSWORD = os.getenv("SYNESIS_NORNIC_PASSWORD", "synesis-nornicdb")
NORNIC_DATABASE = os.getenv("SYNESIS_NORNIC_DATABASE", "nornic")
NORNIC_VECTOR_INDEX = os.getenv("SYNESIS_NORNIC_VECTOR_INDEX", "embeddings")
DELETE_BATCH_SIZE = 500
EDGE_BATCH_SIZE = 1000
NORNIC_BULK_NODE_BATCH_SIZE = int(os.getenv("SYNESIS_NORNIC_BULK_NODE_BATCH_SIZE", "250") or "250")
NORNIC_BULK_META_NODE_BATCH_SIZE = int(os.getenv("SYNESIS_NORNIC_BULK_META_NODE_BATCH_SIZE", "1000") or "1000")
PREFETCH_EXISTING_IDS = os.getenv("SYNESIS_NORNIC_PREFETCH_EXISTING_IDS", "").strip().lower() in {
    "1",
    "true",
    "yes",
}
FAST_NODE_CREATE = os.getenv("SYNESIS_NORNIC_FAST_NODE_CREATE", "true").strip().lower() not in {
    "0",
    "false",
    "no",
}


def chunk_id_hash(text: str, source: str) -> str:
    content = f"{source}:{text[:500]}"
    return hashlib.sha256(content.encode()).hexdigest()[:64]


class NornicGraphWriter:
    """Writes content graph nodes and deterministic relationships to NornicDB."""

    def __init__(
        self,
        uri: str = NORNIC_URI,
        user: str = NORNIC_USER,
        password: str = NORNIC_PASSWORD,
        database: str = NORNIC_DATABASE,
    ):
        self.uri = uri
        self.database = database
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        self.client = self
        self._schema_ready = False

    def close(self) -> None:
        self.driver.close()

    def ensure_schema(self) -> None:
        statements = [
            "CREATE CONSTRAINT content_node_id IF NOT EXISTS FOR (n:ContentNode) REQUIRE n.id IS UNIQUE",
            "CREATE INDEX content_node_pack IF NOT EXISTS FOR (n:ContentNode) ON (n.pack)",
            "CREATE INDEX content_node_source_version IF NOT EXISTS FOR (n:ContentNode) ON (n.source_version)",
            "CREATE INDEX content_node_kind IF NOT EXISTS FOR (n:ContentNode) ON (n.kind)",
            "CREATE INDEX content_node_domain IF NOT EXISTS FOR (n:ContentNode) ON (n.domain)",
            "CREATE INDEX content_node_content_type IF NOT EXISTS FOR (n:ContentNode) ON (n.content_type)",
            "CREATE INDEX content_node_language IF NOT EXISTS FOR (n:ContentNode) ON (n.language)",
            "CREATE INDEX content_node_package IF NOT EXISTS FOR (n:ContentNode) ON (n.package_name)",
            "CREATE INDEX content_node_symbol_fqn IF NOT EXISTS FOR (n:ContentNode) ON (n.symbol_fqn)",
            "CREATE INDEX content_node_artifact_kind IF NOT EXISTS FOR (n:ContentNode) ON (n.artifact_kind)",
            "CREATE INDEX content_node_deprecated IF NOT EXISTS FOR (n:ContentNode) ON (n.deprecated)",
            "CREATE INDEX content_node_path IF NOT EXISTS FOR (n:ContentNode) ON (n.path)",
            "CREATE INDEX content_node_acl IF NOT EXISTS FOR (n:ContentNode) ON (n.visibility_scope, n.org_id, n.tenant_id)",
            "CREATE INDEX content_node_authz_object IF NOT EXISTS FOR (n:ContentNode) ON (n.authz_object_id)",
            "CREATE VECTOR INDEX embeddings IF NOT EXISTS FOR (n:ContentNode) ON (n.embedding)",
        ]
        with self.driver.session(database=self.database) as session:
            for statement in statements:
                session.run(statement)
            session.run(
                """
                MERGE (s:GraphSchema {name: $name})
                SET s.version = $version, s.updated_at_epoch = timestamp()
                """,
                name=SYNESIS_CATALOG,
                version=SCHEMA_VERSION,
            )
        self._schema_ready = True

    def existing_chunk_ids(self, collection_name: str = SYNESIS_CATALOG) -> set[str]:
        del collection_name
        with self.driver.session(database=self.database) as session:
            rows = session.run(
                """
                MATCH (n:ContentNode)
                WHERE n.text IS NOT NULL OR n.embedding IS NOT NULL
                RETURN n.id AS id
                """
            )
            return {str(row["id"]) for row in rows if row.get("id")}

    def upsert_batch(self, entities: list[dict[str, Any]], collection_name: str = SYNESIS_CATALOG) -> int:
        del collection_name
        if not entities:
            return 0
        if not getattr(self, "_schema_ready", False):
            self.ensure_schema()
        total = 0
        existing_ids = self.existing_chunk_ids() if PREFETCH_EXISTING_IDS else set()
        batch_size = int(os.getenv("SYNESIS_NORNIC_WRITE_BATCH_SIZE", "50") or "50")
        batch_size = max(1, min(batch_size, 250))
        for i in range(0, len(entities), batch_size):
            batch = entities[i : i + batch_size]
            deduped: dict[str, dict[str, Any]] = {}
            for entity in batch:
                entity_id = str(entity["id"])
                if not PREFETCH_EXISTING_IDS or entity_id not in existing_ids:
                    deduped[entity_id] = entity
            rows = list(deduped.values())
            if not rows:
                continue
            with self.driver.session(database=self.database) as session:
                if FAST_NODE_CREATE:
                    try:
                        session.execute_write(self._create_nodes_tx, rows)
                    except Neo4jError as exc:
                        logger.warning(
                            "indexer_graph_nodes_fast_create_fallback",
                            extra={"count": len(rows), "offset": i, "error": str(exc)[:500]},
                        )
                        session.execute_write(self._upsert_nodes_tx, rows)
                else:
                    session.execute_write(self._upsert_nodes_tx, rows)
            existing_ids.update(deduped.keys())
            total += len(rows)
            logger.info("indexer_graph_nodes_batch_written", extra={"count": len(rows), "offset": i})
        return total

    @staticmethod
    def _create_nodes_tx(tx: Any, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            node_id = str(row["id"])
            tx.run("CREATE (n:ContentNode {id: $id})", id=node_id)
            tx.run(
                "MATCH (n:ContentNode) WHERE n.id = $id SET n += $props",
                id=node_id,
                props=NornicGraphWriter._clean_props(row),
            )

    @staticmethod
    def _upsert_nodes_tx(tx: Any, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            NornicGraphWriter._upsert_node_tx(tx, row)

    @staticmethod
    def _clean_props(row: dict[str, Any]) -> dict[str, Any]:
        props: dict[str, Any] = {}
        for key, value in row.items():
            if key == "id" or value is None:
                continue
            props[str(key)] = NornicGraphWriter._clean_prop_value(value)
        return props

    @staticmethod
    def _clean_prop_value(value: Any) -> Any:
        if isinstance(value, str | int | float | bool):
            return value
        if isinstance(value, list):
            if all(isinstance(item, str | int | float | bool) for item in value):
                return value
            return json.dumps(value, ensure_ascii=False, sort_keys=True)
        if isinstance(value, dict):
            return json.dumps(value, ensure_ascii=False, sort_keys=True)
        return str(value)

    def bulk_upsert_nodes(
        self,
        rows: list[dict[str, Any]],
        *,
        create_only: bool = False,
        batch_size: int | None = None,
    ) -> int:
        if not rows:
            return 0
        if not getattr(self, "_schema_ready", False):
            self.ensure_schema()
        size = batch_size if batch_size is not None else NORNIC_BULK_NODE_BATCH_SIZE
        size = max(1, min(int(size), 5000))
        total = 0
        for i in range(0, len(rows), size):
            batch = rows[i : i + size]
            with self.driver.session(database=self.database) as session:
                if create_only:
                    try:
                        session.execute_write(self._bulk_create_nodes_tx, batch)
                    except Neo4jError as exc:
                        logger.warning(
                            "nornic_bulk_create_nodes_fallback",
                            extra={"count": len(batch), "offset": i, "error": str(exc)[:500]},
                        )
                        session.execute_write(self._bulk_upsert_nodes_tx, batch)
                else:
                    session.execute_write(self._bulk_upsert_nodes_tx, batch)
            total += len(batch)
            logger.info("nornic_bulk_nodes_batch_written", extra={"count": len(batch), "offset": i})
        return total

    @staticmethod
    def _bulk_create_nodes_tx(tx: Any, rows: list[dict[str, Any]]) -> None:
        tx.run(
            """
            UNWIND $rows AS row
            CREATE (n:ContentNode {id: row.id})
            SET n += row.props
            """,
            rows=NornicGraphWriter._node_param_rows(rows),
        )

    @staticmethod
    def _bulk_upsert_nodes_tx(tx: Any, rows: list[dict[str, Any]]) -> None:
        tx.run(
            """
            UNWIND $rows AS row
            MERGE (n:ContentNode {id: row.id})
            SET n += row.props
            """,
            rows=NornicGraphWriter._node_param_rows(rows),
        )

    @staticmethod
    def _node_param_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {"id": str(row["id"]), "props": NornicGraphWriter._clean_props(row)}
            for row in rows
            if str(row.get("id") or "")
        ]

    @staticmethod
    def _upsert_node_tx(tx: Any, row: dict[str, Any]) -> None:
        node_id = str(row["id"])
        NornicGraphWriter._upsert_content_node_tx(tx, node_id, NornicGraphWriter._clean_props(row))

    @staticmethod
    def _upsert_content_node_tx(tx: Any, node_id: str, props: dict[str, Any]) -> None:
        NornicGraphWriter._ensure_content_node_tx(tx, node_id)
        tx.run("MATCH (n:ContentNode) WHERE n.id = $id SET n += $props", id=node_id, props=props)

    @staticmethod
    def _ensure_content_node_tx(tx: Any, node_id: str) -> None:
        row = tx.run(
            """
            MATCH (n:ContentNode)
            WHERE n.id = $id
            RETURN count(n) AS existing
            """,
            id=node_id,
        ).single()
        if row and int(row["existing"] or 0) > 0:
            return
        tx.run("CREATE (n:ContentNode {id: $id})", id=node_id)

    def upsert_edges(self, edges: list[dict[str, Any]]) -> int:
        if not edges:
            return 0
        grouped: dict[str, list[dict[str, Any]]] = {}
        seen: set[tuple[str, str, str, str]] = set()
        total = 0
        for edge in edges:
            edge_type = str(edge.get("type", "")).upper()
            if edge_type not in GRAPH_EDGE_TYPES:
                logger.warning("nornic_edge_rejected", extra={"edge_type": edge_type})
                continue
            source_id = str(edge.get("source_id") or edge.get("from") or "")
            target_id = str(edge.get("target_id") or edge.get("to") or "")
            if not source_id or not target_id:
                continue
            props = {k: v for k, v in edge.items() if k not in {"type", "source_id", "target_id", "from", "to"}}
            key = (edge_type, source_id, target_id, repr(sorted(props.items())))
            if key in seen:
                continue
            seen.add(key)
            grouped.setdefault(edge_type, []).append({"source_id": source_id, "target_id": target_id, "props": props})
            total += 1
        for edge_type, rows in grouped.items():
            self._write_edge_group(edge_type, rows)
        return total

    def _write_edge_group(self, edge_type: str, rows: list[dict[str, Any]]) -> None:
        batch_size = int(os.getenv("SYNESIS_NORNIC_EDGE_BATCH_SIZE", str(EDGE_BATCH_SIZE)) or str(EDGE_BATCH_SIZE))
        batch_size = max(1, min(batch_size, 2500))
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            with self.driver.session(database=self.database) as session:
                session.execute_write(self._write_edges_tx, edge_type, batch)
            logger.info(
                "indexer_graph_edges_batch_written",
                extra={"edge_type": edge_type, "count": len(batch), "offset": i},
            )

    @staticmethod
    def _write_edges_tx(tx: Any, edge_type: str, rows: list[dict[str, Any]]) -> None:
        cypher = f"""
        UNWIND $rows AS row
        MATCH (a:ContentNode)
        WHERE a.id = row.source_id
        MATCH (b:ContentNode)
        WHERE b.id = row.target_id
        MERGE (a)-[r:{edge_type}]->(b)
        SET r += row.props
        """
        tx.run(
            cypher,
            rows=[
                {
                    "source_id": str(row["source_id"]),
                    "target_id": str(row["target_id"]),
                    "props": NornicGraphWriter._clean_props(row.get("props") or {}),
                }
                for row in rows
            ],
        )

    def delete_by_doc_id(self, doc_id: str, collection_name: str = SYNESIS_CATALOG) -> int:
        del collection_name
        with self.driver.session(database=self.database) as session:
            result = session.run(
                """
                MATCH (n:ContentNode {doc_id: $doc_id})
                DETACH DELETE n
                RETURN count(n) AS deleted
                """,
                doc_id=doc_id,
            )
            row = result.single()
            count = int(row["deleted"]) if row else 0
        logger.info("indexer_graph_nodes_deleted", extra={"count": count, "doc_id": doc_id})
        return count

    def delete_pack(self, pack_id: str) -> int:
        deleted = 0
        with self.driver.session(database=self.database) as session:
            while True:
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
                ids = [str(row["id"]) for row in rows if row.get("id")]
                if not ids:
                    return deleted
                session.run("MATCH (n:ContentNode) WHERE n.id IN $ids DETACH DELETE n", ids=ids)
                deleted += len(ids)

    def delete_partial_ids(self, ids: list[str]) -> int:
        """Delete id-only nodes left behind by interrupted or failed writes."""
        cleaned_ids = list(dict.fromkeys(str(node_id) for node_id in ids if str(node_id)))
        deleted = 0
        for i in range(0, len(cleaned_ids), DELETE_BATCH_SIZE):
            batch = cleaned_ids[i : i + DELETE_BATCH_SIZE]
            with self.driver.session(database=self.database) as session:
                rows = session.run(
                    """
                    MATCH (n:ContentNode)
                    WHERE n.id IN $ids
                      AND coalesce(n.pack, "") = ""
                      AND n.text IS NULL
                      AND n.embedding IS NULL
                    RETURN n.id AS id
                    """,
                    ids=batch,
                )
                partial_ids = [str(row["id"]) for row in rows if row.get("id")]
                if not partial_ids:
                    continue
                session.run("MATCH (n:ContentNode) WHERE n.id IN $ids DETACH DELETE n", ids=partial_ids)
                deleted += len(partial_ids)
        return deleted

    def pack_counts(self, pack_id: str) -> dict[str, Any]:
        with self.driver.session(database=self.database) as session:
            kind_rows = session.run(
                """
                MATCH (n:ContentNode)
                WHERE n.pack = $pack_id OR n.pack_id = $pack_id
                RETURN coalesce(n.kind, "") AS kind,
                       count(n) AS count,
                       count(n.text) AS chunks,
                       count(n.embedding) AS embeddings
                """,
                pack_id=pack_id,
            )
            node_count = 0
            chunk_count = 0
            embedding_count = 0
            counts_by_kind: dict[str, int] = {}
            for row in kind_rows:
                kind = str(row.get("kind") or "Unknown")
                count = int(row.get("count") or 0)
                node_count += count
                chunk_count += int(row.get("chunks") or 0)
                embedding_count += int(row.get("embeddings") or 0)
                counts_by_kind[kind] = counts_by_kind.get(kind, 0) + count
            edge_row = session.run(
                """
                MATCH (a:ContentNode)-[r]->(b:ContentNode)
                WHERE (a.pack = $pack_id OR a.pack_id = $pack_id)
                  AND (b.pack = $pack_id OR b.pack_id = $pack_id)
                RETURN count(r) AS count
                """,
                pack_id=pack_id,
            ).single()
        return {
            "node_count": node_count,
            "chunk_count": chunk_count,
            "embedding_count": embedding_count,
            "edge_count": int(edge_row["count"] or 0) if edge_row else 0,
            "node_counts_by_kind": counts_by_kind,
        }


@dataclass
class ProgressTracker:
    """Track indexing progress with counts and timing."""

    name: str
    total_chunks: int = 0
    total_sources: int = 0
    errors: int = 0
    start_time: float = field(default_factory=time.time)

    def log_source(self, source_name: str, chunk_count: int) -> None:
        self.total_sources += 1
        self.total_chunks += chunk_count
        logger.info(
            "indexer_source_complete",
            extra={
                "source_index": self.total_sources,
                "source": source_name,
                "chunks": chunk_count,
                "total_chunks": self.total_chunks,
            },
        )

    def log_error(self, source_name: str, error: str) -> None:
        self.errors += 1
        logger.warning(
            "indexer_source_error",
            extra={"source_index": self.total_sources, "source": source_name, "error": error},
        )

    def log_complete(self) -> None:
        elapsed = time.time() - self.start_time
        logger.info(
            "indexer_pipeline_complete",
            extra={
                "pipeline": self.name,
                "chunks": self.total_chunks,
                "sources": self.total_sources,
                "errors": self.errors,
                "elapsed_s": round(elapsed, 1),
            },
        )
