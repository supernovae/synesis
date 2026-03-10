"""Handler: GitHub code repositories with tree-sitter AST chunking.

Shallow-clones repos, parses source files with tree-sitter for
function/class-level semantic chunks. Supports Python, Go, Rust,
JavaScript, TypeScript, Java.
"""

from __future__ import annotations

import logging
import shutil
import subprocess  # nosec B404
import tempfile
from pathlib import Path
from typing import Any

from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.github_code")

MAX_CHUNK_CHARS = 6000

LANG_EXTENSIONS: dict[str, set[str]] = {
    "python": {".py"},
    "go": {".go"},
    "rust": {".rs"},
    "javascript": {".js", ".jsx", ".mjs"},
    "typescript": {".ts", ".tsx"},
    "java": {".java"},
}


@register
class GitHubCodeHandler:
    handler_type = "github_code"
    source_type = "code"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        repo = config.get("repo", "")
        language = config.get("language", "python")
        paths = config.get("paths", [])
        branch = config.get("branch", "main")
        name = source_config.get("name", repo)

        if not repo:
            logger.error("github_code handler requires config.repo")
            return []

        extensions = LANG_EXTENSIONS.get(language, set())
        if not extensions:
            logger.warning("Unsupported language '%s', no extensions known", language)
            return []

        tmpdir = tempfile.mkdtemp(prefix="synesis-code-")
        try:
            _shallow_clone(repo, branch, tmpdir)
            return _collect_source_files(
                tmpdir,
                repo,
                branch,
                language,
                paths,
                extensions,
                name,
            )
        except Exception as e:
            logger.error("Failed to clone %s: %s", repo, e)
            return []
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        language = doc.metadata.get("language", "python")
        file_path = doc.metadata.get("file_path", "")
        source_code = doc.content if isinstance(doc.content, str) else doc.content.decode("utf-8", errors="replace")

        try:
            code_chunks = _tree_sitter_chunk(source_code, language, file_path)
        except Exception as e:
            logger.warning("tree-sitter parsing failed for %s: %s", file_path, e)
            code_chunks = []

        if not code_chunks:
            if len(source_code.strip()) > 50:
                return [
                    Chunk(
                        text=source_code[:MAX_CHUNK_CHARS],
                        section=file_path,
                        heading_path=file_path,
                        chunk_index=0,
                    )
                ]
            return []

        return [
            Chunk(
                text=cc["text"],
                section=cc.get("symbol_name", file_path),
                heading_path=f"{file_path} > {sym}" if (sym := cc.get("symbol_name")) else file_path,
                chunk_index=i,
                metadata={
                    "symbol_name": cc.get("symbol_name", ""),
                    "symbol_type": cc.get("symbol_type", ""),
                    "start_line": cc.get("start_line", 0),
                    "end_line": cc.get("end_line", 0),
                },
            )
            for i, cc in enumerate(code_chunks)
        ]


def _shallow_clone(repo: str, branch: str, dest: str) -> None:
    """Shallow clone a GitHub repo."""
    url = f"https://github.com/{repo}.git"
    subprocess.run(  # nosec B603 B607
        ["git", "clone", "--depth", "1", "--branch", branch, url, dest],
        capture_output=True,
        check=True,
        timeout=120,
    )


def _collect_source_files(
    clone_dir: str,
    repo: str,
    branch: str,
    language: str,
    paths: list[str],
    extensions: set[str],
    name: str,
) -> list[RawDocument]:
    """Walk clone directory and collect source files matching extensions."""
    docs: list[RawDocument] = []
    root = Path(clone_dir)
    github_base = f"https://github.com/{repo}/blob/{branch}"

    search_dirs = [root / p for p in paths] if paths else [root]
    for search_dir in search_dirs:
        if not search_dir.exists():
            continue
        for fp in sorted(search_dir.rglob("*")):
            if not fp.is_file() or fp.suffix not in extensions:
                continue
            rel = fp.relative_to(root)
            if any(part.startswith(".") or part == "__pycache__" for part in rel.parts):
                continue
            try:
                content = fp.read_text(encoding="utf-8", errors="replace")
            except Exception:  # nosec B112
                continue
            if not content.strip():
                continue

            docs.append(
                RawDocument(
                    doc_id=f"github:{repo}:{rel}",
                    name=f"{name}: {rel}",
                    content=content,
                    source_url=f"{github_base}/{rel}",
                    metadata={
                        "repo": repo,
                        "language": language,
                        "file_path": str(rel),
                    },
                )
            )

    logger.info("Collected %d %s files from %s", len(docs), language, repo)
    return docs


def _tree_sitter_chunk(
    source_code: str,
    language: str,
    file_path: str,
) -> list[dict[str, Any]]:
    """Parse source code with tree-sitter and extract semantic chunks."""
    try:
        import tree_sitter_go as tsgo
        import tree_sitter_java as tsjava
        import tree_sitter_javascript as tsjavascript
        import tree_sitter_python as tspython
        import tree_sitter_rust as tsrust
        import tree_sitter_typescript as tstypescript
        from tree_sitter import Language, Parser
    except ImportError:
        logger.warning("tree-sitter not installed — falling back to raw file chunks")
        return []

    lang_configs = {
        "python": {
            "language": Language(tspython.language()),
            "top_level_types": {"function_definition", "class_definition", "decorated_definition"},
            "nested_types": {"function_definition"},
        },
        "go": {
            "language": Language(tsgo.language()),
            "top_level_types": {"function_declaration", "method_declaration", "type_declaration"},
            "nested_types": set(),
        },
        "rust": {
            "language": Language(tsrust.language()),
            "top_level_types": {"function_item", "impl_item", "trait_item", "struct_item", "enum_item"},
            "nested_types": {"function_item"},
        },
        "javascript": {
            "language": Language(tsjavascript.language()),
            "top_level_types": {"function_declaration", "class_declaration", "lexical_declaration", "export_statement"},
            "nested_types": {"function_declaration", "method_definition"},
        },
        "typescript": {
            "language": Language(tstypescript.language_typescript()),
            "top_level_types": {
                "function_declaration",
                "class_declaration",
                "lexical_declaration",
                "export_statement",
                "interface_declaration",
                "type_alias_declaration",
            },
            "nested_types": {"function_declaration", "method_definition"},
        },
        "java": {
            "language": Language(tsjava.language()),
            "top_level_types": {"class_declaration", "interface_declaration", "enum_declaration"},
            "nested_types": {"method_declaration", "constructor_declaration"},
        },
    }

    config = lang_configs.get(language)
    if config is None:
        return []

    parser = Parser(config["language"])
    source_bytes = source_code.encode("utf-8")
    tree = parser.parse(source_bytes)

    chunks: list[dict[str, Any]] = []
    for node in tree.root_node.children:
        if node.type not in config["top_level_types"]:
            continue

        leading = _get_leading_comment(source_bytes, node)
        node_text = leading + source_bytes[node.start_byte : node.end_byte]
        text = node_text.decode("utf-8", errors="replace")
        symbol_name = _extract_symbol_name(node)
        symbol_type = node.type.replace("_declaration", "").replace("_definition", "").replace("_item", "")

        if len(text) <= MAX_CHUNK_CHARS:
            chunks.append(
                {
                    "text": text,
                    "symbol_name": symbol_name,
                    "symbol_type": symbol_type,
                    "start_line": node.start_point[0] + 1,
                    "end_line": node.end_point[0] + 1,
                }
            )
        else:
            for child in node.children:
                if child.type in config.get("nested_types", set()):
                    child_leading = _get_leading_comment(source_bytes, child)
                    child_text = (child_leading + source_bytes[child.start_byte : child.end_byte]).decode(
                        "utf-8", errors="replace"
                    )
                    parent_name = _extract_symbol_name(node)
                    child_name = _extract_symbol_name(child)
                    full_name = f"{parent_name}.{child_name}" if parent_name else child_name
                    chunks.append(
                        {
                            "text": child_text[:MAX_CHUNK_CHARS],
                            "symbol_name": full_name,
                            "symbol_type": child.type.replace("_declaration", "").replace("_definition", ""),
                            "start_line": child.start_point[0] + 1,
                            "end_line": child.end_point[0] + 1,
                        }
                    )

    return chunks


def _extract_symbol_name(node) -> str:
    for child in node.children:
        if child.type in ("identifier", "name", "type_identifier", "property_identifier"):
            return child.text.decode("utf-8", errors="replace")
        if child.type == "function_declarator":
            return _extract_symbol_name(child)
    return ""


def _get_leading_comment(source_bytes: bytes, node) -> bytes:
    start = node.start_byte
    if start == 0:
        return b""
    preceding = source_bytes[:start]
    lines = preceding.split(b"\n")
    comment_lines: list[bytes] = []
    for line in reversed(lines):
        stripped = line.strip()
        if stripped.startswith((b"#", b"//", b"/*", b"*")):
            comment_lines.insert(0, line)
        elif stripped == b"":
            if comment_lines:
                break
        else:
            break
    return b"\n".join(comment_lines) + b"\n" if comment_lines else b""
