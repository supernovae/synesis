#!/usr/bin/env python3
"""Convert legacy sources-*.yaml + seed-corpus-*.json into normalized bootstrap YAML.

Reads the old handler-specific config shapes and produces files that map 1:1
to the ingestion_items DB schema.  Run once to generate bootstrap/corpus/*.yaml,
then import via POST /ingestion/bootstrap.

Usage:
    python bootstrap/convert.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

INDEXER_DIR = Path(__file__).parent.parent / "base" / "rag" / "indexer"
OUTPUT_DIR = Path(__file__).parent / "corpus"


def _normalize_source_entry(entry: dict, default_handler: str = "") -> list[dict]:
    """Convert one sources.yaml entry into one or more normalized items."""
    name = entry.get("name", "")
    handler = entry.get("handler", default_handler)
    authority = entry.get("authority", "vetted")
    origin_type = entry.get("origin_type", "curated")
    domain = entry.get("domain", "generalist")
    config = entry.get("config", {}) or {}
    tags = config.get("tags", [])

    if handler == "seed_corpus":
        return _explode_seed_corpus(entry)

    if handler == "arxiv_paper":
        return _explode_arxiv(entry)

    uri = config.get("url") or config.get("repo") or ""
    if handler in ("github_code", "github_markdown") and not uri.startswith("http"):
        repo = config.get("repo", "")
        uri = f"https://github.com/{repo}" if repo else ""

    # Special handlers with compound config (no single URL)
    if handler == "license_spdx":
        uri = f"synesis://license-spdx/{name.lower().replace(' ', '-')}"

    if not uri:
        return []

    item_config = {k: v for k, v in config.items() if k not in ("url", "tags")}
    item: dict = {
        "uri": uri,
        "handler": handler,
        "title": name,
        "domain": domain,
        "authority": authority,
        "origin_type": origin_type,
    }
    if tags:
        item["tags"] = tags
    if item_config:
        item["config"] = item_config
    return [item]


def _explode_seed_corpus(entry: dict) -> list[dict]:
    """Expand a seed_corpus source into individual html_document/pdf_document items."""
    config = entry.get("config", {}) or {}
    json_path = config.get("path", "")
    authority = entry.get("authority", "vetted")
    origin_type = entry.get("origin_type", "curated")

    full_path = INDEXER_DIR / json_path
    if not full_path.exists():
        print(f"  WARN: seed corpus file not found: {full_path}", file=sys.stderr)
        return []

    with open(full_path) as f:
        data = json.load(f)

    sources_list = data.get("sources", [])
    items = []
    for src in sources_list:
        url = src.get("url", "").strip()
        if not url:
            continue

        handler = "pdf_document" if url.lower().endswith(".pdf") else "html_document"
        item: dict = {
            "uri": url,
            "handler": handler,
            "title": src.get("title", src.get("name", "")),
            "domain": src.get("domain", entry.get("domain", "generalist")),
            "authority": authority,
            "origin_type": origin_type,
        }
        tags = src.get("tags", [])
        if tags:
            item["tags"] = tags
        priority = src.get("priority")
        if priority:
            item["priority"] = priority
        items.append(item)

    return items


def _explode_arxiv(entry: dict) -> list[dict]:
    """Expand arxiv_paper batch papers[] into individual items."""
    config = entry.get("config", {}) or {}
    papers = config.get("papers", [])
    authority = entry.get("authority", "external")
    origin_type = entry.get("origin_type", "external")
    domain = entry.get("domain", "generalist")
    tags = config.get("tags", [])

    if config.get("url"):
        item: dict = {
            "uri": config["url"],
            "handler": "arxiv_paper",
            "title": entry.get("name", ""),
            "domain": domain,
            "authority": authority,
            "origin_type": origin_type,
        }
        if tags:
            item["tags"] = tags
        return [item]

    items = []
    for paper in papers:
        paper_id = paper.get("id", "")
        if not paper_id:
            continue
        item = {
            "uri": f"https://arxiv.org/abs/{paper_id}",
            "handler": "arxiv_paper",
            "title": paper.get("title", f"arXiv:{paper_id}"),
            "domain": domain,
            "authority": authority,
            "origin_type": origin_type,
            "config": {"id": paper_id},
        }
        if tags:
            item["tags"] = tags
        items.append(item)
    return items


def convert_file(yaml_path: Path, output_name: str) -> int:
    """Convert one sources-*.yaml file to normalized bootstrap YAML."""
    with open(yaml_path) as f:
        data = yaml.safe_load(f) or {}

    sources = data.get("sources", [])
    all_items: list[dict] = []
    seen_uris: set[str] = set()

    for source in sources:
        normalized = _normalize_source_entry(source)
        for item in normalized:
            uri = item.get("uri", "")
            if uri and uri not in seen_uris:
                seen_uris.add(uri)
                all_items.append(item)

    if not all_items:
        print(f"  SKIP: {yaml_path.name} -> no items", file=sys.stderr)
        return 0

    output_path = OUTPUT_DIR / f"{output_name}.yaml"
    with open(output_path, "w") as f:
        yaml.dump({"items": all_items}, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

    print(f"  OK: {yaml_path.name} -> {output_path.name} ({len(all_items)} items)")
    return len(all_items)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    file_map = {
        "sources-docs.yaml": "docs",
        "sources-code.yaml": "code",
        "sources-research.yaml": "research",
        "sources-epistemic.yaml": "epistemic",
        "sources-epistemic-band2.yaml": "epistemic-band2",
        "sources-epistemic-developer.yaml": "epistemic-developer",
        "sources-apispec.yaml": "apispec",
        "sources-license.yaml": "license",
    }

    total = 0
    uris_all: set[str] = set()

    for filename, output_name in file_map.items():
        yaml_path = INDEXER_DIR / filename
        if not yaml_path.exists():
            print(f"  SKIP: {filename} not found", file=sys.stderr)
            continue
        count = convert_file(yaml_path, output_name)
        total += count

        out_path = OUTPUT_DIR / f"{output_name}.yaml"
        if out_path.exists():
            with open(out_path) as f:
                data = yaml.safe_load(f) or {}
            for item in data.get("items", []):
                uris_all.add(item.get("uri", ""))

    global_dupes = total - len(uris_all)
    print(f"\nTotal: {total} items across {len(file_map)} files")
    if global_dupes > 0:
        print(f"  Note: {global_dupes} cross-file duplicates (will be deduped on DB import)")


if __name__ == "__main__":
    main()
