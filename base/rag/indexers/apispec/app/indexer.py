"""API Spec Indexer.

Fetches OpenAPI 3.x / Swagger 2.0 specs from URLs, parses them into
endpoint-level chunks, and upserts into per-spec Milvus collections.

Usage:
    python -m app.indexer --sources /data/sources.yaml [--spec kubernetes]
"""

from __future__ import annotations

import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.indexer.apispec")
logger.info("API Spec Indexer starting (pid %d)", __import__("os").getpid())

import argparse
from pathlib import Path

import httpx
import yaml

from .indexer_base import (
    EmbedClient,
    MilvusWriter,
    ProgressTracker,
    chunk_id_hash,
)
from .openapi_parser import parse_spec


def index_spec(
    spec_cfg: dict,
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    skip_existing: bool = True,
) -> None:
    """Fetch and index a single API spec."""
    name = spec_cfg["name"]
    url = spec_cfg["url"]
    collection = spec_cfg["collection"]
    description = spec_cfg.get("description", "")

    logger.info(f"Fetching spec: {name} from {url}")

    try:
        resp = httpx.get(url, timeout=60, follow_redirects=True)
        resp.raise_for_status()
        spec_content = resp.text
    except Exception as e:
        progress.log_error(name, f"Failed to fetch: {e}")
        return

    writer.ensure_collection(
        collection,
        description=f"API spec: {description or name}",
    )

    existing_ids: set[str] = set()
    if skip_existing:
        existing_ids = writer.existing_chunk_ids(collection)

    chunks = parse_spec(spec_content, name)
    if not chunks:
        progress.log_source(name, 0)
        return

    entities = []
    skipped = 0
    for chunk in chunks:
        cid = chunk_id_hash(chunk.text, chunk.source)
        if cid in existing_ids:
            skipped += 1
            continue
        entities.append(
            {
                "chunk_id": cid,
                "text": chunk.text[:8192],
                "source": chunk.source[:512],
                "language": "openapi",
                "embedding": None,
            }
        )

    if skipped:
        logger.info(f"  Skipped {skipped} unchanged endpoint chunks")

    if not entities:
        progress.log_source(name, 0)
        return

    texts = [e["text"] for e in entities]
    embeddings = embedder.embed_texts(texts)
    for entity, emb in zip(entities, embeddings):
        entity["embedding"] = emb

    count = writer.upsert_batch(collection, entities)
    progress.log_source(name, count)


def main() -> None:
    parser = argparse.ArgumentParser(description="Synesis API Spec Indexer")
    parser.add_argument("--sources", required=True, help="Path to sources.yaml")
    parser.add_argument("--spec", default=None, help="Index only this spec by name")
    parser.add_argument("--force", action="store_true", help="Re-embed all chunks even if already indexed")
    parser.add_argument(
        "--dry-run", action="store_true", help="Validate config and sources without connecting to Milvus/embedder"
    )
    args = parser.parse_args()

    sources_path = Path(args.sources)
    if not sources_path.exists():
        logger.error(f"Sources file not found: {sources_path}")
        sys.exit(1)

    with open(sources_path) as f:
        sources = yaml.safe_load(f)

    specs = sources.get("specs", [])

    if args.spec:
        specs = [s for s in specs if s["name"].lower() == args.spec.lower()]
        if not specs:
            logger.error(f"Spec '{args.spec}' not found in sources")
            sys.exit(1)

    logger.info(f"Loaded {len(specs)} API specs from {sources_path}")
    for s in specs:
        logger.info(f"  - {s['name']} -> {s['collection']}")

    if args.dry_run:
        logger.info("Dry run complete -- config and sources are valid")
        return

    try:
        writer = MilvusWriter()
    except Exception as e:
        logger.error(f"Failed to connect to Milvus: {e}")
        sys.exit(1)

    embedder = EmbedClient()
    progress = ProgressTracker(name="API Spec Indexer")

    for spec_cfg in specs:
        index_spec(spec_cfg, writer, embedder, progress, skip_existing=not args.force)

    progress.log_complete()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("API Spec Indexer crashed with unhandled exception")
        sys.exit(1)
