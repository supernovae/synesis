"""Terraform language-pack extraction."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .language_pack_common import TERRAFORM_PROMPT_ID, LanguageChunk, _doc_chunks, _read_text


def _terraform_prompt_for_chunk(text: str, *, rel_path: str, artifact_kind: str) -> str:
    lower = f"{rel_path}\n{text}".lower()
    if artifact_kind == "provider_schema":
        return "terraform_provider_schema_architect_v1"
    if artifact_kind == "iac_policy_rule" or "tflint" in lower or "tfsec" in lower:
        return "terraform_policy_lint_architect_v1"
    if artifact_kind == "opentofu_feature" or "opentofu" in lower or "state encryption" in lower:
        return "opentofu_state_architect_v1"
    return TERRAFORM_PROMPT_ID


def _terraform_metadata(
    *,
    text: str,
    rel_path: str,
    artifact_kind: str,
    symbol_kind: str = "",
    provider: str = "",
    prompt_id: str = "",
) -> dict[str, Any]:
    lower = f"{rel_path}\n{text}".lower()
    tags = ["language-pack", "terraform", "iac"]
    if provider:
        tags.append(provider.rsplit("/", 1)[-1].replace("terraform-provider-", ""))
    if artifact_kind == "provider_schema":
        tags.extend(["provider-schema", "hard-constraints"])
    if artifact_kind == "provider_docs":
        tags.append("provider-docs")
    if artifact_kind == "terraform_guide":
        tags.append("terraform-guide")
    if artifact_kind == "opentofu_feature":
        tags.extend(["opentofu", "state-management"])
    if artifact_kind == "iac_policy_rule":
        tags.extend(["policy-as-code", "lint-rule"])
    if any(
        token in lower for token in ("force new", "forcenew", "forces replacement", "destroy", "delete", "replacement")
    ):
        tags.append("destructive-risk")
    if any(token in lower for token in ("import ", "terraform import", "import_id", "import id")):
        tags.append("import-guidance")
    if any(token in lower for token in ("sensitive", "secret", "password", "token", "private_key")):
        tags.append("sensitive-state")
    if any(token in lower for token in ("state", "drift", "refresh", "remote backend")):
        tags.append("state-management")
    return {
        "scope_tags": tags,
        "constraint_kind": "hard" if artifact_kind == "provider_schema" else "guiding",
        "constraint_source": "terraform-provider-schema"
        if artifact_kind == "provider_schema"
        else "tflint-rules"
        if artifact_kind == "iac_policy_rule"
        else "terraform-docs",
        "content_profile": "reference" if artifact_kind in {"provider_schema", "provider_docs"} else "procedural",
        "provider": provider,
        "prompt_id": prompt_id or _terraform_prompt_for_chunk(text, rel_path=rel_path, artifact_kind=artifact_kind),
    }


def _terraform_artifact_for_aux(aux: dict[str, Any]) -> str:
    explicit = str(aux.get("artifact_kind") or "")
    if explicit:
        return explicit
    name = str(aux.get("name") or "").lower()
    repo = str(aux.get("repo") or "").lower()
    if "opentofu" in name or "opentofu" in repo:
        return "opentofu_feature"
    if "tflint" in name or "tflint" in repo:
        return "iac_policy_rule"
    if "provider" in name or "terraform-provider" in repo:
        return "provider_docs"
    return "terraform_guide"


def _terraform_symbol_from_doc_path(rel_path: str) -> tuple[str, str, str]:
    stem = Path(rel_path).stem
    parts = rel_path.split("/")
    if "resources" in parts:
        return "resource_doc", stem, stem
    if "data-sources" in parts or "data_sources" in parts or "datasources" in parts:
        return "data_source_doc", stem, stem
    return "docs", stem, ""


def _extract_terraform_docs(source_root: Path, *, config: dict[str, Any], tag: str) -> list[LanguageChunk]:
    repo = str(config.get("repo") or "github.com/hashicorp/terraform")
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    chunks: list[LanguageChunk] = []
    for chunk in _doc_chunks(
        source_root,
        [str(x) for x in include.get("docs", ["website/docs"])],
        language="terraform",
        repo=repo,
        tag=tag,
        package_name="terraform",
        artifact_kind="terraform_guide",
        prompt_id=TERRAFORM_PROMPT_ID,
    ):
        kind, name, fqn = _terraform_symbol_from_doc_path(chunk.module_path)
        chunk.symbol_kind = kind
        chunk.symbol_name = name
        chunk.symbol_fqn = fqn
        chunk.metadata.update(
            _terraform_metadata(
                text=chunk.text, rel_path=chunk.module_path, artifact_kind="terraform_guide", symbol_kind=kind
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
        raw_path = aux.get("path") or "."
        paths = [str(path) for path in raw_path] if isinstance(raw_path, list) else [str(raw_path)]
        artifact_kind = _terraform_artifact_for_aux(aux)
        package_name = str(aux.get("package_name") or name or "terraform")
        provider = str(aux.get("provider") or "")
        prompt_id = str(aux.get("prompt_id") or "")
        for chunk in _doc_chunks(
            aux_root,
            paths,
            language="terraform",
            repo=repo_name or repo,
            tag=str(aux.get("resolved_ref") or "main"),
            package_name=package_name,
            artifact_kind=artifact_kind,
            prompt_id=prompt_id,
        ):
            kind, symbol_name, symbol_fqn = _terraform_symbol_from_doc_path(chunk.module_path)
            chunk.symbol_kind = kind
            chunk.symbol_name = symbol_name
            chunk.symbol_fqn = symbol_fqn
            chunk.metadata.update(
                _terraform_metadata(
                    text=chunk.text,
                    rel_path=chunk.module_path,
                    artifact_kind=artifact_kind,
                    symbol_kind=kind,
                    provider=provider,
                    prompt_id=prompt_id,
                )
            )
            chunks.append(chunk)
    return chunks


def _terraform_schema_attr_summary(block: dict[str, Any]) -> dict[str, list[str]]:
    attrs = block.get("attributes") if isinstance(block.get("attributes"), dict) else {}
    out = {"required": [], "optional": [], "computed": [], "sensitive": [], "deprecated": []}
    for name, raw in attrs.items():
        if not isinstance(raw, dict):
            continue
        if raw.get("required"):
            out["required"].append(str(name))
        if raw.get("optional"):
            out["optional"].append(str(name))
        if raw.get("computed"):
            out["computed"].append(str(name))
        if raw.get("sensitive"):
            out["sensitive"].append(str(name))
        if raw.get("deprecated"):
            out["deprecated"].append(str(name))
    return out


def _terraform_schema_chunk(
    *,
    repo: str,
    tag: str,
    rel_path: str,
    provider: str,
    name: str,
    schema: dict[str, Any],
    kind: str,
    index: int,
) -> LanguageChunk:
    block = schema.get("block") if isinstance(schema.get("block"), dict) else {}
    summary = _terraform_schema_attr_summary(block)
    nested = sorted((block.get("block_types") or {}).keys()) if isinstance(block.get("block_types"), dict) else []
    payload = {
        "provider": provider,
        "kind": kind,
        "name": name,
        "version": schema.get("version"),
        "attributes": summary,
        "nested_blocks": nested,
        "schema": schema,
    }
    text = json.dumps(payload, indent=2, sort_keys=True)
    metadata = _terraform_metadata(
        text=text, rel_path=rel_path, artifact_kind="provider_schema", symbol_kind=kind, provider=provider
    )
    metadata.update(
        {
            "terraform_provider": provider,
            "required_attributes": summary["required"],
            "optional_attributes": summary["optional"],
            "computed_attributes": summary["computed"],
            "sensitive_attributes": summary["sensitive"],
            "deprecated_attributes": summary["deprecated"],
        }
    )
    return LanguageChunk(
        text=text[:9000],
        doc_id=f"terraform:{provider}:{rel_path}:{kind}:{name}",
        chunk_index=index,
        document_name=rel_path,
        heading_path=name,
        section=name,
        source_url=f"https://{repo}/blob/{tag}/{rel_path}" if repo else rel_path,
        package_name=provider,
        symbol_kind=kind,
        symbol_fqn=name,
        symbol_name=name,
        module_path=rel_path,
        artifact_kind="provider_schema",
        content_format="json",
        metadata=metadata,
    )


def _extract_terraform_provider_schema_files(
    source_root: Path, *, config: dict[str, Any], tag: str, provider_schema: str | Path = ""
) -> list[LanguageChunk]:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    repo = str(config.get("repo") or "github.com/hashicorp/terraform")
    paths: list[Path] = []
    if provider_schema:
        paths.append(Path(provider_schema))
    for rel in include.get("provider_schema_roots", ["provider-schemas"]):
        root = source_root / str(rel)
        if root.is_file():
            paths.append(root)
        elif root.exists():
            paths.extend(sorted(root.rglob("*.json")))
    chunks: list[LanguageChunk] = []
    for file_path in paths:
        if not file_path.exists() or not file_path.is_file():
            continue
        try:
            data = json.loads(_read_text(file_path))
        except json.JSONDecodeError:
            continue
        provider_schemas = data.get("provider_schemas") if isinstance(data.get("provider_schemas"), dict) else {}
        rel_path = (
            file_path.relative_to(source_root).as_posix() if file_path.is_relative_to(source_root) else file_path.name
        )
        for provider, provider_data in sorted(provider_schemas.items()):
            if not isinstance(provider_data, dict):
                continue
            for kind_key, symbol_kind in (("resource_schemas", "resource"), ("data_source_schemas", "data_source")):
                schemas = provider_data.get(kind_key) if isinstance(provider_data.get(kind_key), dict) else {}
                for name, schema in sorted(schemas.items()):
                    if not isinstance(schema, dict):
                        continue
                    chunks.append(
                        _terraform_schema_chunk(
                            repo=repo,
                            tag=tag,
                            rel_path=rel_path,
                            provider=str(provider),
                            name=str(name),
                            schema=schema,
                            kind=symbol_kind,
                            index=len(chunks),
                        )
                    )
    return chunks


def extract_terraform_chunks(
    source_root: Path, *, config: dict[str, Any], tag: str, provider_schema: str | Path = ""
) -> list[LanguageChunk]:
    chunks: list[LanguageChunk] = []
    chunks.extend(_extract_terraform_docs(source_root, config=config, tag=tag))
    chunks.extend(
        _extract_terraform_provider_schema_files(source_root, config=config, tag=tag, provider_schema=provider_schema)
    )
    for idx, chunk in enumerate(chunks):
        chunk.chunk_index = idx
    return chunks
