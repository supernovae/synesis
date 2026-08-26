"""Graph content pack build utilities.

Content packs are ZIP-based, graph-aware documentation/code packs. A pack contains
at least:

- manifest.json
- nodes/chunks.jsonl
- typed node files under nodes/
- edges.jsonl

Optional files include cleaned Markdown, graph-native typed nodes, context cards,
quality reports, and vector sidecars. Runtime loading is handled by the SynPack
v2 bulk importer.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import struct
import tempfile
import time
import zipfile
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import yaml
from synesis_telemetry import get_logger

from .code_graph import derive_graph_edges
from .embed_client import EmbedClient
from .enrichment import enrich_chunks_bulk
from .handlers import get_handler
from .handlers.base import Chunk, RawDocument
from .injection_scan import scan_chunk_text_detailed
from .nornic_writer import NORNIC_URI, NORNIC_VECTOR_INDEX, NornicGraphWriter, chunk_id_hash
from .pipeline import _code_chunk_metrics, _infer_artifact_kind
from .queue_runner import _build_source_config
from .schema import (
    CORPUS_VERSION,
    EMBEDDING_DIM,
    EMBEDDING_MODEL,
    EMBEDDING_PROFILE,
    SCHEMA_VERSION,
    catalog_entity,
)

logger = get_logger("synesis.indexer.synpack")

SYNPACK_FORMAT_VERSION = "2.0"
DEFAULT_PACK_MODEL = EMBEDDING_MODEL
V2_CHUNKS_PATH = "nodes/chunks.jsonl"
V2_DOCUMENTS_PATH = "nodes/documents.jsonl"
V2_PACKAGES_PATH = "nodes/packages.jsonl"
V2_MODULES_PATH = "nodes/modules.jsonl"
V2_SYMBOLS_PATH = "nodes/symbols.jsonl"
V2_CONCEPTS_PATH = "nodes/concepts.jsonl"
V2_PATTERNS_PATH = "nodes/patterns.jsonl"
V2_CONSTRAINTS_PATH = "nodes/constraints.jsonl"
V2_EXAMPLES_PATH = "nodes/examples.jsonl"
V2_CONTEXT_CARDS_PATH = "nodes/context_cards.jsonl"
V2_PACK_CARDS_PATH = "nodes/pack_cards.jsonl"
V2_PACK_MANIFEST_PATH = "nodes/pack_manifest.jsonl"
V2_EXTERNAL_REFS_PATH = "nodes/external_refs.jsonl"
V2_EVAL_CASES_PATH = "nodes/eval_cases.jsonl"
V2_RESOURCE_KINDS_PATH = "nodes/resource_kinds.jsonl"
V2_API_GROUP_VERSIONS_PATH = "nodes/api_group_versions.jsonl"
V2_SCHEMA_PROPERTIES_PATH = "nodes/schema_properties.jsonl"
V2_PLATFORM_CONSTRAINTS_PATH = "nodes/platform_constraints.jsonl"
V2_PLATFORM_COMMANDS_PATH = "nodes/platform_commands.jsonl"
V2_VALIDATION_RECIPES_PATH = "nodes/validation_recipes.jsonl"
V2_RISK_PATTERNS_PATH = "nodes/risk_patterns.jsonl"
V2_ENRICHMENT_PATH = "enrichment/enrichment.jsonl"
V2_QUALITY_PATH = "quality/report.json"
V2_VECTOR_INDEX_PATH = "vectors/index.json"
V2_VECTOR_BINARY_PATH = "vectors/chunks.f32"
V2_EXTRA_NODE_FILES: dict[str, str] = {
    "PackCard": V2_PACK_CARDS_PATH,
    "EvalCase": V2_EVAL_CASES_PATH,
    "ResourceKind": V2_RESOURCE_KINDS_PATH,
    "ApiGroupVersion": V2_API_GROUP_VERSIONS_PATH,
    "SchemaProperty": V2_SCHEMA_PROPERTIES_PATH,
    "PlatformConstraint": V2_PLATFORM_CONSTRAINTS_PATH,
    "PlatformCommand": V2_PLATFORM_COMMANDS_PATH,
    "ValidationRecipe": V2_VALIDATION_RECIPES_PATH,
    "RiskPattern": V2_RISK_PATTERNS_PATH,
}


class SynPackError(ValueError):
    """Raised when a SynPack is invalid or incompatible."""


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _sanitize_pack_id(value: str) -> str:
    safe = []
    for ch in value.strip().lower():
        if ch.isalnum() or ch in {"-", "_"}:
            safe.append(ch)
        elif ch in {".", "/", " "}:
            safe.append("-")
    out = "".join(safe).strip("-_")
    if not out:
        raise SynPackError("pack_id is required")
    return out[:96]


def read_manifest(pack_path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(pack_path) as zf:
        try:
            raw = zf.read("manifest.json")
        except KeyError as exc:
            raise SynPackError("manifest.json missing from SynPack") from exc
    try:
        manifest = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise SynPackError(f"manifest.json is not valid JSON: {exc}") from exc
    if not isinstance(manifest, dict):
        raise SynPackError("manifest.json must be an object")
    return manifest


def validate_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    pack_id = _sanitize_pack_id(str(manifest.get("pack_id", "")))
    model = str(manifest.get("embedding_model", manifest.get("recommended_model", "")) or "")
    dims = int(manifest.get("embedding_dimensions", manifest.get("dimensions", 0)) or 0)
    schema_version = int(manifest.get("synesis_catalog_schema_version", manifest.get("schema_version", 0)) or 0)

    if model != DEFAULT_PACK_MODEL:
        raise SynPackError(f"unsupported embedding_model {model!r}; expected {DEFAULT_PACK_MODEL!r}")
    if dims != EMBEDDING_DIM:
        raise SynPackError(f"embedding dimension mismatch: pack={dims}, catalog={EMBEDDING_DIM}")
    if schema_version and schema_version > SCHEMA_VERSION:
        raise SynPackError(f"pack requires schema v{schema_version}, runtime is v{SCHEMA_VERSION}")

    manifest["pack_id"] = pack_id
    manifest["embedding_model"] = model
    manifest["embedding_dimensions"] = dims
    manifest["embedding_profile"] = str(manifest.get("embedding_profile") or EMBEDDING_PROFILE)
    manifest["corpus_version"] = str(manifest.get("corpus_version") or CORPUS_VERSION)
    return manifest


def validate_synpack(pack_path: str | Path) -> dict[str, Any]:
    path = Path(pack_path)
    if not path.exists():
        raise SynPackError(f"SynPack not found: {path}")
    if not zipfile.is_zipfile(path):
        raise SynPackError(f"SynPack is not a zip file: {path}")
    manifest = validate_manifest(read_manifest(path))
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
    if V2_CHUNKS_PATH not in names:
        raise SynPackError("SynPack v2 nodes/chunks.jsonl missing from content pack")
    return manifest


def _detect_encoding(raw: bytes) -> str:
    """Best-effort encoding detection for diagnostic messages."""
    if raw[:3] == b"\xef\xbb\xbf":
        return "UTF-8-BOM"
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return "UTF-16"
    try:
        raw.decode("utf-8")
        return "UTF-8"
    except UnicodeDecodeError:
        pass
    try:
        raw.decode("ascii")
        return "ASCII"
    except UnicodeDecodeError:
        pass
    high_bytes = sum(1 for b in raw[:4096] if b > 127)
    if high_bytes == 0:
        return "ASCII"
    latin1_printable = sum(1 for b in raw[:4096] if 0xA0 <= b <= 0xFF)
    if latin1_printable > high_bytes * 0.5:
        return "Latin-1/Windows-1252"
    return "unknown-binary"


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        yield from _iter_jsonl_recover(path, raw, exc)
        return
    for line_no, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SynPackError(f"{path.name}:{line_no} invalid JSON: {exc}") from exc
        if not isinstance(obj, dict):
            raise SynPackError(f"{path.name}:{line_no} must be a JSON object")
        yield obj


def _iter_jsonl_recover(path: Path, raw: bytes, original_exc: UnicodeDecodeError) -> Iterable[dict[str, Any]]:
    """Re-read a JSONL file replacing invalid UTF-8 bytes with U+FFFD."""
    detected = _detect_encoding(raw)
    logger.warning(
        "synpack_jsonl_encoding_fallback",
        extra={
            "file": path.name,
            "byte_offset": original_exc.start,
            "reason": original_exc.reason,
            "detected_encoding": detected,
            "file_bytes": len(raw),
        },
    )
    text = raw.decode("utf-8", errors="replace")
    for line_no, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SynPackError(
                f"{path.name}:{line_no} invalid JSON after encoding recovery: {exc}; "
                f"original encoding error at byte {original_exc.start}: {original_exc.reason} "
                f"(detected {detected}). Rebuild the SynPack with valid UTF-8 sources."
            ) from exc
        if not isinstance(obj, dict):
            raise SynPackError(f"{path.name}:{line_no} must be a JSON object")
        yield obj


def _sanitize_str_values(obj: Any) -> Any:
    """Replace lone surrogates and other non-encodable chars in nested structures."""
    if isinstance(obj, str):
        try:
            obj.encode("utf-8")
            return obj
        except UnicodeEncodeError:
            return obj.encode("utf-8", errors="replace").decode("utf-8")
    if isinstance(obj, dict):
        return {k: _sanitize_str_values(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_str_values(item) for item in obj]
    return obj


def _write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("wb") as f:
        for row in rows:
            try:
                line = json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
            except UnicodeEncodeError:
                row = _sanitize_str_values(row)
                line = json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
                logger.warning(
                    "synpack_write_sanitized_row",
                    extra={"file": path.name, "row_id": str(row.get("id", ""))[:64]},
                )
            f.write(line.encode("utf-8"))
            count += 1
    return count


def _parse_agent_enrichment(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("agent_enrichment_json")
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {}
    return {}


def _as_list(value: Any) -> list[Any]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [str(value).strip()] if str(value).strip() else []


def _short_hash(*parts: Any) -> str:
    payload = "|".join(str(part) for part in parts)
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def _node_base(row: dict[str, Any], *, node_id: str, kind: str, name: str = "") -> dict[str, Any]:
    return {
        "id": node_id[:192],
        "kind": kind,
        "name": str(name or node_id)[:256],
        "pack": str(row.get("pack") or row.get("pack_id") or "")[:96],
        "pack_id": str(row.get("pack_id") or row.get("pack") or "")[:96],
        "pack_version": str(row.get("pack_version") or "")[:64],
        "source_version": str(row.get("source_version") or row.get("pack_source_version") or "")[:64],
        "domain": str(row.get("domain") or "")[:64],
        "language": str(row.get("language") or "")[:32],
        "source_url": str(row.get("source_url") or row.get("url") or "")[:512],
        "path": str(row.get("path") or row.get("module_path") or "")[:512],
        "authority": str(row.get("authority") or "")[:32],
        "visibility_scope": str(row.get("visibility_scope") or "global")[:16],
        "org_id": str(row.get("org_id") or "")[:64],
        "tenant_id": str(row.get("tenant_id") or "")[:64],
        "owner_user_id": str(row.get("owner_user_id") or "")[:64],
        "conversation_id": str(row.get("conversation_id") or "")[:128],
        "expires_at_epoch": int(row.get("expires_at_epoch") or 0),
        "acl_mode": str(row.get("acl_mode") or "open")[:16],
        "acl_groups": str(row.get("acl_groups") or "")[:1024],
        "acl_group_ids": [str(value)[:128] for value in _as_list(row.get("acl_group_ids"))[:100]],
    }


def _compact_chunk_row(row: dict[str, Any]) -> dict[str, Any]:
    compact = {key: value for key, value in row.items() if key != "embedding"}
    compact["kind"] = "Chunk"
    return compact


def _add_unique(nodes: dict[str, dict[str, Any]], node: dict[str, Any]) -> None:
    node_id = str(node.get("id") or "")
    if node_id:
        nodes[node_id] = node


def _pack_security_properties(manifest: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Return one fail-closed security envelope for generated pack-level nodes."""

    defaults: dict[str, Any] = {
        "visibility_scope": "global",
        "org_id": "",
        "tenant_id": "",
        "owner_user_id": "",
        "conversation_id": "",
        "expires_at_epoch": 0,
        "acl_mode": "open",
        "acl_groups": "",
        "acl_group_ids": [],
    }

    def present(value: Any) -> bool:
        return value is not None and value != "" and value != []

    def canonical(value: Any) -> str:
        if isinstance(value, (list, tuple, set)):
            return json.dumps(sorted(str(item) for item in value), separators=(",", ":"))
        return str(value)

    resolved: dict[str, Any] = {}
    for field, default in defaults.items():
        row_values: dict[str, Any] = {}
        for row in rows:
            value = row.get(field)
            if present(value):
                row_values.setdefault(canonical(value), value)
        if len(row_values) > 1:
            raise SynPackError(f"pack contains mixed {field} values; split it into security-homogeneous packs")

        explicit = manifest.get(field)
        row_value = next(iter(row_values.values()), None)
        if present(explicit) and row_value is not None and canonical(explicit) != canonical(row_value):
            raise SynPackError(f"manifest {field} conflicts with chunk security metadata")
        resolved[field] = explicit if present(explicit) else row_value if row_value is not None else default

    if not resolved["acl_group_ids"] and resolved["acl_groups"]:
        resolved["acl_group_ids"] = [item.strip() for item in str(resolved["acl_groups"]).split(",") if item.strip()][
            :100
        ]
    return {
        "visibility_scope": str(resolved["visibility_scope"] or "global")[:16],
        "org_id": str(resolved["org_id"] or "")[:64],
        "tenant_id": str(resolved["tenant_id"] or "")[:64],
        "owner_user_id": str(resolved["owner_user_id"] or "")[:64],
        "conversation_id": str(resolved["conversation_id"] or "")[:128],
        "expires_at_epoch": int(resolved["expires_at_epoch"] or 0),
        "acl_mode": str(resolved["acl_mode"] or "open")[:16],
        "acl_groups": str(resolved["acl_groups"] or "")[:1024],
        "acl_group_ids": [str(value)[:128] for value in _as_list(resolved["acl_group_ids"])[:100]],
    }


def _iter_enrichment_texts(enrichment: dict[str, Any], keys: tuple[str, ...]) -> Iterable[tuple[str, str]]:
    for key in keys:
        for item in _as_list(enrichment.get(key)):
            if isinstance(item, dict):
                text = str(item.get("text") or item.get("title") or item.get("name") or item.get("summary") or "")
            else:
                text = str(item)
            text = text.strip()
            if text:
                yield key, text[:2048]


def _first_enrichment_text(value: Any) -> str:
    for item in _as_list(value):
        if isinstance(item, dict):
            text = str(
                item.get("text")
                or item.get("code")
                or item.get("summary")
                or item.get("title")
                or item.get("name")
                or ""
            )
        else:
            text = str(item)
        text = text.strip()
        if text:
            return text[:4096]
    return ""


def _string_list(value: Any, *, limit: int = 24, item_limit: int = 160) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in _as_list(value):
        if isinstance(item, dict):
            text = str(item.get("text") or item.get("name") or item.get("title") or "")
        else:
            text = str(item)
        text = text.strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text[:item_limit])
        if len(out) >= limit:
            break
    return out


def _csv(value: Any, *, limit: int = 24) -> str:
    return ",".join(_string_list(value, limit=limit))


def _example_node(
    row: dict[str, Any],
    pack_id: str,
    key: str,
    item: Any,
) -> dict[str, Any] | None:
    data = item if isinstance(item, dict) else {"text": str(item)}
    text = str(data.get("text") or data.get("code") or data.get("summary") or "").strip()
    code = str(data.get("code") or "").strip()
    if not text and not code:
        return None
    title = str(data.get("title") or data.get("name") or text or code)[:128]
    node_id = f"{pack_id}:example:{_short_hash(key, title, text, code)}"
    return {
        **_node_base(row, node_id=node_id, kind="Example", name=title),
        "example_type": key,
        "text": (text or code)[:4096],
        "code": code[:8192],
        "language": str(data.get("language") or row.get("language") or "")[:32],
        "imports": _csv(data.get("imports"), limit=32) or str(data.get("imports") or "")[:2048],
        "setup": str(data.get("setup") or "")[:2048],
        "expected_output": str(data.get("expected_output") or "")[:2048],
        "test_command": str(data.get("test_command") or data.get("verification") or "")[:512],
        "runnable": bool(data.get("runnable", False)),
        "anti_example": bool(data.get("anti_example", False) or key == "anti_examples"),
        "applies_to": _csv(data.get("applies_to") or row.get("symbol_fqn"), limit=24),
        "source_span": str(data.get("source_span") or row.get("heading_path") or "")[:512],
        "retrieval_terms": _csv(data.get("retrieval_terms") or data.get("query_aliases"), limit=32),
        "query_aliases": _csv(data.get("query_aliases"), limit=32),
    }


def _context_card_node(row: dict[str, Any], pack_id: str, enrichment: dict[str, Any]) -> dict[str, Any] | None:
    what_to_use = _first_enrichment_text(enrichment.get("what_to_use") or enrichment.get("agent_hook"))
    minimal_example = _first_enrichment_text(enrichment.get("minimal_example") or enrichment.get("canonical_examples"))
    verification = _first_enrichment_text(enrichment.get("verification") or enrichment.get("verification_hints"))
    warnings = _first_enrichment_text(
        enrichment.get("do_not_use") or enrichment.get("hidden_warnings") or enrichment.get("anti_patterns")
    )
    if not any((what_to_use, minimal_example, verification, warnings)):
        return None
    symbol = str(row.get("symbol_fqn") or row.get("symbol_name") or row.get("document_name") or row.get("id") or "")
    title = symbol[:128] or "Context card"
    node_id = f"{pack_id}:context-card:{_short_hash(row.get('id'), title)}"
    text = "\n\n".join(
        part
        for part in (
            f"What to use: {what_to_use}" if what_to_use else "",
            f"Do not use: {warnings}" if warnings else "",
            f"Minimal example: {minimal_example}" if minimal_example else "",
            f"Verification: {verification}" if verification else "",
        )
        if part
    )
    return {
        **_node_base(row, node_id=node_id, kind="ContextCard", name=title),
        "text": text[:8192],
        "what_to_use": what_to_use,
        "when_to_use": _first_enrichment_text(enrichment.get("when_to_use") or enrichment.get("task_intents")),
        "do_not_use": warnings,
        "minimal_example": minimal_example,
        "verification": verification,
        "related_apis": _csv(
            enrichment.get("related_apis") or enrichment.get("related_symbols") or enrichment.get("related_interfaces"),
            limit=32,
        ),
        "source_refs": _csv([row.get("source_url"), row.get("doc_id"), row.get("symbol_fqn")], limit=16),
        "retrieval_terms": _csv(enrichment.get("retrieval_terms") or enrichment.get("agent_query_hints"), limit=48),
        "query_aliases": _csv(enrichment.get("query_aliases"), limit=48),
        "task_intents": _csv(enrichment.get("task_intents"), limit=32),
    }


def _pack_card_node(row: dict[str, Any], pack_id: str, enrichment: dict[str, Any]) -> dict[str, Any] | None:
    context_card = _context_card_node(row, pack_id, enrichment)
    if not context_card:
        return None
    title = str(context_card.get("name") or context_card.get("title") or "Pack card")[:160]
    node_id = f"{pack_id}:pack-card:{_short_hash(row.get('id'), title)}"
    claims = _as_list(enrichment.get("claims") or enrichment.get("api_contract") or enrichment.get("agent_hook"))
    constraints = _as_list(
        enrichment.get("constraints")
        or enrichment.get("safety_contract")
        or enrichment.get("hidden_warnings")
        or enrichment.get("anti_patterns")
    )
    evidence = _as_list(enrichment.get("evidence_spans") or context_card.get("source_refs"))
    return {
        **context_card,
        "id": node_id,
        "kind": "PackCard",
        "name": title,
        "card_type": str(
            row.get("card_type") or enrichment.get("card_type") or row.get("artifact_kind") or "reference"
        )[:64],
        "topic": str(row.get("symbol_fqn") or row.get("symbol_name") or row.get("document_name") or title)[:256],
        "intent": _csv(enrichment.get("task_intents"), limit=16),
        "claims": json.dumps(claims[:16], ensure_ascii=False, sort_keys=True),
        "constraints": json.dumps(constraints[:16], ensure_ascii=False, sort_keys=True),
        "evidence_refs": json.dumps(evidence[:24], ensure_ascii=False, sort_keys=True),
        "freshness": str(
            row.get("source_version") or row.get("pack_source_version") or row.get("source_release") or ""
        )[:128],
        "provenance": _csv([row.get("source_url"), row.get("doc_id"), row.get("pack_id")], limit=16),
        "taxonomy_domains": _csv([row.get("domain"), row.get("language"), row.get("scope_tags")], limit=32),
    }


def materialize_synpack_v2(
    rows: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    manifest: dict[str, Any],
    root: str | Path,
    extra_nodes_by_kind: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Write a NornicDB-native typed SynPack v2 bundle under ``root``.

    Legacy flat files remain the compatibility contract. These typed files give
    importers a richer, validated graph without forcing them to infer documents,
    symbols, constraints, examples, and unresolved references from chunk rows.
    """

    root_path = Path(root)
    pack_id = str(manifest.get("pack_id") or "")
    documents: dict[str, dict[str, Any]] = {}
    packages: dict[str, dict[str, Any]] = {}
    modules: dict[str, dict[str, Any]] = {}
    symbols: dict[str, dict[str, Any]] = {}
    concepts: dict[str, dict[str, Any]] = {}
    patterns: dict[str, dict[str, Any]] = {}
    constraints: dict[str, dict[str, Any]] = {}
    examples: dict[str, dict[str, Any]] = {}
    context_cards: dict[str, dict[str, Any]] = {}
    pack_cards: dict[str, dict[str, Any]] = {}
    external_refs: dict[str, dict[str, Any]] = {}
    extra_nodes: dict[str, dict[str, dict[str, Any]]] = {
        kind: {}
        for kind in V2_EXTRA_NODE_FILES
        if kind != "PackCard" and extra_nodes_by_kind and kind in extra_nodes_by_kind
    }
    enrichment_rows: list[dict[str, Any]] = []
    typed_edges: list[dict[str, Any]] = [dict(edge) for edge in edges]
    node_ids: set[str] = set()
    fallback_enriched = 0
    enriched = 0

    for row in rows:
        chunk_id = str(row.get("id") or row.get("chunk_id") or "")
        if not chunk_id:
            continue
        node_ids.add(chunk_id)
        doc_id = str(row.get("doc_id") or "")
        if doc_id:
            _add_unique(
                documents,
                {
                    **_node_base(row, node_id=doc_id, kind="Document", name=str(row.get("document_name") or doc_id)),
                    "doc_id": doc_id,
                    "document_name": str(row.get("document_name") or "")[:256],
                    "heading_path": str(row.get("heading_path") or "")[:512],
                    "source_type": str(row.get("source_type") or "")[:32],
                },
            )
        path = str(row.get("path") or row.get("module_path") or "")
        package_name = str(row.get("package_name") or "")
        if package_name:
            package_id = f"{pack_id}:package:{package_name}"
            _add_unique(
                packages,
                {
                    **_node_base(row, node_id=package_id, kind="Package", name=package_name),
                    "package_name": package_name[:128],
                },
            )
            typed_edges.append({"type": "CONTAINS", "source_id": package_id, "target_id": chunk_id, "source": "pack"})
        module_path = str(row.get("module_path") or path or "")
        if module_path:
            module_id = f"{pack_id}:module:{module_path}"
            _add_unique(
                modules,
                {
                    **_node_base(row, node_id=module_id, kind="Module", name=module_path),
                    "module_path": module_path[:256],
                    "package_name": package_name[:128],
                },
            )
            typed_edges.append({"type": "CONTAINS", "source_id": module_id, "target_id": chunk_id, "source": "pack"})
        if path:
            file_id = f"{pack_id}:file:{path}"
            _add_unique(
                documents,
                {
                    **_node_base(row, node_id=file_id, kind="Document", name=path),
                    "doc_id": doc_id or file_id,
                    "document_name": str(row.get("document_name") or path)[:256],
                    "source_type": str(row.get("source_type") or "")[:32],
                },
            )
        symbol_fqn = str(row.get("symbol_fqn") or "")
        if symbol_fqn:
            _add_unique(
                symbols,
                {
                    **_node_base(
                        row, node_id=symbol_fqn, kind="Symbol", name=str(row.get("symbol_name") or symbol_fqn)
                    ),
                    "symbol_fqn": symbol_fqn[:256],
                    "symbol_name": str(row.get("symbol_name") or "")[:128],
                    "symbol_kind": str(row.get("symbol_kind") or row.get("symbol_type") or "")[:64],
                    "package_name": package_name[:128],
                },
            )
        enrichment = _parse_agent_enrichment(row)
        row["retrieval_terms"] = row.get("retrieval_terms") or _csv(enrichment.get("retrieval_terms"), limit=64)
        row["query_aliases"] = row.get("query_aliases") or _csv(enrichment.get("query_aliases"), limit=64)
        row["task_intents"] = row.get("task_intents") or _csv(enrichment.get("task_intents"), limit=48)
        row["content_type"] = row.get("content_type") or str(manifest.get("content_type") or "developer")
        row["source_release"] = row.get("source_release") or str(manifest.get("source_release") or "")
        row["upstream_commit"] = row.get("upstream_commit") or str(
            manifest.get("upstream_commit") or row.get("commit") or ""
        )
        row["upstream_tag"] = row.get("upstream_tag") or str(manifest.get("upstream_tag") or "")
        row["freshness_score"] = row.get("freshness_score", manifest.get("freshness_score", -1.0))
        row["trust_score"] = row.get("trust_score", manifest.get("trust_score", -1.0))
        if enrichment.get("enrichment_status") == "fallback":
            fallback_enriched += 1
        elif enrichment:
            enriched += 1
        enrichment_rows.append(
            {
                "chunk_id": chunk_id,
                "doc_id": doc_id,
                "symbol_fqn": symbol_fqn,
                "prompt_id": enrichment.get("prompt_id") or row.get("enrichment_profile") or "",
                "enrichment": enrichment,
            }
        )
        for key, text in _iter_enrichment_texts(
            enrichment, ("task_intents", "query_aliases", "agent_query_hints", "related_interfaces")
        ):
            node_id = f"{pack_id}:concept:{_short_hash(key, text)}"
            _add_unique(
                concepts,
                {
                    **_node_base(row, node_id=node_id, kind="Concept", name=text[:128]),
                    "concept_type": key,
                    "text": text,
                },
            )
            typed_edges.append(
                {"type": "RELATED_TO", "source_id": chunk_id, "target_id": node_id, "source": "enrichment"}
            )
        for key, text in _iter_enrichment_texts(enrichment, ("anti_patterns", "hidden_warnings")):
            node_id = f"{pack_id}:pattern:{_short_hash(key, text)}"
            replacement_api = _first_enrichment_text(
                enrichment.get("replacement_api")
                or enrichment.get("replacement_apis")
                or enrichment.get("preferred_replacements")
            )
            _add_unique(
                patterns,
                {
                    **_node_base(row, node_id=node_id, kind="Pattern", name=text[:128]),
                    "pattern_type": key,
                    "text": text,
                    "polarity": "anti_pattern" if key == "anti_patterns" else "warning",
                    "deprecated": key == "hidden_warnings",
                    "deprecation_status": "avoid" if key == "anti_patterns" else "warning",
                    "replacement_api": replacement_api[:256],
                    "retrieval_terms": _csv(
                        enrichment.get("retrieval_terms") or enrichment.get("query_aliases"), limit=48
                    ),
                },
            )
            typed_edges.append(
                {"type": "HAS_PATTERN", "source_id": chunk_id, "target_id": node_id, "source": "enrichment"}
            )
            if replacement_api:
                replacement_id = f"{pack_id}:concept:{_short_hash('replacement', replacement_api)}"
                _add_unique(
                    concepts,
                    {
                        **_node_base(row, node_id=replacement_id, kind="Concept", name=replacement_api[:128]),
                        "concept_type": "replacement_api",
                        "text": replacement_api[:2048],
                    },
                )
                typed_edges.append(
                    {"type": "REPLACED_BY", "source_id": node_id, "target_id": replacement_id, "source": "enrichment"}
                )
        for key, text in _iter_enrichment_texts(
            enrichment, ("safety_contract", "api_contract", "verification_hints", "version_scope")
        ):
            node_id = f"{pack_id}:constraint:{_short_hash(key, text)}"
            _add_unique(
                constraints,
                {
                    **_node_base(row, node_id=node_id, kind="Constraint", name=text[:128]),
                    "constraint_type": key,
                    "text": text,
                },
            )
            typed_edges.append(
                {"type": "HAS_CONSTRAINT", "source_id": chunk_id, "target_id": node_id, "source": "enrichment"}
            )
        for key in ("canonical_examples", "examples", "anti_examples"):
            for item in _as_list(enrichment.get(key)):
                example_node = _example_node(row, pack_id, key, item)
                if not example_node:
                    continue
                _add_unique(examples, example_node)
                typed_edges.append(
                    {
                        "type": "HAS_EXAMPLE",
                        "source_id": chunk_id,
                        "target_id": example_node["id"],
                        "source": "enrichment",
                    }
                )
                if bool(example_node.get("anti_example")):
                    typed_edges.append(
                        {
                            "type": "WARNS_ABOUT",
                            "source_id": example_node["id"],
                            "target_id": chunk_id,
                            "source": "enrichment",
                        }
                    )

        context_card = _context_card_node(row, pack_id, enrichment)
        if context_card:
            _add_unique(context_cards, context_card)
            typed_edges.append(
                {
                    "type": "HAS_CONTEXT_CARD",
                    "source_id": chunk_id,
                    "target_id": context_card["id"],
                    "source": "enrichment",
                }
            )
        pack_card = _pack_card_node(row, pack_id, enrichment)
        if pack_card:
            _add_unique(pack_cards, pack_card)
            typed_edges.append(
                {
                    "type": "HAS_PACK_CARD",
                    "source_id": chunk_id,
                    "target_id": pack_card["id"],
                    "source": "enrichment",
                }
            )

    node_ids.update(documents)
    node_ids.update(packages)
    node_ids.update(modules)
    node_ids.update(symbols)
    node_ids.update(concepts)
    node_ids.update(patterns)
    node_ids.update(constraints)
    node_ids.update(examples)
    node_ids.update(context_cards)
    node_ids.update(pack_cards)
    if extra_nodes_by_kind:
        for kind, nodes_for_kind in extra_nodes_by_kind.items():
            if kind not in V2_EXTRA_NODE_FILES:
                raise SynPackError(f"unsupported SynPack v2 extra node kind: {kind}")
            bucket = pack_cards if kind == "PackCard" else extra_nodes.setdefault(kind, {})
            for node in nodes_for_kind:
                if not isinstance(node, dict):
                    raise SynPackError(f"{kind} extra node must be a JSON object")
                node_id = str(node.get("id") or "").strip()
                if not node_id:
                    raise SynPackError(f"{kind} extra node is missing id")
                normalized = {
                    **_node_base(node, node_id=node_id, kind=kind, name=str(node.get("name") or node_id)),
                    **node,
                    "id": node_id[:192],
                    "kind": kind,
                    "pack": str(node.get("pack") or node.get("pack_id") or pack_id)[:96],
                    "pack_id": str(node.get("pack_id") or node.get("pack") or pack_id)[:96],
                    "pack_version": str(node.get("pack_version") or manifest.get("pack_version") or "")[:64],
                    "source_version": str(
                        node.get("source_version")
                        or node.get("pack_source_version")
                        or manifest.get("source_version")
                        or ""
                    )[:64],
                    "domain": str(node.get("domain") or manifest.get("domain") or "")[:64],
                    "content_type": str(node.get("content_type") or manifest.get("content_type") or "developer"),
                }
                bucket[node_id] = normalized
        node_ids.update(pack_cards)
        for bucket in extra_nodes.values():
            node_ids.update(bucket)

    manifest_node_id = f"{pack_id}:manifest"
    package_terms = sorted({str(row.get("package_name") or "").strip() for row in rows if row.get("package_name")})
    routing_terms = [
        pack_id,
        manifest.get("language"),
        manifest.get("domain"),
        manifest.get("content_type"),
        *package_terms[:64],
        *(str(row.get("task_intents") or "") for row in rows[:128]),
        *(str(row.get("query_aliases") or "") for row in rows[:128]),
        *(str(row.get("symbol_fqn") or "") for row in rows[:256]),
        *(str(row.get("symbol_name") or "") for row in rows[:256]),
    ]
    pack_security = _pack_security_properties(manifest, rows)
    pack_manifest = {
        "id": manifest_node_id,
        "kind": "PackManifest",
        "name": str(manifest.get("name") or pack_id)[:160],
        "text": " ".join(
            str(value).strip()
            for value in (
                manifest.get("name") or pack_id,
                manifest.get("description"),
                manifest.get("language"),
                manifest.get("domain"),
                manifest.get("content_type"),
                manifest.get("source_version"),
            )
            if str(value or "").strip()
        )[:4096],
        "pack": pack_id,
        "pack_id": pack_id,
        "pack_version": str(manifest.get("pack_version") or manifest.get("version") or "")[:64],
        "source_version": str(manifest.get("source_version") or "")[:64],
        "source_release": str(manifest.get("source_release") or "")[:128],
        "upstream_commit": str(manifest.get("upstream_commit") or "")[:128],
        "upstream_tag": str(manifest.get("upstream_tag") or "")[:128],
        "language": str(manifest.get("language") or "")[:32],
        "domain": str(manifest.get("domain") or "")[:64],
        "content_type": str(manifest.get("content_type") or "developer")[:64],
        "install_profile": str(manifest.get("install_profile") or "")[:128],
        "embedding_profile": str(manifest.get("embedding_profile") or EMBEDDING_PROFILE)[:128],
        "retrieval_terms": _csv(routing_terms, limit=192),
        "package_names": package_terms[:128],
        "trust_score": manifest.get("trust_score", -1.0),
        "freshness_score": manifest.get("freshness_score", -1.0),
        **pack_security,
    }
    node_ids.add(manifest_node_id)
    for node_id in sorted(pack_cards):
        typed_edges.append(
            {"type": "HAS_PACK_CARD", "source_id": manifest_node_id, "target_id": node_id, "source": "pack"}
        )
    for node_id in sorted(context_cards):
        typed_edges.append(
            {"type": "HAS_CONTEXT_CARD", "source_id": manifest_node_id, "target_id": node_id, "source": "pack"}
        )

    missing_before_external_refs = 0
    unresolved_edges = 0
    for edge in typed_edges:
        source_id = str(edge.get("source_id") or edge.get("from") or "")
        target_id = str(edge.get("target_id") or edge.get("to") or "")
        if "unresolved" in str(edge.get("resolution_confidence") or "").lower():
            unresolved_edges += 1
        for ref_id, ref_role in ((source_id, "source"), (target_id, "target")):
            if not ref_id or ref_id in node_ids or ref_id in external_refs:
                continue
            missing_before_external_refs += 1
            ref_kind = (
                "call" if ref_id.startswith("call:") else "import" if ref_id.startswith("import:") else "external"
            )
            external_refs[ref_id] = {
                "id": ref_id[:192],
                "kind": "ExternalRef",
                "name": ref_id[:256],
                "external_ref_kind": ref_kind,
                "reference_role": ref_role,
                "pack": pack_id,
                "pack_id": pack_id,
                "pack_version": str(manifest.get("pack_version") or "")[:64],
                "domain": str(manifest.get("domain") or "")[:64],
                "language": str(manifest.get("language") or "")[:32],
                "resolution_confidence": "unresolved",
            }
    node_ids.update(external_refs)

    dangling_after_external_refs = 0
    for edge in typed_edges:
        source_id = str(edge.get("source_id") or edge.get("from") or "")
        target_id = str(edge.get("target_id") or edge.get("to") or "")
        if source_id and source_id not in node_ids:
            dangling_after_external_refs += 1
        if target_id and target_id not in node_ids:
            dangling_after_external_refs += 1

    enrichment_coverage = enriched / len(rows) if rows else 1.0
    graph_resolution = 1.0 - (unresolved_edges / len(typed_edges)) if typed_edges else 1.0
    typed_node_count = (
        len(rows)
        + len(documents)
        + len(packages)
        + len(modules)
        + len(symbols)
        + len(concepts)
        + len(patterns)
        + len(constraints)
        + len(examples)
        + len(context_cards)
        + len(pack_cards)
        + len(external_refs)
        + sum(len(bucket) for bucket in extra_nodes.values())
        + 1
    )
    pack_manifest.update(
        {
            "node_count": typed_node_count,
            "chunk_count": len(rows),
            "edge_count": len(typed_edges),
            "example_count": len(examples),
            "context_card_count": len(context_cards),
            "pack_card_count": len(pack_cards),
            "pattern_count": len(patterns),
            "constraint_count": len(constraints),
            "quality_score": round((enrichment_coverage + max(0.0, graph_resolution)) / 2.0, 4),
        }
    )

    chunk_rows = [_compact_chunk_row(row) for row in rows]
    _write_jsonl(root_path / V2_CHUNKS_PATH, chunk_rows)
    _write_jsonl(root_path / V2_DOCUMENTS_PATH, documents.values())
    _write_jsonl(root_path / V2_PACKAGES_PATH, packages.values())
    _write_jsonl(root_path / V2_MODULES_PATH, modules.values())
    _write_jsonl(root_path / V2_SYMBOLS_PATH, symbols.values())
    _write_jsonl(root_path / V2_CONCEPTS_PATH, concepts.values())
    _write_jsonl(root_path / V2_PATTERNS_PATH, patterns.values())
    _write_jsonl(root_path / V2_CONSTRAINTS_PATH, constraints.values())
    _write_jsonl(root_path / V2_EXAMPLES_PATH, examples.values())
    _write_jsonl(root_path / V2_CONTEXT_CARDS_PATH, context_cards.values())
    _write_jsonl(root_path / V2_PACK_CARDS_PATH, pack_cards.values())
    _write_jsonl(root_path / V2_PACK_MANIFEST_PATH, [pack_manifest])
    _write_jsonl(root_path / V2_EXTERNAL_REFS_PATH, external_refs.values())
    for kind, node_path in V2_EXTRA_NODE_FILES.items():
        if kind in extra_nodes:
            _write_jsonl(root_path / node_path, extra_nodes[kind].values())
    _write_jsonl(root_path / V2_ENRICHMENT_PATH, enrichment_rows)

    edge_counts = Counter(str(edge.get("type") or "").upper() for edge in typed_edges)
    edges_root = root_path / "edges"
    grouped: dict[str, list[dict[str, Any]]] = {}
    for edge in typed_edges:
        edge_type = str(edge.get("type") or "related").lower()
        grouped.setdefault(edge_type, []).append(edge)
    for edge_type, group in grouped.items():
        _write_jsonl(edges_root / f"{edge_type}.jsonl", group)

    vector_index_rows: list[dict[str, Any]] = []
    vector_path = root_path / V2_VECTOR_BINARY_PATH
    vector_path.parent.mkdir(parents=True, exist_ok=True)
    with vector_path.open("wb") as f:
        for idx, row in enumerate(rows):
            vec = row.get("embedding")
            if not isinstance(vec, list):
                raise SynPackError(f"row {idx} missing embedding for v2 vector sidecar")
            if len(vec) != EMBEDDING_DIM:
                raise SynPackError(f"row {idx} embedding dimension mismatch: got {len(vec)}, expected {EMBEDDING_DIM}")
            f.write(struct.pack(f"<{EMBEDDING_DIM}f", *(float(x) for x in vec)))
            vector_index_rows.append({"chunk_id": str(row.get("id") or row.get("chunk_id") or ""), "offset": idx})
    vector_index = {
        "format": "synpack-v2-vectors",
        "dtype": "float32",
        "byte_order": "little",
        "dimensions": EMBEDDING_DIM,
        "count": len(vector_index_rows),
        "embedding_model": DEFAULT_PACK_MODEL,
        "embedding_profile": EMBEDDING_PROFILE,
        "rows": vector_index_rows,
    }
    (root_path / V2_VECTOR_INDEX_PATH).write_text(json.dumps(vector_index, indent=2, sort_keys=True), encoding="utf-8")

    node_counts = {
        "Chunk": len(rows),
        "Document": len(documents),
        "Package": len(packages),
        "Module": len(modules),
        "Symbol": len(symbols),
        "Concept": len(concepts),
        "Pattern": len(patterns),
        "Constraint": len(constraints),
        "Example": len(examples),
        "ContextCard": len(context_cards),
        "PackCard": len(pack_cards),
        "PackManifest": 1,
        "ExternalRef": len(external_refs),
    }
    for kind, bucket in extra_nodes.items():
        node_counts[kind] = len(bucket)
    total_nodes = sum(node_counts.values())
    quality_report = {
        "format": "synpack-v2-quality",
        "pack_id": pack_id,
        "node_counts_by_kind": node_counts,
        "edge_counts_by_type": dict(sorted(edge_counts.items())),
        "node_count": total_nodes,
        "chunk_count": len(rows),
        "edge_count": len(typed_edges),
        "fallback_enriched": fallback_enriched,
        "enriched": enriched,
        "example_count": len(examples),
        "context_card_count": len(context_cards),
        "pack_card_count": len(pack_cards),
        "anti_pattern_count": len(patterns),
        "enrichment_coverage_score": round(enrichment_coverage, 4),
        "graph_resolution_score": round(max(0.0, graph_resolution), 4),
        "dangling_edge_count_before_external_refs": missing_before_external_refs,
        "dangling_edge_count": dangling_after_external_refs,
        "external_ref_count": len(external_refs),
        "unresolved_edge_count": unresolved_edges,
    }
    quality_path = root_path / V2_QUALITY_PATH
    quality_path.parent.mkdir(parents=True, exist_ok=True)
    quality_path.write_text(json.dumps(quality_report, indent=2, sort_keys=True), encoding="utf-8")
    return quality_report


def list_packs(*, nornic_uri: str = NORNIC_URI, limit: int = 16384) -> list[dict[str, Any]]:
    writer = NornicGraphWriter(uri=nornic_uri or NORNIC_URI)
    with writer.driver.session(database=writer.database) as session:
        rows = session.run(
            """
            MATCH (n:ContentNode)
            WHERE coalesce(n.pack, "") <> ""
            RETURN n.pack AS pack_id,
                   max(n.pack_version) AS pack_version,
                   max(coalesce(n.pack_source_version, n.source_version)) AS pack_source_version,
                   max(n.language) AS language,
                   max(n.domain) AS domain,
                   max(n.pack_artifact_hash) AS pack_artifact_hash,
                   count(n) AS node_count,
                   count(n.embedding) AS embedding_count,
                   count(CASE WHEN n.kind = 'Chunk' THEN 1 END) AS chunk_count,
                   count(CASE WHEN n.kind = 'PackCard' THEN 1 END) AS pack_card_count,
                   count(CASE WHEN n.kind = 'ContextCard' THEN 1 END) AS context_card_count,
                   collect(DISTINCT n.kind)[0..12] AS sample_kinds
            ORDER BY pack_id
            LIMIT $limit
            """,
            limit=limit,
        )
        return [dict(row) for row in rows]


def _single_row(session: Any, cypher: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    row = session.run(cypher, params or {}).single()
    return dict(row) if row else {}


def diagnose_pack(
    *,
    pack_id: str,
    query: str = "",
    nornic_uri: str = NORNIC_URI,
    limit: int = 5,
) -> dict[str, Any]:
    """Return pack health diagnostics without requiring shell heredocs."""
    sanitized_pack_id = _sanitize_pack_id(pack_id)
    sample_limit = max(1, min(limit, 25))
    terms = [term.lower() for term in query.split() if len(term) >= 3][:24]
    writer = NornicGraphWriter(uri=nornic_uri or NORNIC_URI)
    with writer.driver.session(database=writer.database) as session:
        result: dict[str, Any] = {
            "ok": True,
            "pack_id": sanitized_pack_id,
            "database": writer.database,
            "connectivity": _single_row(session, "RETURN 1 AS ok"),
        }
        result["counts"] = _single_row(
            session,
            """
            MATCH (n:ContentNode {pack: $pack_id})
            RETURN count(n) AS total,
                   count(n.embedding) AS with_embedding,
                   count(n.text) AS with_text,
                   count(n.content) AS with_content,
                   count(n.kind) AS with_kind,
                   count(n.language) AS with_language,
                   count(n.domain) AS with_domain,
                   count(n.pack_version) AS with_pack_version,
                   count(n.pack_source_version) AS with_pack_source_version,
                   count(n.source_version) AS with_source_version,
                   count(n.pack_artifact_hash) AS with_pack_artifact_hash
            """,
            {"pack_id": sanitized_pack_id},
        )
        result["text_counts_sampled"] = _single_row(
            session,
            """
            MATCH (n:ContentNode {pack: $pack_id})
            WITH n LIMIT 5000
            RETURN count(n) AS sampled,
                   count(n.text) AS with_text,
                   count(n.content) AS with_content,
                   count(n.embedding) AS with_embedding,
                   count(n.kind) AS with_kind,
                   count(n.language) AS with_language,
                   count(n.domain) AS with_domain
            """,
            {"pack_id": sanitized_pack_id},
        )
        result["kinds"] = [
            dict(row)
            for row in session.run(
                """
                MATCH (n:ContentNode {pack: $pack_id})
                WHERE n.kind IS NOT NULL
                RETURN n.kind AS kind, count(n) AS count
                ORDER BY count DESC
                LIMIT 25
                """,
                {"pack_id": sanitized_pack_id},
            )
        ]
        result["sample_nodes"] = [
            dict(row)
            for row in session.run(
                """
                MATCH (n:ContentNode {pack: $pack_id})
                RETURN n.id AS id,
                       n.kind AS kind,
                       n.language AS language,
                       n.domain AS domain,
                       n.document_name AS document_name,
                       n.package_name AS package_name,
                       n.symbol_fqn AS symbol_fqn,
                       n.artifact_kind AS artifact_kind,
                       n.text AS text,
                       keys(n) AS property_keys
                LIMIT $limit
                """,
                {"pack_id": sanitized_pack_id, "limit": sample_limit},
            )
        ]
        for node in result["sample_nodes"]:
            if node.get("text"):
                node["text"] = str(node["text"])[:300]
            if isinstance(node.get("property_keys"), list):
                node["property_keys"] = sorted(str(key) for key in node["property_keys"])[:80]
        result["embedding_samples"] = [
            dict(row)
            for row in session.run(
                """
                MATCH (n:ContentNode {pack: $pack_id})
                WHERE n.embedding IS NOT NULL
                RETURN n.id AS id,
                       n.kind AS kind,
                       n.document_name AS document_name,
                       n.package_name AS package_name,
                       n.symbol_fqn AS symbol_fqn,
                       size(n.embedding) AS embedding_size,
                       n.embedding[0] AS first_value,
                       n.embedding[1] AS second_value,
                       n.embedding[1023] AS last_value
                LIMIT $limit
                """,
                {"pack_id": sanitized_pack_id, "limit": sample_limit},
            )
        ]
        result["indexes"] = [
            dict(row)
            for row in session.run(
                """
                SHOW INDEXES
                YIELD name, type, state
                RETURN name, type, state
                ORDER BY name
                """
            )
        ]
        if terms:
            result["query_terms"] = terms
            result["query_term_hits_sampled"] = _single_row(
                session,
                """
                MATCH (n:ContentNode {pack: $pack_id})
                WITH n LIMIT 50000
                WHERE any(term IN $terms WHERE toLower(coalesce(n.text, n.content, n.name, "")) CONTAINS term)
                RETURN count(n) AS matching_nodes
                """,
                {"pack_id": sanitized_pack_id, "terms": terms},
            )
            result["query_term_samples"] = [
                dict(row)
                for row in session.run(
                    """
                    MATCH (n:ContentNode {pack: $pack_id})
                    WHERE any(term IN $terms WHERE toLower(coalesce(n.text, n.content, n.name, "")) CONTAINS term)
                    RETURN n.id AS id,
                           n.kind AS kind,
                           n.document_name AS document_name,
                           n.package_name AS package_name,
                           n.symbol_fqn AS symbol_fqn,
                           n.text AS text
                    LIMIT $limit
                    """,
                    {"pack_id": sanitized_pack_id, "terms": terms, "limit": sample_limit},
                )
            ]
            for node in result["query_term_samples"]:
                if node.get("text"):
                    node["text"] = str(node["text"])[:300]
        return result


def search_pack(
    query: str,
    *,
    pack_id: str,
    top_k: int = 5,
    nornic_uri: str = NORNIC_URI,
    embedder_url: str = "",
) -> list[dict[str, Any]]:
    embedder_kwargs = {"url": embedder_url} if embedder_url else {}
    embeddings = EmbedClient(**embedder_kwargs).embed_texts([query])
    if not embeddings or len(embeddings[0]) != EMBEDDING_DIM:
        raise SynPackError(f"embedder returned invalid query vector for SynPack search; expected {EMBEDDING_DIM} dims")
    query_vector = [float(x) for x in embeddings[0]]
    limit = max(1, min(top_k, 50))
    candidate_limit = max(limit, min(limit * 10, 500))
    writer = NornicGraphWriter(uri=nornic_uri or NORNIC_URI)
    with writer.driver.session(database=writer.database) as session:
        vector_rows = session.run(
            """
            CALL db.index.vector.queryNodes('embeddings', $candidate_limit, $query_vector)
            YIELD node, score
            WHERE node.pack = $pack_id
            RETURN node, score
            ORDER BY score DESC
            LIMIT $limit
            """,
            {
                "query_vector": query_vector,
                "pack_id": _sanitize_pack_id(pack_id),
                "limit": limit,
                "candidate_limit": candidate_limit,
            },
        )
        out = []
        for row in vector_rows:
            item = _compact_search_result(dict(row["node"]))
            item["score"] = row["score"]
            item["search_backend"] = "vector"
            out.append(item)
        if out:
            return out

        lexical_terms = [term.lower() for term in query.split() if len(term) >= 3][:24]
        lexical_rows = session.run(
            """
            MATCH (node:ContentNode)
            WHERE node.pack = $pack_id
              AND any(term IN $terms WHERE toLower(coalesce(node.text, node.content, node.name, "")) CONTAINS term)
            WITH node,
                 reduce(score = 0.0, term IN $terms |
                   score + CASE WHEN toLower(coalesce(node.text, node.content, node.name, "")) CONTAINS term
                                THEN 1.0 ELSE 0.0 END
                 ) AS lexical_score
            RETURN node, lexical_score AS score
            ORDER BY score DESC
            LIMIT $limit
            """,
            {
                "pack_id": _sanitize_pack_id(pack_id),
                "terms": lexical_terms,
                "limit": limit,
            },
        )
        for row in lexical_rows:
            item = _compact_search_result(dict(row["node"]))
            item["score"] = row["score"]
            item["search_backend"] = "lexical_fallback"
            out.append(item)
        return out


def _compact_search_result(node: dict[str, Any]) -> dict[str, Any]:
    """Return a model-readable search hit without heavyweight index payloads."""
    field_limits = {
        "text": 2400,
        "content": 2400,
        "summary": 1200,
        "chunk_summary": 1200,
        "safety_contract": 1600,
        "lifecycle_model": 1200,
        "retrieval_terms": 1200,
        "keywords": 1000,
        "agent_enrichment_json": 2400,
    }
    preferred_fields = [
        "id",
        "kind",
        "pack",
        "pack_id",
        "pack_version",
        "pack_source_version",
        "language",
        "domain",
        "artifact_kind",
        "document_name",
        "package_name",
        "module_path",
        "repo_path",
        "path",
        "heading_path",
        "section",
        "symbol_fqn",
        "symbol_name",
        "symbol_kind",
        "source_url",
        "url",
        "summary",
        "chunk_summary",
        "safety_contract",
        "lifecycle_model",
        "perf_tier",
        "related_interfaces",
        "related_symbols",
        "replacement_api",
        "tags",
        "retrieval_terms",
        "keywords",
        "agent_enrichment_json",
        "text",
        "content",
    ]
    omitted_fields = {
        "embedding",
        "entities_json",
        "scan_signals",
        "section_boundaries_json",
        "query_aliases",
        "task_intents",
    }
    compact: dict[str, Any] = {}
    for key in preferred_fields:
        if key not in node or key in omitted_fields:
            continue
        value = node[key]
        if value is None or value == "":
            continue
        if isinstance(value, str):
            limit = field_limits.get(key)
            compact[key] = value[:limit] if limit else value
        else:
            compact[key] = value
    return compact


def diagnose_pack_vector_search(
    query: str,
    *,
    pack_id: str,
    top_k: int = 8,
    nornic_uri: str = NORNIC_URI,
    embedder_url: str = "",
) -> dict[str, Any]:
    """Show vector-search candidates before and after pack filtering."""
    embedder_kwargs = {"url": embedder_url} if embedder_url else {}
    embeddings = EmbedClient(**embedder_kwargs).embed_texts([query])
    if not embeddings:
        raise SynPackError("embedder returned no query vector for SynPack search diagnostics")
    query_vector = [float(x) for x in embeddings[0]]
    limit = max(1, min(top_k, 50))
    candidate_limit = max(limit, min(limit * 25, 1000))
    sanitized_pack_id = _sanitize_pack_id(pack_id)
    writer = NornicGraphWriter(uri=nornic_uri or NORNIC_URI)
    with writer.driver.session(database=writer.database) as session:
        raw_candidates = [
            dict(row)
            for row in session.run(
                """
                CALL db.index.vector.queryNodes('embeddings', $candidate_limit, $query_vector)
                YIELD node, score
                RETURN node.id AS id,
                       node.pack AS pack,
                       node.kind AS kind,
                       node.document_name AS document_name,
                       node.package_name AS package_name,
                       node.symbol_fqn AS symbol_fqn,
                       node.text AS text,
                       score AS score
                ORDER BY score DESC
                LIMIT $limit
                """,
                {
                    "query_vector": query_vector,
                    "candidate_limit": candidate_limit,
                    "limit": limit,
                },
            )
        ]
        filtered_candidates = [
            dict(row)
            for row in session.run(
                """
                CALL db.index.vector.queryNodes('embeddings', $candidate_limit, $query_vector)
                YIELD node, score
                WHERE node.pack = $pack_id
                RETURN node.id AS id,
                       node.pack AS pack,
                       node.kind AS kind,
                       node.document_name AS document_name,
                       node.package_name AS package_name,
                       node.symbol_fqn AS symbol_fqn,
                       node.text AS text,
                       score AS score
                ORDER BY score DESC
                LIMIT $limit
                """,
                {
                    "query_vector": query_vector,
                    "pack_id": sanitized_pack_id,
                    "candidate_limit": candidate_limit,
                    "limit": limit,
                },
            )
        ]
    for rows in (raw_candidates, filtered_candidates):
        for row in rows:
            if row.get("text"):
                row["text"] = str(row["text"])[:300]
    return {
        "ok": True,
        "pack_id": sanitized_pack_id,
        "query_vector_dimensions": len(query_vector),
        "query_vector_norm_sample": round(sum(x * x for x in query_vector[:128]) ** 0.5, 6),
        "candidate_limit": candidate_limit,
        "raw_vector_candidate_count": len(raw_candidates),
        "pack_filtered_candidate_count": len(filtered_candidates),
        "raw_vector_candidates": raw_candidates,
        "pack_filtered_candidates": filtered_candidates,
    }


def diagnose_pack_vector_index(
    *,
    pack_id: str,
    nornic_uri: str = NORNIC_URI,
    top_k: int = 5,
) -> dict[str, Any]:
    """Probe the vector index with an embedding already stored in the pack."""
    sanitized_pack_id = _sanitize_pack_id(pack_id)
    limit = max(1, min(top_k, 25))
    writer = NornicGraphWriter(uri=nornic_uri or NORNIC_URI)
    with writer.driver.session(database=writer.database) as session:
        sample = session.run(
            """
            MATCH (n:ContentNode {pack: $pack_id})
            WHERE n.embedding IS NOT NULL
            RETURN n.id AS id,
                   n.kind AS kind,
                   n.document_name AS document_name,
                   n.package_name AS package_name,
                   n.symbol_fqn AS symbol_fqn,
                   n.embedding AS embedding
            LIMIT 1
            """,
            {"pack_id": sanitized_pack_id},
        ).single()
        if not sample:
            return {"ok": False, "pack_id": sanitized_pack_id, "error": "no embedded nodes found"}
        embedding = sample["embedding"]
        embedding_list = list(embedding) if isinstance(embedding, list) else []
        sample_values = embedding_list[:3] + embedding_list[-3:] if len(embedding_list) >= 6 else embedding_list
        numeric_values = [value for value in embedding_list if isinstance(value, int | float)]
        candidates = (
            [
                dict(row)
                for row in session.run(
                    f"""
                CALL db.index.vector.queryNodes('{NORNIC_VECTOR_INDEX}', $limit, $query_vector)
                YIELD node, score
                RETURN node.id AS id,
                       node.pack AS pack,
                       node.kind AS kind,
                       node.document_name AS document_name,
                       node.package_name AS package_name,
                       node.symbol_fqn AS symbol_fqn,
                       score AS score
                ORDER BY score DESC
                LIMIT $limit
                """,
                    {"query_vector": embedding_list, "limit": limit},
                )
            ]
            if embedding_list
            else []
        )
        return {
            "ok": True,
            "pack_id": sanitized_pack_id,
            "sample_node": {
                "id": sample["id"],
                "kind": sample["kind"],
                "document_name": sample["document_name"],
                "package_name": sample["package_name"],
                "symbol_fqn": sample["symbol_fqn"],
            },
            "embedding_python_type": type(embedding).__name__,
            "embedding_dimensions": len(embedding_list),
            "numeric_value_count": len(numeric_values),
            "sample_values": sample_values,
            "self_query_candidate_count": len(candidates),
            "self_query_candidates": candidates,
        }


def repair_pack_vector_index(*, nornic_uri: str = NORNIC_URI) -> dict[str, Any]:
    """Drop and recreate the Synesis vector index."""
    writer = NornicGraphWriter(uri=nornic_uri or NORNIC_URI)
    with writer.driver.session(database=writer.database) as session:
        session.run(f"DROP INDEX {NORNIC_VECTOR_INDEX} IF EXISTS")
        session.run(writer._VECTOR_INDEX_DDL)
        indexes = [
            dict(row)
            for row in session.run(
                """
                SHOW INDEXES
                YIELD name, type, state, populationPercent
                WHERE name = $name
                RETURN name, type, state, populationPercent
                """,
                {"name": NORNIC_VECTOR_INDEX},
            )
        ]
    return {"ok": True, "index": NORNIC_VECTOR_INDEX, "indexes": indexes}


def retouch_pack_embeddings(
    *,
    pack_id: str,
    nornic_uri: str = NORNIC_URI,
    batch_size: int = 25,
) -> dict[str, Any]:
    """Re-set stored embedding properties to force vector-index update hooks."""
    sanitized_pack_id = _sanitize_pack_id(pack_id)
    size = max(1, min(int(batch_size or 25), 50))
    writer = NornicGraphWriter(uri=nornic_uri or NORNIC_URI)
    with writer.driver.session(database=writer.database) as session:
        ids = [
            str(row["id"])
            for row in session.run(
                """
                MATCH (n:ContentNode {pack: $pack_id})
                WHERE n.embedding IS NOT NULL
                RETURN n.id AS id
                """,
                {"pack_id": sanitized_pack_id},
            )
            if row.get("id")
        ]
        touched = 0
        for offset in range(0, len(ids), size):
            batch = ids[offset : offset + size]
            row = session.run(
                """
                MATCH (n:ContentNode)
                WHERE n.id IN $ids
                SET n.embedding = n.embedding
                RETURN count(n) AS touched
                """,
                {"ids": batch},
            ).single()
            touched += int(row["touched"] if row else 0)
    return {
        "ok": True,
        "pack_id": sanitized_pack_id,
        "embedded_node_count": len(ids),
        "touched": touched,
        "batch_size": size,
    }


def _load_bootstrap_items(sources_path: Path) -> list[dict[str, Any]]:
    with sources_path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    items = data.get("items") or data.get("sources") or []
    if not isinstance(items, list):
        raise SynPackError(f"{sources_path} must contain items or sources list")
    return [x for x in items if isinstance(x, dict)]


def build_pack_from_sources(
    sources_path: str | Path,
    output_path: str | Path,
    *,
    pack_id: str,
    pack_version: str = "1.0.0",
    source_version: str = "",
    language: str = "",
    domain: str = "",
    enrich_full: bool = False,
    llm_url: str = "",
    embedder_url: str = "",
    max_chunks: int = 0,
) -> dict[str, Any]:
    pack_id = _sanitize_pack_id(pack_id)
    source_path = Path(sources_path)
    out_path = Path(output_path)
    tmp = Path(tempfile.mkdtemp(prefix="synpack-build-"))
    rows_path = tmp / "nodes.jsonl"
    edges_path = tmp / "edges.jsonl"
    sources_lock: list[dict[str, Any]] = []
    total_rows = 0
    rows: list[dict[str, Any]] = []
    embedder = EmbedClient(**({"url": embedder_url} if embedder_url else {}))
    items = _load_bootstrap_items(source_path)

    with rows_path.open("w", encoding="utf-8") as rows_f, edges_path.open("w", encoding="utf-8") as edges_f:
        for item in items:
            source_config = _build_source_config(item)
            source_config.update(
                {
                    "pack_id": pack_id,
                    "pack_version": pack_version,
                    "pack_source_version": source_version,
                    "pack_partition": pack_id,
                }
            )
            if language and not source_config.get("language"):
                source_config["language"] = language
            if domain and not source_config.get("domain"):
                source_config["domain"] = domain

            handler = get_handler(source_config["handler"])
            docs = handler.fetch(source_config)
            sources_lock.append(
                {
                    "name": source_config.get("name", ""),
                    "handler": source_config.get("handler", ""),
                    "uri": item.get("uri", ""),
                    "documents": len(docs),
                }
            )
            parsed: list[tuple[RawDocument, Chunk]] = []
            for doc in docs:
                for chunk in handler.parse_and_chunk(doc):
                    parsed.append((doc, chunk))
                    if max_chunks and len(parsed) >= max_chunks:
                        break
                if max_chunks and len(parsed) >= max_chunks:
                    break

            enrich_items = [(chunk.text, doc.name, chunk.heading_path, chunk.section) for doc, chunk in parsed]
            enrichments = enrich_chunks_bulk(enrich_items, enrich_full=enrich_full, llm_url=llm_url)
            embed_inputs = [
                f"{e.context_prefix} {chunk.text}" if e.context_prefix else chunk.text
                for (_doc, chunk), e in zip(parsed, enrichments)
            ]
            embeddings = embedder.embed_texts(embed_inputs) if embed_inputs else []

            for (doc, chunk), enrichment, embedding in zip(parsed, enrichments, embeddings):
                chunk_id = chunk_id_hash(chunk.text, f"{pack_id}:{doc.doc_id}:{chunk.section}")
                status, signals = scan_chunk_text_detailed(chunk.text)
                language_out = (
                    chunk.metadata.get("language", "")
                    or doc.metadata.get("language", "")
                    or source_config.get("language", "")
                    or language
                )
                content_format = str(chunk.metadata.get("content_format", "") or "")
                artifact_kind = str(source_config.get("artifact_kind", "") or "") or _infer_artifact_kind(
                    source_config.get("handler", ""), content_format, str(language_out)
                )
                has_code, code_signal_count, code_density = _code_chunk_metrics(chunk.text)
                row = catalog_entity(
                    chunk_id=chunk_id,
                    text=chunk.text,
                    embedding=embedding,
                    doc_id=doc.doc_id,
                    chunk_index=chunk.chunk_index,
                    context_prefix=enrichment.context_prefix,
                    chunk_summary=enrichment.chunk_summary,
                    heading_path=chunk.heading_path,
                    section=chunk.section,
                    document_name=doc.name,
                    source_type=str(getattr(handler, "source_type", "docs")),
                    handler=source_config.get("handler", "synpack"),
                    domain=str(source_config.get("domain", domain or "")),
                    tags=",".join(str(t) for t in source_config.get("config", {}).get("tags", []) if str(t).strip()),
                    keywords=enrichment.keywords,
                    origin_type=str(source_config.get("origin_type", "curated")),
                    authority=str(source_config.get("authority", "vetted")),
                    pack_id=pack_id,
                    pack_version=pack_version,
                    pack_source_version=source_version,
                    pack_partition=pack_id,
                    symbol_kind=str(
                        chunk.metadata.get("symbol_kind", "") or chunk.metadata.get("symbol_type", "") or ""
                    ),
                    symbol_fqn=str(chunk.metadata.get("symbol_fqn", "") or ""),
                    package_name=str(
                        chunk.metadata.get("package_name", "") or doc.metadata.get("package_name", "") or ""
                    ),
                    import_refs=str(chunk.metadata.get("import_refs", "") or doc.metadata.get("import_refs", "")),
                    call_refs=str(chunk.metadata.get("call_refs", "") or doc.metadata.get("call_refs", "")),
                    source_url=chunk.metadata.get("source_url") or doc.source_url,
                    scan_status=status,
                    scan_signals=",".join(signals),
                    content_format=content_format,
                    symbol_type=str(chunk.metadata.get("symbol_type", "") or ""),
                    language=str(language_out or ""),
                    module_path=str(chunk.metadata.get("file_path", "") or doc.metadata.get("module_path", "")),
                    symbol_name=str(chunk.metadata.get("symbol_name", "") or ""),
                    artifact_kind=artifact_kind,
                    has_code=has_code,
                    code_signal_count=code_signal_count,
                    code_density=code_density,
                    code_language=str(language_out or content_format or "") if has_code else "",
                    corpus_class=str(source_config.get("corpus_class", "") or "coder_enriched"),
                    content_profile=str(source_config.get("content_profile", "") or "reference"),
                    crawl_timestamp=int(time.time() * 1000),
                    enrichment_profile="synpack_build_v1",
                )
                rows.append(row)
                rows_f.write(json.dumps(row, ensure_ascii=False) + "\n")
                total_rows += 1

            if max_chunks and total_rows >= max_chunks:
                break
        edges = derive_graph_edges(rows, include_structural_edges=True)
        for edge in edges:
            edges_f.write(json.dumps(edge, ensure_ascii=False, sort_keys=True) + "\n")

    manifest = {
        "format": "synesis-content-pack",
        "format_version": SYNPACK_FORMAT_VERSION,
        "pack_id": pack_id,
        "pack_version": pack_version,
        "version": pack_version,
        "source_version": source_version,
        "language": language,
        "domain": domain or language,
        "embedding_model": DEFAULT_PACK_MODEL,
        "embedding_dimensions": EMBEDDING_DIM,
        "embedding_profile": EMBEDDING_PROFILE,
        "corpus_version": CORPUS_VERSION,
        "content_graph_schema_version": SCHEMA_VERSION,
        "schema_version": SCHEMA_VERSION,
        "partitions": [pack_id],
        "metadata_fields": [
            "package_name",
            "symbol_kind",
            "symbol_fqn",
            "scope_tags",
            "content_profile",
            "constraint_kind",
            "import_refs",
            "call_refs",
        ],
        "created_at": int(time.time()),
        "row_count": total_rows,
        "node_count": total_rows,
        "edge_count": len(edges),
        "requires_bulk_import": total_rows >= 1000,
        "install_profile": "nornicdb-v2-typed-graph",
        "sources_lock_sha256": "",
        "nodes_sha256": _sha256_file(rows_path),
        "edges_sha256": _sha256_file(edges_path),
    }
    sources_lock_path = tmp / "sources.lock.json"
    sources_lock_path.write_text(json.dumps(sources_lock, indent=2), encoding="utf-8")
    manifest["sources_lock_sha256"] = _sha256_file(sources_lock_path)
    quality_report = materialize_synpack_v2(rows, edges, manifest, tmp)
    manifest.update(
        {
            "node_count": quality_report["node_count"],
            "chunk_count": quality_report["chunk_count"],
            "edge_count": quality_report["edge_count"],
            "node_counts_by_kind": quality_report["node_counts_by_kind"],
            "edge_counts_by_type": quality_report["edge_counts_by_type"],
            "pack_card_count": quality_report.get("pack_card_count", 0),
            "dangling_edge_count": quality_report["dangling_edge_count"],
            "external_ref_count": quality_report["external_ref_count"],
            "quality_report_sha256": _sha256_file(tmp / "quality" / "report.json"),
        }
    )
    (tmp / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in ("manifest.json", "nodes.jsonl", "edges.jsonl", "sources.lock.json"):
            zf.write(tmp / name, name)
        for dirname in ("nodes", "edges", "vectors", "enrichment", "quality"):
            directory = tmp / dirname
            for path in sorted(directory.rglob("*")):
                if path.is_file():
                    zf.write(path, str(path.relative_to(tmp)))

    artifact_hash = _sha256_file(out_path)
    shutil.rmtree(tmp, ignore_errors=True)
    return {"ok": True, "pack_id": pack_id, "rows": total_rows, "path": str(out_path), "artifact_hash": artifact_hash}
