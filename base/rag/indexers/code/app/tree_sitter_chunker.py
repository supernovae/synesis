"""AST-aware code chunker using tree-sitter.

Extracts complete semantic units (functions, classes, methods, impls)
from source files, preserving docstrings and leading comments. This
produces self-contained chunks that embedding models can reason about
far better than line-count-based splits.

Supports: Python, Go, Rust, JavaScript, TypeScript, Java.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import tree_sitter_go as tsgo
import tree_sitter_java as tsjava
import tree_sitter_javascript as tsjavascript
import tree_sitter_python as tspython
import tree_sitter_rust as tsrust
import tree_sitter_typescript as tstypescript
from tree_sitter import Language, Parser

logger = logging.getLogger("synesis.indexer.treesitter")

MAX_CHUNK_CHARS = 6000

LANG_CONFIGS: dict[str, dict] = {
    "python": {
        "language": Language(tspython.language()),
        "extensions": {".py"},
        "top_level_types": {"function_definition", "class_definition", "decorated_definition"},
        "nested_types": {"function_definition"},
    },
    "go": {
        "language": Language(tsgo.language()),
        "extensions": {".go"},
        "top_level_types": {"function_declaration", "method_declaration", "type_declaration"},
        "nested_types": set(),
    },
    "rust": {
        "language": Language(tsrust.language()),
        "extensions": {".rs"},
        "top_level_types": {"function_item", "impl_item", "trait_item", "struct_item", "enum_item"},
        "nested_types": {"function_item"},
    },
    "javascript": {
        "language": Language(tsjavascript.language()),
        "extensions": {".js", ".jsx", ".mjs"},
        "top_level_types": {
            "function_declaration",
            "class_declaration",
            "lexical_declaration",
            "export_statement",
        },
        "nested_types": {"function_declaration", "method_definition"},
    },
    "typescript": {
        "language": Language(tstypescript.language_typescript()),
        "extensions": {".ts", ".tsx"},
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
        "extensions": {".java"},
        "top_level_types": {"class_declaration", "interface_declaration", "enum_declaration"},
        "nested_types": {"method_declaration", "constructor_declaration"},
    },
}


@dataclass
class CodeChunk:
    text: str
    symbol_name: str
    symbol_type: str
    file_path: str
    start_line: int
    end_line: int


def _extract_symbol_name(node) -> str:
    """Try to extract a human-readable name from an AST node."""
    for child in node.children:
        if child.type in ("identifier", "name", "type_identifier", "property_identifier"):
            return child.text.decode("utf-8", errors="replace")
        if child.type == "function_declarator":
            return _extract_symbol_name(child)
    return ""


def _get_leading_comment(source_bytes: bytes, node) -> bytes:
    """Capture comments/docstrings immediately above a node."""
    start = node.start_byte
    if start == 0:
        return b""

    preceding = source_bytes[:start]
    lines = preceding.split(b"\n")

    comment_lines: list[bytes] = []
    for line in reversed(lines):
        stripped = line.strip()
        if (
            stripped.startswith(b"#")
            or stripped.startswith(b"//")
            or stripped.startswith(b"/*")
            or stripped.startswith(b"*")
        ):
            comment_lines.insert(0, line)
        elif stripped == b"":
            if comment_lines:
                break
        else:
            break

    if not comment_lines:
        return b""
    return b"\n".join(comment_lines) + b"\n"


def chunk_file(
    source_code: str,
    language: str,
    file_path: str,
    max_chunk_chars: int = MAX_CHUNK_CHARS,
) -> list[CodeChunk]:
    """Parse a source file and extract semantic code chunks."""
    config = LANG_CONFIGS.get(language)
    if config is None:
        return []

    parser = Parser(config["language"])
    source_bytes = source_code.encode("utf-8")
    tree = parser.parse(source_bytes)

    chunks: list[CodeChunk] = []
    top_types = config["top_level_types"]

    for node in tree.root_node.children:
        if node.type not in top_types:
            continue

        leading = _get_leading_comment(source_bytes, node)
        node_text = leading + source_bytes[node.start_byte : node.end_byte]
        text = node_text.decode("utf-8", errors="replace")

        symbol_name = _extract_symbol_name(node)
        symbol_type = node.type.replace("_declaration", "").replace("_definition", "").replace("_item", "")

        if len(text) <= max_chunk_chars:
            chunks.append(
                CodeChunk(
                    text=text,
                    symbol_name=symbol_name,
                    symbol_type=symbol_type,
                    file_path=file_path,
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                )
            )
        else:
            nested_types = config.get("nested_types", set())
            sub_chunks = _split_large_node(
                node,
                source_bytes,
                nested_types,
                file_path,
                max_chunk_chars,
            )
            if sub_chunks:
                chunks.extend(sub_chunks)
            else:
                chunks.append(
                    CodeChunk(
                        text=text[:max_chunk_chars],
                        symbol_name=symbol_name,
                        symbol_type=symbol_type,
                        file_path=file_path,
                        start_line=node.start_point[0] + 1,
                        end_line=node.end_point[0] + 1,
                    )
                )

    return chunks


def _split_large_node(
    node,
    source_bytes: bytes,
    nested_types: set[str],
    file_path: str,
    max_chunk_chars: int,
) -> list[CodeChunk]:
    """Split a large AST node at nested boundaries."""
    chunks: list[CodeChunk] = []

    for child in node.children:
        if child.type in nested_types:
            leading = _get_leading_comment(source_bytes, child)
            child_text = leading + source_bytes[child.start_byte : child.end_byte]
            text = child_text.decode("utf-8", errors="replace")

            symbol_name = _extract_symbol_name(child)
            parent_name = _extract_symbol_name(node)
            full_name = f"{parent_name}.{symbol_name}" if parent_name else symbol_name

            chunks.append(
                CodeChunk(
                    text=text[:max_chunk_chars],
                    symbol_name=full_name,
                    symbol_type=child.type.replace("_declaration", "").replace("_definition", ""),
                    file_path=file_path,
                    start_line=child.start_point[0] + 1,
                    end_line=child.end_point[0] + 1,
                )
            )

    return chunks


def get_extensions_for_language(language: str) -> set[str]:
    config = LANG_CONFIGS.get(language, {})
    return config.get("extensions", set())
