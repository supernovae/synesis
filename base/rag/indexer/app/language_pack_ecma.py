"""ECMAScript language-pack extraction."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .language_pack_common import ECMA_PROMPT_ID, LanguageChunk, _doc_chunks


def _ecma_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str) -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "temporal_api" or "temporal." in lower or "plaindate" in lower or "zoneddatetime" in lower:
        return "ecma_temporal_architect_2026_v1"
    if artifact_kind == "typescript_handbook" or "typescript" in lower or "satisfies" in lower or "using " in lower:
        return "typescript_type_safety_architect_v1"
    if artifact_kind == "runtime_api" or any(
        token in lower for token in ("node.js", "bun", "deno", "permission model")
    ):
        return "js_runtime_compat_architect_v1"
    if artifact_kind == "web_api" or "mdn" in lower or "browser" in lower or "web api" in lower:
        return "web_platform_architect_v1"
    return ECMA_PROMPT_ID


def _ecma_runtime_tags(text: str, rel_path: str) -> list[str]:
    lower = f"{rel_path}\n{text}".lower()
    tags: list[str] = []
    if any(token in lower for token in ("node.js", "node:", "node ")):
        tags.append("node")
    if "bun" in lower:
        tags.append("bun")
    if "deno" in lower:
        tags.append("deno")
    if any(token in lower for token in ("browser", "window.", "document.", "web api", "mdn")):
        tags.append("browser")
    if "edge" in lower or "worker" in lower:
        tags.append("edge")
    return tags


def _ecma_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    package_name: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "ecma", "javascript", "typescript"]
    tags.extend(_ecma_runtime_tags(text, rel_path))
    if artifact_kind == "tc39_proposal":
        tags.append("tc39")
    if artifact_kind == "temporal_api":
        tags.extend(["tc39", "temporal", "date-time"])
    if artifact_kind == "typescript_handbook":
        tags.extend(["typescript", "type-safety"])
    if artifact_kind == "runtime_api":
        tags.append("runtime-api")
    if artifact_kind == "web_api":
        tags.extend(["web-platform", "browser"])
    if any(token in lower for token in ("type stripping", "type-stripping", "erasable syntax", "satisfies", "using ")):
        tags.append("type-stripping")
    if any(token in lower for token in ("esm", "module", "commonjs", "require(")):
        tags.append("module-system")
    if any(token in lower for token in ("promise.withresolvers", "top-level await", "eventemitter", "stream")):
        tags.append("async")
    if any(token in lower for token in ("tree-shake", "bundle", "commonjs monster", "side effect")):
        tags.append("bundle-impact")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard"
        if artifact_kind in {"ecma_spec", "temporal_api", "typescript_handbook"}
        else "guiding",
        "constraint_source": "tc39"
        if artifact_kind in {"ecma_spec", "tc39_proposal", "temporal_api"}
        else "typescript-docs"
        if artifact_kind == "typescript_handbook"
        else "runtime-docs"
        if artifact_kind == "runtime_api"
        else "mdn",
        "content_profile": "reference",
        "package_name": package_name,
        "prompt_id": prompt_id or _ecma_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind),
    }


def _ecma_artifact_for_aux(aux: dict[str, Any], text: str = "", rel_path: str = "") -> str:
    explicit = str(aux.get("artifact_kind") or "")
    if explicit:
        if explicit == "tc39_proposal" and ("temporal" in f"{rel_path}\n{text}".lower() or "Temporal." in text):
            return "temporal_api"
        return explicit
    name = str(aux.get("name") or "").lower()
    repo = str(aux.get("repo") or "").lower()
    haystack = f"{name}\n{repo}\n{rel_path}\n{text}".lower()
    if "temporal" in haystack:
        return "temporal_api"
    if "tc39" in haystack or "proposal" in haystack:
        return "tc39_proposal"
    if "typescript" in haystack:
        return "typescript_handbook"
    if any(token in haystack for token in ("node", "bun", "deno")):
        return "runtime_api"
    if "mdn" in haystack or "content" in haystack:
        return "web_api"
    return "ecma_spec"


def _ecma_symbol_from_path(rel_path: str, text: str) -> tuple[str, str, str]:
    lower = f"{rel_path}\n{text[:1000]}".lower()
    if "temporal" in lower:
        names = re.findall(r"\bTemporal\.[A-Za-z][A-Za-z0-9_.]*", text)
        fqn = names[0] if names else "Temporal"
        return "temporal_api", fqn.rsplit(".", 1)[-1], fqn
    if rel_path.endswith(".json") or Path(rel_path).name in {"package.json", "tsconfig.json", "deno.json"}:
        return "runtime_config", Path(rel_path).name, Path(rel_path).name
    stem = Path(rel_path).stem
    return "docs", stem, ""


def extract_ecma_chunks(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/tc39/proposals")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    aux_names = {
        str(aux.get("name") or "")
        for aux in include.get("aux_sources", [])
        if isinstance(aux, dict) and aux.get("name")
    }
    chunks: list[LanguageChunk] = []
    for chunk in _doc_chunks(
        source_root,
        [str(x) for x in include.get("docs", ["."])],
        language="ecma",
        repo=repo,
        tag=tag,
        package_name="ecma",
        artifact_kind="ecma_spec",
        prompt_id=ECMA_PROMPT_ID,
    ):
        if chunk.module_path.split("/", 1)[0] in aux_names:
            continue
        artifact_kind = (
            "temporal_api"
            if "temporal" in f"{chunk.module_path}\n{chunk.text}".lower()
            else "tc39_proposal"
            if chunk.module_path.startswith("proposal-")
            else "ecma_spec"
        )
        symbol_kind, symbol_name, symbol_fqn = _ecma_symbol_from_path(chunk.module_path, chunk.text)
        chunk.artifact_kind = artifact_kind
        chunk.symbol_kind = symbol_kind
        chunk.symbol_name = symbol_name
        chunk.symbol_fqn = symbol_fqn
        chunk.metadata.update(
            _ecma_metadata(
                text=chunk.text,
                rel_path=chunk.module_path,
                artifact_kind=artifact_kind,
                symbol_kind=symbol_kind,
                package_name="ecma",
            )
        )
        chunks.append(chunk)

    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        aux_root = source_root / name
        if not aux_root.exists():
            continue
        repo_name = str(aux.get("repo") or "")
        path = str(aux.get("path") or ".")
        package_name = str(aux.get("package_name") or name or "ecma")
        prompt_id = str(aux.get("prompt_id") or "")
        for chunk in _doc_chunks(
            aux_root,
            [path],
            language="ecma",
            repo=repo_name or repo,
            tag=str(aux.get("resolved_ref") or "main"),
            package_name=package_name,
            artifact_kind=str(aux.get("artifact_kind") or "docs"),
            prompt_id=prompt_id,
        ):
            artifact_kind = _ecma_artifact_for_aux(aux, chunk.text, chunk.module_path)
            symbol_kind, symbol_name, symbol_fqn = _ecma_symbol_from_path(chunk.module_path, chunk.text)
            chunk.artifact_kind = artifact_kind
            chunk.symbol_kind = symbol_kind
            chunk.symbol_name = symbol_name
            chunk.symbol_fqn = symbol_fqn
            chunk.metadata.update(
                _ecma_metadata(
                    text=chunk.text,
                    rel_path=chunk.module_path,
                    artifact_kind=artifact_kind,
                    symbol_kind=symbol_kind,
                    package_name=package_name,
                    prompt_id=prompt_id,
                )
            )
            chunks.append(chunk)
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks
