"""Bulk SynPack v2 importer for NornicDB.

The importer uses the graph-native v2 artifact layout and batched Cypher
``UNWIND`` writes so large content packs load through deterministic high-volume
graph writes instead of one node at a time.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import tempfile
import time
import zipfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from synesis_telemetry import get_logger

from .nornic_writer import (
    NORNIC_BULK_META_NODE_BATCH_SIZE,
    NORNIC_BULK_NODE_BATCH_SIZE,
    NORNIC_URI,
    NornicGraphWriter,
)
from .schema import EMBEDDING_DIM, ensure_synesis_catalog
from .synpack import (
    V2_API_GROUP_VERSIONS_PATH,
    V2_CHUNKS_PATH,
    V2_CONCEPTS_PATH,
    V2_CONSTRAINTS_PATH,
    V2_CONTEXT_CARDS_PATH,
    V2_DOCUMENTS_PATH,
    V2_EVAL_CASES_PATH,
    V2_EXAMPLES_PATH,
    V2_EXTERNAL_REFS_PATH,
    V2_MODULES_PATH,
    V2_PACK_CARDS_PATH,
    V2_PACKAGES_PATH,
    V2_PATTERNS_PATH,
    V2_PLATFORM_COMMANDS_PATH,
    V2_PLATFORM_CONSTRAINTS_PATH,
    V2_QUALITY_PATH,
    V2_RESOURCE_KINDS_PATH,
    V2_RISK_PATTERNS_PATH,
    V2_SCHEMA_PROPERTIES_PATH,
    V2_SYMBOLS_PATH,
    V2_VALIDATION_RECIPES_PATH,
    V2_VECTOR_BINARY_PATH,
    V2_VECTOR_INDEX_PATH,
    SynPackError,
    _iter_jsonl,
    _sha256_file,
    validate_synpack,
)

logger = get_logger("synesis.indexer.nornic_bulk")

_EDGE_BATCH_SIZE = int(os.getenv("SYNESIS_NORNIC_BULK_EDGE_BATCH_SIZE", "2500") or "2500")
_SUSPEND_VECTOR_INDEX = os.getenv("SYNESIS_NORNIC_BULK_SUSPEND_VECTOR_INDEX", "false").strip().lower() in {
    "1",
    "true",
    "yes",
}

_V2_NODE_FILES: tuple[tuple[str, str], ...] = (
    (V2_CHUNKS_PATH, "Chunk"),
    (V2_DOCUMENTS_PATH, "Document"),
    (V2_PACKAGES_PATH, "Package"),
    (V2_MODULES_PATH, "Module"),
    (V2_SYMBOLS_PATH, "Symbol"),
    (V2_CONCEPTS_PATH, "Concept"),
    (V2_PATTERNS_PATH, "Pattern"),
    (V2_CONSTRAINTS_PATH, "Constraint"),
    (V2_EXAMPLES_PATH, "Example"),
    (V2_CONTEXT_CARDS_PATH, "ContextCard"),
    (V2_PACK_CARDS_PATH, "PackCard"),
    (V2_EVAL_CASES_PATH, "EvalCase"),
    (V2_EXTERNAL_REFS_PATH, "ExternalRef"),
    (V2_RESOURCE_KINDS_PATH, "ResourceKind"),
    (V2_API_GROUP_VERSIONS_PATH, "ApiGroupVersion"),
    (V2_SCHEMA_PROPERTIES_PATH, "SchemaProperty"),
    (V2_PLATFORM_CONSTRAINTS_PATH, "PlatformConstraint"),
    (V2_PLATFORM_COMMANDS_PATH, "PlatformCommand"),
    (V2_VALIDATION_RECIPES_PATH, "ValidationRecipe"),
    (V2_RISK_PATTERNS_PATH, "RiskPattern"),
)


class _VectorSidecar:
    def __init__(self, root: Path):
        self._binary = root / V2_VECTOR_BINARY_PATH
        self._index = root / V2_VECTOR_INDEX_PATH
        self._offset_by_chunk: dict[str, int] = {}
        self._file = None
        if not self._binary.exists() or not self._index.exists():
            return
        index = json.loads(self._index.read_text(encoding="utf-8"))
        dims = int(index.get("dimensions", 0) or 0)
        count = int(index.get("count", 0) or 0)
        if dims != EMBEDDING_DIM:
            raise SynPackError(f"vectors/chunks.f32 dimension mismatch: got {dims}, expected {EMBEDDING_DIM}")
        expected = count * EMBEDDING_DIM * 4
        actual = self._binary.stat().st_size
        if actual != expected:
            raise SynPackError(f"vectors/chunks.f32 byte size mismatch: got {actual}, expected {expected}")
        rows = index.get("rows")
        if not isinstance(rows, list):
            raise SynPackError("vectors/index.json rows must be an array")
        for row in rows:
            if not isinstance(row, dict):
                continue
            chunk_id = str(row.get("chunk_id") or "").strip()
            raw_offset = row.get("offset", -1)
            offset = int(raw_offset) if raw_offset is not None else -1
            if chunk_id and 0 <= offset < count:
                self._offset_by_chunk[chunk_id] = offset
        self._file = self._binary.open("rb")

    @property
    def available(self) -> bool:
        return self._file is not None

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None

    def vector_for(self, chunk_id: str) -> list[float] | None:
        if self._file is None:
            return None
        offset = self._offset_by_chunk.get(chunk_id)
        if offset is None:
            return None
        self._file.seek(offset * EMBEDDING_DIM * 4)
        raw = self._file.read(EMBEDDING_DIM * 4)
        if len(raw) != EMBEDDING_DIM * 4:
            raise SynPackError(f"vectors/chunks.f32 missing vector bytes for {chunk_id}")
        return list(struct.unpack(f"<{EMBEDDING_DIM}f", raw))


def _with_manifest_defaults(
    row: dict[str, Any], manifest: dict[str, Any], *, kind: str, artifact_hash: str
) -> dict[str, Any]:
    node_id = str(row.get("id") or row.get("chunk_id") or "").strip()
    if not node_id:
        raise SynPackError(f"{kind} node is missing id")
    pack_id = str(row.get("pack_id") or row.get("pack") or manifest["pack_id"])
    out = dict(row)
    out["id"] = node_id
    out["kind"] = str(row.get("kind") or kind)
    out["pack"] = str(row.get("pack") or pack_id)
    out["pack_id"] = pack_id
    out["pack_version"] = str(row.get("pack_version") or manifest.get("pack_version") or manifest.get("version") or "")
    out["pack_source_version"] = str(
        row.get("pack_source_version") or row.get("source_version") or manifest.get("source_version") or ""
    )
    out["pack_artifact_hash"] = str(row.get("pack_artifact_hash") or artifact_hash)
    out["domain"] = str(row.get("domain") or manifest.get("domain") or "")
    out["content_type"] = str(row.get("content_type") or manifest.get("content_type") or "developer")
    out["language"] = str(row.get("language") or manifest.get("language") or "")
    out["source_release"] = str(row.get("source_release") or manifest.get("source_release") or "")
    out["upstream_commit"] = str(
        row.get("upstream_commit") or manifest.get("upstream_commit") or row.get("commit") or ""
    )
    out["upstream_tag"] = str(row.get("upstream_tag") or manifest.get("upstream_tag") or "")
    out["trust_score"] = row.get("trust_score", manifest.get("trust_score", -1.0))
    out["freshness_score"] = row.get("freshness_score", manifest.get("freshness_score", -1.0))
    out["visibility_scope"] = str(row.get("visibility_scope") or "global")
    out["acl_mode"] = str(row.get("acl_mode") or "open")
    if kind == "Chunk":
        out["chunk_id"] = str(row.get("chunk_id") or node_id)
    return out


def _iter_v2_nodes(
    root: Path,
    manifest: dict[str, Any],
    *,
    artifact_hash: str,
    node_path: str,
    kind: str,
    vectors: _VectorSidecar,
) -> Iterable[dict[str, Any]]:
    path = root / node_path
    if not path.exists():
        return
    for row in _iter_jsonl(path):
        node = _with_manifest_defaults(row, manifest, kind=kind, artifact_hash=artifact_hash)
        if kind == "Chunk":
            chunk_id = str(node.get("chunk_id") or node["id"])
            embedding = node.get("embedding")
            if not isinstance(embedding, list):
                embedding = vectors.vector_for(chunk_id)
            if not isinstance(embedding, list):
                raise SynPackError(f"chunk {chunk_id} is missing embedding vector")
            if len(embedding) != EMBEDDING_DIM:
                raise SynPackError(
                    f"chunk {chunk_id} embedding dimension mismatch: got {len(embedding)}, expected {EMBEDDING_DIM}"
                )
            node["embedding"] = [float(x) for x in embedding]
        else:
            node.pop("embedding", None)
        yield node


def _flush_nodes(
    writer: NornicGraphWriter,
    batch: list[dict[str, Any]],
    *,
    create_only: bool,
    batch_size: int,
) -> int:
    if not batch:
        return 0
    count = writer.bulk_upsert_nodes(batch, create_only=create_only, batch_size=batch_size)
    batch.clear()
    return count


def _import_node_file(
    writer: NornicGraphWriter,
    root: Path,
    manifest: dict[str, Any],
    *,
    artifact_hash: str,
    node_path: str,
    kind: str,
    vectors: _VectorSidecar,
    create_only: bool,
    global_seen_ids: set[str] | None = None,
) -> int:
    path = root / node_path
    if not path.exists():
        return 0
    batch_size = NORNIC_BULK_NODE_BATCH_SIZE if kind == "Chunk" else NORNIC_BULK_META_NODE_BATCH_SIZE
    batch: list[dict[str, Any]] = []
    seen_ids = global_seen_ids if global_seen_ids is not None else set()
    total = 0
    skipped = 0
    for node in _iter_v2_nodes(
        root, manifest, artifact_hash=artifact_hash, node_path=node_path, kind=kind, vectors=vectors
    ):
        node_id = str(node.get("id") or "")
        if node_id in seen_ids:
            skipped += 1
            continue
        seen_ids.add(node_id)
        batch.append(node)
        if len(batch) >= batch_size:
            total += _flush_nodes(writer, batch, create_only=create_only, batch_size=batch_size)
    total += _flush_nodes(writer, batch, create_only=create_only, batch_size=batch_size)
    logger.info(
        "synpack_bulk_node_file_imported",
        extra={"kind": kind, "path": node_path, "count": total, "skipped_duplicates": skipped},
    )
    return total


def _iter_v2_edges(root: Path) -> Iterable[dict[str, Any]]:
    edges_root = root / "edges"
    if not edges_root.exists():
        return
    for path in sorted(edges_root.glob("*.jsonl")):
        yield from _iter_jsonl(path)


def _load_quality_report(root: Path) -> dict[str, Any]:
    path = root / V2_QUALITY_PATH
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def _safe_extract_synpack(zf: zipfile.ZipFile, destination: Path) -> None:
    root = destination.resolve()
    for member in zf.infolist():
        target = (destination / member.filename).resolve()
        if root != target and root not in target.parents:
            raise SynPackError(f"SynPack contains an unsafe path: {member.filename}")
        zf.extract(member, destination)


def _verify_counts(pack_id: str, expected: dict[str, Any], actual: dict[str, Any]) -> None:
    expected_nodes = int(expected.get("node_count") or 0)
    expected_chunks = int(expected.get("chunk_count") or 0)
    expected_edges = int(expected.get("edge_count") or 0)
    if expected_nodes and int(actual.get("node_count") or 0) < expected_nodes:
        raise SynPackError(
            f"bulk import node count mismatch: expected at least {expected_nodes}, got {actual['node_count']}"
        )
    if expected_chunks and int(actual.get("chunk_count") or 0) < expected_chunks:
        raise SynPackError(
            f"bulk import chunk count mismatch for {pack_id}: expected at least {expected_chunks}, got {actual['chunk_count']}"
        )
    if expected_chunks and int(actual.get("embedding_count") or 0) < expected_chunks:
        raise SynPackError(
            f"bulk import embedding count mismatch for {pack_id}: expected at least {expected_chunks}, "
            f"got {actual['embedding_count']}"
        )
    if expected_edges and int(actual.get("edge_count") or 0) < expected_edges:
        raise SynPackError(
            f"bulk import edge count mismatch: expected at least {expected_edges}, got {actual['edge_count']}"
        )


def bulk_load_synpack(
    pack_path: str | Path,
    *,
    nornic_uri: str = NORNIC_URI,
    replace: bool = False,
) -> dict[str, Any]:
    """Import a graph-native SynPack v2 bundle through batched NornicDB writes."""

    started = time.perf_counter()
    nornic_uri = nornic_uri or NORNIC_URI
    manifest = validate_synpack(pack_path)
    pack_id = str(manifest["pack_id"])
    tmp = Path(tempfile.mkdtemp(prefix="synpack-bulk-load-"))
    writer: NornicGraphWriter | None = None
    vectors: _VectorSidecar | None = None
    vector_index_suspended = False
    try:
        logger.info("synpack_bulk_extract_start", extra={"pack_id": pack_id, "pack_path": str(pack_path)})
        with zipfile.ZipFile(pack_path) as zf:
            _safe_extract_synpack(zf, tmp)
        if not (tmp / V2_CHUNKS_PATH).exists():
            raise SynPackError("bulk import requires a SynPack v2 nodes/chunks.jsonl artifact")
        logger.info("synpack_bulk_extract_complete", extra={"pack_id": pack_id, "work_dir": str(tmp)})

        artifact_hash = _sha256_file(Path(pack_path))
        manifest["artifact_hash"] = artifact_hash
        quality_report = _load_quality_report(tmp)
        if int(quality_report.get("dangling_edge_count") or 0) > 0:
            raise SynPackError("bulk import requires a SynPack v2 graph without dangling edges")

        writer = NornicGraphWriter(uri=nornic_uri)
        logger.info("synpack_bulk_schema_start", extra={"pack_id": pack_id, "nornic_uri": nornic_uri})
        ensure_synesis_catalog(writer.client)
        logger.info("synpack_bulk_schema_complete", extra={"pack_id": pack_id})
        if replace:
            logger.info("synpack_bulk_replace_start", extra={"pack_id": pack_id})
            deleted = writer.delete_pack(pack_id)
            logger.info("synpack_bulk_replace_complete", extra={"pack_id": pack_id, "deleted": deleted})
        else:
            deleted = 0
        if _SUSPEND_VECTOR_INDEX:
            logger.info("synpack_bulk_vector_index_suspend_start", extra={"pack_id": pack_id})
            writer.suspend_vector_index()
            vector_index_suspended = True
            logger.info("synpack_bulk_vector_index_suspend_complete", extra={"pack_id": pack_id})

        logger.info("synpack_bulk_vectors_start", extra={"pack_id": pack_id})
        vectors = _VectorSidecar(tmp)
        if not vectors.available:
            raise SynPackError("bulk import requires vectors/index.json and vectors/chunks.f32")
        logger.info("synpack_bulk_vectors_ready", extra={"pack_id": pack_id})

        nodes = 0
        node_counts_by_kind: dict[str, int] = {}
        global_seen_ids: set[str] = set()
        for node_path, kind in _V2_NODE_FILES:
            logger.info("synpack_bulk_node_file_start", extra={"pack_id": pack_id, "kind": kind, "path": node_path})
            count = _import_node_file(
                writer,
                tmp,
                manifest,
                artifact_hash=artifact_hash,
                node_path=node_path,
                kind=kind,
                vectors=vectors,
                create_only=replace,
                global_seen_ids=global_seen_ids,
            )
            if count:
                node_counts_by_kind[kind] = count
                nodes += count

        logger.info("synpack_bulk_edges_start", extra={"pack_id": pack_id})
        edges = list(_iter_v2_edges(tmp))
        edge_count = writer.upsert_edges(edges)
        logger.info("synpack_bulk_edges_complete", extra={"pack_id": pack_id, "edges": edge_count})

        logger.info("synpack_bulk_verify_start", extra={"pack_id": pack_id})
        actual_counts = writer.pack_counts(pack_id)
        _verify_counts(pack_id, quality_report, actual_counts)
        logger.info("synpack_bulk_verify_complete", extra={"pack_id": pack_id, "verification": actual_counts})

        if vector_index_suspended:
            logger.info("synpack_bulk_vector_index_restore_start", extra={"pack_id": pack_id})
            writer.restore_vector_index()
            vector_index_suspended = False
            logger.info("synpack_bulk_vector_index_restore_complete", extra={"pack_id": pack_id})

        elapsed = max(time.perf_counter() - started, 0.001)
        return {
            "ok": True,
            "backend": "bolt-unwind",
            "pack_id": pack_id,
            "nodes": nodes,
            "node_counts_by_kind": node_counts_by_kind,
            "edges": edge_count,
            "deleted_existing_nodes": deleted,
            "artifact_hash": artifact_hash,
            "duration_ms": round(elapsed * 1000, 1),
            "nodes_per_sec": round(nodes / elapsed, 1),
            "edges_per_sec": round(edge_count / elapsed, 1),
            "verification": actual_counts,
            "quality": quality_report,
        }
    finally:
        if vector_index_suspended and writer is not None:
            try:
                writer.restore_vector_index()
            except Exception as exc:
                logger.warning(
                    "synpack_bulk_vector_index_restore_failed",
                    extra={"pack_id": pack_id, "error": str(exc)[:500]},
                )
        if vectors is not None:
            vectors.close()
        if writer is not None:
            writer.close()
        shutil.rmtree(tmp, ignore_errors=True)
