"""Godot language-pack extraction."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import defusedxml.ElementTree as ET

from .language_pack_common import (
    GODOT_PROMPT_ID,
    LanguageChunk,
    _doc_chunks,
    _read_text,
    _split_text,
    _unique_metadata_values,
)


def _xml_text(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return "".join(node.itertext()).strip()


GODOT_LIFECYCLE_CALLBACKS = (
    "_enter_tree",
    "_ready",
    "_process",
    "_physics_process",
    "_exit_tree",
    "_input",
    "_unhandled_input",
)


def _godot_lifecycle_callbacks(text: str) -> list[str]:
    return [callback for callback in GODOT_LIFECYCLE_CALLBACKS if callback in text]


def _godot_migration_topics(text: str) -> list[str]:
    lower = text.lower()
    topics: list[str] = []
    if "godot 3" in lower or "3.x" in lower or "migration" in lower or "legacy" in lower:
        topics.append("godot-3-to-4")
    if "signal" in lower or "connect" in lower or "await" in lower:
        topics.append("signal-api")
    if "scene tree" in lower or "node" in lower:
        topics.append("node-lifecycle")
    if "shader" in lower:
        topics.append("shader-language")
    if "physics" in lower:
        topics.append("physics")
    return topics


def _godot_scene_tree_role(text: str, *, artifact_kind: str, symbol_kind: str = "") -> str:
    lower = text.lower()
    if artifact_kind == "engine_proposal" or "migration" in lower:
        return "migration"
    if symbol_kind == "signal" or "signal" in lower or "connect" in lower:
        return "signal-contract"
    if _godot_lifecycle_callbacks(text) or "scene tree" in lower:
        return "node-lifecycle"
    if artifact_kind == "shader_language" or "shader" in lower:
        return "rendering"
    if "physics" in lower:
        return "physics"
    if any(token in lower for token in ("button", "control", "ui", "container")):
        return "ui-control"
    return "reference"


def _godot_signal_args(signal: ET.Element) -> list[str]:
    return [
        f"{param.attrib.get('name', '')}: {param.attrib.get('type', '')}".strip()
        for param in signal.findall("param")
        if param.attrib.get("name") or param.attrib.get("type")
    ]


def _godot_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str, symbol_kind: str = "") -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "class_reference":
        return "godot_class_reference_architect_v1"
    if artifact_kind == "shader_language" or "shader" in lower or "rendering" in rel_path.lower():
        return "godot_shader_architect_v1"
    if artifact_kind == "engine_proposal":
        return "godot_proposal_architect_v1"
    if any(token in lower for token in ("scene tree", "signal", "_ready", "_process", "_enter_tree", "node lifecycle")):
        return "godot_scene_tree_architect_v1"
    return GODOT_PROMPT_ID


def _godot_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "godot", "godot-4"]
    if artifact_kind == "class_reference":
        tags.append("class-reference")
    if "signal" in lower or symbol_kind == "signal":
        tags.append("signals")
    if any(token in lower for token in ("scene tree", "_ready", "_enter_tree", "_process", "_physics_process")):
        tags.extend(["scene-tree", "node-lifecycle"])
    if artifact_kind == "shader_language" or "shader" in lower:
        tags.extend(["shader-language", "rendering", "gpu"])
    if artifact_kind == "engine_proposal":
        tags.extend(["proposal", "legacy-migration"])
    if "physics" in lower:
        tags.append("physics")
    return {
        "scope_tags": tags,
        "engine_major_version": "4",
        "lifecycle_callbacks": _godot_lifecycle_callbacks(text),
        "migration_topics": _godot_migration_topics(f"{rel_path}\n{text}"),
        "scene_tree_role": _godot_scene_tree_role(text, artifact_kind=artifact_kind, symbol_kind=symbol_kind),
        "constraint_kind": "hard" if artifact_kind in {"class_reference", "shader_language"} else "guiding",
        "constraint_source": "godot-class-reference"
        if artifact_kind == "class_reference"
        else "godot-proposals"
        if artifact_kind == "engine_proposal"
        else "godot-docs",
        "content_profile": "reference",
        "prompt_id": prompt_id
        or _godot_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind, symbol_kind=symbol_kind),
    }


def _godot_class_row(
    *,
    repo: str,
    tag: str,
    rel_path: str,
    class_name: str,
    text: str,
    symbol_kind: str,
    symbol_name: str,
    symbol_fqn: str,
    metadata_extra: dict[str, Any] | None = None,
) -> LanguageChunk:
    metadata = _godot_metadata(text=text, rel_path=rel_path, artifact_kind="class_reference", symbol_kind=symbol_kind)
    if metadata_extra:
        metadata.update(metadata_extra)
    return LanguageChunk(
        text=text,
        doc_id=f"godot:{repo}:{rel_path}:{symbol_fqn}",
        chunk_index=0,
        document_name=rel_path,
        heading_path=symbol_fqn,
        section=symbol_name,
        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
        package_name="godot-class-reference",
        symbol_kind=symbol_kind,
        symbol_fqn=symbol_fqn,
        symbol_name=symbol_name,
        module_path=rel_path,
        artifact_kind="class_reference",
        content_format="xml",
        metadata=metadata,
    )


def _extract_godot_class_reference(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/godotengine/godot")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    root = source_root / str(include.get("class_reference", "doc/classes"))
    chunks: list[LanguageChunk] = []
    if not root.exists():
        return chunks
    for file_path in sorted(root.glob("*.xml")):
        rel_path = file_path.relative_to(source_root).as_posix()
        try:
            tree = ET.parse(file_path)
        except ET.ParseError:
            continue
        class_el = tree.getroot()
        class_name = class_el.attrib.get("name", file_path.stem)
        inherits = class_el.attrib.get("inherits", "")
        brief = _xml_text(class_el.find("brief_description"))
        desc = _xml_text(class_el.find("description"))
        methods = []
        signals = []
        properties = []
        constants = []
        method_refs: list[str] = []
        signal_refs: list[str] = []
        property_refs: list[str] = []
        constant_refs: list[str] = []
        for method in class_el.findall("./methods/method"):
            name = method.attrib.get("name", "")
            return_type = method.find("return")
            ret = return_type.attrib.get("type", "") if return_type is not None else ""
            args = [f"{a.attrib.get('name', '')}: {a.attrib.get('type', '')}" for a in method.findall("param")]
            methods.append(f"{name}({', '.join(args)}) -> {ret}".strip())
            if name:
                method_refs.append(f"{class_name}.{name}")
        for signal in class_el.findall("./signals/signal"):
            name = signal.attrib.get("name", "")
            args = _godot_signal_args(signal)
            signals.append(f"{name}({', '.join(args)})")
            if name:
                signal_refs.append(f"{class_name}.{name}")
        for prop in class_el.findall("./members/member"):
            name = prop.attrib.get("name", "")
            properties.append(f"{name}: {prop.attrib.get('type', '')}")
            if name:
                property_refs.append(f"{class_name}.{name}")
        for const in class_el.findall("./constants/constant"):
            name = const.attrib.get("name", "")
            constants.append(f"{name}={const.attrib.get('value', '')}")
            if name:
                constant_refs.append(f"{class_name}.{name}")
        class_text = "\n".join(
            [
                f"Class: {class_name}",
                f"Inherits: {inherits}" if inherits else "",
                f"Brief: {brief}" if brief else "",
                f"Description: {desc}" if desc else "",
                "Methods:\n" + "\n".join(f"- {m}" for m in methods[:50]) if methods else "",
                "Signals:\n" + "\n".join(f"- {s}" for s in signals[:50]) if signals else "",
                "Properties:\n" + "\n".join(f"- {p}" for p in properties[:50]) if properties else "",
                "Constants:\n" + "\n".join(f"- {c}" for c in constants[:50]) if constants else "",
            ]
        ).strip()
        chunks.append(
            _godot_class_row(
                repo=repo,
                tag=tag,
                rel_path=rel_path,
                class_name=class_name,
                text=class_text,
                symbol_kind="class",
                symbol_name=class_name,
                symbol_fqn=class_name,
                metadata_extra={
                    "node_class": class_name,
                    "inherits": inherits,
                    "implements_refs": [inherits] if inherits else [],
                    "contains_refs": [*method_refs, *signal_refs, *property_refs, *constant_refs],
                    "signal_list": signals,
                },
            )
        )
        for signal in class_el.findall("./signals/signal"):
            name = signal.attrib.get("name", "")
            args = _godot_signal_args(signal)
            text = f"Signal: {class_name}.{name}({', '.join(args)})\n\n{_xml_text(signal.find('description'))}".strip()
            chunks.append(
                _godot_class_row(
                    repo=repo,
                    tag=tag,
                    rel_path=rel_path,
                    class_name=class_name,
                    text=text,
                    symbol_kind="signal",
                    symbol_name=name,
                    symbol_fqn=f"{class_name}.{name}",
                    metadata_extra={
                        "node_class": class_name,
                        "member_of": class_name,
                        "signal_name": name,
                        "signal_args": args,
                    },
                )
            )
        for method in class_el.findall("./methods/method"):
            name = method.attrib.get("name", "")
            return_type = method.find("return")
            ret = return_type.attrib.get("type", "") if return_type is not None else ""
            args = [f"{a.attrib.get('name', '')}: {a.attrib.get('type', '')}" for a in method.findall("param")]
            text = f"Method: {class_name}.{name}({', '.join(args)}) -> {ret}\n\n{_xml_text(method.find('description'))}".strip()
            chunks.append(
                _godot_class_row(
                    repo=repo,
                    tag=tag,
                    rel_path=rel_path,
                    class_name=class_name,
                    text=text,
                    symbol_kind="method",
                    symbol_name=name,
                    symbol_fqn=f"{class_name}.{name}",
                    metadata_extra={
                        "node_class": class_name,
                        "member_of": class_name,
                        "lifecycle_callbacks": _godot_lifecycle_callbacks(name),
                    },
                )
            )
        for prop in class_el.findall("./members/member"):
            name = prop.attrib.get("name", "")
            text = f"Property: {class_name}.{name}: {prop.attrib.get('type', '')}\n\n{_xml_text(prop)}".strip()
            chunks.append(
                _godot_class_row(
                    repo=repo,
                    tag=tag,
                    rel_path=rel_path,
                    class_name=class_name,
                    text=text,
                    symbol_kind="property",
                    symbol_name=name,
                    symbol_fqn=f"{class_name}.{name}",
                    metadata_extra={"node_class": class_name, "member_of": class_name},
                )
            )
        for const in class_el.findall("./constants/constant"):
            name = const.attrib.get("name", "")
            text = f"Constant: {class_name}.{name} = {const.attrib.get('value', '')}\n\n{_xml_text(const)}".strip()
            chunks.append(
                _godot_class_row(
                    repo=repo,
                    tag=tag,
                    rel_path=rel_path,
                    class_name=class_name,
                    text=text,
                    symbol_kind="constant",
                    symbol_name=name,
                    symbol_fqn=f"{class_name}.{name}",
                    metadata_extra={"node_class": class_name, "member_of": class_name},
                )
            )
    return chunks


def _extract_godot_docs(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        aux_root = source_root / name
        if not aux_root.exists():
            continue
        repo = str(aux.get("repo") or "")
        path = str(aux.get("path") or ".")
        artifact_kind = str(aux.get("artifact_kind") or "engine_manual")
        package_name = str(aux.get("package_name") or name)
        for chunk in _doc_chunks(
            aux_root,
            [path],
            language="godot",
            repo=repo,
            tag=str(aux.get("resolved_ref") or "main"),
            package_name=package_name,
            artifact_kind=artifact_kind,
            prompt_id=str(aux.get("prompt_id") or ""),
        ):
            chunk.metadata.update(
                _godot_metadata(
                    text=chunk.text,
                    rel_path=chunk.module_path,
                    artifact_kind=artifact_kind,
                    prompt_id=str(aux.get("prompt_id") or ""),
                )
            )
            chunks.append(chunk)
    return chunks


def _extract_godot_shader_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/godotengine/godot")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    roots = [str(x) for x in include.get("shader_roots", ["servers/rendering"])]
    chunks: list[LanguageChunk] = []
    for rel in roots:
        root = source_root / rel
        if not root.exists():
            continue
        for file_path in sorted(root.rglob("*")):
            if not file_path.is_file() or file_path.suffix.lower() not in {".h", ".cpp", ".glsl", ".inc", ".gdshader"}:
                continue
            rel_path = file_path.relative_to(source_root).as_posix()
            text = _read_text(file_path)
            if "shader" not in f"{rel_path}\n{text[:2000]}".lower():
                continue
            for part in _split_text(text, max_chars=6500)[:4]:
                heading = file_path.stem
                chunks.append(
                    LanguageChunk(
                        text=part,
                        doc_id=f"godot:{repo}:{rel_path}:{len(chunks)}",
                        chunk_index=len(chunks),
                        document_name=rel_path,
                        heading_path=heading,
                        section=heading,
                        source_url=f"https://{repo}/blob/{tag}/{rel_path}",
                        package_name="godot-shader-language",
                        symbol_kind="shader_source",
                        symbol_fqn=heading,
                        symbol_name=heading,
                        module_path=rel_path,
                        artifact_kind="shader_language",
                        content_format=file_path.suffix.lstrip(".") or "text",
                        metadata=_godot_metadata(
                            text=part, rel_path=rel_path, artifact_kind="shader_language", symbol_kind="shader_source"
                        ),
                    )
                )
    return chunks


def _godot_word_present(needle: str, haystack: str) -> bool:
    if not needle:
        return False
    return bool(re.search(rf"(?<![A-Za-z0-9_]){re.escape(needle)}(?![A-Za-z0-9_])", haystack))


def _attach_godot_doc_references(chunks: list[LanguageChunk]) -> None:
    class_names = sorted(
        {
            chunk.symbol_fqn
            for chunk in chunks
            if chunk.artifact_kind == "class_reference" and chunk.symbol_kind == "class" and chunk.symbol_fqn
        },
        key=len,
        reverse=True,
    )
    symbol_fqns = sorted(
        {
            chunk.symbol_fqn
            for chunk in chunks
            if chunk.artifact_kind == "class_reference" and chunk.symbol_kind != "class" and chunk.symbol_fqn
        },
        key=len,
        reverse=True,
    )
    signals_by_leaf: dict[str, list[str]] = {}
    for chunk in chunks:
        if chunk.artifact_kind != "class_reference" or chunk.symbol_kind != "signal" or not chunk.symbol_fqn:
            continue
        signals_by_leaf.setdefault(chunk.symbol_name, []).append(chunk.symbol_fqn)
    unique_signals = {leaf: refs[0] for leaf, refs in signals_by_leaf.items() if leaf and len(refs) == 1}

    for chunk in chunks:
        if chunk.artifact_kind == "class_reference":
            continue
        haystack = f"{chunk.heading_path}\n{chunk.section}\n{chunk.text}"
        lower = haystack.lower()
        refs: list[str] = []
        for class_name in class_names:
            if _godot_word_present(class_name, haystack):
                refs.append(class_name)
        for symbol_fqn in symbol_fqns:
            if symbol_fqn in haystack:
                refs.append(symbol_fqn)
        if any(token in lower for token in ("signal", "connect", "await")):
            for leaf, signal_fqn in unique_signals.items():
                if _godot_word_present(leaf, haystack):
                    refs.append(signal_fqn)
        for callback in _godot_lifecycle_callbacks(haystack):
            refs.append(f"godot:lifecycle:{callback}")
        if chunk.metadata.get("migration_topics"):
            for topic in chunk.metadata["migration_topics"]:
                refs.append(f"godot:topic:{topic}")
        refs = _unique_metadata_values(chunk.metadata.get("doc_relation_ids"), refs)
        if not refs:
            continue
        chunk.metadata["doc_relation_ids"] = refs
        if chunk.artifact_kind in {"engine_manual", "engine_proposal"}:
            chunk.metadata["documents_refs"] = _unique_metadata_values(chunk.metadata.get("documents_refs"), refs)


def extract_godot_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    chunks.extend(_extract_godot_class_reference(source_root, config=config, tag=tag))
    chunks.extend(_extract_godot_docs(source_root, config=config, tag=tag))
    chunks.extend(_extract_godot_shader_chunks(source_root, config=config, tag=tag))
    _attach_godot_doc_references(chunks)
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks
