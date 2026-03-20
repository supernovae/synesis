"""Handler: Web page crawler (Crawl4AI) with sitemap-first discovery, robots.txt, content gate.

Discovery modes (``config.discovery``):
- ``sitemap_first`` — expand sitemap(s), then fall back to same-host BFS if empty.
- ``sitemap_only`` — only URLs from sitemaps (no BFS fallback).
- ``bfs`` — legacy link following from the seed URL only.

Sitemaps are taken from ``config.sitemap_urls``, then robots.txt ``Sitemap:`` lines,
then ``/sitemap.xml`` and ``/sitemap_index.xml`` on the seed host.

Respects ``robots.txt`` crawl-delay (and ``config.min_request_interval`` floor) between fetches.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Any
from urllib.parse import urljoin, urlparse

from ..chunking import heading_aware_split
from ..content_gate import (
    GatePolicy,
    evaluate_page,
    normalize_url,
    url_passes_filter,
)
from ..robots_cache import (
    DEFAULT_USER_AGENT,
    can_fetch,
    crawl_delay_seconds,
    fetch_robots_info,
)
from ..sitemap_collect import collect_urls_from_sitemaps
from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.web_page")


@register
class WebPageHandler:
    handler_type = "web_page"
    source_type = "web_page"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = dict(source_config.get("config", {}))
        url = config.get("url", "")
        name = source_config.get("name", url)

        if not url:
            logger.error("web_page handler requires config.url")
            return []

        policy = self._build_policy(config)

        pages = asyncio.get_event_loop().run_until_complete(
            _crawl_pages(url, config, policy),
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
        if "max_depth" in config and isinstance(config["max_depth"], int):
            policy.max_depth = max(0, int(config["max_depth"]))
        return policy


async def _crawl_pages(seed_url: str, config: dict[str, Any], policy: GatePolicy) -> list[dict[str, str]]:
    try:
        from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
    except ImportError:
        logger.error("crawl4ai not installed. Run: pip install crawl4ai")
        return []

    max_pages = max(1, int(config.get("max_pages", 80)))
    discovery = (config.get("discovery") or "sitemap_first").lower()
    respect_robots = bool(config.get("respect_robots", True))
    user_agent = (config.get("user_agent") or DEFAULT_USER_AGENT).strip()
    min_interval = float(config.get("min_request_interval", 0.35))

    rinfo = await asyncio.to_thread(fetch_robots_info, seed_url)
    robots_delay = crawl_delay_seconds(user_agent, rinfo) if respect_robots else 0.0
    pause = max(min_interval, robots_delay)

    urls_to_fetch: list[str] = []

    if discovery in ("sitemap_first", "sitemap_only"):
        sitemap_seeds: list[str] = []
        raw = config.get("sitemap_urls")
        if isinstance(raw, list):
            sitemap_seeds.extend(str(x).strip() for x in raw if x)
        if respect_robots:
            sitemap_seeds.extend(u for u in rinfo.sitemap_urls if u not in sitemap_seeds)
        parsed = urlparse(seed_url)
        if parsed.scheme and parsed.netloc:
            base = f"{parsed.scheme}://{parsed.netloc}"
            for tail in ("sitemap.xml", "sitemap_index.xml", "sitemap-index.xml"):
                guess = urljoin(base + "/", tail)
                if guess not in sitemap_seeds:
                    sitemap_seeds.append(guess)

        max_sm = int(config.get("max_sitemap_expand", 24))
        urls_to_fetch = await asyncio.to_thread(
            collect_urls_from_sitemaps,
            seed_url,
            sitemap_seeds,
            policy,
            max_urls=max_pages * 4,
            max_sitemap_hops=max_sm,
        )
        urls_to_fetch = _dedupe_preserve_order(urls_to_fetch)
        urls_to_fetch = urls_to_fetch[: max_pages * 2]

        seed_norm = normalize_url(seed_url)
        if not any(normalize_url(u) == seed_norm for u in urls_to_fetch):
            urls_to_fetch.insert(0, seed_url)
        else:
            urls_to_fetch = [u for u in urls_to_fetch if normalize_url(u) != seed_norm]
            urls_to_fetch.insert(0, seed_url)

        logger.info(
            "web_page_sitemap_discovery seed=%s urls=%d discovery=%s",
            seed_url,
            len(urls_to_fetch),
            discovery,
        )

    if discovery in ("sitemap_first", "sitemap_only") and urls_to_fetch:
        pages = await _fetch_url_list(
            urls_to_fetch,
            seed_url,
            policy,
            user_agent,
            pause,
            respect_robots,
            rinfo,
            max_pages,
        )
        if pages:
            return pages
        if discovery == "sitemap_only":
            return []

    follow_links = bool(config.get("follow_links", True))
    max_depth = max(0, int(config.get("max_depth", 4)))
    return await _crawl_bfs(
        seed_url,
        follow_links,
        max_depth,
        policy,
        user_agent,
        pause,
        respect_robots,
        rinfo,
        max_pages,
    )


def _dedupe_preserve_order(urls: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for u in urls:
        c = normalize_url(u)
        if c in seen:
            continue
        seen.add(c)
        out.append(u)
    return out


async def _fetch_url_list(
    urls: list[str],
    seed_url: str,
    policy: GatePolicy,
    user_agent: str,
    pause: float,
    respect_robots: bool,
    rinfo: Any,
    max_pages: int,
) -> list[dict[str, str]]:
    from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
    from ..extract import html_to_markdown, normalize_doc_markdown

    seed_host = urlparse(seed_url).hostname or ""
    pages: list[dict[str, str]] = []
    crawler_config = CrawlerRunConfig()

    async with AsyncWebCrawler() as crawler:
        for i, url in enumerate(urls):
            if len(pages) >= max_pages:
                break
            if i > 0 and pause > 0:
                await asyncio.sleep(pause)

            if respect_robots and not can_fetch(url, user_agent, rinfo):
                logger.debug("robots_disallow url=%s", url)
                continue

            passes, reason = url_passes_filter(url, policy, seed_host=seed_host)
            if not passes:
                logger.debug("url_filtered (%s): %s", reason, url)
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

            depth = 0 if normalize_url(url) == normalize_url(seed_url) else 1
            verdict = evaluate_page(url, html, policy, depth=depth)
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

            md = normalize_doc_markdown(md)
            pages.append({"url": url, "markdown": md})

    return pages


async def _crawl_bfs(
    seed_url: str,
    follow_links: bool,
    max_depth: int,
    policy: GatePolicy,
    user_agent: str,
    pause: float,
    respect_robots: bool,
    rinfo: Any,
    max_pages: int,
) -> list[dict[str, str]]:
    from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
    from ..extract import html_to_markdown, normalize_doc_markdown

    pages: list[dict[str, str]] = []
    visited: set[str] = set()
    seed_host = urlparse(seed_url).hostname or ""
    crawler_config = CrawlerRunConfig()
    queue: deque[tuple[str, int]] = deque([(seed_url, 0)])
    request_idx = 0

    async with AsyncWebCrawler() as crawler:
        while queue and len(pages) < max_pages:
            url, depth = queue.popleft()
            canonical = normalize_url(url)

            if canonical in visited:
                continue
            visited.add(canonical)

            passes, reason = url_passes_filter(url, policy, seed_host=seed_host)
            if not passes and depth > 0:
                logger.debug("URL filtered (%s): %s", reason, url)
                continue

            if respect_robots and not can_fetch(url, user_agent, rinfo):
                logger.debug("robots_disallow bfs url=%s", url)
                continue

            if request_idx > 0 and pause > 0:
                await asyncio.sleep(pause)
            request_idx += 1

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

            verdict = evaluate_page(url, html, policy, depth=depth)

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

            md = normalize_doc_markdown(md)
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
    max_per_page = 30

    for link in internal_links[:max_per_page]:
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

    return children[:25]
