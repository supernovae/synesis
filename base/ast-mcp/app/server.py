from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

# Define language configs (subset for AST outline)
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
}

_EXT_TO_LANG: dict[str, str] = {}
for _lang_name, _cfg in LANG_CONFIGS.items():
    for _ext in _cfg.get("extensions", set()):
        if _ext not in _EXT_TO_LANG:
            _EXT_TO_LANG[_ext] = _lang_name


def detect_language(file_path: str) -> str | None:
    p = Path(file_path)
    return _EXT_TO_LANG.get(p.suffix.lower())


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


mcp = FastMCP("AST Outline Server")


@mcp.tool()
def get_file_outline(file_path: str) -> str:
    """
    Get an AST-based outline of a file (classes, functions, docstrings) without reading the full file.
    Useful for exploring large codebases efficiently.
    """
    try:
        with open(file_path, encoding="utf-8", errors="replace") as f:
            source_code = f.read()
    except Exception as e:
        return f"Error reading file: {e}"

    language = detect_language(file_path)
    if not language:
        return "Error: Unsupported file extension or language not recognized."

    try:
        from tree_sitter_language_pack import get_parser

        parser = get_parser(language)
    except ImportError:
        return "Error: tree-sitter-language-pack not installed."
    except Exception as e:
        return f"Error loading parser for {language}: {e}"

    source_bytes = source_code.encode("utf-8")
    tree = parser.parse(source_bytes)

    config = LANG_CONFIGS.get(language, {})
    top_level = config.get("top_level", set())
    nested = config.get("nested", set())

    outline_lines = []
    for node in tree.root_node.children:
        if node.type not in top_level:
            continue

        leading = _get_leading_comment(source_bytes, node).decode("utf-8", errors="replace").strip()
        symbol_name = _extract_symbol_name(node)
        symbol_type = node.type.replace("_declaration", "").replace("_definition", "")

        if leading:
            outline_lines.append(f"// {leading}")
        outline_lines.append(f"{symbol_type} {symbol_name} (lines {node.start_point[0] + 1}-{node.end_point[0] + 1})")

        # Check for nested definitions (e.g., methods in a class)
        for child in node.children:
            if child.type in nested:
                child_leading = _get_leading_comment(source_bytes, child).decode("utf-8", errors="replace").strip()
                child_name = _extract_symbol_name(child)
                child_type = child.type.replace("_declaration", "").replace("_definition", "")

                if child_leading:
                    outline_lines.append(f"  // {child_leading}")
                outline_lines.append(
                    f"  {child_type} {child_name} (lines {child.start_point[0] + 1}-{child.end_point[0] + 1})"
                )

        outline_lines.append("")  # Empty line between top-level symbols

    if not outline_lines:
        return "No top-level symbols found or file is empty."

    return "\n".join(outline_lines)


def main():
    mcp.run()


if __name__ == "__main__":
    main()
