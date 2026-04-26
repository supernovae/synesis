"""Configurable SynPack language-pack builder.

The first implementation targets the Go standard library from github.com/golang/go,
but the pipeline keeps prompt loading, enrichment, embedding, and SynPack assembly
language-agnostic enough for later packs.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import httpx
import yaml

from .embed_client import EmbedClient
from .injection_scan import scan_chunk_text_detailed
from .milvus_writer import chunk_id_hash
from .pipeline import _code_chunk_metrics
from .schema import EMBEDDING_DIM, SCHEMA_VERSION, catalog_entity
from .synpack import DEFAULT_PACK_MODEL, SYNPACK_FORMAT_VERSION, SynPackError, _sanitize_pack_id, _sha256_file

GO_TAG_RE = re.compile(r"^go(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)$")
DEFAULT_ENRICHMENT_MODEL = "qwen3.6-35b-a3b"
GO_PROMPT_ID = "go_agentic_architect_v1"
REQUIRED_ENRICHMENT_FIELDS = {
    "agent_hook",
    "perf_tier",
    "safety_contract",
    "lifecycle_model",
    "memory_semantics",
    "concurrency_contract",
    "idiomatic_version",
    "zero_value_behavior",
    "related_interfaces",
    "hidden_warnings",
}


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


def parse_go_stable_tag(tag: str) -> tuple[int, int, int] | None:
    """Return comparable version tuple for stable Go tags, rejecting rc/beta/weekly."""
    m = GO_TAG_RE.match(tag.strip())
    if not m:
        return None
    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def latest_go_stable_tag_from_refs(refs: str) -> str:
    tags: list[tuple[tuple[int, int, int], str]] = []
    for line in refs.splitlines():
        ref = line.rsplit("/", 1)[-1].strip()
        ref = ref[:-3] if ref.endswith("^{}") else ref
        parsed = parse_go_stable_tag(ref)
        if parsed:
            tags.append((parsed, ref))
    if not tags:
        raise SynPackError("no stable Go tags found")
    tags.sort(key=lambda x: x[0])
    return tags[-1][1]


def resolve_latest_go_tag() -> str:
    proc = subprocess.run(
        ["git", "ls-remote", "--tags", "https://github.com/golang/go"],
        check=True,
        text=True,
        capture_output=True,
    )
    return latest_go_stable_tag_from_refs(proc.stdout)


def clone_go_source(tag: str, target: Path) -> None:
    subprocess.run(
        ["git", "clone", "--depth", "1", "--branch", tag, "https://github.com/golang/go", str(target)],
        check=True,
        text=True,
    )


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise SynPackError(f"{path} must contain a YAML object")
    return data


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


def _doc_chunks(root: Path, paths: Iterable[str]) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    index = 0
    for rel in paths:
        path = root / rel
        files = sorted(path.rglob("*")) if path.is_dir() else [path]
        for file_path in files:
            if not file_path.is_file() or file_path.name.startswith("."):
                continue
            if file_path.suffix.lower() not in {"", ".md", ".txt", ".html"}:
                continue
            rel_path = file_path.relative_to(root).as_posix()
            for part in _split_text(_read_text(file_path)):
                chunks.append(
                    LanguageChunk(
                        text=part,
                        doc_id=f"go:{rel_path}",
                        chunk_index=index,
                        document_name=rel_path,
                        heading_path=_heading_for(part, rel_path),
                        section=_heading_for(part, rel_path),
                        module_path=rel_path,
                        source_url=f"https://github.com/golang/go/blob/{{tag}}/{rel_path}",
                        artifact_kind="docs",
                        content_format=file_path.suffix.lstrip(".") or "text",
                    )
                )
                index += 1
    return chunks


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


def parse_enrichment_response(raw: str) -> dict[str, Any]:
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SynPackError(f"enrichment response is not JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise SynPackError("enrichment response must be a single JSON object")
    missing = REQUIRED_ENRICHMENT_FIELDS - set(obj)
    if missing:
        raise SynPackError(f"enrichment response missing fields: {', '.join(sorted(missing))}")
    return obj


def fallback_enrichment(chunk: LanguageChunk, *, error: str = "") -> dict[str, Any]:
    return {
        "agent_hook": f"Use this Go {chunk.symbol_kind or 'documentation'} chunk for {chunk.package_name or chunk.document_name}.",
        "perf_tier": "unknown",
        "safety_contract": "Validate API-specific concurrency, error, nil, and lifecycle requirements against the source text.",
        "lifecycle_model": "No model-derived lifecycle summary is available; rely on the official source content in this chunk.",
        "memory_semantics": "",
        "concurrency_contract": "",
        "idiomatic_version": "",
        "zero_value_behavior": "",
        "related_interfaces": [],
        "hidden_warnings": [error] if error else [],
        "enrichment_status": "fallback",
        "enrichment_error": error,
    }


class OpenAICompatibleEnrichmentClient:
    def __init__(
        self,
        *,
        base_url: str,
        model: str = DEFAULT_ENRICHMENT_MODEL,
        timeout: float = 60.0,
        retry_count: int = 2,
        temperature: float = 0.1,
        prompt_template: str,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.retry_count = retry_count
        self.temperature = temperature
        self.prompt_template = prompt_template

    def enrich(self, chunk: LanguageChunk) -> dict[str, Any]:
        prompt = self.prompt_template.replace("{{RAW_GO_DOC_CONTENT}}", chunk.text)
        payload = {
            "model": self.model,
            "temperature": self.temperature,
            "messages": [
                {"role": "system", "content": "Return exactly one JSON object and no surrounding prose."},
                {"role": "user", "content": prompt},
            ],
        }
        last_error = ""
        for _ in range(max(1, self.retry_count + 1)):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    resp = client.post(f"{self.base_url}/v1/chat/completions", json=payload)
                resp.raise_for_status()
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                return parse_enrichment_response(str(content))
            except Exception as exc:  # deterministic fallback is handled by caller.
                last_error = str(exc)
        raise SynPackError(last_error or "enrichment failed")


def enrich_language_chunks(
    chunks: list[LanguageChunk],
    *,
    prompt_template: str,
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    concurrency: int = 4,
    retry_count: int = 2,
    temperature: float = 0.1,
    skip: bool = False,
) -> list[dict[str, Any]]:
    if skip or not enrichment_url:
        return [fallback_enrichment(chunk, error="enrichment skipped") for chunk in chunks]
    client = OpenAICompatibleEnrichmentClient(
        base_url=enrichment_url,
        model=enrichment_model,
        retry_count=retry_count,
        temperature=temperature,
        prompt_template=prompt_template,
    )

    def one(chunk: LanguageChunk) -> dict[str, Any]:
        try:
            return client.enrich(chunk)
        except Exception as exc:
            return fallback_enrichment(chunk, error=str(exc))

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        return list(pool.map(one, chunks))


def _agent_json(enrichment: dict[str, Any]) -> str:
    return json.dumps(enrichment, sort_keys=True, ensure_ascii=False)


def _build_rows(
    chunks: list[LanguageChunk],
    enrichments: list[dict[str, Any]],
    embeddings: list[list[float]],
    *,
    pack_id: str,
    pack_version: str,
    source_version: str,
    language: str,
    domain: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for chunk, enrichment, embedding in zip(chunks, enrichments, embeddings):
        status, signals = scan_chunk_text_detailed(chunk.text)
        has_code, code_signal_count, code_density = _code_chunk_metrics(chunk.text)
        chunk_id = chunk_id_hash(chunk.text, f"{pack_id}:{chunk.doc_id}:{chunk.section}")
        rows.append(
            catalog_entity(
                chunk_id=chunk_id,
                text=chunk.text,
                embedding=embedding,
                doc_id=chunk.doc_id,
                chunk_index=chunk.chunk_index,
                context_prefix=str(enrichment.get("agent_hook", "") or ""),
                chunk_summary=str(enrichment.get("agent_hook", "") or ""),
                heading_path=chunk.heading_path,
                section=chunk.section,
                document_name=chunk.document_name,
                source_type="docs",
                handler="language_pack",
                domain=domain,
                tags=f"language-pack,{language}",
                keywords=",".join(str(x) for x in [chunk.package_name, chunk.symbol_kind, chunk.symbol_name] if x),
                origin_type="curated",
                authority="vetted",
                pack_id=pack_id,
                pack_version=pack_version,
                pack_source_version=source_version,
                pack_partition=pack_id,
                symbol_kind=chunk.symbol_kind,
                symbol_fqn=chunk.symbol_fqn,
                package_name=chunk.package_name,
                source_url=chunk.source_url,
                agent_hook=str(enrichment.get("agent_hook", "") or ""),
                perf_tier=str(enrichment.get("perf_tier", "") or ""),
                safety_contract=str(enrichment.get("safety_contract", "") or ""),
                lifecycle_model=str(enrichment.get("lifecycle_model", "") or ""),
                agent_enrichment_json=_agent_json(enrichment),
                scan_status=status,
                scan_signals=",".join(signals),
                content_format=chunk.content_format,
                symbol_type=chunk.symbol_kind,
                language=language,
                repo_path="golang/go" if language == "go" else "",
                module_path=chunk.module_path,
                symbol_name=chunk.symbol_name,
                artifact_kind=chunk.artifact_kind,
                has_code=has_code,
                code_signal_count=code_signal_count,
                code_density=code_density,
                code_language=language if has_code else "",
                corpus_class="coder_enriched",
                content_profile="reference",
                crawl_timestamp=int(time.time() * 1000),
                raw_content_hash=hashlib.sha256(chunk.text.encode()).hexdigest(),
                clean_content_hash=hashlib.sha256(chunk.text.encode()).hexdigest(),
                enrichment_profile=GO_PROMPT_ID if language == "go" else "language_pack_v1",
            )
        )
    return rows


def build_language_pack(
    *,
    language: str,
    output_path: str | Path,
    pack_config: str | Path = "",
    pack_id: str = "",
    pack_version: str = "1.0.0",
    source_version: str = "",
    latest_tag: str = "",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_concurrency: int = 4,
    skip_enrichment: bool = False,
    embedder_url: str = "",
    max_chunks: int = 0,
    source_dir: str | Path = "",
) -> dict[str, Any]:
    language = language.lower().strip()
    if language != "go":
        raise SynPackError(f"unsupported language pack: {language}")
    config_path = Path(pack_config) if pack_config else _repo_root() / "base/rag/pack-configs/go.yaml"
    config = _load_yaml(config_path)
    pack_id = _sanitize_pack_id(pack_id or str(config.get("pack_id") or "go-latest"))
    resolved_tag = latest_tag or source_version or resolve_latest_go_tag()
    source_version = resolved_tag
    tmp = Path(tempfile.mkdtemp(prefix="synpack-language-"))
    try:
        source_root = Path(source_dir) if source_dir else tmp / "go"
        if not source_dir:
            clone_go_source(resolved_tag, source_root)
        chunks = extract_go_chunks(source_root, config=config, tag=resolved_tag)
        if max_chunks:
            chunks = chunks[: max(0, max_chunks)]

        prompt_path = _resolve_path(str(config.get("prompt_path") or "base/rag/pack-configs/prompts/go_agentic_architect_v1.md"), base=config_path.parent)
        prompt_template = _read_text(prompt_path)
        prompt_hash = hashlib.sha256(prompt_template.encode()).hexdigest()
        enrichments = enrich_language_chunks(
            chunks,
            prompt_template=prompt_template,
            enrichment_url=enrichment_url,
            enrichment_model=enrichment_model,
            concurrency=enrichment_concurrency,
            skip=skip_enrichment,
        )
        embedder = EmbedClient(**({"url": embedder_url} if embedder_url else {}))
        embed_inputs = [f"{e.get('agent_hook', '')}\n\n{chunk.text}".strip() for chunk, e in zip(chunks, enrichments)]
        embeddings = embedder.embed_texts(embed_inputs) if embed_inputs else []
        if len(embeddings) != len(chunks):
            raise SynPackError(f"embedder returned {len(embeddings)} vectors for {len(chunks)} chunks")
        bad_dims = [len(vec) for vec in embeddings if len(vec) != EMBEDDING_DIM]
        if bad_dims:
            raise SynPackError(f"embedder returned vector dimension {bad_dims[0]}, expected {EMBEDDING_DIM}")
        rows = _build_rows(
            chunks,
            enrichments,
            embeddings,
            pack_id=pack_id,
            pack_version=pack_version,
            source_version=source_version,
            language=language,
            domain=str(config.get("domain") or language),
        )

        rows_path = tmp / "metadata.jsonl"
        with rows_path.open("w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")

        sources_lock = {
            "repo": config.get("repo", "github.com/golang/go"),
            "tag": resolved_tag,
            "source_dir": str(source_root),
            "row_count": len(rows),
        }
        sources_lock_path = tmp / "sources.lock.json"
        sources_lock_path.write_text(json.dumps(sources_lock, indent=2, sort_keys=True), encoding="utf-8")
        manifest = {
            "format": "synpack",
            "format_version": SYNPACK_FORMAT_VERSION,
            "pack_id": pack_id,
            "pack_version": pack_version,
            "version": pack_version,
            "source_version": source_version,
            "language": language,
            "domain": str(config.get("domain") or language),
            "embedding_model": DEFAULT_PACK_MODEL,
            "embedding_dimensions": EMBEDDING_DIM,
            "synesis_catalog_schema_version": SCHEMA_VERSION,
            "schema_version": SCHEMA_VERSION,
            "partitions": [pack_id],
            "metadata_fields": [
                "package_name",
                "symbol_kind",
                "symbol_fqn",
                "perf_tier",
                "agent_hook",
                "safety_contract",
                "lifecycle_model",
                "agent_enrichment_json",
            ],
            "enrichment": {
                "model": enrichment_model if enrichment_url and not skip_enrichment else "",
                "prompt_id": str(config.get("prompt_id") or GO_PROMPT_ID),
                "prompt_sha256": prompt_hash,
                "url_configured": bool(enrichment_url),
                "skipped": bool(skip_enrichment or not enrichment_url),
            },
            "created_at": int(time.time()),
            "row_count": len(rows),
            "sources_lock_sha256": _sha256_file(sources_lock_path),
            "metadata_sha256": _sha256_file(rows_path),
        }
        manifest_path = tmp / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.write(manifest_path, "manifest.json")
            zf.write(rows_path, "metadata.jsonl")
            zf.write(sources_lock_path, "sources.lock.json")
        return {
            "ok": True,
            "pack_id": pack_id,
            "rows": len(rows),
            "path": str(out_path),
            "source_version": source_version,
            "artifact_hash": _sha256_file(out_path),
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
