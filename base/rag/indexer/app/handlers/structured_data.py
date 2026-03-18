"""Handler: Structured data files (YAML, JSON, TOML, XML, HCL).

Provides format-aware chunking that respects document boundaries and
semantic structure. Kubernetes manifests, Ansible playbooks, Terraform
configs, Helm charts, Docker Compose files, Maven POMs — all get
chunked at their natural boundaries instead of arbitrary word splits.

Also usable as a library: `chunk_structured_content()` is called by
github_code when it encounters structured files inside a repo clone.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import yaml

from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.structured_data")

MAX_CHUNK_CHARS = 6000


@register
class StructuredDataHandler:
    handler_type = "structured_data"
    source_type = "structured"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        """Fetch a structured data file from a URL or local path."""
        config = source_config.get("config", {})
        url = config.get("url", "")
        local_path = config.get("path", "")
        name = source_config.get("name", url or local_path)
        fmt = config.get("format", "")

        if url:
            import httpx

            try:
                with httpx.Client(timeout=30, follow_redirects=True) as client:
                    resp = client.get(url)
                    resp.raise_for_status()
                    content = resp.text
            except Exception as e:
                logger.error("Failed to fetch %s: %s", url, e)
                return []

            if not fmt:
                fmt = _detect_format(url)

            return [
                RawDocument(
                    doc_id=f"structured:{name}",
                    name=name,
                    content=content,
                    source_url=url,
                    metadata={"format": fmt},
                )
            ]

        if local_path:
            p = Path(local_path)
            if not p.exists():
                logger.error("Local file not found: %s", local_path)
                return []
            content = p.read_text(encoding="utf-8", errors="replace")
            if not fmt:
                fmt = _detect_format(local_path)
            return [
                RawDocument(
                    doc_id=f"structured:{name}",
                    name=name,
                    content=content,
                    source_url=local_path,
                    metadata={"format": fmt},
                )
            ]

        logger.error("structured_data handler requires config.url or config.path")
        return []

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        content = doc.content if isinstance(doc.content, str) else doc.content.decode("utf-8", errors="replace")
        fmt = doc.metadata.get("format", "yaml")
        return chunk_structured_content(content, fmt, doc.name, doc.name)


def chunk_structured_content(
    content: str,
    fmt: str,
    file_path: str,
    document_name: str,
) -> list[Chunk]:
    """Public API for format-aware structured data chunking.

    Called directly by github_code handler for structured files found in repos.
    """
    if fmt in ("yaml", "yml"):
        return _chunk_yaml(content, file_path, document_name)
    if fmt == "json":
        return _chunk_json(content, file_path, document_name)
    if fmt == "xml":
        return _chunk_xml(content, file_path, document_name)
    if fmt == "toml":
        return _chunk_toml(content, file_path, document_name)
    if fmt in ("hcl", "tf"):
        return _chunk_hcl(content, file_path, document_name)
    return _chunk_generic(content, file_path, document_name, fmt)


# ── YAML ──────────────────────────────────────────────────────────────


def _chunk_yaml(content: str, file_path: str, document_name: str) -> list[Chunk]:
    """Split YAML on --- document separators, then chunk each resource."""
    chunks: list[Chunk] = []
    idx = 0

    try:
        documents = list(yaml.safe_load_all(content))
    except yaml.YAMLError:
        return _chunk_generic(content, file_path, document_name, "yaml")

    raw_docs = content.split("\n---")

    for i, doc in enumerate(documents):
        if doc is None:
            continue
        if not isinstance(doc, dict):
            text = yaml.dump(doc, default_flow_style=False) if not isinstance(doc, str) else doc
            chunks.append(
                Chunk(
                    text=text[:MAX_CHUNK_CHARS],
                    section=f"document-{i}",
                    heading_path=f"{file_path} > document-{i}",
                    chunk_index=idx,
                    metadata={"content_format": "yaml", "symbol_type": "document"},
                )
            )
            idx += 1
            continue

        kind = doc.get("kind", "")
        name = _k8s_name(doc) or doc.get("name", "") or f"document-{i}"
        api_version = doc.get("apiVersion", "")

        if kind:
            heading = f"{kind}/{name}"
            symbol_type = f"k8s_{kind.lower()}"
        else:
            heading = name
            symbol_type = _detect_yaml_type(doc)

        raw_text = raw_docs[i].strip() if i < len(raw_docs) else yaml.dump(doc, default_flow_style=False)
        if raw_text.startswith("---"):
            raw_text = raw_text[3:].strip()

        if len(raw_text) <= MAX_CHUNK_CHARS:
            chunks.append(
                Chunk(
                    text=raw_text,
                    section=heading,
                    heading_path=f"{file_path} > {heading}",
                    chunk_index=idx,
                    metadata={
                        "content_format": "yaml",
                        "symbol_type": symbol_type,
                        "symbol_name": name,
                        "k8s_kind": kind,
                        "k8s_api_version": api_version,
                    },
                )
            )
            idx += 1
        else:
            sub_chunks = _split_yaml_resource(doc, heading, file_path, raw_text)
            for sc in sub_chunks:
                sc.chunk_index = idx
                sc.metadata.setdefault("content_format", "yaml")
                sc.metadata.setdefault("symbol_type", symbol_type)
                sc.metadata.setdefault("symbol_name", name)
                chunks.append(sc)
                idx += 1

    if not chunks and content.strip():
        chunks.append(
            Chunk(
                text=content[:MAX_CHUNK_CHARS],
                section=file_path,
                heading_path=file_path,
                chunk_index=0,
                metadata={"content_format": "yaml"},
            )
        )

    return chunks


def _k8s_name(doc: dict) -> str:
    meta = doc.get("metadata", {})
    if isinstance(meta, dict):
        return meta.get("name", "")
    return ""


def _detect_yaml_type(doc: dict) -> str:
    """Detect the type of a non-Kubernetes YAML document."""
    if "tasks" in doc or "hosts" in doc or "roles" in doc:
        return "ansible_play"
    if "services" in doc and "version" in doc:
        return "compose_service"
    if "stages" in doc or "jobs" in doc:
        return "ci_pipeline"
    return "config"


def _split_yaml_resource(doc: dict, heading: str, file_path: str, raw_text: str) -> list[Chunk]:
    """Split an oversized YAML resource at top-level keys."""
    chunks: list[Chunk] = []

    if "tasks" in doc and isinstance(doc["tasks"], list):
        for j, task in enumerate(doc["tasks"]):
            task_name = task.get("name", f"task-{j}") if isinstance(task, dict) else f"task-{j}"
            task_text = yaml.dump(task, default_flow_style=False)
            chunks.append(
                Chunk(
                    text=task_text[:MAX_CHUNK_CHARS],
                    section=f"{heading} > {task_name}",
                    heading_path=f"{file_path} > {heading} > {task_name}",
                    chunk_index=0,
                    metadata={"symbol_type": "ansible_task", "symbol_name": task_name},
                )
            )
        return chunks

    for key in doc:
        if key in ("apiVersion", "kind"):
            continue
        val = doc[key]
        section_text = yaml.dump({key: val}, default_flow_style=False)
        if len(section_text) > MAX_CHUNK_CHARS:
            section_text = section_text[:MAX_CHUNK_CHARS]
        chunks.append(
            Chunk(
                text=f"# {heading}\n{section_text}",
                section=f"{heading} > {key}",
                heading_path=f"{file_path} > {heading} > {key}",
                chunk_index=0,
                metadata={"symbol_name": key},
            )
        )

    return (
        chunks
        if chunks
        else [
            Chunk(
                text=raw_text[:MAX_CHUNK_CHARS],
                section=heading,
                heading_path=f"{file_path} > {heading}",
                chunk_index=0,
            )
        ]
    )


# ── JSON ──────────────────────────────────────────────────────────────


def _chunk_json(content: str, file_path: str, document_name: str) -> list[Chunk]:
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return _chunk_generic(content, file_path, document_name, "json")

    if isinstance(data, list):
        chunks = []
        for i, item in enumerate(data):
            item_text = json.dumps(item, indent=2)
            name = item.get("name", f"item-{i}") if isinstance(item, dict) else f"item-{i}"
            if len(item_text) > MAX_CHUNK_CHARS:
                item_text = item_text[:MAX_CHUNK_CHARS]
            chunks.append(
                Chunk(
                    text=item_text,
                    section=name,
                    heading_path=f"{file_path} > {name}",
                    chunk_index=i,
                    metadata={"content_format": "json", "symbol_type": "array_element", "symbol_name": name},
                )
            )
        return chunks

    if isinstance(data, dict):
        full_text = json.dumps(data, indent=2)
        if len(full_text) <= MAX_CHUNK_CHARS:
            return [
                Chunk(
                    text=full_text,
                    section=file_path,
                    heading_path=file_path,
                    chunk_index=0,
                    metadata={"content_format": "json", "symbol_type": "object"},
                )
            ]

        chunks = []
        for i, (key, val) in enumerate(data.items()):
            section_text = json.dumps({key: val}, indent=2)
            if len(section_text) > MAX_CHUNK_CHARS:
                section_text = section_text[:MAX_CHUNK_CHARS]
            chunks.append(
                Chunk(
                    text=section_text,
                    section=key,
                    heading_path=f"{file_path} > {key}",
                    chunk_index=i,
                    metadata={"content_format": "json", "symbol_type": "property", "symbol_name": key},
                )
            )
        return chunks

    return [
        Chunk(
            text=content[:MAX_CHUNK_CHARS],
            section=file_path,
            heading_path=file_path,
            chunk_index=0,
            metadata={"content_format": "json"},
        )
    ]


# ── XML ───────────────────────────────────────────────────────────────


def _chunk_xml(content: str, file_path: str, document_name: str) -> list[Chunk]:
    try:
        import xml.etree.ElementTree as ET

        root = ET.fromstring(content)  # noqa: S314  # nosec B314
    except Exception:
        return _chunk_generic(content, file_path, document_name, "xml")

    tag = _strip_ns(root.tag)
    chunks: list[Chunk] = []

    if len(content) <= MAX_CHUNK_CHARS:
        return [
            Chunk(
                text=content,
                section=tag,
                heading_path=f"{file_path} > {tag}",
                chunk_index=0,
                metadata={"content_format": "xml", "symbol_type": f"xml_{tag}", "symbol_name": tag},
            )
        ]

    for i, child in enumerate(root):
        child_tag = _strip_ns(child.tag)
        child_name = child.get("name") or child.get("id") or child.get("artifactId") or child_tag
        try:
            child_text = ET.tostring(child, encoding="unicode")
        except Exception:
            continue
        if len(child_text) > MAX_CHUNK_CHARS:
            child_text = child_text[:MAX_CHUNK_CHARS]
        chunks.append(
            Chunk(
                text=child_text,
                section=f"{tag} > {child_name}",
                heading_path=f"{file_path} > {tag} > {child_name}",
                chunk_index=i,
                metadata={"content_format": "xml", "symbol_type": f"xml_{child_tag}", "symbol_name": child_name},
            )
        )

    return (
        chunks
        if chunks
        else [
            Chunk(
                text=content[:MAX_CHUNK_CHARS],
                section=tag,
                heading_path=f"{file_path} > {tag}",
                chunk_index=0,
                metadata={"content_format": "xml"},
            )
        ]
    )


def _strip_ns(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


# ── TOML ──────────────────────────────────────────────────────────────


def _chunk_toml(content: str, file_path: str, document_name: str) -> list[Chunk]:
    try:
        import tomllib
    except ImportError:
        try:
            import tomli as tomllib  # type: ignore[no-redef]
        except ImportError:
            return _chunk_generic(content, file_path, document_name, "toml")

    try:
        data = tomllib.loads(content)
    except Exception:
        return _chunk_generic(content, file_path, document_name, "toml")

    if len(content) <= MAX_CHUNK_CHARS:
        return [
            Chunk(
                text=content,
                section=file_path,
                heading_path=file_path,
                chunk_index=0,
                metadata={"content_format": "toml", "symbol_type": "config"},
            )
        ]

    chunks = []
    for i, (key, val) in enumerate(data.items()):
        section_text = f"[{key}]\n"
        if isinstance(val, dict):
            for k, v in val.items():
                section_text += f"{k} = {_toml_repr(v)}\n"
        else:
            section_text += f"{key} = {_toml_repr(val)}\n"
        chunks.append(
            Chunk(
                text=section_text[:MAX_CHUNK_CHARS],
                section=key,
                heading_path=f"{file_path} > {key}",
                chunk_index=i,
                metadata={"content_format": "toml", "symbol_type": "table", "symbol_name": key},
            )
        )

    return chunks


def _toml_repr(val: Any) -> str:
    if isinstance(val, str):
        return f'"{val}"'
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, (list, dict)):
        return json.dumps(val)
    return str(val)


# ── HCL (Terraform) ──────────────────────────────────────────────────


def _chunk_hcl(content: str, file_path: str, document_name: str) -> list[Chunk]:
    """Split HCL by top-level blocks (resource, data, module, variable, output, locals)."""
    import re

    block_re = re.compile(
        r"^(resource|data|module|variable|output|locals|terraform|provider)\s+"
        r'(?:"([^"]+)"\s+)?(?:"([^"]+)"\s*)?\{',
        re.MULTILINE,
    )

    matches = list(block_re.finditer(content))
    if not matches:
        return _chunk_generic(content, file_path, document_name, "hcl")

    chunks: list[Chunk] = []
    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        block_text = content[start:end].rstrip()

        block_type = match.group(1)
        type_label = match.group(2) or ""
        name_label = match.group(3) or type_label or f"{block_type}-{i}"
        heading = f"{block_type} {type_label} {name_label}".strip()
        symbol_type = f"hcl_{block_type}"

        chunks.append(
            Chunk(
                text=block_text[:MAX_CHUNK_CHARS],
                section=heading,
                heading_path=f"{file_path} > {heading}",
                chunk_index=i,
                metadata={
                    "content_format": "hcl",
                    "symbol_type": symbol_type,
                    "symbol_name": name_label,
                },
            )
        )

    return chunks


# ── Generic fallback ──────────────────────────────────────────────────


def _chunk_generic(content: str, file_path: str, document_name: str, fmt: str) -> list[Chunk]:
    """Paragraph-boundary fallback for unparseable structured content."""
    if len(content) <= MAX_CHUNK_CHARS:
        return [
            Chunk(
                text=content,
                section=file_path,
                heading_path=file_path,
                chunk_index=0,
                metadata={"content_format": fmt},
            )
        ]

    paragraphs = content.split("\n\n")
    chunks: list[Chunk] = []
    current: list[str] = []
    current_len = 0
    idx = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if current_len + len(para) > MAX_CHUNK_CHARS and current:
            chunks.append(
                Chunk(
                    text="\n\n".join(current),
                    section=f"{file_path} (part {idx + 1})",
                    heading_path=file_path,
                    chunk_index=idx,
                    metadata={"content_format": fmt},
                )
            )
            idx += 1
            current = []
            current_len = 0
        current.append(para)
        current_len += len(para) + 2

    if current:
        chunks.append(
            Chunk(
                text="\n\n".join(current),
                section=f"{file_path} (part {idx + 1})" if idx > 0 else file_path,
                heading_path=file_path,
                chunk_index=idx,
                metadata={"content_format": fmt},
            )
        )

    return chunks


def _detect_format(path: str) -> str:
    suffix = Path(path).suffix.lower()
    fmt_map = {
        ".yaml": "yaml",
        ".yml": "yaml",
        ".json": "json",
        ".toml": "toml",
        ".xml": "xml",
        ".pom": "xml",
        ".tf": "hcl",
        ".tfvars": "hcl",
        ".hcl": "hcl",
    }
    return fmt_map.get(suffix, "yaml")
