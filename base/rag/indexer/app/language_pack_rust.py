"""Rust language-pack extraction."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .language_pack_common import (
    RUST_PROMPT_ID,
    LanguageChunk,
    _doc_chunks,
    _read_text,
    _split_text,
    _unique_metadata_values,
)


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
