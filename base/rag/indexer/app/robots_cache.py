"""Fetch and cache robots.txt for crawl-delay and allow/disallow checks."""

from __future__ import annotations

import logging
import re
import time
import urllib.robotparser
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx

logger = logging.getLogger("synesis.indexer.robots")

_SITEMAP_LINE = re.compile(r"^\s*Sitemap:\s*(\S+)\s*$", re.IGNORECASE | re.MULTILINE)

DEFAULT_USER_AGENT = "SynesisIndexer/1.0 (+https://github.com/supernovae/synesis)"


@dataclass
class RobotsInfo:
    """Parsed robots.txt rules + discovered sitemap URLs."""

    parser: urllib.robotparser.RobotFileParser
    sitemap_urls: list[str] = field(default_factory=list)
    fetch_failed: bool = False


_cache: dict[str, tuple[float, RobotsInfo]] = {}
_CACHE_TTL_SEC = 3600.0


def _robots_url_for_seed(seed_url: str) -> str:
    p = urlparse(seed_url)
    if not p.scheme or not p.netloc:
        return ""
    return f"{p.scheme}://{p.netloc}/robots.txt"


def _parse_sitemap_lines(body: str) -> list[str]:
    return [m.group(1).strip() for m in _SITEMAP_LINE.finditer(body)]


def fetch_robots_info(seed_url: str, *, timeout: float = 20.0) -> RobotsInfo:
    """Load robots.txt for the seed URL's origin (cached)."""
    robots_url = _robots_url_for_seed(seed_url)
    if not robots_url:
        rp = urllib.robotparser.RobotFileParser()
        rp.parse([])
        return RobotsInfo(parser=rp, sitemap_urls=[], fetch_failed=True)

    netloc = urlparse(robots_url).netloc.lower()
    now = time.monotonic()
    hit = _cache.get(netloc)
    if hit and now - hit[0] < _CACHE_TTL_SEC:
        return hit[1]

    rp = urllib.robotparser.RobotFileParser()
    sitemap_urls: list[str] = []
    failed = False
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            r = client.get(robots_url, headers={"User-Agent": DEFAULT_USER_AGENT})
            if r.status_code == 200 and r.text:
                lines = r.text.splitlines()
                rp.parse(lines)
                sitemap_urls = _parse_sitemap_lines(r.text)
            else:
                rp.parse([])
    except Exception as e:
        logger.debug("robots_fetch_failed url=%s err=%s", robots_url, e)
        rp.parse([])
        failed = True

    info = RobotsInfo(parser=rp, sitemap_urls=sitemap_urls, fetch_failed=failed)
    _cache[netloc] = (now, info)
    return info


def can_fetch(url: str, user_agent: str, info: RobotsInfo) -> bool:
    """Return True if robots.txt allows fetching this URL (empty robots allows all)."""
    if info.fetch_failed and not info.sitemap_urls:
        # Conservative: allow if we could not load robots (many CDNs still OK)
        return True
    try:
        return info.parser.can_fetch(user_agent, url)
    except Exception:
        return True


def crawl_delay_seconds(user_agent: str, info: RobotsInfo) -> float:
    """Crawl-delay from robots.txt for this UA, or 0.0."""
    try:
        delay = info.parser.crawl_delay(user_agent)
        if delay is not None and delay > 0:
            return float(delay)
        delay_any = info.parser.crawl_delay("*")
        if delay_any is not None and delay_any > 0:
            return float(delay_any)
    except Exception:
        pass
    return 0.0


def clear_robots_cache() -> None:
    _cache.clear()
