"""Shared language-pack types, configuration, and document chunking."""

from __future__ import annotations

import re
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .content_gate import GatePolicy, score_chunk
from .language_text import basic_source_text_cleanup, normalize_source_text_by_format
from .synpack import SynPackError

GO_PROMPT_ID = "go_agentic_architect_v1"

RUST_PROMPT_ID = "rust_agentic_architect_2024_v1"

QUARKUS_PROMPT_ID = "quarkus_cloud_native_architect_v1"

PYTHON_PROMPT_ID = "python_314_agentic_architect_v1"

GODOT_PROMPT_ID = "godot_4_engine_architect_v1"

TERRAFORM_PROMPT_ID = "terraform_infrastructure_architect_v1"

ECMA_PROMPT_ID = "principal_js_ts_architect_2026_v1"

BASH_PROMPT_ID = "bash_shell_safety_architect_v1"

SUPPORTED_LANGUAGE_PACKS = {"go", "rust", "quarkus", "python", "godot", "terraform", "ecma", "bash"}

AUX_SOURCE_LANGUAGES = {"rust", "quarkus", "python", "godot", "terraform", "ecma", "bash"}

DOC_LIKE_FORMATS = {"", "md", "markdown", "html", "htm", "rst", "adoc", "txt", "text", "texi"}

MARKDOWN_FORMATS = {"md", "markdown"}

HTML_FORMATS = {"html", "htm"}

STRUCTURED_FORMATS = {
    "c",
    "bash",
    "bats",
    "cpp",
    "cs",
    "gd",
    "gdbuiltins",
    "glsl",
    "go",
    "h",
    "hcl",
    "java",
    "js",
    "json",
    "py",
    "python",
    "rs",
    "rust",
    "sh",
    "shell",
    "toml",
    "ts",
    "xml",
    "yaml",
    "yml",
    "zsh",
    "ksh",
}

LANGUAGE_PACK_GATE_POLICY = GatePolicy(min_chunk_quality=0.10, min_chunk_words=12, min_chunk_words_absolute=3)


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


def _basic_source_text_cleanup(text: str) -> str:
    return basic_source_text_cleanup(text)


def _strip_html_tags(text: str) -> str:
    from .language_text import strip_html_tags

    return strip_html_tags(text)


def _normalize_language_chunk_text(chunk: LanguageChunk) -> tuple[str, str]:
    return normalize_source_text_by_format(chunk.text, chunk.content_format)


def _has_curated_rescue_signal(chunk: LanguageChunk, text: str) -> bool:
    if chunk.artifact_kind != "docs":
        return bool(text.strip())
    fmt = (chunk.content_format or "").lower().strip()
    if fmt in STRUCTURED_FORMATS:
        return bool(text.strip())
    if chunk.symbol_kind or chunk.symbol_fqn or chunk.symbol_name:
        return bool(text.strip())
    if re.search(r"(?m)^\s*(?:func|type|class|def|interface|enum|resource|data)\s+\w+", text):
        return True
    return False


def prepare_language_chunks_for_enrichment(
    chunks: list[LanguageChunk],
) -> tuple[list[LanguageChunk], dict[str, Any]]:
    """Normalize curated language-pack chunks and reject obvious junk before enrichment."""
    prepared: list[LanguageChunk] = []
    rejected_reasons: dict[str, int] = {}
    counts = {
        "extracted": len(chunks),
        "normalized": 0,
        "quality_rejected": 0,
        "enrichment_attempted": 0,
    }

    for chunk in chunks:
        original_format = (chunk.content_format or "").lower().strip() or "text"
        normalized_text, normalized_format = _normalize_language_chunk_text(chunk)
        counts["normalized"] += int(normalized_text != chunk.text or normalized_format != original_format)

        verdict = score_chunk(
            normalized_text,
            section=chunk.section,
            heading_path=chunk.heading_path,
            policy=LANGUAGE_PACK_GATE_POLICY,
        )
        if verdict.should_index or _has_curated_rescue_signal(chunk, normalized_text):
            status = "clean" if verdict.should_index else "warn"
            metadata = {
                **chunk.metadata,
                "source_quality_score": round(verdict.quality_score, 4),
                "source_quality_status": status,
                "source_quality_reason": verdict.rejection_reason,
                "original_content_format": original_format,
                "normalized_content_format": normalized_format,
            }
            prepared.append(
                LanguageChunk(
                    text=normalized_text,
                    doc_id=chunk.doc_id,
                    chunk_index=chunk.chunk_index,
                    document_name=chunk.document_name,
                    heading_path=chunk.heading_path,
                    section=chunk.section,
                    source_url=chunk.source_url,
                    package_name=chunk.package_name,
                    symbol_kind=chunk.symbol_kind,
                    symbol_fqn=chunk.symbol_fqn,
                    symbol_name=chunk.symbol_name,
                    module_path=chunk.module_path,
                    artifact_kind=chunk.artifact_kind,
                    content_format=normalized_format,
                    metadata=metadata,
                )
            )
            continue

        reason = verdict.rejection_reason or "source quality rejected"
        rejected_reasons[reason.split("|")[0].strip()] = rejected_reasons.get(reason.split("|")[0].strip(), 0) + 1

    counts["quality_rejected"] = len(chunks) - len(prepared)
    counts["enrichment_attempted"] = len(prepared)
    return prepared, {**counts, "rejected_reasons": rejected_reasons}


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


def _normalize_doc_language(value: str) -> str:
    normalized = str(value or "en").strip().lower().replace("_", "-")
    if not re.fullmatch(r"[a-z]{2,3}(?:-[a-z0-9]{2,8})*", normalized):
        raise SynPackError(f"invalid doc_language: {value!r}")
    return normalized


def _supported_doc_languages(config: dict[str, Any]) -> list[str]:
    raw = config.get("supported_doc_languages") or [config.get("doc_language") or "en"]
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        raise SynPackError("supported_doc_languages must be a list")
    supported = [_normalize_doc_language(str(item)) for item in raw if str(item or "").strip()]
    return supported or ["en"]


def _validate_doc_language(*, doc_language: str, supported_doc_languages: list[str], pack_id: str) -> None:
    if doc_language == "en":
        return
    if doc_language not in supported_doc_languages:
        raise SynPackError(
            f"doc_language={doc_language!r} is not supported by this pack config; "
            f"supported_doc_languages={supported_doc_languages!r}"
        )
    if not pack_id.endswith(f"-{doc_language}"):
        raise SynPackError(f"non-English pack_id must end with '-{doc_language}' to keep pack partitions portable")


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
            if file_path.suffix.lower() not in {
                "",
                ".1",
                ".adoc",
                ".html",
                ".md",
                ".markdown",
                ".mdx",
                ".rst",
                ".texi",
                ".txt",
            }:
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


def _unique_metadata_values(*groups: Any) -> list[str]:
    values: list[str] = []
    for group in groups:
        if isinstance(group, list):
            candidates = group
        elif isinstance(group, (tuple, set)):
            candidates = list(group)
        elif isinstance(group, str):
            candidates = group.split(",")
        else:
            candidates = []
        for item in candidates:
            text = str(item).strip()
            if text and text not in values:
                values.append(text)
    return values
