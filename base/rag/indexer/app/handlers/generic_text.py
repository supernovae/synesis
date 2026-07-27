"""Handler: Generic text catch-all for unrecognized file formats.

Fetches content from a URL or local path and applies paragraph-boundary
chunking with overlap. Use this for config files, logs, READMEs in odd
formats, or any content where no specialized handler exists.
"""

from __future__ import annotations

import logging
from typing import Any

from ..safe_http import get_public_https
from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.generic_text")

MAX_CHUNK_CHARS = 6000
OVERLAP_CHARS = 200


@register
class GenericTextHandler:
    handler_type = "generic_text"
    source_type = "text"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        url = config.get("url", "")
        name = source_config.get("name", url)

        if not url:
            logger.error("generic_text handler requires config.url")
            return []

        try:
            content = get_public_https(url, timeout=30).text
        except Exception as e:
            logger.error("Failed to fetch %s: %s", url, e)
            return []

        return [
            RawDocument(
                doc_id=f"text:{name}",
                name=name,
                content=content,
                source_url=url,
            )
        ]

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        content = doc.content if isinstance(doc.content, str) else doc.content.decode("utf-8", errors="replace")

        if not content.strip():
            return []

        if len(content) <= MAX_CHUNK_CHARS:
            return [
                Chunk(
                    text=content,
                    section=doc.name,
                    heading_path=doc.name,
                    chunk_index=0,
                    metadata={"content_format": "text"},
                )
            ]

        paragraphs = content.split("\n\n")
        chunks: list[Chunk] = []
        current: list[str] = []
        current_len = 0
        idx = 0

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            if current_len + len(para) > MAX_CHUNK_CHARS and current:
                chunk_text = "\n\n".join(current)
                chunks.append(
                    Chunk(
                        text=chunk_text,
                        section=f"{doc.name} (part {idx + 1})",
                        heading_path=doc.name,
                        chunk_index=idx,
                        metadata={"content_format": "text"},
                    )
                )
                idx += 1

                overlap_text = chunk_text[-OVERLAP_CHARS:] if len(chunk_text) > OVERLAP_CHARS else ""
                current = [overlap_text] if overlap_text else []
                current_len = len(overlap_text)

            current.append(para)
            current_len += len(para) + 2

        if current:
            chunks.append(
                Chunk(
                    text="\n\n".join(current),
                    section=f"{doc.name} (part {idx + 1})" if idx > 0 else doc.name,
                    heading_path=doc.name,
                    chunk_index=idx,
                    metadata={"content_format": "text"},
                )
            )

        return chunks
