from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "base" / "images" / "base-api" / "synesis-telemetry"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import language_pack
from app.language_pack import (
    build_language_pack,
    fallback_enrichment,
    latest_go_stable_tag_from_refs,
    parse_enrichment_response,
    parse_go_stable_tag,
)
from app.schema import EMBEDDING_DIM
from app.synpack import SynPackError, validate_synpack


def test_go_tag_parser_accepts_stable_and_rejects_prerelease():
    assert parse_go_stable_tag("go1.26.2") == (1, 26, 2)
    assert parse_go_stable_tag("go1.27rc1") is None
    assert parse_go_stable_tag("go1.27beta1") is None
    assert parse_go_stable_tag("weekly") is None
    assert parse_go_stable_tag("1.26.2") is None


def test_latest_go_stable_tag_from_refs_ignores_prerelease():
    refs = "\n".join(
        [
            "abc\trefs/tags/go1.26.1",
            "def\trefs/tags/go1.27rc1",
            "ghi\trefs/tags/weekly",
            "jkl\trefs/tags/go1.26.2",
        ]
    )
    assert latest_go_stable_tag_from_refs(refs) == "go1.26.2"


def test_enrichment_response_parser_requires_single_object():
    raw = json.dumps(
        {
            "agent_hook": "Use for HTTP streaming.",
            "perf_tier": "io-bound",
            "safety_contract": "Close response bodies.",
            "lifecycle_model": "Construct client, reuse, close bodies.",
            "memory_semantics": "",
            "concurrency_contract": "Client is safe for concurrent use.",
            "idiomatic_version": "go1.26.2",
            "zero_value_behavior": "",
            "related_interfaces": ["io.Reader"],
            "hidden_warnings": [],
        }
    )
    parsed = parse_enrichment_response(raw)
    assert parsed["perf_tier"] == "io-bound"
    with pytest.raises(SynPackError, match="single JSON object"):
        parse_enrichment_response("[]")
    with pytest.raises(SynPackError, match="missing fields"):
        parse_enrichment_response('{"agent_hook":"x"}')


def test_fallback_enrichment_is_deterministic():
    chunk = language_pack.LanguageChunk(text="x", doc_id="d", chunk_index=0, document_name="doc", package_name="fmt")
    first = fallback_enrichment(chunk, error="boom")
    second = fallback_enrichment(chunk, error="boom")
    assert first == second
    assert first["enrichment_status"] == "fallback"
    assert "boom" in first["hidden_warnings"]


def test_build_language_pack_from_go_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source = tmp_path / "go-src"
    (source / "doc").mkdir(parents=True)
    (source / "api").mkdir()
    (source / "src" / "fmt").mkdir(parents=True)
    (source / "src" / "net" / "http").mkdir(parents=True)
    (source / "doc" / "go_spec.html").write_text("# Go Spec\n\nThe Go programming language.", encoding="utf-8")
    (source / "api" / "go1.1.txt").write_text("pkg fmt, func Println(...any) (int, error)", encoding="utf-8")
    (source / "README.md").write_text("# Go", encoding="utf-8")
    (source / "src" / "fmt" / "doc.go").write_text("// Package fmt implements formatted I/O.\npackage fmt\n", encoding="utf-8")
    (source / "src" / "fmt" / "print.go").write_text(
        "package fmt\n\n// Println formats using default formats.\nfunc Println(a ...any) (n int, err error) { return 0, nil }\n",
        encoding="utf-8",
    )
    (source / "src" / "net" / "http" / "doc.go").write_text("// Package http provides HTTP client and server implementations.\npackage http\n", encoding="utf-8")
    (source / "src" / "net" / "http" / "server.go").write_text(
        "package http\n\n// Handler responds to an HTTP request.\ntype Handler interface { ServeHTTP(ResponseWriter, *Request) }\n",
        encoding="utf-8",
    )

    class FakeEmbedClient:
        def __init__(self, **_kwargs):
            pass

        def embed_texts(self, texts):
            return [[0.0] * EMBEDDING_DIM for _ in texts]

    monkeypatch.setattr(language_pack, "EmbedClient", FakeEmbedClient)
    out = tmp_path / "go.synpack"
    result = build_language_pack(
        language="go",
        output_path=out,
        source_dir=source,
        latest_tag="go1.26.2",
        skip_enrichment=True,
        max_chunks=25,
    )
    assert result["ok"] is True
    manifest = validate_synpack(out)
    assert manifest["schema_version"] == 17
    assert manifest["source_version"] == "go1.26.2"
    assert manifest["enrichment"]["prompt_id"] == "go_agentic_architect_v1"
    assert manifest["enrichment"]["skipped"] is True
    with zipfile.ZipFile(out) as zf:
        rows = [json.loads(line) for line in zf.read("metadata.jsonl").decode().splitlines()]
    assert rows
    assert any(row["package_name"] == "fmt" and row["symbol_kind"] == "function" for row in rows)
    assert all("agent_enrichment_json" in row for row in rows)
