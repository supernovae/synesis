"""Handler: Web page crawler (Crawl4AI).

Crawls trusted URLs, converts HTML to Markdown, then chunks with
heading-aware splitting. Supports follow_links for depth-1 same-domain crawling.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any
from urllib.parse import urlparse

from ..chunking import heading_aware_split
from . import register
from .base import BaseHandler, Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.web_page")


@register
class WebPageHandler:
    handler_type = "web_page"
    source_type = "web_page"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        url = config.get("url", "")
        follow_links = config.get("follow_links", False)
        name = source_config.get("name", url)

        if not url:
            logger.error("web_page handler requires config.url")
            return []

        pages = asyncio.get_event_loop().run_until_complete(
            _crawl_url(url, follow_links),
        )
        if not pages:
            logger.warning("No content retrieved from %s", url)
            return []

        docs: list[RawDocument] = []
        for page in pages:
            docs.append(
                RawDocument(
                    doc_id=f"web:{name}:{page['url']}",
                    name=name,
                    content=page["markdown"],
                    source_url=page["url"],
                )
            )

        logger.info("Crawled %d pages from %s", len(docs), url)
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


async def _crawl_url(url: str, follow_links: bool = False) -> list[dict[str, str]]:
    """Crawl a URL using Crawl4AI. Returns list of {url, markdown} dicts."""
    try:
        from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
    except ImportError:
        logger.error("crawl4ai not installed. Run: pip install crawl4ai")
        return []

    pages: list[dict[str, str]] = []
    config = CrawlerRunConfig()

    async with AsyncWebCrawler() as crawler:
        result = await crawler.arun(url=url, config=config)
        if result and result.markdown:
            pages.append({"url": url, "markdown": result.markdown})

        if follow_links and result and result.links:
            seed_host = urlparse(url).hostname or ""
            internal_links = getattr(result.links, "internal", []) or []
            child_urls = []
            for link in internal_links[:20]:
                href = link if isinstance(link, str) else getattr(link, "href", "")
                if not href:
                    continue
                if urlparse(href).hostname == seed_host and href != url:
                    child_urls.append(href)

            for child_url in child_urls[:10]:
                try:
                    child_result = await crawler.arun(url=child_url, config=config)
                    if child_result and child_result.markdown:
                        pages.append({"url": child_url, "markdown": child_result.markdown})
                except Exception as e:
                    logger.warning("Failed to crawl child %s: %s", child_url, e)

    return pages
