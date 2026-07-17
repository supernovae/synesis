"""Quarkus language-pack extraction."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .language_pack_common import QUARKUS_PROMPT_ID, LanguageChunk, _doc_chunks, _read_text


def _java_doc_before(lines: list[str], start: int) -> str:
    i = start - 1
    while i >= 0 and not lines[i].strip():
        i -= 1
    if i < 0 or "*/" not in lines[i]:
        return ""
    block: list[str] = []
    while i >= 0:
        block.append(lines[i])
        if "/**" in lines[i]:
            break
        i -= 1
    block.reverse()
    cleaned: list[str] = []
    for line in block:
        stripped = line.strip()
        stripped = stripped.removeprefix("/**").removesuffix("*/").strip()
        stripped = stripped.removeprefix("*").strip()
        if stripped:
            cleaned.append(stripped)
    return "\n".join(cleaned).strip()


def _quarkus_package_for_path(rel_path: str) -> str:
    if rel_path.startswith("devtools/cli/"):
        return "quarkus-cli"
    if rel_path.startswith("core/runtime/"):
        return "quarkus-core"
    if rel_path.startswith("docs/"):
        return "quarkus-guides"
    if rel_path.startswith("extensions/"):
        parts = rel_path.split("/")
        return parts[1] if len(parts) > 1 else "extensions"
    if rel_path.startswith("quarkus-platform/"):
        return "quarkus-platform"
    return "quarkus"


def _quarkus_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "quarkus", "java"]
    if artifact_kind == "cli_command":
        tags.extend(["quarkus-cli", "devtools", "package-tooling"])
    if artifact_kind == "config_reference":
        tags.extend(
            [
                "config-reference",
                "build-time-config"
                if "build_time" in lower or "buildtime" in lower or "fixed" in lower
                else "runtime-config",
            ]
        )
    if "native" in lower or "graalvm" in lower:
        tags.append("native-image")
    if "reactive" in lower or "mutiny" in lower or "event loop" in lower:
        tags.append("reactive")
    if "dev services" in lower or "devservices" in lower:
        tags.append("dev-services")
    if "extension" in lower or rel_path.startswith("extensions/"):
        tags.append("extension")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind in {"config_reference", "platform_bom"} else "guiding",
        "constraint_source": "quarkus-config-reference"
        if artifact_kind == "config_reference"
        else "quarkus-cli"
        if artifact_kind == "cli_command"
        else "quarkus-docs",
        "content_profile": "reference" if artifact_kind != "cli_command" else "procedural",
        "prompt_id": prompt_id or ("quarkus_cli_architect_v1" if artifact_kind == "cli_command" else QUARKUS_PROMPT_ID),
    }


def _extract_quarkus_docs(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    repo = str(config.get("repo") or "github.com/quarkusio/quarkus")
    paths = [str(x) for x in include.get("guides", ["docs/src/main/asciidoc"])]
    chunks: list[LanguageChunk] = []
    for chunk in _doc_chunks(
        source_root,
        paths,
        language="quarkus",
        repo=repo,
        tag=tag,
        package_name="quarkus-guides",
        artifact_kind="docs",
        prompt_id=QUARKUS_PROMPT_ID,
    ):
        chunk.metadata.update(_quarkus_metadata(text=chunk.text, rel_path=chunk.module_path, artifact_kind="docs"))
        chunks.append(chunk)
    return chunks


def _java_class_name(text: str, fallback: str) -> str:
    m = re.search(r"\b(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)", text)
    return m.group(1) if m else fallback


def _extract_quarkus_config_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/quarkusio/quarkus")
    chunks: list[LanguageChunk] = []
    java_roots = [p for p in source_root.rglob("runtime/src/main/java") if p.is_dir()]
    for root in sorted(java_roots):
        for file_path in sorted(root.rglob("*.java")):
            text = _read_text(file_path)
            if not any(
                marker in text
                for marker in ("@ConfigRoot", "@ConfigItem", "@ConfigMapping", "@ConfigProperty", "@ConfigGroup")
            ):
                continue
            rel_path = file_path.relative_to(source_root).as_posix()
            package = _quarkus_package_for_path(rel_path)
            class_name = _java_class_name(text, file_path.stem)
            class_doc = _java_doc_before(
                text.splitlines(),
                next(
                    (
                        i
                        for i, line in enumerate(text.splitlines())
                        if "class " in line or "interface " in line or "record " in line
                    ),
                    0,
                ),
            )
            if "@ConfigRoot" in text or "@ConfigMapping" in text or "@ConfigGroup" in text:
                body = f"{class_doc}\n\n```java\n{text[:5000]}\n```".strip()
                chunks.append(
                    LanguageChunk(
                        text=body,
                        doc_id=f"quarkus:{repo}:{rel_path}:{class_name}",
                        chunk_index=0,
                        document_name=rel_path,
                        heading_path=class_name,
                        section=class_name,
                        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                        package_name=package,
                        symbol_kind="config_root",
                        symbol_fqn=class_name,
                        symbol_name=class_name,
                        module_path=rel_path,
                        artifact_kind="config_reference",
                        content_format="java",
                        metadata=_quarkus_metadata(
                            text=body, rel_path=rel_path, artifact_kind="config_reference", symbol_kind="config_root"
                        ),
                    )
                )
            lines = text.splitlines()
            field_re = re.compile(
                r"\b(?:public\s+)?(?:Optional<[^>]+>|List<[^>]+>|Map<[^>]+>|[A-Za-z_][A-Za-z0-9_<>.?]+)\s+([a-z][A-Za-z0-9_]*)\s*(?:=|;)"
            )
            for i, line in enumerate(lines):
                if "@ConfigItem" not in "\n".join(lines[max(0, i - 4) : i + 1]) and "@ConfigProperty" not in "\n".join(
                    lines[max(0, i - 4) : i + 1]
                ):
                    continue
                m = field_re.search(line)
                if not m:
                    continue
                field = m.group(1)
                doc = _java_doc_before(lines, i)
                snippet = "\n".join(lines[max(0, i - 6) : min(len(lines), i + 8)]).strip()
                body = f"{doc}\n\n```java\n{snippet}\n```".strip()
                chunks.append(
                    LanguageChunk(
                        text=body,
                        doc_id=f"quarkus:{repo}:{rel_path}:{class_name}.{field}",
                        chunk_index=0,
                        document_name=rel_path,
                        heading_path=f"{class_name}.{field}",
                        section=field,
                        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                        package_name=package,
                        symbol_kind="config_property",
                        symbol_fqn=f"{class_name}.{field}",
                        symbol_name=field,
                        module_path=rel_path,
                        artifact_kind="config_reference",
                        content_format="java",
                        metadata=_quarkus_metadata(
                            text=body,
                            rel_path=rel_path,
                            artifact_kind="config_reference",
                            symbol_kind="config_property",
                        ),
                    )
                )
    return chunks


def _extract_quarkus_cli_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/quarkusio/quarkus")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    cli_root = source_root / str(include.get("cli_root", "devtools/cli/src/main/java/io/quarkus/cli"))
    chunks: list[LanguageChunk] = []
    if not cli_root.exists():
        return chunks
    command_re = re.compile(r"@Command\s*\((?P<args>.*?)\)", re.DOTALL)
    name_re = re.compile(r"name\s*=\s*\"([^\"]+)\"")
    option_re = re.compile(r"@Option\s*\((.*?)\)", re.DOTALL)
    for file_path in sorted(cli_root.rglob("*.java")):
        text = _read_text(file_path)
        if "@Command" not in text:
            continue
        rel_path = file_path.relative_to(source_root).as_posix()
        class_name = _java_class_name(text, file_path.stem)
        command_match = command_re.search(text)
        command_args = command_match.group("args") if command_match else ""
        command_name = name_re.search(command_args).group(1) if name_re.search(command_args) else class_name
        options = [m.group(1).strip().replace("\n", " ")[:240] for m in option_re.finditer(text)]
        doc = _java_doc_before(
            text.splitlines(), next((i for i, line in enumerate(text.splitlines()) if "@Command" in line), 0)
        )
        body = (
            f"{doc}\n\nCommand: quarkus {command_name}\n\n"
            f"Command annotation:\n```java\n@Command({command_args.strip()[:1200]})\n```\n\n"
            f"Options:\n" + "\n".join(f"- {opt}" for opt in options[:20])
        ).strip()
        chunks.append(
            LanguageChunk(
                text=body,
                doc_id=f"quarkus:{repo}:{rel_path}:{command_name}",
                chunk_index=0,
                document_name=rel_path,
                heading_path=f"quarkus {command_name}",
                section=command_name,
                source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                package_name="quarkus-cli",
                symbol_kind="cli_command",
                symbol_fqn=f"quarkus {command_name}",
                symbol_name=command_name,
                module_path=rel_path,
                artifact_kind="cli_command",
                content_format="java",
                metadata=_quarkus_metadata(
                    text=body, rel_path=rel_path, artifact_kind="cli_command", symbol_kind="cli_command"
                ),
            )
        )
    return chunks


def _extract_quarkus_source_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/quarkusio/quarkus")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    roots = [str(x) for x in include.get("source_roots", ["core/runtime/src/main/java"])]
    chunks: list[LanguageChunk] = []
    class_re = re.compile(
        r"\bpublic\s+(?:abstract\s+|final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)"
    )
    for rel in roots:
        root = source_root / rel
        if not root.exists():
            continue
        for file_path in sorted(root.rglob("*.java")):
            text = _read_text(file_path)
            rel_path = file_path.relative_to(source_root).as_posix()
            package = _quarkus_package_for_path(rel_path)
            m = class_re.search(text)
            if not m:
                continue
            name = m.group(1)
            doc = _java_doc_before(text.splitlines(), text[: m.start()].count("\n"))
            body = f"{doc}\n\n```java\n{text[:5000]}\n```".strip()
            chunks.append(
                LanguageChunk(
                    text=body,
                    doc_id=f"quarkus:{repo}:{rel_path}:{name}",
                    chunk_index=0,
                    document_name=rel_path,
                    heading_path=name,
                    section=name,
                    source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                    package_name=package,
                    symbol_kind="java_type",
                    symbol_fqn=name,
                    symbol_name=name,
                    module_path=rel_path,
                    artifact_kind="code",
                    content_format="java",
                    metadata=_quarkus_metadata(
                        text=body, rel_path=rel_path, artifact_kind="code", symbol_kind="java_type"
                    ),
                )
            )
    return chunks


def _extract_quarkus_platform_chunks(source_root: Path, *, config: dict[str, Any]) -> list[LanguageChunk]:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict) or str(aux.get("name") or "") != "quarkus-platform":
            continue
        aux_root = source_root / "quarkus-platform"
        if not aux_root.exists():
            continue
        repo = str(aux.get("repo") or "github.com/quarkusio/quarkus-platform")
        for file_path in sorted(aux_root.rglob("*.xml"))[:200]:
            rel_path = file_path.relative_to(aux_root).as_posix()
            text = _read_text(file_path)
            if "quarkus-bom" not in text and "<artifactId>" not in text:
                continue
            body = text[:6500]
            chunks.append(
                LanguageChunk(
                    text=body,
                    doc_id=f"quarkus:{repo}:{rel_path}",
                    chunk_index=0,
                    document_name=rel_path,
                    heading_path=rel_path,
                    section=file_path.stem,
                    source_url=f"https://{repo}/blob/{aux.get('resolved_ref') or 'main'}/{rel_path}",
                    package_name="quarkus-platform",
                    symbol_kind="platform_bom",
                    symbol_fqn=file_path.stem,
                    symbol_name=file_path.stem,
                    module_path=f"quarkus-platform/{rel_path}",
                    artifact_kind="platform_bom",
                    content_format="xml",
                    metadata=_quarkus_metadata(
                        text=body,
                        rel_path=f"quarkus-platform/{rel_path}",
                        artifact_kind="platform_bom",
                        symbol_kind="platform_bom",
                    ),
                )
            )
    return chunks


def extract_quarkus_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    chunks.extend(_extract_quarkus_docs(source_root, config=config, tag=tag))
    chunks.extend(_extract_quarkus_config_chunks(source_root, config=config, tag=tag))
    chunks.extend(_extract_quarkus_source_chunks(source_root, config=config, tag=tag))
    chunks.extend(_extract_quarkus_cli_chunks(source_root, config=config, tag=tag))
    chunks.extend(_extract_quarkus_platform_chunks(source_root, config=config))
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks
