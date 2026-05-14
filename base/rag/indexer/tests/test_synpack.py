from __future__ import annotations

import json
import struct
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "base" / "images" / "base-api" / "synesis-telemetry"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import content_pack_runner, nornic_bulk_importer, synpack
from app.schema import CORPUS_VERSION, EMBEDDING_DIM
from app.synpack import SynPackError, load_synpack, validate_synpack


def _write_pack(path: Path, manifest: dict, row: dict | None = None) -> None:
    row = row or {
        "text": "Package fmt implements formatted I/O.",
        "source_url": "https://pkg.go.dev/fmt",
        "embedding": [0.0] * EMBEDDING_DIM,
    }
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("metadata.jsonl", json.dumps(row) + "\n")


def test_validate_synpack_accepts_bge_m3_manifest(tmp_path: Path):
    pack = tmp_path / "go.synpack"
    _write_pack(
        pack,
        {
            "pack_id": "Go 1.26",
            "pack_version": "1.0.0",
            "embedding_model": "BAAI/bge-m3",
            "embedding_dimensions": EMBEDDING_DIM,
            "synesis_catalog_schema_version": 17,
        },
    )

    manifest = validate_synpack(pack)

    assert manifest["pack_id"] == "go-1-26"
    assert manifest["embedding_model"] == "BAAI/bge-m3"
    assert manifest["embedding_profile"] == "bge-m3-1024-cosine-v1"
    assert manifest["corpus_version"] == CORPUS_VERSION


def test_validate_synpack_rejects_dimension_mismatch(tmp_path: Path):
    pack = tmp_path / "bad.synpack"
    _write_pack(
        pack,
        {
            "pack_id": "go-1.26",
            "embedding_model": "BAAI/bge-m3",
            "embedding_dimensions": 384,
            "synesis_catalog_schema_version": 17,
        },
    )

    with pytest.raises(SynPackError, match="dimension mismatch"):
        validate_synpack(pack)


def test_load_synpack_dedupes_duplicate_node_ids(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(synpack, "DELETE_PARTIAL_IDS", True)
    pack = tmp_path / "dupes.synpack"
    row = {
        "id": "same-node",
        "chunk_id": "same-node",
        "text": "Package fmt implements formatted I/O.",
        "source_url": "https://pkg.go.dev/fmt",
        "embedding": [0.0] * EMBEDDING_DIM,
    }
    with zipfile.ZipFile(pack, "w") as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "pack_id": "go-latest",
                    "pack_version": "1.0.0",
                    "embedding_model": "BAAI/bge-m3",
                    "embedding_dimensions": EMBEDDING_DIM,
                    "synesis_catalog_schema_version": 17,
                }
            ),
        )
        zf.writestr("metadata.jsonl", json.dumps(row) + "\n" + json.dumps({**row, "text": "duplicate"}) + "\n")

    written: list[dict] = []

    class FakeWriter:
        client = object()

        def __init__(self, uri: str = ""):
            self.uri = uri

        def delete_pack(self, pack_id: str) -> int:
            return 0

        def upsert_batch(self, entities: list[dict], collection_name: str = "") -> int:
            del collection_name
            written.extend(entities)
            return len(entities)

        def delete_partial_ids(self, ids: list[str]) -> int:
            assert ids == ["same-node"]
            return 1

        def upsert_edges(self, edges: list[dict]) -> int:
            return len(edges)

    monkeypatch.setattr(synpack, "NornicGraphWriter", FakeWriter)
    monkeypatch.setattr(synpack, "ensure_synesis_catalog", lambda client: client)

    result = load_synpack(pack)

    assert result["nodes"] == 1
    assert result["duplicate_nodes"] == 1
    assert result["partial_nodes_deleted"] == 1
    assert [entity["id"] for entity in written] == ["same-node"]


def test_load_synpack_accepts_v2_typed_chunks_and_vector_sidecar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pack = tmp_path / "v2.synpack"
    row = {
        "id": "chunk-1",
        "chunk_id": "chunk-1",
        "text": "Package fmt implements formatted I/O.",
        "source_url": "https://pkg.go.dev/fmt",
        "doc_id": "doc-1",
        "pack_id": "go-latest",
    }
    vector = [0.0] * EMBEDDING_DIM
    with zipfile.ZipFile(pack, "w") as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "pack_id": "go-latest",
                    "pack_version": "1.0.0",
                    "embedding_model": "BAAI/bge-m3",
                    "embedding_dimensions": EMBEDDING_DIM,
                    "synesis_catalog_schema_version": 17,
                }
            ),
        )
        zf.writestr("nodes/chunks.jsonl", json.dumps(row) + "\n")
        zf.writestr(
            "vectors/index.json",
            json.dumps(
                {
                    "format": "synpack-v2-vectors",
                    "dtype": "float32",
                    "dimensions": EMBEDDING_DIM,
                    "count": 1,
                    "rows": [{"chunk_id": "chunk-1", "offset": 0}],
                }
            ),
        )
        zf.writestr("vectors/chunks.f32", struct.pack(f"<{EMBEDDING_DIM}f", *vector))

    written: list[dict] = []

    class FakeWriter:
        client = object()

        def __init__(self, uri: str = ""):
            self.uri = uri

        def delete_pack(self, pack_id: str) -> int:
            return 0

        def upsert_batch(self, entities: list[dict], collection_name: str = "") -> int:
            del collection_name
            written.extend(entities)
            return len(entities)

        def delete_partial_ids(self, ids: list[str]) -> int:
            return 0

        def upsert_edges(self, edges: list[dict]) -> int:
            return len(edges)

    monkeypatch.setattr(synpack, "NornicGraphWriter", FakeWriter)
    monkeypatch.setattr(synpack, "ensure_synesis_catalog", lambda client: client)

    manifest = validate_synpack(pack)
    result = load_synpack(pack)

    assert manifest["pack_id"] == "go-latest"
    assert result["nodes"] == 1
    assert written[0]["id"] == "chunk-1"
    assert written[0]["embedding"] == vector


def _write_minimal_v2_pack(path: Path) -> None:
    vector = [0.0] * EMBEDDING_DIM
    chunk = {
        "id": "chunk-1",
        "chunk_id": "chunk-1",
        "kind": "Chunk",
        "text": "Package fmt implements formatted I/O.",
        "source_url": "https://pkg.go.dev/fmt",
        "doc_id": "doc-1",
        "document_name": "fmt",
        "pack_id": "go-latest",
        "domain": "go",
        "language": "go",
    }
    document = {
        "id": "doc-1",
        "kind": "Document",
        "doc_id": "doc-1",
        "document_name": "fmt",
        "pack_id": "go-latest",
    }
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "pack_id": "go-latest",
                    "pack_version": "1.0.0",
                    "embedding_model": "BAAI/bge-m3",
                    "embedding_dimensions": EMBEDDING_DIM,
                    "synesis_catalog_schema_version": 17,
                    "requires_bulk_import": True,
                    "node_count": 2,
                    "edge_count": 1,
                }
            ),
        )
        zf.writestr("nodes/chunks.jsonl", json.dumps(chunk) + "\n")
        zf.writestr("nodes/documents.jsonl", json.dumps(document) + "\n")
        zf.writestr(
            "edges/contains.jsonl",
            json.dumps({"type": "CONTAINS", "source_id": "doc-1", "target_id": "chunk-1"}) + "\n",
        )
        zf.writestr(
            "vectors/index.json",
            json.dumps(
                {
                    "format": "synpack-v2-vectors",
                    "dtype": "float32",
                    "dimensions": EMBEDDING_DIM,
                    "count": 1,
                    "rows": [{"chunk_id": "chunk-1", "offset": 0}],
                }
            ),
        )
        zf.writestr("vectors/chunks.f32", struct.pack(f"<{EMBEDDING_DIM}f", *vector))
        zf.writestr(
            "quality/report.json",
            json.dumps(
                {
                    "node_count": 2,
                    "chunk_count": 1,
                    "edge_count": 1,
                    "dangling_edge_count": 0,
                }
            ),
        )


def test_bulk_load_synpack_imports_v2_typed_graph(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pack = tmp_path / "v2-bulk.synpack"
    _write_minimal_v2_pack(pack)
    written_nodes: list[dict] = []
    written_edges: list[dict] = []

    class FakeWriter:
        def __init__(self, uri: str = ""):
            self.uri = uri
            self.client = self

        def close(self) -> None:
            return None

        def ensure_schema(self) -> None:
            return None

        def delete_pack(self, pack_id: str) -> int:
            assert pack_id == "go-latest"
            return 3

        def bulk_upsert_nodes(
            self, rows: list[dict], *, create_only: bool = False, batch_size: int | None = None
        ) -> int:
            assert create_only is True
            assert batch_size is not None
            written_nodes.extend(rows)
            return len(rows)

        def upsert_edges(self, edges: list[dict]) -> int:
            written_edges.extend(edges)
            return len(edges)

        def pack_counts(self, pack_id: str) -> dict:
            assert pack_id == "go-latest"
            return {
                "node_count": len(written_nodes),
                "chunk_count": sum(1 for node in written_nodes if node.get("kind") == "Chunk"),
                "embedding_count": sum(1 for node in written_nodes if node.get("embedding")),
                "edge_count": len(written_edges),
                "node_counts_by_kind": {"Chunk": 1, "Document": 1},
            }

    monkeypatch.setattr(nornic_bulk_importer, "NornicGraphWriter", FakeWriter)
    monkeypatch.setattr(nornic_bulk_importer, "ensure_synesis_catalog", lambda client: client)

    result = nornic_bulk_importer.bulk_load_synpack(pack, replace=True)

    assert result["backend"] == "bolt-unwind"
    assert result["nodes"] == 2
    assert result["edges"] == 1
    assert result["deleted_existing_nodes"] == 3
    assert {node["kind"] for node in written_nodes} == {"Chunk", "Document"}
    chunk = next(node for node in written_nodes if node["kind"] == "Chunk")
    assert chunk["embedding"] == [0.0] * EMBEDDING_DIM
    assert chunk["domain"] == "go"


def test_content_pack_runner_uses_bulk_backend_for_v2_pack(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pack = tmp_path / "v2-bulk.synpack"
    _write_minimal_v2_pack(pack)
    calls: list[dict] = []
    monkeypatch.setattr(content_pack_runner, "_IMPORT_BACKEND", "auto")
    monkeypatch.setattr(
        content_pack_runner,
        "bulk_load_synpack",
        lambda path, *, nornic_uri, replace: (
            calls.append({"path": path, "nornic_uri": nornic_uri, "replace": replace})
            or {"ok": True, "backend": "bolt-unwind"}
        ),
    )

    result = content_pack_runner._load_content_pack(
        {"replace_existing": True, "result": {"catalog": {"requires_bulk_import": True}}},
        pack,
        nornic_uri="bolt://nornic",
    )

    assert result["backend"] == "bolt-unwind"
    assert calls == [{"path": pack, "nornic_uri": "bolt://nornic", "replace": True}]


def test_content_pack_runner_refuses_large_pack_slow_bolt_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pack = tmp_path / "large.synpack"
    _write_pack(
        pack,
        {
            "pack_id": "go-latest",
            "pack_version": "1.0.0",
            "embedding_model": "BAAI/bge-m3",
            "embedding_dimensions": EMBEDDING_DIM,
            "synesis_catalog_schema_version": 17,
            "requires_bulk_import": True,
            "node_count": 1500,
        },
    )
    monkeypatch.setattr(content_pack_runner, "_ALLOW_SLOW_BOLT_LARGE_PACKS", False)

    with pytest.raises(RuntimeError, match="requires bulk import"):
        content_pack_runner._ensure_not_slow_large_pack({"result": {"catalog": {}}}, pack)


def test_content_pack_runner_allows_explicit_slow_bolt_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pack = tmp_path / "large.synpack"
    _write_pack(
        pack,
        {
            "pack_id": "go-latest",
            "pack_version": "1.0.0",
            "embedding_model": "BAAI/bge-m3",
            "embedding_dimensions": EMBEDDING_DIM,
            "synesis_catalog_schema_version": 17,
            "requires_bulk_import": True,
            "node_count": 1500,
        },
    )
    monkeypatch.setattr(content_pack_runner, "_ALLOW_SLOW_BOLT_LARGE_PACKS", True)

    content_pack_runner._ensure_not_slow_large_pack({"result": {"catalog": {"requires_bulk_import": True}}}, pack)
