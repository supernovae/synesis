"""Knowledge Base Indexer — loads curated markdown docs into synesis_catalog.

Reads all .md files from /data/knowledge-base/, chunks by markdown sections,
embeds via the embedder service, and upserts to Milvus. Idempotent: skips
chunks already present unless --force is used.
"""

from __future__ import annotations

import hashlib
import logging
import sys
from pathlib import Path

from .catalog_schema import SYNESIS_CATALOG, catalog_entity, ensure_synesis_catalog
from .indexer_base import EmbedClient, MilvusWriter, ProgressTracker, chunk_id_hash

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.indexer.knowledge_base")

DOMAIN = "knowledge"
INDEXER_SOURCE = "knowledge_base"


def _split_markdown_sections(content: str) -> list[dict[str, str]]:
    """Split markdown by H2 headings, keeping each section as a chunk."""
    import re

    sections: list[dict[str, str]] = []
    parts = re.split(r"^(##\s+.+)$", content, flags=re.MULTILINE)

    current_heading = ""
    for part in parts:
        stripped = part.strip()
        if not stripped:
            continue
        if stripped.startswith("## "):
            current_heading = stripped.lstrip("#").strip()
        else:
            if stripped:
                sections.append({"section": current_heading, "text": stripped})

    if not sections and content.strip():
        sections.append({"section": "", "text": content.strip()})

    return sections


def _chunk_section(text: str, max_words: int = 600, overlap_words: int = 80) -> list[str]:
    """Split a section into overlapping word-based chunks if it exceeds max_words."""
    words = text.split()
    if len(words) <= max_words:
        return [text]

    chunks = []
    start = 0
    while start < len(words):
        end = min(start + max_words, len(words))
        chunks.append(" ".join(words[start:end]))
        if end >= len(words):
            break
        start = end - overlap_words
    return chunks


def index_directory(
    kb_path: Path,
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    skip_existing: bool = True,
) -> None:
    """Index all .md files in the knowledge-base directory."""
    md_files = sorted(kb_path.glob("*.md"))
    if not md_files:
        logger.warning(f"No .md files found in {kb_path}")
        return

    ensure_synesis_catalog()
    existing_ids = writer.existing_chunk_ids(SYNESIS_CATALOG) if skip_existing else set()

    chunks_to_embed: list[tuple[str, str, str, str, str]] = []

    for md_file in md_files:
        doc_name = md_file.stem
        content = md_file.read_text(encoding="utf-8")
        if not content.strip():
            logger.warning(f"Skipping empty file: {md_file.name}")
            continue

        sections = _split_markdown_sections(content)
        for section in sections:
            for chunk_text in _chunk_section(section["text"]):
                cid = chunk_id_hash(chunk_text, f"kb:{doc_name}:{section['section']}")
                if cid in existing_ids:
                    continue
                tags = f"knowledge_base,{doc_name}"
                chunks_to_embed.append((cid, chunk_text, doc_name, section["section"], tags))

    if not chunks_to_embed:
        logger.info("All chunks already indexed (or no content). Nothing to do.")
        progress.log_source("knowledge-base", 0)
        return

    logger.info(f"Embedding {len(chunks_to_embed)} chunks from {len(md_files)} files...")
    texts = [c[1] for c in chunks_to_embed]
    embeddings = embedder.embed_texts(texts)

    entities = []
    for (cid, text, doc_name, section, tags_str), emb in zip(chunks_to_embed, embeddings):
        entities.append(
            catalog_entity(
                chunk_id=cid,
                text=text[:8192],
                source=f"kb:{doc_name} section:{section}"[:512],
                language=DOMAIN,
                embedding=emb,
                domain=DOMAIN,
                indexer_source=INDEXER_SOURCE,
                section=section[:256],
                document_name=doc_name[:256],
                tags=tags_str[:512],
                origin_type="internal",
                authority="vetted",
            )
        )

    count = writer.upsert_batch(SYNESIS_CATALOG, entities)
    progress.log_source("knowledge-base", count)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Synesis Knowledge Base Indexer")
    parser.add_argument(
        "--path",
        default="/data/knowledge-base",
        help="Path to directory containing .md files (default: /data/knowledge-base)",
    )
    parser.add_argument("--force", action="store_true", help="Re-embed all chunks (ignore existing)")
    parser.add_argument("--dry-run", action="store_true", help="List files without indexing")
    args = parser.parse_args()

    kb_path = Path(args.path)
    if not kb_path.is_dir():
        logger.error(f"Knowledge base directory not found: {kb_path}")
        sys.exit(1)

    md_files = sorted(kb_path.glob("*.md"))
    logger.info(f"Found {len(md_files)} markdown files in {kb_path}")
    for f in md_files:
        logger.info(f"  - {f.name} ({f.stat().st_size} bytes)")

    if args.dry_run:
        logger.info("Dry run complete")
        return

    try:
        writer = MilvusWriter()
    except Exception as e:
        logger.error(f"Failed to connect to Milvus: {e}")
        sys.exit(1)

    embedder = EmbedClient()
    progress = ProgressTracker(name="Knowledge Base Indexer")

    index_directory(kb_path, writer, embedder, progress, skip_existing=not args.force)

    progress.log_complete()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("Knowledge Base Indexer crashed")
        sys.exit(1)
