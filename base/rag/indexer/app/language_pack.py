"""Configurable SynPack language-pack builder.

The pipeline supports curated language packs with language-specific extraction
and enrichment prompts while preserving universal SynPack v17 agentic fields.
"""

from __future__ import annotations

import concurrent.futures
import ast
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import httpx
import yaml

from .embed_client import EmbedClient
from .injection_scan import scan_chunk_text_detailed
from .milvus_writer import chunk_id_hash
from .pipeline import _code_chunk_metrics
from .schema import EMBEDDING_DIM, SCHEMA_VERSION, catalog_entity
from .synpack import DEFAULT_PACK_MODEL, SYNPACK_FORMAT_VERSION, SynPackError, _sanitize_pack_id, _sha256_file

GO_TAG_RE = re.compile(r"^go(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)$")
RUST_TAG_RE = re.compile(r"^(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)$")
QUARKUS_TAG_RE = re.compile(r"^(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)(?:\.Final)?$")
PYTHON_TAG_RE = re.compile(r"^v?(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)$")
DEFAULT_ENRICHMENT_MODEL = "qwen3.6-35b-a3b"
GO_PROMPT_ID = "go_agentic_architect_v1"
RUST_PROMPT_ID = "rust_agentic_architect_2024_v1"
QUARKUS_PROMPT_ID = "quarkus_cloud_native_architect_v1"
PYTHON_PROMPT_ID = "python_314_agentic_architect_v1"
REQUIRED_UNIVERSAL_ENRICHMENT_FIELDS = {
    "agent_hook",
    "perf_tier",
    "safety_contract",
    "lifecycle_model",
}


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


def parse_go_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable Go tags, rejecting rc/beta/weekly."""
    m = GO_TAG_RE.match(tag.strip())
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def latest_go_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_go_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Go tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def parse_rust_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable Rust tags, rejecting beta/nightly/rc."""
    value = tag.strip()
    if any(marker in value.lower() for marker in ("beta", "nightly", "rc")):
        return None
    m = RUST_TAG_RE.match(value)
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def latest_rust_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_rust_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Rust tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def parse_quarkus_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable Quarkus tags, rejecting prereleases."""
    value = tag.strip()
    if any(marker in value.lower() for marker in ("alpha", "beta", "cr", "rc", "snapshot")):
        return None
    m = QUARKUS_TAG_RE.match(value)
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def latest_quarkus_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_quarkus_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Quarkus tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def parse_python_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable CPython tags, rejecting prereleases."""
    value = tag.strip()
    if any(marker in value.lower() for marker in ("a", "b", "rc", "dev")):
        return None
    m = PYTHON_TAG_RE.match(value)
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def latest_python_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_python_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Python tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def _git_ls_remote_tags(repo: str) -> str:
    proc = subprocess.run(
        ["git", "ls-remote", "--tags", f"https://{repo}"],
        check=True,
        text=True,
        capture_output=True,
    )
    return proc.stdout


def resolve_latest_go_tag() -> str:
    return latest_go_stable_tag_from_refs(_git_ls_remote_tags("github.com/golang/go"))


def resolve_latest_rust_tag() -> str:
    return latest_rust_stable_tag_from_refs(_git_ls_remote_tags("github.com/rust-lang/rust"))


def resolve_latest_quarkus_tag() -> str:
    return latest_quarkus_stable_tag_from_refs(_git_ls_remote_tags("github.com/quarkusio/quarkus"))


def resolve_latest_python_tag() -> str:
    return latest_python_stable_tag_from_refs(_git_ls_remote_tags("github.com/python/cpython"))


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
            if file_path.suffix.lower() not in {"", ".adoc", ".md", ".rst", ".txt", ".html"}:
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
        ("function", r"\b(?:pub(?:\([^)]*\))?\s+)?(?:const\s+|async\s+|unsafe\s+|extern\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)"),
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
    return {
        "edition_scope": edition,
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind in {"compiler_error", "language_spec"} else "guiding",
        "constraint_source": "rustc_error_codes" if artifact_kind == "compiler_error" else "rust-official-docs",
        "content_profile": "reference",
        "prompt_id": prompt_id or _rust_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind=symbol_kind),
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
        symbol_fqn = f"{package}::{name}" if package else name
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
                metadata=_rust_metadata(text=body, rel_path=rel_path, artifact_kind="code", symbol_kind=kind),
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
    return LanguageChunk(
        text=body[:6500],
        doc_id=f"rust:{repo}:{rel_path}:module-doc",
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
        artifact_kind="docs",
        content_format="rust",
        metadata=_rust_metadata(text=body, rel_path=rel_path, artifact_kind="docs", symbol_kind="module"),
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
                metadata = _rust_metadata(text=part, rel_path=rel_path, artifact_kind="compiler_error", symbol_kind="compiler_error")
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
            module_doc = _extract_rust_module_doc(path / doc_name, source_root, repo=repo, tag=tag) if (path / doc_name).exists() else None
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
        tags.extend(["config-reference", "build-time-config" if "build_time" in lower or "buildtime" in lower or "fixed" in lower else "runtime-config"])
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
        "constraint_source": "quarkus-config-reference" if artifact_kind == "config_reference" else "quarkus-cli" if artifact_kind == "cli_command" else "quarkus-docs",
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
            if not any(marker in text for marker in ("@ConfigRoot", "@ConfigItem", "@ConfigMapping", "@ConfigProperty", "@ConfigGroup")):
                continue
            rel_path = file_path.relative_to(source_root).as_posix()
            package = _quarkus_package_for_path(rel_path)
            class_name = _java_class_name(text, file_path.stem)
            class_doc = _java_doc_before(text.splitlines(), next((i for i, line in enumerate(text.splitlines()) if "class " in line or "interface " in line or "record " in line), 0))
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
                        metadata=_quarkus_metadata(text=body, rel_path=rel_path, artifact_kind="config_reference", symbol_kind="config_root"),
                    )
                )
            lines = text.splitlines()
            field_re = re.compile(r"\b(?:public\s+)?(?:Optional<[^>]+>|List<[^>]+>|Map<[^>]+>|[A-Za-z_][A-Za-z0-9_<>.?]+)\s+([a-z][A-Za-z0-9_]*)\s*(?:=|;)")
            for i, line in enumerate(lines):
                if "@ConfigItem" not in "\n".join(lines[max(0, i - 4) : i + 1]) and "@ConfigProperty" not in "\n".join(lines[max(0, i - 4) : i + 1]):
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
                        metadata=_quarkus_metadata(text=body, rel_path=rel_path, artifact_kind="config_reference", symbol_kind="config_property"),
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
        doc = _java_doc_before(text.splitlines(), next((i for i, line in enumerate(text.splitlines()) if "@Command" in line), 0))
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
                metadata=_quarkus_metadata(text=body, rel_path=rel_path, artifact_kind="cli_command", symbol_kind="cli_command"),
            )
        )
    return chunks


def _extract_quarkus_source_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/quarkusio/quarkus")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    roots = [str(x) for x in include.get("source_roots", ["core/runtime/src/main/java"])]
    chunks: list[LanguageChunk] = []
    class_re = re.compile(r"\bpublic\s+(?:abstract\s+|final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)")
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
                    metadata=_quarkus_metadata(text=body, rel_path=rel_path, artifact_kind="code", symbol_kind="java_type"),
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
                    metadata=_quarkus_metadata(text=body, rel_path=f"quarkus-platform/{rel_path}", artifact_kind="platform_bom", symbol_kind="platform_bom"),
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
    if "pep 649" in lower or "deferred" in lower and "annotation" in lower:
        tags.append("deferred-annotations")
    if "pep 750" in lower or "template string" in lower or "t-string" in lower or "templatelib" in lower:
        tags.append("t-strings")
    if "asyncio" in lower or "taskgroup" in lower:
        tags.append("async")
    if "uv" in lower:
        tags.append("uv")
    if "pixi" in lower:
        tags.append("pixi")
    if artifact_kind == "repo_map":
        tags.extend(["repo-map", "python-architecture", "swe-bench"])
    if artifact_kind == "type_stub":
        tags.append("typeshed")
    if artifact_kind == "pep":
        tags.append("pep")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind in {"pep", "type_stub", "packaging_spec"} else "guiding",
        "constraint_source": "python-peps" if artifact_kind == "pep" else "typeshed" if artifact_kind == "type_stub" else "python-repo-map" if artifact_kind == "repo_map" else "python-docs",
        "content_profile": "architecture" if artifact_kind == "repo_map" else "reference",
        "prompt_id": prompt_id or _python_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind=symbol_kind),
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


def _extract_python_symbols(file_path: Path, root: Path, *, repo: str, tag: str, artifact_kind: str = "code") -> list[LanguageChunk]:
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
        kind = "class" if isinstance(node, ast.ClassDef) else "async_function" if isinstance(node, ast.AsyncFunctionDef) else "function"
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


def _extract_python_module_doc(file_path: Path, root: Path, *, repo: str, tag: str, artifact_kind: str = "docs") -> LanguageChunk | None:
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
        py_files = sorted(p for p in source_root.rglob("*.py") if ".git" not in p.parts and "__pycache__" not in p.parts)
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
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and not node.name.startswith("_"):
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
            metadata={**_python_metadata(text=json.dumps(project_json), rel_path="repo-map", artifact_kind="repo_map", symbol_kind="project_root"), "repo_map_json": project_json},
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
            "side_effects": "YES" if any(x in ",".join(info["imports"]) for x in ["os", "socket", "subprocess", "sqlite", "requests"]) else "unknown",
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
                metadata={**_python_metadata(text=json.dumps(map_json), rel_path=rel_path, artifact_kind="repo_map", symbol_kind="module"), "repo_map_json": map_json},
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
            chunks.extend(_extract_python_pep_chunks(aux_root, path or ".", repo=repo_name, tag=str(aux.get("resolved_ref") or "main")))
            continue
        if artifact_kind == "type_stub":
            for pyi in sorted((aux_root / path).rglob("*.pyi")) if (aux_root / path).exists() else []:
                chunks.extend(_extract_python_symbols(pyi, aux_root, repo=repo_name, tag=str(aux.get("resolved_ref") or "main"), artifact_kind="type_stub"))
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
            chunk.metadata.update(_python_metadata(text=chunk.text, rel_path=chunk.module_path, artifact_kind=artifact_kind, prompt_id=str(aux.get("prompt_id") or "")))
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
                metadata={**_python_metadata(text=text, rel_path="pyproject.toml", artifact_kind="repo_map", symbol_kind="project_config"), "repo_map_json": map_json},
            )
        )
    chunks.extend(_extract_python_repo_map(source_root, config=config, tag=tag))
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
            else "Go"
        )
    )
    if language.lower() == "rust":
        edition_scope = chunk.metadata.get("edition_scope") if isinstance(chunk.metadata.get("edition_scope"), list) else []
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
            "hidden_warnings": [error] if error else [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() == "python":
        if chunk.artifact_kind == "repo_map":
            repo_map = chunk.metadata.get("repo_map_json") if isinstance(chunk.metadata.get("repo_map_json"), dict) else {}
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
        timeout: float = 60.0,
        retry_count: int = 2,
        temperature: float = 0.1,
        prompt_templates: dict[str, str],
        default_prompt_id: str,
        prompt_variable: str = "{{DOC_CHUNK}}",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.retry_count = retry_count
        self.temperature = temperature
        self.prompt_templates = prompt_templates
        self.default_prompt_id = default_prompt_id
        self.prompt_variable = prompt_variable

    def enrich(self, chunk: LanguageChunk) -> dict[str, Any]:
        prompt_id = chunk.prompt_id or self.default_prompt_id
        template = self.prompt_templates.get(prompt_id) or self.prompt_templates[self.default_prompt_id]
        prompt = template.replace(self.prompt_variable, chunk.text).replace("{{RAW_GO_DOC_CONTENT}}", chunk.text)
        payload = {
            "model": self.model,
            "temperature": self.temperature,
            "messages": [
                {"role": "system", "content": "Return exactly one JSON object and no surrounding prose."},
                {"role": "user", "content": prompt},
            ],
        }
        last_error = ""
        for _ in range(max(1, self.retry_count + 1)):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    resp = client.post(f"{self.base_url}/v1/chat/completions", json=payload)
                resp.raise_for_status()
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                parsed = parse_enrichment_response(str(content))
                parsed.setdefault("prompt_id", prompt_id)
                return parsed
            except Exception as exc:  # deterministic fallback is handled by caller.
                last_error = str(exc)
        raise SynPackError(last_error or "enrichment failed")


def enrich_language_chunks(
    chunks: list[LanguageChunk],
    *,
    prompt_templates: dict[str, str],
    default_prompt_id: str,
    prompt_variable: str = "{{DOC_CHUNK}}",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    concurrency: int = 4,
    retry_count: int = 2,
    temperature: float = 0.1,
    skip: bool = False,
) -> list[dict[str, Any]]:
    if skip or not enrichment_url:
        return [fallback_enrichment(chunk, error="enrichment skipped") for chunk in chunks]
    client = OpenAICompatibleEnrichmentClient(
        base_url=enrichment_url,
        model=enrichment_model,
        retry_count=retry_count,
        temperature=temperature,
        prompt_templates=prompt_templates,
        default_prompt_id=default_prompt_id,
        prompt_variable=prompt_variable,
    )

    def one(chunk: LanguageChunk) -> dict[str, Any]:
        try:
            return client.enrich(chunk)
        except Exception as exc:
            return fallback_enrichment(chunk, error=str(exc))

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
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
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for chunk, enrichment, embedding in zip(chunks, enrichments, embeddings):
        status, signals = scan_chunk_text_detailed(chunk.text)
        has_code, code_signal_count, code_density = _code_chunk_metrics(chunk.text)
        chunk_id = chunk_id_hash(chunk.text, f"{pack_id}:{chunk.doc_id}:{chunk.section}")
        rows.append(
            catalog_entity(
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
                tags=_join_csv([f"language-pack,{language}", chunk.metadata.get("scope_tags", [])]),
                keywords=",".join(str(x) for x in [chunk.package_name, chunk.symbol_kind, chunk.symbol_name] if x),
                origin_type="curated",
                authority="vetted",
                pack_id=pack_id,
                pack_version=pack_version,
                pack_source_version=source_version,
                pack_partition=pack_id,
                symbol_kind=chunk.symbol_kind,
                symbol_fqn=chunk.symbol_fqn,
                package_name=chunk.package_name,
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
                    )
                ),
                module_path=chunk.module_path,
                symbol_name=chunk.symbol_name,
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
                constraint_confidence=1.0 if chunk.metadata.get("constraint_kind") == "hard" else 0.85 if chunk.metadata.get("constraint_kind") else -1.0,
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
                    )
                ),
            )
        )
    return rows


def _default_config_path(language: str) -> Path:
    return _repo_root() / f"base/rag/pack-configs/{language}.yaml"


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
        commit = subprocess.run(["git", "-C", str(target), "rev-parse", "HEAD"], check=True, text=True, capture_output=True).stdout.strip()
        aux["resolved_ref"] = commit
        aux_locks.append({"name": name, "repo": repo, "path": str(target), "ref": ref, "commit": commit})
    sources_lock["aux_sources"] = aux_locks


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
    enrichment_concurrency: int = 4,
    skip_enrichment: bool = False,
    embedder_url: str = "",
    max_chunks: int = 0,
    source_dir: str | Path = "",
) -> dict[str, Any]:
    language = language.lower().strip()
    if language not in {"go", "rust", "quarkus", "python"}:
        raise SynPackError(f"unsupported language pack: {language}")
    config_path = Path(pack_config) if pack_config else _default_config_path(language)
    config = _load_yaml(config_path)
    pack_id = _sanitize_pack_id(pack_id or str(config.get("pack_id") or f"{language}-latest"))
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
                        )
                    ),
                    source_root,
                    tag=resolved_tag,
                )
        sources_lock = {
            "repo": config.get(
                "repo",
                f"github.com/{'golang/go' if language == 'go' else 'rust-lang/rust' if language == 'rust' else 'quarkusio/quarkus' if language == 'quarkus' else 'python/cpython'}",
            ),
            "tag": resolved_tag,
            "source_dir": str(source_root),
        }
        if language in {"rust", "quarkus", "python"} and not source_dir:
            _clone_aux_sources(config, source_root, sources_lock)
        elif language in {"rust", "quarkus", "python"}:
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
        else:
            chunks = extract_quarkus_chunks(source_root, config=config, tag=resolved_tag)
        if max_chunks:
            chunks = chunks[: max(0, max_chunks)]

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
            )
        )
        prompt_variable = str(config.get("prompt_variable") or ("{{RAW_GO_DOC_CONTENT}}" if language == "go" else "{{DOC_CHUNK}}"))
        enrichments = enrich_language_chunks(
            chunks,
            prompt_templates=prompt_templates,
            default_prompt_id=default_prompt_id,
            prompt_variable=prompt_variable,
            enrichment_url=enrichment_url,
            enrichment_model=enrichment_model,
            concurrency=enrichment_concurrency,
            skip=skip_enrichment,
        )
        embedder = EmbedClient(**({"url": embedder_url} if embedder_url else {}))
        embed_inputs = [f"{e.get('agent_hook', '')}\n\n{chunk.text}".strip() for chunk, e in zip(chunks, enrichments)]
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
        )

        rows_path = tmp / "metadata.jsonl"
        with rows_path.open("w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")

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
            "domain": str(config.get("domain") or language),
            "embedding_model": DEFAULT_PACK_MODEL,
            "embedding_dimensions": EMBEDDING_DIM,
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
            "enrichment": {
                "model": enrichment_model if enrichment_url and not skip_enrichment else "",
                "prompt_id": default_prompt_id,
                "prompt_sha256": prompt_hashes.get(default_prompt_id, ""),
                "prompt_hashes": prompt_hashes,
                "url_configured": bool(enrichment_url),
                "skipped": bool(skip_enrichment or not enrichment_url),
            },
            "created_at": int(time.time()),
            "row_count": len(rows),
            "sources_lock_sha256": _sha256_file(sources_lock_path),
            "metadata_sha256": _sha256_file(rows_path),
        }
        manifest_path = tmp / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.write(manifest_path, "manifest.json")
            zf.write(rows_path, "metadata.jsonl")
            zf.write(sources_lock_path, "sources.lock.json")
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
