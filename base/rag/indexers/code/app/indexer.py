"""Code Repository Indexer.

Clones high-quality OSS repositories, parses source files using
tree-sitter for AST-aware chunking, optionally extracts merged PR
descriptions and commit messages via the GitHub API, and upserts
everything into per-language Milvus collections.

Usage:
    python -m app.indexer --sources /data/sources.yaml [--language python] [--repo fastapi]
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml
from pymilvus import DataType, FieldSchema

from .indexer_base import (
    EmbedClient,
    MilvusWriter,
    ProgressTracker,
    chunk_id_hash,
)

from .github_extractor import extract_pr_patterns
from .tree_sitter_chunker import chunk_file, get_extensions_for_language

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.indexer.code")

CLONE_BASE = os.environ.get("CLONE_DIR", "/tmp/synesis-repos")


CODE_EXTRA_FIELDS = [
    FieldSchema(name="symbol_name", dtype=DataType.VARCHAR, max_length=256),
    FieldSchema(name="symbol_type", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="repo_license", dtype=DataType.VARCHAR, max_length=64),
]

PATTERN_EXTRA_FIELDS = [
    FieldSchema(name="pattern_type", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="repo_license", dtype=DataType.VARCHAR, max_length=64),
]

_LICENSE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("MIT", re.compile(r"Permission is hereby granted, free of charge", re.IGNORECASE)),
    ("Apache-2.0", re.compile(r"Apache License\s*(?:,?\s*Version)?\s*2\.0", re.IGNORECASE)),
    ("GPL-3.0-only", re.compile(r"GNU GENERAL PUBLIC LICENSE\s*Version 3", re.IGNORECASE)),
    ("GPL-2.0-only", re.compile(r"GNU GENERAL PUBLIC LICENSE\s*Version 2", re.IGNORECASE)),
    ("LGPL-3.0-only", re.compile(r"GNU LESSER GENERAL PUBLIC LICENSE\s*Version 3", re.IGNORECASE)),
    ("LGPL-2.1-only", re.compile(r"GNU LESSER GENERAL PUBLIC LICENSE\s*Version 2\.1", re.IGNORECASE)),
    ("AGPL-3.0-only", re.compile(r"GNU AFFERO GENERAL PUBLIC LICENSE\s*Version 3", re.IGNORECASE)),
    ("MPL-2.0", re.compile(r"Mozilla Public License\s*(?:,?\s*)?(?:Version\s*)?2\.0", re.IGNORECASE)),
    ("BSD-3-Clause", re.compile(r"Redistribution and use.*?neither the name", re.IGNORECASE | re.DOTALL)),
    ("BSD-2-Clause", re.compile(r"Redistribution and use.*?THIS SOFTWARE IS PROVIDED", re.IGNORECASE | re.DOTALL)),
    ("ISC", re.compile(r"ISC License", re.IGNORECASE)),
    ("Unlicense", re.compile(r"This is free and unencumbered software", re.IGNORECASE)),
    ("CC0-1.0", re.compile(r"CC0 1\.0 Universal", re.IGNORECASE)),
    ("BSL-1.0", re.compile(r"Boost Software License", re.IGNORECASE)),
    ("Zlib", re.compile(r"zlib License", re.IGNORECASE)),
    ("EPL-2.0", re.compile(r"Eclipse Public License.*?2\.0", re.IGNORECASE)),
]

_LICENSE_FILENAMES = (
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "LICENCE",
    "LICENCE.md",
    "LICENCE.txt",
    "COPYING",
    "COPYING.md",
)


def _detect_repo_license(clone_dir: str) -> str:
    """Detect the SPDX license ID from a repo's LICENSE file via pattern matching."""
    base = Path(clone_dir)
    for name in _LICENSE_FILENAMES:
        license_file = base / name
        if not license_file.is_file():
            continue
        try:
            text = license_file.read_text(errors="replace")[:8000]
        except Exception:
            continue
        for spdx_id, pattern in _LICENSE_PATTERNS:
            if pattern.search(text):
                return spdx_id
    return "unknown"


def _clone_repo(repo_full_name: str) -> str:
    """Shallow-clone a repo and return the local directory."""
    dest = os.path.join(CLONE_BASE, repo_full_name.replace("/", "_"))
    if os.path.exists(dest):
        logger.info(f"  Repo already cloned: {dest}")
        subprocess.run(
            ["git", "-C", dest, "pull", "--ff-only"],
            capture_output=True,
            timeout=120,
        )
        return dest

    url = f"https://github.com/{repo_full_name}.git"
    logger.info(f"  Cloning {url} -> {dest}")
    result = subprocess.run(
        ["git", "clone", "--depth", "1", url, dest],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git clone failed: {result.stderr[:500]}")
    return dest


def _collect_source_files(
    clone_dir: str,
    paths: list[str],
    extensions: set[str],
) -> list[Path]:
    """Walk specified paths collecting files with matching extensions."""
    files: list[Path] = []
    base = Path(clone_dir)

    for rel_path in paths:
        target = base / rel_path
        if not target.exists():
            logger.warning(f"  Path not found: {target}")
            continue

        if target.is_file():
            if target.suffix in extensions:
                files.append(target)
        else:
            for f in target.rglob("*"):
                if f.is_file() and f.suffix in extensions:
                    files.append(f)

    return files


def index_language(
    language: str,
    repos: list[dict],
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    skip_existing: bool = True,
) -> None:
    """Index all repositories for a given language.

    When *skip_existing* is True (the default), chunks whose
    ``chunk_id`` already exists in Milvus are skipped -- only
    new/changed content gets embedded and upserted.  This makes
    adding a single new repo to sources.yaml cheap even during a
    full refresh.
    """
    code_collection = f"code_{language}_v1"
    pattern_collection = f"patterns_{language}_v1"

    writer.ensure_collection(
        code_collection,
        extra_fields=CODE_EXTRA_FIELDS,
        description=f"AST-chunked code from quality {language} projects",
    )
    writer.ensure_collection(
        pattern_collection,
        extra_fields=PATTERN_EXTRA_FIELDS,
        description=f"PR/commit patterns from quality {language} projects",
    )

    existing_code_ids: set[str] = set()
    existing_pattern_ids: set[str] = set()
    if skip_existing:
        existing_code_ids = writer.existing_chunk_ids(code_collection)
        existing_pattern_ids = writer.existing_chunk_ids(pattern_collection)
        logger.info(f"  Existing chunks: {len(existing_code_ids)} code, {len(existing_pattern_ids)} patterns")

    extensions = get_extensions_for_language(language)

    for repo_cfg in repos:
        repo_name = repo_cfg["repo"]
        paths = repo_cfg.get("paths", ["."])
        desc = repo_cfg.get("description", "")

        logger.info(f"Processing {repo_name} ({desc})")

        try:
            clone_dir = _clone_repo(repo_name)
        except Exception as e:
            progress.log_error(repo_name, str(e))
            continue

        repo_license = _detect_repo_license(clone_dir)
        logger.info(f"  Detected license: {repo_license}")

        source_files = _collect_source_files(clone_dir, paths, extensions)
        logger.info(f"  Found {len(source_files)} {language} files")

        code_entities: list[dict] = []
        skipped = 0

        for fpath in source_files:
            try:
                source_code = fpath.read_text(errors="replace")
            except Exception:
                continue

            rel_path = str(fpath.relative_to(clone_dir))
            chunks = chunk_file(source_code, language, rel_path)

            for chunk in chunks:
                cid = chunk_id_hash(chunk.text, f"repo:{repo_name} path:{chunk.file_path}")
                if cid in existing_code_ids:
                    skipped += 1
                    continue
                code_entities.append(
                    {
                        "chunk_id": cid,
                        "text": chunk.text[:8192],
                        "source": f"repo:{repo_name} path:{chunk.file_path}"[:512],
                        "symbol_name": chunk.symbol_name[:256],
                        "symbol_type": chunk.symbol_type[:64],
                        "repo_license": repo_license[:64],
                        "language": language[:32],
                    }
                )

        if skipped:
            logger.info(f"  Skipped {skipped} unchanged code chunks")

        if code_entities:
            texts = [e["text"] for e in code_entities]
            embeddings = embedder.embed_texts(texts)
            for entity, emb in zip(code_entities, embeddings):
                entity["embedding"] = emb

            count = writer.upsert_batch(code_collection, code_entities)
            progress.log_source(f"{repo_name} (code)", count)
        else:
            progress.log_source(f"{repo_name} (code)", 0)

        pr_chunks = extract_pr_patterns(repo_name, clone_dir, language)
        if pr_chunks:
            pattern_entities = []
            for pc in pr_chunks:
                cid = chunk_id_hash(pc.text, pc.source)
                if cid in existing_pattern_ids:
                    continue
                pattern_entities.append(
                    {
                        "chunk_id": cid,
                        "text": pc.text[:8192],
                        "source": pc.source[:512],
                        "pattern_type": pc.pattern_type[:64],
                        "repo_license": repo_license[:64],
                        "language": language[:32],
                    }
                )

            texts = [e["text"] for e in pattern_entities]
            embeddings = embedder.embed_texts(texts)
            for entity, emb in zip(pattern_entities, embeddings):
                entity["embedding"] = emb

            count = writer.upsert_batch(pattern_collection, pattern_entities)
            progress.log_source(f"{repo_name} (patterns)", count)


def main() -> None:
    parser = argparse.ArgumentParser(description="Synesis Code Repository Indexer")
    parser.add_argument("--sources", required=True, help="Path to sources.yaml")
    parser.add_argument("--language", default=None, help="Index only this language")
    parser.add_argument("--repo", default=None, help="Index only this repo (owner/name)")
    parser.add_argument("--force", action="store_true", help="Re-embed all chunks even if already indexed")
    parser.add_argument("--dry-run", action="store_true", help="Validate config and sources without connecting to Milvus/embedder")
    args = parser.parse_args()

    sources_path = Path(args.sources)
    if not sources_path.exists():
        logger.error(f"Sources file not found: {sources_path}")
        sys.exit(1)

    with open(sources_path) as f:
        sources = yaml.safe_load(f)

    repositories = sources.get("repositories", {})

    languages_to_index = [args.language] if args.language else list(repositories.keys())
    total_repos = sum(len(repositories.get(l, [])) for l in languages_to_index)
    logger.info(f"Loaded {total_repos} repositories across {len(languages_to_index)} languages from {sources_path}")
    for lang in languages_to_index:
        repos = repositories.get(lang, [])
        logger.info(f"  {lang}: {len(repos)} repos")
        for r in repos:
            logger.info(f"    - {r['repo']}")

    if args.dry_run:
        logger.info("Dry run complete -- config and sources are valid")
        return

    try:
        writer = MilvusWriter()
    except Exception as e:
        logger.error(f"Failed to connect to Milvus: {e}")
        sys.exit(1)

    embedder = EmbedClient()
    progress = ProgressTracker(name="Code Repository Indexer")

    for lang in languages_to_index:
        repos = repositories.get(lang, [])
        if not repos:
            logger.warning(f"No repositories defined for language: {lang}")
            continue

        if args.repo:
            repos = [r for r in repos if r["repo"] == args.repo]
            if not repos:
                logger.warning(f"Repo '{args.repo}' not found for language {lang}")
                continue

        logger.info(f"=== Indexing {lang}: {len(repos)} repositories ===")
        index_language(lang, repos, writer, embedder, progress, skip_existing=not args.force)

    progress.log_complete()


if __name__ == "__main__":
    main()
