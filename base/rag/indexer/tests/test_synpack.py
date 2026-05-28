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
from app.synpack import SynPackError, validate_synpack


def _write_pack(path: Path, manifest: dict, row: dict | None = None) -> None:
    row = row or {
        "text": "Package fmt implements formatted I/O.",
        "source_url": "https://pkg.go.dev/fmt",
        "embedding": [0.0] * EMBEDDING_DIM,
    }
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("nodes/chunks.jsonl", json.dumps(row) + "\n")


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


def test_validate_synpack_rejects_legacy_flat_pack(tmp_path: Path):
    pack = tmp_path / "legacy.synpack"
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
        zf.writestr("metadata.jsonl", json.dumps({"text": "legacy"}) + "\n")

    with pytest.raises(SynPackError, match="SynPack v2"):
        validate_synpack(pack)


def test_search_pack_embeds_query_and_avoids_neo4j_query_kwarg(monkeypatch: pytest.MonkeyPatch):
    calls: list[dict] = []

    class FakeEmbedClient:
        def __init__(self, **kwargs):
            calls.append({"embedder_kwargs": kwargs})

        def embed_texts(self, texts):
            calls.append({"texts": texts})
            return [[0.25] * EMBEDDING_DIM]

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def run(self, cypher, parameters=None, **kwargs):
            assert "query_vector" in parameters
            assert parameters["query_vector"] == [0.25] * EMBEDDING_DIM
            assert parameters["pack_id"] == "go-latest"
            assert parameters["limit"] == 8
            assert parameters["candidate_limit"] == 80
            assert kwargs == {}
            calls.append({"cypher": cypher, "parameters": parameters})
            return [
                {
                    "node": {
                        "id": "chunk-1",
                        "pack": "go-latest",
                        "text": "Use net/http Server.Shutdown with signal.NotifyContext.",
                        "embedding": [0.25] * EMBEDDING_DIM,
                        "entities_json": '{"ignored": true}',
                    },
                    "score": 0.99,
                }
            ]

    class FakeDriver:
        def session(self, *, database):
            assert database
            return FakeSession()

    class FakeWriter:
        database = "neo4j"

        def __init__(self, uri=""):
            self.uri = uri
            self.driver = FakeDriver()

    monkeypatch.setattr(synpack, "EmbedClient", FakeEmbedClient)
    monkeypatch.setattr(synpack, "NornicGraphWriter", FakeWriter)

    results = synpack.search_pack(
        "net/http graceful shutdown",
        pack_id="go-latest",
        top_k=8,
        nornic_uri="bolt://nornic",
        embedder_url="http://embedder",
    )

    assert calls[0]["embedder_kwargs"] == {"url": "http://embedder"}
    assert calls[1]["texts"] == ["net/http graceful shutdown"]
    assert results == [
        {
            "id": "chunk-1",
            "pack": "go-latest",
            "text": "Use net/http Server.Shutdown with signal.NotifyContext.",
            "score": 0.99,
            "search_backend": "vector",
        }
    ]
    assert "embedding" not in results[0]
    assert "entities_json" not in results[0]


def test_search_pack_uses_pack_scoped_lexical_fallback(monkeypatch: pytest.MonkeyPatch):
    calls: list[dict] = []

    class FakeEmbedClient:
        def __init__(self, **_kwargs):
            pass

        def embed_texts(self, texts):
            return [[0.5] * EMBEDDING_DIM]

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def run(self, cypher, parameters=None, **kwargs):
            assert kwargs == {}
            calls.append({"cypher": cypher, "parameters": parameters})
            if "db.index.vector.queryNodes" in cypher:
                return []
            return [
                {
                    "node": {
                        "id": "chunk-2",
                        "pack": "go-latest",
                        "text": "Server.Shutdown gracefully closes a Go HTTP server." * 100,
                        "embedding": [0.5] * EMBEDDING_DIM,
                    },
                    "score": 4.0,
                }
            ]

    class FakeDriver:
        def session(self, *, database):
            assert database
            return FakeSession()

    class FakeWriter:
        database = "neo4j"

        def __init__(self, uri=""):
            self.uri = uri
            self.driver = FakeDriver()

    monkeypatch.setattr(synpack, "EmbedClient", FakeEmbedClient)
    monkeypatch.setattr(synpack, "NornicGraphWriter", FakeWriter)

    results = synpack.search_pack("net/http Server Shutdown", pack_id="go-latest", top_k=3)

    assert len(calls) == 2
    assert calls[1]["parameters"]["terms"] == ["net/http", "server", "shutdown"]
    assert results == [
        {
            "id": "chunk-2",
            "pack": "go-latest",
            "text": ("Server.Shutdown gracefully closes a Go HTTP server." * 100)[:2400],
            "score": 4.0,
            "search_backend": "lexical_fallback",
        }
    ]


def test_diagnose_pack_returns_counts_samples_indexes_and_query_hits(monkeypatch: pytest.MonkeyPatch):
    calls: list[dict] = []

    class FakeResult:
        def __init__(self, rows):
            self.rows = rows

        def single(self):
            return self.rows[0] if self.rows else None

        def __iter__(self):
            return iter(self.rows)

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def run(self, cypher, parameters=None):
            calls.append({"cypher": cypher, "parameters": parameters})
            if "RETURN 1 AS ok" in cypher:
                return FakeResult([{"ok": 1}])
            if "count(n) AS total" in cypher:
                return FakeResult([{"total": 2, "with_embedding": 1, "with_text": 2}])
            if "RETURN n.kind AS kind" in cypher:
                return FakeResult([{"kind": "Chunk", "count": 1}])
            if "SHOW INDEXES" in cypher:
                return FakeResult([{"name": "embeddings", "type": "VECTOR", "state": "ONLINE"}])
            if "sampled" in cypher:
                return FakeResult([{"sampled": 2, "with_embedding": 1, "with_text": 2}])
            if "matching_nodes" in cypher:
                return FakeResult([{"matching_nodes": 1}])
            if "any(term IN $terms" in cypher:
                return FakeResult(
                    [
                        {
                            "id": "chunk-1",
                            "kind": "Chunk",
                            "document_name": "net/http",
                            "package_name": "net/http",
                            "symbol_fqn": "net/http.Server.Shutdown",
                            "text": "Shutdown gracefully stops the server.",
                        }
                    ]
                )
            if "size(n.embedding)" in cypher:
                return FakeResult(
                    [
                        {
                            "id": "chunk-1",
                            "kind": "Chunk",
                            "document_name": "net/http",
                            "package_name": "net/http",
                            "symbol_fqn": "net/http.Server.Shutdown",
                            "embedding_size": EMBEDDING_DIM,
                            "first_value": 0.1,
                            "second_value": 0.2,
                            "last_value": 0.3,
                        }
                    ]
                )
            return FakeResult(
                [
                    {
                        "id": "chunk-1",
                        "kind": "Chunk",
                        "language": "go",
                        "domain": "go",
                        "document_name": "net/http",
                        "package_name": "net/http",
                        "symbol_fqn": "net/http.Server.Shutdown",
                        "artifact_kind": "docs",
                        "text": "Shutdown gracefully stops the server." * 20,
                        "property_keys": ["pack", "text", "kind"],
                    }
                ]
            )

    class FakeDriver:
        def session(self, *, database):
            assert database
            return FakeSession()

    class FakeWriter:
        database = "neo4j"

        def __init__(self, uri=""):
            self.uri = uri
            self.driver = FakeDriver()

    monkeypatch.setattr(synpack, "NornicGraphWriter", FakeWriter)

    result = synpack.diagnose_pack(pack_id="go-latest", query="Server Shutdown", limit=3)

    assert result["connectivity"] == {"ok": 1}
    assert result["counts"]["total"] == 2
    assert result["kinds"] == [{"kind": "Chunk", "count": 1}]
    assert result["indexes"] == [{"name": "embeddings", "type": "VECTOR", "state": "ONLINE"}]
    assert result["query_terms"] == ["server", "shutdown"]
    assert result["text_counts_sampled"] == {"sampled": 2, "with_embedding": 1, "with_text": 2}
    assert result["query_term_hits_sampled"] == {"matching_nodes": 1}
    assert result["embedding_samples"][0]["embedding_size"] == EMBEDDING_DIM
    assert len(result["sample_nodes"][0]["text"]) == 300
    assert calls[0]["parameters"] == {}


def test_diagnose_pack_vector_search_reports_raw_and_filtered_candidates(monkeypatch: pytest.MonkeyPatch):
    class FakeEmbedClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def embed_texts(self, texts):
            assert texts == ["shutdown"]
            return [[0.125] * EMBEDDING_DIM]

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def run(self, cypher, parameters=None):
            assert parameters["candidate_limit"] == 200
            assert parameters["limit"] == 8
            if "WHERE node.pack = $pack_id" in cypher:
                assert parameters["pack_id"] == "go-latest"
                return [
                    {
                        "id": "chunk-1",
                        "pack": "go-latest",
                        "kind": "Chunk",
                        "document_name": "net/http",
                        "package_name": "net/http",
                        "symbol_fqn": "net/http.Server.Shutdown",
                        "text": "Shutdown gracefully stops the server." * 20,
                        "score": 0.95,
                    }
                ]
            return [
                {
                    "id": "chunk-raw",
                    "pack": "go-latest",
                    "kind": "Chunk",
                    "document_name": "context",
                    "package_name": "context",
                    "symbol_fqn": "context.WithTimeout",
                    "text": "Context timeout." * 20,
                    "score": 0.9,
                }
            ]

    class FakeDriver:
        def session(self, *, database):
            assert database
            return FakeSession()

    class FakeWriter:
        database = "neo4j"

        def __init__(self, uri=""):
            self.uri = uri
            self.driver = FakeDriver()

    monkeypatch.setattr(synpack, "EmbedClient", FakeEmbedClient)
    monkeypatch.setattr(synpack, "NornicGraphWriter", FakeWriter)

    result = synpack.diagnose_pack_vector_search(
        "shutdown",
        pack_id="go-latest",
        top_k=8,
        embedder_url="http://embedder",
    )

    assert result["query_vector_dimensions"] == EMBEDDING_DIM
    assert result["candidate_limit"] == 200
    assert result["raw_vector_candidate_count"] == 1
    assert result["pack_filtered_candidate_count"] == 1
    assert len(result["pack_filtered_candidates"][0]["text"]) == 300


def test_diagnose_pack_vector_index_uses_existing_embedding(monkeypatch: pytest.MonkeyPatch):
    class FakeResult:
        def __init__(self, rows):
            self.rows = rows

        def single(self):
            return self.rows[0] if self.rows else None

        def __iter__(self):
            return iter(self.rows)

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def run(self, cypher, parameters=None):
            if "n.embedding AS embedding" in cypher:
                return FakeResult(
                    [
                        {
                            "id": "chunk-1",
                            "kind": "Chunk",
                            "document_name": "net/http",
                            "package_name": "net/http",
                            "symbol_fqn": "net/http.Server.Shutdown",
                            "embedding": [0.25] * EMBEDDING_DIM,
                        }
                    ]
                )
            assert parameters["limit"] == 5
            assert parameters["query_vector"] == [0.25] * EMBEDDING_DIM
            return FakeResult(
                [
                    {
                        "id": "chunk-1",
                        "pack": "go-latest",
                        "kind": "Chunk",
                        "document_name": "net/http",
                        "package_name": "net/http",
                        "symbol_fqn": "net/http.Server.Shutdown",
                        "score": 1.0,
                    }
                ]
            )

    class FakeDriver:
        def session(self, *, database):
            assert database
            return FakeSession()

    class FakeWriter:
        database = "neo4j"

        def __init__(self, uri=""):
            self.uri = uri
            self.driver = FakeDriver()

    monkeypatch.setattr(synpack, "NornicGraphWriter", FakeWriter)

    result = synpack.diagnose_pack_vector_index(pack_id="go-latest", top_k=5)

    assert result["embedding_dimensions"] == EMBEDDING_DIM
    assert result["numeric_value_count"] == EMBEDDING_DIM
    assert result["self_query_candidate_count"] == 1
    assert result["self_query_candidates"][0]["id"] == "chunk-1"


def test_repair_pack_vector_index_recreates_index(monkeypatch: pytest.MonkeyPatch):
    statements: list[str] = []

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def run(self, cypher, parameters=None):
            statements.append(cypher)
            if "SHOW INDEXES" in cypher:
                return [{"name": "embeddings", "type": "VECTOR", "state": "ONLINE", "populationPercent": 100.0}]
            return []

    class FakeDriver:
        def session(self, *, database):
            assert database
            return FakeSession()

    class FakeWriter:
        database = "neo4j"
        _VECTOR_INDEX_DDL = synpack.NornicGraphWriter._VECTOR_INDEX_DDL

        def __init__(self, uri=""):
            self.uri = uri
            self.driver = FakeDriver()

    monkeypatch.setattr(synpack, "NornicGraphWriter", FakeWriter)

    result = synpack.repair_pack_vector_index()

    assert "DROP INDEX embeddings IF EXISTS" in statements
    assert any("CREATE VECTOR INDEX embeddings" in statement for statement in statements)
    assert result["indexes"][0]["state"] == "ONLINE"


def test_retouch_pack_embeddings_resets_embedding_properties(monkeypatch: pytest.MonkeyPatch):
    calls: list[dict] = []

    class FakeResult:
        def __init__(self, rows):
            self.rows = rows

        def single(self):
            return self.rows[0] if self.rows else None

        def __iter__(self):
            return iter(self.rows)

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def run(self, cypher, parameters=None):
            calls.append({"cypher": cypher, "parameters": parameters})
            if "RETURN n.id AS id" in cypher:
                return FakeResult([{"id": "a"}, {"id": "b"}, {"id": "c"}])
            return FakeResult([{"touched": len(parameters["ids"])}])

    class FakeDriver:
        def session(self, *, database):
            assert database
            return FakeSession()

    class FakeWriter:
        database = "neo4j"

        def __init__(self, uri=""):
            self.uri = uri
            self.driver = FakeDriver()

    monkeypatch.setattr(synpack, "NornicGraphWriter", FakeWriter)

    result = synpack.retouch_pack_embeddings(pack_id="go-latest", batch_size=2)

    assert result == {
        "ok": True,
        "pack_id": "go-latest",
        "embedded_node_count": 3,
        "touched": 3,
        "batch_size": 2,
    }
    assert calls[1]["parameters"]["ids"] == ["a", "b"]
    assert calls[2]["parameters"]["ids"] == ["c"]


def test_retouch_pack_embeddings_caps_batch_size_for_large_vectors(monkeypatch: pytest.MonkeyPatch):
    class FakeResult:
        def __init__(self, rows):
            self.rows = rows

        def single(self):
            return self.rows[0] if self.rows else None

        def __iter__(self):
            return iter(self.rows)

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def run(self, cypher, parameters=None):
            if "RETURN n.id AS id" in cypher:
                return FakeResult([{"id": str(i)} for i in range(75)])
            assert len(parameters["ids"]) <= 50
            return FakeResult([{"touched": len(parameters["ids"])}])

    class FakeDriver:
        def session(self, *, database):
            assert database
            return FakeSession()

    class FakeWriter:
        database = "neo4j"

        def __init__(self, uri=""):
            self.uri = uri
            self.driver = FakeDriver()

    monkeypatch.setattr(synpack, "NornicGraphWriter", FakeWriter)

    result = synpack.retouch_pack_embeddings(pack_id="go-latest", batch_size=500)

    assert result["batch_size"] == 50
    assert result["embedded_node_count"] == 75
    assert result["touched"] == 75


def _write_minimal_v2_pack(path: Path, *, duplicate_chunk_row: bool = False) -> None:
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
    pack_card = {
        "id": "go-latest:pack-card:fmt",
        "kind": "PackCard",
        "name": "fmt overview",
        "text": "Use fmt for formatted I/O.",
        "what_to_use": "fmt package formatting helpers",
        "when_to_use": "formatted I/O",
        "minimal_example": 'fmt.Println("hello")',
        "verification": "go test ./...",
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
                    "node_count": 3,
                    "edge_count": 2,
                }
            ),
        )
        chunk_rows = [json.dumps(chunk)]
        if duplicate_chunk_row:
            chunk_rows.append(json.dumps(chunk))
        zf.writestr("nodes/chunks.jsonl", "\n".join(chunk_rows) + "\n")
        zf.writestr("nodes/documents.jsonl", json.dumps(document) + "\n")
        zf.writestr("nodes/pack_cards.jsonl", json.dumps(pack_card) + "\n")
        zf.writestr(
            "edges/contains.jsonl",
            json.dumps({"type": "CONTAINS", "source_id": "doc-1", "target_id": "chunk-1"}) + "\n",
        )
        zf.writestr(
            "edges/has_pack_card.jsonl",
            json.dumps({"type": "HAS_PACK_CARD", "source_id": "chunk-1", "target_id": pack_card["id"]}) + "\n",
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
                    "node_count": 4 if duplicate_chunk_row else 3,
                    "chunk_count": 2 if duplicate_chunk_row else 1,
                    "edge_count": 2,
                    "pack_card_count": 1,
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

        def suspend_unique_constraint(self) -> None:
            return None

        def restore_unique_constraint(self) -> None:
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
                "node_counts_by_kind": {"Chunk": 1, "Document": 1, "PackCard": 1},
            }

    monkeypatch.setattr(nornic_bulk_importer, "NornicGraphWriter", FakeWriter)
    monkeypatch.setattr(nornic_bulk_importer, "ensure_synesis_catalog", lambda client: client)

    result = nornic_bulk_importer.bulk_load_synpack(pack, replace=True)

    assert result["backend"] == "bolt-unwind"
    assert result["nodes"] == 3
    assert result["edges"] == 2
    assert result["deleted_existing_nodes"] == 3
    assert {node["kind"] for node in written_nodes} == {"Chunk", "Document", "PackCard"}
    card = next(node for node in written_nodes if node["kind"] == "PackCard")
    assert card["what_to_use"] == "fmt package formatting helpers"
    chunk = next(node for node in written_nodes if node["kind"] == "Chunk")
    assert chunk["embedding"] == [0.0] * EMBEDDING_DIM
    assert chunk["domain"] == "go"


def test_bulk_load_synpack_verifies_deduplicated_node_count(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pack = tmp_path / "v2-bulk-duplicate.synpack"
    _write_minimal_v2_pack(pack, duplicate_chunk_row=True)
    written_nodes: list[dict] = []
    written_edges: list[dict] = []

    class FakeWriter:
        def __init__(self, uri: str = ""):
            self.uri = uri
            self.client = self

        def close(self) -> None:
            return None

        def delete_pack(self, pack_id: str) -> int:
            assert pack_id == "go-latest"
            return 0

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
                "node_counts_by_kind": {"Chunk": 1, "Document": 1, "PackCard": 1},
            }

    monkeypatch.setattr(nornic_bulk_importer, "NornicGraphWriter", FakeWriter)
    monkeypatch.setattr(nornic_bulk_importer, "ensure_synesis_catalog", lambda client: client)

    result = nornic_bulk_importer.bulk_load_synpack(pack, replace=True)

    assert result["nodes"] == 3
    assert result["quality"]["node_count"] == 4
    assert result["quality"]["chunk_count"] == 2
    assert len(written_nodes) == 3


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


def test_content_pack_runner_rejects_legacy_bolt_backend(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pack = tmp_path / "large.synpack"
    _write_minimal_v2_pack(pack)
    monkeypatch.setattr(content_pack_runner, "_IMPORT_BACKEND", "legacy-bolt")

    with pytest.raises(RuntimeError, match="legacy-bolt"):
        content_pack_runner._load_content_pack({"replace_existing": False}, pack, nornic_uri="bolt://nornic")


def test_iter_jsonl_recovers_from_latin1_bytes(tmp_path: Path):
    """Synpack loader recovers when JSONL contains non-UTF-8 bytes (e.g. Latin-1)."""
    from app.synpack import _iter_jsonl

    # Simulate a JSONL file where a value contains a Latin-1 byte (0xBE = ¾)
    line1 = b'{"id": "chunk-1", "text": "value is \xbe here"}\n'
    line2 = b'{"id": "chunk-2", "text": "clean line"}\n'
    bad_file = tmp_path / "chunks.jsonl"
    bad_file.write_bytes(line1 + line2)

    rows = list(_iter_jsonl(bad_file))

    assert len(rows) == 2
    assert rows[0]["id"] == "chunk-1"
    assert "\ufffd" in rows[0]["text"]  # replacement character
    assert rows[1]["id"] == "chunk-2"
    assert rows[1]["text"] == "clean line"


def test_iter_jsonl_works_with_valid_utf8(tmp_path: Path):
    """Normal UTF-8 JSONL files load without triggering the fallback path."""
    from app.synpack import _iter_jsonl

    content = '{"id": "chunk-1", "text": "héllo wörld 你好"}\n{"id": "chunk-2", "text": "ok"}\n'
    jsonl_file = tmp_path / "chunks.jsonl"
    jsonl_file.write_text(content, encoding="utf-8")

    rows = list(_iter_jsonl(jsonl_file))

    assert len(rows) == 2
    assert rows[0]["text"] == "héllo wörld 你好"
    assert rows[1]["text"] == "ok"


def test_read_manifest_rejects_binary_manifest(tmp_path: Path):
    """read_manifest wraps UnicodeDecodeError as SynPackError."""
    pack = tmp_path / "bad-manifest.synpack"
    with zipfile.ZipFile(pack, "w") as zf:
        zf.writestr("manifest.json", b"\x00\xbe\xef not json at all")
        zf.writestr("nodes/chunks.jsonl", '{"id":"c1","text":"x"}\n')

    with pytest.raises(SynPackError, match="not valid JSON"):
        validate_synpack(pack)


def test_bulk_load_recovers_latin1_chunks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """bulk_load_synpack succeeds when nodes/chunks.jsonl has non-UTF-8 bytes."""
    vector = [0.0] * EMBEDDING_DIM
    chunk_line = b'{"id": "chunk-1", "chunk_id": "chunk-1", "kind": "Chunk", '
    chunk_line += b'"text": "Package \xbe fmt", "doc_id": "d1", '
    chunk_line += b'"pack_id": "test-pack", "domain": "go", "language": "go"}\n'

    with zipfile.ZipFile(tmp_path / "latin1.synpack", "w") as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "pack_id": "test-pack",
                    "pack_version": "1.0.0",
                    "embedding_model": "BAAI/bge-m3",
                    "embedding_dimensions": EMBEDDING_DIM,
                    "synesis_catalog_schema_version": 17,
                    "requires_bulk_import": True,
                    "node_count": 1,
                    "edge_count": 0,
                }
            ),
        )
        zf.writestr("nodes/chunks.jsonl", chunk_line)
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
                    "node_count": 1,
                    "chunk_count": 1,
                    "edge_count": 0,
                    "dangling_edge_count": 0,
                    "pack_card_count": 0,
                }
            ),
        )

    written_nodes: list[dict] = []

    class FakeWriter:
        def __init__(self, uri=""):
            self.client = self

        def close(self):
            pass

        def ensure_schema(self):
            pass

        def suspend_unique_constraint(self):
            pass

        def restore_unique_constraint(self):
            pass

        def delete_pack(self, pack_id):
            return 0

        def bulk_upsert_nodes(self, rows, *, create_only=False, batch_size=None):
            written_nodes.extend(rows)
            return len(rows)

        def upsert_edges(self, edges):
            return len(edges)

        def pack_counts(self, pack_id):
            return {
                "node_count": len(written_nodes),
                "chunk_count": len(written_nodes),
                "embedding_count": len(written_nodes),
                "edge_count": 0,
            }

    monkeypatch.setattr(nornic_bulk_importer, "NornicGraphWriter", FakeWriter)
    monkeypatch.setattr(nornic_bulk_importer, "ensure_synesis_catalog", lambda client: client)

    result = nornic_bulk_importer.bulk_load_synpack(tmp_path / "latin1.synpack", replace=True)

    assert result["ok"] is True
    assert result["nodes"] == 1
    assert len(written_nodes) == 1
    assert "\ufffd" in written_nodes[0]["text"]  # bad byte replaced
