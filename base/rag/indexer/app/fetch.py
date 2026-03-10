"""Smart HTML fetching with automatic browser fallback.

Tries a lightweight httpx GET first.  If the response looks like a
JS-rendered shell (SPA with minimal visible text), falls back to
crawl4ai's headless Chromium to render the page before returning HTML.

PDF and other binary content should NOT go through this — use httpx
directly for those.
"""

from __future__ import annotations

import asyncio
import logging
import re

logger = logging.getLogger("synesis.indexer.fetch")

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

_MIN_VISIBLE_TEXT = 200


def _is_js_shell(html: str) -> bool:
    """Heuristic: HTML is likely a JS-rendered shell if visible text is tiny.

    Strips all tags and checks whether the remaining visible text is
    shorter than the threshold.  Common SPA frameworks emit a small HTML
    scaffold (``<div id="root"></div>``) with all real content injected
    by JavaScript at runtime — httpx can't execute that JS.
    """
    if len(html) < 500:
        return False
    text = _TAG_RE.sub(" ", html)
    text = _WS_RE.sub(" ", text).strip()
    return len(text) < _MIN_VISIBLE_TEXT


def _browser_fetch(url: str) -> str:
    """Fetch a single page via crawl4ai's headless Chromium."""
    try:
        from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
    except ImportError:
        logger.debug("crawl4ai not available for browser fallback")
        return ""

    async def _run() -> str:
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url, config=CrawlerRunConfig())
            if result:
                return getattr(result, "html", "") or ""
            return ""

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                return pool.submit(lambda: asyncio.run(_run())).result(timeout=60)
        return loop.run_until_complete(_run())
    except Exception as e:
        logger.warning("Browser fallback failed for %s: %s", url, e)
        return ""


def ensure_rendered(html: str, url: str) -> str:
    """Return fully-rendered HTML, falling back to browser if needed.

    Call this after an httpx fetch for any URL expected to be an HTML
    page.  If the httpx-fetched HTML has enough visible text it is
    returned as-is (fast path).  Otherwise, crawl4ai re-fetches the
    page with headless Chromium so JavaScript can execute.

    Args:
        html: HTML string from the httpx response.
        url:  The original URL (needed for the browser fallback).

    Returns:
        HTML string — either the original or the browser-rendered version.
    """
    if html and not _is_js_shell(html):
        return html

    reason = "empty response" if not html else "JS shell detected"
    logger.info("Browser fallback for %s (%s)", url, reason)

    rendered = _browser_fetch(url)
    return rendered or html or ""
