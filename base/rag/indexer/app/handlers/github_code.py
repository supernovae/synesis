"""Handler: GitHub code repositories with tree-sitter AST chunking.

Shallow-clones repos, parses source files with tree-sitter-language-pack
(170+ languages) for function/class-level semantic chunks. Structured data
files (YAML, JSON, TOML, XML, HCL) found in repos are routed to the
structured_data handler for format-aware chunking.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess  # nosec B404
import tempfile
from pathlib import Path
from typing import Any

from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.github_code")

MAX_CHUNK_CHARS = 6000

# ── Language configs ──────────────────────────────────────────────────
# Each entry maps a language name to its file extensions and the
# tree-sitter node types that represent top-level and nested symbols.

LANG_CONFIGS: dict[str, dict[str, Any]] = {
    "python": {
        "extensions": {".py"},
        "top_level": {"function_definition", "class_definition", "decorated_definition"},
        "nested": {"function_definition"},
    },
    "go": {
        "extensions": {".go"},
        "top_level": {"function_declaration", "method_declaration", "type_declaration"},
        "nested": set(),
    },
    "rust": {
        "extensions": {".rs"},
        "top_level": {"function_item", "impl_item", "trait_item", "struct_item", "enum_item"},
        "nested": {"function_item"},
    },
    "javascript": {
        "extensions": {".js", ".jsx", ".mjs"},
        "top_level": {"function_declaration", "class_declaration", "lexical_declaration", "export_statement"},
        "nested": {"function_declaration", "method_definition"},
    },
    "typescript": {
        "extensions": {".ts", ".tsx"},
        "top_level": {
            "function_declaration",
            "class_declaration",
            "lexical_declaration",
            "export_statement",
            "interface_declaration",
            "type_alias_declaration",
        },
        "nested": {"function_declaration", "method_definition"},
    },
    "java": {
        "extensions": {".java"},
        "top_level": {"class_declaration", "interface_declaration", "enum_declaration"},
        "nested": {"method_declaration", "constructor_declaration"},
    },
    "c": {
        "extensions": {".c", ".h"},
        "top_level": {"function_definition", "declaration", "struct_specifier", "enum_specifier", "type_definition"},
        "nested": set(),
    },
    "cpp": {
        "extensions": {".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".h"},
        "top_level": {
            "function_definition",
            "class_specifier",
            "struct_specifier",
            "namespace_definition",
            "template_declaration",
            "enum_specifier",
        },
        "nested": {"function_definition"},
    },
    "c_sharp": {
        "extensions": {".cs"},
        "top_level": {
            "class_declaration",
            "interface_declaration",
            "struct_declaration",
            "enum_declaration",
            "namespace_declaration",
        },
        "nested": {"method_declaration", "constructor_declaration", "property_declaration"},
    },
    "ruby": {
        "extensions": {".rb", ".rake", ".gemspec"},
        "top_level": {"method", "class", "module", "singleton_method"},
        "nested": {"method", "singleton_method"},
    },
    "php": {
        "extensions": {".php"},
        "top_level": {"function_definition", "class_declaration", "interface_declaration", "trait_declaration"},
        "nested": {"method_declaration"},
    },
    "bash": {
        "extensions": {".sh", ".bash", ".zsh"},
        "top_level": {"function_definition"},
        "nested": set(),
    },
    "lua": {
        "extensions": {".lua"},
        "top_level": {"function_declaration", "function_definition", "variable_declaration"},
        "nested": set(),
    },
    "kotlin": {
        "extensions": {".kt", ".kts"},
        "top_level": {"function_declaration", "class_declaration", "object_declaration", "interface_declaration"},
        "nested": {"function_declaration"},
    },
    "scala": {
        "extensions": {".scala", ".sc"},
        "top_level": {"function_definition", "class_definition", "object_definition", "trait_definition"},
        "nested": {"function_definition"},
    },
    "swift": {
        "extensions": {".swift"},
        "top_level": {
            "function_declaration",
            "class_declaration",
            "struct_declaration",
            "protocol_declaration",
            "enum_declaration",
        },
        "nested": {"function_declaration"},
    },
    "sql": {
        "extensions": {".sql"},
        "top_level": {
            "create_table_statement",
            "create_function_statement",
            "create_view_statement",
            "select_statement",
        },
        "nested": set(),
    },
    "r": {
        "extensions": {".r", ".R"},
        "top_level": {"function_definition", "left_assignment"},
        "nested": set(),
    },
    "elixir": {
        "extensions": {".ex", ".exs"},
        "top_level": {"call"},
        "nested": set(),
    },
    "haskell": {
        "extensions": {".hs"},
        "top_level": {"function", "type_alias", "newtype", "data_type"},
        "nested": set(),
    },
    "perl": {
        "extensions": {".pl", ".pm"},
        "top_level": {"function_definition", "package_statement"},
        "nested": set(),
    },
    "dockerfile": {
        "extensions": set(),
        "filenames": {"Dockerfile", "Containerfile"},
        "top_level": {
            "from_instruction",
            "run_instruction",
            "copy_instruction",
            "cmd_instruction",
            "entrypoint_instruction",
        },
        "nested": set(),
    },
    "make": {
        "extensions": set(),
        "filenames": {"Makefile", "GNUmakefile", "makefile"},
        "top_level": {"rule"},
        "nested": set(),
    },
    "protobuf": {
        "extensions": {".proto"},
        "top_level": {"message", "service", "enum"},
        "nested": {"rpc"},
    },
    "hcl": {
        "extensions": {".tf", ".tfvars", ".hcl"},
        "top_level": {"block"},
        "nested": set(),
    },
}

# Build reverse lookup: extension → language name
_EXT_TO_LANG: dict[str, str] = {}
_FILENAME_TO_LANG: dict[str, str] = {}
for _lang_name, _cfg in LANG_CONFIGS.items():
    for _ext in _cfg.get("extensions", set()):
        if _ext not in _EXT_TO_LANG:
            _EXT_TO_LANG[_ext] = _lang_name
    for _fn in _cfg.get("filenames", set()):
        _FILENAME_TO_LANG[_fn] = _lang_name

# Files that should be routed to structured_data handler instead
STRUCTURED_EXTENSIONS = {".yaml", ".yml", ".json", ".toml", ".xml", ".pom"}


def detect_language(file_path: str) -> str | None:
    """Detect language from file path. Returns None if unrecognized."""
    p = Path(file_path)
    if p.name in _FILENAME_TO_LANG:
        return _FILENAME_TO_LANG[p.name]
    return _EXT_TO_LANG.get(p.suffix.lower())


@register
class GitHubCodeHandler:
    handler_type = "github_code"
    source_type = "code"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        repo = config.get("repo", "")
        paths = config.get("paths", [])
        branch = config.get("branch", "main")
        name = source_config.get("name", repo)

        if not repo:
            logger.error("github_code handler requires config.repo")
            return []

        tmpdir = tempfile.mkdtemp(prefix="synesis-code-")
        try:
            _shallow_clone(repo, branch, tmpdir)
            return _collect_all_files(tmpdir, repo, branch, paths, name)
        except Exception as e:
            logger.error("Failed to clone %s: %s", repo, e)
            return []
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        file_path = doc.metadata.get("file_path", "")
        language = doc.metadata.get("language", "")
        is_structured = doc.metadata.get("is_structured", False)
        source_code = doc.content if isinstance(doc.content, str) else doc.content.decode("utf-8", errors="replace")

        if is_structured:
            return _chunk_structured_file(source_code, file_path, doc)

        if not language:
            language = detect_language(file_path) or ""

        if language:
            try:
                code_chunks = _tree_sitter_chunk(source_code, language, file_path)
            except Exception as e:
                logger.warning("tree-sitter parsing failed for %s: %s", file_path, e)
                code_chunks = []

            if code_chunks:
                repo = str(doc.metadata.get("repo", "") or "")
                import_refs = _join_refs(_extract_import_refs(source_code, language))
                return [
                    Chunk(
                        text=cc["text"],
                        section=cc.get("symbol_name", file_path),
                        heading_path=f"{file_path} > {sym}" if (sym := cc.get("symbol_name")) else file_path,
                        chunk_index=i,
                        metadata={
                            "symbol_name": cc.get("symbol_name", ""),
                            "symbol_type": cc.get("symbol_type", ""),
                            "symbol_kind": cc.get("symbol_type", ""),
                            "symbol_fqn": _symbol_fqn(repo, file_path, cc.get("symbol_name", "")),
                            "package_name": repo,
                            "repo_path": repo,
                            "file_path": file_path,
                            "content_format": language,
                            "language": language,
                            "artifact_kind": "code",
                            "start_line": cc.get("start_line", 0),
                            "end_line": cc.get("end_line", 0),
                            "import_refs": import_refs,
                            "call_refs": _join_refs(_extract_call_refs(cc["text"], language)),
                        },
                    )
                    for i, cc in enumerate(code_chunks)
                ]

        if len(source_code.strip()) > 50:
            return [
                Chunk(
                    text=source_code[:MAX_CHUNK_CHARS],
                    section=file_path,
                    heading_path=file_path,
                    chunk_index=0,
                    metadata={
                        "content_format": language or "text",
                        "language": language or "",
                        "artifact_kind": "code" if language else "",
                        "repo_path": doc.metadata.get("repo", ""),
                        "file_path": file_path,
                        "package_name": doc.metadata.get("repo", ""),
                        "import_refs": _join_refs(_extract_import_refs(source_code, language or "")),
                        "call_refs": _join_refs(_extract_call_refs(source_code, language or "")),
                    },
                )
            ]
        return []


def _shallow_clone(repo: str, branch: str, dest: str) -> None:
    url = f"https://github.com/{repo}.git"
    subprocess.run(  # nosec B603 B607
        ["git", "clone", "--depth", "1", "--branch", branch, url, dest],
        capture_output=True,
        check=True,
        timeout=120,
    )


def _collect_all_files(
    clone_dir: str,
    repo: str,
    branch: str,
    paths: list[str],
    name: str,
) -> list[RawDocument]:
    """Walk clone directory and collect all recognized source files."""
    docs: list[RawDocument] = []
    root = Path(clone_dir)
    github_base = f"https://github.com/{repo}/blob/{branch}"

    search_dirs = [root / p for p in paths] if paths else [root]
    for search_dir in search_dirs:
        if not search_dir.exists():
            continue
        for fp in sorted(search_dir.rglob("*")):
            if not fp.is_file():
                continue
            rel = fp.relative_to(root)
            if any(
                part.startswith(".") or part in {"__pycache__", "node_modules", ".git", "vendor"} for part in rel.parts
            ):
                continue

            is_structured = fp.suffix.lower() in STRUCTURED_EXTENSIONS
            language = detect_language(str(rel))

            if not language and not is_structured:
                continue

            try:
                content = fp.read_text(encoding="utf-8", errors="replace")
            except Exception:
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
                        "language": language or "",
                        "file_path": str(rel),
                        "is_structured": is_structured,
                    },
                )
            )

    logger.info("Collected %d files from %s", len(docs), repo)
    return docs


def _chunk_structured_file(content: str, file_path: str, doc: RawDocument) -> list[Chunk]:
    """Route structured data files to format-aware chunking."""
    from .structured_data import chunk_structured_content

    suffix = Path(file_path).suffix.lower()
    fmt_map = {
        ".yaml": "yaml",
        ".yml": "yaml",
        ".json": "json",
        ".toml": "toml",
        ".xml": "xml",
        ".pom": "xml",
    }
    fmt = fmt_map.get(suffix, "yaml")
    return chunk_structured_content(content, fmt, file_path, doc.name)


def _tree_sitter_chunk(
    source_code: str,
    language: str,
    file_path: str,
) -> list[dict[str, Any]]:
    """Parse source code with tree-sitter and extract semantic chunks."""
    try:
        from tree_sitter_language_pack import get_parser
    except ImportError:
        logger.warning("tree-sitter-language-pack not installed — falling back to raw file chunks")
        return []

    config = LANG_CONFIGS.get(language)
    if config is None:
        return []

    try:
        parser = get_parser(language)
    except Exception:
        logger.debug("No tree-sitter parser available for '%s'", language)
        return []

    source_bytes = source_code.encode("utf-8")
    tree = parser.parse(source_bytes)

    top_level = config.get("top_level", set())
    nested = config.get("nested", set())

    chunks: list[dict[str, Any]] = []
    for node in tree.root_node.children:
        if node.type not in top_level:
            continue

        leading = _get_leading_comment(source_bytes, node)
        node_text = leading + source_bytes[node.start_byte : node.end_byte]
        text = node_text.decode("utf-8", errors="replace")
        symbol_name = _extract_symbol_name(node)
        symbol_type = (
            node.type.replace("_declaration", "")
            .replace("_definition", "")
            .replace("_item", "")
            .replace("_specifier", "")
        )

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
                if child.type in nested:
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
        if stripped.startswith((b"#", b"//", b"/*", b"*", b"--", b";;")):
            comment_lines.insert(0, line)
        elif stripped == b"":
            if comment_lines:
                break
        else:
            break
    return b"\n".join(comment_lines) + b"\n" if comment_lines else b""


def _symbol_fqn(repo: str, file_path: str, symbol_name: str) -> str:
    prefix = f"{repo}:" if repo else ""
    if symbol_name:
        return f"{prefix}{file_path}:{symbol_name}"
    return ""


def _join_refs(values: list[str], limit: int = 64) -> str:
    seen: list[str] = []
    for value in values:
        value = value.strip()
        if value and value not in seen:
            seen.append(value)
        if len(seen) >= limit:
            break
    return ",".join(seen)


def _extract_import_refs(source_code: str, language: str) -> list[str]:
    refs: list[str] = []
    if language == "python":
        patterns = [
            r"(?m)^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+\w+)?",
            r"(?m)^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+",
        ]
    elif language in {"javascript", "typescript"}:
        patterns = [
            r"""(?m)^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]""",
            r"""(?m)^\s*import\s+['"]([^'"]+)['"]""",
            r"""require\(\s*['"]([^'"]+)['"]\s*\)""",
        ]
    elif language == "go":
        patterns = [r"""(?m)^\s*import\s+(?:\(\s*)?"([^"]+)"""]
    elif language == "rust":
        patterns = [r"(?m)^\s*use\s+([^;]+);"]
    elif language == "java":
        patterns = [r"(?m)^\s*import\s+([\w.*]+);"]
    else:
        patterns = []

    for pattern in patterns:
        refs.extend(m.group(1).strip() for m in re.finditer(pattern, source_code))
    return refs


_CALL_KEYWORDS = {
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "func",
    "function",
    "def",
    "class",
    "new",
    "sizeof",
}


def _extract_call_refs(source_code: str, language: str) -> list[str]:
    del language
    refs: list[str] = []
    for match in re.finditer(r"\b([A-Za-z_][\w.]*)\s*\(", source_code):
        name = match.group(1)
        leaf = name.rsplit(".", 1)[-1]
        if leaf.lower() in _CALL_KEYWORDS:
            continue
        refs.append(name)
    return refs
