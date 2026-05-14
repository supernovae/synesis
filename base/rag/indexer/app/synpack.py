"""Graph content pack build/load utilities.

Content packs are ZIP-based, graph-aware documentation/code packs. A pack contains
at least:

- manifest.json
- nodes.jsonl or metadata.jsonl
- edges.jsonl

Optional files include cleaned Markdown, vectors.npy, embedder.onnx, and graph
exports. The loader validates manifest compatibility before writing nodes and
relationships into the NornicDB content graph.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import struct
import tempfile
import time
import zipfile
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import yaml
from synesis_telemetry import get_logger

from .code_graph import derive_graph_edges
from .embed_client import EmbedClient
from .enrichment import enrich_chunks_bulk
from .handlers import get_handler
from .handlers.base import Chunk, RawDocument
from .injection_scan import scan_chunk_text_detailed
from .nornic_writer import NORNIC_URI, NornicGraphWriter, chunk_id_hash
from .pipeline import _code_chunk_metrics, _infer_artifact_kind
from .queue_runner import _build_source_config
from .schema import (
    CORPUS_VERSION,
    EMBEDDING_DIM,
    EMBEDDING_MODEL,
    EMBEDDING_PROFILE,
    SCHEMA_VERSION,
    catalog_entity,
    ensure_synesis_catalog,
)

logger = get_logger("synesis.indexer.synpack")

SYNPACK_FORMAT_VERSION = "2.0"
DEFAULT_PACK_MODEL = EMBEDDING_MODEL
DELETE_PARTIAL_IDS = os.getenv("SYNESIS_NORNIC_DELETE_PARTIAL_IDS", "").strip().lower() in {"1", "true", "yes"}
V2_CHUNKS_PATH = "nodes/chunks.jsonl"
V2_DOCUMENTS_PATH = "nodes/documents.jsonl"
V2_PACKAGES_PATH = "nodes/packages.jsonl"
V2_MODULES_PATH = "nodes/modules.jsonl"
V2_SYMBOLS_PATH = "nodes/symbols.jsonl"
V2_CONCEPTS_PATH = "nodes/concepts.jsonl"
V2_PATTERNS_PATH = "nodes/patterns.jsonl"
V2_CONSTRAINTS_PATH = "nodes/constraints.jsonl"
V2_EXAMPLES_PATH = "nodes/examples.jsonl"
V2_EXTERNAL_REFS_PATH = "nodes/external_refs.jsonl"
V2_ENRICHMENT_PATH = "enrichment/enrichment.jsonl"
V2_QUALITY_PATH = "quality/report.json"
V2_VECTOR_INDEX_PATH = "vectors/index.json"
V2_VECTOR_BINARY_PATH = "vectors/chunks.f32"


class SynPackError(ValueError):
    """Raised when a SynPack is invalid or incompatible."""


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _sanitize_pack_id(value: str) -> str:
    safe = []
    for ch in value.strip().lower():
        if ch.isalnum() or ch in {"-", "_"}:
            safe.append(ch)
        elif ch in {".", "/", " "}:
            safe.append("-")
    out = "".join(safe).strip("-_")
    if not out:
        raise SynPackError("pack_id is required")
    return out[:96]


def read_manifest(pack_path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(pack_path) as zf:
        try:
            raw = zf.read("manifest.json")
        except KeyError as exc:
            raise SynPackError("manifest.json missing from SynPack") from exc
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SynPackError(f"manifest.json is not valid JSON: {exc}") from exc
    if not isinstance(manifest, dict):
        raise SynPackError("manifest.json must be an object")
    return manifest


def validate_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    pack_id = _sanitize_pack_id(str(manifest.get("pack_id", "")))
    model = str(manifest.get("embedding_model", manifest.get("recommended_model", "")) or "")
    dims = int(manifest.get("embedding_dimensions", manifest.get("dimensions", 0)) or 0)
    schema_version = int(manifest.get("synesis_catalog_schema_version", manifest.get("schema_version", 0)) or 0)

    if model != DEFAULT_PACK_MODEL:
        raise SynPackError(f"unsupported embedding_model {model!r}; expected {DEFAULT_PACK_MODEL!r}")
    if dims != EMBEDDING_DIM:
        raise SynPackError(f"embedding dimension mismatch: pack={dims}, catalog={EMBEDDING_DIM}")
    if schema_version and schema_version > SCHEMA_VERSION:
        raise SynPackError(f"pack requires schema v{schema_version}, runtime is v{SCHEMA_VERSION}")

    manifest["pack_id"] = pack_id
    manifest["embedding_model"] = model
    manifest["embedding_dimensions"] = dims
    manifest["embedding_profile"] = str(manifest.get("embedding_profile") or EMBEDDING_PROFILE)
    manifest["corpus_version"] = str(manifest.get("corpus_version") or CORPUS_VERSION)
    return manifest


def validate_synpack(pack_path: str | Path) -> dict[str, Any]:
    path = Path(pack_path)
    if not path.exists():
        raise SynPackError(f"SynPack not found: {path}")
    if not zipfile.is_zipfile(path):
        raise SynPackError(f"SynPack is not a zip file: {path}")
    manifest = validate_manifest(read_manifest(path))
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
    if "nodes.jsonl" not in names and "metadata.jsonl" not in names and V2_CHUNKS_PATH not in names:
        raise SynPackError("nodes.jsonl, metadata.jsonl, or nodes/chunks.jsonl missing from content pack")
    return manifest


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SynPackError(f"{path.name}:{line_no} invalid JSON: {exc}") from exc
            if not isinstance(obj, dict):
                raise SynPackError(f"{path.name}:{line_no} must be a JSON object")
            yield obj


def _load_vectors_if_present(root: Path) -> list[list[float]] | None:
    vectors_path = root / "vectors.npy"
    if vectors_path.exists():
        try:
            import numpy as np  # type: ignore
        except Exception as exc:
            raise SynPackError("vectors.npy requires numpy to be installed") from exc
        arr = np.load(vectors_path)
        if len(arr.shape) != 2 or int(arr.shape[1]) != EMBEDDING_DIM:
            raise SynPackError(f"vectors.npy must have shape [N,{EMBEDDING_DIM}]")
        return arr.astype("float32").tolist()

    binary_path = root / V2_VECTOR_BINARY_PATH
    index_path = root / V2_VECTOR_INDEX_PATH
    if not binary_path.exists() or not index_path.exists():
        return None
    index = json.loads(index_path.read_text(encoding="utf-8"))
    count = int(index.get("count", 0) or 0)
    dims = int(index.get("dimensions", 0) or 0)
    if dims != EMBEDDING_DIM:
        raise SynPackError(f"vectors/chunks.f32 dimension mismatch: got {dims}, expected {EMBEDDING_DIM}")
    raw = binary_path.read_bytes()
    expected = count * dims * 4
    if len(raw) != expected:
        raise SynPackError(f"vectors/chunks.f32 byte size mismatch: got {len(raw)}, expected {expected}")
    vectors: list[list[float]] = []
    offset = 0
    for _ in range(count):
        end = offset + dims * 4
        vectors.append(list(struct.unpack(f"<{dims}f", raw[offset:end])))
        offset = end
    return vectors


def _write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
            count += 1
    return count


def _parse_agent_enrichment(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("agent_enrichment_json")
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {}
    return {}


def _as_list(value: Any) -> list[Any]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [str(value).strip()] if str(value).strip() else []


def _short_hash(*parts: Any) -> str:
    payload = "|".join(str(part) for part in parts)
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def _node_base(row: dict[str, Any], *, node_id: str, kind: str, name: str = "") -> dict[str, Any]:
    return {
        "id": node_id[:192],
        "kind": kind,
        "name": str(name or node_id)[:256],
        "pack": str(row.get("pack") or row.get("pack_id") or "")[:96],
        "pack_id": str(row.get("pack_id") or row.get("pack") or "")[:96],
        "pack_version": str(row.get("pack_version") or "")[:64],
        "source_version": str(row.get("source_version") or row.get("pack_source_version") or "")[:64],
        "domain": str(row.get("domain") or "")[:64],
        "language": str(row.get("language") or "")[:32],
        "source_url": str(row.get("source_url") or row.get("url") or "")[:512],
        "path": str(row.get("path") or row.get("module_path") or "")[:512],
        "authority": str(row.get("authority") or "")[:32],
        "visibility_scope": str(row.get("visibility_scope") or "global")[:16],
        "acl_mode": str(row.get("acl_mode") or "open")[:16],
    }


def _compact_chunk_row(row: dict[str, Any]) -> dict[str, Any]:
    compact = {key: value for key, value in row.items() if key != "embedding"}
    compact["kind"] = "Chunk"
    return compact


def _add_unique(nodes: dict[str, dict[str, Any]], node: dict[str, Any]) -> None:
    node_id = str(node.get("id") or "")
    if node_id:
        nodes[node_id] = node


def _iter_enrichment_texts(enrichment: dict[str, Any], keys: tuple[str, ...]) -> Iterable[tuple[str, str]]:
    for key in keys:
        for item in _as_list(enrichment.get(key)):
            if isinstance(item, dict):
                text = str(item.get("text") or item.get("title") or item.get("name") or item.get("summary") or "")
            else:
                text = str(item)
            text = text.strip()
            if text:
                yield key, text[:2048]


def materialize_synpack_v2(
    rows: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    manifest: dict[str, Any],
    root: str | Path,
) -> dict[str, Any]:
    """Write a NornicDB-native typed SynPack v2 bundle under ``root``.

    Legacy flat files remain the compatibility contract. These typed files give
    importers a richer, validated graph without forcing them to infer documents,
    symbols, constraints, examples, and unresolved references from chunk rows.
    """

    root_path = Path(root)
    pack_id = str(manifest.get("pack_id") or "")
    documents: dict[str, dict[str, Any]] = {}
    packages: dict[str, dict[str, Any]] = {}
    modules: dict[str, dict[str, Any]] = {}
    symbols: dict[str, dict[str, Any]] = {}
    concepts: dict[str, dict[str, Any]] = {}
    patterns: dict[str, dict[str, Any]] = {}
    constraints: dict[str, dict[str, Any]] = {}
    examples: dict[str, dict[str, Any]] = {}
    external_refs: dict[str, dict[str, Any]] = {}
    enrichment_rows: list[dict[str, Any]] = []
    typed_edges: list[dict[str, Any]] = [dict(edge) for edge in edges]
    node_ids: set[str] = set()
    fallback_enriched = 0
    enriched = 0

    for row in rows:
        chunk_id = str(row.get("id") or row.get("chunk_id") or "")
        if not chunk_id:
            continue
        node_ids.add(chunk_id)
        doc_id = str(row.get("doc_id") or "")
        if doc_id:
            _add_unique(
                documents,
                {
                    **_node_base(row, node_id=doc_id, kind="Document", name=str(row.get("document_name") or doc_id)),
                    "doc_id": doc_id,
                    "document_name": str(row.get("document_name") or "")[:256],
                    "heading_path": str(row.get("heading_path") or "")[:512],
                    "source_type": str(row.get("source_type") or "")[:32],
                },
            )
        path = str(row.get("path") or row.get("module_path") or "")
        package_name = str(row.get("package_name") or "")
        if package_name:
            package_id = f"{pack_id}:package:{package_name}"
            _add_unique(
                packages,
                {
                    **_node_base(row, node_id=package_id, kind="Package", name=package_name),
                    "package_name": package_name[:128],
                },
            )
            typed_edges.append({"type": "CONTAINS", "source_id": package_id, "target_id": chunk_id, "source": "pack"})
        module_path = str(row.get("module_path") or path or "")
        if module_path:
            module_id = f"{pack_id}:module:{module_path}"
            _add_unique(
                modules,
                {
                    **_node_base(row, node_id=module_id, kind="Module", name=module_path),
                    "module_path": module_path[:256],
                    "package_name": package_name[:128],
                },
            )
            typed_edges.append({"type": "CONTAINS", "source_id": module_id, "target_id": chunk_id, "source": "pack"})
        if path:
            file_id = f"{pack_id}:file:{path}"
            _add_unique(
                documents,
                {
                    **_node_base(row, node_id=file_id, kind="Document", name=path),
                    "doc_id": doc_id or file_id,
                    "document_name": str(row.get("document_name") or path)[:256],
                    "source_type": str(row.get("source_type") or "")[:32],
                },
            )
        symbol_fqn = str(row.get("symbol_fqn") or "")
        if symbol_fqn:
            _add_unique(
                symbols,
                {
                    **_node_base(
                        row, node_id=symbol_fqn, kind="Symbol", name=str(row.get("symbol_name") or symbol_fqn)
                    ),
                    "symbol_fqn": symbol_fqn[:256],
                    "symbol_name": str(row.get("symbol_name") or "")[:128],
                    "symbol_kind": str(row.get("symbol_kind") or row.get("symbol_type") or "")[:64],
                    "package_name": package_name[:128],
                },
            )
        enrichment = _parse_agent_enrichment(row)
        if enrichment.get("enrichment_status") == "fallback":
            fallback_enriched += 1
        elif enrichment:
            enriched += 1
        enrichment_rows.append(
            {
                "chunk_id": chunk_id,
                "doc_id": doc_id,
                "symbol_fqn": symbol_fqn,
                "prompt_id": enrichment.get("prompt_id") or row.get("enrichment_profile") or "",
                "enrichment": enrichment,
            }
        )
        for key, text in _iter_enrichment_texts(
            enrichment, ("task_intents", "query_aliases", "agent_query_hints", "related_interfaces")
        ):
            node_id = f"{pack_id}:concept:{_short_hash(key, text)}"
            _add_unique(
                concepts,
                {
                    **_node_base(row, node_id=node_id, kind="Concept", name=text[:128]),
                    "concept_type": key,
                    "text": text,
                },
            )
            typed_edges.append(
                {"type": "RELATED_TO", "source_id": chunk_id, "target_id": node_id, "source": "enrichment"}
            )
        for key, text in _iter_enrichment_texts(enrichment, ("anti_patterns", "hidden_warnings")):
            node_id = f"{pack_id}:pattern:{_short_hash(key, text)}"
            _add_unique(
                patterns,
                {
                    **_node_base(row, node_id=node_id, kind="Pattern", name=text[:128]),
                    "pattern_type": key,
                    "text": text,
                },
            )
            typed_edges.append(
                {"type": "HAS_PATTERN", "source_id": chunk_id, "target_id": node_id, "source": "enrichment"}
            )
        for key, text in _iter_enrichment_texts(
            enrichment, ("safety_contract", "api_contract", "verification_hints", "version_scope")
        ):
            node_id = f"{pack_id}:constraint:{_short_hash(key, text)}"
            _add_unique(
                constraints,
                {
                    **_node_base(row, node_id=node_id, kind="Constraint", name=text[:128]),
                    "constraint_type": key,
                    "text": text,
                },
            )
            typed_edges.append(
                {"type": "HAS_CONSTRAINT", "source_id": chunk_id, "target_id": node_id, "source": "enrichment"}
            )
        for key, text in _iter_enrichment_texts(enrichment, ("canonical_examples", "examples")):
            node_id = f"{pack_id}:example:{_short_hash(key, text)}"
            _add_unique(
                examples,
                {
                    **_node_base(row, node_id=node_id, kind="Example", name=text[:128]),
                    "example_type": key,
                    "text": text,
                },
            )
            typed_edges.append(
                {"type": "HAS_EXAMPLE", "source_id": chunk_id, "target_id": node_id, "source": "enrichment"}
            )

    node_ids.update(documents)
    node_ids.update(packages)
    node_ids.update(modules)
    node_ids.update(symbols)
    node_ids.update(concepts)
    node_ids.update(patterns)
    node_ids.update(constraints)
    node_ids.update(examples)

    missing_before_external_refs = 0
    unresolved_edges = 0
    for edge in typed_edges:
        source_id = str(edge.get("source_id") or edge.get("from") or "")
        target_id = str(edge.get("target_id") or edge.get("to") or "")
        if "unresolved" in str(edge.get("resolution_confidence") or "").lower():
            unresolved_edges += 1
        for ref_id, ref_role in ((source_id, "source"), (target_id, "target")):
            if not ref_id or ref_id in node_ids or ref_id in external_refs:
                continue
            missing_before_external_refs += 1
            ref_kind = (
                "call" if ref_id.startswith("call:") else "import" if ref_id.startswith("import:") else "external"
            )
            external_refs[ref_id] = {
                "id": ref_id[:192],
                "kind": "ExternalRef",
                "name": ref_id[:256],
                "external_ref_kind": ref_kind,
                "reference_role": ref_role,
                "pack": pack_id,
                "pack_id": pack_id,
                "pack_version": str(manifest.get("pack_version") or "")[:64],
                "domain": str(manifest.get("domain") or "")[:64],
                "language": str(manifest.get("language") or "")[:32],
                "resolution_confidence": "unresolved",
            }
    node_ids.update(external_refs)

    dangling_after_external_refs = 0
    for edge in typed_edges:
        source_id = str(edge.get("source_id") or edge.get("from") or "")
        target_id = str(edge.get("target_id") or edge.get("to") or "")
        if source_id and source_id not in node_ids:
            dangling_after_external_refs += 1
        if target_id and target_id not in node_ids:
            dangling_after_external_refs += 1

    chunk_rows = [_compact_chunk_row(row) for row in rows]
    _write_jsonl(root_path / V2_CHUNKS_PATH, chunk_rows)
    _write_jsonl(root_path / V2_DOCUMENTS_PATH, documents.values())
    _write_jsonl(root_path / V2_PACKAGES_PATH, packages.values())
    _write_jsonl(root_path / V2_MODULES_PATH, modules.values())
    _write_jsonl(root_path / V2_SYMBOLS_PATH, symbols.values())
    _write_jsonl(root_path / V2_CONCEPTS_PATH, concepts.values())
    _write_jsonl(root_path / V2_PATTERNS_PATH, patterns.values())
    _write_jsonl(root_path / V2_CONSTRAINTS_PATH, constraints.values())
    _write_jsonl(root_path / V2_EXAMPLES_PATH, examples.values())
    _write_jsonl(root_path / V2_EXTERNAL_REFS_PATH, external_refs.values())
    _write_jsonl(root_path / V2_ENRICHMENT_PATH, enrichment_rows)

    edge_counts = Counter(str(edge.get("type") or "").upper() for edge in typed_edges)
    edges_root = root_path / "edges"
    grouped: dict[str, list[dict[str, Any]]] = {}
    for edge in typed_edges:
        edge_type = str(edge.get("type") or "related").lower()
        grouped.setdefault(edge_type, []).append(edge)
    for edge_type, group in grouped.items():
        _write_jsonl(edges_root / f"{edge_type}.jsonl", group)

    vector_index_rows: list[dict[str, Any]] = []
    vector_path = root_path / V2_VECTOR_BINARY_PATH
    vector_path.parent.mkdir(parents=True, exist_ok=True)
    with vector_path.open("wb") as f:
        for idx, row in enumerate(rows):
            vec = row.get("embedding")
            if not isinstance(vec, list):
                raise SynPackError(f"row {idx} missing embedding for v2 vector sidecar")
            if len(vec) != EMBEDDING_DIM:
                raise SynPackError(f"row {idx} embedding dimension mismatch: got {len(vec)}, expected {EMBEDDING_DIM}")
            f.write(struct.pack(f"<{EMBEDDING_DIM}f", *(float(x) for x in vec)))
            vector_index_rows.append({"chunk_id": str(row.get("id") or row.get("chunk_id") or ""), "offset": idx})
    vector_index = {
        "format": "synpack-v2-vectors",
        "dtype": "float32",
        "byte_order": "little",
        "dimensions": EMBEDDING_DIM,
        "count": len(vector_index_rows),
        "embedding_model": DEFAULT_PACK_MODEL,
        "embedding_profile": EMBEDDING_PROFILE,
        "rows": vector_index_rows,
    }
    (root_path / V2_VECTOR_INDEX_PATH).write_text(json.dumps(vector_index, indent=2, sort_keys=True), encoding="utf-8")

    node_counts = {
        "Chunk": len(rows),
        "Document": len(documents),
        "Package": len(packages),
        "Module": len(modules),
        "Symbol": len(symbols),
        "Concept": len(concepts),
        "Pattern": len(patterns),
        "Constraint": len(constraints),
        "Example": len(examples),
        "ExternalRef": len(external_refs),
    }
    total_nodes = sum(node_counts.values())
    enrichment_coverage = enriched / len(rows) if rows else 1.0
    graph_resolution = 1.0 - (unresolved_edges / len(typed_edges)) if typed_edges else 1.0
    quality_report = {
        "format": "synpack-v2-quality",
        "pack_id": pack_id,
        "node_counts_by_kind": node_counts,
        "edge_counts_by_type": dict(sorted(edge_counts.items())),
        "node_count": total_nodes,
        "chunk_count": len(rows),
        "edge_count": len(typed_edges),
        "fallback_enriched": fallback_enriched,
        "enriched": enriched,
        "enrichment_coverage_score": round(enrichment_coverage, 4),
        "graph_resolution_score": round(max(0.0, graph_resolution), 4),
        "dangling_edge_count_before_external_refs": missing_before_external_refs,
        "dangling_edge_count": dangling_after_external_refs,
        "external_ref_count": len(external_refs),
        "unresolved_edge_count": unresolved_edges,
    }
    quality_path = root_path / V2_QUALITY_PATH
    quality_path.parent.mkdir(parents=True, exist_ok=True)
    quality_path.write_text(json.dumps(quality_report, indent=2, sort_keys=True), encoding="utf-8")
    return quality_report


def _row_to_entity(row: dict[str, Any], manifest: dict[str, Any], embedding: list[float] | None) -> dict[str, Any]:
    if "embedding" in row and isinstance(row["embedding"], list):
        embedding = [float(x) for x in row["embedding"]]
    if embedding is None:
        raise SynPackError("row is missing embedding and no vectors.npy entry is available")
    if len(embedding) != EMBEDDING_DIM:
        raise SynPackError(f"row embedding dimension mismatch: got {len(embedding)}, expected {EMBEDDING_DIM}")

    if "chunk_id" in row and "text" in row:
        # Complete or near-complete catalog entity. Rebuild through catalog_entity
        # so new fields/defaults and truncation rules stay consistent.
        base = dict(row)
    else:
        base = row

    pack_id = str(base.get("pack_id") or manifest["pack_id"])
    text = str(base.get("text") or base.get("content") or "")
    if not text:
        raise SynPackError("row text/content is required")
    source_url = str(base.get("source_url") or "")
    chunk_id = str(base.get("chunk_id") or chunk_id_hash(text, f"{pack_id}:{source_url}"))

    return catalog_entity(
        chunk_id=chunk_id,
        text=text,
        embedding=embedding,
        doc_id=str(base.get("doc_id") or source_url or pack_id),
        chunk_index=int(base.get("chunk_index", 0) or 0),
        context_prefix=str(base.get("context_prefix", "") or ""),
        chunk_summary=str(base.get("chunk_summary", "") or ""),
        heading_path=str(base.get("heading_path", "") or ""),
        section=str(base.get("section", "") or ""),
        document_name=str(base.get("document_name", "") or manifest.get("name", pack_id)),
        source_type=str(base.get("source_type", "") or "docs"),
        handler=str(base.get("handler", "") or "synpack"),
        domain=str(base.get("domain", "") or manifest.get("domain", "")),
        tags=str(
            base.get("tags", "") or ",".join(manifest.get("tags", []) if isinstance(manifest.get("tags"), list) else [])
        ),
        keywords=str(base.get("keywords", "") or ""),
        origin_type=str(base.get("origin_type", "") or "curated"),
        authority=str(base.get("authority", "") or "vetted"),
        pack_id=pack_id,
        pack_version=str(base.get("pack_version", "") or manifest.get("pack_version", manifest.get("version", ""))),
        pack_source_version=str(base.get("pack_source_version", "") or manifest.get("source_version", "")),
        pack_artifact_hash=str(base.get("pack_artifact_hash", "") or manifest.get("artifact_hash", "")),
        pack_partition=str(base.get("pack_partition", "") or pack_id),
        symbol_kind=str(base.get("symbol_kind", "") or ""),
        symbol_fqn=str(base.get("symbol_fqn", "") or ""),
        package_name=str(base.get("package_name", "") or ""),
        doc_relation_ids=(
            ",".join(str(x) for x in base.get("doc_relation_ids", []) if str(x).strip())
            if isinstance(base.get("doc_relation_ids"), list)
            else str(base.get("doc_relation_ids", "") or "")
        ),
        source_url=source_url,
        agent_hook=str(base.get("agent_hook", "") or ""),
        perf_tier=str(base.get("perf_tier", "") or ""),
        safety_contract=str(base.get("safety_contract", "") or ""),
        lifecycle_model=str(base.get("lifecycle_model", "") or ""),
        agent_enrichment_json=(
            json.dumps(base.get("agent_enrichment_json", {}), sort_keys=True)
            if isinstance(base.get("agent_enrichment_json"), dict)
            else str(base.get("agent_enrichment_json", "") or "")
        ),
        scan_status=str(base.get("scan_status", "clean") or "clean"),
        scan_signals=str(base.get("scan_signals", "") or ""),
        content_format=str(base.get("content_format", "") or ""),
        symbol_type=str(base.get("symbol_type", "") or base.get("symbol_kind", "") or ""),
        approval_status=str(base.get("approval_status", "auto_approved") or "auto_approved"),
        language=str(base.get("language", "") or manifest.get("language", "")),
        repo_path=str(base.get("repo_path", "") or ""),
        module_path=str(base.get("module_path", "") or ""),
        symbol_name=str(base.get("symbol_name", "") or ""),
        artifact_kind=str(base.get("artifact_kind", "") or "docs"),
        has_code=bool(base.get("has_code", False)),
        code_signal_count=int(base.get("code_signal_count", 0) or 0),
        code_density=float(base.get("code_density", 0.0) or 0.0),
        code_language=str(base.get("code_language", "") or ""),
        visibility_scope=str(base.get("visibility_scope", "global") or "global"),
        org_id=str(base.get("org_id", "") or ""),
        tenant_id=str(base.get("tenant_id", "") or ""),
        acl_mode=str(base.get("acl_mode", "open") or "open"),
        acl_groups=str(base.get("acl_groups", "") or ""),
        corpus_class=str(base.get("corpus_class", "") or "coder_enriched"),
        constraint_kind=str(base.get("constraint_kind", "") or ""),
        content_profile=str(base.get("content_profile", "") or "reference"),
        scope_tags=str(base.get("scope_tags", "") or ""),
        constraint_source=str(base.get("constraint_source", "") or ""),
        constraint_confidence=float(base.get("constraint_confidence", -1.0) or -1.0),
        crawl_timestamp=int(base.get("crawl_timestamp", 0) or int(time.time() * 1000)),
        raw_content_hash=str(base.get("raw_content_hash", "") or hashlib.sha256(text.encode()).hexdigest()),
        clean_content_hash=str(base.get("clean_content_hash", "") or hashlib.sha256(text.encode()).hexdigest()),
        enrichment_profile=str(base.get("enrichment_profile", "") or "synpack_v1"),
    )


def load_synpack(pack_path: str | Path, *, nornic_uri: str = NORNIC_URI, replace: bool = False) -> dict[str, Any]:
    nornic_uri = nornic_uri or NORNIC_URI
    manifest = validate_synpack(pack_path)
    pack_id = manifest["pack_id"]
    tmp = Path(tempfile.mkdtemp(prefix="synpack-load-"))
    try:
        with zipfile.ZipFile(pack_path) as zf:
            zf.extractall(tmp)
        vectors = _load_vectors_if_present(tmp)
        rows_file = tmp / "nodes.jsonl"
        if not rows_file.exists():
            rows_file = tmp / "metadata.jsonl"
        if not rows_file.exists():
            rows_file = tmp / V2_CHUNKS_PATH
        rows = list(_iter_jsonl(rows_file))
        if vectors is not None and len(vectors) != len(rows):
            raise SynPackError(f"vectors.npy row count {len(vectors)} does not match metadata rows {len(rows)}")

        writer = NornicGraphWriter(uri=nornic_uri)
        ensure_synesis_catalog(writer.client)
        if replace:
            writer.delete_pack(pack_id)

        artifact_hash = _sha256_file(Path(pack_path))
        manifest["artifact_hash"] = artifact_hash
        logger.info("synpack_nodes_parse_start", extra={"pack_id": pack_id, "rows": len(rows)})
        raw_entities = [
            _row_to_entity(row, manifest, vectors[i] if vectors is not None else None) for i, row in enumerate(rows)
        ]
        entities_by_id: dict[str, dict[str, Any]] = {}
        duplicate_nodes = 0
        for entity in raw_entities:
            entity_id = str(entity["id"])
            if entity_id in entities_by_id:
                duplicate_nodes += 1
            entities_by_id[entity_id] = entity
        entities = list(entities_by_id.values())
        logger.info(
            "synpack_nodes_parse_complete",
            extra={"pack_id": pack_id, "nodes": len(entities), "duplicate_nodes": duplicate_nodes},
        )
        partial_nodes_deleted = 0
        if DELETE_PARTIAL_IDS:
            partial_nodes_deleted = writer.delete_partial_ids([str(entity["id"]) for entity in entities])
        count = writer.upsert_batch(entities)
        logger.info(
            "synpack_nodes_loaded",
            extra={
                "pack_id": pack_id,
                "nodes": count,
                "duplicate_nodes": duplicate_nodes,
                "partial_nodes_deleted": partial_nodes_deleted,
            },
        )
        edge_count = 0
        edges_path = tmp / "edges.jsonl"
        if edges_path.exists():
            edges = list(_iter_jsonl(edges_path))
            logger.info("synpack_edges_load_start", extra={"pack_id": pack_id, "edges": len(edges)})
            edge_count = writer.upsert_edges(edges)
            logger.info("synpack_edges_loaded", extra={"pack_id": pack_id, "edges": edge_count})
        return {
            "ok": True,
            "pack_id": pack_id,
            "nodes": count,
            "duplicate_nodes": duplicate_nodes,
            "partial_nodes_deleted": partial_nodes_deleted,
            "edges": edge_count,
            "artifact_hash": artifact_hash,
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def list_packs(*, nornic_uri: str = NORNIC_URI, limit: int = 16384) -> list[dict[str, Any]]:
    writer = NornicGraphWriter(uri=nornic_uri or NORNIC_URI)
    with writer.driver.session(database=writer.database) as session:
        rows = session.run(
            """
            MATCH (n:ContentNode)
            WHERE coalesce(n.pack, "") <> ""
            RETURN n.pack AS pack_id,
                   max(n.pack_version) AS pack_version,
                   max(n.source_version) AS pack_source_version,
                   max(n.language) AS language,
                   max(n.domain) AS domain,
                   max(n.pack_artifact_hash) AS pack_artifact_hash,
                   count(n) AS node_count
            ORDER BY pack_id
            LIMIT $limit
            """,
            limit=limit,
        )
        return [dict(row) for row in rows]


def search_pack(
    query: str,
    *,
    pack_id: str,
    top_k: int = 5,
    nornic_uri: str = NORNIC_URI,
    embedder_url: str = "",
) -> list[dict[str, Any]]:
    del embedder_url
    writer = NornicGraphWriter(uri=nornic_uri or NORNIC_URI)
    with writer.driver.session(database=writer.database) as session:
        rows = session.run(
            """
            CALL db.index.vector.queryNodes('embeddings', $limit, $query)
            YIELD node, score
            WHERE node.pack = $pack_id
            RETURN node, score
            ORDER BY score DESC
            LIMIT $limit
            """,
            query=query,
            pack_id=_sanitize_pack_id(pack_id),
            limit=max(1, min(top_k, 50)),
        )
        out = []
        for row in rows:
            item = dict(row["node"])
            item["score"] = row["score"]
            out.append(item)
        return out


def _load_bootstrap_items(sources_path: Path) -> list[dict[str, Any]]:
    with sources_path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    items = data.get("items") or data.get("sources") or []
    if not isinstance(items, list):
        raise SynPackError(f"{sources_path} must contain items or sources list")
    return [x for x in items if isinstance(x, dict)]


def build_pack_from_sources(
    sources_path: str | Path,
    output_path: str | Path,
    *,
    pack_id: str,
    pack_version: str = "1.0.0",
    source_version: str = "",
    language: str = "",
    domain: str = "",
    enrich_full: bool = False,
    llm_url: str = "",
    embedder_url: str = "",
    max_chunks: int = 0,
) -> dict[str, Any]:
    pack_id = _sanitize_pack_id(pack_id)
    source_path = Path(sources_path)
    out_path = Path(output_path)
    tmp = Path(tempfile.mkdtemp(prefix="synpack-build-"))
    rows_path = tmp / "nodes.jsonl"
    edges_path = tmp / "edges.jsonl"
    sources_lock: list[dict[str, Any]] = []
    total_rows = 0
    rows: list[dict[str, Any]] = []
    embedder = EmbedClient(**({"url": embedder_url} if embedder_url else {}))
    items = _load_bootstrap_items(source_path)

    with rows_path.open("w", encoding="utf-8") as rows_f, edges_path.open("w", encoding="utf-8") as edges_f:
        for item in items:
            source_config = _build_source_config(item)
            source_config.update(
                {
                    "pack_id": pack_id,
                    "pack_version": pack_version,
                    "pack_source_version": source_version,
                    "pack_partition": pack_id,
                }
            )
            if language and not source_config.get("language"):
                source_config["language"] = language
            if domain and not source_config.get("domain"):
                source_config["domain"] = domain

            handler = get_handler(source_config["handler"])
            docs = handler.fetch(source_config)
            sources_lock.append(
                {
                    "name": source_config.get("name", ""),
                    "handler": source_config.get("handler", ""),
                    "uri": item.get("uri", ""),
                    "documents": len(docs),
                }
            )
            parsed: list[tuple[RawDocument, Chunk]] = []
            for doc in docs:
                for chunk in handler.parse_and_chunk(doc):
                    parsed.append((doc, chunk))
                    if max_chunks and len(parsed) >= max_chunks:
                        break
                if max_chunks and len(parsed) >= max_chunks:
                    break

            enrich_items = [(chunk.text, doc.name, chunk.heading_path, chunk.section) for doc, chunk in parsed]
            enrichments = enrich_chunks_bulk(enrich_items, enrich_full=enrich_full, llm_url=llm_url)
            embed_inputs = [
                f"{e.context_prefix} {chunk.text}" if e.context_prefix else chunk.text
                for (_doc, chunk), e in zip(parsed, enrichments)
            ]
            embeddings = embedder.embed_texts(embed_inputs) if embed_inputs else []

            for (doc, chunk), enrichment, embedding in zip(parsed, enrichments, embeddings):
                chunk_id = chunk_id_hash(chunk.text, f"{pack_id}:{doc.doc_id}:{chunk.section}")
                status, signals = scan_chunk_text_detailed(chunk.text)
                language_out = (
                    chunk.metadata.get("language", "")
                    or doc.metadata.get("language", "")
                    or source_config.get("language", "")
                    or language
                )
                content_format = str(chunk.metadata.get("content_format", "") or "")
                artifact_kind = str(source_config.get("artifact_kind", "") or "") or _infer_artifact_kind(
                    source_config.get("handler", ""), content_format, str(language_out)
                )
                has_code, code_signal_count, code_density = _code_chunk_metrics(chunk.text)
                row = catalog_entity(
                    chunk_id=chunk_id,
                    text=chunk.text,
                    embedding=embedding,
                    doc_id=doc.doc_id,
                    chunk_index=chunk.chunk_index,
                    context_prefix=enrichment.context_prefix,
                    chunk_summary=enrichment.chunk_summary,
                    heading_path=chunk.heading_path,
                    section=chunk.section,
                    document_name=doc.name,
                    source_type=str(getattr(handler, "source_type", "docs")),
                    handler=source_config.get("handler", "synpack"),
                    domain=str(source_config.get("domain", domain or "")),
                    tags=",".join(str(t) for t in source_config.get("config", {}).get("tags", []) if str(t).strip()),
                    keywords=enrichment.keywords,
                    origin_type=str(source_config.get("origin_type", "curated")),
                    authority=str(source_config.get("authority", "vetted")),
                    pack_id=pack_id,
                    pack_version=pack_version,
                    pack_source_version=source_version,
                    pack_partition=pack_id,
                    symbol_kind=str(
                        chunk.metadata.get("symbol_kind", "") or chunk.metadata.get("symbol_type", "") or ""
                    ),
                    symbol_fqn=str(chunk.metadata.get("symbol_fqn", "") or ""),
                    package_name=str(
                        chunk.metadata.get("package_name", "") or doc.metadata.get("package_name", "") or ""
                    ),
                    import_refs=str(chunk.metadata.get("import_refs", "") or doc.metadata.get("import_refs", "")),
                    call_refs=str(chunk.metadata.get("call_refs", "") or doc.metadata.get("call_refs", "")),
                    source_url=chunk.metadata.get("source_url") or doc.source_url,
                    scan_status=status,
                    scan_signals=",".join(signals),
                    content_format=content_format,
                    symbol_type=str(chunk.metadata.get("symbol_type", "") or ""),
                    language=str(language_out or ""),
                    module_path=str(chunk.metadata.get("file_path", "") or doc.metadata.get("module_path", "")),
                    symbol_name=str(chunk.metadata.get("symbol_name", "") or ""),
                    artifact_kind=artifact_kind,
                    has_code=has_code,
                    code_signal_count=code_signal_count,
                    code_density=code_density,
                    code_language=str(language_out or content_format or "") if has_code else "",
                    corpus_class=str(source_config.get("corpus_class", "") or "coder_enriched"),
                    content_profile=str(source_config.get("content_profile", "") or "reference"),
                    crawl_timestamp=int(time.time() * 1000),
                    enrichment_profile="synpack_build_v1",
                )
                rows.append(row)
                rows_f.write(json.dumps(row, ensure_ascii=False) + "\n")
                total_rows += 1

            if max_chunks and total_rows >= max_chunks:
                break
        edges = derive_graph_edges(rows, include_structural_edges=True)
        for edge in edges:
            edges_f.write(json.dumps(edge, ensure_ascii=False, sort_keys=True) + "\n")

    manifest = {
        "format": "synesis-content-pack",
        "format_version": SYNPACK_FORMAT_VERSION,
        "pack_id": pack_id,
        "pack_version": pack_version,
        "version": pack_version,
        "source_version": source_version,
        "language": language,
        "domain": domain or language,
        "embedding_model": DEFAULT_PACK_MODEL,
        "embedding_dimensions": EMBEDDING_DIM,
        "embedding_profile": EMBEDDING_PROFILE,
        "corpus_version": CORPUS_VERSION,
        "content_graph_schema_version": SCHEMA_VERSION,
        "schema_version": SCHEMA_VERSION,
        "partitions": [pack_id],
        "metadata_fields": [
            "package_name",
            "symbol_kind",
            "symbol_fqn",
            "scope_tags",
            "content_profile",
            "constraint_kind",
            "import_refs",
            "call_refs",
        ],
        "created_at": int(time.time()),
        "row_count": total_rows,
        "node_count": total_rows,
        "edge_count": len(edges),
        "requires_bulk_import": total_rows >= 1000,
        "install_profile": "nornicdb-v2-typed-graph",
        "sources_lock_sha256": "",
        "nodes_sha256": _sha256_file(rows_path),
        "edges_sha256": _sha256_file(edges_path),
    }
    sources_lock_path = tmp / "sources.lock.json"
    sources_lock_path.write_text(json.dumps(sources_lock, indent=2), encoding="utf-8")
    manifest["sources_lock_sha256"] = _sha256_file(sources_lock_path)
    quality_report = materialize_synpack_v2(rows, edges, manifest, tmp)
    manifest.update(
        {
            "node_count": quality_report["node_count"],
            "chunk_count": quality_report["chunk_count"],
            "edge_count": quality_report["edge_count"],
            "node_counts_by_kind": quality_report["node_counts_by_kind"],
            "edge_counts_by_type": quality_report["edge_counts_by_type"],
            "dangling_edge_count": quality_report["dangling_edge_count"],
            "external_ref_count": quality_report["external_ref_count"],
            "quality_report_sha256": _sha256_file(tmp / "quality" / "report.json"),
        }
    )
    (tmp / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in ("manifest.json", "nodes.jsonl", "edges.jsonl", "sources.lock.json"):
            zf.write(tmp / name, name)
        for dirname in ("nodes", "edges", "vectors", "enrichment", "quality"):
            directory = tmp / dirname
            for path in sorted(directory.rglob("*")):
                if path.is_file():
                    zf.write(path, str(path.relative_to(tmp)))

    artifact_hash = _sha256_file(out_path)
    shutil.rmtree(tmp, ignore_errors=True)
    return {"ok": True, "pack_id": pack_id, "rows": total_rows, "path": str(out_path), "artifact_hash": artifact_hash}
