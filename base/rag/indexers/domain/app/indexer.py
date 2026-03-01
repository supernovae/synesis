"""Domain / Runbook Knowledge Loader — Red Hat, OpenShift, ODF from GitHub.

Fetches markdown from openshift/runbooks, red-hat-storage/ocs-sop, etc.,
parses by section, embeds, and upserts to synesis_catalog (unified catalog).
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import yaml

from .catalog_schema import SYNESIS_CATALOG, catalog_entity, ensure_synesis_catalog
from .github_fetcher import fetch_all_markdown
from .markdown_parser import parse_markdown
from .indexer_base import (
    EmbedClient,
    MilvusWriter,
    ProgressTracker,
    chunk_id_hash,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.indexer.domain")


def _domain_from_collection(collection: str) -> str:
    """Extract domain from collection name (e.g. domain_openshift -> openshift)."""
    for prefix in ("domain_", "sop_"):
        if collection.startswith(prefix):
            return collection[len(prefix):].strip("_") or "generalist"
    return "generalist"


def index_repo(
    repo_cfg: dict,
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    skip_existing: bool = True,
    token: str | None = None,
) -> None:
    """Fetch and index a GitHub repo's markdown files into synesis_catalog."""
    repo = repo_cfg.get("repo", "")
    path = repo_cfg.get("path", "")
    branch = repo_cfg.get("branch", "main")
    collection = repo_cfg.get("collection", "domain_openshift")
    tags = repo_cfg.get("tags", [])
    domain = _domain_from_collection(collection)

    if not repo or not path:
        progress.log_error(repo or "unknown", "Missing repo or path")
        return

    logger.info(f"Fetching GitHub repo {repo} path={path} branch={branch} -> {SYNESIS_CATALOG}")

    try:
        files = fetch_all_markdown(repo, path, branch, token)
    except Exception as e:
        progress.log_error(repo, f"Failed to list/fetch: {e}")
        return

    if not files:
        logger.warning(f"No markdown files found in {repo}/{path}")
        progress.log_source(repo, 0)
        return

    ensure_synesis_catalog()
    existing_ids = writer.existing_chunk_ids(SYNESIS_CATALOG) if skip_existing else set()

    chunks_to_embed: list[tuple[str, str, str, str, str, str]] = []
    for mf in files:
        doc_name = f"{repo}:{mf.path}"
        for chunk in parse_markdown(mf.content, doc_name, tags):
            cid = chunk_id_hash(chunk.text, f"{doc_name}:{chunk.section}")
            if cid in existing_ids:
                continue
            chunks_to_embed.append(
                (cid, chunk.text, doc_name, chunk.section, ",".join(chunk.tags), domain)
            )

    if not chunks_to_embed:
        progress.log_source(repo, 0)
        return

    texts = [c[1] for c in chunks_to_embed]
    embeddings = embedder.embed_texts(texts)
    all_entities = []
    for (cid, text, doc_name, section, tags_str, _domain), emb in zip(chunks_to_embed, embeddings):
        all_entities.append(
            catalog_entity(
                chunk_id=cid,
                text=text[:8192],
                source=f"doc:{doc_name} section:{section}"[:512],
                language="domain",
                embedding=emb,
                domain=_domain,
                indexer_source="domain",
                section=section[:256],
                document_name=doc_name[:256],
                tags=tags_str[:512],
            )
        )

    count = writer.upsert_batch(SYNESIS_CATALOG, all_entities)
    progress.log_source(repo, count)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Synesis Domain / Runbook Knowledge Loader")
    parser.add_argument("--sources", required=True, help="Path to sources.yaml")
    parser.add_argument("--repo", default=None, help="Index only this repo (owner/name)")
    parser.add_argument("--force", action="store_true", help="Re-embed all chunks")
    parser.add_argument("--token", default=None, help="GitHub token for higher rate limit")
    parser.add_argument("--dry-run", action="store_true", help="Validate config only")
    args = parser.parse_args()

    sources_path = Path(args.sources)
    if not sources_path.exists():
        logger.error(f"Sources file not found: {sources_path}")
        sys.exit(1)

    with open(sources_path) as f:
        sources = yaml.safe_load(f)

    repos = sources.get("github_repos", [])
    if not repos:
        logger.error("No github_repos in sources")
        sys.exit(1)

    if args.repo:
        repos = [r for r in repos if r.get("repo") == args.repo]
        if not repos:
            logger.error(f"Repo '{args.repo}' not found")
            sys.exit(1)

    logger.info(f"Loaded {len(repos)} GitHub repos from {sources_path}")
    for r in repos:
        logger.info(f"  - {r['repo']}/{r.get('path','')} -> {r.get('collection','')}")

    if args.dry_run:
        logger.info("Dry run complete")
        return

    try:
        writer = MilvusWriter()
    except Exception as e:
        logger.error(f"Failed to connect to Milvus: {e}")
        sys.exit(1)

    embedder = EmbedClient()
    progress = ProgressTracker(name="Domain Knowledge Loader")

    for repo_cfg in repos:
        index_repo(
            repo_cfg,
            writer,
            embedder,
            progress,
            skip_existing=not args.force,
            token=args.token or None,
        )

    progress.log_complete()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("Domain loader crashed")
        sys.exit(1)
