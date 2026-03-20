"""Discover page URLs from sitemap.xml / sitemap index (filtered by policy)."""

from __future__ import annotations

import gzip
import logging
import xml.etree.ElementTree as ET
from typing import TYPE_CHECKING
from urllib.parse import urlparse

import httpx

from .content_gate import GatePolicy, normalize_url, url_passes_filter
from .robots_cache import DEFAULT_USER_AGENT

if TYPE_CHECKING:
    pass

logger = logging.getLogger("synesis.indexer.sitemap")

# Sitemap 0.9 namespace
_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"


def _local_tag(elem: ET.Element) -> str:
    t = elem.tag
    return t.split("}", 1)[-1] if t.startswith("{") else t


def _fetch_xml(client: httpx.Client, url: str, timeout: float) -> str | None:
    try:
        r = client.get(
            url,
            timeout=timeout,
            headers={"User-Agent": DEFAULT_USER_AGENT, "Accept": "application/xml,text/xml,*/*"},
        )
        r.raise_for_status()
        data = r.content
        if url.lower().endswith(".gz") or "gzip" in (r.headers.get("content-encoding") or "").lower():
            data = gzip.decompress(data)
        return data.decode("utf-8", errors="replace")
    except Exception as e:
        logger.debug("sitemap_fetch_failed url=%s err=%s", url, e)
        return None


def _parse_sitemap_xml(xml_text: str) -> tuple[list[str], list[str]]:
    """Return (nested_sitemap_urls, page_urls)."""
    nested: list[str] = []
    pages: list[str] = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        logger.warning("sitemap_parse_error: %s", e)
        return nested, pages

    root_tag = _local_tag(root)
    if root_tag == "sitemapindex":
        for child in root:
            if _local_tag(child) != "sitemap":
                continue
            loc = None
            for el in child:
                if _local_tag(el) == "loc" and el.text:
                    loc = el.text.strip()
                    break
            if loc:
                nested.append(loc)
    elif root_tag == "urlset":
        for child in root:
            if _local_tag(child) != "url":
                continue
            loc = None
            for el in child:
                if _local_tag(el) == "loc" and el.text:
                    loc = el.text.strip()
                    break
            if loc:
                pages.append(loc)
    return nested, pages


def collect_urls_from_sitemaps(
    seed_url: str,
    sitemap_seeds: list[str],
    policy: GatePolicy,
    *,
    max_urls: int = 500,
    max_sitemap_hops: int = 12,
    timeout: float = 25.0,
) -> list[str]:
    """Breadth-first expansion of sitemap indexes; filter URLs with url_passes_filter."""
    seed_host = (urlparse(seed_url).hostname or "").lower()
    seen_sitemaps: set[str] = set()
    seen_pages: set[str] = set()
    ordered_pages: list[str] = []

    queue: list[str] = []
    for s in sitemap_seeds:
        if s and s not in seen_sitemaps:
            queue.append(s)

    if not queue:
        return []

    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        hops = 0
        while queue and hops < max_sitemap_hops and len(ordered_pages) < max_urls:
            sm_url = queue.pop(0)
            canon_sm = normalize_url(sm_url)
            if canon_sm in seen_sitemaps:
                continue
            seen_sitemaps.add(canon_sm)
            hops += 1

            xml_text = _fetch_xml(client, sm_url, timeout)
            if not xml_text:
                continue

            nested, pages = _parse_sitemap_xml(xml_text)
            for n in nested:
                cn = normalize_url(n)
                if cn not in seen_sitemaps:
                    queue.append(n)

            for u in pages:
                if len(ordered_pages) >= max_urls:
                    break
                cu = normalize_url(u)
                if cu in seen_pages:
                    continue
                ok, reason = url_passes_filter(u, policy, seed_host=seed_host)
                if not ok:
                    logger.debug("sitemap_url_filtered %s (%s)", u, reason)
                    continue
                seen_pages.add(cu)
                ordered_pages.append(u)

    return ordered_pages
