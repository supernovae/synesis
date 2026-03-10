"""Handler: Web page crawler (Crawl4AI) with content gate.

Crawls trusted URLs using Crawl4AI for JS-rendered page fetching,
converts HTML to Markdown via trafilatura, then chunks with
heading-aware splitting.  Crawl4AI is retained only as a
browser/fetcher; its built-in markdown converter is bypassed in
favour of the unified trafilatura pipeline.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Any
from urllib.parse import urlparse

from ..chunking import heading_aware_split
from ..content_gate import (
    GatePolicy,
    evaluate_page,
    normalize_url,
    url_passes_filter,
)
from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.web_page")

_MAX_PAGES_PER_SOURCE = 50


@register
class WebPageHandler:
    handler_type = "web_page"
    source_type = "web_page"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        url = config.get("url", "")
        follow_links = config.get("follow_links", False)
        max_depth = config.get("max_depth", 2)
        name = source_config.get("name", url)

        if not url:
            logger.error("web_page handler requires config.url")
            return []

        policy = self._build_policy(config)

        pages = asyncio.get_event_loop().run_until_complete(
            _crawl_with_gate(url, follow_links, max_depth, policy),
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

    @staticmethod
    def _build_policy(config: dict[str, Any]) -> GatePolicy:
        """Build a GatePolicy, optionally narrowing allowed_prefixes from config."""
        policy = GatePolicy()
        prefixes = config.get("allowed_prefixes")
        if prefixes and isinstance(prefixes, list):
            policy.allowed_prefixes = prefixes
        if config.get("allow_blog"):
            policy.allow_blog = True
        return policy


async def _crawl_with_gate(
    seed_url: str,
    follow_links: bool,
    max_depth: int,
    policy: GatePolicy,
) -> list[dict[str, str]]:
    """BFS crawl with content gate at each level."""
    try:
        from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
    except ImportError:
        logger.error("crawl4ai not installed. Run: pip install crawl4ai")
        return []

    from ..extract import html_to_markdown

    pages: list[dict[str, str]] = []
    visited: set[str] = set()
    seed_host = urlparse(seed_url).hostname or ""
    crawler_config = CrawlerRunConfig()

    queue: deque[tuple[str, int]] = deque([(seed_url, 0)])

    async with AsyncWebCrawler() as crawler:
        while queue and len(pages) < _MAX_PAGES_PER_SOURCE:
            url, depth = queue.popleft()
            canonical = normalize_url(url)

            if canonical in visited:
                continue
            visited.add(canonical)

            passes, reason = url_passes_filter(url, policy, seed_host=seed_host)
            if not passes and depth > 0:
                logger.debug("URL filtered (%s): %s", reason, url)
                continue

            try:
                result = await crawler.arun(url=url, config=crawler_config)
            except Exception as e:
                logger.warning("Crawl failed for %s: %s", url, e)
                continue

            if not result:
                continue

            html = getattr(result, "html", "") or ""
            if not html:
                continue

            verdict = evaluate_page(html, html, policy, depth=depth)

            if verdict and not verdict.should_index and depth > 0:
                logger.info(
                    "Page rejected (score=%.2f, type=%s): %s — %s",
                    verdict.quality_score,
                    verdict.doc_type,
                    url,
                    verdict.rejection_reason,
                )
                continue

            md = html_to_markdown(html)
            if not md:
                logger.debug("trafilatura returned empty for %s", url)
                continue

            pages.append({"url": url, "markdown": md})

            if not follow_links or depth >= max_depth:
                continue
            if verdict and not verdict.should_follow_children:
                continue

            child_urls = _extract_child_urls(result, seed_host, policy, visited)
            for child in child_urls:
                queue.append((child, depth + 1))

    return pages


def _extract_child_urls(
    result: Any,
    seed_host: str,
    policy: GatePolicy,
    visited: set[str],
) -> list[str]:
    """Extract and filter child URLs from a crawl result."""
    if not result.links:
        return []

    internal_links = getattr(result.links, "internal", []) or []
    children: list[str] = []

    for link in internal_links[:30]:
        href = link if isinstance(link, str) else getattr(link, "href", "")
        if not href:
            continue

        canonical = normalize_url(href)
        if canonical in visited:
            continue

        parsed = urlparse(href)
        if parsed.hostname and parsed.hostname.lower() != seed_host.lower():
            continue

        passes, _reason = url_passes_filter(href, policy, seed_host=seed_host)
        if not passes:
            continue

        children.append(href)

    return children[:20]
