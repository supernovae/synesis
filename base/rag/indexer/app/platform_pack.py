"""Configurable SynPack platform-pack builder.

Platform packs model operational APIs, commands, validation workflows, and risk
patterns as first-class SynPack v2 graph data. They are intentionally separate
from language packs because platform knowledge is resource/schema/workflow
centric rather than package/symbol centric.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import re
import shutil
import tempfile
import time
import zipfile
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import httpx
import yaml

from .code_graph import derive_graph_edges
from .embed_client import EmbedClient
from .injection_scan import scan_chunk_text_detailed
from .language_pack import (
    DEFAULT_EMBEDDER_BATCH_SIZE,
    DEFAULT_EMBEDDER_TIMEOUT_SECONDS,
    DEFAULT_ENRICHMENT_CONCURRENCY,
    DEFAULT_ENRICHMENT_MAX_TOKENS,
    DEFAULT_ENRICHMENT_MODEL,
    DEFAULT_ENRICHMENT_PROVIDER,
    DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
    MAX_ENRICHMENT_CONCURRENCY,
    _effective_enrichment_max_tokens,
    _enrichment_thinking_metadata,
    _normalize_enrichment_provider,
    _resolve_enrichment_api_key,
    aggregate_enrichment_usage,
    parse_enrichment_response,
)
from .nornic_writer import chunk_id_hash
from .pipeline import _code_chunk_metrics
from .schema import CORPUS_VERSION, EMBEDDING_DIM, EMBEDDING_PROFILE, SCHEMA_VERSION, catalog_entity
from .synpack import (
    DEFAULT_PACK_MODEL,
    SYNPACK_FORMAT_VERSION,
    SynPackError,
    _sanitize_pack_id,
    _sha256_file,
    materialize_synpack_v2,
)

SUPPORTED_PLATFORM_PACKS = {"openshift", "kubernetes", "gitops", "observability", "devops-tooling"}
DEFAULT_PLATFORM_PROMPT_ID = "platform_api_schema_architect_v1"
PLATFORM_PROMPT_VARIABLE = "{{PLATFORM_DOC_OR_SPEC_CHUNK}}"
PLATFORM_NODE_KINDS = (
    "ResourceKind",
    "ApiGroupVersion",
    "SchemaProperty",
    "PlatformConstraint",
    "PlatformCommand",
    "ValidationRecipe",
    "RiskPattern",
)


@dataclass
class PlatformChunk:
    text: str
    doc_id: str
    chunk_index: int
    document_name: str
    heading_path: str = ""
    section: str = ""
    source_url: str = ""
    platform: str = ""
    resource_kind: str = ""
    api_group: str = ""
    api_version: str = ""
    artifact_kind: str = "docs"
    content_format: str = "markdown"
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def prompt_id(self) -> str:
        return str(self.metadata.get("prompt_id") or "")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _default_config_path(platform: str) -> Path:
    return _repo_root() / f"base/rag/pack-configs/platform/{platform}.yaml"


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SynPackError(f"platform pack config not found: {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise SynPackError(f"platform pack config must be a mapping: {path}")
    return data


def _write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def _sha_short(*parts: Any) -> str:
    return hashlib.sha256("|".join(str(part) for part in parts).encode()).hexdigest()[:24]


def _node_id(pack_id: str, category: str, *parts: Any) -> str:
    readable = ":".join(str(part).strip().replace("/", ".").replace(" ", "-") for part in parts if str(part).strip())
    readable = re.sub(r"[^A-Za-z0-9_.:-]+", "-", readable).strip("-:._")
    if len(readable) > 96:
        readable = f"{readable[:64]}:{_sha_short(*parts)}"
    return f"{pack_id}:{category}:{readable or _sha_short(category, *parts)}"


def _base_node(
    *,
    pack_id: str,
    pack_version: str,
    source_version: str,
    platform: str,
    kind: str,
    node_id: str,
    name: str,
    domain: str,
    source_url: str = "",
    **fields: Any,
) -> dict[str, Any]:
    return {
        "id": node_id,
        "kind": kind,
        "name": name,
        "pack": pack_id,
        "pack_id": pack_id,
        "pack_version": pack_version,
        "source_version": source_version,
        "domain": domain,
        "platform": platform,
        "source_url": source_url,
        "content_type": "developer",
        "authority": "vetted",
        **fields,
    }


def _load_source_entry(entry: Any, *, source_root: Path) -> tuple[str, dict[str, Any]]:
    if isinstance(entry, str):
        entry = {"path": entry}
    if not isinstance(entry, dict):
        raise SynPackError("platform source entries must be strings or mappings")
    if entry.get("content") is not None:
        return str(entry.get("content") or ""), dict(entry)
    url = str(entry.get("url") or "").strip()
    if url:
        with httpx.Client(timeout=60.0, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            return resp.text, dict(entry)
    raw_path = str(entry.get("path") or "").strip()
    if not raw_path:
        raise SynPackError("platform source entry requires path, url, or content")
    path = Path(raw_path)
    if not path.is_absolute():
        path = source_root / path
    if not path.exists():
        raise SynPackError(f"platform source path not found: {path}")
    return path.read_text(encoding="utf-8"), {**dict(entry), "resolved_path": str(path)}


def _parse_structured_document(text: str, *, source_name: str = "") -> dict[str, Any]:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise SynPackError(f"cannot parse platform structured source {source_name}: {exc}") from exc
    if not isinstance(data, dict):
        raise SynPackError(f"platform structured source must parse to an object: {source_name}")
    return data


def _schema_map(spec: dict[str, Any]) -> dict[str, Any]:
    components = spec.get("components") if isinstance(spec.get("components"), dict) else {}
    schemas = components.get("schemas") if isinstance(components.get("schemas"), dict) else None
    definitions = spec.get("definitions") if isinstance(spec.get("definitions"), dict) else None
    return dict(schemas or definitions or {})


def _infer_gvk(schema_name: str, schema: dict[str, Any]) -> list[dict[str, str]]:
    extension = schema.get("x-kubernetes-group-version-kind")
    if isinstance(extension, list):
        gvks = []
        for item in extension:
            if isinstance(item, dict) and item.get("kind"):
                gvks.append(
                    {
                        "group": str(item.get("group") or ""),
                        "version": str(item.get("version") or ""),
                        "kind": str(item.get("kind") or ""),
                    }
                )
        if gvks:
            return gvks
    parts = schema_name.split(".")
    kind = str(schema.get("title") or parts[-1] or schema_name)
    version = next((part for part in reversed(parts[:-1]) if re.fullmatch(r"v\d+(?:[a-z]+\d*)?", part)), "")
    group = ""
    if "api" in parts and version:
        idx = parts.index("api")
        version_idx = parts.index(version)
        group = ".".join(parts[idx + 1 : version_idx])
    elif "openshift" in parts and version:
        version_idx = parts.index(version)
        group = ".".join(parts[max(0, version_idx - 2) : version_idx])
    return [{"group": group, "version": version, "kind": kind}]


def _iter_schema_properties(
    schema: dict[str, Any], *, required: set[str], prefix: str = "", depth: int = 0, max_depth: int = 4
) -> Iterable[tuple[str, dict[str, Any], bool]]:
    if depth > max_depth:
        return
    props = schema.get("properties")
    if not isinstance(props, dict):
        return
    for name, prop in props.items():
        if not isinstance(prop, dict):
            continue
        field_path = f"{prefix}.{name}" if prefix else str(name)
        is_required = str(name) in required
        yield field_path, prop, is_required
        child_required = prop.get("required") if isinstance(prop.get("required"), list) else []
        yield from _iter_schema_properties(
            prop,
            required={str(item) for item in child_required},
            prefix=field_path,
            depth=depth + 1,
            max_depth=max_depth,
        )
        items = prop.get("items")
        if isinstance(items, dict):
            item_required = items.get("required") if isinstance(items.get("required"), list) else []
            yield from _iter_schema_properties(
                items,
                required={str(item) for item in item_required},
                prefix=f"{field_path}[]",
                depth=depth + 1,
                max_depth=max_depth,
            )


def _property_type(prop: dict[str, Any]) -> str:
    if prop.get("$ref"):
        return str(prop.get("$ref") or "").rsplit("/", 1)[-1]
    if prop.get("type"):
        value = str(prop.get("type") or "")
        if value == "array" and isinstance(prop.get("items"), dict):
            return f"array[{_property_type(prop['items'])}]"
        return value
    if prop.get("oneOf"):
        return "oneOf"
    if prop.get("anyOf"):
        return "anyOf"
    return "object"


def _sensitive_field(path: str) -> bool:
    lowered = path.lower()
    return any(term in lowered for term in ("password", "secret", "token", "privatekey", "clientkey", "certificate"))


def _resource_text(gvk: dict[str, str], schema: dict[str, Any], schema_name: str) -> str:
    kind = gvk["kind"]
    group = gvk["group"] or "core"
    version = gvk["version"] or "unknown"
    description = str(schema.get("description") or "").strip()
    required = schema.get("required") if isinstance(schema.get("required"), list) else []
    required_text = ", ".join(str(item) for item in required[:20]) or "none listed"
    lines = [
        f"# {kind}",
        f"API group/version: {group}/{version}",
        f"OpenAPI schema: {schema_name}",
        f"Required top-level fields: {required_text}",
    ]
    if description:
        lines.append("")
        lines.append(description)
    return "\n".join(lines).strip()


def _doc_chunks(
    text: str,
    *,
    doc_id: str,
    document_name: str,
    source_url: str,
    platform: str,
    artifact_kind: str,
    prompt_id: str,
    max_chars: int = 6000,
) -> list[PlatformChunk]:
    text = re.sub(r"\r\n?", "\n", text).strip()
    if not text:
        return []
    paragraphs = re.split(r"\n(?=#{1,3}\s)", text)
    chunks: list[PlatformChunk] = []
    buf = ""
    idx = 0
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if buf and len(buf) + len(paragraph) + 2 > max_chars:
            chunks.append(
                PlatformChunk(
                    text=buf.strip(),
                    doc_id=doc_id,
                    chunk_index=idx,
                    document_name=document_name,
                    source_url=source_url,
                    platform=platform,
                    artifact_kind=artifact_kind,
                    metadata={"prompt_id": prompt_id},
                )
            )
            idx += 1
            buf = ""
        buf = f"{buf}\n\n{paragraph}".strip()
    if buf:
        chunks.append(
            PlatformChunk(
                text=buf.strip(),
                doc_id=doc_id,
                chunk_index=idx,
                document_name=document_name,
                source_url=source_url,
                platform=platform,
                artifact_kind=artifact_kind,
                metadata={"prompt_id": prompt_id},
            )
        )
    return chunks


def _default_platform_commands(
    platform: str, pack_id: str, pack_version: str, source_version: str, domain: str
) -> list[dict[str, Any]]:
    commands = [
        ("kubectl", "kubectl apply --dry-run=server -f manifest.yaml", "server-side validation"),
        ("kubectl", "kubectl diff -f manifest.yaml", "preview cluster drift before apply"),
        ("kubectl", "kubectl auth can-i create pods --as system:serviceaccount:ns:name", "RBAC permission check"),
        ("helm", "helm template release chart/ --values values.yaml", "render Helm manifests before validation"),
        ("kustomize", "kustomize build overlays/prod", "render Kustomize overlays before validation"),
        ("kubeconform", "kubeconform -strict -summary manifests/", "schema validation"),
        ("conftest", "conftest test manifests/", "policy-as-code validation"),
    ]
    if platform == "openshift":
        commands.extend(
            [
                ("oc", "oc adm policy who-can create pods", "OpenShift RBAC subject discovery"),
                (
                    "oc",
                    "oc explain route.spec.tls --api-version=route.openshift.io/v1",
                    "OpenShift Route TLS schema lookup",
                ),
                ("oc", "oc adm policy scc-subject-review -f pod.yaml", "SCC admission review"),
            ]
        )
    return [
        _base_node(
            pack_id=pack_id,
            pack_version=pack_version,
            source_version=source_version,
            platform=platform,
            kind="PlatformCommand",
            node_id=_node_id(pack_id, "command", name, command),
            name=name,
            domain=domain,
            command=command,
            command_family=name,
            workflow=workflow,
            retrieval_terms=f"{name},{command},{workflow}",
        )
        for name, command, workflow in commands
    ]


def _default_validation_recipes(
    platform: str, pack_id: str, pack_version: str, source_version: str, domain: str
) -> list[dict[str, Any]]:
    recipes = [
        ("server-dry-run", "Use kubectl apply --dry-run=server to validate against live admission and API schema."),
        ("diff-before-apply", "Use kubectl diff or oc diff before changing live resources."),
        ("rbac-can-i", "Use kubectl auth can-i and oc adm policy who-can to verify service account permissions."),
        ("render-before-validate", "Render Helm or Kustomize output before schema and policy checks."),
        ("schema-policy-check", "Run kubeconform for schema validation and conftest for policy controls."),
    ]
    if platform == "openshift":
        recipes.append(("scc-review", "Use oc adm policy scc-subject-review to explain SCC admission failures."))
    return [
        _base_node(
            pack_id=pack_id,
            pack_version=pack_version,
            source_version=source_version,
            platform=platform,
            kind="ValidationRecipe",
            node_id=_node_id(pack_id, "validation", recipe_id),
            name=recipe_id,
            domain=domain,
            recipe_id=recipe_id,
            text=text,
            retrieval_terms=f"{recipe_id},{text}",
        )
        for recipe_id, text in recipes
    ]


def _default_risk_patterns(
    platform: str, pack_id: str, pack_version: str, source_version: str, domain: str
) -> list[dict[str, Any]]:
    risks = [
        ("privileged-pod", "Privileged pods and allowPrivilegeEscalation can bypass container isolation controls."),
        ("hostpath-volume", "hostPath volumes expose host filesystem paths to workloads and need strict review."),
        ("wildcard-rbac", "Wildcard RBAC verbs or resources can grant broader permissions than intended."),
        ("loadbalancer-exposure", "Service type LoadBalancer can expose workloads externally."),
        (
            "selector-immutability",
            "Deployment and workload selectors are immutable after creation and require migration planning.",
        ),
        (
            "stateful-destructive-change",
            "StatefulSet, PVC, and storage changes can cause data loss or blocked rollouts.",
        ),
        (
            "missing-probes-resources",
            "Missing probes or resource requests make rollout and autoscaling behavior less predictable.",
        ),
    ]
    if platform == "openshift":
        risks.extend(
            [
                (
                    "unsafe-scc",
                    "OpenShift SecurityContextConstraints can allow privileged, host network, or hostPath access.",
                ),
                (
                    "route-tls-mismatch",
                    "OpenShift Route edge, reencrypt, and passthrough TLS modes have different certificate and backend expectations.",
                ),
            ]
        )
    return [
        _base_node(
            pack_id=pack_id,
            pack_version=pack_version,
            source_version=source_version,
            platform=platform,
            kind="RiskPattern",
            node_id=_node_id(pack_id, "risk", risk_id),
            name=risk_id,
            domain=domain,
            risk_id=risk_id,
            text=text,
            severity="high" if risk_id in {"privileged-pod", "wildcard-rbac", "unsafe-scc"} else "medium",
            retrieval_terms=f"{risk_id},{text}",
        )
        for risk_id, text in risks
    ]


def extract_platform_pack(
    *,
    platform: str,
    config: dict[str, Any],
    pack_id: str,
    pack_version: str,
    source_version: str,
    source_dir: str | Path = "",
    max_chunks: int = 0,
) -> tuple[list[PlatformChunk], dict[str, list[dict[str, Any]]], list[dict[str, Any]], dict[str, Any]]:
    source_root = Path(source_dir) if source_dir else _repo_root()
    domain = str(config.get("domain") or platform)
    prompt_id = str(config.get("prompt_id") or DEFAULT_PLATFORM_PROMPT_ID)
    chunks: list[PlatformChunk] = []
    extra_nodes: dict[str, list[dict[str, Any]]] = {kind: [] for kind in PLATFORM_NODE_KINDS}
    edges: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []

    for entry in config.get("openapi_specs", []) or []:
        text, meta = _load_source_entry(entry, source_root=source_root)
        source_name = str(meta.get("name") or meta.get("path") or meta.get("url") or "openapi")
        source_url = str(meta.get("url") or meta.get("source_url") or "")
        spec = _parse_structured_document(text, source_name=source_name)
        sources.append({"type": "openapi", "name": source_name, **{k: v for k, v in meta.items() if k != "content"}})
        for schema_name, schema in _schema_map(spec).items():
            if not isinstance(schema, dict):
                continue
            gvks = _infer_gvk(str(schema_name), schema)
            if not gvks:
                continue
            required = (
                {str(item) for item in schema.get("required", [])}
                if isinstance(schema.get("required"), list)
                else set()
            )
            for gvk in gvks:
                if not gvk.get("kind"):
                    continue
                group = gvk.get("group") or ""
                version = gvk.get("version") or ""
                kind_name = gvk["kind"]
                api_id = _node_id(pack_id, "api", group or "core", version or "unknown")
                resource_id = _node_id(pack_id, "resource", group or "core", version or "unknown", kind_name)
                extra_nodes["ApiGroupVersion"].append(
                    _base_node(
                        pack_id=pack_id,
                        pack_version=pack_version,
                        source_version=source_version,
                        platform=platform,
                        kind="ApiGroupVersion",
                        node_id=api_id,
                        name=f"{group or 'core'}/{version or 'unknown'}",
                        domain=domain,
                        source_url=source_url,
                        api_group=group,
                        api_version=version,
                    )
                )
                extra_nodes["ResourceKind"].append(
                    _base_node(
                        pack_id=pack_id,
                        pack_version=pack_version,
                        source_version=source_version,
                        platform=platform,
                        kind="ResourceKind",
                        node_id=resource_id,
                        name=kind_name,
                        domain=domain,
                        source_url=source_url,
                        api_group=group,
                        api_version=version,
                        resource_kind=kind_name,
                        schema_name=str(schema_name),
                        description=str(schema.get("description") or "")[:4096],
                    )
                )
                edges.append(
                    {"type": "MANAGED_BY", "source_id": resource_id, "target_id": api_id, "source": "platform_pack"}
                )
                chunks.append(
                    PlatformChunk(
                        text=_resource_text(gvk, schema, str(schema_name)),
                        doc_id=resource_id,
                        chunk_index=0,
                        document_name=kind_name,
                        source_url=source_url,
                        platform=platform,
                        resource_kind=kind_name,
                        api_group=group,
                        api_version=version,
                        artifact_kind="api_schema",
                        content_format="markdown",
                        metadata={"prompt_id": "platform_api_schema_architect_v1", "resource_node_id": resource_id},
                    )
                )
                for field_path, prop, is_required in _iter_schema_properties(schema, required=required):
                    prop_id = _node_id(pack_id, "field", group or "core", version or "unknown", kind_name, field_path)
                    deprecated = bool(prop.get("deprecated"))
                    sensitive = _sensitive_field(field_path)
                    extra_nodes["SchemaProperty"].append(
                        _base_node(
                            pack_id=pack_id,
                            pack_version=pack_version,
                            source_version=source_version,
                            platform=platform,
                            kind="SchemaProperty",
                            node_id=prop_id,
                            name=f"{kind_name}.{field_path}",
                            domain=domain,
                            source_url=source_url,
                            api_group=group,
                            api_version=version,
                            resource_kind=kind_name,
                            field_path=field_path,
                            property_type=_property_type(prop),
                            required=is_required,
                            default=prop.get("default"),
                            deprecated=deprecated,
                            sensitive=sensitive,
                            enum=prop.get("enum") if isinstance(prop.get("enum"), list) else [],
                            description=str(prop.get("description") or "")[:4096],
                        )
                    )
                    edges.append(
                        {"type": "HAS_FIELD", "source_id": resource_id, "target_id": prop_id, "source": "platform_pack"}
                    )
                    if is_required:
                        constraint_id = _node_id(pack_id, "constraint", kind_name, field_path, "required")
                        extra_nodes["PlatformConstraint"].append(
                            _base_node(
                                pack_id=pack_id,
                                pack_version=pack_version,
                                source_version=source_version,
                                platform=platform,
                                kind="PlatformConstraint",
                                node_id=constraint_id,
                                name=f"{kind_name}.{field_path} required",
                                domain=domain,
                                constraint_type="required_field",
                                resource_kind=kind_name,
                                field_path=field_path,
                                text=f"{kind_name}.{field_path} is required by the API schema.",
                            )
                        )
                        edges.append(
                            {
                                "type": "REQUIRES",
                                "source_id": resource_id,
                                "target_id": constraint_id,
                                "source": "platform_pack",
                            }
                        )
                    if field_path == "spec.selector" or field_path.startswith("spec.selector."):
                        constraint_id = _node_id(pack_id, "constraint", kind_name, field_path, "immutable")
                        extra_nodes["PlatformConstraint"].append(
                            _base_node(
                                pack_id=pack_id,
                                pack_version=pack_version,
                                source_version=source_version,
                                platform=platform,
                                kind="PlatformConstraint",
                                node_id=constraint_id,
                                name=f"{kind_name}.{field_path} immutable selector",
                                domain=domain,
                                constraint_type="immutable_selector",
                                resource_kind=kind_name,
                                field_path=field_path,
                                text=f"{kind_name}.{field_path} behaves as an immutable workload selector after creation; plan migrations instead of in-place selector edits.",
                            )
                        )
                        edges.append(
                            {
                                "type": "CONFLICTS_WITH",
                                "source_id": constraint_id,
                                "target_id": prop_id,
                                "source": "platform_pack",
                            }
                        )
                    if deprecated:
                        constraint_id = _node_id(pack_id, "constraint", kind_name, field_path, "deprecated")
                        extra_nodes["PlatformConstraint"].append(
                            _base_node(
                                pack_id=pack_id,
                                pack_version=pack_version,
                                source_version=source_version,
                                platform=platform,
                                kind="PlatformConstraint",
                                node_id=constraint_id,
                                name=f"{kind_name}.{field_path} deprecated",
                                domain=domain,
                                constraint_type="deprecated_field",
                                resource_kind=kind_name,
                                field_path=field_path,
                                text=f"{kind_name}.{field_path} is marked deprecated in the API schema.",
                            )
                        )
                        edges.append(
                            {
                                "type": "DEPRECATED_BY",
                                "source_id": prop_id,
                                "target_id": constraint_id,
                                "source": "platform_pack",
                            }
                        )

    for entry in (config.get("docs", []) or []) + (config.get("cli_docs", []) or []):
        text, meta = _load_source_entry(entry, source_root=source_root)
        source_name = str(meta.get("name") or meta.get("path") or meta.get("url") or "platform-doc")
        artifact_kind = str(
            meta.get("artifact_kind") or ("cli_reference" if meta in config.get("cli_docs", []) else "docs")
        )
        source_url = str(meta.get("url") or meta.get("source_url") or "")
        sources.append(
            {"type": artifact_kind, "name": source_name, **{k: v for k, v in meta.items() if k != "content"}}
        )
        chunks.extend(
            _doc_chunks(
                text,
                doc_id=_node_id(pack_id, "doc", source_name),
                document_name=source_name,
                source_url=source_url,
                platform=platform,
                artifact_kind=artifact_kind,
                prompt_id=str(meta.get("prompt_id") or prompt_id),
            )
        )

    extra_nodes["PlatformCommand"].extend(
        _default_platform_commands(platform, pack_id, pack_version, source_version, domain)
    )
    extra_nodes["ValidationRecipe"].extend(
        _default_validation_recipes(platform, pack_id, pack_version, source_version, domain)
    )
    extra_nodes["RiskPattern"].extend(_default_risk_patterns(platform, pack_id, pack_version, source_version, domain))
    for recipe in extra_nodes["ValidationRecipe"]:
        for resource in extra_nodes["ResourceKind"]:
            edges.append(
                {
                    "type": "VALIDATED_BY",
                    "source_id": resource["id"],
                    "target_id": recipe["id"],
                    "source": "platform_pack",
                }
            )
    for risk in extra_nodes["RiskPattern"]:
        for resource in extra_nodes["ResourceKind"]:
            if risk["name"] in {"selector-immutability", "route-tls-mismatch", "unsafe-scc"}:
                kind_name = str(resource.get("resource_kind") or "")
                if risk["name"] == "selector-immutability" and kind_name not in {
                    "Deployment",
                    "StatefulSet",
                    "DaemonSet",
                    "ReplicaSet",
                }:
                    continue
                if risk["name"] == "route-tls-mismatch" and kind_name != "Route":
                    continue
                if risk["name"] == "unsafe-scc" and kind_name != "SecurityContextConstraints":
                    continue
            edges.append(
                {
                    "type": "CONFLICTS_WITH",
                    "source_id": resource["id"],
                    "target_id": risk["id"],
                    "source": "platform_pack",
                }
            )

    if max_chunks:
        chunks = chunks[: max(0, max_chunks)]
    sources_lock = {
        "platform": platform,
        "source_version": source_version,
        "source_dir": str(source_root),
        "sources": sources,
        "resource_kind_count": len(extra_nodes["ResourceKind"]),
        "schema_property_count": len(extra_nodes["SchemaProperty"]),
        "row_count": len(chunks),
    }
    return chunks, extra_nodes, edges, sources_lock


def _fallback_enrichment(chunk: PlatformChunk, *, error: str = "") -> dict[str, Any]:
    identity = " ".join(
        part for part in [chunk.resource_kind, chunk.api_group, chunk.api_version, chunk.document_name] if part
    )
    aliases = [item for item in [chunk.resource_kind, chunk.document_name, chunk.section, identity] if item]
    if chunk.resource_kind:
        aliases.extend(
            [
                f"{chunk.resource_kind} api schema",
                f"{chunk.resource_kind} yaml",
                f"{chunk.resource_kind} validation",
            ]
        )
    return {
        "enrichment_status": "fallback",
        "enrichment_error": error,
        "agent_hook": f"{chunk.platform} {identity or chunk.document_name} {chunk.artifact_kind}".strip(),
        "perf_tier": "n/a",
        "safety_contract": "Validate generated manifests with server-side dry-run, schema checks, RBAC checks, and policy checks before applying to a cluster.",
        "lifecycle_model": "versioned platform API",
        "task_intents": ["explain platform API behavior", "generate safe manifest", "debug validation failure"],
        "query_aliases": aliases,
        "agent_query_hints": aliases,
        "api_contract": f"{chunk.resource_kind or chunk.document_name} is part of the {chunk.platform} platform pack.",
        "version_scope": chunk.api_version or "platform source version",
        "verification_hints": [
            "kubectl apply --dry-run=server -f manifest.yaml",
            "kubectl diff -f manifest.yaml",
            "kubeconform -strict -summary manifests/",
            "conftest test manifests/",
        ],
        "canonical_examples": [],
        "anti_patterns": [],
        "hidden_warnings": [],
        "prompt_id": chunk.prompt_id or DEFAULT_PLATFORM_PROMPT_ID,
    }


def _render_prompt(chunk: PlatformChunk, prompt_templates: dict[str, str], default_prompt_id: str) -> tuple[str, str]:
    prompt_id = chunk.prompt_id or default_prompt_id
    template = prompt_templates.get(prompt_id) or prompt_templates[default_prompt_id]
    identity = {
        "platform": chunk.platform,
        "resource_kind": chunk.resource_kind,
        "api_group": chunk.api_group,
        "api_version": chunk.api_version,
        "artifact_kind": chunk.artifact_kind,
        "document_name": chunk.document_name,
    }
    prompt = template.replace(PLATFORM_PROMPT_VARIABLE, chunk.text).replace("{{DOC_CHUNK}}", chunk.text)
    return prompt_id, f"{prompt}\n\nPlatform chunk identity: {json.dumps(identity, sort_keys=True)}"


def enrich_platform_chunks(
    chunks: list[PlatformChunk],
    *,
    prompt_templates: dict[str, str],
    default_prompt_id: str,
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    enrichment_api_key: str = "",
    concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    timeout: float = DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
    skip: bool = False,
) -> list[dict[str, Any]]:
    provider = _normalize_enrichment_provider(enrichment_provider)
    if skip or not enrichment_url:
        return [_fallback_enrichment(chunk, error="enrichment skipped") for chunk in chunks]
    api_key = _resolve_enrichment_api_key(enrichment_api_key, provider=provider)
    url = enrichment_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = f"{url}/chat/completions" if url.endswith("/v1") else f"{url}/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    if provider == "deepseek":
        headers["X-DeepSeek-Think-Mode"] = "Max"

    def one(chunk: PlatformChunk) -> dict[str, Any]:
        prompt_id, prompt = _render_prompt(chunk, prompt_templates, default_prompt_id)
        payload: dict[str, Any] = {
            "model": enrichment_model,
            "max_tokens": _effective_enrichment_max_tokens(max_tokens, provider=provider),
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": "You enrich Kubernetes, OpenShift, and DevOps platform API knowledge for SynPack v2 graph retrieval. Return exactly one JSON object grounded in the source.",
                },
                {"role": "user", "content": prompt},
            ],
        }
        if provider == "deepseek":
            payload["reasoning_effort"] = "max"
            payload["thinking"] = {"type": "enabled"}
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
            parsed = parse_enrichment_response(str(data["choices"][0]["message"]["content"]), required_fields=None)
            parsed.setdefault("prompt_id", prompt_id)
            usage = data.get("usage") if isinstance(data, dict) else {}
            if isinstance(usage, dict):
                parsed["_enrichment_usage"] = {
                    key: int(usage.get(key, 0) or 0) for key in ("prompt_tokens", "completion_tokens", "total_tokens")
                }
            return parsed
        except Exception as exc:
            return _fallback_enrichment(chunk, error=str(exc))

    workers = max(1, min(int(concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, chunks))


def _embedding_input(chunk: PlatformChunk, enrichment: dict[str, Any]) -> str:
    identity = " | ".join(
        item
        for item in [chunk.platform, chunk.resource_kind, chunk.api_group, chunk.api_version, chunk.document_name]
        if item
    )
    retrieval = (
        ", ".join(str(item) for item in enrichment.get("query_aliases", []) if str(item).strip())
        if isinstance(enrichment.get("query_aliases"), list)
        else str(enrichment.get("query_aliases") or "")
    )
    hook = str(enrichment.get("agent_hook") or "").strip()
    return "\n\n".join(
        part
        for part in [
            f"IDENTIFIERS: {identity}" if identity else "",
            f"RETRIEVAL_TERMS: {retrieval}" if retrieval else "",
            f"AGENT_HOOK: {hook}" if hook else "",
            chunk.text,
        ]
        if part
    )


def _join_csv(values: Iterable[Any]) -> str:
    seen: list[str] = []
    for value in values:
        if isinstance(value, list):
            items = value
        else:
            items = str(value or "").split(",")
        for item in items:
            s = str(item).strip()
            if s and s not in seen:
                seen.append(s)
    return ",".join(seen)


def _build_rows(
    chunks: list[PlatformChunk],
    enrichments: list[dict[str, Any]],
    embeddings: list[list[float]],
    *,
    pack_id: str,
    pack_version: str,
    source_version: str,
    platform: str,
    domain: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for chunk, enrichment, embedding in zip(chunks, enrichments, embeddings):
        status, signals = scan_chunk_text_detailed(chunk.text)
        has_code, code_signal_count, code_density = _code_chunk_metrics(chunk.text)
        chunk_id = chunk_id_hash(chunk.text, f"{pack_id}:{chunk.doc_id}:{chunk.chunk_index}")
        row = catalog_entity(
            chunk_id=chunk_id,
            text=chunk.text,
            embedding=embedding,
            doc_id=chunk.doc_id,
            chunk_index=chunk.chunk_index,
            context_prefix=str(enrichment.get("agent_hook") or ""),
            chunk_summary=str(enrichment.get("agent_hook") or ""),
            heading_path=chunk.heading_path,
            section=chunk.section,
            document_name=chunk.document_name,
            source_type=chunk.artifact_kind,
            handler="platform_pack",
            domain=domain,
            tags=_join_csv([[f"platform-pack:{platform}", chunk.artifact_kind, chunk.resource_kind]]),
            keywords=_join_csv(
                [
                    [chunk.platform, chunk.resource_kind, chunk.api_group, chunk.api_version],
                    enrichment.get("query_aliases", []),
                ]
            ),
            origin_type="curated",
            authority="vetted",
            pack_id=pack_id,
            pack_version=pack_version,
            pack_source_version=source_version,
            pack_partition=pack_id,
            source_url=chunk.source_url,
            agent_hook=str(enrichment.get("agent_hook") or ""),
            perf_tier=str(enrichment.get("perf_tier") or "n/a"),
            safety_contract=str(enrichment.get("safety_contract") or ""),
            lifecycle_model=str(enrichment.get("lifecycle_model") or "versioned platform API"),
            agent_enrichment_json=json.dumps(enrichment, ensure_ascii=False, sort_keys=True),
            scan_status=status,
            scan_signals=",".join(signals),
            content_format=chunk.content_format,
            artifact_kind=chunk.artifact_kind,
            has_code=has_code,
            code_signal_count=code_signal_count,
            code_density=code_density,
            code_language="yaml" if has_code else "",
            corpus_class="platform_enriched",
            content_profile="platform_reference",
            scope_tags=_join_csv([[platform, chunk.artifact_kind, chunk.resource_kind]]),
            crawl_timestamp=int(time.time() * 1000),
            raw_content_hash=hashlib.sha256(chunk.text.encode()).hexdigest(),
            clean_content_hash=hashlib.sha256(chunk.text.encode()).hexdigest(),
            enrichment_profile=str(enrichment.get("prompt_id") or chunk.prompt_id or DEFAULT_PLATFORM_PROMPT_ID),
        )
        row["platform"] = platform
        row["resource_kind"] = chunk.resource_kind
        row["api_group"] = chunk.api_group
        row["api_version"] = chunk.api_version
        row["query_aliases"] = _join_csv([enrichment.get("query_aliases", [])])
        row["agent_query_hints"] = _join_csv([enrichment.get("agent_query_hints", [])])
        row["task_intents"] = _join_csv([enrichment.get("task_intents", [])])
        row["verification_hints"] = _join_csv([enrichment.get("verification_hints", [])])
        rows.append(row)
    return rows


def _load_prompt_templates(config: dict[str, Any], *, config_path: Path) -> tuple[dict[str, str], dict[str, str]]:
    prompts = config.get("prompts") if isinstance(config.get("prompts"), list) else []
    if not prompts:
        prompts = [
            {
                "id": config.get("prompt_id") or DEFAULT_PLATFORM_PROMPT_ID,
                "path": f"../prompts/{DEFAULT_PLATFORM_PROMPT_ID}.md",
            }
        ]
    templates: dict[str, str] = {}
    hashes: dict[str, str] = {}
    for spec in prompts:
        if not isinstance(spec, dict):
            continue
        prompt_id = str(spec.get("id") or "").strip()
        raw_path = str(spec.get("path") or "").strip()
        if not prompt_id or not raw_path:
            continue
        path = Path(raw_path)
        if not path.is_absolute():
            path = (config_path.parent / path).resolve()
        text = path.read_text(encoding="utf-8")
        templates[prompt_id] = text
        hashes[prompt_id] = hashlib.sha256(text.encode()).hexdigest()
    if not templates:
        raise SynPackError("platform pack config must define at least one prompt template")
    return templates, hashes


def _chunk_record(pack_id: str, chunk: PlatformChunk) -> dict[str, Any]:
    record = asdict(chunk)
    record["chunk_key"] = hashlib.sha256(
        "|".join([pack_id, chunk.doc_id, str(chunk.chunk_index), chunk.text]).encode()
    ).hexdigest()
    return record


def _chunk_from_record(record: dict[str, Any]) -> PlatformChunk:
    payload = {key: value for key, value in record.items() if key in PlatformChunk.__dataclass_fields__}
    return PlatformChunk(**payload)


def _completed_enrichment_map(work_dir: Path) -> dict[str, dict[str, Any]]:
    completed: dict[str, dict[str, Any]] = {}
    for record in _read_jsonl(work_dir / "enrichments" / "completed.jsonl"):
        key = str(record.get("chunk_key") or "")
        enrichment = record.get("enrichment")
        if key and isinstance(enrichment, dict):
            completed[key] = enrichment
    return completed


def _write_synpack_archive_payload(zf: zipfile.ZipFile, root: Path) -> None:
    for name in ("manifest.json", "metadata.jsonl", "nodes.jsonl", "edges.jsonl", "sources.lock.json"):
        path = root / name
        if path.exists():
            zf.write(path, name)
    for dirname in ("nodes", "edges", "vectors", "enrichment", "quality"):
        directory = root / dirname
        if not directory.exists():
            continue
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                zf.write(path, str(path.relative_to(root)))


def _manifest_base(
    *, pack_id: str, pack_version: str, source_version: str, platform: str, domain: str
) -> dict[str, Any]:
    return {
        "format": "synpack",
        "format_version": SYNPACK_FORMAT_VERSION,
        "pack_id": pack_id,
        "pack_version": pack_version,
        "version": pack_version,
        "source_version": source_version,
        "platform": platform,
        "language": "",
        "domain": domain,
        "content_type": "developer",
        "embedding_model": DEFAULT_PACK_MODEL,
        "embedding_dimensions": EMBEDDING_DIM,
        "embedding_profile": EMBEDDING_PROFILE,
        "corpus_version": CORPUS_VERSION,
        "synesis_catalog_schema_version": SCHEMA_VERSION,
        "schema_version": SCHEMA_VERSION,
        "partitions": [pack_id],
        "install_profile": "nornicdb-v2-platform-graph",
        "metadata_fields": [
            "platform",
            "resource_kind",
            "api_group",
            "api_version",
            "artifact_kind",
            "agent_enrichment_json",
            "query_aliases",
            "task_intents",
            "verification_hints",
        ],
    }


def _estimate_cost(chunks: list[PlatformChunk], *, model: str, provider: str, max_tokens: int) -> dict[str, Any]:
    chars = sum(len(chunk.text) for chunk in chunks)
    requests = len(chunks)
    return {
        "estimator": "platform_chars_div_4_plus_request_budget_v1",
        "model": model,
        "provider": _normalize_enrichment_provider(provider),
        "chunks": requests,
        "chunk_text_chars": chars,
        "prompt_tokens_estimate": max(1, chars // 4) if requests else 0,
        "completion_budget_tokens": requests * _effective_enrichment_max_tokens(max_tokens, provider=provider),
    }


def prepare_staged_platform_pack(
    *,
    platform: str,
    work_dir: str | Path,
    pack_config: str | Path = "",
    pack_id: str = "",
    pack_version: str = "1.0.0",
    source_version: str = "",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    enrichment_concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    enrichment_max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    max_chunks: int = 0,
    source_dir: str | Path = "",
) -> dict[str, Any]:
    platform = platform.lower().strip()
    if platform not in SUPPORTED_PLATFORM_PACKS:
        raise SynPackError(f"unsupported platform pack: {platform}")
    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)
    config_path = Path(pack_config) if pack_config else _default_config_path(platform)
    config = _load_yaml(config_path)
    pack_id = _sanitize_pack_id(pack_id or str(config.get("pack_id") or f"{platform}-latest"))
    source_version = source_version or str(config.get("source_version") or config.get("version") or "pinned")
    domain = str(config.get("domain") or platform)
    prompt_templates, prompt_hashes = _load_prompt_templates(config, config_path=config_path)
    default_prompt_id = str(config.get("prompt_id") or DEFAULT_PLATFORM_PROMPT_ID)
    chunks, extra_nodes, edges, sources_lock = extract_platform_pack(
        platform=platform,
        config=config,
        pack_id=pack_id,
        pack_version=pack_version,
        source_version=source_version,
        source_dir=source_dir,
        max_chunks=max_chunks,
    )
    _write_jsonl(work / "chunks.jsonl", [_chunk_record(pack_id, chunk) for chunk in chunks])
    for kind, nodes in extra_nodes.items():
        _write_jsonl(work / "platform_nodes" / f"{kind}.jsonl", nodes)
    _write_jsonl(work / "platform_edges.jsonl", edges)
    sources_lock["row_count"] = len(chunks)
    sources_lock_path = work / "sources.lock.json"
    sources_lock_path.write_text(json.dumps(sources_lock, indent=2, sort_keys=True), encoding="utf-8")
    cost_estimate = _estimate_cost(
        chunks, model=enrichment_model, provider=enrichment_provider, max_tokens=enrichment_max_tokens
    )
    run_manifest = {
        **_manifest_base(
            pack_id=pack_id,
            pack_version=pack_version,
            source_version=source_version,
            platform=platform,
            domain=domain,
        ),
        "staged": True,
        "pack_config": str(config_path),
        "prompt_variable": PLATFORM_PROMPT_VARIABLE,
        "enrichment": {
            "model": enrichment_model,
            "provider": _normalize_enrichment_provider(enrichment_provider),
            "prompt_id": default_prompt_id,
            "prompt_sha256": prompt_hashes.get(default_prompt_id, ""),
            "prompt_hashes": prompt_hashes,
            "url_configured": bool(enrichment_url),
            "skipped": False,
            "max_tokens": _effective_enrichment_max_tokens(enrichment_max_tokens, provider=enrichment_provider),
            "concurrency": max(
                1, min(int(enrichment_concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY)
            ),
            **_enrichment_thinking_metadata(enrichment_provider),
            "cost_estimate": cost_estimate,
        },
        "source_quality": {
            "extracted": len(chunks),
            "platform_nodes": {kind: len(nodes) for kind, nodes in extra_nodes.items()},
        },
        "created_at": int(time.time()),
        "row_count": len(chunks),
        "sources_lock_sha256": _sha256_file(sources_lock_path),
    }
    (work / "run_manifest.json").write_text(json.dumps(run_manifest, indent=2, sort_keys=True), encoding="utf-8")
    return {
        "ok": True,
        "phase": "prepare",
        "work_dir": str(work),
        "pack_id": pack_id,
        "source_version": source_version,
        "chunks": len(chunks),
        "platform_nodes": run_manifest["source_quality"]["platform_nodes"],
        "cost_estimate": cost_estimate,
    }


def enrich_staged_platform_pack(
    *,
    work_dir: str | Path,
    enrichment_url: str = "",
    enrichment_model: str = "",
    enrichment_provider: str = "",
    enrichment_api_key: str = "",
    enrichment_concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    enrichment_max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    enrichment_timeout: float = DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
    request_limit: int = 0,
    batch_size: int = 100,
    skip_enrichment: bool = False,
) -> dict[str, Any]:
    work = Path(work_dir)
    manifest = json.loads((work / "run_manifest.json").read_text(encoding="utf-8"))
    prompt_hashes = manifest["enrichment"]["prompt_hashes"]
    prompt_templates = {
        prompt_id: (_repo_root() / "base/rag/pack-configs/prompts" / f"{prompt_id}.md").read_text(encoding="utf-8")
        for prompt_id in prompt_hashes
    }
    records = _read_jsonl(work / "chunks.jsonl")
    completed = _completed_enrichment_map(work)
    pending = [record for record in records if str(record.get("chunk_key") or "") not in completed]
    if request_limit:
        pending = pending[: max(0, request_limit)]
    pending = pending[: max(1, batch_size)] if pending else []
    chunks = [_chunk_from_record(record) for record in pending]
    enrichments = enrich_platform_chunks(
        chunks,
        prompt_templates=prompt_templates,
        default_prompt_id=str(manifest["enrichment"]["prompt_id"]),
        enrichment_url=enrichment_url,
        enrichment_model=enrichment_model or str(manifest["enrichment"]["model"] or DEFAULT_ENRICHMENT_MODEL),
        enrichment_provider=enrichment_provider
        or str(manifest["enrichment"]["provider"] or DEFAULT_ENRICHMENT_PROVIDER),
        enrichment_api_key=enrichment_api_key,
        concurrency=enrichment_concurrency,
        max_tokens=enrichment_max_tokens,
        timeout=enrichment_timeout,
        skip=skip_enrichment,
    )
    completed_path = work / "enrichments" / "completed.jsonl"
    completed_path.parent.mkdir(parents=True, exist_ok=True)
    with completed_path.open("a", encoding="utf-8") as f:
        for record, enrichment in zip(pending, enrichments):
            f.write(
                json.dumps(
                    {"chunk_key": record["chunk_key"], "enrichment": enrichment, "completed_at": int(time.time())},
                    ensure_ascii=False,
                    sort_keys=True,
                )
                + "\n"
            )
    completed_after = len(_completed_enrichment_map(work))
    return {
        "ok": True,
        "phase": "enrich",
        "submitted": len(pending),
        "completed": completed_after,
        "remaining": max(0, len(records) - completed_after),
    }


def _read_platform_nodes(work: Path) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for kind in PLATFORM_NODE_KINDS:
        out[kind] = _read_jsonl(work / "platform_nodes" / f"{kind}.jsonl")
    return out


def finalize_staged_platform_pack(
    *,
    work_dir: str | Path,
    output_path: str | Path,
    embedder_url: str = "",
    embedder_batch_size: int = DEFAULT_EMBEDDER_BATCH_SIZE,
    embedder_timeout: float = DEFAULT_EMBEDDER_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    work = Path(work_dir)
    manifest = json.loads((work / "run_manifest.json").read_text(encoding="utf-8"))
    records = _read_jsonl(work / "chunks.jsonl")
    completed = _completed_enrichment_map(work)
    missing = [record["chunk_key"] for record in records if record["chunk_key"] not in completed]
    if missing:
        raise SynPackError(f"cannot finalize staged platform pack; missing {len(missing)} enrichments")
    chunks = [_chunk_from_record(record) for record in records]
    enrichments = [completed[record["chunk_key"]] for record in records]
    embedder_kwargs: dict[str, Any] = {
        "batch_size": max(1, int(embedder_batch_size or 1)),
        "timeout": max(1.0, float(embedder_timeout or 1.0)),
    }
    if embedder_url:
        embedder_kwargs["url"] = embedder_url
    embedder = EmbedClient(**embedder_kwargs)
    embeddings = (
        embedder.embed_texts([_embedding_input(chunk, enrichment) for chunk, enrichment in zip(chunks, enrichments)])
        if chunks
        else []
    )
    if len(embeddings) != len(chunks):
        raise SynPackError(f"embedder returned {len(embeddings)} vectors for {len(chunks)} chunks")
    bad_dims = [len(vec) for vec in embeddings if len(vec) != EMBEDDING_DIM]
    if bad_dims:
        raise SynPackError(f"embedder returned vector dimension {bad_dims[0]}, expected {EMBEDDING_DIM}")
    rows = _build_rows(
        chunks,
        enrichments,
        embeddings,
        pack_id=str(manifest["pack_id"]),
        pack_version=str(manifest["pack_version"]),
        source_version=str(manifest["source_version"]),
        platform=str(manifest["platform"]),
        domain=str(manifest["domain"]),
    )
    final_dir = work / "final"
    final_dir.mkdir(parents=True, exist_ok=True)
    _write_jsonl(final_dir / "metadata.jsonl", rows)
    structural_edges = derive_graph_edges(rows, include_structural_edges=True)
    platform_edges = _read_jsonl(work / "platform_edges.jsonl")
    edges = structural_edges + platform_edges
    _write_jsonl(final_dir / "edges.jsonl", edges)
    shutil.copyfile(work / "sources.lock.json", final_dir / "sources.lock.json")
    final_manifest = {
        **{key: value for key, value in manifest.items() if key not in {"staged", "pack_config", "prompt_variable"}},
        "enrichment": {**manifest["enrichment"], "usage": aggregate_enrichment_usage(enrichments), "skipped": False},
        "created_at": int(time.time()),
        "row_count": len(rows),
        "node_count": len(rows),
        "edge_count": len(edges),
        "requires_bulk_import": True,
        "sources_lock_sha256": _sha256_file(final_dir / "sources.lock.json"),
        "metadata_sha256": _sha256_file(final_dir / "metadata.jsonl"),
        "edges_sha256": _sha256_file(final_dir / "edges.jsonl"),
    }
    quality_report = materialize_synpack_v2(
        rows, edges, final_manifest, final_dir, extra_nodes_by_kind=_read_platform_nodes(work)
    )
    final_manifest.update(
        {
            "node_count": quality_report["node_count"],
            "chunk_count": quality_report["chunk_count"],
            "edge_count": quality_report["edge_count"],
            "node_counts_by_kind": quality_report["node_counts_by_kind"],
            "edge_counts_by_type": quality_report["edge_counts_by_type"],
            "pack_card_count": quality_report.get("pack_card_count", 0),
            "dangling_edge_count": quality_report["dangling_edge_count"],
            "external_ref_count": quality_report["external_ref_count"],
            "quality_report_sha256": _sha256_file(final_dir / "quality" / "report.json"),
        }
    )
    (final_dir / "manifest.json").write_text(json.dumps(final_manifest, indent=2, sort_keys=True), encoding="utf-8")
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        _write_synpack_archive_payload(zf, final_dir)
    return {
        "ok": True,
        "phase": "finalize",
        "pack_id": str(manifest["pack_id"]),
        "rows": len(rows),
        "path": str(out_path),
        "artifact_hash": _sha256_file(out_path),
    }


def build_platform_pack(
    *,
    platform: str,
    output_path: str | Path,
    pack_config: str | Path = "",
    pack_id: str = "",
    pack_version: str = "1.0.0",
    source_version: str = "",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    enrichment_api_key: str = "",
    enrichment_concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    enrichment_max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    enrichment_timeout: float = DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
    estimate_cost_only: bool = False,
    skip_enrichment: bool = False,
    embedder_url: str = "",
    embedder_batch_size: int = DEFAULT_EMBEDDER_BATCH_SIZE,
    embedder_timeout: float = DEFAULT_EMBEDDER_TIMEOUT_SECONDS,
    max_chunks: int = 0,
    source_dir: str | Path = "",
) -> dict[str, Any]:
    platform = platform.lower().strip()
    if platform not in SUPPORTED_PLATFORM_PACKS:
        raise SynPackError(f"unsupported platform pack: {platform}")
    config_path = Path(pack_config) if pack_config else _default_config_path(platform)
    config = _load_yaml(config_path)
    pack_id = _sanitize_pack_id(pack_id or str(config.get("pack_id") or f"{platform}-latest"))
    source_version = source_version or str(config.get("source_version") or config.get("version") or "pinned")
    domain = str(config.get("domain") or platform)
    prompt_templates, prompt_hashes = _load_prompt_templates(config, config_path=config_path)
    default_prompt_id = str(config.get("prompt_id") or DEFAULT_PLATFORM_PROMPT_ID)
    chunks, extra_nodes, platform_edges, sources_lock = extract_platform_pack(
        platform=platform,
        config=config,
        pack_id=pack_id,
        pack_version=pack_version,
        source_version=source_version,
        source_dir=source_dir,
        max_chunks=max_chunks,
    )
    cost_estimate = _estimate_cost(
        chunks, model=enrichment_model, provider=enrichment_provider, max_tokens=enrichment_max_tokens
    )
    if estimate_cost_only:
        return {
            "ok": True,
            "estimate_only": True,
            "platform": platform,
            "pack_id": pack_id,
            "source_version": source_version,
            "chunks": len(chunks),
            "platform_nodes": {kind: len(nodes) for kind, nodes in extra_nodes.items()},
            "enrichment": {
                "model": enrichment_model,
                "provider": _normalize_enrichment_provider(enrichment_provider),
                "prompt_id": default_prompt_id,
                "prompt_hashes": prompt_hashes,
                "cost_estimate": cost_estimate,
            },
        }
    enrichments = enrich_platform_chunks(
        chunks,
        prompt_templates=prompt_templates,
        default_prompt_id=default_prompt_id,
        enrichment_url=enrichment_url,
        enrichment_model=enrichment_model,
        enrichment_provider=enrichment_provider,
        enrichment_api_key=enrichment_api_key,
        concurrency=enrichment_concurrency,
        max_tokens=enrichment_max_tokens,
        timeout=enrichment_timeout,
        skip=skip_enrichment,
    )
    embedder_kwargs: dict[str, Any] = {
        "batch_size": max(1, int(embedder_batch_size or 1)),
        "timeout": max(1.0, float(embedder_timeout or 1.0)),
    }
    if embedder_url:
        embedder_kwargs["url"] = embedder_url
    embedder = EmbedClient(**embedder_kwargs)
    embeddings = (
        embedder.embed_texts([_embedding_input(chunk, enrichment) for chunk, enrichment in zip(chunks, enrichments)])
        if chunks
        else []
    )
    if len(embeddings) != len(chunks):
        raise SynPackError(f"embedder returned {len(embeddings)} vectors for {len(chunks)} chunks")
    bad_dims = [len(vec) for vec in embeddings if len(vec) != EMBEDDING_DIM]
    if bad_dims:
        raise SynPackError(f"embedder returned vector dimension {bad_dims[0]}, expected {EMBEDDING_DIM}")
    tmp = Path(tempfile.mkdtemp(prefix="synpack-platform-"))
    try:
        rows = _build_rows(
            chunks,
            enrichments,
            embeddings,
            pack_id=pack_id,
            pack_version=pack_version,
            source_version=source_version,
            platform=platform,
            domain=domain,
        )
        _write_jsonl(tmp / "metadata.jsonl", rows)
        edges = derive_graph_edges(rows, include_structural_edges=True) + platform_edges
        _write_jsonl(tmp / "edges.jsonl", edges)
        sources_lock["row_count"] = len(rows)
        sources_lock_path = tmp / "sources.lock.json"
        sources_lock_path.write_text(json.dumps(sources_lock, indent=2, sort_keys=True), encoding="utf-8")
        manifest = {
            **_manifest_base(
                pack_id=pack_id,
                pack_version=pack_version,
                source_version=source_version,
                platform=platform,
                domain=domain,
            ),
            "trust_score": float(config.get("trust_score", 1.0) or 1.0),
            "freshness_score": float(config.get("freshness_score", 1.0) or 1.0),
            "enrichment": {
                "model": enrichment_model if enrichment_url and not skip_enrichment else "",
                "provider": _normalize_enrichment_provider(enrichment_provider),
                "prompt_id": default_prompt_id,
                "prompt_sha256": prompt_hashes.get(default_prompt_id, ""),
                "prompt_hashes": prompt_hashes,
                "url_configured": bool(enrichment_url),
                "skipped": bool(skip_enrichment or not enrichment_url),
                "max_tokens": _effective_enrichment_max_tokens(enrichment_max_tokens, provider=enrichment_provider),
                "concurrency": max(
                    1, min(int(enrichment_concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY)
                ),
                **_enrichment_thinking_metadata(enrichment_provider),
                "cost_estimate": cost_estimate,
                "usage": aggregate_enrichment_usage(enrichments),
            },
            "source_quality": {
                "extracted": len(chunks),
                "platform_nodes": {kind: len(nodes) for kind, nodes in extra_nodes.items()},
            },
            "created_at": int(time.time()),
            "row_count": len(rows),
            "node_count": len(rows),
            "edge_count": len(edges),
            "requires_bulk_import": True,
            "sources_lock_sha256": _sha256_file(sources_lock_path),
            "metadata_sha256": _sha256_file(tmp / "metadata.jsonl"),
            "edges_sha256": _sha256_file(tmp / "edges.jsonl"),
        }
        quality_report = materialize_synpack_v2(rows, edges, manifest, tmp, extra_nodes_by_kind=extra_nodes)
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
        (tmp / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            _write_synpack_archive_payload(zf, tmp)
        return {
            "ok": True,
            "pack_id": pack_id,
            "platform": platform,
            "rows": len(rows),
            "path": str(out_path),
            "source_version": source_version,
            "artifact_hash": _sha256_file(out_path),
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
