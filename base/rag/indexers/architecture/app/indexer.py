"""Architecture Whitepaper Indexer.

Downloads whitepapers and design pattern documentation (PDFs, HTML,
Markdown), parses by section, embeds, and upserts into Milvus.
Gives the Critic node access to architectural best practices for
its Safety-II "What-If" analysis.

Usage:
    python -m app.indexer --sources /data/sources.yaml
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import httpx
import yaml
from pymilvus import FieldSchema, DataType

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "ingestion"))
from app.indexer_base import (
    MilvusWriter,
    EmbedClient,
    ProgressTracker,
    chunk_id_hash,
)

from .pdf_parser import parse_pdf
from .html_parser import parse_html, parse_markdown

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.indexer.architecture")


ARCH_EXTRA_FIELDS = [
    FieldSchema(name="section", dtype=DataType.VARCHAR, max_length=256),
    FieldSchema(name="document_name", dtype=DataType.VARCHAR, max_length=256),
    FieldSchema(name="tags", dtype=DataType.VARCHAR, max_length=512),
]


def index_document(
    doc_cfg: dict,
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    skip_existing: bool = True,
) -> None:
    """Fetch and index a single architecture document."""
    name = doc_cfg["name"]
    url = doc_cfg["url"]
    doc_type = doc_cfg.get("type", "pdf")
    collection = doc_cfg["collection"]
    tags = doc_cfg.get("tags", [])

    logger.info(f"Fetching document: {name} ({doc_type}) from {url}")

    try:
        if doc_type == "pdf":
            resp = httpx.get(url, timeout=120, follow_redirects=True)
        else:
            resp = httpx.get(url, timeout=60, follow_redirects=True)
        resp.raise_for_status()
    except Exception as e:
        progress.log_error(name, f"Failed to fetch: {e}")
        return

    writer.ensure_collection(
        collection,
        extra_fields=ARCH_EXTRA_FIELDS,
        description=f"Architecture docs: {collection}",
    )

    existing_ids: set[str] = set()
    if skip_existing:
        existing_ids = writer.existing_chunk_ids(collection)

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

    entities = []
    skipped = 0
    for chunk in chunks:
        cid = chunk_id_hash(chunk.text, f"{name}:{chunk.section}")
        if cid in existing_ids:
            skipped += 1
            continue
        entities.append({
            "chunk_id": cid,
            "text": chunk.text[:8192],
            "source": f"doc:{name} section:{chunk.section}"[:512],
            "section": chunk.section[:256],
            "document_name": name[:256],
            "tags": ",".join(chunk.tags)[:512],
            "language": "architecture",
            "embedding": None,
        })

    if skipped:
        logger.info(f"  Skipped {skipped} unchanged section chunks")

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
    parser = argparse.ArgumentParser(description="Synesis Architecture Whitepaper Indexer")
    parser.add_argument("--sources", required=True, help="Path to sources.yaml")
    parser.add_argument("--document", default=None, help="Index only this document by name")
    parser.add_argument("--force", action="store_true", help="Re-embed all chunks even if already indexed")
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

    writer = MilvusWriter()
    embedder = EmbedClient()
    progress = ProgressTracker(name="Architecture Whitepaper Indexer")

    for doc_cfg in documents:
        index_document(doc_cfg, writer, embedder, progress, skip_existing=not args.force)

    progress.log_complete()


if __name__ == "__main__":
    main()
