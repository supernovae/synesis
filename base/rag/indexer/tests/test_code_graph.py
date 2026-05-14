from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "base" / "images" / "base-api" / "synesis-telemetry"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.code_graph import derive_graph_edges
from app.handlers.base import RawDocument
from app.handlers.github_code import GitHubCodeHandler, _extract_call_refs, _extract_import_refs
from app.nornic_writer import NornicGraphWriter


def test_github_code_chunks_preserve_graph_metadata(monkeypatch):
    monkeypatch.setattr(
        "app.handlers.github_code._tree_sitter_chunk",
        lambda *_args: [
            {
                "text": "import requests\n\ndef fetch(url):\n    return requests.get(url)\n",
                "symbol_name": "fetch",
                "symbol_type": "function",
                "start_line": 1,
                "end_line": 4,
            }
        ],
    )

    doc = RawDocument(
        doc_id="github:acme/app:src/client.py",
        name="client.py",
        content="import requests\n\ndef fetch(url):\n    return requests.get(url)\n",
        source_url="https://github.com/acme/app/blob/main/src/client.py",
        metadata={"repo": "acme/app", "language": "python", "file_path": "src/client.py"},
    )

    chunks = GitHubCodeHandler().parse_and_chunk(doc)

    assert chunks[0].metadata["symbol_fqn"] == "acme/app:src/client.py:fetch"
    assert chunks[0].metadata["package_name"] == "acme/app"
    assert chunks[0].metadata["import_refs"] == "requests"
    assert "requests.get" in chunks[0].metadata["call_refs"]


def test_code_metadata_derives_import_and_call_edges():
    edges = derive_graph_edges(
        [
            {
                "id": "chunk-1",
                "pack": "global",
                "path": "src/client.py",
                "symbol_name": "fetch",
                "symbol_fqn": "acme/app:src/client.py:fetch",
                "import_refs": "requests",
                "call_refs": "requests.get,helper",
            },
            {
                "id": "chunk-2",
                "pack": "global",
                "path": "src/client.py",
                "symbol_name": "helper",
                "symbol_fqn": "acme/app:src/client.py:helper",
                "import_refs": "",
                "call_refs": "",
            },
        ]
    )

    assert any(
        edge["type"] == "IMPORTS"
        and edge["source_id"] == "global:file:src/client.py"
        and edge["target_id"] == "import:requests"
        and edge["resolution_confidence"] == "external_or_unresolved"
        for edge in edges
    )
    assert any(
        edge["type"] == "CALLS"
        and edge["source_id"] == "acme/app:src/client.py:fetch"
        and edge["target_id"] == "acme/app:src/client.py:helper"
        and edge["resolution_confidence"] == "symbol"
        for edge in edges
    )


def test_code_graph_resolves_import_to_pack_file():
    edges = derive_graph_edges(
        [
            {
                "id": "chunk-1",
                "pack": "global",
                "path": "src/client.py",
                "symbol_name": "fetch",
                "symbol_fqn": "acme/app:src/client.py:fetch",
                "import_refs": "pkg.mod",
            },
            {
                "id": "chunk-2",
                "pack": "global",
                "path": "pkg/mod.py",
                "symbol_name": "Thing",
                "symbol_fqn": "acme/app:pkg/mod.py:Thing",
            },
        ]
    )

    assert any(
        edge["type"] == "IMPORTS"
        and edge["target_id"] == "global:file:pkg/mod.py"
        and edge["resolution_confidence"] == "module"
        for edge in edges
    )


def test_metadata_refs_derive_semantic_graph_edges():
    edges = derive_graph_edges(
        [
            {
                "id": "button-class-chunk",
                "symbol_fqn": "Button",
                "contains_refs": "Button.pressed,Button.set_text",
                "implements_refs": "BaseButton",
            },
            {
                "id": "signals-doc-chunk",
                "documents_refs": "Button.pressed,godot:lifecycle:_ready",
                "doc_relation_ids": "Button.pressed",
            },
        ]
    )

    assert any(
        edge["type"] == "CONTAINS" and edge["source_id"] == "Button" and edge["target_id"] == "Button.pressed"
        for edge in edges
    )
    assert any(
        edge["type"] == "IMPLEMENTS" and edge["source_id"] == "Button" and edge["target_id"] == "BaseButton"
        for edge in edges
    )
    assert any(
        edge["type"] == "DOCUMENTS"
        and edge["source_id"] == "signals-doc-chunk"
        and edge["target_id"] == "godot:lifecycle:_ready"
        for edge in edges
    )
    assert any(
        edge["type"] == "REFERENCES"
        and edge["source_id"] == "signals-doc-chunk"
        and edge["target_id"] == "Button.pressed"
        for edge in edges
    )


def test_lightweight_code_reference_extractors():
    assert set(_extract_import_refs("from pkg.mod import thing\nimport os\n", "python")) == {"pkg.mod", "os"}
    calls = _extract_call_refs("if ready:\n    client.fetch(url)\n    helper()\n", "python")
    assert "client.fetch" in calls
    assert "helper" in calls
    assert "if" not in calls


def test_nornic_edge_writes_are_batched_by_type(monkeypatch):
    writer = NornicGraphWriter.__new__(NornicGraphWriter)
    calls: list[tuple[str, list[dict]]] = []
    monkeypatch.setattr(writer, "_write_edge_group", lambda edge_type, rows: calls.append((edge_type, rows)))

    count = writer.upsert_edges(
        [
            {"type": "CALLS", "source_id": "a", "target_id": "b", "call_ref": "b"},
            {"type": "CALLS", "source_id": "a", "target_id": "c", "call_ref": "c"},
            {"type": "IMPORTS", "source_id": "file", "target_id": "import:os", "import_ref": "os"},
        ]
    )

    assert count == 3
    assert calls[0][0] == "CALLS"
    assert len(calls[0][1]) == 2
    assert calls[1][0] == "IMPORTS"
    assert len(calls[1][1]) == 1


def test_nornic_node_writes_use_scalar_parameters():
    calls: list[tuple[str, dict]] = []

    class FakeResult:
        def single(self) -> dict[str, int]:
            return {"existing": 0}

    class FakeTx:
        def run(self, query: str, **params: object) -> None:
            calls.append((query, params))
            return FakeResult()

    NornicGraphWriter._upsert_nodes_tx(
        FakeTx(),
        [
            {
                "id": "chunk-1",
                "text": "content",
                "pack": "go-latest",
                "doc_id": "doc-1",
                "path": "net/http/server.go",
                "symbol_fqn": "net/http.Server",
                "embedding": [0.1, 0.2],
            }
        ],
    )

    assert calls[0][1]["id"] == "chunk-1"
    assert calls[1][1]["id"] == "chunk-1"
    assert calls[1][1]["props"]["pack"] == "go-latest"
    assert calls[1][1]["props"]["embedding"] == [0.1, 0.2]
    assert "id" not in calls[1][1]["props"]
    assert "row.id" not in calls[1][0]
    assert "MERGE (n:ContentNode {id: $id})" in calls[0][0]
    assert "SET n += $props" in calls[1][0]
    assert len(calls) == 2


def test_nornic_edge_tx_uses_scalar_parameters():
    calls: list[tuple[str, dict]] = []

    class FakeResult:
        def single(self) -> dict[str, int]:
            return {"existing": 1}

    class FakeTx:
        def run(self, query: str, **params: object) -> None:
            calls.append((query, params))
            return FakeResult()

    NornicGraphWriter._write_edges_tx(
        FakeTx(),
        "CALLS",
        [{"source_id": "a", "target_id": "b", "props": {"call_ref": "b"}}],
    )

    assert calls[-1][1] == {"source_id": "a", "target_id": "b", "props": {"call_ref": "b"}}
    assert "row.source_id" not in calls[-1][0]
