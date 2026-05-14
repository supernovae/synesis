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
import shutil
import tempfile
import time
import zipfile
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
    if "nodes.jsonl" not in names and "metadata.jsonl" not in names:
        raise SynPackError("nodes.jsonl missing from content pack")
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
    if not vectors_path.exists():
        return None
    try:
        import numpy as np  # type: ignore
    except Exception as exc:
        raise SynPackError("vectors.npy requires numpy to be installed") from exc
    arr = np.load(vectors_path)
    if len(arr.shape) != 2 or int(arr.shape[1]) != EMBEDDING_DIM:
        raise SynPackError(f"vectors.npy must have shape [N,{EMBEDDING_DIM}]")
    return arr.astype("float32").tolist()


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
        rows = list(_iter_jsonl(rows_file))
        if vectors is not None and len(vectors) != len(rows):
            raise SynPackError(f"vectors.npy row count {len(vectors)} does not match metadata rows {len(rows)}")

        writer = NornicGraphWriter(uri=nornic_uri)
        ensure_synesis_catalog(writer.client)
        if replace:
            writer.delete_pack(pack_id)

        artifact_hash = _sha256_file(Path(pack_path))
        manifest["artifact_hash"] = artifact_hash
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
        count = writer.upsert_batch(entities)
        edge_count = 0
        edges_path = tmp / "edges.jsonl"
        if edges_path.exists():
            edge_count = writer.upsert_edges(list(_iter_jsonl(edges_path)))
        return {
            "ok": True,
            "pack_id": pack_id,
            "nodes": count,
            "duplicate_nodes": duplicate_nodes,
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
        for edge in derive_graph_edges(rows, include_structural_edges=True):
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
        "sources_lock_sha256": "",
        "nodes_sha256": _sha256_file(rows_path),
        "edges_sha256": _sha256_file(edges_path),
    }
    sources_lock_path = tmp / "sources.lock.json"
    sources_lock_path.write_text(json.dumps(sources_lock, indent=2), encoding="utf-8")
    manifest["sources_lock_sha256"] = _sha256_file(sources_lock_path)
    (tmp / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(tmp / "manifest.json", "manifest.json")
        zf.write(rows_path, "nodes.jsonl")
        zf.write(edges_path, "edges.jsonl")
        zf.write(sources_lock_path, "sources.lock.json")

    artifact_hash = _sha256_file(out_path)
    shutil.rmtree(tmp, ignore_errors=True)
    return {"ok": True, "pack_id": pack_id, "rows": total_rows, "path": str(out_path), "artifact_hash": artifact_hash}
