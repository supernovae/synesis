"""Architecture Whitepaper Indexer.

Downloads whitepapers and design pattern documentation (PDFs, HTML,
Markdown), parses by section, embeds, and upserts into synesis_catalog
with indexer_source=architecture. Gives the Critic node access to
architectural best practices for its Safety-II "What-If" analysis.

Usage:
    python -m app.indexer --sources /data/sources.yaml
"""

from __future__ import annotations

import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.indexer.architecture")
logger.info("Architecture Whitepaper Indexer starting (pid %d)", __import__("os").getpid())

import argparse
import re
from pathlib import Path

import httpx
import yaml

from .catalog_schema import SYNESIS_CATALOG, catalog_entity, ensure_synesis_catalog
from .html_parser import parse_html, parse_markdown
from .indexer_base import (
    EmbedClient,
    MilvusWriter,
    ProgressTracker,
    chunk_id_hash,
)
from .pdf_parser import parse_pdf


def _domain_from_collection(collection: str) -> str:
    """Extract domain from collection name (e.g. arch_cloud -> cloud)."""
    m = re.match(r"arch_(\w+)", collection)
    return m.group(1) if m else "architecture"


def index_document(
    doc_cfg: dict,
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    skip_existing: bool = True,
) -> None:
    """Fetch and index a single architecture document into synesis_catalog."""
    name = doc_cfg["name"]
    url = doc_cfg["url"]
    doc_type = doc_cfg.get("type", "pdf")
    collection = doc_cfg["collection"]
    tags = doc_cfg.get("tags", [])
    domain = _domain_from_collection(collection)

    logger.info(f"Fetching document: {name} ({doc_type}) from {url} -> {SYNESIS_CATALOG}")

    try:
        if doc_type == "pdf":
            resp = httpx.get(url, timeout=120, follow_redirects=True)
        else:
            resp = httpx.get(url, timeout=60, follow_redirects=True)
        resp.raise_for_status()
    except Exception as e:
        progress.log_error(name, f"Failed to fetch: {e}")
        return

    ensure_synesis_catalog()
    existing_ids: set[str] = writer.existing_chunk_ids(SYNESIS_CATALOG) if skip_existing else set()

    if doc_type == "pdf":
        chunks = parse_pdf(resp.content, name, tags)
    elif doc_type == "html":
        chunks = parse_html(resp.text, name, tags)
    elif doc_type == "markdown":
        chunks = parse_markdown(resp.text, name, tags)
    else:
        logger.warning(f"Unknown document type '{doc_type}' for {name}")
        progress.log_error(name, f"Unknown type: {doc_type}")
        return

    if not chunks:
        progress.log_source(name, 0)
        return

    raw_entities: list[tuple[str, str, str, str, str]] = []
    skipped = 0
    for chunk in chunks:
        cid = chunk_id_hash(chunk.text, f"{name}:{chunk.section}")
        if cid in existing_ids:
            skipped += 1
            continue
        raw_entities.append((
            cid,
            chunk.text,
            f"doc:{name} section:{chunk.section}",
            chunk.section,
            ",".join(chunk.tags),
        ))

    if skipped:
        logger.info(f"  Skipped {skipped} unchanged section chunks")

    if not raw_entities:
        progress.log_source(name, 0)
        return

    texts = [e[1] for e in raw_entities]
    embeddings = embedder.embed_texts(texts)
    catalog_entities = []
    for (cid, text, source, section, tags_str), emb in zip(raw_entities, embeddings):
        catalog_entities.append(
            catalog_entity(
                chunk_id=cid,
                text=text[:8192],
                source=source[:512],
                language="architecture",
                embedding=emb,
                domain=domain,
                indexer_source="architecture",
                section=section[:256],
                document_name=name[:256],
                tags=tags_str[:512],
            )
        )

    count = writer.upsert_batch(SYNESIS_CATALOG, catalog_entities)
    progress.log_source(name, count)


def main() -> None:
    parser = argparse.ArgumentParser(description="Synesis Architecture Whitepaper Indexer")
    parser.add_argument("--sources", required=True, help="Path to sources.yaml")
    parser.add_argument("--document", default=None, help="Index only this document by name")
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

    documents = sources.get("documents", [])

    if args.document:
        documents = [d for d in documents if d["name"].lower() == args.document.lower()]
        if not documents:
            logger.error(f"Document '{args.document}' not found in sources")
            sys.exit(1)

    logger.info(f"Loaded {len(documents)} documents from {sources_path}")
    for d in documents:
        logger.info(f"  - {d['name']} ({d.get('type', 'unknown')}) -> {d['collection']}")

    if args.dry_run:
        logger.info("Dry run complete -- config and sources are valid")
        return

    try:
        writer = MilvusWriter()
    except Exception as e:
        logger.error(f"Failed to connect to Milvus: {e}")
        sys.exit(1)

    embedder = EmbedClient()
    progress = ProgressTracker(name="Architecture Whitepaper Indexer")

    for doc_cfg in documents:
        index_document(doc_cfg, writer, embedder, progress, skip_existing=not args.force)

    progress.log_complete()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("Architecture Whitepaper Indexer crashed with unhandled exception")
        sys.exit(1)
