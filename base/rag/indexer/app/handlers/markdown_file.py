"""Handler: Local markdown files (curated knowledge base).

Reads markdown files from a local directory path, then chunks
with heading-aware splitting.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from ..chunking import heading_aware_split
from . import register
from .base import BaseHandler, Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.markdown_file")


@register
class MarkdownFileHandler:
    handler_type = "markdown_file"
    source_type = "markdown"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        path = config.get("path", "")
        name = source_config.get("name", path)

        if not path:
            logger.error("markdown_file handler requires config.path")
            return []

        base_path = Path(path)
        if not base_path.exists():
            logger.error("Path does not exist: %s", path)
            return []

        docs: list[RawDocument] = []

        if base_path.is_file() and base_path.suffix == ".md":
            content = base_path.read_text(encoding="utf-8", errors="replace")
            docs.append(
                RawDocument(
                    doc_id=f"file:{base_path}",
                    name=f"{name}: {base_path.name}",
                    content=content,
                    source_url="",
                    metadata={"file_path": str(base_path)},
                )
            )
        elif base_path.is_dir():
            for md_file in sorted(base_path.rglob("*.md")):
                if any(part.startswith(".") for part in md_file.parts):
                    continue
                try:
                    content = md_file.read_text(encoding="utf-8", errors="replace")
                except Exception as e:
                    logger.warning("Failed to read %s: %s", md_file, e)
                    continue
                if not content.strip():
                    continue

                rel = md_file.relative_to(base_path)
                docs.append(
                    RawDocument(
                        doc_id=f"file:{rel}",
                        name=f"{name}: {rel}",
                        content=content,
                        source_url="",
                        metadata={"file_path": str(rel)},
                    )
                )

        logger.info("Collected %d markdown files from %s", len(docs), path)
        return docs

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        content = doc.content if isinstance(doc.content, str) else doc.content.decode("utf-8", errors="replace")
        text_chunks = heading_aware_split(content, document_name=doc.name)

        return [
            Chunk(
                text=tc.text,
                section=tc.section,
                heading_path=tc.heading_path,
                chunk_index=tc.chunk_index,
            )
            for tc in text_chunks
        ]
