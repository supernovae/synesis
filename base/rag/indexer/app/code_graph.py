"""Deterministic code graph edge derivation.

This module intentionally avoids LLM calls. It resolves lightweight metadata
from handlers and pack builders into graph edges that NornicDB can traverse.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any


def csv_values(value: Any) -> list[str]:
    if isinstance(value, list):
        raw = value
    else:
        raw = str(value or "").split(",")
    seen: list[str] = []
    for item in raw:
        text = str(item).strip()
        if text and text not in seen:
            seen.append(text)
    return seen


def derive_graph_edges(
    rows: list[dict[str, Any]],
    *,
    include_structural_edges: bool = False,
) -> list[dict[str, Any]]:
    """Create deterministic graph edges from indexed row metadata.

    Resolution strategy, in order:
    1. exact symbol_fqn
    2. same-file symbol name or qualified suffix
    3. global symbol name or qualified suffix
    4. module/package match for imports
    5. placeholder target for unresolved external refs
    """

    resolver = _SymbolResolver(rows)
    edges: list[dict[str, Any]] = []

    for row in rows:
        chunk_id = str(row.get("id") or "")
        if not chunk_id:
            continue
        symbol_fqn = str(row.get("symbol_fqn") or "")
        source_id = symbol_fqn or chunk_id
        path = str(row.get("path") or row.get("module_path") or "")
        pack = str(row.get("pack") or row.get("pack_id") or "global")
        file_id = f"{pack}:file:{path}" if path else ""

        if include_structural_edges:
            doc_id = str(row.get("doc_id") or "")
            if doc_id:
                edges.append({"type": "CONTAINS", "source_id": doc_id, "target_id": chunk_id, "source": "code_graph"})
            if symbol_fqn:
                edges.append(
                    {"type": "DEFINES", "source_id": chunk_id, "target_id": symbol_fqn, "source": "code_graph"}
                )

        for ref in csv_values(row.get("doc_relation_ids")):
            edges.append({"type": "REFERENCES", "source_id": chunk_id, "target_id": ref, "source": "metadata"})

        for ref in csv_values(row.get("import_refs")):
            target_id, confidence = resolver.resolve_import(ref, row)
            edges.append(
                {
                    "type": "IMPORTS",
                    "source_id": file_id or source_id,
                    "target_id": target_id,
                    "import_ref": ref,
                    "resolution_confidence": confidence,
                    "source": "code_graph",
                }
            )

        for ref in csv_values(row.get("call_refs")):
            target_id, confidence = resolver.resolve_call(ref, row)
            edges.append(
                {
                    "type": "CALLS",
                    "source_id": source_id,
                    "target_id": target_id,
                    "call_ref": ref,
                    "resolution_confidence": confidence,
                    "source": "code_graph",
                }
            )

    return _dedupe_edges(edges)


def extract_import_refs(source_code: str, language: str) -> list[str]:
    refs: list[str] = []
    if language == "python":
        patterns = [
            r"(?m)^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+\w+)?",
            r"(?m)^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+",
        ]
    elif language in {"javascript", "typescript", "ecma"}:
        patterns = [
            r"""(?m)^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]""",
            r"""(?m)^\s*import\s+['"]([^'"]+)['"]""",
            r"""require\(\s*['"]([^'"]+)['"]\s*\)""",
        ]
    elif language == "go":
        patterns = [r"""(?m)^\s*import\s+(?:\(\s*)?"([^"]+)"""]
    elif language == "rust":
        patterns = [r"(?m)^\s*use\s+([^;]+);"]
    elif language in {"java", "quarkus"}:
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


def extract_call_refs(source_code: str, language: str) -> list[str]:
    del language
    refs: list[str] = []
    for match in re.finditer(r"\b([A-Za-z_][\w.]*)\s*\(", source_code):
        name = match.group(1)
        leaf = name.rsplit(".", 1)[-1]
        if leaf.lower() in _CALL_KEYWORDS:
            continue
        refs.append(name)
    return refs


def _dedupe_edges(edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str, str, str, str]] = set()
    deduped: list[dict[str, Any]] = []
    for edge in edges:
        key = (
            str(edge.get("type") or ""),
            str(edge.get("source_id") or ""),
            str(edge.get("target_id") or ""),
            str(edge.get("import_ref") or ""),
            str(edge.get("call_ref") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(edge)
    return deduped


class _SymbolResolver:
    def __init__(self, rows: list[dict[str, Any]]):
        self.by_fqn: dict[str, str] = {}
        self.by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.by_leaf: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.by_module: dict[str, list[dict[str, Any]]] = defaultdict(list)

        for row in rows:
            fqn = str(row.get("symbol_fqn") or "")
            name = str(row.get("symbol_name") or "")
            path = str(row.get("path") or row.get("module_path") or "")
            module = _module_key(path)
            if fqn:
                self.by_fqn[fqn] = fqn
                self.by_leaf[_leaf(fqn)].append(row)
            if name:
                self.by_name[name].append(row)
                self.by_leaf[_leaf(name)].append(row)
            if module:
                self.by_module[module].append(row)

    def resolve_call(self, ref: str, source_row: dict[str, Any]) -> tuple[str, str]:
        ref = ref.strip()
        if not ref:
            return "call:", "unresolved"
        if ref in self.by_fqn:
            return self.by_fqn[ref], "exact_fqn"

        candidates = self.by_name.get(ref) or self.by_leaf.get(_leaf(ref)) or []
        target = _best_candidate(candidates, source_row)
        if target:
            return str(target.get("symbol_fqn") or target.get("id")), "symbol"
        return f"call:{ref}", "unresolved"

    def resolve_import(self, ref: str, source_row: dict[str, Any]) -> tuple[str, str]:
        ref = ref.strip()
        if not ref:
            return "import:", "unresolved"

        module = _module_key(ref)
        module_candidates = self.by_module.get(module) or []
        if not module_candidates:
            module_candidates = [
                row
                for key, rows in self.by_module.items()
                if key.endswith(f".{module}") or key.endswith(f"/{module}") or module.endswith(f".{key}")
                for row in rows
            ]
        target = _best_candidate(module_candidates, source_row)
        if target:
            path = str(target.get("path") or target.get("module_path") or "")
            pack = str(target.get("pack") or target.get("pack_id") or "global")
            return f"{pack}:file:{path}" if path else str(target.get("id")), "module"

        candidates = self.by_name.get(_leaf(ref)) or self.by_leaf.get(_leaf(ref)) or []
        target = _best_candidate(candidates, source_row)
        if target:
            return str(target.get("symbol_fqn") or target.get("id")), "symbol"
        return f"import:{ref}", "external_or_unresolved"


def _best_candidate(candidates: list[dict[str, Any]], source_row: dict[str, Any]) -> dict[str, Any] | None:
    if not candidates:
        return None
    source_path = str(source_row.get("path") or source_row.get("module_path") or "")
    source_pack = str(source_row.get("pack") or source_row.get("pack_id") or "")
    for row in candidates:
        if str(row.get("path") or row.get("module_path") or "") == source_path:
            return row
    for row in candidates:
        if str(row.get("pack") or row.get("pack_id") or "") == source_pack:
            return row
    return candidates[0]


def _leaf(value: str) -> str:
    return value.strip().replace("::", ".").replace("/", ".").rsplit(".", 1)[-1].rsplit(":", 1)[-1]


def _module_key(value: str) -> str:
    text = value.strip().replace("\\", "/")
    if not text:
        return ""
    if text.endswith((".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java")):
        text = text.rsplit(".", 1)[0]
    return text.strip("./").replace("/", ".")
