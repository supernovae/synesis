"""Handler: HTML documents (architecture docs, design patterns).

Fetches HTML from URLs, converts to Markdown via trafilatura,
then chunks with heading-aware splitting.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..chunking import heading_aware_split
from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.html_document")


@register
class HTMLDocumentHandler:
    handler_type = "html_document"
    source_type = "html"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        url = config.get("url", "")
        name = source_config.get("name", url)

        if not url:
            logger.error("html_document handler requires config.url")
            return []

        try:
            with httpx.Client(timeout=30, follow_redirects=True) as client:
                resp = client.get(url)
                resp.raise_for_status()
        except Exception as e:
            logger.error("Failed to fetch HTML %s: %s", url, e)
            return []

        from ..fetch import ensure_rendered

        content = ensure_rendered(resp.text, url)

        return [
            RawDocument(
                doc_id=f"html:{name}",
                name=name,
                content=content,
                source_url=url,
            )
        ]

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        from ..extract import html_to_markdown, normalize_doc_markdown

        html = doc.content if isinstance(doc.content, str) else doc.content.decode("utf-8", errors="replace")
        md = html_to_markdown(html)
        if not md:
            logger.warning("trafilatura returned empty for %s", doc.name)
            return []

        md = normalize_doc_markdown(md)
        text_chunks = heading_aware_split(md, document_name=doc.name)

        return [
            Chunk(
                text=tc.text,
                section=tc.section,
                heading_path=tc.heading_path,
                chunk_index=tc.chunk_index,
            )
            for tc in text_chunks
        ]
