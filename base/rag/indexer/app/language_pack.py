"""Configurable SynPack language-pack builder.

The pipeline supports curated language packs with language-specific extraction
and enrichment prompts while preserving universal SynPack v2 graph-ready fields.
"""

from __future__ import annotations

import concurrent.futures
import contextlib
import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import time
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import asdict
from pathlib import Path
from typing import Any

import httpx

from .code_graph import derive_graph_edges, extract_call_refs, extract_import_refs
from .embed_client import EmbedClient
from .injection_scan import scan_chunk_text_detailed
from .language_pack_bash import _shell_dialect, extract_bash_chunks
from .language_pack_common import (
    AUX_SOURCE_LANGUAGES,
    BASH_PROMPT_ID,
    ECMA_PROMPT_ID,
    GO_PROMPT_ID,
    GODOT_PROMPT_ID,
    PYTHON_PROMPT_ID,
    QUARKUS_PROMPT_ID,
    RUST_PROMPT_ID,
    SUPPORTED_LANGUAGE_PACKS,
    TERRAFORM_PROMPT_ID,
    LanguageChunk,
    _load_yaml,
    _normalize_doc_language,
    _read_text,
    _repo_root,
    _resolve_path,
    _supported_doc_languages,
    _validate_doc_language,
    clone_go_source,
    clone_repo,
    prepare_language_chunks_for_enrichment,
)
from .language_pack_common import _doc_chunks as _doc_chunks
from .language_pack_ecma import extract_ecma_chunks
from .language_pack_go import extract_go_chunks
from .language_pack_godot import _godot_lifecycle_callbacks, _godot_scene_tree_role, extract_godot_chunks
from .language_pack_python import extract_python_chunks
from .language_pack_quarkus import extract_quarkus_chunks
from .language_pack_rust import extract_rust_chunks
from .language_pack_tags import (
    latest_go_stable_tag_from_refs as latest_go_stable_tag_from_refs,
)
from .language_pack_tags import (
    latest_godot_stable_tag_from_refs as latest_godot_stable_tag_from_refs,
)
from .language_pack_tags import (
    latest_python_stable_tag_from_refs as latest_python_stable_tag_from_refs,
)
from .language_pack_tags import (
    latest_quarkus_stable_tag_from_refs as latest_quarkus_stable_tag_from_refs,
)
from .language_pack_tags import (
    latest_rust_stable_tag_from_refs as latest_rust_stable_tag_from_refs,
)
from .language_pack_tags import (
    latest_terraform_stable_tag_from_refs as latest_terraform_stable_tag_from_refs,
)
from .language_pack_tags import (
    parse_go_stable_tag as parse_go_stable_tag,
)
from .language_pack_tags import (
    parse_godot_stable_tag as parse_godot_stable_tag,
)
from .language_pack_tags import (
    parse_python_stable_tag as parse_python_stable_tag,
)
from .language_pack_tags import (
    parse_quarkus_stable_tag as parse_quarkus_stable_tag,
)
from .language_pack_tags import (
    parse_rust_stable_tag as parse_rust_stable_tag,
)
from .language_pack_tags import (
    parse_terraform_stable_tag as parse_terraform_stable_tag,
)
from .language_pack_tags import (
    resolve_latest_ecma_tag,
    resolve_latest_go_tag,
    resolve_latest_godot_tag,
    resolve_latest_python_tag,
    resolve_latest_quarkus_tag,
    resolve_latest_rust_tag,
    resolve_latest_terraform_tag,
)
from .language_pack_terraform import extract_terraform_chunks
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

DEFAULT_ENRICHMENT_MODEL = "deepseek-v4-pro"
DEFAULT_ENRICHMENT_PROVIDER = "deepseek"
DEFAULT_ENRICHMENT_MAX_TOKENS = 8192
DEFAULT_ENRICHMENT_TIMEOUT_SECONDS = 180.0
DEFAULT_ENRICHMENT_CONCURRENCY = 6
MAX_ENRICHMENT_CONCURRENCY = 8
DEFAULT_THINKING_CAP_TOKENS = 8192
DEFAULT_EMBEDDER_BATCH_SIZE = 8
DEFAULT_EMBEDDER_TIMEOUT_SECONDS = 300.0
FRONTIER_ENRICHMENT_SYSTEM_PROMPT = (
    "You are a principal software architect building retrieval enrichment for a portable Synesis SynPack. "
    "Analyze the chunk deeply for agentic retrieval, operational hazards, version constraints, lifecycle, "
    "performance, safety, and human-facing implementation guidance. Ground every field in the provided source. "
    "If the chunk is thin, ambiguous, generated, or noisy, say so in warnings instead of inventing facts. "
    "Return exactly one JSON object matching the requested schema and no surrounding prose. "
    "Prefer structured arrays and dense source-grounded strings that preserve exact names, relationships, "
    "retrieval facets, and MCP/tool guidance for smaller coding models. Do not artificially limit answers to "
    "one sentence when multiple source-grounded clauses make the pack more useful."
)
SYNPACK_V2_ENRICHMENT_APPEND = """

SynPack v2 enrichment requirements:
- Do not optimize for tiny output. Return rich, dense, source-grounded fields
  when the source supports them. Multi-sentence string fields are acceptable.
- Optimize every field for hybrid vector, keyword, and graph retrieval. Prefer
  concrete identifiers over pronouns. Write "net/http.Server.Shutdown shuts down
  listeners with context cancellation", not "this function shuts down listeners".
- Include the exact package/module, type, function, method, class, resource,
  command, error code, property, signal, or proposal name in agent_hook,
  query_aliases, agent_query_hints, task_intents, api_contract, and
  verification_hints whenever the source identifies one.
- Avoid generic phrases such as "this function", "this method", "this class",
  "this resource", "the API", or "this chunk" unless the sentence also names
  the concrete identifier.
- query_aliases and agent_query_hints should include likely user search forms:
  fully-qualified names, short names, package plus symbol, error codes, common
  task wording, and version/runtime qualifiers evidenced by the source.
- Include dense, source-grounded values for these optional fields when evidenced:
  task_intents, query_aliases, agent_query_hints, api_contract, version_scope,
  performance_notes, anti_patterns, hidden_warnings, canonical_examples,
  verification_hints, related_interfaces, related_symbols, agent_actions,
  confidence, evidence_spans, what_to_use, when_to_use, do_not_use,
  minimal_example.
- task_intents, query_aliases, agent_query_hints, anti_patterns,
  hidden_warnings, canonical_examples, verification_hints, related_interfaces,
  related_symbols, agent_actions, and evidence_spans should be JSON arrays.
- canonical_examples and anti_examples may be objects with title, text, code,
  setup, expected_output, test_command, runnable, applies_to, retrieval_terms,
  and query_aliases when the source supports concrete examples.
- what_to_use, when_to_use, do_not_use, and minimal_example should be concise
  context-card text suitable for small coding models and MCP clients.
- api_contract, version_scope, performance_notes, confidence may be strings or objects.
- Use empty arrays or "unknown" when the source does not support a field.
- Do not invent relationships. Put uncertain relationships in related_symbols with confidence and evidence span.
"""
REQUIRED_UNIVERSAL_ENRICHMENT_FIELDS = {
    "agent_hook",
    "perf_tier",
    "safety_contract",
    "lifecycle_model",
}
SYNPACK_V2_ARRAY_ENRICHMENT_FIELDS = (
    "task_intents",
    "query_aliases",
    "agent_query_hints",
    "anti_patterns",
    "hidden_warnings",
    "canonical_examples",
    "verification_hints",
    "related_interfaces",
    "related_symbols",
    "agent_actions",
    "evidence_spans",
)
SYNPACK_V2_SCALAR_ENRICHMENT_FIELDS = (
    "api_contract",
    "version_scope",
    "performance_notes",
    "confidence",
)


def parse_enrichment_response(raw: str, *, required_fields: set[str] | None = None) -> dict[str, Any]:
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SynPackError(f"enrichment response is not JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise SynPackError("enrichment response must be a single JSON object")
    missing = (required_fields or REQUIRED_UNIVERSAL_ENRICHMENT_FIELDS) - set(obj)
    if missing:
        raise SynPackError(f"enrichment response missing fields: {', '.join(sorted(missing))}")
    return obj


def _source_quality_metadata(chunk: LanguageChunk) -> dict[str, Any]:
    keys = (
        "source_quality_score",
        "source_quality_status",
        "source_quality_reason",
        "original_content_format",
        "normalized_content_format",
    )
    return {key: chunk.metadata[key] for key in keys if key in chunk.metadata}


def _attach_source_quality(enrichment: dict[str, Any], chunk: LanguageChunk) -> dict[str, Any]:
    out = _ensure_v2_enrichment_defaults(enrichment)
    quality = _source_quality_metadata(chunk)
    if not quality:
        return out
    out.setdefault("source_quality", quality)
    if quality.get("source_quality_status") == "warn":
        warnings = out.get("hidden_warnings")
        if not isinstance(warnings, list):
            warnings = [str(warnings)] if warnings else []
        reason = str(quality.get("source_quality_reason") or "source quality warning")
        if reason and reason not in warnings:
            warnings.append(reason)
        out["hidden_warnings"] = warnings
    return out


def _ensure_v2_enrichment_defaults(enrichment: dict[str, Any]) -> dict[str, Any]:
    out = dict(enrichment)
    for key in SYNPACK_V2_ARRAY_ENRICHMENT_FIELDS:
        value = out.get(key)
        if value is None or value == "":
            out[key] = []
        elif not isinstance(value, list):
            out[key] = [value]
    for key in SYNPACK_V2_SCALAR_ENRICHMENT_FIELDS:
        out.setdefault(key, "unknown")
    return out


def _chunk_identity_metadata(chunk: LanguageChunk) -> dict[str, str]:
    return {
        "document_name": chunk.document_name,
        "heading_path": chunk.heading_path,
        "section": chunk.section,
        "package_name": chunk.package_name,
        "module_path": chunk.module_path,
        "symbol_kind": chunk.symbol_kind,
        "symbol_name": chunk.symbol_name,
        "symbol_fqn": chunk.symbol_fqn,
        "artifact_kind": chunk.artifact_kind,
        "source_url": chunk.source_url,
        "prompt_id": chunk.prompt_id,
    }


def _string_list(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            if isinstance(item, dict):
                text = str(
                    item.get("symbol")
                    or item.get("name")
                    or item.get("text")
                    or item.get("query")
                    or item.get("intent")
                    or item.get("summary")
                    or ""
                ).strip()
            else:
                text = str(item).strip()
            if text:
                out.append(text)
        return out
    if isinstance(value, dict):
        return [str(v).strip() for v in value.values() if str(v).strip()]
    return [part.strip() for part in str(value).split(",") if part.strip()]


def _chunk_identity_terms(chunk: LanguageChunk) -> list[str]:
    terms = [
        chunk.symbol_fqn,
        chunk.symbol_name,
        chunk.package_name,
        f"{chunk.package_name}.{chunk.symbol_name}" if chunk.package_name and chunk.symbol_name else "",
        f"{chunk.package_name}::{chunk.symbol_name}" if chunk.package_name and chunk.symbol_name else "",
        f"{chunk.package_name} {chunk.symbol_name}" if chunk.package_name and chunk.symbol_name else "",
        chunk.module_path,
        chunk.heading_path,
        chunk.document_name,
        chunk.artifact_kind,
        chunk.symbol_kind,
    ]
    return [term for term in terms if term]


def _retrieval_terms(chunk: LanguageChunk, enrichment: dict[str, Any]) -> list[str]:
    seen: set[str] = set()
    terms: list[str] = []
    for term in _chunk_identity_terms(chunk):
        if term not in seen:
            seen.add(term)
            terms.append(term)
    for key in (
        "query_aliases",
        "agent_query_hints",
        "task_intents",
        "verification_hints",
        "related_interfaces",
        "related_symbols",
        "hidden_warnings",
        "anti_patterns",
    ):
        for term in _string_list(enrichment.get(key)):
            if term not in seen:
                seen.add(term)
                terms.append(term)
    return terms[:80]


def _embedding_input(chunk: LanguageChunk, enrichment: dict[str, Any]) -> str:
    identity = " | ".join(_chunk_identity_terms(chunk))
    retrieval = " | ".join(_retrieval_terms(chunk, enrichment))
    hook = str(enrichment.get("agent_hook") or "").strip()
    parts = [
        f"IDENTIFIERS: {identity}" if identity else "",
        f"RETRIEVAL_TERMS: {retrieval}" if retrieval else "",
        f"AGENT_HOOK: {hook}" if hook else "",
        chunk.text,
    ]
    return "\n\n".join(part for part in parts if part).strip()


def _zero_quality_enrichment_skip_reason(chunk: LanguageChunk) -> str:
    quality = _source_quality_metadata(chunk)
    raw_score = quality.get("source_quality_score")
    try:
        score = float(raw_score)
    except (TypeError, ValueError):
        return ""
    if score > 0.0:
        return ""
    reason = str(quality.get("source_quality_reason") or "no source quality signal").strip()
    return f"source_quality_score=0.0; LLM enrichment skipped ({reason})"


def fallback_enrichment(chunk: LanguageChunk, *, error: str = "") -> dict[str, Any]:
    language = str(
        chunk.metadata.get("language")
        or (
            "Rust"
            if chunk.doc_id.startswith("rust:")
            else "Quarkus"
            if chunk.doc_id.startswith("quarkus:")
            else "Python"
            if chunk.doc_id.startswith("python:")
            else "Godot"
            if chunk.doc_id.startswith("godot:")
            else "Terraform"
            if chunk.doc_id.startswith("terraform:")
            else "Ecma"
            if chunk.doc_id.startswith("ecma:")
            else "Bash"
            if chunk.doc_id.startswith("bash:")
            else "Go"
        )
    )
    if language.lower() == "rust":
        edition_scope = (
            chunk.metadata.get("edition_scope") if isinstance(chunk.metadata.get("edition_scope"), list) else []
        )
        return {
            "agent_hook": f"Use this Rust {chunk.symbol_kind or 'documentation'} chunk for {chunk.package_name or chunk.document_name}.",
            "perf_tier": "unknown",
            "safety_contract": "Validate ownership, borrowing, Send/Sync, panic, unsafe, and edition-specific constraints against the source text.",
            "lifecycle_model": "No model-derived lifecycle summary is available; rely on the official source content in this chunk.",
            "edition_scope": edition_scope,
            "async_contract": {
                "runtime_agnostic": "unknown",
                "blocking_risk": "unknown",
                "pinning_required": "unknown",
                "cancel_safety": "unknown",
                "requires_send": "unknown",
            },
            "borrow_contract": "unknown",
            "lifetime_capture": "unknown",
            "send_sync": "unknown",
            "panic_risk": "unknown",
            "unsafe_contract": "unknown",
            "ffi_risk": "unknown",
            "drop_semantics": "unknown",
            "feature_gate_or_stability": "unknown",
            "error_context": chunk.symbol_fqn if chunk.symbol_kind == "compiler_error" else "",
            "api_contract": "unknown",
            "version_scope": ",".join(str(item) for item in edition_scope) if edition_scope else "unknown",
            "performance_notes": "unknown",
            "task_intents": [chunk.artifact_kind] if chunk.artifact_kind else [],
            "query_aliases": _chunk_identity_terms(chunk),
            "verification_hints": ["cargo check", "cargo test", "cargo clippy"],
            "related_interfaces": [],
            "related_symbols": [],
            "canonical_examples": [],
            "anti_patterns": [],
            "hidden_warnings": [error] if error else [],
            "agent_actions": [],
            "evidence_spans": [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() == "python":
        if chunk.artifact_kind == "repo_map":
            repo_map = (
                chunk.metadata.get("repo_map_json") if isinstance(chunk.metadata.get("repo_map_json"), dict) else {}
            )
            return {
                "agent_hook": f"Use this Python repo-map row to orient before searching implementation files for {chunk.symbol_fqn or chunk.document_name}.",
                "perf_tier": "unknown",
                "safety_contract": "Use this as navigation metadata, not source-of-truth code behavior.",
                "lifecycle_model": "Repository topology and module intent map.",
                **repo_map,
                "enrichment_status": "fallback",
                "enrichment_error": error,
            }
        return {
            "agent_hook": f"Use this Python {chunk.symbol_kind or 'documentation'} chunk for {chunk.package_name or chunk.document_name}.",
            "perf_tier": "unknown",
            "safety_contract": "Validate Python version, free-threading, subinterpreter, async, typing, and environment constraints against the source text.",
            "lifecycle_model": "No model-derived lifecycle summary is available; rely on the official Python content in this chunk.",
            "thread_model": "unknown",
            "typing_strategy": "unknown",
            "async_contract": "unknown",
            "dependency_footprint": "unknown",
            "modern_idiom": "unknown",
            "environment_hint": "",
            "subinterpreter_safety": "unknown",
            "free_threading_risk": "unknown",
            "t_string_guidance": "unknown",
            "type_resolution_hint": "unknown",
            "hidden_warnings": [error] if error else [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() == "terraform":
        return {
            "agent_hook": f"Use this Terraform {chunk.symbol_kind or 'documentation'} chunk for {chunk.symbol_fqn or chunk.document_name}; validate with fmt, validate, and plan JSON before apply.",
            "perf_tier": "unknown",
            "safety_contract": "Treat infrastructure changes as stateful. Validate provider schema, plan actions, replacement risk, permissions, drift, imports, and sensitive state before execution.",
            "lifecycle_model": "No model-derived dependency lifecycle is available; rely on provider schema, Terraform graph, and plan JSON for final risk.",
            "core_safety": "unknown",
            "destroy_triggers": [],
            "force_new_confidence": "unknown",
            "permission_requirements": "unknown",
            "cross_resource_links": [],
            "drift_risk": "unknown",
            "provisioner_safe": "unknown",
            "import_id_format": "unknown",
            "state_sensitivity": "unknown",
            "approval_policy": "Require human approval for delete or delete/create plan actions.",
            "plan_guardrail": "Run terraform plan -out=tfplan and terraform show -json tfplan, then analyze destructive actions before apply.",
            "cloud_provider": str(chunk.metadata.get("provider") or "unknown"),
            "resource_weight": "unknown",
            "validation_hints": ["terraform fmt -check -recursive", "terraform validate", "terraform plan -out=tfplan"],
            "hidden_warnings": [error] if error else [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() in {"ecma", "javascript", "typescript"}:
        return {
            "agent_hook": f"Use this Ecma/JS/TS {chunk.symbol_kind or 'documentation'} chunk for {chunk.symbol_fqn or chunk.document_name}; verify runtime, module system, and TypeScript posture before suggesting code.",
            "perf_tier": "unknown",
            "safety_contract": "Validate runtime compatibility, TypeScript strictness/type-stripping, async behavior, module system, bundle impact, and memory lifecycle against project config.",
            "lifecycle_model": "No model-derived lifecycle summary is available; rely on runtime docs, package config, and source text.",
            "runtime_compatibility": [],
            "runtime_env": "unknown",
            "ts_safety": "unknown",
            "ts_contract": "unknown",
            "async_flavor": "unknown",
            "bundle_impact": "unknown",
            "memory_impact": "unknown",
            "modern_idiom": "unknown",
            "module_system": "unknown",
            "type_stripping_status": "unknown",
            "permission_model": "unknown",
            "dependency_advice": "unknown",
            "timezone_dependency": "unknown",
            "dst_awareness": "unknown",
            "runtime_status": "unknown",
            "comparison_logic": "unknown",
            "temporal_type": chunk.symbol_fqn if chunk.symbol_kind == "temporal_api" else "",
            "legacy_date_replacement": "unknown",
            "calendar_safety": "unknown",
            "hidden_warnings": [error] if error else [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() == "godot":
        signal_list = chunk.metadata.get("signal_list") if isinstance(chunk.metadata.get("signal_list"), list) else []
        signal_args = chunk.metadata.get("signal_args") if isinstance(chunk.metadata.get("signal_args"), list) else []
        lifecycle_callbacks = (
            chunk.metadata.get("lifecycle_callbacks")
            if isinstance(chunk.metadata.get("lifecycle_callbacks"), list)
            else _godot_lifecycle_callbacks(chunk.text)
        )
        migration_topics = (
            chunk.metadata.get("migration_topics") if isinstance(chunk.metadata.get("migration_topics"), list) else []
        )
        return {
            "agent_hook": f"Use this Godot {chunk.symbol_kind or 'documentation'} chunk for {chunk.symbol_fqn or chunk.document_name}.",
            "perf_tier": "unknown",
            "safety_contract": "Validate scene-tree lifecycle, signal routing, threading, rendering/physics boundaries, and Godot 4.x API behavior against the source text.",
            "lifecycle_model": "No model-derived lifecycle summary is available; rely on the official Godot class/docs source in this chunk.",
            "node_class": str(
                chunk.metadata.get("node_class") or (chunk.symbol_fqn if chunk.symbol_kind == "class" else "") or ""
            ),
            "inherits": str(chunk.metadata.get("inherits") or ""),
            "member_of": str(chunk.metadata.get("member_of") or ""),
            "signal_name": str(
                chunk.metadata.get("signal_name") or (chunk.symbol_name if chunk.symbol_kind == "signal" else "")
            ),
            "signal_args": signal_args,
            "lifecycle_callbacks": lifecycle_callbacks,
            "scene_tree_role": str(
                chunk.metadata.get("scene_tree_role")
                or _godot_scene_tree_role(chunk.text, artifact_kind=chunk.artifact_kind, symbol_kind=chunk.symbol_kind)
            ),
            "engine_major_version": str(chunk.metadata.get("engine_major_version") or "4"),
            "migration_topics": migration_topics,
            "node_compatibility": "unknown",
            "signal_list": signal_list,
            "signal_contract": "unknown",
            "gdscript_idiom": "unknown",
            "thread_safety": "unknown",
            "performance_note": "unknown",
            "common_node_patterns": "unknown",
            "scene_tree_impact": "unknown",
            "lifecycle_order": "unknown",
            "physics_rendering_boundary": "unknown",
            "legacy_3x_warning": "unknown",
            "hidden_warnings": [error] if error else [],
            "agent_query_hints": [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() == "quarkus":
        if chunk.artifact_kind == "cli_command":
            return {
                "agent_hook": f"Use this Quarkus CLI command chunk for {chunk.symbol_fqn or chunk.document_name}.",
                "perf_tier": "unknown",
                "safety_contract": "Check whether the command is read-only, project-modifying, destructive, build-triggering, or long-running before suggesting execution.",
                "lifecycle_model": "No model-derived CLI lifecycle summary is available; rely on the official command source.",
                "command_intent": "unknown",
                "context_requirement": "unknown",
                "interactive_features": "unknown",
                "associated_extensions": [],
                "common_flags": [],
                "agent_advice": "Prefer Quarkus CLI commands over manual Maven/Gradle edits when they preserve platform BOM alignment.",
                "enrichment_status": "fallback",
                "enrichment_error": error,
                "hidden_warnings": [error] if error else [],
            }
        return {
            "agent_hook": f"Use this Quarkus {chunk.symbol_kind or 'documentation'} chunk for {chunk.package_name or chunk.document_name}.",
            "perf_tier": "unknown",
            "safety_contract": "Validate build-time vs runtime config, reactive blocking boundaries, CDI scope, extension dependency, and native-image constraints against the source text.",
            "lifecycle_model": "No model-derived lifecycle summary is available; rely on the official Quarkus docs/source in this chunk.",
            "build_time_config": [],
            "reactive_flavor": "unknown",
            "native_image_note": "unknown",
            "dev_services": "unknown",
            "extension_dependency": "unknown",
            "cdi_scope": "unknown",
            "event_loop_safety": "unknown",
            "config_phase": "unknown",
            "agent_advice": "",
            "hidden_warnings": [error] if error else [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
    if language.lower() in {"bash", "shell", "sh"}:
        return {
            "agent_hook": f"Use this shell {chunk.symbol_kind or 'pattern'} chunk for {chunk.symbol_fqn or chunk.document_name}; prefer safe quoting, explicit checks, and a shellcheck/shfmt/test feedback loop.",
            "perf_tier": "unknown",
            "safety_contract": "Validate quoting, word splitting, globbing, command substitution, traps, tempfiles, permissions, destructive commands, and ShellCheck diagnostics against the source text.",
            "lifecycle_model": "Shell script execution lifecycle: parse with bash -n, lint with shellcheck, format with shfmt, test with bats or fixture scripts, and clean up resources with traps.",
            "shell_dialect": str(chunk.metadata.get("shell_dialect") or _shell_dialect(chunk.text, chunk.module_path)),
            "portability_scope": "unknown",
            "strict_mode_guidance": "Use strict mode only with understood errexit/nounset/pipefail boundaries; guard expected failures explicitly.",
            "quoting_contract": 'Quote expansions by default, use arrays for multi-word values, and use "$@" for argument forwarding.',
            "error_handling_contract": "Check command exits directly in if/while or with immediate captures; do not mask failures with declare/local assignment.",
            "tempfile_contract": "Use mktemp and trap-based cleanup when temporary paths are needed.",
            "command_safety": str(chunk.metadata.get("command_safety") or "safe"),
            "feedback_loop": ["bash -n", "shellcheck -x", "shfmt -d", "bats"],
            "task_intents": [chunk.artifact_kind] if chunk.artifact_kind else ["shell scripting"],
            "query_aliases": _chunk_identity_terms(chunk),
            "agent_query_hints": ["shellcheck", "safe bash", "quoting", "bash -n", "shfmt"],
            "api_contract": "unknown",
            "version_scope": "unknown",
            "performance_notes": "unknown",
            "canonical_examples": [],
            "anti_patterns": [],
            "verification_hints": ["bash -n script.sh", "shellcheck -x script.sh", "shfmt -d script.sh"],
            "related_interfaces": [],
            "related_symbols": [],
            "agent_actions": ["lint with ShellCheck", "format with shfmt", "run syntax checks", "add fixture tests"],
            "evidence_spans": [],
            "what_to_use": "Safe shell patterns grounded in ShellCheck, shell style guidance, and defensive scripting sources.",
            "when_to_use": "Use for writing, reviewing, or repairing Bash/POSIX shell scripts and developer automation.",
            "do_not_use": "Do not use to justify unquoted expansions, eval, curl-pipe-shell installers, unsafe rm -rf paths, or unchecked cd.",
            "minimal_example": "shellcheck -x script.sh && shfmt -d script.sh && bash -n script.sh",
            "hidden_warnings": [error] if error else [],
            "enrichment_status": "fallback",
            "enrichment_error": error,
        }
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
        provider: str = DEFAULT_ENRICHMENT_PROVIDER,
        api_key: str = "",
        timeout: float = DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
        retry_count: int = 2,
        temperature: float | None = None,
        max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
        prompt_templates: dict[str, str],
        default_prompt_id: str,
        prompt_variable: str = "{{DOC_CHUNK}}",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.provider = _normalize_enrichment_provider(provider)
        self.api_key = _resolve_enrichment_api_key(api_key, provider=self.provider)
        self.timeout = timeout
        self.retry_count = retry_count
        self.temperature = temperature
        requested_max_tokens = int(max_tokens or DEFAULT_ENRICHMENT_MAX_TOKENS)
        if self.provider == "deepseek":
            self.max_tokens = max(DEFAULT_ENRICHMENT_MAX_TOKENS, requested_max_tokens)
        else:
            self.max_tokens = max(1, requested_max_tokens)
        self.prompt_templates = prompt_templates
        self.default_prompt_id = default_prompt_id
        self.prompt_variable = prompt_variable

    def render_prompt(self, chunk: LanguageChunk) -> tuple[str, str]:
        prompt_id = chunk.prompt_id or self.default_prompt_id
        template = self.prompt_templates.get(prompt_id) or self.prompt_templates[self.default_prompt_id]
        prompt = template.replace(self.prompt_variable, chunk.text).replace("{{RAW_GO_DOC_CONTENT}}", chunk.text)
        quality = _source_quality_metadata(chunk)
        if quality:
            prompt = (
                f"{prompt}\n\nSource quality metadata: {json.dumps(quality, sort_keys=True)}\n"
                "If the source appears incomplete or noisy, include that as hidden_warnings or source_quality notes. "
                "Do not repair source text or invent missing facts."
            )
        doc_language = str(chunk.metadata.get("doc_language") or "en")
        prompt = (
            f"{prompt}\n\nSource document language: {doc_language}. "
            "Preserve official terminology, identifiers, APIs, package names, and error strings exactly as written. "
            "Do not translate code identifiers or infer facts from another language edition."
        )
        identity = {k: v for k, v in _chunk_identity_metadata(chunk).items() if v}
        if identity:
            prompt = (
                f"{prompt}\n\nChunk identity metadata: {json.dumps(identity, sort_keys=True)}\n"
                "Use these identifiers as retrieval anchors when they are consistent with the source. "
                "The best enrichment survives searches for exact symbol names, package paths, error codes, "
                "resource names, commands, class members, and common task phrasing."
            )
        prompt = f"{prompt}{SYNPACK_V2_ENRICHMENT_APPEND}"
        return prompt_id, prompt

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self.provider == "deepseek":
            headers["X-DeepSeek-Think-Mode"] = "Max"
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _chat_completions_url(self) -> str:
        if self.base_url.endswith("/chat/completions"):
            return self.base_url
        if self.base_url.endswith("/v1"):
            return f"{self.base_url}/chat/completions"
        return f"{self.base_url}/v1/chat/completions"

    def enrich(self, chunk: LanguageChunk) -> dict[str, Any]:
        prompt_id, prompt = self.render_prompt(chunk)
        payload = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": FRONTIER_ENRICHMENT_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
        }
        if self.provider == "deepseek":
            payload["reasoning_effort"] = "max"
            payload["thinking"] = {"type": "enabled"}
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        last_error = ""
        for _ in range(max(1, self.retry_count + 1)):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    resp = client.post(self._chat_completions_url(), headers=self._headers(), json=payload)
                resp.raise_for_status()
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                parsed = parse_enrichment_response(str(content))
                parsed.setdefault("prompt_id", prompt_id)
                usage = _enrichment_usage_from_response(data)
                if usage:
                    parsed["_enrichment_usage"] = usage
                return parsed
            except Exception as exc:  # deterministic fallback is handled by caller.
                last_error = str(exc)
        raise SynPackError(last_error or "enrichment failed")


def _normalize_enrichment_provider(provider: str = DEFAULT_ENRICHMENT_PROVIDER) -> str:
    normalized = (provider or DEFAULT_ENRICHMENT_PROVIDER).strip().lower().replace("_", "-")
    aliases = {
        "deepseek": "deepseek",
        "openai": "openai-compatible",
        "openai-compatible": "openai-compatible",
        "custom": "openai-compatible",
        "custom-openai": "openai-compatible",
    }
    if normalized not in aliases:
        raise SynPackError(f"unsupported enrichment provider: {provider}")
    return aliases[normalized]


def _resolve_enrichment_api_key(api_key: str = "", *, provider: str = DEFAULT_ENRICHMENT_PROVIDER) -> str:
    explicit = (api_key or "").strip()
    if explicit:
        return explicit
    shared = (
        os.environ.get("SYNESIS_INDEXER_ENRICHMENT_API_KEY") or os.environ.get("SYNESIS_INDEXER_ENRICHMENT_TOKEN") or ""
    ).strip()
    if shared:
        return shared
    if _normalize_enrichment_provider(provider) == "deepseek":
        return (os.environ.get("DEEPSEEK_TOKEN") or os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    return (os.environ.get("OPENAI_API_KEY") or "").strip()


def _effective_enrichment_max_tokens(max_tokens: int, *, provider: str = DEFAULT_ENRICHMENT_PROVIDER) -> int:
    requested_max_tokens = int(max_tokens or DEFAULT_ENRICHMENT_MAX_TOKENS)
    if _normalize_enrichment_provider(provider) == "deepseek":
        return max(DEFAULT_ENRICHMENT_MAX_TOKENS, requested_max_tokens)
    return max(1, requested_max_tokens)


def _enrichment_thinking_metadata(provider: str = DEFAULT_ENRICHMENT_PROVIDER) -> dict[str, Any]:
    if _normalize_enrichment_provider(provider) == "deepseek":
        return {"thinking": {"type": "enabled", "reasoning_effort": "max"}, "think_mode_header": "Max"}
    return {"thinking": {"type": "disabled"}, "think_mode_header": ""}


def _approx_token_count(text: str) -> int:
    return max(1, math.ceil(len(text or "") / 4))


def _enrichment_usage_from_response(data: dict[str, Any]) -> dict[str, int]:
    usage = data.get("usage") if isinstance(data, dict) else {}
    if not isinstance(usage, dict):
        return {}
    prompt_details = usage.get("prompt_tokens_details")
    if not isinstance(prompt_details, dict):
        prompt_details = {}
    cache_hit = usage.get(
        "prompt_cache_hit_tokens", prompt_details.get("cache_hit_tokens", prompt_details.get("cached_tokens", 0))
    )
    cache_miss = usage.get("prompt_cache_miss_tokens", prompt_details.get("cache_miss_tokens", 0))
    fields = {
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
        "prompt_cache_hit_tokens": cache_hit,
        "prompt_cache_miss_tokens": cache_miss,
    }
    out: dict[str, int] = {}
    for key, value in fields.items():
        try:
            out[key] = int(value or 0)
        except (TypeError, ValueError):
            out[key] = 0
    return out


def aggregate_enrichment_usage(enrichments: list[dict[str, Any]]) -> dict[str, int]:
    totals = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "prompt_cache_hit_tokens": 0,
        "prompt_cache_miss_tokens": 0,
    }
    seen = False
    for enrichment in enrichments:
        usage = enrichment.get("_enrichment_usage")
        if not isinstance(usage, dict):
            continue
        seen = True
        for key in totals:
            with contextlib.suppress(TypeError, ValueError):
                totals[key] += int(usage.get(key, 0) or 0)
    return totals if seen else {}


def _percentile(values: list[int], percentile: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, math.ceil((percentile / 100) * len(ordered)) - 1))
    return ordered[idx]


def estimate_enrichment_token_budget(
    chunks: list[LanguageChunk],
    *,
    prompt_templates: dict[str, str],
    default_prompt_id: str,
    prompt_variable: str = "{{DOC_CHUNK}}",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    skip_zero_quality: bool = True,
    max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    thinking_cap_tokens: int = DEFAULT_THINKING_CAP_TOKENS,
    input_price_per_mtok: float = 0.0,
    output_price_per_mtok: float = 0.0,
) -> dict[str, Any]:
    client = OpenAICompatibleEnrichmentClient(
        base_url=enrichment_url or "https://api.deepseek.com",
        model=enrichment_model,
        provider=enrichment_provider,
        max_tokens=max_tokens,
        prompt_templates=prompt_templates,
        default_prompt_id=default_prompt_id,
        prompt_variable=prompt_variable,
    )
    prompt_tokens = 0
    prompt_chars = 0
    chunk_text_chars = 0
    chunk_text_tokens: list[int] = []
    prompt_tokens_per_request: list[int] = []
    chunks_by_artifact_kind: dict[str, int] = {}
    chunks_by_prompt_id: dict[str, int] = {}
    system_tokens = _approx_token_count(FRONTIER_ENRICHMENT_SYSTEM_PROMPT)
    for chunk in chunks:
        skip_reason = _zero_quality_enrichment_skip_reason(chunk) if skip_zero_quality else ""
        if skip_reason:
            artifact_kind = chunk.artifact_kind or "unknown"
            chunks_by_artifact_kind[artifact_kind] = chunks_by_artifact_kind.get(artifact_kind, 0) + 1
            continue
        prompt_id, prompt = client.render_prompt(chunk)
        prompt_token_count = system_tokens + _approx_token_count(prompt)
        chunk_token_count = _approx_token_count(chunk.text)
        prompt_tokens += prompt_token_count
        prompt_chars += len(prompt)
        chunk_text_chars += len(chunk.text)
        prompt_tokens_per_request.append(prompt_token_count)
        chunk_text_tokens.append(chunk_token_count)
        artifact_kind = chunk.artifact_kind or "unknown"
        chunks_by_artifact_kind[artifact_kind] = chunks_by_artifact_kind.get(artifact_kind, 0) + 1
        chunks_by_prompt_id[prompt_id] = chunks_by_prompt_id.get(prompt_id, 0) + 1
    zero_quality_skipped_chunks = len(chunks) - len(prompt_tokens_per_request)
    completion_budget_tokens = len(prompt_tokens_per_request) * client.max_tokens
    thinking_budget_tokens = (
        len(prompt_tokens_per_request) * max(0, int(thinking_cap_tokens or 0)) if client.provider == "deepseek" else 0
    )
    uncached_input_cost = (prompt_tokens / 1_000_000) * max(0.0, input_price_per_mtok)
    output_budget_cost = ((completion_budget_tokens + thinking_budget_tokens) / 1_000_000) * max(
        0.0, output_price_per_mtok
    )
    return {
        "estimator": "chars_div_4_plus_request_budget_v1",
        "scope": "prepared_chunks_after_extraction_and_quality_gate",
        "note": "Completion and thinking values are worst-case request budgets, not predicted usage.",
        "model": enrichment_model,
        "provider": client.provider,
        "chunks": len(chunks),
        "llm_enrichment_chunks": len(prompt_tokens_per_request),
        "zero_quality_skipped_chunks": zero_quality_skipped_chunks,
        "chunks_by_artifact_kind": dict(sorted(chunks_by_artifact_kind.items())),
        "chunks_by_prompt_id": dict(sorted(chunks_by_prompt_id.items())),
        "chunk_text_chars": chunk_text_chars,
        "chunk_text_tokens_estimate": sum(chunk_text_tokens),
        "prompt_chars": prompt_chars,
        "prompt_tokens_estimate": prompt_tokens,
        "prompt_tokens_per_request_min": min(prompt_tokens_per_request) if prompt_tokens_per_request else 0,
        "prompt_tokens_per_request_p50": _percentile(prompt_tokens_per_request, 50),
        "prompt_tokens_per_request_p95": _percentile(prompt_tokens_per_request, 95),
        "prompt_tokens_per_request_max": max(prompt_tokens_per_request) if prompt_tokens_per_request else 0,
        "completion_budget_tokens": completion_budget_tokens,
        "completion_budget_tokens_worst_case": completion_budget_tokens,
        "thinking_budget_tokens": thinking_budget_tokens,
        "thinking_budget_tokens_worst_case": thinking_budget_tokens,
        "worst_case_total_tokens": prompt_tokens + completion_budget_tokens + thinking_budget_tokens,
        "max_tokens_per_request": client.max_tokens,
        "thinking_cap_tokens_per_request": max(0, int(thinking_cap_tokens or 0))
        if client.provider == "deepseek"
        else 0,
        "thinking_effort": "max" if client.provider == "deepseek" else "",
        "thinking_mode": "enabled" if client.provider == "deepseek" else "disabled",
        "cache_strategy": "stable_system_prompt_plus_prompt_template_prefix",
        "uncached_input_price_per_mtok": input_price_per_mtok,
        "output_price_per_mtok": output_price_per_mtok,
        "estimated_uncached_usd": round(uncached_input_cost + output_budget_cost, 6)
        if input_price_per_mtok or output_price_per_mtok
        else None,
    }


def enrich_language_chunks(
    chunks: list[LanguageChunk],
    *,
    prompt_templates: dict[str, str],
    default_prompt_id: str,
    prompt_variable: str = "{{DOC_CHUNK}}",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    enrichment_api_key: str = "",
    concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    retry_count: int = 2,
    temperature: float | None = None,
    max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    timeout: float = DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
    skip: bool = False,
    skip_zero_quality: bool = True,
) -> list[dict[str, Any]]:
    if skip or not enrichment_url:
        return [
            _attach_source_quality(fallback_enrichment(chunk, error="enrichment skipped"), chunk) for chunk in chunks
        ]
    client = OpenAICompatibleEnrichmentClient(
        base_url=enrichment_url,
        model=enrichment_model,
        provider=enrichment_provider,
        api_key=enrichment_api_key,
        timeout=timeout,
        retry_count=retry_count,
        temperature=temperature,
        max_tokens=max_tokens,
        prompt_templates=prompt_templates,
        default_prompt_id=default_prompt_id,
        prompt_variable=prompt_variable,
    )

    def one(chunk: LanguageChunk) -> dict[str, Any]:
        skip_reason = _zero_quality_enrichment_skip_reason(chunk) if skip_zero_quality else ""
        if skip_reason:
            return _attach_source_quality(fallback_enrichment(chunk, error=skip_reason), chunk)
        try:
            return _attach_source_quality(client.enrich(chunk), chunk)
        except Exception as exc:
            return _attach_source_quality(fallback_enrichment(chunk, error=str(exc)), chunk)

    workers = max(1, min(int(concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, chunks))


def _agent_json(enrichment: dict[str, Any]) -> str:
    return json.dumps(enrichment, sort_keys=True, ensure_ascii=False)


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
    chunks: list[LanguageChunk],
    enrichments: list[dict[str, Any]],
    embeddings: list[list[float]],
    *,
    pack_id: str,
    pack_version: str,
    source_version: str,
    language: str,
    domain: str,
    doc_language: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for chunk, enrichment, embedding in zip(chunks, enrichments, embeddings):
        enrichment = dict(enrichment)
        enrichment.setdefault("doc_language", doc_language)
        status, signals = scan_chunk_text_detailed(chunk.text)
        has_code, code_signal_count, code_density = _code_chunk_metrics(chunk.text)
        import_refs = str(chunk.metadata.get("import_refs") or "")
        call_refs = str(chunk.metadata.get("call_refs") or "")
        if has_code:
            import_refs = import_refs or _join_csv([extract_import_refs(chunk.text, language)])
            call_refs = call_refs or _join_csv([extract_call_refs(chunk.text, language)])
        chunk_id = chunk_id_hash(chunk.text, f"{pack_id}:{chunk.doc_id}:{chunk.section}")
        retrieval_terms = _retrieval_terms(chunk, enrichment)
        row = catalog_entity(
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
            tags=_join_csv(
                [f"language-pack,{language}", f"doc-language:{doc_language}", chunk.metadata.get("scope_tags", [])]
            ),
            keywords=_join_csv([[chunk.package_name, chunk.symbol_kind, chunk.symbol_name], retrieval_terms]),
            origin_type="curated",
            authority="vetted",
            pack_id=pack_id,
            pack_version=pack_version,
            pack_source_version=source_version,
            pack_partition=pack_id,
            symbol_kind=chunk.symbol_kind,
            symbol_fqn=chunk.symbol_fqn,
            package_name=chunk.package_name,
            doc_relation_ids=_join_csv([chunk.metadata.get("doc_relation_ids", [])]),
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
            repo_path=str(
                chunk.metadata.get("repo_path")
                or (
                    "golang/go"
                    if language == "go"
                    else "rust-lang/rust"
                    if language == "rust"
                    else "quarkusio/quarkus"
                    if language == "quarkus"
                    else "python/cpython"
                    if language == "python"
                    else "godotengine/godot"
                    if language == "godot"
                    else "tc39/proposals"
                    if language == "ecma"
                    else "koalaman/shellcheck"
                    if language == "bash"
                    else "hashicorp/terraform"
                )
            ),
            module_path=chunk.module_path,
            symbol_name=chunk.symbol_name,
            import_refs=import_refs,
            call_refs=call_refs,
            artifact_kind=chunk.artifact_kind,
            has_code=has_code,
            code_signal_count=code_signal_count,
            code_density=code_density,
            code_language=language if has_code else "",
            corpus_class="coder_enriched",
            constraint_kind=str(chunk.metadata.get("constraint_kind") or ""),
            content_profile=str(chunk.metadata.get("content_profile") or "reference"),
            scope_tags=_join_csv([chunk.metadata.get("scope_tags", [])]),
            constraint_source=str(chunk.metadata.get("constraint_source") or ""),
            constraint_confidence=1.0
            if chunk.metadata.get("constraint_kind") == "hard"
            else 0.85
            if chunk.metadata.get("constraint_kind")
            else -1.0,
            crawl_timestamp=int(time.time() * 1000),
            raw_content_hash=hashlib.sha256(chunk.text.encode()).hexdigest(),
            clean_content_hash=hashlib.sha256(chunk.text.encode()).hexdigest(),
            enrichment_profile=str(
                enrichment.get("prompt_id")
                or chunk.prompt_id
                or (
                    GO_PROMPT_ID
                    if language == "go"
                    else RUST_PROMPT_ID
                    if language == "rust"
                    else QUARKUS_PROMPT_ID
                    if language == "quarkus"
                    else PYTHON_PROMPT_ID
                    if language == "python"
                    else GODOT_PROMPT_ID
                    if language == "godot"
                    else ECMA_PROMPT_ID
                    if language == "ecma"
                    else BASH_PROMPT_ID
                    if language == "bash"
                    else TERRAFORM_PROMPT_ID
                )
            ),
        )
        row["retrieval_terms"] = _join_csv([retrieval_terms])
        row["query_aliases"] = _join_csv([enrichment.get("query_aliases")])
        row["agent_query_hints"] = _join_csv([enrichment.get("agent_query_hints")])
        row["task_intents"] = _join_csv([enrichment.get("task_intents")])
        row["verification_hints"] = _join_csv([enrichment.get("verification_hints")])
        row["related_interfaces"] = _join_csv([enrichment.get("related_interfaces")])
        row["related_symbols"] = _join_csv([enrichment.get("related_symbols")])
        for key in (
            "contains_refs",
            "documents_refs",
            "implements_refs",
            "overrides_refs",
            "valid_in_refs",
            "derived_from_refs",
        ):
            value = _join_csv([chunk.metadata.get(key, [])])
            if value:
                row[key] = value
        rows.append(row)
    return rows


def _default_config_path(language: str) -> Path:
    return _repo_root() / f"base/rag/pack-configs/{language}.yaml"


def _default_repo_for_language(language: str) -> str:
    return (
        "github.com/golang/go"
        if language == "go"
        else "github.com/rust-lang/rust"
        if language == "rust"
        else "github.com/quarkusio/quarkus"
        if language == "quarkus"
        else "github.com/python/cpython"
        if language == "python"
        else "github.com/godotengine/godot"
        if language == "godot"
        else "github.com/tc39/proposals"
        if language == "ecma"
        else "github.com/koalaman/shellcheck"
        if language == "bash"
        else "github.com/hashicorp/terraform"
    )


def _default_prompt_id_for_language(language: str) -> str:
    return (
        GO_PROMPT_ID
        if language == "go"
        else RUST_PROMPT_ID
        if language == "rust"
        else QUARKUS_PROMPT_ID
        if language == "quarkus"
        else PYTHON_PROMPT_ID
        if language == "python"
        else GODOT_PROMPT_ID
        if language == "godot"
        else ECMA_PROMPT_ID
        if language == "ecma"
        else BASH_PROMPT_ID
        if language == "bash"
        else TERRAFORM_PROMPT_ID
    )


def _resolve_language_tag(language: str, *, latest_tag: str, source_version: str) -> str:
    if latest_tag or source_version:
        return latest_tag or source_version
    if language == "go":
        return resolve_latest_go_tag()
    if language == "rust":
        return resolve_latest_rust_tag()
    if language == "quarkus":
        return resolve_latest_quarkus_tag()
    if language == "python":
        return resolve_latest_python_tag()
    if language == "godot":
        return resolve_latest_godot_tag()
    if language == "terraform":
        return resolve_latest_terraform_tag()
    if language == "ecma":
        return resolve_latest_ecma_tag()
    if language == "bash":
        return "main"
    raise SynPackError(f"unsupported language pack: {language}")


def _prompt_specs(config: dict[str, Any]) -> list[dict[str, str]]:
    specs: list[dict[str, str]] = []
    if config.get("prompt_path"):
        specs.append({"id": str(config.get("prompt_id") or "language_pack_v1"), "path": str(config["prompt_path"])})
    for item in config.get("prompts", []):
        if isinstance(item, dict) and item.get("id") and item.get("path"):
            specs.append({"id": str(item["id"]), "path": str(item["path"])})
    if not specs:
        raise SynPackError("language pack config must define prompt_path or prompts")
    dedup: dict[str, str] = {}
    for spec in specs:
        dedup[spec["id"]] = spec["path"]
    return [{"id": k, "path": v} for k, v in dedup.items()]


def _load_prompt_templates(config: dict[str, Any], *, config_path: Path) -> tuple[dict[str, str], dict[str, str]]:
    templates: dict[str, str] = {}
    hashes: dict[str, str] = {}
    for spec in _prompt_specs(config):
        path = _resolve_path(spec["path"], base=config_path.parent)
        content = _read_text(path)
        templates[spec["id"]] = content
        hashes[spec["id"]] = hashlib.sha256(content.encode()).hexdigest()
    return templates, hashes


def _clone_aux_sources(config: dict[str, Any], source_root: Path, sources_lock: dict[str, Any]) -> None:
    include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
    aux_locks: list[dict[str, Any]] = []
    for aux in include.get("aux_sources", []):
        if not isinstance(aux, dict):
            continue
        name = str(aux.get("name") or "")
        repo = str(aux.get("repo") or "")
        if not name or not repo:
            continue
        ref = str(aux.get("ref") or "")
        target = source_root / name
        if target.exists():
            aux_locks.append({"name": name, "repo": repo, "path": str(target), "ref": ref or "local"})
            aux["resolved_ref"] = ref or "local"
            continue
        clone_repo(repo, target, tag=ref)
        commit = subprocess.run(
            ["git", "-C", str(target), "rev-parse", "HEAD"], check=True, text=True, capture_output=True
        ).stdout.strip()
        aux["resolved_ref"] = commit
        aux_locks.append({"name": name, "repo": repo, "path": str(target), "ref": ref, "commit": commit})
    sources_lock["aux_sources"] = aux_locks


LanguageChunkExtractor = Callable[..., list[LanguageChunk]]

LANGUAGE_CHUNK_EXTRACTORS: dict[str, LanguageChunkExtractor] = {
    "go": extract_go_chunks,
    "rust": extract_rust_chunks,
    "python": extract_python_chunks,
    "godot": extract_godot_chunks,
    "terraform": extract_terraform_chunks,
    "ecma": extract_ecma_chunks,
    "bash": extract_bash_chunks,
    "quarkus": extract_quarkus_chunks,
}


def _extract_chunks_for_language(
    language: str,
    source_root: Path,
    *,
    config: dict[str, Any],
    tag: str,
    provider_schema: str | Path = "",
) -> list[LanguageChunk]:
    extractor = LANGUAGE_CHUNK_EXTRACTORS.get(language, LANGUAGE_CHUNK_EXTRACTORS["quarkus"])
    if language == "terraform":
        return extractor(source_root, config=config, tag=tag, provider_schema=provider_schema)
    return extractor(source_root, config=config, tag=tag)


def _language_pack_manifest_base(
    *,
    pack_id: str,
    pack_version: str,
    source_version: str,
    language: str,
    doc_language: str,
    supported_doc_languages: list[str],
    domain: str,
) -> dict[str, Any]:
    return {
        "format": "synpack",
        "format_version": SYNPACK_FORMAT_VERSION,
        "pack_id": pack_id,
        "pack_version": pack_version,
        "version": pack_version,
        "source_version": source_version,
        "language": language,
        "doc_language": doc_language,
        "supported_doc_languages": supported_doc_languages,
        "domain": domain,
        "embedding_model": DEFAULT_PACK_MODEL,
        "embedding_dimensions": EMBEDDING_DIM,
        "embedding_profile": EMBEDDING_PROFILE,
        "corpus_version": CORPUS_VERSION,
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
    }


def _chunk_key(pack_id: str, chunk: LanguageChunk) -> str:
    payload = "|".join([pack_id, chunk.doc_id, str(chunk.chunk_index), chunk.section, chunk.prompt_id, chunk.text])
    return hashlib.sha256(payload.encode()).hexdigest()


def _chunk_record(pack_id: str, chunk: LanguageChunk) -> dict[str, Any]:
    record = asdict(chunk)
    record["chunk_key"] = _chunk_key(pack_id, chunk)
    return record


def _chunk_from_record(record: dict[str, Any]) -> LanguageChunk:
    payload = {key: value for key, value in record.items() if key in LanguageChunk.__dataclass_fields__}
    return LanguageChunk(**payload)


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


def _append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        f.flush()


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


def _completed_enrichment_map(work_dir: Path) -> dict[str, dict[str, Any]]:
    completed: dict[str, dict[str, Any]] = {}
    for record in _read_jsonl(work_dir / "enrichments" / "completed.jsonl"):
        key = str(record.get("chunk_key") or "")
        enrichment = record.get("enrichment")
        if key and isinstance(enrichment, dict):
            completed[key] = enrichment
    return completed


def _write_enrich_state(work_dir: Path, *, total: int, completed: int, failed: int, submitted: int) -> None:
    state = {
        "total_chunks": total,
        "completed_chunks": completed,
        "failed_attempts": failed,
        "submitted_this_run": submitted,
        "updated_at": int(time.time()),
    }
    state_path = work_dir / "checkpoints" / "enrich-state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def prepare_staged_language_pack(
    *,
    language: str,
    work_dir: str | Path,
    pack_config: str | Path = "",
    pack_id: str = "",
    pack_version: str = "1.0.0",
    source_version: str = "",
    latest_tag: str = "",
    enrichment_url: str = "",
    enrichment_model: str = DEFAULT_ENRICHMENT_MODEL,
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    enrichment_api_key: str = "",
    skip_zero_quality: bool = True,
    enrichment_concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    enrichment_max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    enrichment_input_price_per_mtok: float = 0.0,
    enrichment_output_price_per_mtok: float = 0.0,
    max_chunks: int = 0,
    source_dir: str | Path = "",
    provider_schema: str | Path = "",
    doc_language: str = "",
) -> dict[str, Any]:
    language = language.lower().strip()
    if language not in SUPPORTED_LANGUAGE_PACKS:
        raise SynPackError(f"unsupported language pack: {language}")
    enrichment_provider = _normalize_enrichment_provider(enrichment_provider)
    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)
    config_path = Path(pack_config) if pack_config else _default_config_path(language)
    config = _load_yaml(config_path)
    pack_id = _sanitize_pack_id(pack_id or str(config.get("pack_id") or f"{language}-latest"))
    doc_language = _normalize_doc_language(doc_language or str(config.get("doc_language") or "en"))
    supported_doc_languages = _supported_doc_languages(config)
    _validate_doc_language(doc_language=doc_language, supported_doc_languages=supported_doc_languages, pack_id=pack_id)
    resolved_tag = _resolve_language_tag(language, latest_tag=latest_tag, source_version=source_version)
    source_version = resolved_tag
    source_root = Path(source_dir) if source_dir else work / "sources" / language
    if not source_dir and not source_root.exists():
        if language == "go":
            clone_go_source(resolved_tag, source_root)
        else:
            clone_repo(str(config.get("repo") or _default_repo_for_language(language)), source_root, tag=resolved_tag)
    sources_lock = {
        "repo": config.get("repo", _default_repo_for_language(language)),
        "tag": resolved_tag,
        "source_dir": str(source_root),
    }
    if language in AUX_SOURCE_LANGUAGES and not source_dir:
        _clone_aux_sources(config, source_root, sources_lock)
    elif language in AUX_SOURCE_LANGUAGES:
        include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
        sources_lock["aux_sources"] = [
            {
                "name": str(aux.get("name") or ""),
                "repo": str(aux.get("repo") or ""),
                "path": str(source_root / str(aux.get("name") or "")),
                "ref": "local",
            }
            for aux in include.get("aux_sources", [])
            if isinstance(aux, dict)
        ]
    chunks = _extract_chunks_for_language(
        language, source_root, config=config, tag=resolved_tag, provider_schema=provider_schema
    )
    if max_chunks:
        chunks = chunks[: max(0, max_chunks)]
    chunks, source_quality_report = prepare_language_chunks_for_enrichment(chunks)
    for chunk in chunks:
        chunk.metadata["doc_language"] = doc_language
    source_quality_report["doc_language"] = doc_language
    prompt_templates, prompt_hashes = _load_prompt_templates(config, config_path=config_path)
    default_prompt_id = str(config.get("prompt_id") or _default_prompt_id_for_language(language))
    prompt_variable = str(
        config.get("prompt_variable") or ("{{RAW_GO_DOC_CONTENT}}" if language == "go" else "{{DOC_CHUNK}}")
    )
    enrichment_cost_estimate = estimate_enrichment_token_budget(
        chunks,
        prompt_templates=prompt_templates,
        default_prompt_id=default_prompt_id,
        prompt_variable=prompt_variable,
        enrichment_url=enrichment_url,
        enrichment_model=enrichment_model,
        enrichment_provider=enrichment_provider,
        skip_zero_quality=skip_zero_quality,
        max_tokens=enrichment_max_tokens,
        thinking_cap_tokens=DEFAULT_THINKING_CAP_TOKENS,
        input_price_per_mtok=enrichment_input_price_per_mtok,
        output_price_per_mtok=enrichment_output_price_per_mtok,
    )
    source_quality_report["enrichment_cost_estimate"] = enrichment_cost_estimate
    thinking_metadata = _enrichment_thinking_metadata(enrichment_provider)
    chunk_records = [_chunk_record(pack_id, chunk) for chunk in chunks]
    chunks_path = work / "chunks.jsonl"
    chunks_path.write_text("", encoding="utf-8")
    for record in chunk_records:
        _append_jsonl(chunks_path, record)
    sources_lock["row_count"] = len(chunks)
    sources_lock_path = work / "sources.lock.json"
    sources_lock_path.write_text(json.dumps(sources_lock, indent=2, sort_keys=True), encoding="utf-8")
    run_manifest = {
        **_language_pack_manifest_base(
            pack_id=pack_id,
            pack_version=pack_version,
            source_version=source_version,
            language=language,
            doc_language=doc_language,
            supported_doc_languages=supported_doc_languages,
            domain=str(config.get("domain") or language),
        ),
        "staged": True,
        "pack_config": str(config_path),
        "prompt_variable": prompt_variable,
        "enrichment": {
            "model": enrichment_model,
            "provider": enrichment_provider,
            "prompt_id": default_prompt_id,
            "prompt_sha256": prompt_hashes.get(default_prompt_id, ""),
            "prompt_hashes": prompt_hashes,
            "url_configured": bool(enrichment_url),
            "api_key_configured": bool(_resolve_enrichment_api_key(enrichment_api_key, provider=enrichment_provider)),
            "skip_zero_quality": bool(skip_zero_quality),
            "skipped": False,
            "max_tokens": _effective_enrichment_max_tokens(enrichment_max_tokens, provider=enrichment_provider),
            "concurrency": max(
                1, min(int(enrichment_concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY)
            ),
            **thinking_metadata,
            "doc_language": doc_language,
            "supported_doc_languages": supported_doc_languages,
            "cost_estimate": enrichment_cost_estimate,
        },
        "source_quality": source_quality_report,
        "created_at": int(time.time()),
        "row_count": len(chunks),
        "chunks_sha256": hashlib.sha256(chunks_path.read_bytes()).hexdigest(),
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
        "cost_estimate": enrichment_cost_estimate,
    }


def enrich_staged_language_pack(
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
    skip_zero_quality: bool | None = None,
) -> dict[str, Any]:
    work = Path(work_dir)
    manifest_path = work / "run_manifest.json"
    chunks_path = work / "chunks.jsonl"
    if not manifest_path.exists() or not chunks_path.exists():
        raise SynPackError("staged work_dir must contain run_manifest.json and chunks.jsonl")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    prompt_hashes = manifest["enrichment"]["prompt_hashes"]
    prompt_templates = {
        prompt_id: (_repo_root() / "base/rag/pack-configs/prompts" / f"{prompt_id}.md").read_text(encoding="utf-8")
        for prompt_id in prompt_hashes
    }
    default_prompt_id = str(manifest["enrichment"]["prompt_id"])
    prompt_variable = str(manifest.get("prompt_variable") or "{{DOC_CHUNK}}")
    model = enrichment_model or str(manifest["enrichment"]["model"] or DEFAULT_ENRICHMENT_MODEL)
    provider = _normalize_enrichment_provider(enrichment_provider or str(manifest["enrichment"].get("provider") or ""))
    if skip_zero_quality is None:
        skip_zero_quality = bool(manifest["enrichment"].get("skip_zero_quality", True))
    url = enrichment_url or ""
    records = _read_jsonl(chunks_path)
    completed = _completed_enrichment_map(work)
    pending = [record for record in records if str(record.get("chunk_key") or "") not in completed]
    limit = max(0, int(request_limit or 0))
    if limit:
        pending = pending[:limit]
    if skip_enrichment or not url:
        submitted = 0
        for record in pending:
            chunk = _chunk_from_record(record)
            enrichment = _attach_source_quality(fallback_enrichment(chunk, error="enrichment skipped"), chunk)
            _append_jsonl(
                work / "enrichments" / "completed.jsonl",
                {
                    "chunk_key": record["chunk_key"],
                    "chunk_index": chunk.chunk_index,
                    "enrichment": enrichment,
                    "completed_at": int(time.time()),
                    "skipped": True,
                },
            )
            submitted += 1
        completed_after = len(_completed_enrichment_map(work))
        _write_enrich_state(work, total=len(records), completed=completed_after, failed=0, submitted=submitted)
        return {
            "ok": True,
            "phase": "enrich",
            "work_dir": str(work),
            "submitted": submitted,
            "completed": completed_after,
            "remaining": max(0, len(records) - completed_after),
        }
    client = OpenAICompatibleEnrichmentClient(
        base_url=url,
        model=model,
        provider=provider,
        api_key=enrichment_api_key,
        timeout=enrichment_timeout,
        max_tokens=enrichment_max_tokens,
        prompt_templates=prompt_templates,
        default_prompt_id=default_prompt_id,
        prompt_variable=prompt_variable,
    )
    submitted = 0
    failed = 0
    workers = max(1, min(int(enrichment_concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY))
    batch = pending[: max(1, int(batch_size or 1))]

    def one(record: dict[str, Any]) -> dict[str, Any]:
        chunk = _chunk_from_record(record)
        skip_reason = _zero_quality_enrichment_skip_reason(chunk) if skip_zero_quality else ""
        if skip_reason:
            enrichment = _attach_source_quality(fallback_enrichment(chunk, error=skip_reason), chunk)
            return {
                "chunk_key": record["chunk_key"],
                "chunk_index": chunk.chunk_index,
                "enrichment": enrichment,
                "completed_at": int(time.time()),
                "model": "",
                "skipped": True,
                "skip_reason": "zero_quality_source",
            }
        enrichment = _attach_source_quality(client.enrich(chunk), chunk)
        return {
            "chunk_key": record["chunk_key"],
            "chunk_index": chunk.chunk_index,
            "enrichment": enrichment,
            "completed_at": int(time.time()),
            "model": model,
        }

    while batch:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            future_map = {pool.submit(one, record): record for record in batch}
            for future in concurrent.futures.as_completed(future_map):
                record = future_map[future]
                submitted += 1
                try:
                    _append_jsonl(work / "enrichments" / "completed.jsonl", future.result())
                except Exception as exc:
                    failed += 1
                    _append_jsonl(
                        work / "enrichments" / "failed.jsonl",
                        {
                            "chunk_key": record.get("chunk_key"),
                            "chunk_index": record.get("chunk_index"),
                            "error": str(exc),
                            "failed_at": int(time.time()),
                            "model": model,
                        },
                    )
                completed_now = len(_completed_enrichment_map(work))
                _write_enrich_state(
                    work, total=len(records), completed=completed_now, failed=failed, submitted=submitted
                )
        if limit and submitted >= limit:
            break
        start = submitted
        end = submitted + max(1, int(batch_size or 1))
        batch = pending[start:end]
    completed_after = len(_completed_enrichment_map(work))
    return {
        "ok": True,
        "phase": "enrich",
        "work_dir": str(work),
        "submitted": submitted,
        "failed": failed,
        "completed": completed_after,
        "remaining": max(0, len(records) - completed_after),
    }


def finalize_staged_language_pack(
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
    missing = [
        str(record.get("chunk_key") or "") for record in records if str(record.get("chunk_key") or "") not in completed
    ]
    if missing:
        raise SynPackError(f"cannot finalize staged pack; missing {len(missing)} enrichments")
    chunks = [_chunk_from_record(record) for record in records]
    enrichments = [completed[str(record["chunk_key"])] for record in records]
    enrichment_usage = aggregate_enrichment_usage(enrichments)
    embedder_kwargs: dict[str, Any] = {
        "batch_size": max(1, int(embedder_batch_size or 1)),
        "timeout": max(1.0, float(embedder_timeout or 1.0)),
    }
    if embedder_url:
        embedder_kwargs["url"] = embedder_url
    embedder = EmbedClient(**embedder_kwargs)
    embed_inputs = [_embedding_input(chunk, enrichment) for chunk, enrichment in zip(chunks, enrichments)]
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
        pack_id=str(manifest["pack_id"]),
        pack_version=str(manifest["pack_version"]),
        source_version=str(manifest["source_version"]),
        language=str(manifest["language"]),
        domain=str(manifest["domain"]),
        doc_language=str(manifest["doc_language"]),
    )
    final_dir = work / "final"
    final_dir.mkdir(parents=True, exist_ok=True)
    rows_path = final_dir / "metadata.jsonl"
    with rows_path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    edges_path = final_dir / "edges.jsonl"
    edges = derive_graph_edges(rows, include_structural_edges=True)
    with edges_path.open("w", encoding="utf-8") as f:
        for edge in edges:
            f.write(json.dumps(edge, ensure_ascii=False, sort_keys=True) + "\n")
    sources_lock_path = work / "sources.lock.json"
    final_sources_lock_path = final_dir / "sources.lock.json"
    shutil.copyfile(sources_lock_path, final_sources_lock_path)
    final_manifest = {
        **{key: value for key, value in manifest.items() if key not in {"staged", "pack_config", "prompt_variable"}},
        "enrichment": {**manifest["enrichment"], "usage": enrichment_usage, "skipped": False},
        "created_at": int(time.time()),
        "row_count": len(rows),
        "node_count": len(rows),
        "edge_count": len(edges),
        "requires_bulk_import": len(rows) >= 1000,
        "install_profile": "nornicdb-v2-typed-graph",
        "content_type": "developer",
        "trust_score": 1.0,
        "freshness_score": 1.0,
        "sources_lock_sha256": _sha256_file(final_sources_lock_path),
        "metadata_sha256": _sha256_file(rows_path),
        "edges_sha256": _sha256_file(edges_path),
    }
    quality_report = materialize_synpack_v2(rows, edges, final_manifest, final_dir)
    final_manifest.update(
        {
            "node_count": quality_report["node_count"],
            "chunk_count": quality_report["chunk_count"],
            "edge_count": quality_report["edge_count"],
            "node_counts_by_kind": quality_report["node_counts_by_kind"],
            "edge_counts_by_type": quality_report["edge_counts_by_type"],
            "example_count": quality_report.get("example_count", 0),
            "context_card_count": quality_report.get("context_card_count", 0),
            "pack_card_count": quality_report.get("pack_card_count", 0),
            "anti_pattern_count": quality_report.get("anti_pattern_count", 0),
            "dangling_edge_count": quality_report["dangling_edge_count"],
            "external_ref_count": quality_report["external_ref_count"],
            "quality_report_sha256": _sha256_file(final_dir / "quality" / "report.json"),
        }
    )
    manifest_path = final_dir / "manifest.json"
    manifest_path.write_text(json.dumps(final_manifest, indent=2, sort_keys=True), encoding="utf-8")
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
    enrichment_provider: str = DEFAULT_ENRICHMENT_PROVIDER,
    enrichment_api_key: str = "",
    skip_zero_quality: bool = True,
    enrichment_concurrency: int = DEFAULT_ENRICHMENT_CONCURRENCY,
    enrichment_max_tokens: int = DEFAULT_ENRICHMENT_MAX_TOKENS,
    enrichment_timeout: float = DEFAULT_ENRICHMENT_TIMEOUT_SECONDS,
    enrichment_input_price_per_mtok: float = 0.0,
    enrichment_output_price_per_mtok: float = 0.0,
    estimate_cost_only: bool = False,
    skip_enrichment: bool = False,
    embedder_url: str = "",
    embedder_batch_size: int = DEFAULT_EMBEDDER_BATCH_SIZE,
    embedder_timeout: float = DEFAULT_EMBEDDER_TIMEOUT_SECONDS,
    max_chunks: int = 0,
    source_dir: str | Path = "",
    provider_schema: str | Path = "",
    doc_language: str = "",
) -> dict[str, Any]:
    language = language.lower().strip()
    if language not in SUPPORTED_LANGUAGE_PACKS:
        raise SynPackError(f"unsupported language pack: {language}")
    enrichment_provider = _normalize_enrichment_provider(enrichment_provider)
    config_path = Path(pack_config) if pack_config else _default_config_path(language)
    config = _load_yaml(config_path)
    pack_id = _sanitize_pack_id(pack_id or str(config.get("pack_id") or f"{language}-latest"))
    doc_language = _normalize_doc_language(doc_language or str(config.get("doc_language") or "en"))
    supported_doc_languages = _supported_doc_languages(config)
    _validate_doc_language(doc_language=doc_language, supported_doc_languages=supported_doc_languages, pack_id=pack_id)
    resolved_tag = _resolve_language_tag(language, latest_tag=latest_tag, source_version=source_version)
    source_version = resolved_tag
    tmp = Path(tempfile.mkdtemp(prefix="synpack-language-"))
    try:
        source_root = Path(source_dir) if source_dir else tmp / language
        if not source_dir:
            if language == "go":
                clone_go_source(resolved_tag, source_root)
            else:
                clone_repo(
                    str(
                        config.get("repo")
                        or (
                            "github.com/rust-lang/rust"
                            if language == "rust"
                            else "github.com/quarkusio/quarkus"
                            if language == "quarkus"
                            else "github.com/python/cpython"
                            if language == "python"
                            else "github.com/godotengine/godot"
                            if language == "godot"
                            else "github.com/tc39/proposals"
                            if language == "ecma"
                            else "github.com/koalaman/shellcheck"
                            if language == "bash"
                            else "github.com/hashicorp/terraform"
                        )
                    ),
                    source_root,
                    tag=resolved_tag,
                )
        sources_lock = {
            "repo": config.get(
                "repo",
                f"github.com/{'golang/go' if language == 'go' else 'rust-lang/rust' if language == 'rust' else 'quarkusio/quarkus' if language == 'quarkus' else 'python/cpython' if language == 'python' else 'godotengine/godot' if language == 'godot' else 'tc39/proposals' if language == 'ecma' else 'koalaman/shellcheck' if language == 'bash' else 'hashicorp/terraform'}",
            ),
            "tag": resolved_tag,
            "source_dir": str(source_root),
        }
        if language in AUX_SOURCE_LANGUAGES and not source_dir:
            _clone_aux_sources(config, source_root, sources_lock)
        elif language in AUX_SOURCE_LANGUAGES:
            include = config.get("include", {}) if isinstance(config.get("include"), dict) else {}
            sources_lock["aux_sources"] = [
                {
                    "name": str(aux.get("name") or ""),
                    "repo": str(aux.get("repo") or ""),
                    "path": str(source_root / str(aux.get("name") or "")),
                    "ref": "local",
                }
                for aux in include.get("aux_sources", [])
                if isinstance(aux, dict)
            ]
        if language == "go":
            chunks = extract_go_chunks(source_root, config=config, tag=resolved_tag)
        elif language == "rust":
            chunks = extract_rust_chunks(source_root, config=config, tag=resolved_tag)
        elif language == "python":
            chunks = extract_python_chunks(source_root, config=config, tag=resolved_tag)
        elif language == "godot":
            chunks = extract_godot_chunks(source_root, config=config, tag=resolved_tag)
        elif language == "terraform":
            chunks = extract_terraform_chunks(
                source_root, config=config, tag=resolved_tag, provider_schema=provider_schema
            )
        elif language == "ecma":
            chunks = extract_ecma_chunks(source_root, config=config, tag=resolved_tag)
        elif language == "bash":
            chunks = extract_bash_chunks(source_root, config=config, tag=resolved_tag)
        else:
            chunks = extract_quarkus_chunks(source_root, config=config, tag=resolved_tag)
        if max_chunks:
            chunks = chunks[: max(0, max_chunks)]
        chunks, source_quality_report = prepare_language_chunks_for_enrichment(chunks)
        for chunk in chunks:
            chunk.metadata["doc_language"] = doc_language
        source_quality_report["doc_language"] = doc_language

        prompt_templates, prompt_hashes = _load_prompt_templates(config, config_path=config_path)
        default_prompt_id = str(
            config.get("prompt_id")
            or (
                GO_PROMPT_ID
                if language == "go"
                else RUST_PROMPT_ID
                if language == "rust"
                else QUARKUS_PROMPT_ID
                if language == "quarkus"
                else PYTHON_PROMPT_ID
                if language == "python"
                else GODOT_PROMPT_ID
                if language == "godot"
                else ECMA_PROMPT_ID
                if language == "ecma"
                else BASH_PROMPT_ID
                if language == "bash"
                else TERRAFORM_PROMPT_ID
            )
        )
        prompt_variable = str(
            config.get("prompt_variable") or ("{{RAW_GO_DOC_CONTENT}}" if language == "go" else "{{DOC_CHUNK}}")
        )
        enrichment_cost_estimate = estimate_enrichment_token_budget(
            chunks,
            prompt_templates=prompt_templates,
            default_prompt_id=default_prompt_id,
            prompt_variable=prompt_variable,
            enrichment_url=enrichment_url,
            enrichment_model=enrichment_model,
            enrichment_provider=enrichment_provider,
            skip_zero_quality=skip_zero_quality,
            max_tokens=enrichment_max_tokens,
            thinking_cap_tokens=DEFAULT_THINKING_CAP_TOKENS,
            input_price_per_mtok=enrichment_input_price_per_mtok,
            output_price_per_mtok=enrichment_output_price_per_mtok,
        )
        source_quality_report["enrichment_cost_estimate"] = enrichment_cost_estimate
        thinking_metadata = _enrichment_thinking_metadata(enrichment_provider)
        if estimate_cost_only:
            return {
                "ok": True,
                "estimate_only": True,
                "language": language,
                "pack_id": pack_id,
                "source_version": source_version,
                "source_quality": source_quality_report,
                "enrichment": {
                    "model": enrichment_model,
                    "provider": enrichment_provider,
                    "prompt_id": default_prompt_id,
                    "prompt_sha256": prompt_hashes.get(default_prompt_id, ""),
                    "prompt_hashes": prompt_hashes,
                    "url_configured": bool(enrichment_url),
                    "api_key_configured": bool(
                        _resolve_enrichment_api_key(enrichment_api_key, provider=enrichment_provider)
                    ),
                    "skip_zero_quality": bool(skip_zero_quality),
                    "max_tokens": _effective_enrichment_max_tokens(enrichment_max_tokens, provider=enrichment_provider),
                    "concurrency": max(
                        1,
                        min(int(enrichment_concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY),
                    ),
                    **thinking_metadata,
                    "doc_language": doc_language,
                    "supported_doc_languages": supported_doc_languages,
                    "cost_estimate": enrichment_cost_estimate,
                },
            }
        enrichments = enrich_language_chunks(
            chunks,
            prompt_templates=prompt_templates,
            default_prompt_id=default_prompt_id,
            prompt_variable=prompt_variable,
            enrichment_url=enrichment_url,
            enrichment_model=enrichment_model,
            enrichment_provider=enrichment_provider,
            enrichment_api_key=enrichment_api_key,
            concurrency=enrichment_concurrency,
            max_tokens=enrichment_max_tokens,
            timeout=enrichment_timeout,
            skip=skip_enrichment,
            skip_zero_quality=skip_zero_quality,
        )
        enrichment_usage = aggregate_enrichment_usage(enrichments)
        source_quality_report["fallback_enriched"] = sum(
            1 for enrichment in enrichments if enrichment.get("enrichment_status") == "fallback"
        )
        embedder_kwargs: dict[str, Any] = {
            "batch_size": max(1, int(embedder_batch_size or 1)),
            "timeout": max(1.0, float(embedder_timeout or 1.0)),
        }
        if embedder_url:
            embedder_kwargs["url"] = embedder_url
        embedder = EmbedClient(**embedder_kwargs)
        embed_inputs = [_embedding_input(chunk, enrichment) for chunk, enrichment in zip(chunks, enrichments)]
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
            doc_language=doc_language,
        )

        rows_path = tmp / "metadata.jsonl"
        with rows_path.open("w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        edges_path = tmp / "edges.jsonl"
        edges = derive_graph_edges(rows, include_structural_edges=True)
        with edges_path.open("w", encoding="utf-8") as f:
            for edge in edges:
                f.write(json.dumps(edge, ensure_ascii=False, sort_keys=True) + "\n")

        sources_lock["row_count"] = len(rows)
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
            "doc_language": doc_language,
            "supported_doc_languages": supported_doc_languages,
            "domain": str(config.get("domain") or language),
            "content_type": str(config.get("content_type") or "developer"),
            "trust_score": float(config.get("trust_score", 1.0) or 1.0),
            "freshness_score": float(config.get("freshness_score", 1.0) or 1.0),
            "embedding_model": DEFAULT_PACK_MODEL,
            "embedding_dimensions": EMBEDDING_DIM,
            "embedding_profile": EMBEDDING_PROFILE,
            "corpus_version": CORPUS_VERSION,
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
                "retrieval_terms",
                "query_aliases",
                "task_intents",
                "import_refs",
                "call_refs",
            ],
            "enrichment": {
                "model": enrichment_model if enrichment_url and not skip_enrichment else "",
                "provider": enrichment_provider,
                "prompt_id": default_prompt_id,
                "prompt_sha256": prompt_hashes.get(default_prompt_id, ""),
                "prompt_hashes": prompt_hashes,
                "url_configured": bool(enrichment_url),
                "api_key_configured": bool(
                    _resolve_enrichment_api_key(enrichment_api_key, provider=enrichment_provider)
                ),
                "skip_zero_quality": bool(skip_zero_quality),
                "skipped": bool(skip_enrichment or not enrichment_url),
                "max_tokens": _effective_enrichment_max_tokens(enrichment_max_tokens, provider=enrichment_provider),
                "concurrency": max(
                    1, min(int(enrichment_concurrency or DEFAULT_ENRICHMENT_CONCURRENCY), MAX_ENRICHMENT_CONCURRENCY)
                ),
                **thinking_metadata,
                "doc_language": doc_language,
                "supported_doc_languages": supported_doc_languages,
                "cost_estimate": enrichment_cost_estimate,
                "usage": enrichment_usage,
            },
            "source_quality": source_quality_report,
            "created_at": int(time.time()),
            "row_count": len(rows),
            "node_count": len(rows),
            "edge_count": len(edges),
            "requires_bulk_import": len(rows) >= 1000,
            "install_profile": "nornicdb-v2-typed-graph",
            "sources_lock_sha256": _sha256_file(sources_lock_path),
            "metadata_sha256": _sha256_file(rows_path),
            "edges_sha256": _sha256_file(edges_path),
        }
        quality_report = materialize_synpack_v2(rows, edges, manifest, tmp)
        manifest.update(
            {
                "node_count": quality_report["node_count"],
                "chunk_count": quality_report["chunk_count"],
                "edge_count": quality_report["edge_count"],
                "node_counts_by_kind": quality_report["node_counts_by_kind"],
                "edge_counts_by_type": quality_report["edge_counts_by_type"],
                "example_count": quality_report.get("example_count", 0),
                "context_card_count": quality_report.get("context_card_count", 0),
                "pack_card_count": quality_report.get("pack_card_count", 0),
                "anti_pattern_count": quality_report.get("anti_pattern_count", 0),
                "dangling_edge_count": quality_report["dangling_edge_count"],
                "external_ref_count": quality_report["external_ref_count"],
                "quality_report_sha256": _sha256_file(tmp / "quality" / "report.json"),
            }
        )
        manifest_path = tmp / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            _write_synpack_archive_payload(zf, tmp)
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
