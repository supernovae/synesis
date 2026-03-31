#!/usr/bin/env python3
"""Annotate bootstrap corpus YAML files with missing metadata fields.

Adds corpus_class, languages, artifact_kind, content_profile,
freshness_sla_days, scope_tags, and constraint_kind using deterministic
heuristics derived from existing item fields (domain, handler, tags, URI).

Usage:
  python3 scripts/annotate-bootstrap-corpus.py --dry-run
  python3 scripts/annotate-bootstrap-corpus.py
  python3 scripts/annotate-bootstrap-corpus.py bootstrap/corpus/code.yaml
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CORPUS_DIR = REPO_ROOT / "bootstrap" / "corpus"

# ---------------------------------------------------------------------------
# Domain -> corpus_class heuristics
# ---------------------------------------------------------------------------

_CODER_DOMAINS = {
    "python", "javascript", "typescript", "go", "golang", "rust", "java",
    "csharp", "c_sharp", "kotlin", "swift", "ruby", "php", "cpp", "c",
    "terraform", "sql", "bash", "shell", "perl", "scala", "haskell",
    "elixir", "dart", "lua", "r", "zig", "nim", "ocaml", "clojure",
}

_HYBRID_DOMAINS = {
    "kubernetes", "openshift", "cloud", "devops", "databases", "secops",
    "architecture", "software_architecture", "networking", "observability",
    "generalist",
}

_GENERAL_DOMAINS = {
    "health", "music", "taxes_personal", "outdoors", "cooking", "career",
    "consumer_protection", "personal_finance", "fitness", "travel",
}

_CODER_HANDLERS = {"github_code", "openapi_spec", "github_markdown", "license_spdx"}

# Domain -> language mapping
_DOMAIN_LANGUAGES: dict[str, list[str]] = {
    "python": ["python"],
    "javascript": ["javascript"],
    "typescript": ["typescript"],
    "go": ["go"],
    "golang": ["go"],
    "rust": ["rust"],
    "java": ["java"],
    "csharp": ["csharp"],
    "c_sharp": ["csharp"],
    "kotlin": ["kotlin"],
    "swift": ["swift"],
    "ruby": ["ruby"],
    "php": ["php"],
    "cpp": ["cpp"],
    "c": ["c"],
    "terraform": ["terraform"],
    "sql": ["sql"],
    "bash": ["bash"],
    "shell": ["bash"],
    "perl": ["perl"],
    "scala": ["scala"],
}

# Tag -> language mapping (when domain doesn't resolve)
_TAG_LANGUAGES: dict[str, str] = {
    "python": "python",
    "javascript": "javascript",
    "typescript": "typescript",
    "golang": "go",
    "go": "go",
    "rust": "rust",
    "java": "java",
    "csharp": "csharp",
    "terraform": "terraform",
    "hcl": "terraform",
    "sql": "sql",
    "bash": "bash",
    "shell": "bash",
    "ruby": "ruby",
    "php": "php",
    "kotlin": "kotlin",
    "swift": "swift",
    "cpp": "cpp",
}

# Handler -> artifact_kind
_HANDLER_ARTIFACT: dict[str, str] = {
    "github_code": "code",
    "openapi_spec": "api_spec",
    "arxiv_paper": "docs",
    "web_page": "docs",
    "pdf_document": "docs",
    "html_document": "docs",
    "github_markdown": "docs",
    "license_spdx": "docs",
}

# Tag -> content_profile hints
_TAG_CONTENT_PROFILE: dict[str, str] = {
    "tutorial": "docs",
    "guide": "docs",
    "reference": "reference",
    "api-reference": "api_spec",
    "api_reference": "api_spec",
    "architecture": "architecture",
    "adr": "architecture",
    "security": "docs",
    "style-guide": "reference",
    "linter": "reference",
    "testing": "docs",
}

# Handler -> freshness_sla_days
_HANDLER_FRESHNESS: dict[str, int] = {
    "github_code": 90,
    "openapi_spec": 90,
    "web_page": 180,
    "html_document": 180,
    "github_markdown": 180,
    "pdf_document": 365,
    "arxiv_paper": 365,
    "license_spdx": 365,
}

# Authority+handler -> constraint_kind
_HARD_AUTHORITIES = {"canonical"}
_GUIDING_AUTHORITIES = {"vetted"}


def _infer_corpus_class(item: dict[str, Any]) -> str:
    handler = str(item.get("handler") or "").lower()
    if handler in _CODER_HANDLERS:
        return "coder_enriched"

    domain = str(item.get("domain") or "").lower()
    if domain in _CODER_DOMAINS:
        return "coder_enriched"
    if domain in _GENERAL_DOMAINS:
        return "general"
    if domain in _HYBRID_DOMAINS:
        return "hybrid"

    tags = [str(t).lower() for t in (item.get("tags") or [])]
    if any(t in _CODER_DOMAINS for t in tags):
        return "coder_enriched"

    return "general"


def _infer_languages(item: dict[str, Any]) -> list[str]:
    langs: set[str] = set()

    domain = str(item.get("domain") or "").lower()
    if domain in _DOMAIN_LANGUAGES:
        langs.update(_DOMAIN_LANGUAGES[domain])

    config = item.get("config")
    if isinstance(config, dict):
        cfg_lang = str(config.get("language") or "").lower()
        if cfg_lang and cfg_lang in _TAG_LANGUAGES:
            langs.add(_TAG_LANGUAGES[cfg_lang])
        elif cfg_lang:
            langs.add(cfg_lang)

    tags = [str(t).lower() for t in (item.get("tags") or [])]
    for tag in tags:
        if tag in _TAG_LANGUAGES:
            langs.add(_TAG_LANGUAGES[tag])

    return sorted(langs)


def _infer_artifact_kind(item: dict[str, Any]) -> str:
    handler = str(item.get("handler") or "").lower()
    return _HANDLER_ARTIFACT.get(handler, "docs")


def _infer_content_profile(item: dict[str, Any]) -> str:
    handler = str(item.get("handler") or "").lower()
    if handler == "github_code":
        return "code"
    if handler == "openapi_spec":
        return "api_spec"

    tags = [str(t).lower() for t in (item.get("tags") or [])]
    for tag in tags:
        if tag in _TAG_CONTENT_PROFILE:
            return _TAG_CONTENT_PROFILE[tag]

    return "docs"


def _infer_freshness_sla_days(item: dict[str, Any]) -> int:
    handler = str(item.get("handler") or "").lower()
    return _HANDLER_FRESHNESS.get(handler, 180)


def _infer_scope_tags(item: dict[str, Any]) -> list[str]:
    existing = item.get("tags")
    if isinstance(existing, list) and existing:
        return [str(t) for t in existing]
    return []


def _infer_constraint_kind(item: dict[str, Any]) -> str:
    authority = str(item.get("authority") or "").lower()
    if authority in _HARD_AUTHORITIES:
        return "hard"
    if authority in _GUIDING_AUTHORITIES:
        return "guiding"
    return "advisory"


def _fix_legacy_enums(item: dict[str, Any]) -> int:
    """Fix legacy enum values to match current admin backend. Returns fix count."""
    fixes = 0
    if item.get("authority") == "external":
        item["authority"] = "vetted"
        fixes += 1
    if item.get("origin_type") == "external":
        item["origin_type"] = "curated"
        fixes += 1
    return fixes


def _annotate_item(item: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Add missing annotation fields. Returns (item, fields_added_count)."""
    added = 0

    added += _fix_legacy_enums(item)

    if "corpus_class" not in item:
        item["corpus_class"] = _infer_corpus_class(item)
        added += 1

    if "languages" not in item:
        item["languages"] = _infer_languages(item)
        added += 1

    if "artifact_kind" not in item:
        item["artifact_kind"] = _infer_artifact_kind(item)
        added += 1

    if "content_profile" not in item:
        item["content_profile"] = _infer_content_profile(item)
        added += 1

    if "freshness_sla_days" not in item:
        item["freshness_sla_days"] = _infer_freshness_sla_days(item)
        added += 1

    if "scope_tags" not in item:
        item["scope_tags"] = _infer_scope_tags(item)
        added += 1

    if "constraint_kind" not in item:
        item["constraint_kind"] = _infer_constraint_kind(item)
        added += 1

    return item, added


def _annotate_file(path: Path, dry_run: bool) -> tuple[int, int]:
    """Annotate a single YAML file. Returns (items_count, total_fields_added)."""
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or "items" not in raw:
        print(f"  SKIP {path}: no 'items' key")
        return 0, 0

    items = raw["items"]
    if not isinstance(items, list):
        print(f"  SKIP {path}: 'items' is not a list")
        return 0, 0

    total_fields = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        _, fields_added = _annotate_item(item)
        total_fields += fields_added

    if not dry_run and total_fields > 0:
        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(raw, f, default_flow_style=False, allow_unicode=True, sort_keys=False, width=120)

    return len(items), total_fields


def main() -> int:
    parser = argparse.ArgumentParser(description="Annotate bootstrap corpus YAML with missing metadata.")
    parser.add_argument("files", nargs="*", help="Specific YAML files (defaults to bootstrap/corpus/*.yaml)")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    args = parser.parse_args()

    if args.files:
        files = [Path(f) for f in args.files]
    else:
        files = sorted(DEFAULT_CORPUS_DIR.glob("*.yaml"))

    if not files:
        print("No corpus YAML files found.")
        return 0

    total_items = 0
    total_fields = 0

    for path in files:
        if not path.exists():
            print(f"  ERROR: {path} not found")
            continue
        items, fields = _annotate_file(path, dry_run=args.dry_run)
        total_items += items
        total_fields += fields
        action = "would add" if args.dry_run else "added"
        print(f"  {path.name}: {items} items, {action} {fields} fields")

    mode = "DRY RUN" if args.dry_run else "APPLIED"
    print(f"\n{mode}: {total_items} items across {len(files)} files, {total_fields} fields {'would be ' if args.dry_run else ''}added")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
