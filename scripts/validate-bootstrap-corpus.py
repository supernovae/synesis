#!/usr/bin/env python3
"""Validate bootstrap corpus YAML annotations for ingestion quality.

Usage:
  python3 scripts/validate-bootstrap-corpus.py
  python3 scripts/validate-bootstrap-corpus.py --strict
  python3 scripts/validate-bootstrap-corpus.py bootstrap/corpus/cloud.yaml
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CORPUS_DIR = REPO_ROOT / "bootstrap" / "corpus"

VALID_ORIGIN = {"curated", "official", "community", "generated"}
VALID_AUTHORITY = {"canonical", "vetted", "community", "untrusted"}
VALID_CORPUS_CLASS = {"coder_enriched", "general", "hybrid"}
VALID_CONTENT_PROFILE = {
    "code", "docs", "api_spec", "policy", "architecture", "mixed",
    "reference", "conceptual", "procedural", "troubleshooting",
}
VALID_ARTIFACT_KIND = {
    "code", "docs", "config", "api_spec", "architecture",
    "tutorial", "blog", "specification", "runbook", "changelog",
}
VALID_CONSTRAINT_KIND = {"hard", "guiding", "advisory"}

# Initial top-10 target set from the blueprint.
TOP10_LANGS = {
    "typescript",
    "javascript",
    "python",
    "go",
    "terraform",
    "java",
    "sql",
    "c#",
    "c_sharp",
    "csharp",
    "rust",
    "bash",
    "yaml",
    "kubernetes",
}

REQUIRED_FIELDS = {
    "title",
    "handler",
    "uri",
    "origin_type",
    "authority",
    "domain",
    "content_profile",
    "languages",
    "artifact_kind",
    "freshness_sla_days",
    "scope_tags",
    "corpus_class",
}


@dataclass
class ValidationResult:
    errors: int = 0
    warnings: int = 0

    def add_error(self, msg: str) -> None:
        self.errors += 1
        print(f"ERROR: {msg}")

    def add_warning(self, msg: str) -> None:
        self.warnings += 1
        print(f"WARN:  {msg}")


def _validate_item(item: dict[str, Any], src: str, idx: int, result: ValidationResult, strict: bool) -> None:
    ident = f"{src} item[{idx}]"
    missing = [f for f in REQUIRED_FIELDS if f not in item]
    for field in missing:
        result.add_warning(f"{ident}: missing recommended field '{field}'")

    origin = str(item.get("origin_type") or "").strip().lower()
    if origin and origin not in VALID_ORIGIN:
        result.add_error(f"{ident}: invalid origin_type='{origin}'")

    authority = str(item.get("authority") or "").strip().lower()
    if authority and authority not in VALID_AUTHORITY:
        result.add_error(f"{ident}: invalid authority='{authority}'")

    corpus_class = str(item.get("corpus_class") or "").strip().lower()
    if corpus_class and corpus_class not in VALID_CORPUS_CLASS:
        result.add_error(f"{ident}: invalid corpus_class='{corpus_class}'")

    content_profile = str(item.get("content_profile") or "").strip().lower()
    if content_profile and content_profile not in VALID_CONTENT_PROFILE:
        result.add_error(f"{ident}: invalid content_profile='{content_profile}'")

    artifact_kind = str(item.get("artifact_kind") or "").strip().lower()
    if artifact_kind and artifact_kind not in VALID_ARTIFACT_KIND:
        result.add_error(f"{ident}: invalid artifact_kind='{artifact_kind}'")

    if "freshness_sla_days" in item:
        try:
            if int(item["freshness_sla_days"]) < 1:
                result.add_error(f"{ident}: freshness_sla_days must be >= 1")
        except Exception:
            result.add_error(f"{ident}: freshness_sla_days must be an integer")

    languages = item.get("languages")
    if languages is not None and not isinstance(languages, list):
        result.add_error(f"{ident}: languages must be a list")
    if isinstance(languages, list):
        if not languages:
            result.add_warning(f"{ident}: empty languages list")
        for raw in languages:
            lang = str(raw).strip().lower()
            if not lang:
                result.add_warning(f"{ident}: blank language entry")
                continue
            if lang not in TOP10_LANGS and strict:
                result.add_warning(f"{ident}: language '{lang}' is outside current top-10 set")

    scope_tags = item.get("scope_tags")
    if scope_tags is not None and not isinstance(scope_tags, list):
        result.add_error(f"{ident}: scope_tags must be a list")

    constraint_kind = str(item.get("constraint_kind") or "").strip().lower()
    if constraint_kind and constraint_kind not in VALID_CONSTRAINT_KIND:
        result.add_error(f"{ident}: invalid constraint_kind='{constraint_kind}'")

    # Coder-enriched corpus should carry stronger metadata.
    if corpus_class == "coder_enriched":
        for required in ("languages", "artifact_kind", "content_profile"):
            if required not in item:
                result.add_warning(f"{ident}: coder_enriched source missing '{required}'")
        if authority and authority not in {"canonical", "vetted"}:
            result.add_warning(f"{ident}: coder_enriched source uses low authority='{authority}'")

    # Backstage/Developer Hub references are optional but recommended for platform sources.
    if "backstage" in str(item.get("uri", "")).lower() or "developer" in str(item.get("title", "")).lower():
        if not str(item.get("backstage_entity_ref") or "").strip():
            result.add_warning(f"{ident}: missing backstage_entity_ref for likely platform source")


def _validate_file(path: Path, result: ValidationResult, strict: bool) -> None:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        result.add_error(f"{path}: failed to parse YAML ({exc})")
        return

    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        result.add_error(f"{path}: expected top-level 'items' list")
        return

    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            result.add_error(f"{path} item[{idx}]: expected mapping object")
            continue
        _validate_item(item, str(path), idx, result, strict)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate bootstrap corpus annotations.")
    parser.add_argument("files", nargs="*", help="Specific YAML files (defaults to bootstrap/corpus/*.yaml)")
    parser.add_argument("--strict", action="store_true", help="Warn on languages outside current top-10 set")
    args = parser.parse_args()

    if args.files:
        files = [Path(f) for f in args.files]
    else:
        files = sorted(DEFAULT_CORPUS_DIR.glob("*.yaml"))

    if not files:
        print("No corpus YAML files found.")
        return 0

    result = ValidationResult()
    for path in files:
        if not path.exists():
            result.add_error(f"{path}: file not found")
            continue
        _validate_file(path, result, strict=args.strict)

    print(f"\nValidation complete: {result.errors} error(s), {result.warnings} warning(s)")
    return 1 if result.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
