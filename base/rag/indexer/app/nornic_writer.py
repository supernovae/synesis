"""NornicDB graph writer with idempotent content-node upserts."""

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass, field
from typing import Any

from neo4j import GraphDatabase
from synesis_telemetry import get_logger

from .schema import GRAPH_EDGE_TYPES, SCHEMA_VERSION, SYNESIS_CATALOG

logger = get_logger("synesis.indexer.nornic")

NORNIC_URI = os.getenv("SYNESIS_NORNIC_URI", "bolt://synesis-nornicdb.synesis-rag.svc.cluster.local:7687")
NORNIC_USER = os.getenv("SYNESIS_NORNIC_USER", "neo4j")
NORNIC_PASSWORD = os.getenv("SYNESIS_NORNIC_PASSWORD", "synesis-nornicdb")
NORNIC_DATABASE = os.getenv("SYNESIS_NORNIC_DATABASE", "nornic")
NORNIC_VECTOR_INDEX = os.getenv("SYNESIS_NORNIC_VECTOR_INDEX", "embeddings")


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

    def close(self) -> None:
        self.driver.close()

    def ensure_schema(self) -> None:
        statements = [
            "CREATE CONSTRAINT content_node_id IF NOT EXISTS FOR (n:ContentNode) REQUIRE n.id IS UNIQUE",
            "CREATE INDEX content_node_pack IF NOT EXISTS FOR (n:ContentNode) ON (n.pack)",
            "CREATE INDEX content_node_source_version IF NOT EXISTS FOR (n:ContentNode) ON (n.source_version)",
            "CREATE INDEX content_node_symbol_fqn IF NOT EXISTS FOR (n:ContentNode) ON (n.symbol_fqn)",
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

    def existing_chunk_ids(self, collection_name: str = SYNESIS_CATALOG) -> set[str]:
        del collection_name
        with self.driver.session(database=self.database) as session:
            rows = session.run("MATCH (n:ContentNode) RETURN n.id AS id")
            return {str(row["id"]) for row in rows if row.get("id")}

    def upsert_batch(self, entities: list[dict[str, Any]], collection_name: str = SYNESIS_CATALOG) -> int:
        del collection_name
        if not entities:
            return 0
        self.ensure_schema()
        total = 0
        for i in range(0, len(entities), 250):
            batch = entities[i : i + 250]
            deduped: dict[str, dict[str, Any]] = {}
            for entity in batch:
                deduped[str(entity["id"])] = entity
            rows = list(deduped.values())
            with self.driver.session(database=self.database) as session:
                session.execute_write(self._upsert_nodes_tx, rows)
            total += len(rows)
        return total

    @staticmethod
    def _upsert_nodes_tx(tx: Any, rows: list[dict[str, Any]]) -> None:
        tx.run(
            """
            UNWIND $rows AS row
            MERGE (n:ContentNode {id: row.id})
            SET n += row
            WITH n, row
            FOREACH (_ IN CASE WHEN row.doc_id <> "" THEN [1] ELSE [] END |
              MERGE (d:ContentNode:Document {id: row.doc_id})
              SET d.pack = row.pack,
                  d.pack_version = row.pack_version,
                  d.source_version = row.source_version,
                  d.name = row.document_name,
                  d.path = row.path,
                  d.visibility_scope = row.visibility_scope,
                  d.org_id = row.org_id,
                  d.tenant_id = row.tenant_id,
                  d.owner_user_id = row.owner_user_id,
                  d.conversation_id = row.conversation_id,
                  d.acl_mode = row.acl_mode,
                  d.acl_groups = row.acl_groups,
                  d.acl_group_ids = row.acl_group_ids,
                  d.authz_object_id = row.authz_object_id
              MERGE (d)-[:CONTAINS]->(n)
            )
            WITH n, row
            FOREACH (_ IN CASE WHEN row.path <> "" THEN [1] ELSE [] END |
              MERGE (f:ContentNode:File {id: row.pack + ":file:" + row.path})
              SET f.pack = row.pack,
                  f.pack_version = row.pack_version,
                  f.source_version = row.source_version,
                  f.name = row.path,
                  f.path = row.path,
                  f.repo_path = row.repo_path,
                  f.module_path = row.module_path,
                  f.kind = "File",
                  f.language = row.language,
                  f.visibility_scope = row.visibility_scope,
                  f.org_id = row.org_id,
                  f.tenant_id = row.tenant_id,
                  f.owner_user_id = row.owner_user_id,
                  f.conversation_id = row.conversation_id,
                  f.acl_mode = row.acl_mode,
                  f.acl_groups = row.acl_groups,
                  f.acl_group_ids = row.acl_group_ids,
                  f.authz_object_id = row.authz_object_id
              MERGE (f)-[:CONTAINS]->(n)
            )
            WITH n, row
            FOREACH (_ IN CASE WHEN row.symbol_fqn <> "" THEN [1] ELSE [] END |
              MERGE (s:ContentNode:Symbol {id: row.symbol_fqn})
              SET s.pack = row.pack,
                  s.pack_version = row.pack_version,
                  s.source_version = row.source_version,
                  s.symbol_fqn = row.symbol_fqn,
                  s.symbol_name = row.symbol_name,
                  s.symbol_kind = row.symbol_kind,
                  s.language = row.language,
                  s.path = row.path,
                  s.repo_path = row.repo_path,
                  s.visibility_scope = row.visibility_scope,
                  s.org_id = row.org_id,
                  s.tenant_id = row.tenant_id,
                  s.owner_user_id = row.owner_user_id,
                  s.conversation_id = row.conversation_id,
                  s.acl_mode = row.acl_mode,
                  s.acl_groups = row.acl_groups,
                  s.acl_group_ids = row.acl_group_ids,
                  s.authz_object_id = row.authz_object_id
              MERGE (n)-[:DEFINES]->(s)
            )
            """,
            rows=rows,
        )

    def upsert_edges(self, edges: list[dict[str, Any]]) -> int:
        if not edges:
            return 0
        grouped: dict[str, list[dict[str, Any]]] = {}
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
            grouped.setdefault(edge_type, []).append({"source_id": source_id, "target_id": target_id, "props": props})
            total += 1
        for edge_type, rows in grouped.items():
            self._write_edge_group(edge_type, rows)
        return total

    def _write_edge_group(self, edge_type: str, rows: list[dict[str, Any]]) -> None:
        cypher = f"""
        UNWIND $rows AS row
        MERGE (a:ContentNode {{id: row.source_id}})
        MERGE (b:ContentNode {{id: row.target_id}})
        MERGE (a)-[r:{edge_type}]->(b)
        SET r += row.props
        """
        for i in range(0, len(rows), 500):
            with self.driver.session(database=self.database) as session:
                session.run(cypher, rows=rows[i : i + 500])

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
        with self.driver.session(database=self.database) as session:
            result = session.run(
                """
                MATCH (n:ContentNode {pack: $pack_id})
                DETACH DELETE n
                RETURN count(n) AS deleted
                """,
                pack_id=pack_id,
            )
            row = result.single()
            return int(row["deleted"]) if row else 0


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
