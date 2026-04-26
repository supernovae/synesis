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
    latest_godot_stable_tag_from_refs,
    latest_go_stable_tag_from_refs,
    latest_python_stable_tag_from_refs,
    latest_quarkus_stable_tag_from_refs,
    latest_rust_stable_tag_from_refs,
    latest_terraform_stable_tag_from_refs,
    parse_enrichment_response,
    parse_godot_stable_tag,
    parse_go_stable_tag,
    parse_python_stable_tag,
    parse_quarkus_stable_tag,
    parse_rust_stable_tag,
    parse_terraform_stable_tag,
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


def test_rust_tag_parser_accepts_stable_and_rejects_prerelease():
    assert parse_rust_stable_tag("1.88.0") == (1, 88, 0)
    assert parse_rust_stable_tag("1.89.0-beta.1") is None
    assert parse_rust_stable_tag("1.89.0-nightly") is None
    assert parse_rust_stable_tag("1.89.0-rc.1") is None
    assert parse_rust_stable_tag("rust-1.88.0") is None


def test_latest_rust_stable_tag_from_refs_ignores_prerelease():
    refs = "\n".join(
        [
            "abc\trefs/tags/1.87.1",
            "def\trefs/tags/1.88.0-beta.1",
            "ghi\trefs/tags/nightly",
            "jkl\trefs/tags/1.88.0",
        ]
    )
    assert latest_rust_stable_tag_from_refs(refs) == "1.88.0"


def test_quarkus_tag_parser_accepts_stable_and_rejects_prerelease():
    assert parse_quarkus_stable_tag("3.34.1") == (3, 34, 1)
    assert parse_quarkus_stable_tag("3.33.0.Final") == (3, 33, 0)
    assert parse_quarkus_stable_tag("3.35.0.CR1") is None
    assert parse_quarkus_stable_tag("3.35.0.Beta1") is None
    assert parse_quarkus_stable_tag("999-SNAPSHOT") is None


def test_latest_quarkus_stable_tag_from_refs_ignores_prerelease():
    refs = "\n".join(
        [
            "abc\trefs/tags/3.33.0",
            "def\trefs/tags/3.34.0.CR1",
            "ghi\trefs/tags/3.34.1",
            "jkl\trefs/tags/999-SNAPSHOT",
        ]
    )
    assert latest_quarkus_stable_tag_from_refs(refs) == "3.34.1"


def test_python_tag_parser_accepts_stable_and_rejects_prerelease():
    assert parse_python_stable_tag("v3.14.4") == (3, 14, 4)
    assert parse_python_stable_tag("3.14.4") == (3, 14, 4)
    assert parse_python_stable_tag("v3.15.0a1") is None
    assert parse_python_stable_tag("v3.15.0rc1") is None
    assert parse_python_stable_tag("python-3.14.4") is None


def test_latest_python_stable_tag_from_refs_ignores_prerelease():
    refs = "\n".join(
        [
            "abc\trefs/tags/v3.14.3",
            "def\trefs/tags/v3.15.0a1",
            "ghi\trefs/tags/v3.14.4",
        ]
    )
    assert latest_python_stable_tag_from_refs(refs) == "v3.14.4"


def test_godot_tag_parser_accepts_stable_and_rejects_prerelease():
    assert parse_godot_stable_tag("4.4-stable") == (4, 4, 0)
    assert parse_godot_stable_tag("4.4.1-stable") == (4, 4, 1)
    assert parse_godot_stable_tag("4.5-rc1") is None
    assert parse_godot_stable_tag("4.5-beta1") is None
    assert parse_godot_stable_tag("godot-4.4") is None


def test_latest_godot_stable_tag_from_refs_ignores_prerelease():
    refs = "\n".join(
        [
            "abc\trefs/tags/4.3-stable",
            "def\trefs/tags/4.4-rc1",
            "ghi\trefs/tags/4.4-stable",
            "jkl\trefs/tags/4.4.1-stable",
        ]
    )
    assert latest_godot_stable_tag_from_refs(refs) == "4.4.1-stable"


def test_terraform_tag_parser_accepts_stable_and_rejects_prerelease():
    assert parse_terraform_stable_tag("v1.11.2") == (1, 11, 2)
    assert parse_terraform_stable_tag("1.11.2") == (1, 11, 2)
    assert parse_terraform_stable_tag("v1.12.0-rc1") is None
    assert parse_terraform_stable_tag("v1.12.0-beta1") is None
    assert parse_terraform_stable_tag("terraform-1.11.2") is None


def test_latest_terraform_stable_tag_from_refs_ignores_prerelease():
    refs = "\n".join(
        [
            "abc\trefs/tags/v1.11.1",
            "def\trefs/tags/v1.12.0-rc1",
            "ghi\trefs/tags/v1.11.2",
        ]
    )
    assert latest_terraform_stable_tag_from_refs(refs) == "v1.11.2"


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


def test_rust_fallback_preserves_async_contract_and_error_context():
    chunk = language_pack.LanguageChunk(
        text="E0716 temporary value dropped while borrowed",
        doc_id="rust:rust-lang/rust:compiler/rustc_error_codes/src/E0716.md:E0716",
        chunk_index=0,
        document_name="E0716.md",
        package_name="rustc_error_codes",
        symbol_kind="compiler_error",
        symbol_fqn="E0716",
    )
    enrichment = fallback_enrichment(chunk, error="skipped")
    assert enrichment["error_context"] == "E0716"
    assert enrichment["async_contract"]["cancel_safety"] == "unknown"
    assert enrichment["enrichment_status"] == "fallback"


def test_quarkus_fallback_preserves_framework_and_cli_contracts():
    config_chunk = language_pack.LanguageChunk(
        text="quarkus.datasource.db-kind is build-time fixed",
        doc_id="quarkus:github.com/quarkusio/quarkus:extensions/datasource/runtime/src/main/java/Config.java",
        chunk_index=0,
        document_name="Config.java",
        package_name="datasource",
        symbol_kind="config_property",
        artifact_kind="config_reference",
    )
    config_enrichment = fallback_enrichment(config_chunk, error="skipped")
    assert config_enrichment["build_time_config"] == []
    assert config_enrichment["config_phase"] == "unknown"
    cli_chunk = language_pack.LanguageChunk(
        text="@Command(name = \"dev\")",
        doc_id="quarkus:github.com/quarkusio/quarkus:devtools/cli/src/main/java/io/quarkus/cli/Dev.java:dev",
        chunk_index=0,
        document_name="Dev.java",
        package_name="quarkus-cli",
        symbol_kind="cli_command",
        symbol_fqn="quarkus dev",
        artifact_kind="cli_command",
    )
    cli_enrichment = fallback_enrichment(cli_chunk, error="skipped")
    assert cli_enrichment["command_intent"] == "unknown"
    assert cli_enrichment["agent_advice"].startswith("Prefer Quarkus CLI")


def test_python_fallback_preserves_language_and_repo_map_contracts():
    chunk = language_pack.LanguageChunk(
        text="asyncio TaskGroup",
        doc_id="python:github.com/python/cpython:Lib/asyncio/taskgroups.py:TaskGroup",
        chunk_index=0,
        document_name="taskgroups.py",
        package_name="asyncio",
        symbol_kind="class",
        artifact_kind="code",
    )
    enrichment = fallback_enrichment(chunk, error="skipped")
    assert enrichment["thread_model"] == "unknown"
    assert enrichment["type_resolution_hint"] == "unknown"
    repo_map = {"map_level": 2, "module_intent": "Auth helpers", "center_of_gravity": 0.5}
    map_chunk = language_pack.LanguageChunk(
        text=json.dumps(repo_map),
        doc_id="python:github.com/python/cpython:repo-map:Lib/auth.py",
        chunk_index=0,
        document_name="Lib/auth.py",
        package_name="repo_map",
        symbol_kind="module",
        artifact_kind="repo_map",
        metadata={"repo_map_json": repo_map},
    )
    map_enrichment = fallback_enrichment(map_chunk, error="skipped")
    assert map_enrichment["map_level"] == 2
    assert map_enrichment["module_intent"] == "Auth helpers"


def test_godot_fallback_preserves_scene_and_signal_contracts():
    chunk = language_pack.LanguageChunk(
        text="Signal: Button.pressed()\n\nEmitted when pressed.",
        doc_id="godot:github.com/godotengine/godot:doc/classes/Button.xml:Button.pressed",
        chunk_index=0,
        document_name="doc/classes/Button.xml",
        package_name="godot-class-reference",
        symbol_kind="signal",
        symbol_fqn="Button.pressed",
        artifact_kind="class_reference",
        metadata={"signal_list": ["pressed()"]},
    )
    enrichment = fallback_enrichment(chunk, error="skipped")
    assert enrichment["signal_list"] == ["pressed()"]
    assert enrichment["signal_contract"] == "unknown"
    assert enrichment["legacy_3x_warning"] == "unknown"


def test_terraform_fallback_preserves_plan_and_drift_contracts():
    chunk = language_pack.LanguageChunk(
        text='{"name":"aws_db_instance"}',
        doc_id="terraform:registry.terraform.io/hashicorp/aws:schema.json:resource:aws_db_instance",
        chunk_index=0,
        document_name="schema.json",
        package_name="registry.terraform.io/hashicorp/aws",
        symbol_kind="resource",
        symbol_fqn="aws_db_instance",
        artifact_kind="provider_schema",
        metadata={"provider": "registry.terraform.io/hashicorp/aws"},
    )
    enrichment = fallback_enrichment(chunk, error="skipped")
    assert enrichment["cloud_provider"] == "registry.terraform.io/hashicorp/aws"
    assert enrichment["destroy_triggers"] == []
    assert "terraform plan" in enrichment["plan_guardrail"]


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


def test_build_language_pack_from_rust_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source = tmp_path / "rust-src"
    (source / "library" / "std" / "src").mkdir(parents=True)
    (source / "library" / "core" / "src").mkdir(parents=True)
    (source / "library" / "alloc" / "src").mkdir(parents=True)
    (source / "compiler" / "rustc_error_codes" / "src").mkdir(parents=True)
    (source / "reference" / "src").mkdir(parents=True)
    (source / "nomicon" / "src").mkdir(parents=True)
    (source / "async-book" / "src").mkdir(parents=True)
    (source / "book" / "src").mkdir(parents=True)
    (source / "library" / "std" / "src" / "lib.rs").write_text(
        "/// A growable string type.\npub struct String;\n\n/// Spawns a thread.\npub fn spawn<F>(f: F) where F: Send + 'static {}\n",
        encoding="utf-8",
    )
    (source / "library" / "core" / "src" / "future.rs").write_text(
        "/// A future value.\npub trait Future { type Output; }\n",
        encoding="utf-8",
    )
    (source / "library" / "alloc" / "src" / "boxed.rs").write_text(
        "/// A pointer type for heap allocation.\npub struct Box<T>(T);\n",
        encoding="utf-8",
    )
    (source / "compiler" / "rustc_error_codes" / "src" / "E0716.md").write_text(
        "# E0716\n\nA temporary value was dropped while borrowed.",
        encoding="utf-8",
    )
    (source / "reference" / "src" / "edition-2024.md").write_text(
        "# Rust 2024\n\nThe 2024 edition changes RPIT lifetime capture and reserves the gen keyword.",
        encoding="utf-8",
    )
    (source / "nomicon" / "src" / "ffi.md").write_text("# FFI\n\nUnsafe Rust FFI requires layout invariants.", encoding="utf-8")
    (source / "async-book" / "src" / "pinning.md").write_text("# Pinning\n\nFutures may require Pin.", encoding="utf-8")
    (source / "book" / "src" / "ch01.md").write_text("# Rust 2021\n\nCargo projects use edition 2021.", encoding="utf-8")

    class FakeEmbedClient:
        def __init__(self, **_kwargs):
            pass

        def embed_texts(self, texts):
            return [[0.0] * EMBEDDING_DIM for _ in texts]

    monkeypatch.setattr(language_pack, "EmbedClient", FakeEmbedClient)
    out = tmp_path / "rust.synpack"
    result = build_language_pack(
        language="rust",
        output_path=out,
        source_dir=source,
        latest_tag="1.88.0",
        skip_enrichment=True,
        max_chunks=50,
    )
    assert result["ok"] is True
    manifest = validate_synpack(out)
    assert manifest["schema_version"] == 17
    assert manifest["source_version"] == "1.88.0"
    assert manifest["enrichment"]["prompt_id"] == "rust_agentic_architect_2024_v1"
    assert "rust_error_debugger_v1" in manifest["enrichment"]["prompt_hashes"]
    with zipfile.ZipFile(out) as zf:
        rows = [json.loads(line) for line in zf.read("metadata.jsonl").decode().splitlines()]
    assert any(row["language"] == "rust" and row["symbol_kind"] == "struct" for row in rows)
    assert any(row["artifact_kind"] == "compiler_error" and row["symbol_fqn"] == "E0716" for row in rows)
    assert any("edition-2024" in row["scope_tags"] for row in rows)
    error_row = next(row for row in rows if row["symbol_fqn"] == "E0716")
    assert json.loads(error_row["agent_enrichment_json"])["error_context"] == "E0716"


def test_build_language_pack_from_quarkus_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source = tmp_path / "quarkus-src"
    (source / "docs" / "src" / "main" / "asciidoc").mkdir(parents=True)
    (source / "extensions" / "datasource" / "runtime" / "src" / "main" / "java" / "io" / "quarkus" / "datasource").mkdir(parents=True)
    (source / "core" / "runtime" / "src" / "main" / "java" / "io" / "quarkus" / "runtime").mkdir(parents=True)
    (source / "devtools" / "cli" / "src" / "main" / "java" / "io" / "quarkus" / "cli").mkdir(parents=True)
    (source / "quarkus-platform").mkdir()
    (source / "docs" / "src" / "main" / "asciidoc" / "cli-tooling.adoc").write_text(
        "= Quarkus CLI\n\nThe quarkus dev command starts dev mode with hot reload and Dev Services.",
        encoding="utf-8",
    )
    (source / "extensions" / "datasource" / "runtime" / "src" / "main" / "java" / "io" / "quarkus" / "datasource" / "DataSourceConfig.java").write_text(
        """
package io.quarkus.datasource;

import io.quarkus.runtime.annotations.ConfigItem;
import io.quarkus.runtime.annotations.ConfigRoot;

/** Datasource build-time configuration. */
@ConfigRoot
public class DataSourceConfig {
    /** Database kind. This is fixed at build time. */
    @ConfigItem
    public String dbKind;
}
""",
        encoding="utf-8",
    )
    (source / "core" / "runtime" / "src" / "main" / "java" / "io" / "quarkus" / "runtime" / "LaunchMode.java").write_text(
        "package io.quarkus.runtime;\n\n/** Quarkus launch mode. */\npublic enum LaunchMode { NORMAL, DEVELOPMENT }\n",
        encoding="utf-8",
    )
    (source / "devtools" / "cli" / "src" / "main" / "java" / "io" / "quarkus" / "cli" / "Dev.java").write_text(
        """
package io.quarkus.cli;

import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

/** Starts Quarkus dev mode. */
@Command(name = "dev", description = "Run dev mode")
public class Dev {
    @Option(names = "--debug")
    boolean debug;
}
""",
        encoding="utf-8",
    )
    (source / "quarkus-platform" / "pom.xml").write_text(
        "<project><artifactId>quarkus-bom</artifactId><version>3.34.1</version></project>",
        encoding="utf-8",
    )

    class FakeEmbedClient:
        def __init__(self, **_kwargs):
            pass

        def embed_texts(self, texts):
            return [[0.0] * EMBEDDING_DIM for _ in texts]

    monkeypatch.setattr(language_pack, "EmbedClient", FakeEmbedClient)
    out = tmp_path / "quarkus.synpack"
    result = build_language_pack(
        language="quarkus",
        output_path=out,
        source_dir=source,
        latest_tag="3.34.1",
        skip_enrichment=True,
        max_chunks=50,
    )
    assert result["ok"] is True
    manifest = validate_synpack(out)
    assert manifest["source_version"] == "3.34.1"
    assert manifest["enrichment"]["prompt_id"] == "quarkus_cloud_native_architect_v1"
    assert "quarkus_cli_architect_v1" in manifest["enrichment"]["prompt_hashes"]
    with zipfile.ZipFile(out) as zf:
        rows = [json.loads(line) for line in zf.read("metadata.jsonl").decode().splitlines()]
    assert any(row["artifact_kind"] == "cli_command" and row["symbol_fqn"] == "quarkus dev" for row in rows)
    assert any(row["artifact_kind"] == "config_reference" and row["symbol_kind"] == "config_property" for row in rows)
    assert any("build-time-config" in row["scope_tags"] for row in rows)
    assert any(row["artifact_kind"] == "platform_bom" for row in rows)
    cli_row = next(row for row in rows if row["artifact_kind"] == "cli_command")
    assert json.loads(cli_row["agent_enrichment_json"])["command_intent"] == "unknown"


def test_build_language_pack_from_python_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source = tmp_path / "python-src"
    (source / "Lib" / "asyncio").mkdir(parents=True)
    (source / "Lib" / "concurrent").mkdir(parents=True)
    (source / "Lib" / "string").mkdir(parents=True)
    (source / "Doc").mkdir()
    (source / "peps").mkdir()
    (source / "packaging.python.org" / "source").mkdir(parents=True)
    (source / "uv" / "docs").mkdir(parents=True)
    (source / "pixi" / "docs").mkdir(parents=True)
    (source / "typeshed" / "stdlib").mkdir(parents=True)
    (source / "pyproject.toml").write_text(
        '[project]\nname = "demo"\nrequires-python = ">=3.14"\ndependencies = ["httpx>=0.27"]\n',
        encoding="utf-8",
    )
    (source / "Lib" / "asyncio" / "taskgroups.py").write_text(
        '"""Task groups for asyncio structured concurrency."""\n\nclass TaskGroup:\n    """TaskGroup cancels sibling tasks on error."""\n    async def __aenter__(self) -> "TaskGroup":\n        return self\n',
        encoding="utf-8",
    )
    (source / "Lib" / "concurrent" / "interpreters.py").write_text(
        '"""PEP 734 subinterpreters support isolated execution."""\n\ndef create():\n    """Create a subinterpreter."""\n    return object()\n',
        encoding="utf-8",
    )
    (source / "Lib" / "string" / "templatelib.py").write_text(
        '"""PEP 750 template strings."""\n\nclass Template:\n    """A t-string template."""\n    pass\n',
        encoding="utf-8",
    )
    (source / "Doc" / "library.rst").write_text("Python 3.14 library docs mention free-threading.", encoding="utf-8")
    (source / "peps" / "pep-0703.rst").write_text("PEP 703\n=======\n\nMaking the Global Interpreter Lock optional.", encoding="utf-8")
    (source / "peps" / "pep-0649.rst").write_text("PEP 649\n=======\n\nDeferred evaluation of annotations.", encoding="utf-8")
    (source / "packaging.python.org" / "source" / "pyproject.rst").write_text("Use pyproject.toml for project metadata.", encoding="utf-8")
    (source / "uv" / "docs" / "concepts.md").write_text("Use uv add and uv run pytest for fast Python environments.", encoding="utf-8")
    (source / "pixi" / "docs" / "index.md").write_text("Pixi manages cross-language environments.", encoding="utf-8")
    (source / "typeshed" / "stdlib" / "zlib.pyi").write_text("def compress(data: bytes) -> bytes: ...\n", encoding="utf-8")

    class FakeEmbedClient:
        def __init__(self, **_kwargs):
            pass

        def embed_texts(self, texts):
            return [[0.0] * EMBEDDING_DIM for _ in texts]

    monkeypatch.setattr(language_pack, "EmbedClient", FakeEmbedClient)
    out = tmp_path / "python.synpack"
    result = build_language_pack(
        language="python",
        output_path=out,
        source_dir=source,
        latest_tag="v3.14.4",
        skip_enrichment=True,
        max_chunks=100,
    )
    assert result["ok"] is True
    manifest = validate_synpack(out)
    assert manifest["source_version"] == "v3.14.4"
    assert manifest["enrichment"]["prompt_id"] == "python_314_agentic_architect_v1"
    assert "python_repo_architect_v1" in manifest["enrichment"]["prompt_hashes"]
    with zipfile.ZipFile(out) as zf:
        rows = [json.loads(line) for line in zf.read("metadata.jsonl").decode().splitlines()]
    assert any(row["artifact_kind"] == "pep" and row["symbol_fqn"] == "PEP-0703" for row in rows)
    assert any(row["artifact_kind"] == "type_stub" for row in rows)
    assert any(row["artifact_kind"] == "tool_docs" and "uv" in row["scope_tags"] for row in rows)
    assert any(row["artifact_kind"] == "repo_map" for row in rows)
    assert any(row["artifact_kind"] == "repo_map" and row["symbol_kind"] == "project_config" for row in rows)
    assert any("subinterpreters" in row["scope_tags"] for row in rows)
    map_row = next(row for row in rows if row["artifact_kind"] == "repo_map" and row["symbol_kind"] == "module")
    assert "center_of_gravity" in json.loads(map_row["agent_enrichment_json"])


def test_build_language_pack_from_godot_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source = tmp_path / "godot-src"
    (source / "doc" / "classes").mkdir(parents=True)
    (source / "servers" / "rendering").mkdir(parents=True)
    (source / "godot-docs" / "tutorials" / "scripting").mkdir(parents=True)
    (source / "godot-docs" / "concepts").mkdir(parents=True)
    (source / "godot-proposals").mkdir(parents=True)
    (source / "doc" / "classes" / "Button.xml").write_text(
        """
<class name="Button" inherits="BaseButton">
  <brief_description>Clickable UI button.</brief_description>
  <description>Emits pressed when activated in the scene tree.</description>
  <methods>
    <method name="set_text">
      <return type="void" />
      <param index="0" name="text" type="String" />
      <description>Sets label text.</description>
    </method>
  </methods>
  <members>
    <member name="text" type="String">Button label.</member>
  </members>
  <signals>
    <signal name="pressed">
      <description>Emitted when the button is pressed.</description>
    </signal>
  </signals>
  <constants>
    <constant name="ALIGN_CENTER" value="1">Center alignment.</constant>
  </constants>
</class>
""",
        encoding="utf-8",
    )
    (source / "doc" / "classes" / "Area2D.xml").write_text(
        """
<class name="Area2D" inherits="CollisionObject2D">
  <brief_description>2D detection and physics area.</brief_description>
  <description>Detects bodies in the physics step.</description>
  <signals>
    <signal name="body_entered">
      <param index="0" name="body" type="Node2D" />
      <description>Emitted when a physics body enters.</description>
    </signal>
  </signals>
</class>
""",
        encoding="utf-8",
    )
    (source / "godot-docs" / "tutorials" / "scripting" / "signals.rst").write_text(
        "Signals decouple nodes in the scene tree. Connect pressed in _ready and await signals in Godot 4.",
        encoding="utf-8",
    )
    (source / "godot-docs" / "concepts" / "scene_tree.rst").write_text(
        "The scene tree calls _enter_tree before _ready and _process every frame.",
        encoding="utf-8",
    )
    (source / "godot-proposals" / "0001-godot-4-change.md").write_text(
        "# Godot 4 migration\n\nAvoid legacy Godot 3.x node and signal patterns.",
        encoding="utf-8",
    )
    (source / "servers" / "rendering" / "shader_language.cpp").write_text(
        "// Godot shader language parser for rendering server materials.\nvoid parse_shader() {}\n",
        encoding="utf-8",
    )

    class FakeEmbedClient:
        def __init__(self, **_kwargs):
            pass

        def embed_texts(self, texts):
            return [[0.0] * EMBEDDING_DIM for _ in texts]

    monkeypatch.setattr(language_pack, "EmbedClient", FakeEmbedClient)
    out = tmp_path / "godot.synpack"
    result = build_language_pack(
        language="godot",
        output_path=out,
        source_dir=source,
        latest_tag="4.4-stable",
        skip_enrichment=True,
        max_chunks=100,
    )
    assert result["ok"] is True
    manifest = validate_synpack(out)
    assert manifest["source_version"] == "4.4-stable"
    assert manifest["enrichment"]["prompt_id"] == "godot_4_engine_architect_v1"
    assert "godot_class_reference_architect_v1" in manifest["enrichment"]["prompt_hashes"]
    with zipfile.ZipFile(out) as zf:
        rows = [json.loads(line) for line in zf.read("metadata.jsonl").decode().splitlines()]
    assert any(row["artifact_kind"] == "class_reference" and row["symbol_kind"] == "class" for row in rows)
    assert any(row["artifact_kind"] == "class_reference" and row["symbol_kind"] == "signal" and row["symbol_fqn"] == "Button.pressed" for row in rows)
    assert any(row["artifact_kind"] == "engine_manual" for row in rows)
    assert any(row["artifact_kind"] == "engine_proposal" for row in rows)
    assert any(row["artifact_kind"] == "shader_language" for row in rows)
    assert any("signals" in row["scope_tags"] for row in rows)
    signal_row = next(row for row in rows if row["symbol_fqn"] == "Button.pressed")
    assert json.loads(signal_row["agent_enrichment_json"])["signal_contract"] == "unknown"
    class_row = next(row for row in rows if row["symbol_fqn"] == "Button")
    assert json.loads(class_row["agent_enrichment_json"])["signal_list"] == ["pressed()"]


def test_build_language_pack_from_terraform_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source = tmp_path / "terraform-src"
    (source / "website" / "docs").mkdir(parents=True)
    (source / "provider-schemas").mkdir(parents=True)
    (source / "terraform-provider-aws" / "docs" / "resources").mkdir(parents=True)
    (source / "terraform-provider-azurerm" / "website" / "docs" / "resources").mkdir(parents=True)
    (source / "terraform-provider-google" / "website" / "docs" / "resources").mkdir(parents=True)
    (source / "opentofu" / "website" / "docs").mkdir(parents=True)
    (source / "tflint-ruleset-aws" / "docs").mkdir(parents=True)
    (source / "tflint-ruleset-azurerm" / "docs").mkdir(parents=True)
    (source / "tflint-ruleset-google" / "docs").mkdir(parents=True)
    (source / "website" / "docs" / "state.md").write_text(
        "# Terraform State\n\nState tracks resources and drift. Use plan before apply.",
        encoding="utf-8",
    )
    (source / "terraform-provider-aws" / "docs" / "resources" / "db_instance.md").write_text(
        "# aws_db_instance\n\nChanging identifier can force replacement. Import uses DB identifier.",
        encoding="utf-8",
    )
    (source / "terraform-provider-azurerm" / "website" / "docs" / "resources" / "resource_group.md").write_text(
        "# azurerm_resource_group\n\nResource groups contain Azure resources.",
        encoding="utf-8",
    )
    (source / "terraform-provider-google" / "website" / "docs" / "resources" / "compute_instance.md").write_text(
        "# google_compute_instance\n\nCompute instances may be recreated for boot disk changes.",
        encoding="utf-8",
    )
    (source / "opentofu" / "website" / "docs" / "state-encryption.md").write_text(
        "# State Encryption\n\nOpenTofu can encrypt state and supports early variable evaluation.",
        encoding="utf-8",
    )
    (source / "tflint-ruleset-aws" / "docs" / "aws_instance_invalid_type.md").write_text(
        "# aws_instance_invalid_type\n\nFlags invalid EC2 instance types.",
        encoding="utf-8",
    )
    (source / "tflint-ruleset-azurerm" / "docs" / "azurerm_resource_group_invalid_name.md").write_text(
        "# azurerm_resource_group_invalid_name\n\nFlags invalid resource group names.",
        encoding="utf-8",
    )
    (source / "tflint-ruleset-google" / "docs" / "google_project_iam_member_invalid_member.md").write_text(
        "# google_project_iam_member_invalid_member\n\nFlags invalid IAM members.",
        encoding="utf-8",
    )
    schema = {
        "provider_schemas": {
            "registry.terraform.io/hashicorp/aws": {
                "resource_schemas": {
                    "aws_db_instance": {
                        "version": 1,
                        "block": {
                            "attributes": {
                                "identifier": {"type": "string", "optional": True},
                                "engine": {"type": "string", "required": True},
                                "password": {"type": "string", "optional": True, "sensitive": True},
                                "arn": {"type": "string", "computed": True},
                            },
                            "block_types": {"timeouts": {"nesting_mode": "single"}},
                        },
                    }
                },
                "data_source_schemas": {
                    "aws_ami": {
                        "version": 0,
                        "block": {"attributes": {"owners": {"type": ["list", "string"], "required": True}}},
                    }
                },
            },
            "registry.terraform.io/hashicorp/azurerm": {
                "resource_schemas": {
                    "azurerm_resource_group": {
                        "block": {"attributes": {"name": {"type": "string", "required": True}, "location": {"type": "string", "required": True}}},
                    }
                }
            },
            "registry.terraform.io/hashicorp/google": {
                "resource_schemas": {
                    "google_compute_instance": {
                        "block": {"attributes": {"name": {"type": "string", "required": True}, "machine_type": {"type": "string", "required": True}}},
                    }
                }
            },
        }
    }
    (source / "provider-schemas" / "providers.json").write_text(json.dumps(schema), encoding="utf-8")

    class FakeEmbedClient:
        def __init__(self, **_kwargs):
            pass

        def embed_texts(self, texts):
            return [[0.0] * EMBEDDING_DIM for _ in texts]

    monkeypatch.setattr(language_pack, "EmbedClient", FakeEmbedClient)
    out = tmp_path / "terraform.synpack"
    result = build_language_pack(
        language="terraform",
        output_path=out,
        source_dir=source,
        latest_tag="v1.11.2",
        skip_enrichment=True,
        max_chunks=100,
    )
    assert result["ok"] is True
    manifest = validate_synpack(out)
    assert manifest["source_version"] == "v1.11.2"
    assert manifest["enrichment"]["prompt_id"] == "terraform_infrastructure_architect_v1"
    assert "terraform_provider_schema_architect_v1" in manifest["enrichment"]["prompt_hashes"]
    with zipfile.ZipFile(out) as zf:
        rows = [json.loads(line) for line in zf.read("metadata.jsonl").decode().splitlines()]
    assert any(row["artifact_kind"] == "provider_schema" and row["symbol_fqn"] == "aws_db_instance" for row in rows)
    assert any(row["artifact_kind"] == "provider_docs" and row["symbol_fqn"] == "db_instance" for row in rows)
    assert any(row["artifact_kind"] == "opentofu_feature" for row in rows)
    assert any(row["artifact_kind"] == "iac_policy_rule" for row in rows)
    assert any("sensitive-state" in row["scope_tags"] for row in rows)
    schema_row = next(row for row in rows if row["artifact_kind"] == "provider_schema" and row["symbol_fqn"] == "aws_db_instance")
    enrichment = json.loads(schema_row["agent_enrichment_json"])
    assert enrichment["approval_policy"].startswith("Require human approval")
