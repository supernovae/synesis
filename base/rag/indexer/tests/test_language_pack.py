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
    enrich_staged_language_pack,
    fallback_enrichment,
    finalize_staged_language_pack,
    latest_go_stable_tag_from_refs,
    latest_godot_stable_tag_from_refs,
    latest_python_stable_tag_from_refs,
    latest_quarkus_stable_tag_from_refs,
    latest_rust_stable_tag_from_refs,
    latest_terraform_stable_tag_from_refs,
    parse_enrichment_response,
    parse_go_stable_tag,
    parse_godot_stable_tag,
    parse_python_stable_tag,
    parse_quarkus_stable_tag,
    parse_rust_stable_tag,
    parse_terraform_stable_tag,
    prepare_staged_language_pack,
)
from app.schema import EMBEDDING_DIM, SCHEMA_VERSION
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


def test_deepseek_enrichment_payload_uses_v4_max_thinking_and_usage(monkeypatch: pytest.MonkeyPatch):
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "agent_hook": "Use for streaming HTTP APIs.",
                                    "perf_tier": "io-bound",
                                    "safety_contract": "Close response bodies.",
                                    "lifecycle_model": "Create client, issue request, close body.",
                                }
                            )
                        }
                    }
                ],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 25,
                    "total_tokens": 125,
                    "prompt_cache_hit_tokens": 80,
                    "prompt_cache_miss_tokens": 20,
                },
            }

    class FakeClient:
        def __init__(self, timeout):
            captured["timeout"] = timeout

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, url, *, headers, json):
            captured["url"] = url
            captured["headers"] = headers
            captured["payload"] = json
            return FakeResponse()

    monkeypatch.delenv("SYNESIS_INDEXER_ENRICHMENT_API_KEY", raising=False)
    monkeypatch.delenv("SYNESIS_INDEXER_ENRICHMENT_TOKEN", raising=False)
    monkeypatch.setenv("DEEPSEEK_TOKEN", "secret")
    monkeypatch.setattr(language_pack.httpx, "Client", FakeClient)
    client = language_pack.OpenAICompatibleEnrichmentClient(
        base_url="https://api.deepseek.com",
        prompt_templates={"p": "Inspect this chunk:\n{{DOC_CHUNK}}"},
        default_prompt_id="p",
    )
    chunk = language_pack.LanguageChunk(text="func ReadAll()", doc_id="d", chunk_index=0, document_name="doc")

    enrichment = client.enrich(chunk)

    assert captured["url"] == "https://api.deepseek.com/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer secret"
    assert captured["headers"]["X-DeepSeek-Think-Mode"] == "Max"
    assert captured["payload"]["model"] == "deepseek-v4-pro"
    assert captured["payload"]["max_tokens"] == 8192
    assert captured["payload"]["reasoning_effort"] == "max"
    assert captured["payload"]["thinking"] == {"type": "enabled"}
    assert captured["payload"]["response_format"] == {"type": "json_object"}
    assert "principal software architect" in captured["payload"]["messages"][0]["content"]
    assert enrichment["_enrichment_usage"]["prompt_cache_hit_tokens"] == 80


def test_enrichment_prompt_and_embedding_input_preserve_identifier_anchors():
    client = language_pack.OpenAICompatibleEnrichmentClient(
        base_url="https://example.test",
        provider="openai-compatible",
        prompt_templates={"p": "Inspect this chunk:\n{{DOC_CHUNK}}"},
        default_prompt_id="p",
    )
    chunk = language_pack.LanguageChunk(
        text="func (srv *Server) Shutdown(ctx context.Context) error",
        doc_id="go:src/net/http/server.go:Shutdown",
        chunk_index=0,
        document_name="src/net/http/server.go",
        package_name="net/http",
        symbol_kind="method",
        symbol_name="Shutdown",
        symbol_fqn="net/http.Server.Shutdown",
        module_path="src/net/http/server.go",
        artifact_kind="code",
    )

    _prompt_id, prompt = client.render_prompt(chunk)
    embed_text = language_pack._embedding_input(
        chunk,
        {
            "agent_hook": "net/http.Server.Shutdown gracefully shuts down HTTP servers.",
            "query_aliases": ["http graceful shutdown", "Server Shutdown context cancellation"],
            "agent_query_hints": ["net/http Server shutdown"],
        },
    )

    assert "Chunk identity metadata" in prompt
    assert "net/http.Server.Shutdown" in prompt
    assert "Do not optimize for tiny output" in prompt
    assert "IDENTIFIERS: net/http.Server.Shutdown" in embed_text
    assert "http graceful shutdown" in embed_text
    assert "AGENT_HOOK: net/http.Server.Shutdown" in embed_text


def test_openai_compatible_enrichment_uses_custom_url_token_and_standard_payload(monkeypatch: pytest.MonkeyPatch):
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "agent_hook": "Use for portable provider calls.",
                                    "perf_tier": "io-bound",
                                    "safety_contract": "Check provider rate limits.",
                                    "lifecycle_model": "Create request, parse response.",
                                }
                            )
                        }
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25},
            }

    class FakeClient:
        def __init__(self, timeout):
            captured["timeout"] = timeout

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, url, *, headers, json):
            captured["url"] = url
            captured["headers"] = headers
            captured["payload"] = json
            return FakeResponse()

    monkeypatch.setattr(language_pack.httpx, "Client", FakeClient)
    client = language_pack.OpenAICompatibleEnrichmentClient(
        base_url="https://third-party.example/v1",
        model="deepseek/deepseek-v3.2",
        provider="openai-compatible",
        api_key="custom-secret",
        max_tokens=2048,
        prompt_templates={"p": "Inspect this chunk:\n{{DOC_CHUNK}}"},
        default_prompt_id="p",
    )
    chunk = language_pack.LanguageChunk(text="func ReadAll()", doc_id="d", chunk_index=0, document_name="doc")

    enrichment = client.enrich(chunk)

    assert captured["url"] == "https://third-party.example/v1/chat/completions"
    assert captured["headers"] == {"Authorization": "Bearer custom-secret"}
    assert captured["payload"]["model"] == "deepseek/deepseek-v3.2"
    assert captured["payload"]["max_tokens"] == 2048
    assert "reasoning_effort" not in captured["payload"]
    assert "thinking" not in captured["payload"]
    assert enrichment["_enrichment_usage"]["prompt_tokens"] == 20


def test_enrichment_token_budget_estimate_uses_max_thinking_budget():
    chunk = language_pack.LanguageChunk(text="resource example", doc_id="d", chunk_index=0, document_name="doc")
    estimate = language_pack.estimate_enrichment_token_budget(
        [chunk],
        prompt_templates={"p": "Analyze:\n{{DOC_CHUNK}}"},
        default_prompt_id="p",
        enrichment_model="deepseek-v4-pro",
        max_tokens=4096,
        input_price_per_mtok=0.1,
        output_price_per_mtok=1.0,
    )

    assert estimate["model"] == "deepseek-v4-pro"
    assert estimate["max_tokens_per_request"] == 8192
    assert estimate["thinking_effort"] == "max"
    assert estimate["thinking_budget_tokens"] == 8192
    assert estimate["thinking_budget_tokens_worst_case"] == 8192
    assert estimate["chunk_text_tokens_estimate"] > 0
    assert estimate["prompt_tokens_per_request_max"] >= estimate["prompt_tokens_per_request_min"]
    assert estimate["worst_case_total_tokens"] >= estimate["prompt_tokens_estimate"]
    assert estimate["note"].startswith("Completion and thinking values are worst-case")
    assert estimate["estimated_uncached_usd"] is not None


def test_openai_compatible_estimate_honors_max_tokens_without_thinking_budget():
    chunk = language_pack.LanguageChunk(text="resource example", doc_id="d", chunk_index=0, document_name="doc")
    estimate = language_pack.estimate_enrichment_token_budget(
        [chunk],
        prompt_templates={"p": "Analyze:\n{{DOC_CHUNK}}"},
        default_prompt_id="p",
        enrichment_model="deepseek/deepseek-v3.2",
        enrichment_provider="openai-compatible",
        max_tokens=4096,
    )

    assert estimate["provider"] == "openai-compatible"
    assert estimate["max_tokens_per_request"] == 4096
    assert estimate["thinking_budget_tokens"] == 0
    assert estimate["thinking_mode"] == "disabled"


def test_doc_chunks_include_provider_markdown_and_mdx(tmp_path: Path):
    docs = tmp_path / "website" / "docs" / "r"
    docs.mkdir(parents=True)
    (docs / "aws_instance.html.markdown").write_text("# aws_instance\n\nResource docs.", encoding="utf-8")
    (docs / "azurerm_linux_virtual_machine.mdx").write_text(
        "# azurerm_linux_virtual_machine\n\nMDX docs.", encoding="utf-8"
    )

    chunks = language_pack._doc_chunks(
        tmp_path,
        ["website/docs"],
        language="terraform",
        repo="github.com/hashicorp/terraform-provider-aws",
        tag="main",
        package_name="registry.terraform.io/hashicorp/aws",
        artifact_kind="provider_docs",
    )

    names = {chunk.document_name for chunk in chunks}
    assert "website/docs/r/aws_instance.html.markdown" in names
    assert "website/docs/r/azurerm_linux_virtual_machine.mdx" in names


def test_non_english_doc_language_requires_pack_config_opt_in(tmp_path: Path):
    with pytest.raises(SynPackError, match="not supported"):
        build_language_pack(
            language="go",
            output_path=tmp_path / "go.synpack",
            source_dir=tmp_path,
            latest_tag="go1.26.2",
            doc_language="ja",
            skip_enrichment=True,
        )


def test_non_english_doc_language_requires_pack_id_suffix(tmp_path: Path):
    config = tmp_path / "go-ja.yaml"
    config.write_text(
        "\n".join(
            [
                "language: go",
                "domain: go",
                "pack_id: go-latest",
                "doc_language: ja",
                "supported_doc_languages:",
                "  - en",
                "  - ja",
                "prompt_id: go_agentic_architect_v1",
                "prompt_path: prompts/go_agentic_architect_v1.md",
            ]
        ),
        encoding="utf-8",
    )
    with pytest.raises(SynPackError, match="must end with '-ja'"):
        build_language_pack(
            language="go",
            output_path=tmp_path / "go.synpack",
            pack_config=config,
            source_dir=tmp_path,
            latest_tag="go1.26.2",
            doc_language="ja",
            skip_enrichment=True,
        )


def test_language_pack_preparation_normalizes_html_and_keeps_quality_metadata():
    chunk = language_pack.LanguageChunk(
        text=(
            "<html><body><nav>Menu</nav><main><h1>Install</h1><p>Use the official installer "
            "for this runtime. The installer configures the command line tools, standard "
            "library documentation, and local environment paths for development workflows.</p></main></body></html>"
        ),
        doc_id="python:docs:install.html",
        chunk_index=0,
        document_name="install.html",
        heading_path="Install",
        section="Install",
        content_format="html",
    )
    prepared, report = language_pack.prepare_language_chunks_for_enrichment([chunk])

    assert report["extracted"] == 1
    assert report["quality_rejected"] == 0
    assert len(prepared) == 1
    assert prepared[0].content_format in {"markdown", "text"}
    assert "official installer" in prepared[0].text
    assert "<html" not in prepared[0].text.lower()
    assert prepared[0].metadata["original_content_format"] == "html"
    assert prepared[0].metadata["source_quality_status"] in {"clean", "warn"}


def test_language_pack_preparation_preserves_structured_chunks():
    chunk = language_pack.LanguageChunk(
        text='{"module": "asyncio", "intent": "event loop primitives"}',
        doc_id="python:repo-map",
        chunk_index=0,
        document_name="repo-map.json",
        artifact_kind="repo_map",
        content_format="json",
    )
    prepared, report = language_pack.prepare_language_chunks_for_enrichment([chunk])

    assert report["quality_rejected"] == 0
    assert len(prepared) == 1
    assert prepared[0].content_format == "json"
    assert prepared[0].text == chunk.text
    assert prepared[0].metadata["source_quality_status"] in {"clean", "warn"}


def test_language_pack_preparation_rejects_junk_before_enrichment():
    chunk = language_pack.LanguageChunk(
        text="Home Search Contact us Subscribe Back to top",
        doc_id="python:docs:junk",
        chunk_index=0,
        document_name="junk.md",
        content_format="markdown",
    )
    prepared, report = language_pack.prepare_language_chunks_for_enrichment([chunk])

    assert prepared == []
    assert report["quality_rejected"] == 1
    assert report["rejected_reasons"]


def test_source_quality_is_attached_to_fallback_enrichment():
    chunk = language_pack.LanguageChunk(
        text="def f():\n    return 1",
        doc_id="python:module",
        chunk_index=0,
        document_name="mod.py",
        content_format="py",
        metadata={
            "source_quality_status": "warn",
            "source_quality_score": 0.0,
            "source_quality_reason": "thin+empty",
            "original_content_format": "py",
            "normalized_content_format": "py",
        },
    )
    enrichment = language_pack.enrich_language_chunks(
        [chunk],
        prompt_templates={"python_314_agentic_architect_v1": "{{DOC_CHUNK}}"},
        default_prompt_id="python_314_agentic_architect_v1",
        skip=True,
    )[0]

    assert enrichment["source_quality"]["source_quality_status"] == "warn"
    assert "thin+empty" in enrichment["hidden_warnings"]


def test_zero_quality_chunks_use_fallback_without_llm_call(monkeypatch: pytest.MonkeyPatch):
    class ExplodingClient:
        def __init__(self, timeout):
            del timeout

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, *_args, **_kwargs):
            raise AssertionError("zero-quality chunk should not call enrichment endpoint")

    monkeypatch.setattr(language_pack.httpx, "Client", ExplodingClient)
    chunk = language_pack.LanguageChunk(
        text="func Syscall(uintptr, uintptr, uintptr, uintptr) (uintptr, uintptr, Errno)",
        doc_id="go:api",
        chunk_index=0,
        document_name="api/go1.txt",
        metadata={
            "source_quality_status": "warn",
            "source_quality_score": 0.0,
            "source_quality_reason": "thin+short: 8 words, no rescue signals",
        },
    )

    enrichment = language_pack.enrich_language_chunks(
        [chunk],
        prompt_templates={"go_agentic_architect_v1": "{{DOC_CHUNK}}"},
        default_prompt_id="go_agentic_architect_v1",
        enrichment_url="https://provider.example/v1",
    )[0]

    assert enrichment["enrichment_status"] == "fallback"
    assert "source_quality_score=0.0" in enrichment["enrichment_error"]
    assert enrichment["source_quality"]["source_quality_score"] == 0.0


def test_staged_zero_quality_chunks_complete_without_llm_call(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    class ExplodingClient:
        def __init__(self, timeout):
            del timeout

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, *_args, **_kwargs):
            raise AssertionError("zero-quality chunk should not call enrichment endpoint")

    monkeypatch.setattr(language_pack.httpx, "Client", ExplodingClient)
    work = tmp_path / "go-work"
    work.mkdir()
    (work / "run_manifest.json").write_text(
        json.dumps(
            {
                "pack_id": "go-latest",
                "enrichment": {
                    "model": "deepseek-v4-pro",
                    "provider": "deepseek",
                    "prompt_id": "go_agentic_architect_v1",
                    "prompt_hashes": {"go_agentic_architect_v1": "x"},
                },
            }
        ),
        encoding="utf-8",
    )
    chunk = language_pack.LanguageChunk(
        text="func Syscall(uintptr, uintptr, uintptr, uintptr) (uintptr, uintptr, Errno)",
        doc_id="go:api",
        chunk_index=0,
        document_name="api/go1.txt",
        metadata={
            "source_quality_status": "warn",
            "source_quality_score": 0.0,
            "source_quality_reason": "thin+short: 8 words, no rescue signals",
        },
    )
    (work / "chunks.jsonl").write_text(json.dumps(language_pack._chunk_record("go-latest", chunk)) + "\n")

    result = enrich_staged_language_pack(work_dir=work, enrichment_url="https://provider.example/v1")

    completed = (work / "enrichments" / "completed.jsonl").read_text(encoding="utf-8").strip()
    completed_record = json.loads(completed)
    assert result["completed"] == 1
    assert completed_record["skipped"] is True
    assert completed_record["skip_reason"] == "zero_quality_source"
    assert completed_record["enrichment"]["enrichment_status"] == "fallback"


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
        text='@Command(name = "dev")',
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


def test_ecma_fallback_preserves_runtime_and_temporal_contracts():
    chunk = language_pack.LanguageChunk(
        text="Temporal.PlainDate avoids Date timezone shifts.",
        doc_id="ecma:tc39/proposals:proposal-temporal/README.md:Temporal.PlainDate",
        chunk_index=0,
        document_name="proposal-temporal/README.md",
        package_name="tc39",
        symbol_kind="temporal_api",
        symbol_fqn="Temporal.PlainDate",
        artifact_kind="temporal_api",
    )
    enrichment = fallback_enrichment(chunk, error="skipped")
    assert enrichment["temporal_type"] == "Temporal.PlainDate"
    assert enrichment["runtime_compatibility"] == []
    assert enrichment["legacy_date_replacement"] == "unknown"
    assert "skipped" in enrichment["hidden_warnings"]


def test_build_language_pack_from_go_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source = tmp_path / "go-src"
    (source / "doc").mkdir(parents=True)
    (source / "api").mkdir()
    (source / "src" / "fmt").mkdir(parents=True)
    (source / "src" / "net" / "http").mkdir(parents=True)
    (source / "doc" / "go_spec.html").write_text("# Go Spec\n\nThe Go programming language.", encoding="utf-8")
    (source / "api" / "go1.1.txt").write_text("pkg fmt, func Println(...any) (int, error)", encoding="utf-8")
    (source / "README.md").write_text("# Go", encoding="utf-8")
    (source / "src" / "fmt" / "doc.go").write_text(
        "// Package fmt implements formatted I/O.\npackage fmt\n", encoding="utf-8"
    )
    (source / "src" / "fmt" / "print.go").write_text(
        "package fmt\n\n// Println formats using default formats.\nfunc Println(a ...any) (n int, err error) { return 0, nil }\n",
        encoding="utf-8",
    )
    (source / "src" / "net" / "http" / "doc.go").write_text(
        "// Package http provides HTTP client and server implementations.\npackage http\n", encoding="utf-8"
    )
    (source / "src" / "net" / "http" / "server.go").write_text(
        "package http\n\n// Handler responds to an HTTP request.\ntype Handler interface { ServeHTTP(ResponseWriter, *Request) }\n",
        encoding="utf-8",
    )

    captured_embedder_kwargs = {}

    class FakeEmbedClient:
        def __init__(self, **kwargs):
            captured_embedder_kwargs.update(kwargs)

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
    assert manifest["schema_version"] == SCHEMA_VERSION
    with zipfile.ZipFile(out) as zf:
        assert "edges.jsonl" in zf.namelist()
        assert "nodes/chunks.jsonl" in zf.namelist()
        assert "nodes/documents.jsonl" in zf.namelist()
        assert "nodes/packages.jsonl" in zf.namelist()
        assert "nodes/modules.jsonl" in zf.namelist()
        assert "nodes/symbols.jsonl" in zf.namelist()
        assert "nodes/external_refs.jsonl" in zf.namelist()
        assert "vectors/chunks.f32" in zf.namelist()
        assert "vectors/index.json" in zf.namelist()
        assert "enrichment/enrichment.jsonl" in zf.namelist()
        assert "quality/report.json" in zf.namelist()
    assert manifest["source_version"] == "go1.26.2"
    assert manifest["install_profile"] == "nornicdb-v2-typed-graph"
    assert manifest["node_counts_by_kind"]["Chunk"] == manifest["row_count"]
    assert manifest["dangling_edge_count"] == 0
    assert manifest["doc_language"] == "en"
    assert manifest["supported_doc_languages"] == ["en"]
    assert manifest["enrichment"]["prompt_id"] == "go_agentic_architect_v1"
    assert manifest["enrichment"]["skipped"] is True
    assert manifest["source_quality"]["extracted"] >= manifest["source_quality"]["enrichment_attempted"]
    assert "quality_rejected" in manifest["source_quality"]
    with zipfile.ZipFile(out) as zf:
        rows = [json.loads(line) for line in zf.read("metadata.jsonl").decode().splitlines()]
    assert rows
    assert any(row["package_name"] == "fmt" and row["symbol_kind"] == "function" for row in rows)
    assert all("agent_enrichment_json" in row for row in rows)
    assert all("source_quality" in json.loads(row["agent_enrichment_json"]) for row in rows)
    assert all(json.loads(row["agent_enrichment_json"])["doc_language"] == "en" for row in rows)
    assert all("doc-language:en" in row["tags"] for row in rows)
    assert captured_embedder_kwargs == {"batch_size": 8, "timeout": 300.0}


def test_staged_language_pack_resume_and_finalize(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source = tmp_path / "go-src"
    (source / "doc").mkdir(parents=True)
    (source / "api").mkdir()
    (source / "src" / "fmt").mkdir(parents=True)
    (source / "doc" / "go_spec.html").write_text("# Go Spec\n\nThe Go programming language.", encoding="utf-8")
    (source / "api" / "go1.1.txt").write_text("pkg fmt, func Println(...any) (int, error)", encoding="utf-8")
    (source / "src" / "fmt" / "doc.go").write_text(
        "// Package fmt implements formatted I/O.\npackage fmt\n", encoding="utf-8"
    )
    (source / "src" / "fmt" / "print.go").write_text(
        "package fmt\n\n// Println formats using default formats.\nfunc Println(a ...any) (n int, err error) { return 0, nil }\n",
        encoding="utf-8",
    )

    captured_embedder_kwargs = {}

    class FakeEmbedClient:
        def __init__(self, **kwargs):
            captured_embedder_kwargs.update(kwargs)

        def embed_texts(self, texts):
            return [[0.0] * EMBEDDING_DIM for _ in texts]

    monkeypatch.setattr(language_pack, "EmbedClient", FakeEmbedClient)
    work = tmp_path / "work"
    prepared = prepare_staged_language_pack(
        language="go",
        work_dir=work,
        pack_id="go-latest",
        source_dir=source,
        latest_tag="go1.26.2",
    )
    assert prepared["chunks"] >= 2

    first = enrich_staged_language_pack(work_dir=work, request_limit=1, batch_size=1, skip_enrichment=True)
    second = enrich_staged_language_pack(work_dir=work, request_limit=100, batch_size=1, skip_enrichment=True)

    assert first["submitted"] == 1
    assert second["submitted"] == prepared["chunks"] - 1
    assert second["remaining"] == 0
    completed_lines = (work / "enrichments" / "completed.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(completed_lines) == prepared["chunks"]

    out = tmp_path / "go-staged.synpack"
    finalized = finalize_staged_language_pack(
        work_dir=work,
        output_path=out,
        embedder_url="http://embedder.local/v1",
        embedder_batch_size=3,
        embedder_timeout=123.0,
    )
    assert finalized["ok"] is True
    assert captured_embedder_kwargs == {
        "url": "http://embedder.local/v1",
        "batch_size": 3,
        "timeout": 123.0,
    }
    manifest = validate_synpack(out)
    assert manifest["row_count"] == prepared["chunks"]
    assert manifest["install_profile"] == "nornicdb-v2-typed-graph"
    assert manifest["node_counts_by_kind"]["Chunk"] == prepared["chunks"]
    assert manifest["dangling_edge_count"] == 0
    with zipfile.ZipFile(out) as zf:
        rows = [json.loads(line) for line in zf.read("metadata.jsonl").decode().splitlines()]
        quality = json.loads(zf.read("quality/report.json"))
        assert quality["chunk_count"] == prepared["chunks"]
        assert "nodes/chunks.jsonl" in zf.namelist()
    assert len(rows) == prepared["chunks"]


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
    (source / "nomicon" / "src" / "ffi.md").write_text(
        "# FFI\n\nUnsafe Rust FFI requires layout invariants.", encoding="utf-8"
    )
    (source / "async-book" / "src" / "pinning.md").write_text("# Pinning\n\nFutures may require Pin.", encoding="utf-8")
    (source / "book" / "src" / "ch01.md").write_text(
        "# Rust 2021\n\nCargo projects use edition 2021.", encoding="utf-8"
    )

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
    assert manifest["schema_version"] == SCHEMA_VERSION
    with zipfile.ZipFile(out) as zf:
        assert "edges.jsonl" in zf.namelist()
    assert manifest["source_version"] == "1.88.0"
    assert manifest["enrichment"]["prompt_id"] == "rust_agentic_architect_2024_v1"
    assert "rust_error_debugger_v1" in manifest["enrichment"]["prompt_hashes"]
    assert "rust_cargo_tooling_architect_v1" in manifest["enrichment"]["prompt_hashes"]
    assert "rust_example_architect_v1" in manifest["enrichment"]["prompt_hashes"]
    with zipfile.ZipFile(out) as zf:
        rows = [json.loads(line) for line in zf.read("metadata.jsonl").decode().splitlines()]
    assert any(row["language"] == "rust" and row["symbol_kind"] == "struct" for row in rows)
    assert any(row["symbol_fqn"] == "std::String" for row in rows)
    assert any(row["artifact_kind"] == "compiler_error" and row["symbol_fqn"] == "E0716" for row in rows)
    assert any("edition-2024" in row["scope_tags"] for row in rows)
    error_row = next(row for row in rows if row["symbol_fqn"] == "E0716")
    assert json.loads(error_row["agent_enrichment_json"])["error_context"] == "E0716"


def test_build_language_pack_from_quarkus_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source = tmp_path / "quarkus-src"
    (source / "docs" / "src" / "main" / "asciidoc").mkdir(parents=True)
    (
        source / "extensions" / "datasource" / "runtime" / "src" / "main" / "java" / "io" / "quarkus" / "datasource"
    ).mkdir(parents=True)
    (source / "core" / "runtime" / "src" / "main" / "java" / "io" / "quarkus" / "runtime").mkdir(parents=True)
    (source / "devtools" / "cli" / "src" / "main" / "java" / "io" / "quarkus" / "cli").mkdir(parents=True)
    (source / "quarkus-platform").mkdir()
    (source / "docs" / "src" / "main" / "asciidoc" / "cli-tooling.adoc").write_text(
        "= Quarkus CLI\n\nThe quarkus dev command starts dev mode with hot reload and Dev Services.",
        encoding="utf-8",
    )
    (
        source
        / "extensions"
        / "datasource"
        / "runtime"
        / "src"
        / "main"
        / "java"
        / "io"
        / "quarkus"
        / "datasource"
        / "DataSourceConfig.java"
    ).write_text(
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
    (
        source / "core" / "runtime" / "src" / "main" / "java" / "io" / "quarkus" / "runtime" / "LaunchMode.java"
    ).write_text(
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
    (source / "peps" / "pep-0703.rst").write_text(
        "PEP 703\n=======\n\nMaking the Global Interpreter Lock optional.", encoding="utf-8"
    )
    (source / "peps" / "pep-0649.rst").write_text(
        "PEP 649\n=======\n\nDeferred evaluation of annotations.", encoding="utf-8"
    )
    (source / "packaging.python.org" / "source" / "pyproject.rst").write_text(
        "Use pyproject.toml for project metadata.", encoding="utf-8"
    )
    (source / "uv" / "docs" / "concepts.md").write_text(
        "Use uv add and uv run pytest for fast Python environments.", encoding="utf-8"
    )
    (source / "pixi" / "docs" / "index.md").write_text("Pixi manages cross-language environments.", encoding="utf-8")
    (source / "typeshed" / "stdlib" / "zlib.pyi").write_text(
        "def compress(data: bytes) -> bytes: ...\n", encoding="utf-8"
    )

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
    (source / "doc" / "classes" / "BaseButton.xml").write_text(
        """
<class name="BaseButton" inherits="Control">
  <brief_description>Base class for button controls.</brief_description>
  <description>Defines shared button behavior for UI controls.</description>
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
        edges = [json.loads(line) for line in zf.read("edges.jsonl").decode().splitlines()]
    assert any(row["artifact_kind"] == "class_reference" and row["symbol_kind"] == "class" for row in rows)
    assert any(
        row["artifact_kind"] == "class_reference"
        and row["symbol_kind"] == "signal"
        and row["symbol_fqn"] == "Button.pressed"
        for row in rows
    )
    assert any(row["artifact_kind"] == "engine_manual" for row in rows)
    assert any(row["artifact_kind"] == "engine_proposal" for row in rows)
    assert any(row["artifact_kind"] == "shader_language" for row in rows)
    assert any("signals" in row["scope_tags"] for row in rows)
    signal_row = next(row for row in rows if row["symbol_fqn"] == "Button.pressed")
    signal_json = json.loads(signal_row["agent_enrichment_json"])
    assert signal_json["signal_contract"] == "unknown"
    assert signal_json["member_of"] == "Button"
    assert signal_json["signal_name"] == "pressed"
    assert signal_json["signal_args"] == []
    class_row = next(row for row in rows if row["symbol_fqn"] == "Button")
    class_json = json.loads(class_row["agent_enrichment_json"])
    assert class_json["signal_list"] == ["pressed()"]
    assert class_json["node_class"] == "Button"
    assert class_json["inherits"] == "BaseButton"
    assert class_json["engine_major_version"] == "4"
    assert class_row["contains_refs"] == "Button.set_text,Button.pressed,Button.text,Button.ALIGN_CENTER"
    assert class_row["implements_refs"] == "BaseButton"
    manual_row = next(
        row for row in rows if row["artifact_kind"] == "engine_manual" and "signals.rst" in row["module_path"]
    )
    manual_json = json.loads(manual_row["agent_enrichment_json"])
    assert manual_json["lifecycle_callbacks"] == ["_ready"]
    assert "Button.pressed" in manual_row["doc_relation_ids"]
    proposal_row = next(row for row in rows if row["artifact_kind"] == "engine_proposal")
    proposal_json = json.loads(proposal_row["agent_enrichment_json"])
    assert "godot-3-to-4" in proposal_json["migration_topics"]
    assert any(
        edge["type"] == "IMPLEMENTS" and edge["source_id"] == "Button" and edge["target_id"] == "BaseButton"
        for edge in edges
    )
    assert any(
        edge["type"] == "CONTAINS" and edge["source_id"] == "Button" and edge["target_id"] == "Button.pressed"
        for edge in edges
    )
    assert any(
        edge["type"] == "DOCUMENTS"
        and edge["source_id"] == manual_row["id"]
        and edge["target_id"] == "godot:lifecycle:_ready"
        for edge in edges
    )


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
                        "block": {
                            "attributes": {
                                "name": {"type": "string", "required": True},
                                "location": {"type": "string", "required": True},
                            }
                        },
                    }
                }
            },
            "registry.terraform.io/hashicorp/google": {
                "resource_schemas": {
                    "google_compute_instance": {
                        "block": {
                            "attributes": {
                                "name": {"type": "string", "required": True},
                                "machine_type": {"type": "string", "required": True},
                            }
                        },
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
    schema_row = next(
        row for row in rows if row["artifact_kind"] == "provider_schema" and row["symbol_fqn"] == "aws_db_instance"
    )
    enrichment = json.loads(schema_row["agent_enrichment_json"])
    assert enrichment["approval_policy"].startswith("Require human approval")


def test_build_language_pack_from_ecma_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source = tmp_path / "ecma-src"
    (source / "proposal-temporal").mkdir(parents=True)
    (source / "proposal-array-grouping").mkdir(parents=True)
    (source / "TypeScript-Website" / "packages" / "documentation" / "copy" / "en" / "handbook-v2").mkdir(parents=True)
    (source / "node" / "doc" / "api").mkdir(parents=True)
    (source / "bun" / "docs").mkdir(parents=True)
    (source / "deno" / "runtime").mkdir(parents=True)
    (
        source
        / "mdn-content"
        / "files"
        / "en-us"
        / "web"
        / "javascript"
        / "reference"
        / "global_objects"
        / "temporal"
        / "plaindate"
    ).mkdir(parents=True)
    (source / "README.md").write_text(
        "# TC39 proposals\n\nStage 4 JavaScript features include Temporal, Object.groupBy, and Promise.withResolvers.",
        encoding="utf-8",
    )
    (source / "proposal-temporal" / "README.md").write_text(
        "# Temporal\n\nTemporal.PlainDate is immutable and avoids legacy Date month indexing and timezone shifts. Temporal.ZonedDateTime uses IANA time zones.",
        encoding="utf-8",
    )
    (source / "proposal-array-grouping" / "README.md").write_text(
        "# Object.groupBy\n\nObject.groupBy groups records without Lodash.",
        encoding="utf-8",
    )
    (
        source
        / "TypeScript-Website"
        / "packages"
        / "documentation"
        / "copy"
        / "en"
        / "handbook-v2"
        / "Everyday Types.md"
    ).write_text(
        "# Everyday Types\n\nUse satisfies, strict mode, type-only imports, and erasable syntax for native type stripping.",
        encoding="utf-8",
    )
    (source / "node" / "doc" / "api" / "typescript.md").write_text(
        "# TypeScript in Node\n\nNode 24 supports type stripping for erasable TypeScript syntax. The permission model protects fs and child_process.",
        encoding="utf-8",
    )
    (source / "bun" / "docs" / "typescript.md").write_text(
        "# Bun TypeScript\n\nBun runs TypeScript natively and includes fetch, SQLite, and Web APIs.",
        encoding="utf-8",
    )
    (source / "deno" / "runtime" / "fundamentals.md").write_text(
        "# Deno runtime\n\nDeno runs TypeScript and uses explicit permissions for network and filesystem access.",
        encoding="utf-8",
    )
    (
        source
        / "mdn-content"
        / "files"
        / "en-us"
        / "web"
        / "javascript"
        / "reference"
        / "global_objects"
        / "temporal"
        / "plaindate"
        / "index.md"
    ).write_text(
        "# Temporal.PlainDate\n\nPlainDate represents a calendar date without time or timezone. Use add({ months: 3 }) instead of mutating Date.",
        encoding="utf-8",
    )

    class FakeEmbedClient:
        def __init__(self, **_kwargs):
            pass

        def embed_texts(self, texts):
            return [[0.0] * EMBEDDING_DIM for _ in texts]

    monkeypatch.setattr(language_pack, "EmbedClient", FakeEmbedClient)
    out = tmp_path / "ecma.synpack"
    result = build_language_pack(
        language="ecma",
        output_path=out,
        source_dir=source,
        latest_tag="main",
        skip_enrichment=True,
        max_chunks=100,
    )
    assert result["ok"] is True
    manifest = validate_synpack(out)
    assert manifest["source_version"] == "main"
    assert manifest["enrichment"]["prompt_id"] == "principal_js_ts_architect_2026_v1"
    assert "ecma_temporal_architect_2026_v1" in manifest["enrichment"]["prompt_hashes"]
    assert "typescript_type_safety_architect_v1" in manifest["enrichment"]["prompt_hashes"]
    with zipfile.ZipFile(out) as zf:
        rows = [json.loads(line) for line in zf.read("metadata.jsonl").decode().splitlines()]
    assert any(row["artifact_kind"] == "temporal_api" for row in rows)
    assert any(row["artifact_kind"] == "typescript_handbook" for row in rows)
    assert any(row["artifact_kind"] == "runtime_api" and "node" in row["scope_tags"] for row in rows)
    assert any(row["artifact_kind"] == "web_api" for row in rows)
    assert any("type-stripping" in row["scope_tags"] for row in rows)
    temporal_row = next(row for row in rows if row["artifact_kind"] == "temporal_api")
    enrichment = json.loads(temporal_row["agent_enrichment_json"])
    assert "runtime_compatibility" in enrichment
    assert "legacy_date_replacement" in enrichment
