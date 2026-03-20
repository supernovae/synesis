#!/usr/bin/env python3
"""Classify bootstrap corpus web items: blogs stay html_document; docs -> web_page + crawl config.

Heuristics:
- Blog hosts (medium, dev.to, substack, …) or path segments /blog/, /news/, … → single-page html_document + tag corpus_blog.
- Other https URLs with html_document → web_page with sitemap_first, robots respect,
  allowed_prefixes derived from the URI path (caps breadth per site).

Usage (from repo root):
  python3 scripts/classify-bootstrap-web-sources.py
  python3 scripts/classify-bootstrap-web-sources.py --dry-run

Requires PyYAML.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from urllib.parse import urlparse

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
CORPUS_DIR = REPO_ROOT / "bootstrap" / "corpus"

BLOG_HOST_FRAGMENTS = (
    "medium.com",
    "dev.to",
    "substack.com",
    "hashnode.",
    "towardsdatascience",
    "javascriptweekly.com",
    "blog.logrocket",
    "hn.algolia",
    "lobste.rs",
)

BLOG_PATH_SNIPPETS = (
    "/blog/",
    "/blogs/",
    "/news/",
    "/articles/",
    "/posts/",
    "/post/",
    "/changelog",
    "/release-notes/",
    "/releases/",
)

TEXT_FILE_SUFFIXES = (".html", ".htm", ".php", ".asp", ".aspx", ".jsp")


def is_probably_blog(uri: str) -> bool:
    low = uri.lower()
    pr = urlparse(low)
    host = pr.netloc
    for frag in BLOG_HOST_FRAGMENTS:
        if frag in host:
            return True
    path = pr.path if pr.path.endswith("/") else pr.path + "/"
    for snip in BLOG_PATH_SNIPPETS:
        if snip in path:
            return True
    return False


def doc_allowed_prefix(uri: str, max_segments: int = 6) -> str:
    """Longest safe prefix under the seed path (directory-style), full URL."""
    p = urlparse(uri.strip())
    if not p.scheme.startswith("http") or not p.netloc:
        return ""
    parts = [x for x in p.path.split("/") if x]
    if parts and "." in parts[-1]:
        last = parts[-1].lower()
        if last.endswith(TEXT_FILE_SUFFIXES) or "." in last:
            parts = parts[:-1]
    if not parts:
        return f"{p.scheme}://{p.netloc}/"
    keep = min(len(parts), max_segments)
    path = "/" + "/".join(parts[:keep]) + "/"
    return f"{p.scheme}://{p.netloc}{path}"


def _github_repo_landing_only(uri: str) -> bool:
    """True for https://github.com/org/repo (no /blob/, /wiki/, etc.)."""
    pr = urlparse(uri.lower())
    if pr.netloc not in ("github.com", "www.github.com"):
        return False
    if "/blob/" in pr.path or "/raw/" in pr.path or "/wiki" in pr.path:
        return False
    parts = [x for x in pr.path.strip("/").split("/") if x]
    return 0 < len(parts) <= 2


def should_skip_item(uri: str, handler: str) -> bool:
    if handler != "html_document":
        return True
    low = uri.lower()
    if not low.startswith(("http://", "https://")):
        return True
    if low.split("?", 1)[0].endswith(".pdf"):
        return True
    if _github_repo_landing_only(uri):
        return True
    return False


def web_page_config(uri: str) -> dict:
    prefix = doc_allowed_prefix(uri)
    return {
        "discovery": "sitemap_first",
        "follow_links": True,
        "max_depth": 5,
        "max_pages": 100,
        "respect_robots": True,
        "min_request_interval": 0.4,
        "allowed_prefixes": [prefix] if prefix else [],
    }


def split_corpus_file(text: str) -> tuple[str, str]:
    """Return (header_before_items, from_items_line_inclusive). Header keeps YAML comments."""
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.lstrip().startswith("items:"):
            return "".join(lines[:i]), "".join(lines[i:])
    return "", text


def process_file(path: Path, dry_run: bool) -> tuple[int, int]:
    """Returns (blogs_tagged, docs_converted)."""
    text = path.read_text(encoding="utf-8")
    header, body = split_corpus_file(text)
    data = yaml.safe_load(body if body.strip() else text)
    if not data or "items" not in data:
        return 0, 0

    blogs = 0
    docs = 0
    for item in data["items"]:
        if not isinstance(item, dict):
            continue
        uri = (item.get("uri") or "").strip()
        handler = (item.get("handler") or "").strip()
        if should_skip_item(uri, handler):
            continue

        if is_probably_blog(uri):
            tags = item.get("tags")
            if not isinstance(tags, list):
                tags = []
            if "corpus_blog" not in tags:
                tags = list(tags) + ["corpus_blog"]
                item["tags"] = tags
                blogs += 1
            continue

        item["handler"] = "web_page"
        cfg = web_page_config(uri)
        existing = item.get("config")
        if isinstance(existing, dict):
            merged = {**cfg, **existing}
            item["config"] = merged
        else:
            item["config"] = cfg
        docs += 1

    if not dry_run and (blogs or docs):
        dumped = yaml.dump(data, default_flow_style=False, sort_keys=False, allow_unicode=True)
        path.write_text(header + dumped, encoding="utf-8")
    return blogs, docs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="Do not write files")
    ap.add_argument(
        "files",
        nargs="*",
        type=Path,
        help="YAML files (default: all bootstrap/corpus/*.yaml)",
    )
    args = ap.parse_args()
    files = args.files
    if not files:
        files = sorted(CORPUS_DIR.glob("*.yaml"))

    total_b = total_d = 0
    for f in files:
        if not f.is_file():
            print(f"skip missing: {f}", file=sys.stderr)
            continue
        b, d = process_file(f, args.dry_run)
        total_b += b
        total_d += d
        if b or d:
            print(f"{f.name}: tagged {b} blogs, converted {d} docs to web_page")

    print(f"Total: corpus_blog tags +{total_b}, web_page conversions +{total_d}")
    if args.dry_run:
        print("(dry-run: no files written)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
