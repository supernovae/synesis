"""Configurable SynPack language-pack builder.

The pipeline supports curated language packs with language-specific extraction
and enrichment prompts while preserving universal SynPack v2 graph-ready fields.
"""

from __future__ import annotations

import ast
import concurrent.futures
import contextlib
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import defusedxml.ElementTree as ET
import httpx
import yaml

from .code_graph import derive_graph_edges, extract_call_refs, extract_import_refs
from .content_gate import GatePolicy, score_chunk
from .embed_client import EmbedClient
from .injection_scan import scan_chunk_text_detailed
from .language_pack_tags import (
    latest_go_stable_tag_from_refs as latest_go_stable_tag_from_refs,
)
from .language_pack_tags import (
    latest_godot_stable_tag_from_refs as latest_godot_stable_tag_from_refs,
)
from .language_pack_tags import (
    latest_python_stable_tag_from_refs as latest_python_stable_tag_from_refs,
)
from .language_pack_tags import (
    latest_quarkus_stable_tag_from_refs as latest_quarkus_stable_tag_from_refs,
)
from .language_pack_tags import (
    latest_rust_stable_tag_from_refs as latest_rust_stable_tag_from_refs,
)
from .language_pack_tags import (
    latest_terraform_stable_tag_from_refs as latest_terraform_stable_tag_from_refs,
)
from .language_pack_tags import (
    parse_go_stable_tag as parse_go_stable_tag,
)
from .language_pack_tags import (
    parse_godot_stable_tag as parse_godot_stable_tag,
)
from .language_pack_tags import (
    parse_python_stable_tag as parse_python_stable_tag,
)
from .language_pack_tags import (
    parse_quarkus_stable_tag as parse_quarkus_stable_tag,
)
from .language_pack_tags import (
    parse_rust_stable_tag as parse_rust_stable_tag,
)
from .language_pack_tags import (
    parse_terraform_stable_tag as parse_terraform_stable_tag,
)
from .language_pack_tags import (
    resolve_latest_ecma_tag,
    resolve_latest_go_tag,
    resolve_latest_godot_tag,
    resolve_latest_python_tag,
    resolve_latest_quarkus_tag,
    resolve_latest_rust_tag,
    resolve_latest_terraform_tag,
)
from .language_text import basic_source_text_cleanup, normalize_source_text_by_format
from .nornic_writer import chunk_id_hash
from .pipeline import _code_chunk_metrics
from .schema import CORPUS_VERSION, EMBEDDING_DIM, EMBEDDING_PROFILE, SCHEMA_VERSION, catalog_entity
from .synpack import (
    DEFAULT_PACK_MODEL,
    SYNPACK_FORMAT_VERSION,
    SynPackError,
    _sanitize_pack_id,
    _sha256_file,
    materialize_synpack_v2,
)

DEFAULT_ENRICHMENT_MODEL = "deepseek-v4-pro"
DEFAULT_ENRICHMENT_PROVIDER = "deepseek"
DEFAULT_ENRICHMENT_MAX_TOKENS = 8192
DEFAULT_ENRICHMENT_TIMEOUT_SECONDS = 180.0
DEFAULT_ENRICHMENT_CONCURRENCY = 6
MAX_ENRICHMENT_CONCURRENCY = 8
DEFAULT_THINKING_CAP_TOKENS = 8192
DEFAULT_EMBEDDER_BATCH_SIZE = 8
DEFAULT_EMBEDDER_TIMEOUT_SECONDS = 300.0
FRONTIER_ENRICHMENT_SYSTEM_PROMPT = (
    "You are a principal software architect building retrieval enrichment for a portable Synesis SynPack. "
    "Analyze the chunk deeply for agentic retrieval, operational hazards, version constraints, lifecycle, "
    "performance, safety, and human-facing implementation guidance. Ground every field in the provided source. "
    "If the chunk is thin, ambiguous, generated, or noisy, say so in warnings instead of inventing facts. "
    "Return exactly one JSON object matching the requested schema and no surrounding prose. "
    "Prefer structured arrays and dense source-grounded strings that preserve exact names, relationships, "
    "retrieval facets, and MCP/tool guidance for smaller coding models. Do not artificially limit answers to "
    "one sentence when multiple source-grounded clauses make the pack more useful."
)
SYNPACK_V2_ENRICHMENT_APPEND = """

SynPack v2 enrichment requirements:
- Do not optimize for tiny output. Return rich, dense, source-grounded fields
  when the source supports them. Multi-sentence string fields are acceptable.
- Optimize every field for hybrid vector, keyword, and graph retrieval. Prefer
  concrete identifiers over pronouns. Write "net/http.Server.Shutdown shuts down
  listeners with context cancellation", not "this function shuts down listeners".
- Include the exact package/module, type, function, method, class, resource,
  command, error code, property, signal, or proposal name in agent_hook,
  query_aliases, agent_query_hints, task_intents, api_contract, and
  verification_hints whenever the source identifies one.
- Avoid generic phrases such as "this function", "this method", "this class",
  "this resource", "the API", or "this chunk" unless the sentence also names
  the concrete identifier.
- query_aliases and agent_query_hints should include likely user search forms:
  fully-qualified names, short names, package plus symbol, error codes, common
  task wording, and version/runtime qualifiers evidenced by the source.
- Include dense, source-grounded values for these optional fields when evidenced:
  task_intents, query_aliases, agent_query_hints, api_contract, version_scope,
  performance_notes, anti_patterns, hidden_warnings, canonical_examples,
  verification_hints, related_interfaces, related_symbols, agent_actions,
  confidence, evidence_spans, what_to_use, when_to_use, do_not_use,
  minimal_example.
- task_intents, query_aliases, agent_query_hints, anti_patterns,
  hidden_warnings, canonical_examples, verification_hints, related_interfaces,
  related_symbols, agent_actions, and evidence_spans should be JSON arrays.
- canonical_examples and anti_examples may be objects with title, text, code,
  setup, expected_output, test_command, runnable, applies_to, retrieval_terms,
  and query_aliases when the source supports concrete examples.
- what_to_use, when_to_use, do_not_use, and minimal_example should be concise
  context-card text suitable for small coding models and MCP clients.
- api_contract, version_scope, performance_notes, confidence may be strings or objects.
- Use empty arrays or "unknown" when the source does not support a field.
- Do not invent relationships. Put uncertain relationships in related_symbols with confidence and evidence span.
"""
GO_PROMPT_ID = "go_agentic_architect_v1"
RUST_PROMPT_ID = "rust_agentic_architect_2024_v1"
QUARKUS_PROMPT_ID = "quarkus_cloud_native_architect_v1"
PYTHON_PROMPT_ID = "python_314_agentic_architect_v1"
GODOT_PROMPT_ID = "godot_4_engine_architect_v1"
TERRAFORM_PROMPT_ID = "terraform_infrastructure_architect_v1"
ECMA_PROMPT_ID = "principal_js_ts_architect_2026_v1"
BASH_PROMPT_ID = "bash_shell_safety_architect_v1"
SUPPORTED_LANGUAGE_PACKS = {"go", "rust", "quarkus", "python", "godot", "terraform", "ecma", "bash"}
AUX_SOURCE_LANGUAGES = {"rust", "quarkus", "python", "godot", "terraform", "ecma", "bash"}
REQUIRED_UNIVERSAL_ENRICHMENT_FIELDS = {
    "agent_hook",
    "perf_tier",
    "safety_contract",
    "lifecycle_model",
}
SYNPACK_V2_ARRAY_ENRICHMENT_FIELDS = (
    "task_intents",
    "query_aliases",
    "agent_query_hints",
    "anti_patterns",
    "hidden_warnings",
    "canonical_examples",
    "verification_hints",
    "related_interfaces",
    "related_symbols",
    "agent_actions",
    "evidence_spans",
)
SYNPACK_V2_SCALAR_ENRICHMENT_FIELDS = (
    "api_contract",
    "version_scope",
    "performance_notes",
    "confidence",
)
DOC_LIKE_FORMATS = {"", "md", "markdown", "html", "htm", "rst", "adoc", "txt", "text", "texi"}
MARKDOWN_FORMATS = {"md", "markdown"}
HTML_FORMATS = {"html", "htm"}
STRUCTURED_FORMATS = {
    "c",
    "bash",
    "bats",
    "cpp",
    "cs",
    "gd",
    "gdbuiltins",
    "glsl",
    "go",
    "h",
    "hcl",
    "java",
    "js",
    "json",
    "py",
    "python",
    "rs",
    "rust",
    "sh",
    "shell",
    "toml",
    "ts",
    "xml",
    "yaml",
    "yml",
    "zsh",
    "ksh",
}
LANGUAGE_PACK_GATE_POLICY = GatePolicy(min_chunk_quality=0.10, min_chunk_words=12, min_chunk_words_absolute=3)


@dataclass
class LanguageChunk:
    text: str
    doc_id: str
    chunk_index: int
    document_name: str
    heading_path: str = ""
    section: str = ""
    source_url: str = ""
    package_name: str = ""
    symbol_kind: str = ""
    symbol_fqn: str = ""
    symbol_name: str = ""
    module_path: str = ""
    artifact_kind: str = "docs"
    content_format: str = "markdown"
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def prompt_id(self) -> str:
        return str(self.metadata.get("prompt_id") or "")


def _basic_source_text_cleanup(text: str) -> str:
    return basic_source_text_cleanup(text)


def _strip_html_tags(text: str) -> str:
    from .language_text import strip_html_tags

    return strip_html_tags(text)


def _normalize_language_chunk_text(chunk: LanguageChunk) -> tuple[str, str]:
    return normalize_source_text_by_format(chunk.text, chunk.content_format)


def _has_curated_rescue_signal(chunk: LanguageChunk, text: str) -> bool:
    if chunk.artifact_kind != "docs":
        return bool(text.strip())
    fmt = (chunk.content_format or "").lower().strip()
    if fmt in STRUCTURED_FORMATS:
        return bool(text.strip())
    if chunk.symbol_kind or chunk.symbol_fqn or chunk.symbol_name:
        return bool(text.strip())
    if re.search(r"(?m)^\s*(?:func|type|class|def|interface|enum|resource|data)\s+\w+", text):
        return True
    return False


def prepare_language_chunks_for_enrichment(
    chunks: list[LanguageChunk],
) -> tuple[list[LanguageChunk], dict[str, Any]]:
    """Normalize curated language-pack chunks and reject obvious junk before enrichment."""
    prepared: list[LanguageChunk] = []
    rejected_reasons: dict[str, int] = {}
    counts = {
        "extracted": len(chunks),
        "normalized": 0,
        "quality_rejected": 0,
        "enrichment_attempted": 0,
    }

    for chunk in chunks:
        original_format = (chunk.content_format or "").lower().strip() or "text"
        normalized_text, normalized_format = _normalize_language_chunk_text(chunk)
        counts["normalized"] += int(normalized_text != chunk.text or normalized_format != original_format)

        verdict = score_chunk(
            normalized_text,
            section=chunk.section,
            heading_path=chunk.heading_path,
            policy=LANGUAGE_PACK_GATE_POLICY,
        )
        if verdict.should_index or _has_curated_rescue_signal(chunk, normalized_text):
            status = "clean" if verdict.should_index else "warn"
            metadata = {
                **chunk.metadata,
                "source_quality_score": round(verdict.quality_score, 4),
                "source_quality_status": status,
                "source_quality_reason": verdict.rejection_reason,
                "original_content_format": original_format,
                "normalized_content_format": normalized_format,
            }
            prepared.append(
                LanguageChunk(
                    text=normalized_text,
                    doc_id=chunk.doc_id,
                    chunk_index=chunk.chunk_index,
                    document_name=chunk.document_name,
                    heading_path=chunk.heading_path,
                    section=chunk.section,
                    source_url=chunk.source_url,
                    package_name=chunk.package_name,
                    symbol_kind=chunk.symbol_kind,
                    symbol_fqn=chunk.symbol_fqn,
                    symbol_name=chunk.symbol_name,
                    module_path=chunk.module_path,
                    artifact_kind=chunk.artifact_kind,
                    content_format=normalized_format,
                    metadata=metadata,
                )
            )
            continue

        reason = verdict.rejection_reason or "source quality rejected"
        rejected_reasons[reason.split("|")[0].strip()] = rejected_reasons.get(reason.split("|")[0].strip(), 0) + 1

    counts["quality_rejected"] = len(chunks) - len(prepared)
    counts["enrichment_attempted"] = len(prepared)
    return prepared, {**counts, "rejected_reasons": rejected_reasons}


def clone_repo(repo: str, target: Path, *, tag: str = "", depth: int = 1) -> None:
    cmd = ["git", "clone", "--depth", str(depth)]
    if tag:
        cmd.extend(["--branch", tag])
    cmd.extend([f"https://{repo}", str(target)])
    subprocess.run(
        cmd,
        check=True,
        text=True,
    )


def clone_go_source(tag: str, target: Path) -> None:
    clone_repo("github.com/golang/go", target, tag=tag)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise SynPackError(f"{path} must contain a YAML object")
    return data


def _normalize_doc_language(value: str) -> str:
    normalized = str(value or "en").strip().lower().replace("_", "-")
    if not re.fullmatch(r"[a-z]{2,3}(?:-[a-z0-9]{2,8})*", normalized):
        raise SynPackError(f"invalid doc_language: {value!r}")
    return normalized


def _supported_doc_languages(config: dict[str, Any]) -> list[str]:
    raw = config.get("supported_doc_languages") or [config.get("doc_language") or "en"]
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        raise SynPackError("supported_doc_languages must be a list")
    supported = [_normalize_doc_language(str(item)) for item in raw if str(item or "").strip()]
    return supported or ["en"]


def _validate_doc_language(*, doc_language: str, supported_doc_languages: list[str], pack_id: str) -> None:
    if doc_language == "en":
        return
    if doc_language not in supported_doc_languages:
        raise SynPackError(
            f"doc_language={doc_language!r} is not supported by this pack config; "
            f"supported_doc_languages={supported_doc_languages!r}"
        )
    if not pack_id.endswith(f"-{doc_language}"):
        raise SynPackError(f"non-English pack_id must end with '-{doc_language}' to keep pack partitions portable")


def _resolve_path(value: str, *, base: Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    if (base / path).exists():
        return base / path
    return _repo_root() / path


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="ignore")


def _split_text(text: str, *, max_chars: int = 6500) -> list[str]:
    text = text.strip()
    if not text:
        return []
    parts: list[str] = []
    current: list[str] = []
    size = 0
    for block in re.split(r"\n(?=#{1,4}\s|\w)", text):
        block = block.strip()
        if not block:
            continue
        if current and size + len(block) > max_chars:
            parts.append("\n\n".join(current))
            current = []
            size = 0
        current.append(block)
        size += len(block)
    if current:
        parts.append("\n\n".join(current))
    out: list[str] = []
    for part in parts:
        if len(part) <= max_chars:
            out.append(part)
        else:
            out.extend(part[i : i + max_chars] for i in range(0, len(part), max_chars))
    return out


def _heading_for(text: str, fallback: str) -> str:
    for line in text.splitlines()[:20]:
        if line.startswith("#"):
            return line.lstrip("#").strip()[:512]
    return fallback


def _doc_chunks(
    root: Path,
    paths: Iterable[str],
    *,
    language: str = "go",
    repo: str = "github.com/golang/go",
    tag: str = "{tag}",
    package_name: str = "",
    artifact_kind: str = "docs",
    symbol_kind: str = "",
    prompt_id: str = "",
    metadata: dict[str, Any] | None = None,
) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    index = 0
    for rel in paths:
        path = root / rel
        files = sorted(path.rglob("*")) if path.is_dir() else [path]
        for file_path in files:
            if not file_path.is_file() or file_path.name.startswith("."):
                continue
            if file_path.suffix.lower() not in {
                "",
                ".1",
                ".adoc",
                ".html",
                ".md",
                ".markdown",
                ".mdx",
                ".rst",
                ".texi",
                ".txt",
            }:
                continue
            rel_path = file_path.relative_to(root).as_posix()
            for part in _split_text(_read_text(file_path)):
                heading = _heading_for(part, rel_path)
                chunks.append(
                    LanguageChunk(
                        text=part,
                        doc_id=f"{language}:{repo}:{rel_path}",
                        chunk_index=index,
                        document_name=rel_path,
                        heading_path=heading,
                        section=heading,
                        package_name=package_name,
                        symbol_kind=symbol_kind,
                        symbol_fqn=heading if symbol_kind else "",
                        module_path=rel_path,
                        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                        artifact_kind=artifact_kind,
                        content_format=file_path.suffix.lstrip(".") or "text",
                        metadata={**(metadata or {}), **({"prompt_id": prompt_id} if prompt_id else {})},
                    )
                )
                index += 1
    return chunks


def _go_package_name(file_text: str, fallback: str) -> str:
    m = re.search(r"(?m)^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)", file_text)
    return m.group(1) if m else fallback


def _leading_comment(lines: list[str], start: int) -> str:
    out: list[str] = []
    i = start - 1
    while i >= 0:
        line = lines[i].rstrip()
        stripped = line.strip()
        if stripped.startswith("//"):
            out.append(stripped[2:].strip())
            i -= 1
            continue
        if stripped.endswith("*/"):
            block = [stripped]
            i -= 1
            while i >= 0:
                block.append(lines[i].strip())
                if lines[i].strip().startswith("/*"):
                    break
                i -= 1
            out.extend(reversed([x.strip("/* ").rstrip("*/ ").strip() for x in block]))
            break
        if not stripped:
            i -= 1
            continue
        break
    return "\n".join(reversed([x for x in out if x])).strip()


def _extract_go_symbols(file_path: Path, root: Path, package_path: str, package_name: str) -> list[LanguageChunk]:
    text = _read_text(file_path)
    lines = text.splitlines()
    rel_path = file_path.relative_to(root).as_posix()
    chunks: list[LanguageChunk] = []
    symbol_re = re.compile(
        r"^\s*(?:func\s+(?:\([^)]*\)\s*)?(?P<func>[A-Z][A-Za-z0-9_]*)|type\s+(?P<type>[A-Z][A-Za-z0-9_]*)|var\s+(?P<var>[A-Z][A-Za-z0-9_]*)|const\s+(?P<const>[A-Z][A-Za-z0-9_]*))\b"
    )
    for i, line in enumerate(lines):
        m = symbol_re.match(line)
        if not m:
            continue
        name = next(v for v in m.groupdict().values() if v)
        kind = "function" if m.group("func") else "type" if m.group("type") else "var" if m.group("var") else "const"
        comment = _leading_comment(lines, i)
        snippet = "\n".join(lines[i : min(len(lines), i + 40)]).strip()
        body = f"{comment}\n\n```go\n{snippet}\n```".strip()
        chunks.append(
            LanguageChunk(
                text=body,
                doc_id=f"go:{rel_path}:{name}",
                chunk_index=0,
                document_name=rel_path,
                heading_path=f"{package_path}.{name}",
                section=name,
                source_url=f"https://github.com/golang/go/blob/{{tag}}/{rel_path}",
                package_name=package_path,
                symbol_kind=kind,
                symbol_fqn=f"{package_path}.{name}",
                symbol_name=name,
                module_path=rel_path,
                artifact_kind="code",
                content_format="go",
            )
        )
    return chunks


def _go_package_chunks(root: Path, *, exclude_dirs: set[str] | None = None) -> list[LanguageChunk]:
    src = root / "src"
    chunks: list[LanguageChunk] = []
    index = 0
    excluded = exclude_dirs or {"cmd", "internal", "testdata", "vendor"}
    for pkg_dir in sorted(p for p in src.rglob("*") if p.is_dir()):
        rel_pkg = pkg_dir.relative_to(src).as_posix()
        if not rel_pkg or any(part in excluded for part in rel_pkg.split("/")):
            continue
        go_files = [
            p
            for p in sorted(pkg_dir.glob("*.go"))
            if not p.name.endswith("_test.go") and not p.name.startswith("z") and not p.name.endswith(".s")
        ]
        if not go_files:
            continue
        package_name = _go_package_name(_read_text(go_files[0]), rel_pkg.rsplit("/", 1)[-1])
        docs = []
        for name in ("doc.go", "example_test.go"):
            p = pkg_dir / name
            if p.exists():
                docs.append(_read_text(p))
        package_text = "\n\n".join(docs) or f"Package {package_name} in the Go standard library path {rel_pkg}."
        rel_doc = go_files[0].relative_to(root).as_posix()
        chunks.append(
            LanguageChunk(
                text=package_text[:6500],
                doc_id=f"go:src/{rel_pkg}",
                chunk_index=index,
                document_name=rel_pkg,
                heading_path=rel_pkg,
                section=package_name,
                source_url=f"https://github.com/golang/go/tree/{{tag}}/src/{rel_pkg}",
                package_name=rel_pkg,
                symbol_kind="package",
                symbol_fqn=rel_pkg,
                symbol_name=package_name,
                module_path=rel_doc,
                artifact_kind="docs",
                content_format="go",
            )
        )
        index += 1
        for file_path in go_files:
            for symbol in _extract_go_symbols(file_path, root, rel_pkg, package_name):
                symbol.chunk_index = index
                chunks.append(symbol)
                index += 1
    return chunks


def extract_go_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    docs = include.get("docs", ["doc", "api", "README.md", "CONTRIBUTING.md"])
    exclude_dirs = {str(x) for x in include.get("exclude_dirs", ["cmd", "internal", "testdata", "vendor"])}
    chunks = _doc_chunks(source_root, [str(x) for x in docs])
    chunks.extend(_go_package_chunks(source_root, exclude_dirs=exclude_dirs))
    for chunk in chunks:
        chunk.source_url = chunk.source_url.replace("{tag}", tag)
    return chunks


SHELL_SCRIPT_SUFFIXES = {".sh", ".bash", ".zsh", ".ksh", ".bats"}


def _shell_dialect(text: str, rel_path: str = "") -> str:
    first = text.splitlines()[0].lower() if text.splitlines() else ""
    haystack = f"{rel_path}\n{first}".lower()
    if "zsh" in haystack:
        return "zsh"
    if "ksh" in haystack:
        return "ksh"
    if "bash" in haystack:
        return "bash"
    if "dash" in haystack or "/bin/sh" in haystack or "posix" in haystack:
        return "posix-sh"
    return "shell"


def _bash_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str, symbol_kind: str = "") -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "shellcheck_rule" or re.search(r"\bSC\d{4}\b", text):
        return "shellcheck_rule_architect_v1"
    if artifact_kind in {"feedback_loop", "script_pattern"} or any(
        token in lower for token in ("shellcheck", "shfmt", "bats", "bash -n", "set -euo pipefail")
    ):
        return "shell_feedback_loop_architect_v1"
    return BASH_PROMPT_ID


def _bash_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "bash", "shell"]
    if "shellcheck" in lower or artifact_kind == "shellcheck_rule":
        tags.extend(["shellcheck", "linter-rules"])
    if "shfmt" in lower:
        tags.append("shfmt")
    if "bats" in lower or "test" in lower:
        tags.append("testing")
    if "set -euo pipefail" in lower or "errexit" in lower or "nounset" in lower:
        tags.append("strict-mode")
    if "trap" in lower or "cleanup" in lower:
        tags.append("cleanup-traps")
    if "mktemp" in lower or "tmp" in lower:
        tags.append("safe-tempfiles")
    if "quote" in lower or "word splitting" in lower or "$@" in text:
        tags.append("quoting")
    if any(token in lower for token in ("eval", "curl |", "| bash", "rm -rf", "sudo", "chmod +x")):
        tags.append("dangerous-command")
    if artifact_kind == "style_guide":
        tags.append("style-guide")
    if artifact_kind == "bash_reference":
        tags.append("bash-reference")
    if artifact_kind == "defensive_pattern":
        tags.append("defensive-programming")
    if artifact_kind == "pure_bash_pattern":
        tags.append("pure-bash")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind == "shellcheck_rule" or "dangerous-command" in tags else "guiding",
        "constraint_source": "shellcheck"
        if artifact_kind == "shellcheck_rule"
        else "shell-style-guide"
        if artifact_kind == "style_guide"
        else "bash-reference"
        if artifact_kind == "bash_reference"
        else "shell-patterns",
        "content_profile": "diagnostic" if artifact_kind == "shellcheck_rule" else "procedural",
        "shell_dialect": _shell_dialect(text, rel_path),
        "command_safety": "dangerous"
        if "dangerous-command" in tags
        else "guarded"
        if "cleanup-traps" in tags
        else "safe",
        "prompt_id": prompt_id or _bash_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind),
    }


def _shellcheck_rule_id(text: str, rel_path: str) -> str:
    name_match = re.search(r"\b(SC\d{4})\b", Path(rel_path).stem, re.I)
    if name_match:
        return name_match.group(1).upper()
    text_match = re.search(r"\b(SC\d{4})\b", text)
    return text_match.group(1).upper() if text_match else ""


def _extract_shellcheck_rule_chunks(
    root: Path,
    rel: str,
    *,
    repo: str,
    tag: str,
    package_name: str,
    prompt_id: str = "",
) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    path = root / rel
    files = sorted(path.rglob("*")) if path.is_dir() else [path]
    for file_path in files:
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in {"", ".md", ".markdown", ".txt", ".rst"}:
            continue
        rel_path = file_path.relative_to(root).as_posix()
        text = _read_text(file_path)
        rule_id = _shellcheck_rule_id(text, rel_path)
        if not rule_id:
            continue
        for index, part in enumerate(_split_text(text, max_chars=6500)):
            chunks.append(
                LanguageChunk(
                    text=part,
                    doc_id=f"bash:{repo}:{rel_path}:{rule_id}",
                    chunk_index=index,
                    document_name=rel_path,
                    heading_path=rule_id,
                    section=rule_id,
                    source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                    package_name=package_name,
                    symbol_kind="shellcheck_rule",
                    symbol_fqn=rule_id,
                    symbol_name=rule_id,
                    module_path=rel_path,
                    artifact_kind="shellcheck_rule",
                    content_format=file_path.suffix.lstrip(".") or "text",
                    metadata=_bash_metadata(
                        text=part,
                        rel_path=rel_path,
                        artifact_kind="shellcheck_rule",
                        symbol_kind="shellcheck_rule",
                        prompt_id=prompt_id,
                    ),
                )
            )
    return chunks


def _is_shell_script(path: Path, text: str) -> bool:
    return path.suffix.lower() in SHELL_SCRIPT_SUFFIXES or (text.startswith("#!") and "sh" in text.splitlines()[0])


def _shell_function_comment(lines: list[str], start: int) -> str:
    out: list[str] = []
    i = start - 1
    while i >= 0:
        stripped = lines[i].strip()
        if stripped.startswith("#") and not stripped.startswith("#!"):
            out.append(stripped.lstrip("#").strip())
            i -= 1
            continue
        if not stripped:
            i -= 1
            continue
        break
    return "\n".join(reversed([item for item in out if item])).strip()


def _extract_shell_script_chunks(
    root: Path,
    rel: str,
    *,
    repo: str,
    tag: str,
    package_name: str,
    prompt_id: str = "",
) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    path = root / rel
    files = sorted(path.rglob("*")) if path.is_dir() else [path]
    function_re = re.compile(r"(?m)^\s*(?:function\s+)?(?P<name>[A-Za-z_][A-Za-z0-9_:-]*)\s*(?:\(\))?\s*\{")
    for file_path in files:
        if not file_path.is_file():
            continue
        text = _read_text(file_path)
        if not _is_shell_script(file_path, text):
            continue
        rel_path = file_path.relative_to(root).as_posix()
        lines = text.splitlines()
        matched = False
        for match in function_re.finditer(text):
            matched = True
            name = match.group("name")
            line_no = text[: match.start()].count("\n")
            comment = _shell_function_comment(lines, line_no)
            snippet = "\n".join(lines[line_no : min(len(lines), line_no + 80)]).strip()
            body = f"{comment}\n\n```bash\n{snippet}\n```".strip()
            chunks.append(
                LanguageChunk(
                    text=body,
                    doc_id=f"bash:{repo}:{rel_path}:{name}",
                    chunk_index=len(chunks),
                    document_name=rel_path,
                    heading_path=name,
                    section=name,
                    source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                    package_name=package_name,
                    symbol_kind="function",
                    symbol_fqn=f"{rel_path}:{name}",
                    symbol_name=name,
                    module_path=rel_path,
                    artifact_kind="script_pattern",
                    content_format=file_path.suffix.lstrip(".") or "shell",
                    metadata=_bash_metadata(
                        text=body,
                        rel_path=rel_path,
                        artifact_kind="script_pattern",
                        symbol_kind="function",
                        prompt_id=prompt_id,
                    ),
                )
            )
        if not matched:
            chunks.append(
                LanguageChunk(
                    text=text[:6500],
                    doc_id=f"bash:{repo}:{rel_path}",
                    chunk_index=len(chunks),
                    document_name=rel_path,
                    heading_path=rel_path,
                    section=file_path.stem,
                    source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                    package_name=package_name,
                    symbol_kind="script",
                    symbol_fqn=rel_path,
                    symbol_name=file_path.name,
                    module_path=rel_path,
                    artifact_kind="script_pattern",
                    content_format=file_path.suffix.lstrip(".") or "shell",
                    metadata=_bash_metadata(
                        text=text,
                        rel_path=rel_path,
                        artifact_kind="script_pattern",
                        symbol_kind="script",
                        prompt_id=prompt_id,
                    ),
                )
            )
    return chunks


def extract_bash_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/koalaman/shellcheck")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for chunk in _doc_chunks(
        source_root,
        [str(x) for x in include.get("docs", ["README.md"])],
        language="bash",
        repo=repo,
        tag=tag,
        package_name="shellcheck",
        artifact_kind="feedback_loop",
        prompt_id="shell_feedback_loop_architect_v1",
    ):
        chunk.metadata.update(
            _bash_metadata(
                text=chunk.text,
                rel_path=chunk.module_path,
                artifact_kind="feedback_loop",
                prompt_id="shell_feedback_loop_architect_v1",
            )
        )
        chunks.append(chunk)

    for rel in include.get("shellcheck_rules", []):
        chunks.extend(
            _extract_shellcheck_rule_chunks(
                source_root,
                str(rel),
                repo=repo,
                tag=tag,
                package_name="shellcheck",
                prompt_id="shellcheck_rule_architect_v1",
            )
        )
    for rel in include.get("script_roots", []):
        chunks.extend(
            _extract_shell_script_chunks(
                source_root,
                str(rel),
                repo=repo,
                tag=tag,
                package_name="shell-patterns",
                prompt_id="shell_feedback_loop_architect_v1",
            )
        )

    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        aux_root = source_root / name if name and (source_root / name).exists() else source_root
        repo_name = str(aux.get("repo") or repo)
        raw_path = aux.get("path") or "."
        paths = [str(path) for path in raw_path] if isinstance(raw_path, list) else [str(raw_path)]
        artifact_kind = str(aux.get("artifact_kind") or "docs")
        package_name = str(aux.get("package_name") or name or "shell")
        prompt_id = str(aux.get("prompt_id") or "")
        for rel in paths:
            if artifact_kind == "shellcheck_rule":
                chunks.extend(
                    _extract_shellcheck_rule_chunks(
                        aux_root,
                        rel,
                        repo=repo_name,
                        tag=str(aux.get("resolved_ref") or "main"),
                        package_name=package_name,
                        prompt_id=prompt_id or "shellcheck_rule_architect_v1",
                    )
                )
                continue
            for chunk in _doc_chunks(
                aux_root,
                [rel],
                language="bash",
                repo=repo_name,
                tag=str(aux.get("resolved_ref") or "main"),
                package_name=package_name,
                artifact_kind=artifact_kind,
                prompt_id=prompt_id,
            ):
                chunk.metadata.update(
                    _bash_metadata(
                        text=chunk.text,
                        rel_path=chunk.module_path,
                        artifact_kind=artifact_kind,
                        prompt_id=prompt_id,
                    )
                )
                chunks.append(chunk)
            if artifact_kind in {"script_pattern", "feedback_loop"}:
                chunks.extend(
                    _extract_shell_script_chunks(
                        aux_root,
                        rel,
                        repo=repo_name,
                        tag=str(aux.get("resolved_ref") or "main"),
                        package_name=package_name,
                        prompt_id=prompt_id or "shell_feedback_loop_architect_v1",
                    )
                )

    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks


def _rust_doc_comment(lines: list[str], start: int) -> str:
    out: list[str] = []
    i = start - 1
    while i >= 0:
        stripped = lines[i].strip()
        if stripped.startswith("///") or stripped.startswith("//!"):
            out.append(stripped[3:].strip())
            i -= 1
            continue
        if stripped.startswith("#["):
            i -= 1
            continue
        if not stripped:
            i -= 1
            continue
        break
    return "\n".join(reversed(out)).strip()


def _rust_symbol_kind(line: str) -> tuple[str, str] | None:
    patterns = [
        ("trait", r"\b(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("struct", r"\b(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("enum", r"\b(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)"),
        (
            "function",
            r"\b(?:pub(?:\([^)]*\))?\s+)?(?:const\s+|async\s+|unsafe\s+|extern\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)",
        ),
        ("macro", r"\b(?:pub(?:\([^)]*\))?\s+)?macro_rules!\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("macro", r"\b(?:pub(?:\([^)]*\))?\s+)?macro\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("type_alias", r"\b(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("const", r"\b(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ("module", r"\b(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)"),
    ]
    for kind, pattern in patterns:
        m = re.search(pattern, line)
        if m:
            return kind, m.group(1)
    return None


def _rust_package_for_path(rel_path: str) -> str:
    if rel_path.startswith("library/std/"):
        return "std"
    if rel_path.startswith("library/core/"):
        return "core"
    if rel_path.startswith("library/alloc/"):
        return "alloc"
    if rel_path.startswith("compiler/rustc_error_codes/"):
        return "rustc_error_codes"
    return rel_path.split("/", 1)[0]


def _rust_module_for_path(rel_path: str) -> str:
    normalized = rel_path.replace("\\", "/")
    for crate in ("std", "core", "alloc"):
        prefix = f"library/{crate}/src/"
        if normalized.startswith(prefix):
            module = normalized[len(prefix) :]
            module = re.sub(r"\.rs$", "", module)
            if module in {"lib", "mod"}:
                return crate
            module = re.sub(r"/(?:mod|lib)$", "", module)
            module = module.strip("/")
            return "::".join([crate, *[part for part in module.split("/") if part]]) if module else crate
    if normalized.startswith("compiler/rustc_error_codes/"):
        return "rustc_error_codes"
    module = re.sub(r"\.[A-Za-z0-9]+$", "", normalized)
    module = re.sub(r"/(?:mod|lib)$", "", module)
    return "::".join(part for part in module.split("/") if part)


def _rust_symbol_fqn(rel_path: str, name: str) -> str:
    module = _rust_module_for_path(rel_path)
    return f"{module}::{name}" if module else name


def _rust_impl_refs(snippet: str, *, package: str) -> tuple[list[str], list[str]]:
    implements: list[str] = []
    contains: list[str] = []
    for match in re.finditer(
        r"\bimpl(?:<[^>{}]+>)?\s+(?:(?P<trait>[A-Za-z_][\w:<>]*)\s+for\s+)?(?P<target>[A-Za-z_][\w:<>]*)",
        snippet,
    ):
        trait = (match.group("trait") or "").strip()
        target = (match.group("target") or "").strip()
        if trait:
            implements.append(trait)
        if target:
            contains.append(f"{package}::{target}" if package and "::" not in target else target)
    return _unique_metadata_values(implements), _unique_metadata_values(contains)


def _edition_scope(text: str, rel_path: str) -> list[str]:
    haystack = f"{rel_path}\n{text}".lower()
    editions: list[str] = []
    if "2021" in haystack or "rust 2021" in haystack:
        editions.append("2021")
    if "2024" in haystack or "rust 2024" in haystack or "rpit" in haystack or "gen keyword" in haystack:
        editions.append("2024")
    return editions


def _rust_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str, symbol_kind: str = "") -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "compiler_error" or symbol_kind == "compiler_error":
        return "rust_error_debugger_v1"
    if artifact_kind == "tooling_guidance" or "cargo.toml" in lower or "cargo " in lower:
        return "rust_cargo_tooling_architect_v1"
    if artifact_kind == "examples":
        return "rust_example_architect_v1"
    if "nomicon" in rel_path or "unsafe" in lower or "ffi" in lower:
        return "rust_unsafe_nomicon_v1"
    if "async" in rel_path or "future" in lower or "pin<" in lower or "tokio" in lower:
        return "rust_async_architect_v1"
    if "2021" in lower and "2024" not in lower:
        return "rust_systems_architect_2021_v1"
    return RUST_PROMPT_ID


def _rust_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    edition = _edition_scope(text, rel_path)
    tags = ["language-pack", "rust"]
    tags.extend(f"edition-{e}" for e in edition)
    if artifact_kind == "compiler_error":
        tags.extend(["error-catalog", "rustc"])
    if artifact_kind == "language_spec":
        tags.append("language-spec")
    if artifact_kind == "unsafe_guidance":
        tags.append("unsafe")
    if artifact_kind == "async_guidance":
        tags.append("async")
    if artifact_kind == "tooling_guidance":
        tags.extend(["cargo", "tooling"])
    if artifact_kind == "examples":
        tags.append("example")
    if artifact_kind == "edition_guide":
        tags.append("edition-guide")
    content_profile = "reference"
    if artifact_kind in {"tooling_guidance", "examples"}:
        content_profile = "procedural"
    elif artifact_kind == "compiler_error":
        content_profile = "diagnostic"
    return {
        "edition_scope": edition,
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind in {"compiler_error", "language_spec"} else "guiding",
        "constraint_source": "rustc_error_codes" if artifact_kind == "compiler_error" else "rust-official-docs",
        "content_profile": content_profile,
        "prompt_id": prompt_id
        or _rust_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind=symbol_kind),
    }


def _extract_rust_symbols(file_path: Path, root: Path, *, repo: str, tag: str) -> list[LanguageChunk]:
    text = _read_text(file_path)
    lines = text.splitlines()
    rel_path = file_path.relative_to(root).as_posix()
    package = _rust_package_for_path(rel_path)
    chunks: list[LanguageChunk] = []
    for i, line in enumerate(lines):
        found = _rust_symbol_kind(line)
        if not found:
            continue
        kind, name = found
        comment = _rust_doc_comment(lines, i)
        snippet = "\n".join(lines[i : min(len(lines), i + 48)]).strip()
        body = f"{comment}\n\n```rust\n{snippet}\n```".strip()
        symbol_fqn = _rust_symbol_fqn(rel_path, name)
        implements_refs, contains_refs = _rust_impl_refs(snippet, package=package)
        metadata = _rust_metadata(text=body, rel_path=rel_path, artifact_kind="code", symbol_kind=kind)
        metadata.update(
            {
                "module_fqn": _rust_module_for_path(rel_path),
                "implements_refs": implements_refs,
                "contains_refs": contains_refs,
                "valid_in_refs": [f"rust:edition:{edition}" for edition in metadata.get("edition_scope", [])],
            }
        )
        chunks.append(
            LanguageChunk(
                text=body,
                doc_id=f"rust:{repo}:{rel_path}:{name}",
                chunk_index=0,
                document_name=rel_path,
                heading_path=symbol_fqn,
                section=name,
                source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                package_name=package,
                symbol_kind=kind,
                symbol_fqn=symbol_fqn,
                symbol_name=name,
                module_path=rel_path,
                artifact_kind="code",
                content_format="rust",
                metadata=metadata,
            )
        )
    return chunks


def _extract_rust_module_doc(file_path: Path, root: Path, *, repo: str, tag: str) -> LanguageChunk | None:
    text = _read_text(file_path)
    docs: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("//!"):
            docs.append(stripped[3:].strip())
            continue
        if stripped.startswith("#![") or not stripped:
            continue
        break
    body = "\n".join(docs).strip()
    if not body:
        return None
    rel_path = file_path.relative_to(root).as_posix()
    package = _rust_package_for_path(rel_path)
    module_fqn = _rust_module_for_path(rel_path)
    metadata = _rust_metadata(text=body, rel_path=rel_path, artifact_kind="docs", symbol_kind="module")
    metadata.update(
        {
            "module_fqn": module_fqn,
            "valid_in_refs": [f"rust:edition:{edition}" for edition in metadata.get("edition_scope", [])],
        }
    )
    return LanguageChunk(
        text=body[:6500],
        doc_id=f"rust:{repo}:{rel_path}:module-doc",
        chunk_index=0,
        document_name=rel_path,
        heading_path=module_fqn or package,
        section=module_fqn or package,
        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
        package_name=package,
        symbol_kind="module",
        symbol_fqn=module_fqn or package,
        symbol_name=(module_fqn or package).rsplit("::", 1)[-1],
        module_path=rel_path,
        artifact_kind="docs",
        content_format="rust",
        metadata=metadata,
    )


def _extract_rust_error_chunks(root: Path, rel: str, *, repo: str, tag: str) -> list[LanguageChunk]:
    base = root / rel
    if not base.exists():
        return []
    chunks: list[LanguageChunk] = []
    for file_path in sorted(base.rglob("*")):
        if not file_path.is_file() or file_path.suffix.lower() not in {".md", ".rs"}:
            continue
        rel_path = file_path.relative_to(root).as_posix()
        text = _read_text(file_path)
        codes = sorted(set(re.findall(r"\bE\d{4}\b", f"{file_path.name}\n{text}")))
        if not codes:
            continue
        for part in _split_text(text):
            for code in codes[:1]:
                metadata = _rust_metadata(
                    text=part, rel_path=rel_path, artifact_kind="compiler_error", symbol_kind="compiler_error"
                )
                chunks.append(
                    LanguageChunk(
                        text=part,
                        doc_id=f"rust:{repo}:{rel_path}:{code}",
                        chunk_index=len(chunks),
                        document_name=rel_path,
                        heading_path=code,
                        section=code,
                        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                        package_name="rustc_error_codes",
                        symbol_kind="compiler_error",
                        symbol_fqn=code,
                        symbol_name=code,
                        module_path=rel_path,
                        artifact_kind="compiler_error",
                        content_format=file_path.suffix.lstrip(".") or "text",
                        metadata=metadata,
                    )
                )
    return chunks


def _rust_doc_chunks_for_path(
    root: Path,
    rel: str,
    *,
    repo: str,
    tag: str,
    package_name: str,
    artifact_kind: str,
) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    for chunk in _doc_chunks(
        root,
        [rel],
        language="rust",
        repo=repo,
        tag=tag,
        package_name=package_name,
        artifact_kind=artifact_kind,
        symbol_kind="edition_rule" if artifact_kind == "language_spec" else "",
    ):
        chunk.metadata.update(
            _rust_metadata(
                text=chunk.text,
                rel_path=chunk.module_path,
                artifact_kind=artifact_kind,
                symbol_kind=chunk.symbol_kind,
            )
        )
        chunk.metadata["module_fqn"] = _rust_module_for_path(chunk.module_path)
        chunk.metadata["valid_in_refs"] = [
            f"rust:edition:{edition}" for edition in chunk.metadata.get("edition_scope", [])
        ]
        chunks.append(chunk)
    return chunks


def extract_rust_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/rust-lang/rust")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for rel in include.get("rust_docs", ["library/std/src", "library/core/src", "library/alloc/src"]):
        root_rel = str(rel)
        path = source_root / root_rel
        if not path.exists():
            continue
        for doc_name in ("lib.rs", "mod.rs"):
            module_doc = (
                _extract_rust_module_doc(path / doc_name, source_root, repo=repo, tag=tag)
                if (path / doc_name).exists()
                else None
            )
            if module_doc:
                chunks.append(module_doc)
        for rs in sorted(path.rglob("*.rs")):
            if any(part in {"tests", "testdata"} for part in rs.relative_to(source_root).parts):
                continue
            chunks.extend(_extract_rust_symbols(rs, source_root, repo=repo, tag=tag))
        chunks.extend(
            _rust_doc_chunks_for_path(
                source_root,
                root_rel,
                repo=repo,
                tag=tag,
                package_name=_rust_package_for_path(root_rel),
                artifact_kind="docs",
            )
        )
    for rel in include.get("error_codes", ["compiler/rustc_error_codes/src"]):
        chunks.extend(_extract_rust_error_chunks(source_root, str(rel), repo=repo, tag=tag))

    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        rel = str(aux.get("path") or "src")
        repo_name = str(aux.get("repo") or "")
        aux_root = source_root / name if name and (source_root / name).exists() else source_root
        artifact_kind = str(aux.get("artifact_kind") or "docs")
        package_name = str(aux.get("package_name") or name or "rust")
        prompt_id = str(aux.get("prompt_id") or "")
        for chunk in _rust_doc_chunks_for_path(
            aux_root,
            rel,
            repo=repo_name or repo,
            tag=str(aux.get("resolved_ref") or "main"),
            package_name=package_name,
            artifact_kind=artifact_kind,
        ):
            if prompt_id:
                chunk.metadata["prompt_id"] = prompt_id
            chunks.append(chunk)

    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks


def _java_doc_before(lines: list[str], start: int) -> str:
    i = start - 1
    while i >= 0 and not lines[i].strip():
        i -= 1
    if i < 0 or "*/" not in lines[i]:
        return ""
    block: list[str] = []
    while i >= 0:
        block.append(lines[i])
        if "/**" in lines[i]:
            break
        i -= 1
    block.reverse()
    cleaned: list[str] = []
    for line in block:
        stripped = line.strip()
        stripped = stripped.removeprefix("/**").removesuffix("*/").strip()
        stripped = stripped.removeprefix("*").strip()
        if stripped:
            cleaned.append(stripped)
    return "\n".join(cleaned).strip()


def _quarkus_package_for_path(rel_path: str) -> str:
    if rel_path.startswith("devtools/cli/"):
        return "quarkus-cli"
    if rel_path.startswith("core/runtime/"):
        return "quarkus-core"
    if rel_path.startswith("docs/"):
        return "quarkus-guides"
    if rel_path.startswith("extensions/"):
        parts = rel_path.split("/")
        return parts[1] if len(parts) > 1 else "extensions"
    if rel_path.startswith("quarkus-platform/"):
        return "quarkus-platform"
    return "quarkus"


def _quarkus_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "quarkus", "java"]
    if artifact_kind == "cli_command":
        tags.extend(["quarkus-cli", "devtools", "package-tooling"])
    if artifact_kind == "config_reference":
        tags.extend(
            [
                "config-reference",
                "build-time-config"
                if "build_time" in lower or "buildtime" in lower or "fixed" in lower
                else "runtime-config",
            ]
        )
    if "native" in lower or "graalvm" in lower:
        tags.append("native-image")
    if "reactive" in lower or "mutiny" in lower or "event loop" in lower:
        tags.append("reactive")
    if "dev services" in lower or "devservices" in lower:
        tags.append("dev-services")
    if "extension" in lower or rel_path.startswith("extensions/"):
        tags.append("extension")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind in {"config_reference", "platform_bom"} else "guiding",
        "constraint_source": "quarkus-config-reference"
        if artifact_kind == "config_reference"
        else "quarkus-cli"
        if artifact_kind == "cli_command"
        else "quarkus-docs",
        "content_profile": "reference" if artifact_kind != "cli_command" else "procedural",
        "prompt_id": prompt_id or ("quarkus_cli_architect_v1" if artifact_kind == "cli_command" else QUARKUS_PROMPT_ID),
    }


def _extract_quarkus_docs(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    repo = str(config.get("repo") or "github.com/quarkusio/quarkus")
    paths = [str(x) for x in include.get("guides", ["docs/src/main/asciidoc"])]
    chunks: list[LanguageChunk] = []
    for chunk in _doc_chunks(
        source_root,
        paths,
        language="quarkus",
        repo=repo,
        tag=tag,
        package_name="quarkus-guides",
        artifact_kind="docs",
        prompt_id=QUARKUS_PROMPT_ID,
    ):
        chunk.metadata.update(_quarkus_metadata(text=chunk.text, rel_path=chunk.module_path, artifact_kind="docs"))
        chunks.append(chunk)
    return chunks


def _java_class_name(text: str, fallback: str) -> str:
    m = re.search(r"\b(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)", text)
    return m.group(1) if m else fallback


def _extract_quarkus_config_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/quarkusio/quarkus")
    chunks: list[LanguageChunk] = []
    java_roots = [p for p in source_root.rglob("runtime/src/main/java") if p.is_dir()]
    for root in sorted(java_roots):
        for file_path in sorted(root.rglob("*.java")):
            text = _read_text(file_path)
            if not any(
                marker in text
                for marker in ("@ConfigRoot", "@ConfigItem", "@ConfigMapping", "@ConfigProperty", "@ConfigGroup")
            ):
                continue
            rel_path = file_path.relative_to(source_root).as_posix()
            package = _quarkus_package_for_path(rel_path)
            class_name = _java_class_name(text, file_path.stem)
            class_doc = _java_doc_before(
                text.splitlines(),
                next(
                    (
                        i
                        for i, line in enumerate(text.splitlines())
                        if "class " in line or "interface " in line or "record " in line
                    ),
                    0,
                ),
            )
            if "@ConfigRoot" in text or "@ConfigMapping" in text or "@ConfigGroup" in text:
                body = f"{class_doc}\n\n```java\n{text[:5000]}\n```".strip()
                chunks.append(
                    LanguageChunk(
                        text=body,
                        doc_id=f"quarkus:{repo}:{rel_path}:{class_name}",
                        chunk_index=0,
                        document_name=rel_path,
                        heading_path=class_name,
                        section=class_name,
                        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                        package_name=package,
                        symbol_kind="config_root",
                        symbol_fqn=class_name,
                        symbol_name=class_name,
                        module_path=rel_path,
                        artifact_kind="config_reference",
                        content_format="java",
                        metadata=_quarkus_metadata(
                            text=body, rel_path=rel_path, artifact_kind="config_reference", symbol_kind="config_root"
                        ),
                    )
                )
            lines = text.splitlines()
            field_re = re.compile(
                r"\b(?:public\s+)?(?:Optional<[^>]+>|List<[^>]+>|Map<[^>]+>|[A-Za-z_][A-Za-z0-9_<>.?]+)\s+([a-z][A-Za-z0-9_]*)\s*(?:=|;)"
            )
            for i, line in enumerate(lines):
                if "@ConfigItem" not in "\n".join(lines[max(0, i - 4) : i + 1]) and "@ConfigProperty" not in "\n".join(
                    lines[max(0, i - 4) : i + 1]
                ):
                    continue
                m = field_re.search(line)
                if not m:
                    continue
                field = m.group(1)
                doc = _java_doc_before(lines, i)
                snippet = "\n".join(lines[max(0, i - 6) : min(len(lines), i + 8)]).strip()
                body = f"{doc}\n\n```java\n{snippet}\n```".strip()
                chunks.append(
                    LanguageChunk(
                        text=body,
                        doc_id=f"quarkus:{repo}:{rel_path}:{class_name}.{field}",
                        chunk_index=0,
                        document_name=rel_path,
                        heading_path=f"{class_name}.{field}",
                        section=field,
                        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                        package_name=package,
                        symbol_kind="config_property",
                        symbol_fqn=f"{class_name}.{field}",
                        symbol_name=field,
                        module_path=rel_path,
                        artifact_kind="config_reference",
                        content_format="java",
                        metadata=_quarkus_metadata(
                            text=body,
                            rel_path=rel_path,
                            artifact_kind="config_reference",
                            symbol_kind="config_property",
                        ),
                    )
                )
    return chunks


def _extract_quarkus_cli_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/quarkusio/quarkus")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    cli_root = source_root / str(include.get("cli_root", "devtools/cli/src/main/java/io/quarkus/cli"))
    chunks: list[LanguageChunk] = []
    if not cli_root.exists():
        return chunks
    command_re = re.compile(r"@Command\s*\((?P<args>.*?)\)", re.DOTALL)
    name_re = re.compile(r"name\s*=\s*\"([^\"]+)\"")
    option_re = re.compile(r"@Option\s*\((.*?)\)", re.DOTALL)
    for file_path in sorted(cli_root.rglob("*.java")):
        text = _read_text(file_path)
        if "@Command" not in text:
            continue
        rel_path = file_path.relative_to(source_root).as_posix()
        class_name = _java_class_name(text, file_path.stem)
        command_match = command_re.search(text)
        command_args = command_match.group("args") if command_match else ""
        command_name = name_re.search(command_args).group(1) if name_re.search(command_args) else class_name
        options = [m.group(1).strip().replace("\n", " ")[:240] for m in option_re.finditer(text)]
        doc = _java_doc_before(
            text.splitlines(), next((i for i, line in enumerate(text.splitlines()) if "@Command" in line), 0)
        )
        body = (
            f"{doc}\n\nCommand: quarkus {command_name}\n\n"
            f"Command annotation:\n```java\n@Command({command_args.strip()[:1200]})\n```\n\n"
            f"Options:\n" + "\n".join(f"- {opt}" for opt in options[:20])
        ).strip()
        chunks.append(
            LanguageChunk(
                text=body,
                doc_id=f"quarkus:{repo}:{rel_path}:{command_name}",
                chunk_index=0,
                document_name=rel_path,
                heading_path=f"quarkus {command_name}",
                section=command_name,
                source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                package_name="quarkus-cli",
                symbol_kind="cli_command",
                symbol_fqn=f"quarkus {command_name}",
                symbol_name=command_name,
                module_path=rel_path,
                artifact_kind="cli_command",
                content_format="java",
                metadata=_quarkus_metadata(
                    text=body, rel_path=rel_path, artifact_kind="cli_command", symbol_kind="cli_command"
                ),
            )
        )
    return chunks


def _extract_quarkus_source_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/quarkusio/quarkus")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    roots = [str(x) for x in include.get("source_roots", ["core/runtime/src/main/java"])]
    chunks: list[LanguageChunk] = []
    class_re = re.compile(
        r"\bpublic\s+(?:abstract\s+|final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)"
    )
    for rel in roots:
        root = source_root / rel
        if not root.exists():
            continue
        for file_path in sorted(root.rglob("*.java")):
            text = _read_text(file_path)
            rel_path = file_path.relative_to(source_root).as_posix()
            package = _quarkus_package_for_path(rel_path)
            m = class_re.search(text)
            if not m:
                continue
            name = m.group(1)
            doc = _java_doc_before(text.splitlines(), text[: m.start()].count("\n"))
            body = f"{doc}\n\n```java\n{text[:5000]}\n```".strip()
            chunks.append(
                LanguageChunk(
                    text=body,
                    doc_id=f"quarkus:{repo}:{rel_path}:{name}",
                    chunk_index=0,
                    document_name=rel_path,
                    heading_path=name,
                    section=name,
                    source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                    package_name=package,
                    symbol_kind="java_type",
                    symbol_fqn=name,
                    symbol_name=name,
                    module_path=rel_path,
                    artifact_kind="code",
                    content_format="java",
                    metadata=_quarkus_metadata(
                        text=body, rel_path=rel_path, artifact_kind="code", symbol_kind="java_type"
                    ),
                )
            )
    return chunks


def _extract_quarkus_platform_chunks(source_root: Path, *, config: dict[str, Any]) -> list[LanguageChunk]:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict) or str(aux.get("name") or "") != "quarkus-platform":
            continue
        aux_root = source_root / "quarkus-platform"
        if not aux_root.exists():
            continue
        repo = str(aux.get("repo") or "github.com/quarkusio/quarkus-platform")
        for file_path in sorted(aux_root.rglob("*.xml"))[:200]:
            rel_path = file_path.relative_to(aux_root).as_posix()
            text = _read_text(file_path)
            if "quarkus-bom" not in text and "<artifactId>" not in text:
                continue
            body = text[:6500]
            chunks.append(
                LanguageChunk(
                    text=body,
                    doc_id=f"quarkus:{repo}:{rel_path}",
                    chunk_index=0,
                    document_name=rel_path,
                    heading_path=rel_path,
                    section=file_path.stem,
                    source_url=f"https://{repo}/blob/{aux.get('resolved_ref') or 'main'}/{rel_path}",
                    package_name="quarkus-platform",
                    symbol_kind="platform_bom",
                    symbol_fqn=file_path.stem,
                    symbol_name=file_path.stem,
                    module_path=f"quarkus-platform/{rel_path}",
                    artifact_kind="platform_bom",
                    content_format="xml",
                    metadata=_quarkus_metadata(
                        text=body,
                        rel_path=f"quarkus-platform/{rel_path}",
                        artifact_kind="platform_bom",
                        symbol_kind="platform_bom",
                    ),
                )
            )
    return chunks


def extract_quarkus_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    chunks.extend(_extract_quarkus_docs(source_root, config=config, tag=tag))
    chunks.extend(_extract_quarkus_config_chunks(source_root, config=config, tag=tag))
    chunks.extend(_extract_quarkus_source_chunks(source_root, config=config, tag=tag))
    chunks.extend(_extract_quarkus_cli_chunks(source_root, config=config, tag=tag))
    chunks.extend(_extract_quarkus_platform_chunks(source_root, config=config))
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks


def _python_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str, symbol_kind: str = "") -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "repo_map":
        return "python_repo_architect_v1"
    if artifact_kind in {"packaging_spec", "tool_docs"} or "pyproject" in lower or "uv " in lower or "pixi" in lower:
        return "python_packaging_env_architect_v1"
    if artifact_kind == "type_stub" or "typing" in lower or "type hints" in lower or "pep 649" in lower:
        return "python_typing_architect_v1"
    if artifact_kind == "web_framework_docs" or any(
        marker in lower for marker in ("flask", "werkzeug", "jinja", "wsgi", "blueprint", "request context")
    ):
        return "python_web_flask_architect_v1"
    if artifact_kind in {"ml_framework_docs", "ml_tutorial"} or any(
        marker in lower for marker in ("torch.", "pytorch", "autograd", "cuda", "nn.module", "dataloader")
    ):
        return "python_ml_pytorch_architect_v1"
    if artifact_kind in {"data_science_docs", "notebook_docs"} or any(
        marker in lower
        for marker in (
            "numpy",
            "pandas",
            "scipy",
            "scikit-learn",
            "sklearn",
            "matplotlib",
            "jupyter",
            "dataframe",
            "ndarray",
        )
    ):
        return "python_data_science_architect_v1"
    if "asyncio" in rel_path or "taskgroup" in lower or "await" in lower or "cancel" in lower:
        return "python_async_architect_v1"
    return PYTHON_PROMPT_ID


def _python_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "python"]
    if "pep 703" in lower or "free-thread" in lower or "nogil" in lower or "no-gil" in lower:
        tags.append("free-threading")
    if "pep 734" in lower or "subinterpreter" in lower or "interpreters" in lower:
        tags.append("subinterpreters")
    if "pep 649" in lower or ("deferred" in lower and "annotation" in lower):
        tags.append("deferred-annotations")
    if "pep 750" in lower or "template string" in lower or "t-string" in lower or "templatelib" in lower:
        tags.append("t-strings")
    if "asyncio" in lower or "taskgroup" in lower:
        tags.append("async")
    if "uv" in lower:
        tags.append("uv")
    if "pixi" in lower:
        tags.append("pixi")
    if artifact_kind == "web_framework_docs":
        tags.extend(["web-framework", "flask-ecosystem"])
        if "flask" in lower:
            tags.append("flask")
        if "werkzeug" in lower or "wsgi" in lower:
            tags.append("werkzeug-wsgi")
        if "jinja" in lower or "template" in lower:
            tags.append("jinja-template")
        if "click" in lower or "cli" in lower:
            tags.append("click-cli")
    if artifact_kind in {"ml_framework_docs", "ml_tutorial"}:
        tags.extend(["ml", "pytorch"])
        if "cuda" in lower or "mps" in lower or "device" in lower:
            tags.append("accelerator-device")
        if "autograd" in lower or "gradient" in lower:
            tags.append("autograd")
        if "dataloader" in lower or "dataset" in lower:
            tags.append("data-loading")
        if "distributed" in lower:
            tags.append("distributed-training")
    if artifact_kind in {"data_science_docs", "notebook_docs"}:
        tags.extend(["data-science", "numeric-python"])
        if "numpy" in lower or "ndarray" in lower:
            tags.append("numpy-array")
        if "pandas" in lower or "dataframe" in lower:
            tags.append("pandas-dataframe")
        if "scipy" in lower:
            tags.append("scipy")
        if "scikit-learn" in lower or "sklearn" in lower or "estimator" in lower:
            tags.append("sklearn-estimator")
        if "jupyter" in lower or "notebook" in lower:
            tags.append("notebook")
    if artifact_kind == "repo_map":
        tags.extend(["repo-map", "python-architecture", "repo-repair"])
    if artifact_kind == "type_stub":
        tags.append("typeshed")
    if artifact_kind == "pep":
        tags.append("pep")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind in {"pep", "type_stub", "packaging_spec"} else "guiding",
        "constraint_source": "python-peps"
        if artifact_kind == "pep"
        else "typeshed"
        if artifact_kind == "type_stub"
        else "python-repo-map"
        if artifact_kind == "repo_map"
        else "python-web-framework-docs"
        if artifact_kind == "web_framework_docs"
        else "python-ml-framework-docs"
        if artifact_kind in {"ml_framework_docs", "ml_tutorial"}
        else "python-data-science-docs"
        if artifact_kind in {"data_science_docs", "notebook_docs"}
        else "python-docs",
        "content_profile": "architecture"
        if artifact_kind == "repo_map"
        else "procedural"
        if artifact_kind in {"ml_tutorial", "notebook_docs"}
        else "reference",
        "prompt_id": prompt_id
        or _python_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind=symbol_kind),
    }


def _python_package_for_path(rel_path: str) -> str:
    if rel_path.startswith("Lib/"):
        parts = rel_path.split("/")
        if len(parts) > 1:
            return parts[1].removesuffix(".py")
    if rel_path.startswith("Doc/"):
        return "python-docs"
    if rel_path.startswith("peps/"):
        return "peps"
    if rel_path.startswith("typeshed/"):
        return "typeshed"
    return "python"


def _annotation_to_string(node: ast.AST | None) -> str:
    if node is None:
        return ""
    try:
        return ast.unparse(node)
    except Exception:
        return ""


def _extract_python_symbols(
    file_path: Path, root: Path, *, repo: str, tag: str, artifact_kind: str = "code"
) -> list[LanguageChunk]:
    text = _read_text(file_path)
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    rel_path = file_path.relative_to(root).as_posix()
    package = _python_package_for_path(rel_path)
    chunks: list[LanguageChunk] = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        name = node.name
        if name.startswith("_") and name != "__init__":
            continue
        kind = (
            "class"
            if isinstance(node, ast.ClassDef)
            else "async_function"
            if isinstance(node, ast.AsyncFunctionDef)
            else "function"
        )
        doc = ast.get_docstring(node) or ""
        lineno = max(1, getattr(node, "lineno", 1))
        end = min(len(text.splitlines()), getattr(node, "end_lineno", lineno + 40))
        snippet = "\n".join(text.splitlines()[lineno - 1 : min(end, lineno + 60)]).strip()
        body = f"{doc}\n\n```python\n{snippet}\n```".strip()
        symbol_fqn = f"{package}.{name}" if package else name
        chunks.append(
            LanguageChunk(
                text=body,
                doc_id=f"python:{repo}:{rel_path}:{name}",
                chunk_index=0,
                document_name=rel_path,
                heading_path=symbol_fqn,
                section=name,
                source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                package_name=package,
                symbol_kind=kind,
                symbol_fqn=symbol_fqn,
                symbol_name=name,
                module_path=rel_path,
                artifact_kind=artifact_kind,
                content_format=file_path.suffix.lstrip(".") or "python",
                metadata=_python_metadata(text=body, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind=kind),
            )
        )
    return chunks


def _extract_python_module_doc(
    file_path: Path, root: Path, *, repo: str, tag: str, artifact_kind: str = "docs"
) -> LanguageChunk | None:
    text = _read_text(file_path)
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return None
    doc = ast.get_docstring(tree) or ""
    if not doc:
        return None
    rel_path = file_path.relative_to(root).as_posix()
    package = _python_package_for_path(rel_path)
    return LanguageChunk(
        text=doc[:6500],
        doc_id=f"python:{repo}:{rel_path}:module-doc",
        chunk_index=0,
        document_name=rel_path,
        heading_path=package,
        section=package,
        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
        package_name=package,
        symbol_kind="module",
        symbol_fqn=package,
        symbol_name=package,
        module_path=rel_path,
        artifact_kind=artifact_kind,
        content_format=file_path.suffix.lstrip(".") or "python",
        metadata=_python_metadata(text=doc, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind="module"),
    )


def _extract_python_pep_chunks(root: Path, rel: str, *, repo: str, tag: str) -> list[LanguageChunk]:
    base = root / rel
    if not base.exists():
        return []
    chunks: list[LanguageChunk] = []
    for file_path in sorted(base.rglob("pep-*.rst")):
        rel_path = file_path.relative_to(root).as_posix()
        text = _read_text(file_path)
        m = re.search(r"pep-(\d{4})", file_path.name, re.IGNORECASE)
        if not m:
            continue
        pep = f"PEP-{m.group(1)}"
        for part in _split_text(text):
            chunks.append(
                LanguageChunk(
                    text=part,
                    doc_id=f"python:{repo}:{rel_path}:{pep}",
                    chunk_index=len(chunks),
                    document_name=rel_path,
                    heading_path=pep,
                    section=pep,
                    source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                    package_name="peps",
                    symbol_kind="pep",
                    symbol_fqn=pep,
                    symbol_name=pep,
                    module_path=rel_path,
                    artifact_kind="pep",
                    content_format="rst",
                    metadata=_python_metadata(text=part, rel_path=rel_path, artifact_kind="pep", symbol_kind="pep"),
                )
            )
    return chunks


def _extract_python_repo_map(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/python/cpython")
    chunks: list[LanguageChunk] = []
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    repo_map_paths = [str(x) for x in include.get("repo_map_paths", ["Lib"])]
    py_files: list[Path] = []
    for rel in repo_map_paths:
        root = source_root / rel
        if root.is_file() and root.suffix == ".py":
            py_files.append(root)
        elif root.exists():
            py_files.extend(p for p in root.rglob("*.py") if ".git" not in p.parts and "__pycache__" not in p.parts)
    if not py_files:
        py_files = sorted(
            p for p in source_root.rglob("*.py") if ".git" not in p.parts and "__pycache__" not in p.parts
        )
    else:
        py_files = sorted(set(py_files))
    py_files = py_files[:1000]
    internal_import_counts: dict[str, int] = {}
    module_infos: list[dict[str, Any]] = []
    package_roots = {p.parent for p in py_files if p.name == "__init__.py"}
    for file_path in py_files:
        text = _read_text(file_path)
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        rel_path = file_path.relative_to(source_root).as_posix()
        public: list[str] = []
        imports: list[str] = []
        type_hints: list[str] = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and not node.name.startswith(
                "_"
            ):
                public.append(node.name)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    ann = _annotation_to_string(node.returns)
                    if ann:
                        type_hints.append(f"{node.name} -> {ann}")
            elif isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.append(node.module)
        for item in imports:
            internal_import_counts[item.split(".")[0]] = internal_import_counts.get(item.split(".")[0], 0) + 1
        module_infos.append(
            {
                "rel_path": rel_path,
                "doc": ast.get_docstring(tree) or "",
                "public": public[:50],
                "imports": imports[:50],
                "type_hints": type_hints[:50],
                "map_level": 1 if file_path in package_roots else 2,
            }
        )
    max_imports = max(internal_import_counts.values(), default=1)
    project_files = [p.relative_to(source_root).as_posix() for p in py_files[:200]]
    project_json = {
        "map_level": 0,
        "module_intent": "Python project root inferred from pyproject/package layout.",
        "entry_points": [p for p in project_files if p.endswith("__init__.py") or p.endswith("pyproject.toml")][:20],
        "api_surface": [],
        "export_surface": [],
        "dependency_edge": [],
        "center_of_gravity": 1.0,
        "side_effects": "unknown",
        "agent_brief": "Start here to orient on package layout before searching implementation files.",
    }
    chunks.append(
        LanguageChunk(
            text=json.dumps(project_json, sort_keys=True),
            doc_id=f"python:{repo}:repo-map:root",
            chunk_index=0,
            document_name="repo-map",
            heading_path="Project Root",
            section="project_root",
            source_url=f"https://{repo}/tree/{tag}",
            package_name="repo_map",
            symbol_kind="project_root",
            symbol_fqn="repo_map:root",
            symbol_name="root",
            module_path="",
            artifact_kind="repo_map",
            content_format="json",
            metadata={
                **_python_metadata(
                    text=json.dumps(project_json),
                    rel_path="repo-map",
                    artifact_kind="repo_map",
                    symbol_kind="project_root",
                ),
                "repo_map_json": project_json,
            },
        )
    )
    for info in module_infos:
        rel_path = str(info["rel_path"])
        module_name = rel_path.removesuffix(".py").replace("/", ".")
        center = min(1.0, internal_import_counts.get(module_name.split(".")[0], 0) / max_imports)
        map_json = {
            "map_level": info["map_level"],
            "module_intent": info["doc"][:500] or f"Python module {module_name}.",
            "entry_points": info["public"][:20],
            "api_surface": info["public"][:50],
            "export_surface": info["type_hints"][:50],
            "dependency_edge": info["imports"][:50],
            "center_of_gravity": round(center, 4),
            "side_effects": "YES"
            if any(x in ",".join(info["imports"]) for x in ["os", "socket", "subprocess", "sqlite", "requests"])
            else "unknown",
            "agent_brief": f"Use {module_name} as a high-level map row before opening source when the bug report mentions related APIs.",
        }
        chunks.append(
            LanguageChunk(
                text=json.dumps(map_json, sort_keys=True),
                doc_id=f"python:{repo}:repo-map:{rel_path}",
                chunk_index=len(chunks),
                document_name=rel_path,
                heading_path=module_name,
                section=module_name,
                source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                package_name="repo_map",
                symbol_kind="module",
                symbol_fqn=module_name,
                symbol_name=module_name.rsplit(".", 1)[-1],
                module_path=rel_path,
                artifact_kind="repo_map",
                content_format="json",
                metadata={
                    **_python_metadata(
                        text=json.dumps(map_json), rel_path=rel_path, artifact_kind="repo_map", symbol_kind="module"
                    ),
                    "repo_map_json": map_json,
                },
            )
        )
    return chunks


def extract_python_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/python/cpython")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for rel in include.get("stdlib", ["Lib"]):
        root = source_root / str(rel)
        if not root.exists():
            continue
        for file_path in sorted(root.rglob("*.py")):
            if "test" in file_path.relative_to(root).parts:
                continue
            module_doc = _extract_python_module_doc(file_path, source_root, repo=repo, tag=tag)
            if module_doc:
                chunks.append(module_doc)
            chunks.extend(_extract_python_symbols(file_path, source_root, repo=repo, tag=tag))
    for rel in include.get("docs", ["Doc"]):
        chunks.extend(
            _doc_chunks(
                source_root,
                [str(rel)],
                language="python",
                repo=repo,
                tag=tag,
                package_name="python-docs",
                artifact_kind="docs",
                prompt_id=PYTHON_PROMPT_ID,
            )
        )
    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        aux_root = source_root / name if name and (source_root / name).exists() else source_root
        repo_name = str(aux.get("repo") or repo)
        path = str(aux.get("path") or "")
        artifact_kind = str(aux.get("artifact_kind") or "docs")
        if artifact_kind == "pep":
            chunks.extend(
                _extract_python_pep_chunks(
                    aux_root, path or ".", repo=repo_name, tag=str(aux.get("resolved_ref") or "main")
                )
            )
            continue
        if artifact_kind == "type_stub":
            for pyi in sorted((aux_root / path).rglob("*.pyi")) if (aux_root / path).exists() else []:
                chunks.extend(
                    _extract_python_symbols(
                        pyi,
                        aux_root,
                        repo=repo_name,
                        tag=str(aux.get("resolved_ref") or "main"),
                        artifact_kind="type_stub",
                    )
                )
            continue
        for chunk in _doc_chunks(
            aux_root,
            [path or "."],
            language="python",
            repo=repo_name,
            tag=str(aux.get("resolved_ref") or "main"),
            package_name=str(aux.get("package_name") or name or "python"),
            artifact_kind=artifact_kind,
            prompt_id=str(aux.get("prompt_id") or ""),
        ):
            chunk.metadata.update(
                _python_metadata(
                    text=chunk.text,
                    rel_path=chunk.module_path,
                    artifact_kind=artifact_kind,
                    prompt_id=str(aux.get("prompt_id") or ""),
                )
            )
            chunks.append(chunk)
    pyproject = source_root / "pyproject.toml"
    if pyproject.exists():
        text = _read_text(pyproject)
        map_json = {
            "map_level": 0,
            "module_intent": "Python project metadata, dependency groups, build backend, and tool configuration.",
            "entry_points": re.findall(r"(?m)^\s*([A-Za-z0-9_.-]+)\s*=", text)[:20],
            "api_surface": [],
            "export_surface": [],
            "dependency_edge": re.findall(r"['\"]([A-Za-z0-9_.-]+)[<>=~!;,'\"]", text)[:50],
            "center_of_gravity": 1.0,
            "side_effects": "NO",
            "agent_brief": "Inspect pyproject.toml before changing dependencies, test commands, build backend, or Python version constraints.",
        }
        chunks.append(
            LanguageChunk(
                text=text[:6500],
                doc_id=f"python:{repo}:pyproject.toml",
                chunk_index=len(chunks),
                document_name="pyproject.toml",
                heading_path="pyproject.toml",
                section="pyproject",
                source_url=f"https://{repo}/blob/{tag}/pyproject.toml",
                package_name="repo_map",
                symbol_kind="project_config",
                symbol_fqn="pyproject.toml",
                symbol_name="pyproject.toml",
                module_path="pyproject.toml",
                artifact_kind="repo_map",
                content_format="toml",
                metadata={
                    **_python_metadata(
                        text=text, rel_path="pyproject.toml", artifact_kind="repo_map", symbol_kind="project_config"
                    ),
                    "repo_map_json": map_json,
                },
            )
        )
    chunks.extend(_extract_python_repo_map(source_root, config=config, tag=tag))
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks


def _xml_text(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return "".join(node.itertext()).strip()


GODOT_LIFECYCLE_CALLBACKS = (
    "_enter_tree",
    "_ready",
    "_process",
    "_physics_process",
    "_exit_tree",
    "_input",
    "_unhandled_input",
)


def _unique_metadata_values(*groups: Any) -> list[str]:
    values: list[str] = []
    for group in groups:
        if isinstance(group, list):
            candidates = group
        elif isinstance(group, (tuple, set)):
            candidates = list(group)
        elif isinstance(group, str):
            candidates = group.split(",")
        else:
            candidates = []
        for item in candidates:
            text = str(item).strip()
            if text and text not in values:
                values.append(text)
    return values


def _godot_lifecycle_callbacks(text: str) -> list[str]:
    return [callback for callback in GODOT_LIFECYCLE_CALLBACKS if callback in text]


def _godot_migration_topics(text: str) -> list[str]:
    lower = text.lower()
    topics: list[str] = []
    if "godot 3" in lower or "3.x" in lower or "migration" in lower or "legacy" in lower:
        topics.append("godot-3-to-4")
    if "signal" in lower or "connect" in lower or "await" in lower:
        topics.append("signal-api")
    if "scene tree" in lower or "node" in lower:
        topics.append("node-lifecycle")
    if "shader" in lower:
        topics.append("shader-language")
    if "physics" in lower:
        topics.append("physics")
    return topics


def _godot_scene_tree_role(text: str, *, artifact_kind: str, symbol_kind: str = "") -> str:
    lower = text.lower()
    if artifact_kind == "engine_proposal" or "migration" in lower:
        return "migration"
    if symbol_kind == "signal" or "signal" in lower or "connect" in lower:
        return "signal-contract"
    if _godot_lifecycle_callbacks(text) or "scene tree" in lower:
        return "node-lifecycle"
    if artifact_kind == "shader_language" or "shader" in lower:
        return "rendering"
    if "physics" in lower:
        return "physics"
    if any(token in lower for token in ("button", "control", "ui", "container")):
        return "ui-control"
    return "reference"


def _godot_signal_args(signal: ET.Element) -> list[str]:
    return [
        f"{param.attrib.get('name', '')}: {param.attrib.get('type', '')}".strip()
        for param in signal.findall("param")
        if param.attrib.get("name") or param.attrib.get("type")
    ]


def _godot_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str, symbol_kind: str = "") -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "class_reference":
        return "godot_class_reference_architect_v1"
    if artifact_kind == "shader_language" or "shader" in lower or "rendering" in rel_path.lower():
        return "godot_shader_architect_v1"
    if artifact_kind == "engine_proposal":
        return "godot_proposal_architect_v1"
    if any(token in lower for token in ("scene tree", "signal", "_ready", "_process", "_enter_tree", "node lifecycle")):
        return "godot_scene_tree_architect_v1"
    return GODOT_PROMPT_ID


def _godot_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "godot", "godot-4"]
    if artifact_kind == "class_reference":
        tags.append("class-reference")
    if "signal" in lower or symbol_kind == "signal":
        tags.append("signals")
    if any(token in lower for token in ("scene tree", "_ready", "_enter_tree", "_process", "_physics_process")):
        tags.extend(["scene-tree", "node-lifecycle"])
    if artifact_kind == "shader_language" or "shader" in lower:
        tags.extend(["shader-language", "rendering", "gpu"])
    if artifact_kind == "engine_proposal":
        tags.extend(["proposal", "legacy-migration"])
    if "physics" in lower:
        tags.append("physics")
    return {
        "scope_tags": tags,
        "engine_major_version": "4",
        "lifecycle_callbacks": _godot_lifecycle_callbacks(text),
        "migration_topics": _godot_migration_topics(f"{rel_path}\n{text}"),
        "scene_tree_role": _godot_scene_tree_role(text, artifact_kind=artifact_kind, symbol_kind=symbol_kind),
        "constraint_kind": "hard" if artifact_kind in {"class_reference", "shader_language"} else "guiding",
        "constraint_source": "godot-class-reference"
        if artifact_kind == "class_reference"
        else "godot-proposals"
        if artifact_kind == "engine_proposal"
        else "godot-docs",
        "content_profile": "reference",
        "prompt_id": prompt_id
        or _godot_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind=symbol_kind),
    }


def _godot_class_row(
    *,
    repo: str,
    tag: str,
    rel_path: str,
    class_name: str,
    text: str,
    symbol_kind: str,
    symbol_name: str,
    symbol_fqn: str,
    metadata_extra: dict[str, Any] | None = None,
) -> LanguageChunk:
    metadata = _godot_metadata(text=text, rel_path=rel_path, artifact_kind="class_reference", symbol_kind=symbol_kind)
    if metadata_extra:
        metadata.update(metadata_extra)
    return LanguageChunk(
        text=text,
        doc_id=f"godot:{repo}:{rel_path}:{symbol_fqn}",
        chunk_index=0,
        document_name=rel_path,
        heading_path=symbol_fqn,
        section=symbol_name,
        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
        package_name="godot-class-reference",
        symbol_kind=symbol_kind,
        symbol_fqn=symbol_fqn,
        symbol_name=symbol_name,
        module_path=rel_path,
        artifact_kind="class_reference",
        content_format="xml",
        metadata=metadata,
    )


def _extract_godot_class_reference(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/godotengine/godot")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    root = source_root / str(include.get("class_reference", "doc/classes"))
    chunks: list[LanguageChunk] = []
    if not root.exists():
        return chunks
    for file_path in sorted(root.glob("*.xml")):
        rel_path = file_path.relative_to(source_root).as_posix()
        try:
            tree = ET.parse(file_path)
        except ET.ParseError:
            continue
        class_el = tree.getroot()
        class_name = class_el.attrib.get("name", file_path.stem)
        inherits = class_el.attrib.get("inherits", "")
        brief = _xml_text(class_el.find("brief_description"))
        desc = _xml_text(class_el.find("description"))
        methods = []
        signals = []
        properties = []
        constants = []
        method_refs: list[str] = []
        signal_refs: list[str] = []
        property_refs: list[str] = []
        constant_refs: list[str] = []
        for method in class_el.findall("./methods/method"):
            name = method.attrib.get("name", "")
            return_type = method.find("return")
            ret = return_type.attrib.get("type", "") if return_type is not None else ""
            args = [f"{a.attrib.get('name', '')}: {a.attrib.get('type', '')}" for a in method.findall("param")]
            methods.append(f"{name}({', '.join(args)}) -> {ret}".strip())
            if name:
                method_refs.append(f"{class_name}.{name}")
        for signal in class_el.findall("./signals/signal"):
            name = signal.attrib.get("name", "")
            args = _godot_signal_args(signal)
            signals.append(f"{name}({', '.join(args)})")
            if name:
                signal_refs.append(f"{class_name}.{name}")
        for prop in class_el.findall("./members/member"):
            name = prop.attrib.get("name", "")
            properties.append(f"{name}: {prop.attrib.get('type', '')}")
            if name:
                property_refs.append(f"{class_name}.{name}")
        for const in class_el.findall("./constants/constant"):
            name = const.attrib.get("name", "")
            constants.append(f"{name}={const.attrib.get('value', '')}")
            if name:
                constant_refs.append(f"{class_name}.{name}")
        class_text = "\n".join(
            [
                f"Class: {class_name}",
                f"Inherits: {inherits}" if inherits else "",
                f"Brief: {brief}" if brief else "",
                f"Description: {desc}" if desc else "",
                "Methods:\n" + "\n".join(f"- {m}" for m in methods[:50]) if methods else "",
                "Signals:\n" + "\n".join(f"- {s}" for s in signals[:50]) if signals else "",
                "Properties:\n" + "\n".join(f"- {p}" for p in properties[:50]) if properties else "",
                "Constants:\n" + "\n".join(f"- {c}" for c in constants[:50]) if constants else "",
            ]
        ).strip()
        chunks.append(
            _godot_class_row(
                repo=repo,
                tag=tag,
                rel_path=rel_path,
                class_name=class_name,
                text=class_text,
                symbol_kind="class",
                symbol_name=class_name,
                symbol_fqn=class_name,
                metadata_extra={
                    "node_class": class_name,
                    "inherits": inherits,
                    "implements_refs": [inherits] if inherits else [],
                    "contains_refs": [*method_refs, *signal_refs, *property_refs, *constant_refs],
                    "signal_list": signals,
                },
            )
        )
        for signal in class_el.findall("./signals/signal"):
            name = signal.attrib.get("name", "")
            args = _godot_signal_args(signal)
            text = f"Signal: {class_name}.{name}({', '.join(args)})\n\n{_xml_text(signal.find('description'))}".strip()
            chunks.append(
                _godot_class_row(
                    repo=repo,
                    tag=tag,
                    rel_path=rel_path,
                    class_name=class_name,
                    text=text,
                    symbol_kind="signal",
                    symbol_name=name,
                    symbol_fqn=f"{class_name}.{name}",
                    metadata_extra={
                        "node_class": class_name,
                        "member_of": class_name,
                        "signal_name": name,
                        "signal_args": args,
                    },
                )
            )
        for method in class_el.findall("./methods/method"):
            name = method.attrib.get("name", "")
            return_type = method.find("return")
            ret = return_type.attrib.get("type", "") if return_type is not None else ""
            args = [f"{a.attrib.get('name', '')}: {a.attrib.get('type', '')}" for a in method.findall("param")]
            text = f"Method: {class_name}.{name}({', '.join(args)}) -> {ret}\n\n{_xml_text(method.find('description'))}".strip()
            chunks.append(
                _godot_class_row(
                    repo=repo,
                    tag=tag,
                    rel_path=rel_path,
                    class_name=class_name,
                    text=text,
                    symbol_kind="method",
                    symbol_name=name,
                    symbol_fqn=f"{class_name}.{name}",
                    metadata_extra={
                        "node_class": class_name,
                        "member_of": class_name,
                        "lifecycle_callbacks": _godot_lifecycle_callbacks(name),
                    },
                )
            )
        for prop in class_el.findall("./members/member"):
            name = prop.attrib.get("name", "")
            text = f"Property: {class_name}.{name}: {prop.attrib.get('type', '')}\n\n{_xml_text(prop)}".strip()
            chunks.append(
                _godot_class_row(
                    repo=repo,
                    tag=tag,
                    rel_path=rel_path,
                    class_name=class_name,
                    text=text,
                    symbol_kind="property",
                    symbol_name=name,
                    symbol_fqn=f"{class_name}.{name}",
                    metadata_extra={"node_class": class_name, "member_of": class_name},
                )
            )
        for const in class_el.findall("./constants/constant"):
            name = const.attrib.get("name", "")
            text = f"Constant: {class_name}.{name} = {const.attrib.get('value', '')}\n\n{_xml_text(const)}".strip()
            chunks.append(
                _godot_class_row(
                    repo=repo,
                    tag=tag,
                    rel_path=rel_path,
                    class_name=class_name,
                    text=text,
                    symbol_kind="constant",
                    symbol_name=name,
                    symbol_fqn=f"{class_name}.{name}",
                    metadata_extra={"node_class": class_name, "member_of": class_name},
                )
            )
    return chunks


def _extract_godot_docs(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        aux_root = source_root / name
        if not aux_root.exists():
            continue
        repo = str(aux.get("repo") or "")
        path = str(aux.get("path") or ".")
        artifact_kind = str(aux.get("artifact_kind") or "engine_manual")
        package_name = str(aux.get("package_name") or name)
        for chunk in _doc_chunks(
            aux_root,
            [path],
            language="godot",
            repo=repo,
            tag=str(aux.get("resolved_ref") or "main"),
            package_name=package_name,
            artifact_kind=artifact_kind,
            prompt_id=str(aux.get("prompt_id") or ""),
        ):
            chunk.metadata.update(
                _godot_metadata(
                    text=chunk.text,
                    rel_path=chunk.module_path,
                    artifact_kind=artifact_kind,
                    prompt_id=str(aux.get("prompt_id") or ""),
                )
            )
            chunks.append(chunk)
    return chunks


def _extract_godot_shader_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/godotengine/godot")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    roots = [str(x) for x in include.get("shader_roots", ["servers/rendering"])]
    chunks: list[LanguageChunk] = []
    for rel in roots:
        root = source_root / rel
        if not root.exists():
            continue
        for file_path in sorted(root.rglob("*")):
            if not file_path.is_file() or file_path.suffix.lower() not in {".h", ".cpp", ".glsl", ".inc", ".gdshader"}:
                continue
            rel_path = file_path.relative_to(source_root).as_posix()
            text = _read_text(file_path)
            if "shader" not in f"{rel_path}\n{text[:2000]}".lower():
                continue
            for part in _split_text(text, max_chars=6500)[:4]:
                heading = file_path.stem
                chunks.append(
                    LanguageChunk(
                        text=part,
                        doc_id=f"godot:{repo}:{rel_path}:{len(chunks)}",
                        chunk_index=len(chunks),
                        document_name=rel_path,
                        heading_path=heading,
                        section=heading,
                        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                        package_name="godot-shader-language",
                        symbol_kind="shader_source",
                        symbol_fqn=heading,
                        symbol_name=heading,
                        module_path=rel_path,
                        artifact_kind="shader_language",
                        content_format=file_path.suffix.lstrip(".") or "text",
                        metadata=_godot_metadata(
                            text=part, rel_path=rel_path, artifact_kind="shader_language", symbol_kind="shader_source"
                        ),
                    )
                )
    return chunks


def _godot_word_present(needle: str, haystack: str) -> bool:
    if not needle:
        return False
    return bool(re.search(rf"(?<![A-Za-z0-9_]){re.escape(needle)}(?![A-Za-z0-9_])", haystack))


def _attach_godot_doc_references(chunks: list[LanguageChunk]) -> None:
    class_names = sorted(
        {
            chunk.symbol_fqn
            for chunk in chunks
            if chunk.artifact_kind == "class_reference" and chunk.symbol_kind == "class" and chunk.symbol_fqn
        },
        key=len,
        reverse=True,
    )
    symbol_fqns = sorted(
        {
            chunk.symbol_fqn
            for chunk in chunks
            if chunk.artifact_kind == "class_reference" and chunk.symbol_kind != "class" and chunk.symbol_fqn
        },
        key=len,
        reverse=True,
    )
    signals_by_leaf: dict[str, list[str]] = {}
    for chunk in chunks:
        if chunk.artifact_kind != "class_reference" or chunk.symbol_kind != "signal" or not chunk.symbol_fqn:
            continue
        signals_by_leaf.setdefault(chunk.symbol_name, []).append(chunk.symbol_fqn)
    unique_signals = {leaf: refs[0] for leaf, refs in signals_by_leaf.items() if leaf and len(refs) == 1}

    for chunk in chunks:
        if chunk.artifact_kind == "class_reference":
            continue
        haystack = f"{chunk.heading_path}\n{chunk.section}\n{chunk.text}"
        lower = haystack.lower()
        refs: list[str] = []
        for class_name in class_names:
            if _godot_word_present(class_name, haystack):
                refs.append(class_name)
        for symbol_fqn in symbol_fqns:
            if symbol_fqn in haystack:
                refs.append(symbol_fqn)
        if any(token in lower for token in ("signal", "connect", "await")):
            for leaf, signal_fqn in unique_signals.items():
                if _godot_word_present(leaf, haystack):
                    refs.append(signal_fqn)
        for callback in _godot_lifecycle_callbacks(haystack):
            refs.append(f"godot:lifecycle:{callback}")
        if chunk.metadata.get("migration_topics"):
            for topic in chunk.metadata["migration_topics"]:
                refs.append(f"godot:topic:{topic}")
        refs = _unique_metadata_values(chunk.metadata.get("doc_relation_ids"), refs)
        if not refs:
            continue
        chunk.metadata["doc_relation_ids"] = refs
        if chunk.artifact_kind in {"engine_manual", "engine_proposal"}:
            chunk.metadata["documents_refs"] = _unique_metadata_values(chunk.metadata.get("documents_refs"), refs)


def extract_godot_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    chunks.extend(_extract_godot_class_reference(source_root, config=config, tag=tag))
    chunks.extend(_extract_godot_docs(source_root, config=config, tag=tag))
    chunks.extend(_extract_godot_shader_chunks(source_root, config=config, tag=tag))
    _attach_godot_doc_references(chunks)
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks


def _terraform_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str) -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "provider_schema":
        return "terraform_provider_schema_architect_v1"
    if artifact_kind == "iac_policy_rule" or "tflint" in lower or "tfsec" in lower:
        return "terraform_policy_lint_architect_v1"
    if artifact_kind == "opentofu_feature" or "opentofu" in lower or "state encryption" in lower:
        return "opentofu_state_architect_v1"
    return TERRAFORM_PROMPT_ID


def _terraform_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    provider: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "terraform", "iac"]
    if provider:
        tags.append(provider.rsplit("/", 1)[-1].replace("terraform-provider-", ""))
    if artifact_kind == "provider_schema":
        tags.extend(["provider-schema", "hard-constraints"])
    if artifact_kind == "provider_docs":
        tags.append("provider-docs")
    if artifact_kind == "terraform_guide":
        tags.append("terraform-guide")
    if artifact_kind == "opentofu_feature":
        tags.extend(["opentofu", "state-management"])
    if artifact_kind == "iac_policy_rule":
        tags.extend(["policy-as-code", "lint-rule"])
    if any(
        token in lower for token in ("force new", "forcenew", "forces replacement", "destroy", "delete", "replacement")
    ):
        tags.append("destructive-risk")
    if any(token in lower for token in ("import ", "terraform import", "import_id", "import id")):
        tags.append("import-guidance")
    if any(token in lower for token in ("sensitive", "secret", "password", "token", "private_key")):
        tags.append("sensitive-state")
    if any(token in lower for token in ("state", "drift", "refresh", "remote backend")):
        tags.append("state-management")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind == "provider_schema" else "guiding",
        "constraint_source": "terraform-provider-schema"
        if artifact_kind == "provider_schema"
        else "tflint-rules"
        if artifact_kind == "iac_policy_rule"
        else "terraform-docs",
        "content_profile": "reference" if artifact_kind in {"provider_schema", "provider_docs"} else "procedural",
        "provider": provider,
        "prompt_id": prompt_id or _terraform_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind),
    }


def _terraform_artifact_for_aux(aux: dict[str, Any]) -> str:
    explicit = str(aux.get("artifact_kind") or "")
    if explicit:
        return explicit
    name = str(aux.get("name") or "").lower()
    repo = str(aux.get("repo") or "").lower()
    if "opentofu" in name or "opentofu" in repo:
        return "opentofu_feature"
    if "tflint" in name or "tflint" in repo:
        return "iac_policy_rule"
    if "provider" in name or "terraform-provider" in repo:
        return "provider_docs"
    return "terraform_guide"


def _terraform_symbol_from_doc_path(rel_path: str) -> tuple[str, str, str]:
    stem = Path(rel_path).stem
    parts = rel_path.split("/")
    if "resources" in parts:
        return "resource_doc", stem, stem
    if "data-sources" in parts or "data_sources" in parts or "datasources" in parts:
        return "data_source_doc", stem, stem
    return "docs", stem, ""


def _extract_terraform_docs(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/hashicorp/terraform")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for chunk in _doc_chunks(
        source_root,
        [str(x) for x in include.get("docs", ["website/docs"])],
        language="terraform",
        repo=repo,
        tag=tag,
        package_name="terraform",
        artifact_kind="terraform_guide",
        prompt_id=TERRAFORM_PROMPT_ID,
    ):
        kind, name, fqn = _terraform_symbol_from_doc_path(chunk.module_path)
        chunk.symbol_kind = kind
        chunk.symbol_name = name
        chunk.symbol_fqn = fqn
        chunk.metadata.update(
            _terraform_metadata(
                text=chunk.text, rel_path=chunk.module_path, artifact_kind="terraform_guide", symbol_kind=kind
            )
        )
        chunks.append(chunk)

    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        aux_root = source_root / name
        if not aux_root.exists():
            continue
        repo_name = str(aux.get("repo") or "")
        raw_path = aux.get("path") or "."
        paths = [str(path) for path in raw_path] if isinstance(raw_path, list) else [str(raw_path)]
        artifact_kind = _terraform_artifact_for_aux(aux)
        package_name = str(aux.get("package_name") or name or "terraform")
        provider = str(aux.get("provider") or "")
        prompt_id = str(aux.get("prompt_id") or "")
        for chunk in _doc_chunks(
            aux_root,
            paths,
            language="terraform",
            repo=repo_name or repo,
            tag=str(aux.get("resolved_ref") or "main"),
            package_name=package_name,
            artifact_kind=artifact_kind,
            prompt_id=prompt_id,
        ):
            kind, symbol_name, symbol_fqn = _terraform_symbol_from_doc_path(chunk.module_path)
            chunk.symbol_kind = kind
            chunk.symbol_name = symbol_name
            chunk.symbol_fqn = symbol_fqn
            chunk.metadata.update(
                _terraform_metadata(
                    text=chunk.text,
                    rel_path=chunk.module_path,
                    artifact_kind=artifact_kind,
                    symbol_kind=kind,
                    provider=provider,
                    prompt_id=prompt_id,
                )
            )
            chunks.append(chunk)
    return chunks


def _terraform_schema_attr_summary(block: dict[str, Any]) -> dict[str, list[str]]:
    attrs = block.get("attributes") if isinstance(block.get("attributes"), dict) else {}
    out = {"required": [], "optional": [], "computed": [], "sensitive": [], "deprecated": []}
    for name, raw in attrs.items():
        if not isinstance(raw, dict):
            continue
        if raw.get("required"):
            out["required"].append(str(name))
        if raw.get("optional"):
            out["optional"].append(str(name))
        if raw.get("computed"):
            out["computed"].append(str(name))
        if raw.get("sensitive"):
            out["sensitive"].append(str(name))
        if raw.get("deprecated"):
            out["deprecated"].append(str(name))
    return out


def _terraform_schema_chunk(
    *,
    repo: str,
    tag: str,
    rel_path: str,
    provider: str,
    name: str,
    schema: dict[str, Any],
    kind: str,
    index: int,
) -> LanguageChunk:
    block = schema.get("block") if isinstance(schema.get("block"), dict) else {}
    summary = _terraform_schema_attr_summary(block)
    nested = sorted((block.get("block_types") or {}).keys()) if isinstance(block.get("block_types"), dict) else []
    payload = {
        "provider": provider,
        "kind": kind,
        "name": name,
        "version": schema.get("version"),
        "attributes": summary,
        "nested_blocks": nested,
        "schema": schema,
    }
    text = json.dumps(payload, indent=2, sort_keys=True)
    metadata = _terraform_metadata(
        text=text, rel_path=rel_path, artifact_kind="provider_schema", symbol_kind=kind, provider=provider
    )
    metadata.update(
        {
            "terraform_provider": provider,
            "required_attributes": summary["required"],
            "optional_attributes": summary["optional"],
            "computed_attributes": summary["computed"],
            "sensitive_attributes": summary["sensitive"],
            "deprecated_attributes": summary["deprecated"],
        }
    )
    return LanguageChunk(
        text=text[:9000],
        doc_id=f"terraform:{provider}:{rel_path}:{kind}:{name}",
        chunk_index=index,
        document_name=rel_path,
        heading_path=name,
        section=name,
        source_url=f"https://{repo}/blob/{tag}/{rel_path}" if repo else rel_path,
        package_name=provider,
        symbol_kind=kind,
        symbol_fqn=name,
        symbol_name=name,
        module_path=rel_path,
        artifact_kind="provider_schema",
        content_format="json",
        metadata=metadata,
    )


def _extract_terraform_provider_schema_files(
    source_root: Path, *, config: dict[str, Any], tag: str, provider_schema: str | Path = ""
) -> list[LanguageChunk]:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    repo = str(config.get("repo") or "github.com/hashicorp/terraform")
    paths: list[Path] = []
    if provider_schema:
        paths.append(Path(provider_schema))
    for rel in include.get("provider_schema_roots", ["provider-schemas"]):
        root = source_root / str(rel)
        if root.is_file():
            paths.append(root)
        elif root.exists():
            paths.extend(sorted(root.rglob("*.json")))
    chunks: list[LanguageChunk] = []
    for file_path in paths:
        if not file_path.exists() or not file_path.is_file():
            continue
        try:
            data = json.loads(_read_text(file_path))
        except json.JSONDecodeError:
            continue
        provider_schemas = data.get("provider_schemas") if isinstance(data.get("provider_schemas"), dict) else {}
        rel_path = (
            file_path.relative_to(source_root).as_posix() if file_path.is_relative_to(source_root) else file_path.name
        )
        for provider, provider_data in sorted(provider_schemas.items()):
            if not isinstance(provider_data, dict):
                continue
            for kind_key, symbol_kind in (("resource_schemas", "resource"), ("data_source_schemas", "data_source")):
                schemas = provider_data.get(kind_key) if isinstance(provider_data.get(kind_key), dict) else {}
                for name, schema in sorted(schemas.items()):
                    if not isinstance(schema, dict):
                        continue
                    chunks.append(
                        _terraform_schema_chunk(
                            repo=repo,
                            tag=tag,
                            rel_path=rel_path,
                            provider=str(provider),
                            name=str(name),
                            schema=schema,
                            kind=symbol_kind,
                            index=len(chunks),
                        )
                    )
    return chunks


def extract_terraform_chunks(
    source_root: Path, *, config: dict[str, Any], tag: str, provider_schema: str | Path = ""
) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    chunks.extend(_extract_terraform_docs(source_root, config=config, tag=tag))
    chunks.extend(
        _extract_terraform_provider_schema_files(source_root, config=config, tag=tag, provider_schema=provider_schema)
    )
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks


def _ecma_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str) -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "temporal_api" or "temporal." in lower or "plaindate" in lower or "zoneddatetime" in lower:
        return "ecma_temporal_architect_2026_v1"
    if artifact_kind == "typescript_handbook" or "typescript" in lower or "satisfies" in lower or "using " in lower:
        return "typescript_type_safety_architect_v1"
    if artifact_kind == "runtime_api" or any(
        token in lower for token in ("node.js", "bun", "deno", "permission model")
    ):
        return "js_runtime_compat_architect_v1"
    if artifact_kind == "web_api" or "mdn" in lower or "browser" in lower or "web api" in lower:
        return "web_platform_architect_v1"
    return ECMA_PROMPT_ID


def _ecma_runtime_tags(text: str, rel_path: str) -> list[str]:
    lower = f"{rel_path}\n{text}".lower()
    tags: list[str] = []
    if any(token in lower for token in ("node.js", "node:", "node ")):
        tags.append("node")
    if "bun" in lower:
        tags.append("bun")
    if "deno" in lower:
        tags.append("deno")
    if any(token in lower for token in ("browser", "window.", "document.", "web api", "mdn")):
        tags.append("browser")
    if "edge" in lower or "worker" in lower:
        tags.append("edge")
    return tags


def _ecma_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    package_name: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "ecma", "javascript", "typescript"]
    tags.extend(_ecma_runtime_tags(text, rel_path))
    if artifact_kind == "tc39_proposal":
        tags.append("tc39")
    if artifact_kind == "temporal_api":
        tags.extend(["tc39", "temporal", "date-time"])
    if artifact_kind == "typescript_handbook":
        tags.extend(["typescript", "type-safety"])
    if artifact_kind == "runtime_api":
        tags.append("runtime-api")
    if artifact_kind == "web_api":
        tags.extend(["web-platform", "browser"])
    if any(token in lower for token in ("type stripping", "type-stripping", "erasable syntax", "satisfies", "using ")):
        tags.append("type-stripping")
    if any(token in lower for token in ("esm", "module", "commonjs", "require(")):
        tags.append("module-system")
    if any(token in lower for token in ("promise.withresolvers", "top-level await", "eventemitter", "stream")):
        tags.append("async")
    if any(token in lower for token in ("tree-shake", "bundle", "commonjs monster", "side effect")):
        tags.append("bundle-impact")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard"
        if artifact_kind in {"ecma_spec", "temporal_api", "typescript_handbook"}
        else "guiding",
        "constraint_source": "tc39"
        if artifact_kind in {"ecma_spec", "tc39_proposal", "temporal_api"}
        else "typescript-docs"
        if artifact_kind == "typescript_handbook"
        else "runtime-docs"
        if artifact_kind == "runtime_api"
        else "mdn",
        "content_profile": "reference",
        "package_name": package_name,
        "prompt_id": prompt_id or _ecma_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind),
    }


def _ecma_artifact_for_aux(aux: dict[str, Any], text: str = "", rel_path: str = "") -> str:
    explicit = str(aux.get("artifact_kind") or "")
    if explicit:
        if explicit == "tc39_proposal" and ("temporal" in f"{rel_path}\n{text}".lower() or "Temporal." in text):
            return "temporal_api"
        return explicit
    name = str(aux.get("name") or "").lower()
    repo = str(aux.get("repo") or "").lower()
    haystack = f"{name}\n{repo}\n{rel_path}\n{text}".lower()
    if "temporal" in haystack:
        return "temporal_api"
    if "tc39" in haystack or "proposal" in haystack:
        return "tc39_proposal"
    if "typescript" in haystack:
        return "typescript_handbook"
    if any(token in haystack for token in ("node", "bun", "deno")):
        return "runtime_api"
    if "mdn" in haystack or "content" in haystack:
        return "web_api"
    return "ecma_spec"


def _ecma_symbol_from_path(rel_path: str, text: str) -> tuple[str, str, str]:
    lower = f"{rel_path}\n{text[:1000]}".lower()
    if "temporal" in lower:
        names = re.findall(r"\bTemporal\.[A-Za-z][A-Za-z0-9_.]*", text)
        fqn = names[0] if names else "Temporal"
        return "temporal_api", fqn.rsplit(".", 1)[-1], fqn
    if rel_path.endswith(".json") or Path(rel_path).name in {"package.json", "tsconfig.json", "deno.json"}:
        return "runtime_config", Path(rel_path).name, Path(rel_path).name
    stem = Path(rel_path).stem
    return "docs", stem, ""


def extract_ecma_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/tc39/proposals")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    aux_names = {
        str(aux.get("name") or "")
        for aux in include.get("aux_sources", [])
        if isinstance(aux, dict) and aux.get("name")
    }
    chunks: list[LanguageChunk] = []
    for chunk in _doc_chunks(
        source_root,
        [str(x) for x in include.get("docs", ["."])],
        language="ecma",
        repo=repo,
        tag=tag,
        package_name="ecma",
        artifact_kind="ecma_spec",
        prompt_id=ECMA_PROMPT_ID,
    ):
        if chunk.module_path.split("/", 1)[0] in aux_names:
            continue
        artifact_kind = (
            "temporal_api"
            if "temporal" in f"{chunk.module_path}\n{chunk.text}".lower()
            else "tc39_proposal"
            if chunk.module_path.startswith("proposal-")
            else "ecma_spec"
        )
        symbol_kind, symbol_name, symbol_fqn = _ecma_symbol_from_path(chunk.module_path, chunk.text)
        chunk.artifact_kind = artifact_kind
        chunk.symbol_kind = symbol_kind
        chunk.symbol_name = symbol_name
        chunk.symbol_fqn = symbol_fqn
        chunk.metadata.update(
            _ecma_metadata(
                text=chunk.text,
                rel_path=chunk.module_path,
                artifact_kind=artifact_kind,
                symbol_kind=symbol_kind,
                package_name="ecma",
            )
        )
        chunks.append(chunk)

    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        aux_root = source_root / name
        if not aux_root.exists():
            continue
        repo_name = str(aux.get("repo") or "")
        path = str(aux.get("path") or ".")
        package_name = str(aux.get("package_name") or name or "ecma")
        prompt_id = str(aux.get("prompt_id") or "")
        for chunk in _doc_chunks(
            aux_root,
            [path],
            language="ecma",
            repo=repo_name or repo,
            tag=str(aux.get("resolved_ref") or "main"),
            package_name=package_name,
            artifact_kind=str(aux.get("artifact_kind") or "docs"),
            prompt_id=prompt_id,
        ):
            artifact_kind = _ecma_artifact_for_aux(aux, chunk.text, chunk.module_path)
            symbol_kind, symbol_name, symbol_fqn = _ecma_symbol_from_path(chunk.module_path, chunk.text)
            chunk.artifact_kind = artifact_kind
            chunk.symbol_kind = symbol_kind
            chunk.symbol_name = symbol_name
            chunk.symbol_fqn = symbol_fqn
            chunk.metadata.update(
                _ecma_metadata(
                    text=chunk.text,
                    rel_path=chunk.module_path,
                    artifact_kind=artifact_kind,
                    symbol_kind=symbol_kind,
                    package_name=package_name,
                    prompt_id=prompt_id,
                )
            )
            chunks.append(chunk)
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks


def parse_enrichment_response(raw: str, *, required_fields: set[str] | None = None) -> dict[str, Any]:
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SynPackError(f"enrichment response is not JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise SynPackError("enrichment response must be a single JSON object")
    missing = (required_fields or REQUIRED_UNIVERSAL_ENRICHMENT_FIELDS) - set(obj)
    if missing:
        raise SynPackError(f"enrichment response missing fields: {', '.join(sorted(missing))}")
    return obj


def _source_quality_metadata(chunk: LanguageChunk) -> dict[str, Any]:
    keys = (
        "source_quality_score",
        "source_quality_status",
        "source_quality_reason",
        "original_content_format",
        "normalized_content_format",
    )
    return {key: chunk.metadata[key] for key in keys if key in chunk.metadata}


def _attach_source_quality(enrichment: dict[str, Any], chunk: LanguageChunk) -> dict[str, Any]:
    out = _ensure_v2_enrichment_defaults(enrichment)
    quality = _source_quality_metadata(chunk)
    if not quality:
        return out
    out.setdefault("source_quality", quality)
    if quality.get("source_quality_status") == "warn":
        warnings = out.get("hidden_warnings")
        if not isinstance(warnings, list):
            warnings = [str(warnings)] if warnings else []
        reason = str(quality.get("source_quality_reason") or "source quality warning")
        if reason and reason not in warnings:
            warnings.append(reason)
        out["hidden_warnings"] = warnings
    return out


def _ensure_v2_enrichment_defaults(enrichment: dict[str, Any]) -> dict[str, Any]:
    out = dict(enrichment)
    for key in SYNPACK_V2_ARRAY_ENRICHMENT_FIELDS:
        value = out.get(key)
        if value is None or value == "":
            out[key] = []
        elif not isinstance(value, list):
            out[key] = [value]
    for key in SYNPACK_V2_SCALAR_ENRICHMENT_FIELDS:
        out.setdefault(key, "unknown")
    return out


def _chunk_identity_metadata(chunk: LanguageChunk) -> dict[str, str]:
    return {
        "document_name": chunk.document_name,
        "heading_path": chunk.heading_path,
        "section": chunk.section,
        "package_name": chunk.package_name,
        "module_path": chunk.module_path,
        "symbol_kind": chunk.symbol_kind,
        "symbol_name": chunk.symbol_name,
        "symbol_fqn": chunk.symbol_fqn,
        "artifact_kind": chunk.artifact_kind,
        "source_url": chunk.source_url,
        "prompt_id": chunk.prompt_id,
    }


def _string_list(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            if isinstance(item, dict):
                text = str(
                    item.get("symbol")
                    or item.get("name")
                    or item.get("text")
                    or item.get("query")
                    or item.get("intent")
                    or item.get("summary")
                    or ""
                ).strip()
            else:
                text = str(item).strip()
            if text:
                out.append(text)
        return out
    if isinstance(value, dict):
        return [str(v).strip() for v in value.values() if str(v).strip()]
    return [part.strip() for part in str(value).split(",") if part.strip()]


def _chunk_identity_terms(chunk: LanguageChunk) -> list[str]:
    terms = [
        chunk.symbol_fqn,
        chunk.symbol_name,
        chunk.package_name,
        f"{chunk.package_name}.{chunk.symbol_name}" if chunk.package_name and chunk.symbol_name else "",
        f"{chunk.package_name}::{chunk.symbol_name}" if chunk.package_name and chunk.symbol_name else "",
        f"{chunk.package_name} {chunk.symbol_name}" if chunk.package_name and chunk.symbol_name else "",
        chunk.module_path,
        chunk.heading_path,
        chunk.document_name,
        chunk.artifact_kind,
        chunk.symbol_kind,
    ]
    return [term for term in terms if term]


def _retrieval_terms(chunk: LanguageChunk, enrichment: dict[str, Any]) -> list[str]:
    seen: set[str] = set()
    terms: list[str] = []
    for term in _chunk_identity_terms(chunk):
        if term not in seen:
            seen.add(term)
            terms.append(term)
    for key in (
        "query_aliases",
        "agent_query_hints",
        "task_intents",
        "verification_hints",
        "related_interfaces",
        "related_symbols",
        "hidden_warnings",
        "anti_patterns",
    ):
        for term in _string_list(enrichment.get(key)):
            if term not in seen:
                seen.add(term)
                terms.append(term)
    return terms[:80]


def _embedding_input(chunk: LanguageChunk, enrichment: dict[str, Any]) -> str:
    identity = " | ".join(_chunk_identity_terms(chunk))
    retrieval = " | ".join(_retrieval_terms(chunk, enrichment))
    hook = str(enrichment.get("agent_hook") or "").strip()
    parts = [
        f"IDENTIFIERS: {identity}" if identity else "",
        f"RETRIEVAL_TERMS: {retrieval}" if retrieval else "",
        f"AGENT_HOOK: {hook}" if hook else "",
        chunk.text,
    ]
    return "\n\n".join(part for part in parts if part).strip()


def _zero_quality_enrichment_skip_reason(chunk: LanguageChunk) -> str:
    quality = _source_quality_metadata(chunk)
    raw_score = quality.get("source_quality_score")
    try:
        score = float(raw_score)
    except (TypeError, ValueError):
        return ""
    if score > 0.0:
        return ""
    reason = str(quality.get("source_quality_reason") or "no source quality signal").strip()
    return f"source_quality_score=0.0; LLM enrichment skipped ({reason})"


def fallback_enrichment(chunk: LanguageChunk, *, error: str = "") -> dict[str, Any]:
    language = str(
        chunk.metadata.get("language")
        or (
            "Rust"
            if chunk.doc_id.startswith("rust:")
            else "Quarkus"
            if chunk.doc_id.startswith("quarkus:")
            else "Python"
            if chunk.doc_id.startswith("python:")
            else "Godot"
            if chunk.doc_id.startswith("godot:")
            else "Terraform"
            if chunk.doc_id.startswith("terraform:")
            else "Ecma"
            if chunk.doc_id.startswith("ecma:")
            else "Bash"
            if chunk.doc_id.startswith("bash:")
            else "Go"
        )
    )
    if language.lower() == "rust":
        edition_scope = (
            chunk.metadata.get("edition_scope") if isinstance(chunk.metadata.get("edition_scope"), list) else []
        )
        return {
            "agent_hook": f"Use this Rust {chunk.symbol_kind or 'documentation'} chunk for {chunk.package_name or chunk.document_name}.",
            "perf_tier": "unknown",
            "safety_contract": "Validate ownership, borrowing, Send/Sync, panic, unsafe, and edition-specific constraints against the source text.",
            "lifecycle_model": "No model-derived lifecycle summary is available; rely on the official source content in this chunk.",
            "edition_scope": edition_scope,
            "async_contract": {
                "runtime_agnostic": "unknown",
                "blocking_risk": "unknown",
                "pinning_required": "unknown",
                "cancel_safety": "unknown",
                "requires_send": "unknown",
            },
            "borrow_contract": "unknown",
            "lifetime_capture": "unknown",
            "send_sync": "unknown",
            "panic_risk": "unknown",
            "unsafe_contract": "unknown",
            "ffi_risk": "unknown",
            "drop_semantics": "unknown",
            "feature_gate_or_stability": "unknown",
            "error_context": chunk.symbol_fqn if chunk.symbol_kind == "compiler_error" else "",
            "api_contract": "unknown",
            "version_scope": ",".join(str(item) for item in edition_scope) if edition_scope else "unknown",
            "performance_notes": "unknown",
            "task_intents": [chunk.artifact_kind] if chunk.artifact_kind else [],
            "query_aliases": _chunk_identity_terms(chunk),
            "verification_hints": ["cargo check", "cargo test", "cargo clippy"],
            "related_interfaces": [],
            "related_symbols": [],
            "canonical_examples": [],
            "anti_patterns": [],
            "hidden_warnings": [error] if error else [],
            "agent_actions": [],
            "evidence_spans": [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() == "python":
        if chunk.artifact_kind == "repo_map":
            repo_map = (
                chunk.metadata.get("repo_map_json") if isinstance(chunk.metadata.get("repo_map_json"), dict) else {}
            )
            return {
                "agent_hook": f"Use this Python repo-map row to orient before searching implementation files for {chunk.symbol_fqn or chunk.document_name}.",
                "perf_tier": "unknown",
                "safety_contract": "Use this as navigation metadata, not source-of-truth code behavior.",
                "lifecycle_model": "Repository topology and module intent map.",
                **repo_map,
                "enrichment_status": "fallback",
                "enrichment_error": error,
            }
        return {
            "agent_hook": f"Use this Python {chunk.symbol_kind or 'documentation'} chunk for {chunk.package_name or chunk.document_name}.",
            "perf_tier": "unknown",
            "safety_contract": "Validate Python version, free-threading, subinterpreter, async, typing, and environment constraints against the source text.",
            "lifecycle_model": "No model-derived lifecycle summary is available; rely on the official Python content in this chunk.",
            "thread_model": "unknown",
            "typing_strategy": "unknown",
            "async_contract": "unknown",
            "dependency_footprint": "unknown",
            "modern_idiom": "unknown",
            "environment_hint": "",
            "subinterpreter_safety": "unknown",
            "free_threading_risk": "unknown",
            "t_string_guidance": "unknown",
            "type_resolution_hint": "unknown",
            "hidden_warnings": [error] if error else [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() == "terraform":
        return {
            "agent_hook": f"Use this Terraform {chunk.symbol_kind or 'documentation'} chunk for {chunk.symbol_fqn or chunk.document_name}; validate with fmt, validate, and plan JSON before apply.",
            "perf_tier": "unknown",
            "safety_contract": "Treat infrastructure changes as stateful. Validate provider schema, plan actions, replacement risk, permissions, drift, imports, and sensitive state before execution.",
            "lifecycle_model": "No model-derived dependency lifecycle is available; rely on provider schema, Terraform graph, and plan JSON for final risk.",
            "core_safety": "unknown",
            "destroy_triggers": [],
            "force_new_confidence": "unknown",
            "permission_requirements": "unknown",
            "cross_resource_links": [],
            "drift_risk": "unknown",
            "provisioner_safe": "unknown",
            "import_id_format": "unknown",
            "state_sensitivity": "unknown",
            "approval_policy": "Require human approval for delete or delete/create plan actions.",
            "plan_guardrail": "Run terraform plan -out=tfplan and terraform show -json tfplan, then analyze destructive actions before apply.",
            "cloud_provider": str(chunk.metadata.get("provider") or "unknown"),
            "resource_weight": "unknown",
            "validation_hints": ["terraform fmt -check -recursive", "terraform validate", "terraform plan -out=tfplan"],
            "hidden_warnings": [error] if error else [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() in {"ecma", "javascript", "typescript"}:
        return {
            "agent_hook": f"Use this Ecma/JS/TS {chunk.symbol_kind or 'documentation'} chunk for {chunk.symbol_fqn or chunk.document_name}; verify runtime, module system, and TypeScript posture before suggesting code.",
            "perf_tier": "unknown",
            "safety_contract": "Validate runtime compatibility, TypeScript strictness/type-stripping, async behavior, module system, bundle impact, and memory lifecycle against project config.",
            "lifecycle_model": "No model-derived lifecycle summary is available; rely on runtime docs, package config, and source text.",
            "runtime_compatibility": [],
            "runtime_env": "unknown",
            "ts_safety": "unknown",
            "ts_contract": "unknown",
            "async_flavor": "unknown",
            "bundle_impact": "unknown",
            "memory_impact": "unknown",
            "modern_idiom": "unknown",
            "module_system": "unknown",
            "type_stripping_status": "unknown",
            "permission_model": "unknown",
            "dependency_advice": "unknown",
            "timezone_dependency": "unknown",
            "dst_awareness": "unknown",
            "runtime_status": "unknown",
            "comparison_logic": "unknown",
            "temporal_type": chunk.symbol_fqn if chunk.symbol_kind == "temporal_api" else "",
            "legacy_date_replacement": "unknown",
            "calendar_safety": "unknown",
            "hidden_warnings": [error] if error else [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() == "godot":
        signal_list = chunk.metadata.get("signal_list") if isinstance(chunk.metadata.get("signal_list"), list) else []
        signal_args = chunk.metadata.get("signal_args") if isinstance(chunk.metadata.get("signal_args"), list) else []
        lifecycle_callbacks = (
            chunk.metadata.get("lifecycle_callbacks")
            if isinstance(chunk.metadata.get("lifecycle_callbacks"), list)
            else _godot_lifecycle_callbacks(chunk.text)
        )
        migration_topics = (
            chunk.metadata.get("migration_topics") if isinstance(chunk.metadata.get("migration_topics"), list) else []
        )
        return {
            "agent_hook": f"Use this Godot {chunk.symbol_kind or 'documentation'} chunk for {chunk.symbol_fqn or chunk.document_name}.",
            "perf_tier": "unknown",
            "safety_contract": "Validate scene-tree lifecycle, signal routing, threading, rendering/physics boundaries, and Godot 4.x API behavior against the source text.",
            "lifecycle_model": "No model-derived lifecycle summary is available; rely on the official Godot class/docs source in this chunk.",
            "node_class": str(
                chunk.metadata.get("node_class") or (chunk.symbol_fqn if chunk.symbol_kind == "class" else "") or ""
            ),
            "inherits": str(chunk.metadata.get("inherits") or ""),
            "member_of": str(chunk.metadata.get("member_of") or ""),
            "signal_name": str(
                chunk.metadata.get("signal_name") or (chunk.symbol_name if chunk.symbol_kind == "signal" else "")
            ),
            "signal_args": signal_args,
            "lifecycle_callbacks": lifecycle_callbacks,
            "scene_tree_role": str(
                chunk.metadata.get("scene_tree_role")
                or _godot_scene_tree_role(chunk.text, artifact_kind=chunk.artifact_kind, symbol_kind=chunk.symbol_kind)
            ),
            "engine_major_version": str(chunk.metadata.get("engine_major_version") or "4"),
            "migration_topics": migration_topics,
            "node_compatibility": "unknown",
            "signal_list": signal_list,
            "signal_contract": "unknown",
            "gdscript_idiom": "unknown",
            "thread_safety": "unknown",
            "performance_note": "unknown",
            "common_node_patterns": "unknown",
            "scene_tree_impact": "unknown",
            "lifecycle_order": "unknown",
            "physics_rendering_boundary": "unknown",
            "legacy_3x_warning": "unknown",
            "hidden_warnings": [error] if error else [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() == "quarkus":
        if chunk.artifact_kind == "cli_command":
            return {
                "agent_hook": f"Use this Quarkus CLI command chunk for {chunk.symbol_fqn or chunk.document_name}.",
                "perf_tier": "unknown",
                "safety_contract": "Check whether the command is read-only, project-modifying, destructive, build-triggering, or long-running before suggesting execution.",
                "lifecycle_model": "No model-derived CLI lifecycle summary is available; rely on the official command source.",
                "command_intent": "unknown",
                "context_requirement": "unknown",
                "interactive_features": "unknown",
                "associated_extensions": [],
                "common_flags": [],
                "agent_advice": "Prefer Quarkus CLI commands over manual Maven/Gradle edits when they preserve platform BOM alignment.",
                "enrichment_status": "fallback",
                "enrichment_error": error,
                "hidden_warnings": [error] if error else [],
            }
        return {
            "agent_hook": f"Use this Quarkus {chunk.symbol_kind or 'documentation'} chunk for {chunk.package_name or chunk.document_name}.",
            "perf_tier": "unknown",
            "safety_contract": "Validate build-time vs runtime config, reactive blocking boundaries, CDI scope, extension dependency, and native-image constraints against the source text.",
            "lifecycle_model": "No model-derived lifecycle summary is available; rely on the official Quarkus docs/source in this chunk.",
            "build_time_config": [],
            "reactive_flavor": "unknown",
            "native_image_note": "unknown",
            "dev_services": "unknown",
            "extension_dependency": "unknown",
            "cdi_scope": "unknown",
            "event_loop_safety": "unknown",
            "config_phase": "unknown",
            "agent_advice": "",
            "hidden_warnings": [error] if error else [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() in {"bash", "shell", "sh"}:
        return {
            "agent_hook": f"Use this shell {chunk.symbol_kind or 'pattern'} chunk for {chunk.symbol_fqn or chunk.document_name}; prefer safe quoting, explicit checks, and a shellcheck/shfmt/test feedback loop.",
            "perf_tier": "unknown",
            "safety_contract": "Validate quoting, word splitting, globbing, command substitution, traps, tempfiles, permissions, destructive commands, and ShellCheck diagnostics against the source text.",
            "lifecycle_model": "Shell script execution lifecycle: parse with bash -n, lint with shellcheck, format with shfmt, test with bats or fixture scripts, and clean up resources with traps.",
            "shell_dialect": str(chunk.metadata.get("shell_dialect") or _shell_dialect(chunk.text, chunk.module_path)),
            "portability_scope": "unknown",
            "strict_mode_guidance": "Use strict mode only with understood errexit/nounset/pipefail boundaries; guard expected failures explicitly.",
            "quoting_contract": 'Quote expansions by default, use arrays for multi-word values, and use "$@" for argument forwarding.',
            "error_handling_contract": "Check command exits directly in if/while or with immediate captures; do not mask failures with declare/local assignment.",
            "tempfile_contract": "Use mktemp and trap-based cleanup when temporary paths are needed.",
            "command_safety": str(chunk.metadata.get("command_safety") or "safe"),
            "feedback_loop": ["bash -n", "shellcheck -x", "shfmt -d", "bats"],
            "task_intents": [chunk.artifact_kind] if chunk.artifact_kind else ["shell scripting"],
            "query_aliases": _chunk_identity_terms(chunk),
            "agent_query_hints": ["shellcheck", "safe bash", "quoting", "bash -n", "shfmt"],
            "api_contract": "unknown",
            "version_scope": "unknown",
            "performance_notes": "unknown",
            "canonical_examples": [],
            "anti_patterns": [],
            "verification_hints": ["bash -n script.sh", "shellcheck -x script.sh", "shfmt -d script.sh"],
            "related_interfaces": [],
            "related_symbols": [],
            "agent_actions": ["lint with ShellCheck", "format with shfmt", "run syntax checks", "add fixture tests"],
            "evidence_spans": [],
            "what_to_use": "Safe shell patterns grounded in ShellCheck, shell style guidance, and defensive scripting sources.",
            "when_to_use": "Use for writing, reviewing, or repairing Bash/POSIX shell scripts and developer automation.",
            "do_not_use": "Do not use to justify unquoted expansions, eval, curl-pipe-shell installers, unsafe rm -rf paths, or unchecked cd.",
            "minimal_example": "shellcheck -x script.sh && shfmt -d script.sh && bash -n script.sh",
            "hidden_warnings": [error] if error else [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    return {
        "agent_hook": f"Use this Go {chunk.symbol_kind or 'documentation'} chunk for {chunk.package_name or chunk.document_name}.",
        "perf_tier": "unknown",
        "safety_contract": "Validate API-specific concurrency, error, nil, and lifecycle requirements against the source text.",
        "lifecycle_model": "No model-derived lifecycle summary is available; rely on the official source content in this chunk.",
        "memory_semantics": "",
        "concurrency_contract": "",
        "idiomatic_version": "",
        "zero_value_behavior": "",
        "related_interfaces": [],
        "hidden_warnings": [error] if error else [],
        "enrichment_status": "fallback",
        "enrichment_error": error,
    }


class OpenAICompatibleEnrichmentClient:
    def __init__(
        self,
        *,
        base_url: str,
        model: str = DEFAULT_ENRICHMENT_MODEL,
        provider: str = DEFAULT_ENRICHMENT_PROVIDER,
        api_key: str = "",
        timeout: float = DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
        retry_count: int = 2,
        temperature: float | None = None,
        max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
        prompt_templates: dict[str, str],
        default_prompt_id: str,
        prompt_variable: str = "{{DOC_CHUNK}}",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.provider = _normalize_enrichment_provider(provider)
        self.api_key = _resolve_enrichment_api_key(api_key, provider=self.provider)
        self.timeout = timeout
        self.retry_count = retry_count
        self.temperature = temperature
        requested_max_tokens = int(max_tokens or DEFAULT_ENRICHMENT_MAX_TOKENS)
        if self.provider == "deepseek":
            self.max_tokens = max(DEFAULT_ENRICHMENT_MAX_TOKENS, requested_max_tokens)
        else:
            self.max_tokens = max(1, requested_max_tokens)
        self.prompt_templates = prompt_templates
        self.default_prompt_id = default_prompt_id
        self.prompt_variable = prompt_variable

    def render_prompt(self, chunk: LanguageChunk) -> tuple[str, str]:
        prompt_id = chunk.prompt_id or self.default_prompt_id
        template = self.prompt_templates.get(prompt_id) or self.prompt_templates[self.default_prompt_id]
        prompt = template.replace(self.prompt_variable, chunk.text).replace("{{RAW_GO_DOC_CONTENT}}", chunk.text)
        quality = _source_quality_metadata(chunk)
        if quality:
            prompt = (
                f"{prompt}\n\nSource quality metadata: {json.dumps(quality, sort_keys=True)}\n"
                "If the source appears incomplete or noisy, include that as hidden_warnings or source_quality notes. "
                "Do not repair source text or invent missing facts."
            )
        doc_language = str(chunk.metadata.get("doc_language") or "en")
        prompt = (
            f"{prompt}\n\nSource document language: {doc_language}. "
            "Preserve official terminology, identifiers, APIs, package names, and error strings exactly as written. "
            "Do not translate code identifiers or infer facts from another language edition."
        )
        identity = {k: v for k, v in _chunk_identity_metadata(chunk).items() if v}
        if identity:
            prompt = (
                f"{prompt}\n\nChunk identity metadata: {json.dumps(identity, sort_keys=True)}\n"
                "Use these identifiers as retrieval anchors when they are consistent with the source. "
                "The best enrichment survives searches for exact symbol names, package paths, error codes, "
                "resource names, commands, class members, and common task phrasing."
            )
        prompt = f"{prompt}{SYNPACK_V2_ENRICHMENT_APPEND}"
        return prompt_id, prompt

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self.provider == "deepseek":
            headers["X-DeepSeek-Think-Mode"] = "Max"
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _chat_completions_url(self) -> str:
        if self.base_url.endswith("/chat/completions"):
            return self.base_url
        if self.base_url.endswith("/v1"):
            return f"{self.base_url}/chat/completions"
        return f"{self.base_url}/v1/chat/completions"

    def enrich(self, chunk: LanguageChunk) -> dict[str, Any]:
        prompt_id, prompt = self.render_prompt(chunk)
        payload = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": FRONTIER_ENRICHMENT_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
        }
        if self.provider == "deepseek":
            payload["reasoning_effort"] = "max"
            payload["thinking"] = {"type": "enabled"}
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        last_error = ""
        for _ in range(max(1, self.retry_count + 1)):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    resp = client.post(self._chat_completions_url(), headers=self._headers(), json=payload)
                resp.raise_for_status()
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                parsed = parse_enrichment_response(str(content))
                parsed.setdefault("prompt_id", prompt_id)
                usage = _enrichment_usage_from_response(data)
                if usage:
                    parsed["_enrichment_usage"] = usage
                return parsed
            except Exception as exc:  # deterministic fallback is handled by caller.
                last_error = str(exc)
        raise SynPackError(last_error or "enrichment failed")


def _normalize_enrichment_provider(provider: str = DEFAULT_ENRICHMENT_PROVIDER) -> str:
    normalized = (provider or DEFAULT_ENRICHMENT_PROVIDER).strip().lower().replace("_", "-")
    aliases = {
        "deepseek": "deepseek",
        "openai": "openai-compatible",
        "openai-compatible": "openai-compatible",
        "custom": "openai-compatible",
        "custom-openai": "openai-compatible",
    }
    if normalized not in aliases:
        raise SynPackError(f"unsupported enrichment provider: {provider}")
    return aliases[normalized]


def _resolve_enrichment_api_key(api_key: str = "", *, provider: str = DEFAULT_ENRICHMENT_PROVIDER) -> str:
    explicit = (api_key or "").strip()
    if explicit:
        return explicit
    shared = (
        os.environ.get("SYNESIS_INDEXER_ENRICHMENT_API_KEY") or os.environ.get("SYNESIS_INDEXER_ENRICHMENT_TOKEN") or ""
    ).strip()
    if shared:
        return shared
    if _normalize_enrichment_provider(provider) == "deepseek":
        return (os.environ.get("DEEPSEEK_TOKEN") or os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    return (os.environ.get("OPENAI_API_KEY") or "").strip()


def _effective_enrichment_max_tokens(max_tokens: int, *, provider: str = DEFAULT_ENRICHMENT_PROVIDER) -> int:
    requested_max_tokens = int(max_tokens or DEFAULT_ENRICHMENT_MAX_TOKENS)
    if _normalize_enrichment_provider(provider) == "deepseek":
        return max(DEFAULT_ENRICHMENT_MAX_TOKENS, requested_max_tokens)
    return max(1, requested_max_tokens)


def _enrichment_thinking_metadata(provider: str = DEFAULT_ENRICHMENT_PROVIDER) -> dict[str, Any]:
    if _normalize_enrichment_provider(provider) == "deepseek":
        return {"thinking": {"type": "enabled", "reasoning_effort": "max"}, "think_mode_header": "Max"}
    return {"thinking": {"type": "disabled"}, "think_mode_header": ""}


def _approx_token_count(text: str) -> int:
    return max(1, math.ceil(len(text or "") / 4))


def _enrichment_usage_from_response(data: dict[str, Any]) -> dict[str, int]:
    usage = data.get("usage") if isinstance(data, dict) else {}
    if not isinstance(usage, dict):
        return {}
    prompt_details = usage.get("prompt_tokens_details")
    if not isinstance(prompt_details, dict):
        prompt_details = {}
    cache_hit = usage.get(
        "prompt_cache_hit_tokens", prompt_details.get("cache_hit_tokens", prompt_details.get("cached_tokens", 0))
    )
    cache_miss = usage.get("prompt_cache_miss_tokens", prompt_details.get("cache_miss_tokens", 0))
    fields = {
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
        "prompt_cache_hit_tokens": cache_hit,
        "prompt_cache_miss_tokens": cache_miss,
    }
    out: dict[str, int] = {}
    for key, value in fields.items():
        try:
            out[key] = int(value or 0)
        except (TypeError, ValueError):
            out[key] = 0
    return out


def aggregate_enrichment_usage(enrichments: list[dict[str, Any]]) -> dict[str, int]:
    totals = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "prompt_cache_hit_tokens": 0,
        "prompt_cache_miss_tokens": 0,
    }
    seen = False
    for enrichment in enrichments:
        usage = enrichment.get("_enrichment_usage")
        if not isinstance(usage, dict):
            continue
        seen = True
        for key in totals:
            with contextlib.suppress(TypeError, ValueError):
                totals[key] += int(usage.get(key, 0) or 0)
    return totals if seen else {}


def _percentile(values: list[int], percentile: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, math.ceil((percentile / 100) * len(ordered)) - 1))
    return ordered[idx]


def estimate_enrichment_token_budget(
    chunks: list[LanguageChunk],
    *,
    prompt_templates: dict[str, str],
    default_prompt_id: str,
    prompt_variable: str = "{{DOC_CHUNK}}",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    skip_zero_quality: bool = True,
    max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    thinking_cap_tokens: int = DEFAULT_THINKING_CAP_TOKENS,
    input_price_per_mtok: float = 0.0,
    output_price_per_mtok: float = 0.0,
) -> dict[str, Any]:
    client = OpenAICompatibleEnrichmentClient(
        base_url=enrichment_url or "https://api.deepseek.com",
        model=enrichment_model,
        provider=enrichment_provider,
        max_tokens=max_tokens,
        prompt_templates=prompt_templates,
        default_prompt_id=default_prompt_id,
        prompt_variable=prompt_variable,
    )
    prompt_tokens = 0
    prompt_chars = 0
    chunk_text_chars = 0
    chunk_text_tokens: list[int] = []
    prompt_tokens_per_request: list[int] = []
    chunks_by_artifact_kind: dict[str, int] = {}
    chunks_by_prompt_id: dict[str, int] = {}
    system_tokens = _approx_token_count(FRONTIER_ENRICHMENT_SYSTEM_PROMPT)
    for chunk in chunks:
        skip_reason = _zero_quality_enrichment_skip_reason(chunk) if skip_zero_quality else ""
        if skip_reason:
            artifact_kind = chunk.artifact_kind or "unknown"
            chunks_by_artifact_kind[artifact_kind] = chunks_by_artifact_kind.get(artifact_kind, 0) + 1
            continue
        prompt_id, prompt = client.render_prompt(chunk)
        prompt_token_count = system_tokens + _approx_token_count(prompt)
        chunk_token_count = _approx_token_count(chunk.text)
        prompt_tokens += prompt_token_count
        prompt_chars += len(prompt)
        chunk_text_chars += len(chunk.text)
        prompt_tokens_per_request.append(prompt_token_count)
        chunk_text_tokens.append(chunk_token_count)
        artifact_kind = chunk.artifact_kind or "unknown"
        chunks_by_artifact_kind[artifact_kind] = chunks_by_artifact_kind.get(artifact_kind, 0) + 1
        chunks_by_prompt_id[prompt_id] = chunks_by_prompt_id.get(prompt_id, 0) + 1
    zero_quality_skipped_chunks = len(chunks) - len(prompt_tokens_per_request)
    completion_budget_tokens = len(prompt_tokens_per_request) * client.max_tokens
    thinking_budget_tokens = (
        len(prompt_tokens_per_request) * max(0, int(thinking_cap_tokens or 0)) if client.provider == "deepseek" else 0
    )
    uncached_input_cost = (prompt_tokens / 1_000_000) * max(0.0, input_price_per_mtok)
    output_budget_cost = ((completion_budget_tokens + thinking_budget_tokens) / 1_000_000) * max(
        0.0, output_price_per_mtok
    )
    return {
        "estimator": "chars_div_4_plus_request_budget_v1",
        "scope": "prepared_chunks_after_extraction_and_quality_gate",
        "note": "Completion and thinking values are worst-case request budgets, not predicted usage.",
        "model": enrichment_model,
        "provider": client.provider,
        "chunks": len(chunks),
        "llm_enrichment_chunks": len(prompt_tokens_per_request),
        "zero_quality_skipped_chunks": zero_quality_skipped_chunks,
        "chunks_by_artifact_kind": dict(sorted(chunks_by_artifact_kind.items())),
        "chunks_by_prompt_id": dict(sorted(chunks_by_prompt_id.items())),
        "chunk_text_chars": chunk_text_chars,
        "chunk_text_tokens_estimate": sum(chunk_text_tokens),
        "prompt_chars": prompt_chars,
        "prompt_tokens_estimate": prompt_tokens,
        "prompt_tokens_per_request_min": min(prompt_tokens_per_request) if prompt_tokens_per_request else 0,
        "prompt_tokens_per_request_p50": _percentile(prompt_tokens_per_request, 50),
        "prompt_tokens_per_request_p95": _percentile(prompt_tokens_per_request, 95),
        "prompt_tokens_per_request_max": max(prompt_tokens_per_request) if prompt_tokens_per_request else 0,
        "completion_budget_tokens": completion_budget_tokens,
        "completion_budget_tokens_worst_case": completion_budget_tokens,
        "thinking_budget_tokens": thinking_budget_tokens,
        "thinking_budget_tokens_worst_case": thinking_budget_tokens,
        "worst_case_total_tokens": prompt_tokens + completion_budget_tokens + thinking_budget_tokens,
        "max_tokens_per_request": client.max_tokens,
        "thinking_cap_tokens_per_request": max(0, int(thinking_cap_tokens or 0))
        if client.provider == "deepseek"
        else 0,
        "thinking_effort": "max" if client.provider == "deepseek" else "",
        "thinking_mode": "enabled" if client.provider == "deepseek" else "disabled",
        "cache_strategy": "stable_system_prompt_plus_prompt_template_prefix",
        "uncached_input_price_per_mtok": input_price_per_mtok,
        "output_price_per_mtok": output_price_per_mtok,
        "estimated_uncached_usd": round(uncached_input_cost + output_budget_cost, 6)
        if input_price_per_mtok or output_price_per_mtok
        else None,
    }


def enrich_language_chunks(
    chunks: list[LanguageChunk],
    *,
    prompt_templates: dict[str, str],
    default_prompt_id: str,
    prompt_variable: str = "{{DOC_CHUNK}}",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    enrichment_api_key: str = "",
    concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    retry_count: int = 2,
    temperature: float | None = None,
    max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    timeout: float = DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
    skip: bool = False,
    skip_zero_quality: bool = True,
) -> list[dict[str, Any]]:
    if skip or not enrichment_url:
        return [
            _attach_source_quality(fallback_enrichment(chunk, error="enrichment skipped"), chunk) for chunk in chunks
        ]
    client = OpenAICompatibleEnrichmentClient(
        base_url=enrichment_url,
        model=enrichment_model,
        provider=enrichment_provider,
        api_key=enrichment_api_key,
        timeout=timeout,
        retry_count=retry_count,
        temperature=temperature,
        max_tokens=max_tokens,
        prompt_templates=prompt_templates,
        default_prompt_id=default_prompt_id,
        prompt_variable=prompt_variable,
    )

    def one(chunk: LanguageChunk) -> dict[str, Any]:
        skip_reason = _zero_quality_enrichment_skip_reason(chunk) if skip_zero_quality else ""
        if skip_reason:
            return _attach_source_quality(fallback_enrichment(chunk, error=skip_reason), chunk)
        try:
            return _attach_source_quality(client.enrich(chunk), chunk)
        except Exception as exc:
            return _attach_source_quality(fallback_enrichment(chunk, error=str(exc)), chunk)

    workers = max(1, min(int(concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, chunks))


def _agent_json(enrichment: dict[str, Any]) -> str:
    return json.dumps(enrichment, sort_keys=True, ensure_ascii=False)


def _join_csv(values: Iterable[Any]) -> str:
    seen: list[str] = []
    for value in values:
        if isinstance(value, list):
            items = value
        else:
            items = str(value or "").split(",")
        for item in items:
            s = str(item).strip()
            if s and s not in seen:
                seen.append(s)
    return ",".join(seen)


def _build_rows(
    chunks: list[LanguageChunk],
    enrichments: list[dict[str, Any]],
    embeddings: list[list[float]],
    *,
    pack_id: str,
    pack_version: str,
    source_version: str,
    language: str,
    domain: str,
    doc_language: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for chunk, enrichment, embedding in zip(chunks, enrichments, embeddings):
        enrichment = dict(enrichment)
        enrichment.setdefault("doc_language", doc_language)
        status, signals = scan_chunk_text_detailed(chunk.text)
        has_code, code_signal_count, code_density = _code_chunk_metrics(chunk.text)
        import_refs = str(chunk.metadata.get("import_refs") or "")
        call_refs = str(chunk.metadata.get("call_refs") or "")
        if has_code:
            import_refs = import_refs or _join_csv([extract_import_refs(chunk.text, language)])
            call_refs = call_refs or _join_csv([extract_call_refs(chunk.text, language)])
        chunk_id = chunk_id_hash(chunk.text, f"{pack_id}:{chunk.doc_id}:{chunk.section}")
        retrieval_terms = _retrieval_terms(chunk, enrichment)
        row = catalog_entity(
            chunk_id=chunk_id,
            text=chunk.text,
            embedding=embedding,
            doc_id=chunk.doc_id,
            chunk_index=chunk.chunk_index,
            context_prefix=str(enrichment.get("agent_hook", "") or ""),
            chunk_summary=str(enrichment.get("agent_hook", "") or ""),
            heading_path=chunk.heading_path,
            section=chunk.section,
            document_name=chunk.document_name,
            source_type="docs",
            handler="language_pack",
            domain=domain,
            tags=_join_csv(
                [f"language-pack,{language}", f"doc-language:{doc_language}", chunk.metadata.get("scope_tags", [])]
            ),
            keywords=_join_csv([[chunk.package_name, chunk.symbol_kind, chunk.symbol_name], retrieval_terms]),
            origin_type="curated",
            authority="vetted",
            pack_id=pack_id,
            pack_version=pack_version,
            pack_source_version=source_version,
            pack_partition=pack_id,
            symbol_kind=chunk.symbol_kind,
            symbol_fqn=chunk.symbol_fqn,
            package_name=chunk.package_name,
            doc_relation_ids=_join_csv([chunk.metadata.get("doc_relation_ids", [])]),
            source_url=chunk.source_url,
            agent_hook=str(enrichment.get("agent_hook", "") or ""),
            perf_tier=str(enrichment.get("perf_tier", "") or ""),
            safety_contract=str(enrichment.get("safety_contract", "") or ""),
            lifecycle_model=str(enrichment.get("lifecycle_model", "") or ""),
            agent_enrichment_json=_agent_json(enrichment),
            scan_status=status,
            scan_signals=",".join(signals),
            content_format=chunk.content_format,
            symbol_type=chunk.symbol_kind,
            language=language,
            repo_path=str(
                chunk.metadata.get("repo_path")
                or (
                    "golang/go"
                    if language == "go"
                    else "rust-lang/rust"
                    if language == "rust"
                    else "quarkusio/quarkus"
                    if language == "quarkus"
                    else "python/cpython"
                    if language == "python"
                    else "godotengine/godot"
                    if language == "godot"
                    else "tc39/proposals"
                    if language == "ecma"
                    else "koalaman/shellcheck"
                    if language == "bash"
                    else "hashicorp/terraform"
                )
            ),
            module_path=chunk.module_path,
            symbol_name=chunk.symbol_name,
            import_refs=import_refs,
            call_refs=call_refs,
            artifact_kind=chunk.artifact_kind,
            has_code=has_code,
            code_signal_count=code_signal_count,
            code_density=code_density,
            code_language=language if has_code else "",
            corpus_class="coder_enriched",
            constraint_kind=str(chunk.metadata.get("constraint_kind") or ""),
            content_profile=str(chunk.metadata.get("content_profile") or "reference"),
            scope_tags=_join_csv([chunk.metadata.get("scope_tags", [])]),
            constraint_source=str(chunk.metadata.get("constraint_source") or ""),
            constraint_confidence=1.0
            if chunk.metadata.get("constraint_kind") == "hard"
            else 0.85
            if chunk.metadata.get("constraint_kind")
            else -1.0,
            crawl_timestamp=int(time.time() * 1000),
            raw_content_hash=hashlib.sha256(chunk.text.encode()).hexdigest(),
            clean_content_hash=hashlib.sha256(chunk.text.encode()).hexdigest(),
            enrichment_profile=str(
                enrichment.get("prompt_id")
                or chunk.prompt_id
                or (
                    GO_PROMPT_ID
                    if language == "go"
                    else RUST_PROMPT_ID
                    if language == "rust"
                    else QUARKUS_PROMPT_ID
                    if language == "quarkus"
                    else PYTHON_PROMPT_ID
                    if language == "python"
                    else GODOT_PROMPT_ID
                    if language == "godot"
                    else ECMA_PROMPT_ID
                    if language == "ecma"
                    else BASH_PROMPT_ID
                    if language == "bash"
                    else TERRAFORM_PROMPT_ID
                )
            ),
        )
        row["retrieval_terms"] = _join_csv([retrieval_terms])
        row["query_aliases"] = _join_csv([enrichment.get("query_aliases")])
        row["agent_query_hints"] = _join_csv([enrichment.get("agent_query_hints")])
        row["task_intents"] = _join_csv([enrichment.get("task_intents")])
        row["verification_hints"] = _join_csv([enrichment.get("verification_hints")])
        row["related_interfaces"] = _join_csv([enrichment.get("related_interfaces")])
        row["related_symbols"] = _join_csv([enrichment.get("related_symbols")])
        for key in (
            "contains_refs",
            "documents_refs",
            "implements_refs",
            "overrides_refs",
            "valid_in_refs",
            "derived_from_refs",
        ):
            value = _join_csv([chunk.metadata.get(key, [])])
            if value:
                row[key] = value
        rows.append(row)
    return rows


def _default_config_path(language: str) -> Path:
    return _repo_root() / f"base/rag/pack-configs/{language}.yaml"


def _default_repo_for_language(language: str) -> str:
    return (
        "github.com/golang/go"
        if language == "go"
        else "github.com/rust-lang/rust"
        if language == "rust"
        else "github.com/quarkusio/quarkus"
        if language == "quarkus"
        else "github.com/python/cpython"
        if language == "python"
        else "github.com/godotengine/godot"
        if language == "godot"
        else "github.com/tc39/proposals"
        if language == "ecma"
        else "github.com/koalaman/shellcheck"
        if language == "bash"
        else "github.com/hashicorp/terraform"
    )


def _default_prompt_id_for_language(language: str) -> str:
    return (
        GO_PROMPT_ID
        if language == "go"
        else RUST_PROMPT_ID
        if language == "rust"
        else QUARKUS_PROMPT_ID
        if language == "quarkus"
        else PYTHON_PROMPT_ID
        if language == "python"
        else GODOT_PROMPT_ID
        if language == "godot"
        else ECMA_PROMPT_ID
        if language == "ecma"
        else BASH_PROMPT_ID
        if language == "bash"
        else TERRAFORM_PROMPT_ID
    )


def _resolve_language_tag(language: str, *, latest_tag: str, source_version: str) -> str:
    if latest_tag or source_version:
        return latest_tag or source_version
    if language == "go":
        return resolve_latest_go_tag()
    if language == "rust":
        return resolve_latest_rust_tag()
    if language == "quarkus":
        return resolve_latest_quarkus_tag()
    if language == "python":
        return resolve_latest_python_tag()
    if language == "godot":
        return resolve_latest_godot_tag()
    if language == "terraform":
        return resolve_latest_terraform_tag()
    if language == "ecma":
        return resolve_latest_ecma_tag()
    if language == "bash":
        return "main"
    raise SynPackError(f"unsupported language pack: {language}")


def _prompt_specs(config: dict[str, Any]) -> list[dict[str, str]]:
    specs: list[dict[str, str]] = []
    if config.get("prompt_path"):
        specs.append({"id": str(config.get("prompt_id") or "language_pack_v1"), "path": str(config["prompt_path"])})
    for item in config.get("prompts", []):
        if isinstance(item, dict) and item.get("id") and item.get("path"):
            specs.append({"id": str(item["id"]), "path": str(item["path"])})
    if not specs:
        raise SynPackError("language pack config must define prompt_path or prompts")
    dedup: dict[str, str] = {}
    for spec in specs:
        dedup[spec["id"]] = spec["path"]
    return [{"id": k, "path": v} for k, v in dedup.items()]


def _load_prompt_templates(config: dict[str, Any], *, config_path: Path) -> tuple[dict[str, str], dict[str, str]]:
    templates: dict[str, str] = {}
    hashes: dict[str, str] = {}
    for spec in _prompt_specs(config):
        path = _resolve_path(spec["path"], base=config_path.parent)
        content = _read_text(path)
        templates[spec["id"]] = content
        hashes[spec["id"]] = hashlib.sha256(content.encode()).hexdigest()
    return templates, hashes


def _clone_aux_sources(config: dict[str, Any], source_root: Path, sources_lock: dict[str, Any]) -> None:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    aux_locks: list[dict[str, Any]] = []
    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        repo = str(aux.get("repo") or "")
        if not name or not repo:
            continue
        ref = str(aux.get("ref") or "")
        target = source_root / name
        if target.exists():
            aux_locks.append({"name": name, "repo": repo, "path": str(target), "ref": ref or "local"})
            aux["resolved_ref"] = ref or "local"
            continue
        clone_repo(repo, target, tag=ref)
        commit = subprocess.run(
            ["git", "-C", str(target), "rev-parse", "HEAD"], check=True, text=True, capture_output=True
        ).stdout.strip()
        aux["resolved_ref"] = commit
        aux_locks.append({"name": name, "repo": repo, "path": str(target), "ref": ref, "commit": commit})
    sources_lock["aux_sources"] = aux_locks


LanguageChunkExtractor = Callable[..., list[LanguageChunk]]

LANGUAGE_CHUNK_EXTRACTORS: dict[str, LanguageChunkExtractor] = {
    "go": extract_go_chunks,
    "rust": extract_rust_chunks,
    "python": extract_python_chunks,
    "godot": extract_godot_chunks,
    "terraform": extract_terraform_chunks,
    "ecma": extract_ecma_chunks,
    "bash": extract_bash_chunks,
    "quarkus": extract_quarkus_chunks,
}


def _extract_chunks_for_language(
    language: str,
    source_root: Path,
    *,
    config: dict[str, Any],
    tag: str,
    provider_schema: str | Path = "",
) -> list[LanguageChunk]:
    extractor = LANGUAGE_CHUNK_EXTRACTORS.get(language, LANGUAGE_CHUNK_EXTRACTORS["quarkus"])
    if language == "terraform":
        return extractor(source_root, config=config, tag=tag, provider_schema=provider_schema)
    return extractor(source_root, config=config, tag=tag)


def _language_pack_manifest_base(
    *,
    pack_id: str,
    pack_version: str,
    source_version: str,
    language: str,
    doc_language: str,
    supported_doc_languages: list[str],
    domain: str,
) -> dict[str, Any]:
    return {
        "format": "synpack",
        "format_version": SYNPACK_FORMAT_VERSION,
        "pack_id": pack_id,
        "pack_version": pack_version,
        "version": pack_version,
        "source_version": source_version,
        "language": language,
        "doc_language": doc_language,
        "supported_doc_languages": supported_doc_languages,
        "domain": domain,
        "embedding_model": DEFAULT_PACK_MODEL,
        "embedding_dimensions": EMBEDDING_DIM,
        "embedding_profile": EMBEDDING_PROFILE,
        "corpus_version": CORPUS_VERSION,
        "synesis_catalog_schema_version": SCHEMA_VERSION,
        "schema_version": SCHEMA_VERSION,
        "partitions": [pack_id],
        "metadata_fields": [
            "package_name",
            "symbol_kind",
            "symbol_fqn",
            "perf_tier",
            "agent_hook",
            "safety_contract",
            "lifecycle_model",
            "agent_enrichment_json",
        ],
    }


def _chunk_key(pack_id: str, chunk: LanguageChunk) -> str:
    payload = "|".join([pack_id, chunk.doc_id, str(chunk.chunk_index), chunk.section, chunk.prompt_id, chunk.text])
    return hashlib.sha256(payload.encode()).hexdigest()


def _chunk_record(pack_id: str, chunk: LanguageChunk) -> dict[str, Any]:
    record = asdict(chunk)
    record["chunk_key"] = _chunk_key(pack_id, chunk)
    return record


def _chunk_from_record(record: dict[str, Any]) -> LanguageChunk:
    payload = {key: value for key, value in record.items() if key in LanguageChunk.__dataclass_fields__}
    return LanguageChunk(**payload)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def _append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        f.flush()


def _write_synpack_archive_payload(zf: zipfile.ZipFile, root: Path) -> None:
    for name in ("manifest.json", "metadata.jsonl", "nodes.jsonl", "edges.jsonl", "sources.lock.json"):
        path = root / name
        if path.exists():
            zf.write(path, name)
    for dirname in ("nodes", "edges", "vectors", "enrichment", "quality"):
        directory = root / dirname
        if not directory.exists():
            continue
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                zf.write(path, str(path.relative_to(root)))


def _completed_enrichment_map(work_dir: Path) -> dict[str, dict[str, Any]]:
    completed: dict[str, dict[str, Any]] = {}
    for record in _read_jsonl(work_dir / "enrichments" / "completed.jsonl"):
        key = str(record.get("chunk_key") or "")
        enrichment = record.get("enrichment")
        if key and isinstance(enrichment, dict):
            completed[key] = enrichment
    return completed


def _write_enrich_state(work_dir: Path, *, total: int, completed: int, failed: int, submitted: int) -> None:
    state = {
        "total_chunks": total,
        "completed_chunks": completed,
        "failed_attempts": failed,
        "submitted_this_run": submitted,
        "updated_at": int(time.time()),
    }
    state_path = work_dir / "checkpoints" / "enrich-state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def prepare_staged_language_pack(
    *,
    language: str,
    work_dir: str | Path,
    pack_config: str | Path = "",
    pack_id: str = "",
    pack_version: str = "1.0.0",
    source_version: str = "",
    latest_tag: str = "",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    enrichment_api_key: str = "",
    skip_zero_quality: bool = True,
    enrichment_concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    enrichment_max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    enrichment_input_price_per_mtok: float = 0.0,
    enrichment_output_price_per_mtok: float = 0.0,
    max_chunks: int = 0,
    source_dir: str | Path = "",
    provider_schema: str | Path = "",
    doc_language: str = "",
) -> dict[str, Any]:
    language = language.lower().strip()
    if language not in SUPPORTED_LANGUAGE_PACKS:
        raise SynPackError(f"unsupported language pack: {language}")
    enrichment_provider = _normalize_enrichment_provider(enrichment_provider)
    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)
    config_path = Path(pack_config) if pack_config else _default_config_path(language)
    config = _load_yaml(config_path)
    pack_id = _sanitize_pack_id(pack_id or str(config.get("pack_id") or f"{language}-latest"))
    doc_language = _normalize_doc_language(doc_language or str(config.get("doc_language") or "en"))
    supported_doc_languages = _supported_doc_languages(config)
    _validate_doc_language(doc_language=doc_language, supported_doc_languages=supported_doc_languages, pack_id=pack_id)
    resolved_tag = _resolve_language_tag(language, latest_tag=latest_tag, source_version=source_version)
    source_version = resolved_tag
    source_root = Path(source_dir) if source_dir else work / "sources" / language
    if not source_dir and not source_root.exists():
        if language == "go":
            clone_go_source(resolved_tag, source_root)
        else:
            clone_repo(str(config.get("repo") or _default_repo_for_language(language)), source_root, tag=resolved_tag)
    sources_lock = {
        "repo": config.get("repo", _default_repo_for_language(language)),
        "tag": resolved_tag,
        "source_dir": str(source_root),
    }
    if language in AUX_SOURCE_LANGUAGES and not source_dir:
        _clone_aux_sources(config, source_root, sources_lock)
    elif language in AUX_SOURCE_LANGUAGES:
        include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
        sources_lock["aux_sources"] = [
            {
                "name": str(aux.get("name") or ""),
                "repo": str(aux.get("repo") or ""),
                "path": str(source_root / str(aux.get("name") or "")),
                "ref": "local",
            }
            for aux in include.get("aux_sources", [])
            if isinstance(aux, dict)
        ]
    chunks = _extract_chunks_for_language(
        language, source_root, config=config, tag=resolved_tag, provider_schema=provider_schema
    )
    if max_chunks:
        chunks = chunks[: max(0, max_chunks)]
    chunks, source_quality_report = prepare_language_chunks_for_enrichment(chunks)
    for chunk in chunks:
        chunk.metadata["doc_language"] = doc_language
    source_quality_report["doc_language"] = doc_language
    prompt_templates, prompt_hashes = _load_prompt_templates(config, config_path=config_path)
    default_prompt_id = str(config.get("prompt_id") or _default_prompt_id_for_language(language))
    prompt_variable = str(
        config.get("prompt_variable") or ("{{RAW_GO_DOC_CONTENT}}" if language == "go" else "{{DOC_CHUNK}}")
    )
    enrichment_cost_estimate = estimate_enrichment_token_budget(
        chunks,
        prompt_templates=prompt_templates,
        default_prompt_id=default_prompt_id,
        prompt_variable=prompt_variable,
        enrichment_url=enrichment_url,
        enrichment_model=enrichment_model,
        enrichment_provider=enrichment_provider,
        skip_zero_quality=skip_zero_quality,
        max_tokens=enrichment_max_tokens,
        thinking_cap_tokens=DEFAULT_THINKING_CAP_TOKENS,
        input_price_per_mtok=enrichment_input_price_per_mtok,
        output_price_per_mtok=enrichment_output_price_per_mtok,
    )
    source_quality_report["enrichment_cost_estimate"] = enrichment_cost_estimate
    thinking_metadata = _enrichment_thinking_metadata(enrichment_provider)
    chunk_records = [_chunk_record(pack_id, chunk) for chunk in chunks]
    chunks_path = work / "chunks.jsonl"
    chunks_path.write_text("", encoding="utf-8")
    for record in chunk_records:
        _append_jsonl(chunks_path, record)
    sources_lock["row_count"] = len(chunks)
    sources_lock_path = work / "sources.lock.json"
    sources_lock_path.write_text(json.dumps(sources_lock, indent=2, sort_keys=True), encoding="utf-8")
    run_manifest = {
        **_language_pack_manifest_base(
            pack_id=pack_id,
            pack_version=pack_version,
            source_version=source_version,
            language=language,
            doc_language=doc_language,
            supported_doc_languages=supported_doc_languages,
            domain=str(config.get("domain") or language),
        ),
        "staged": True,
        "pack_config": str(config_path),
        "prompt_variable": prompt_variable,
        "enrichment": {
            "model": enrichment_model,
            "provider": enrichment_provider,
            "prompt_id": default_prompt_id,
            "prompt_sha256": prompt_hashes.get(default_prompt_id, ""),
            "prompt_hashes": prompt_hashes,
            "url_configured": bool(enrichment_url),
            "api_key_configured": bool(_resolve_enrichment_api_key(enrichment_api_key, provider=enrichment_provider)),
            "skip_zero_quality": bool(skip_zero_quality),
            "skipped": False,
            "max_tokens": _effective_enrichment_max_tokens(enrichment_max_tokens, provider=enrichment_provider),
            "concurrency": max(
                1, min(int(enrichment_concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY)
            ),
            **thinking_metadata,
            "doc_language": doc_language,
            "supported_doc_languages": supported_doc_languages,
            "cost_estimate": enrichment_cost_estimate,
        },
        "source_quality": source_quality_report,
        "created_at": int(time.time()),
        "row_count": len(chunks),
        "chunks_sha256": hashlib.sha256(chunks_path.read_bytes()).hexdigest(),
        "sources_lock_sha256": _sha256_file(sources_lock_path),
    }
    (work / "run_manifest.json").write_text(json.dumps(run_manifest, indent=2, sort_keys=True), encoding="utf-8")
    return {
        "ok": True,
        "phase": "prepare",
        "work_dir": str(work),
        "pack_id": pack_id,
        "source_version": source_version,
        "chunks": len(chunks),
        "cost_estimate": enrichment_cost_estimate,
    }


def enrich_staged_language_pack(
    *,
    work_dir: str | Path,
    enrichment_url: str = "",
    enrichment_model: str = "",
    enrichment_provider: str = "",
    enrichment_api_key: str = "",
    enrichment_concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    enrichment_max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    enrichment_timeout: float = DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
    request_limit: int = 0,
    batch_size: int = 100,
    skip_enrichment: bool = False,
    skip_zero_quality: bool | None = None,
) -> dict[str, Any]:
    work = Path(work_dir)
    manifest_path = work / "run_manifest.json"
    chunks_path = work / "chunks.jsonl"
    if not manifest_path.exists() or not chunks_path.exists():
        raise SynPackError("staged work_dir must contain run_manifest.json and chunks.jsonl")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    prompt_hashes = manifest["enrichment"]["prompt_hashes"]
    prompt_templates = {
        prompt_id: (_repo_root() / "base/rag/pack-configs/prompts" / f"{prompt_id}.md").read_text(encoding="utf-8")
        for prompt_id in prompt_hashes
    }
    default_prompt_id = str(manifest["enrichment"]["prompt_id"])
    prompt_variable = str(manifest.get("prompt_variable") or "{{DOC_CHUNK}}")
    model = enrichment_model or str(manifest["enrichment"]["model"] or DEFAULT_ENRICHMENT_MODEL)
    provider = _normalize_enrichment_provider(enrichment_provider or str(manifest["enrichment"].get("provider") or ""))
    if skip_zero_quality is None:
        skip_zero_quality = bool(manifest["enrichment"].get("skip_zero_quality", True))
    url = enrichment_url or ""
    records = _read_jsonl(chunks_path)
    completed = _completed_enrichment_map(work)
    pending = [record for record in records if str(record.get("chunk_key") or "") not in completed]
    limit = max(0, int(request_limit or 0))
    if limit:
        pending = pending[:limit]
    if skip_enrichment or not url:
        submitted = 0
        for record in pending:
            chunk = _chunk_from_record(record)
            enrichment = _attach_source_quality(fallback_enrichment(chunk, error="enrichment skipped"), chunk)
            _append_jsonl(
                work / "enrichments" / "completed.jsonl",
                {
                    "chunk_key": record["chunk_key"],
                    "chunk_index": chunk.chunk_index,
                    "enrichment": enrichment,
                    "completed_at": int(time.time()),
                    "skipped": True,
                },
            )
            submitted += 1
        completed_after = len(_completed_enrichment_map(work))
        _write_enrich_state(work, total=len(records), completed=completed_after, failed=0, submitted=submitted)
        return {
            "ok": True,
            "phase": "enrich",
            "work_dir": str(work),
            "submitted": submitted,
            "completed": completed_after,
            "remaining": max(0, len(records) - completed_after),
        }
    client = OpenAICompatibleEnrichmentClient(
        base_url=url,
        model=model,
        provider=provider,
        api_key=enrichment_api_key,
        timeout=enrichment_timeout,
        max_tokens=enrichment_max_tokens,
        prompt_templates=prompt_templates,
        default_prompt_id=default_prompt_id,
        prompt_variable=prompt_variable,
    )
    submitted = 0
    failed = 0
    workers = max(1, min(int(enrichment_concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY))
    batch = pending[: max(1, int(batch_size or 1))]

    def one(record: dict[str, Any]) -> dict[str, Any]:
        chunk = _chunk_from_record(record)
        skip_reason = _zero_quality_enrichment_skip_reason(chunk) if skip_zero_quality else ""
        if skip_reason:
            enrichment = _attach_source_quality(fallback_enrichment(chunk, error=skip_reason), chunk)
            return {
                "chunk_key": record["chunk_key"],
                "chunk_index": chunk.chunk_index,
                "enrichment": enrichment,
                "completed_at": int(time.time()),
                "model": "",
                "skipped": True,
                "skip_reason": "zero_quality_source",
            }
        enrichment = _attach_source_quality(client.enrich(chunk), chunk)
        return {
            "chunk_key": record["chunk_key"],
            "chunk_index": chunk.chunk_index,
            "enrichment": enrichment,
            "completed_at": int(time.time()),
            "model": model,
        }

    while batch:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            future_map = {pool.submit(one, record): record for record in batch}
            for future in concurrent.futures.as_completed(future_map):
                record = future_map[future]
                submitted += 1
                try:
                    _append_jsonl(work / "enrichments" / "completed.jsonl", future.result())
                except Exception as exc:
                    failed += 1
                    _append_jsonl(
                        work / "enrichments" / "failed.jsonl",
                        {
                            "chunk_key": record.get("chunk_key"),
                            "chunk_index": record.get("chunk_index"),
                            "error": str(exc),
                            "failed_at": int(time.time()),
                            "model": model,
                        },
                    )
                completed_now = len(_completed_enrichment_map(work))
                _write_enrich_state(
                    work, total=len(records), completed=completed_now, failed=failed, submitted=submitted
                )
        if limit and submitted >= limit:
            break
        start = submitted
        end = submitted + max(1, int(batch_size or 1))
        batch = pending[start:end]
    completed_after = len(_completed_enrichment_map(work))
    return {
        "ok": True,
        "phase": "enrich",
        "work_dir": str(work),
        "submitted": submitted,
        "failed": failed,
        "completed": completed_after,
        "remaining": max(0, len(records) - completed_after),
    }


def finalize_staged_language_pack(
    *,
    work_dir: str | Path,
    output_path: str | Path,
    embedder_url: str = "",
    embedder_batch_size: int = DEFAULT_EMBEDDER_BATCH_SIZE,
    embedder_timeout: float = DEFAULT_EMBEDDER_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    work = Path(work_dir)
    manifest = json.loads((work / "run_manifest.json").read_text(encoding="utf-8"))
    records = _read_jsonl(work / "chunks.jsonl")
    completed = _completed_enrichment_map(work)
    missing = [
        str(record.get("chunk_key") or "") for record in records if str(record.get("chunk_key") or "") not in completed
    ]
    if missing:
        raise SynPackError(f"cannot finalize staged pack; missing {len(missing)} enrichments")
    chunks = [_chunk_from_record(record) for record in records]
    enrichments = [completed[str(record["chunk_key"])] for record in records]
    enrichment_usage = aggregate_enrichment_usage(enrichments)
    embedder_kwargs: dict[str, Any] = {
        "batch_size": max(1, int(embedder_batch_size or 1)),
        "timeout": max(1.0, float(embedder_timeout or 1.0)),
    }
    if embedder_url:
        embedder_kwargs["url"] = embedder_url
    embedder = EmbedClient(**embedder_kwargs)
    embed_inputs = [_embedding_input(chunk, enrichment) for chunk, enrichment in zip(chunks, enrichments)]
    embeddings = embedder.embed_texts(embed_inputs) if embed_inputs else []
    if len(embeddings) != len(chunks):
        raise SynPackError(f"embedder returned {len(embeddings)} vectors for {len(chunks)} chunks")
    bad_dims = [len(vec) for vec in embeddings if len(vec) != EMBEDDING_DIM]
    if bad_dims:
        raise SynPackError(f"embedder returned vector dimension {bad_dims[0]}, expected {EMBEDDING_DIM}")
    rows = _build_rows(
        chunks,
        enrichments,
        embeddings,
        pack_id=str(manifest["pack_id"]),
        pack_version=str(manifest["pack_version"]),
        source_version=str(manifest["source_version"]),
        language=str(manifest["language"]),
        domain=str(manifest["domain"]),
        doc_language=str(manifest["doc_language"]),
    )
    final_dir = work / "final"
    final_dir.mkdir(parents=True, exist_ok=True)
    rows_path = final_dir / "metadata.jsonl"
    with rows_path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    edges_path = final_dir / "edges.jsonl"
    edges = derive_graph_edges(rows, include_structural_edges=True)
    with edges_path.open("w", encoding="utf-8") as f:
        for edge in edges:
            f.write(json.dumps(edge, ensure_ascii=False, sort_keys=True) + "\n")
    sources_lock_path = work / "sources.lock.json"
    final_sources_lock_path = final_dir / "sources.lock.json"
    shutil.copyfile(sources_lock_path, final_sources_lock_path)
    final_manifest = {
        **{key: value for key, value in manifest.items() if key not in {"staged", "pack_config", "prompt_variable"}},
        "enrichment": {**manifest["enrichment"], "usage": enrichment_usage, "skipped": False},
        "created_at": int(time.time()),
        "row_count": len(rows),
        "node_count": len(rows),
        "edge_count": len(edges),
        "requires_bulk_import": len(rows) >= 1000,
        "install_profile": "nornicdb-v2-typed-graph",
        "content_type": "developer",
        "trust_score": 1.0,
        "freshness_score": 1.0,
        "sources_lock_sha256": _sha256_file(final_sources_lock_path),
        "metadata_sha256": _sha256_file(rows_path),
        "edges_sha256": _sha256_file(edges_path),
    }
    quality_report = materialize_synpack_v2(rows, edges, final_manifest, final_dir)
    final_manifest.update(
        {
            "node_count": quality_report["node_count"],
            "chunk_count": quality_report["chunk_count"],
            "edge_count": quality_report["edge_count"],
            "node_counts_by_kind": quality_report["node_counts_by_kind"],
            "edge_counts_by_type": quality_report["edge_counts_by_type"],
            "example_count": quality_report.get("example_count", 0),
            "context_card_count": quality_report.get("context_card_count", 0),
            "pack_card_count": quality_report.get("pack_card_count", 0),
            "anti_pattern_count": quality_report.get("anti_pattern_count", 0),
            "dangling_edge_count": quality_report["dangling_edge_count"],
            "external_ref_count": quality_report["external_ref_count"],
            "quality_report_sha256": _sha256_file(final_dir / "quality" / "report.json"),
        }
    )
    manifest_path = final_dir / "manifest.json"
    manifest_path.write_text(json.dumps(final_manifest, indent=2, sort_keys=True), encoding="utf-8")
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        _write_synpack_archive_payload(zf, final_dir)
    return {
        "ok": True,
        "phase": "finalize",
        "pack_id": str(manifest["pack_id"]),
        "rows": len(rows),
        "path": str(out_path),
        "artifact_hash": _sha256_file(out_path),
    }


def build_language_pack(
    *,
    language: str,
    output_path: str | Path,
    pack_config: str | Path = "",
    pack_id: str = "",
    pack_version: str = "1.0.0",
    source_version: str = "",
    latest_tag: str = "",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    enrichment_api_key: str = "",
    skip_zero_quality: bool = True,
    enrichment_concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    enrichment_max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    enrichment_timeout: float = DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
    enrichment_input_price_per_mtok: float = 0.0,
    enrichment_output_price_per_mtok: float = 0.0,
    estimate_cost_only: bool = False,
    skip_enrichment: bool = False,
    embedder_url: str = "",
    embedder_batch_size: int = DEFAULT_EMBEDDER_BATCH_SIZE,
    embedder_timeout: float = DEFAULT_EMBEDDER_TIMEOUT_SECONDS,
    max_chunks: int = 0,
    source_dir: str | Path = "",
    provider_schema: str | Path = "",
    doc_language: str = "",
) -> dict[str, Any]:
    language = language.lower().strip()
    if language not in SUPPORTED_LANGUAGE_PACKS:
        raise SynPackError(f"unsupported language pack: {language}")
    enrichment_provider = _normalize_enrichment_provider(enrichment_provider)
    config_path = Path(pack_config) if pack_config else _default_config_path(language)
    config = _load_yaml(config_path)
    pack_id = _sanitize_pack_id(pack_id or str(config.get("pack_id") or f"{language}-latest"))
    doc_language = _normalize_doc_language(doc_language or str(config.get("doc_language") or "en"))
    supported_doc_languages = _supported_doc_languages(config)
    _validate_doc_language(doc_language=doc_language, supported_doc_languages=supported_doc_languages, pack_id=pack_id)
    resolved_tag = _resolve_language_tag(language, latest_tag=latest_tag, source_version=source_version)
    source_version = resolved_tag
    tmp = Path(tempfile.mkdtemp(prefix="synpack-language-"))
    try:
        source_root = Path(source_dir) if source_dir else tmp / language
        if not source_dir:
            if language == "go":
                clone_go_source(resolved_tag, source_root)
            else:
                clone_repo(
                    str(
                        config.get("repo")
                        or (
                            "github.com/rust-lang/rust"
                            if language == "rust"
                            else "github.com/quarkusio/quarkus"
                            if language == "quarkus"
                            else "github.com/python/cpython"
                            if language == "python"
                            else "github.com/godotengine/godot"
                            if language == "godot"
                            else "github.com/tc39/proposals"
                            if language == "ecma"
                            else "github.com/koalaman/shellcheck"
                            if language == "bash"
                            else "github.com/hashicorp/terraform"
                        )
                    ),
                    source_root,
                    tag=resolved_tag,
                )
        sources_lock = {
            "repo": config.get(
                "repo",
                f"github.com/{'golang/go' if language == 'go' else 'rust-lang/rust' if language == 'rust' else 'quarkusio/quarkus' if language == 'quarkus' else 'python/cpython' if language == 'python' else 'godotengine/godot' if language == 'godot' else 'tc39/proposals' if language == 'ecma' else 'koalaman/shellcheck' if language == 'bash' else 'hashicorp/terraform'}",
            ),
            "tag": resolved_tag,
            "source_dir": str(source_root),
        }
        if language in AUX_SOURCE_LANGUAGES and not source_dir:
            _clone_aux_sources(config, source_root, sources_lock)
        elif language in AUX_SOURCE_LANGUAGES:
            include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
            sources_lock["aux_sources"] = [
                {
                    "name": str(aux.get("name") or ""),
                    "repo": str(aux.get("repo") or ""),
                    "path": str(source_root / str(aux.get("name") or "")),
                    "ref": "local",
                }
                for aux in include.get("aux_sources", [])
                if isinstance(aux, dict)
            ]
        if language == "go":
            chunks = extract_go_chunks(source_root, config=config, tag=resolved_tag)
        elif language == "rust":
            chunks = extract_rust_chunks(source_root, config=config, tag=resolved_tag)
        elif language == "python":
            chunks = extract_python_chunks(source_root, config=config, tag=resolved_tag)
        elif language == "godot":
            chunks = extract_godot_chunks(source_root, config=config, tag=resolved_tag)
        elif language == "terraform":
            chunks = extract_terraform_chunks(
                source_root, config=config, tag=resolved_tag, provider_schema=provider_schema
            )
        elif language == "ecma":
            chunks = extract_ecma_chunks(source_root, config=config, tag=resolved_tag)
        elif language == "bash":
            chunks = extract_bash_chunks(source_root, config=config, tag=resolved_tag)
        else:
            chunks = extract_quarkus_chunks(source_root, config=config, tag=resolved_tag)
        if max_chunks:
            chunks = chunks[: max(0, max_chunks)]
        chunks, source_quality_report = prepare_language_chunks_for_enrichment(chunks)
        for chunk in chunks:
            chunk.metadata["doc_language"] = doc_language
        source_quality_report["doc_language"] = doc_language

        prompt_templates, prompt_hashes = _load_prompt_templates(config, config_path=config_path)
        default_prompt_id = str(
            config.get("prompt_id")
            or (
                GO_PROMPT_ID
                if language == "go"
                else RUST_PROMPT_ID
                if language == "rust"
                else QUARKUS_PROMPT_ID
                if language == "quarkus"
                else PYTHON_PROMPT_ID
                if language == "python"
                else GODOT_PROMPT_ID
                if language == "godot"
                else ECMA_PROMPT_ID
                if language == "ecma"
                else BASH_PROMPT_ID
                if language == "bash"
                else TERRAFORM_PROMPT_ID
            )
        )
        prompt_variable = str(
            config.get("prompt_variable") or ("{{RAW_GO_DOC_CONTENT}}" if language == "go" else "{{DOC_CHUNK}}")
        )
        enrichment_cost_estimate = estimate_enrichment_token_budget(
            chunks,
            prompt_templates=prompt_templates,
            default_prompt_id=default_prompt_id,
            prompt_variable=prompt_variable,
            enrichment_url=enrichment_url,
            enrichment_model=enrichment_model,
            enrichment_provider=enrichment_provider,
            skip_zero_quality=skip_zero_quality,
            max_tokens=enrichment_max_tokens,
            thinking_cap_tokens=DEFAULT_THINKING_CAP_TOKENS,
            input_price_per_mtok=enrichment_input_price_per_mtok,
            output_price_per_mtok=enrichment_output_price_per_mtok,
        )
        source_quality_report["enrichment_cost_estimate"] = enrichment_cost_estimate
        thinking_metadata = _enrichment_thinking_metadata(enrichment_provider)
        if estimate_cost_only:
            return {
                "ok": True,
                "estimate_only": True,
                "language": language,
                "pack_id": pack_id,
                "source_version": source_version,
                "source_quality": source_quality_report,
                "enrichment": {
                    "model": enrichment_model,
                    "provider": enrichment_provider,
                    "prompt_id": default_prompt_id,
                    "prompt_sha256": prompt_hashes.get(default_prompt_id, ""),
                    "prompt_hashes": prompt_hashes,
                    "url_configured": bool(enrichment_url),
                    "api_key_configured": bool(
                        _resolve_enrichment_api_key(enrichment_api_key, provider=enrichment_provider)
                    ),
                    "skip_zero_quality": bool(skip_zero_quality),
                    "max_tokens": _effective_enrichment_max_tokens(enrichment_max_tokens, provider=enrichment_provider),
                    "concurrency": max(
                        1,
                        min(int(enrichment_concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY),
                    ),
                    **thinking_metadata,
                    "doc_language": doc_language,
                    "supported_doc_languages": supported_doc_languages,
                    "cost_estimate": enrichment_cost_estimate,
                },
            }
        enrichments = enrich_language_chunks(
            chunks,
            prompt_templates=prompt_templates,
            default_prompt_id=default_prompt_id,
            prompt_variable=prompt_variable,
            enrichment_url=enrichment_url,
            enrichment_model=enrichment_model,
            enrichment_provider=enrichment_provider,
            enrichment_api_key=enrichment_api_key,
            concurrency=enrichment_concurrency,
            max_tokens=enrichment_max_tokens,
            timeout=enrichment_timeout,
            skip=skip_enrichment,
            skip_zero_quality=skip_zero_quality,
        )
        enrichment_usage = aggregate_enrichment_usage(enrichments)
        source_quality_report["fallback_enriched"] = sum(
            1 for enrichment in enrichments if enrichment.get("enrichment_status") == "fallback"
        )
        embedder_kwargs: dict[str, Any] = {
            "batch_size": max(1, int(embedder_batch_size or 1)),
            "timeout": max(1.0, float(embedder_timeout or 1.0)),
        }
        if embedder_url:
            embedder_kwargs["url"] = embedder_url
        embedder = EmbedClient(**embedder_kwargs)
        embed_inputs = [_embedding_input(chunk, enrichment) for chunk, enrichment in zip(chunks, enrichments)]
        embeddings = embedder.embed_texts(embed_inputs) if embed_inputs else []
        if len(embeddings) != len(chunks):
            raise SynPackError(f"embedder returned {len(embeddings)} vectors for {len(chunks)} chunks")
        bad_dims = [len(vec) for vec in embeddings if len(vec) != EMBEDDING_DIM]
        if bad_dims:
            raise SynPackError(f"embedder returned vector dimension {bad_dims[0]}, expected {EMBEDDING_DIM}")
        rows = _build_rows(
            chunks,
            enrichments,
            embeddings,
            pack_id=pack_id,
            pack_version=pack_version,
            source_version=source_version,
            language=language,
            domain=str(config.get("domain") or language),
            doc_language=doc_language,
        )

        rows_path = tmp / "metadata.jsonl"
        with rows_path.open("w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        edges_path = tmp / "edges.jsonl"
        edges = derive_graph_edges(rows, include_structural_edges=True)
        with edges_path.open("w", encoding="utf-8") as f:
            for edge in edges:
                f.write(json.dumps(edge, ensure_ascii=False, sort_keys=True) + "\n")

        sources_lock["row_count"] = len(rows)
        sources_lock_path = tmp / "sources.lock.json"
        sources_lock_path.write_text(json.dumps(sources_lock, indent=2, sort_keys=True), encoding="utf-8")
        manifest = {
            "format": "synpack",
            "format_version": SYNPACK_FORMAT_VERSION,
            "pack_id": pack_id,
            "pack_version": pack_version,
            "version": pack_version,
            "source_version": source_version,
            "language": language,
            "doc_language": doc_language,
            "supported_doc_languages": supported_doc_languages,
            "domain": str(config.get("domain") or language),
            "content_type": str(config.get("content_type") or "developer"),
            "trust_score": float(config.get("trust_score", 1.0) or 1.0),
            "freshness_score": float(config.get("freshness_score", 1.0) or 1.0),
            "embedding_model": DEFAULT_PACK_MODEL,
            "embedding_dimensions": EMBEDDING_DIM,
            "embedding_profile": EMBEDDING_PROFILE,
            "corpus_version": CORPUS_VERSION,
            "synesis_catalog_schema_version": SCHEMA_VERSION,
            "schema_version": SCHEMA_VERSION,
            "partitions": [pack_id],
            "metadata_fields": [
                "package_name",
                "symbol_kind",
                "symbol_fqn",
                "perf_tier",
                "agent_hook",
                "safety_contract",
                "lifecycle_model",
                "agent_enrichment_json",
                "retrieval_terms",
                "query_aliases",
                "task_intents",
                "import_refs",
                "call_refs",
            ],
            "enrichment": {
                "model": enrichment_model if enrichment_url and not skip_enrichment else "",
                "provider": enrichment_provider,
                "prompt_id": default_prompt_id,
                "prompt_sha256": prompt_hashes.get(default_prompt_id, ""),
                "prompt_hashes": prompt_hashes,
                "url_configured": bool(enrichment_url),
                "api_key_configured": bool(
                    _resolve_enrichment_api_key(enrichment_api_key, provider=enrichment_provider)
                ),
                "skip_zero_quality": bool(skip_zero_quality),
                "skipped": bool(skip_enrichment or not enrichment_url),
                "max_tokens": _effective_enrichment_max_tokens(enrichment_max_tokens, provider=enrichment_provider),
                "concurrency": max(
                    1, min(int(enrichment_concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY)
                ),
                **thinking_metadata,
                "doc_language": doc_language,
                "supported_doc_languages": supported_doc_languages,
                "cost_estimate": enrichment_cost_estimate,
                "usage": enrichment_usage,
            },
            "source_quality": source_quality_report,
            "created_at": int(time.time()),
            "row_count": len(rows),
            "node_count": len(rows),
            "edge_count": len(edges),
            "requires_bulk_import": len(rows) >= 1000,
            "install_profile": "nornicdb-v2-typed-graph",
            "sources_lock_sha256": _sha256_file(sources_lock_path),
            "metadata_sha256": _sha256_file(rows_path),
            "edges_sha256": _sha256_file(edges_path),
        }
        quality_report = materialize_synpack_v2(rows, edges, manifest, tmp)
        manifest.update(
            {
                "node_count": quality_report["node_count"],
                "chunk_count": quality_report["chunk_count"],
                "edge_count": quality_report["edge_count"],
                "node_counts_by_kind": quality_report["node_counts_by_kind"],
                "edge_counts_by_type": quality_report["edge_counts_by_type"],
                "example_count": quality_report.get("example_count", 0),
                "context_card_count": quality_report.get("context_card_count", 0),
                "pack_card_count": quality_report.get("pack_card_count", 0),
                "anti_pattern_count": quality_report.get("anti_pattern_count", 0),
                "dangling_edge_count": quality_report["dangling_edge_count"],
                "external_ref_count": quality_report["external_ref_count"],
                "quality_report_sha256": _sha256_file(tmp / "quality" / "report.json"),
            }
        )
        manifest_path = tmp / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            _write_synpack_archive_payload(zf, tmp)
        return {
            "ok": True,
            "pack_id": pack_id,
            "rows": len(rows),
            "path": str(out_path),
            "source_version": source_version,
            "artifact_hash": _sha256_file(out_path),
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
