"""Go language-pack extraction."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .language_pack_common import LanguageChunk, _doc_chunks, _read_text


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
