"""Web search client -- async wrapper around SearXNG for live web context.

Provides two search profiles:
  - "web": General knowledge via Google/Bing/DuckDuckGo
  - "code": Code-specific via GitHub/StackOverflow

Implements a Corrective-RAG-inspired pipeline (arxiv 2401.15884):
  SearXNG search → page fetch (top N) → BM25 relevance filter → dedup → token-budgeted assembly

Includes a per-profile circuit breaker so SearXNG downtime never blocks
the LangGraph pipeline. All failures return empty results gracefully.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .config import settings
from .injection_scanner import reduce_context_on_injection, scan_web_content

logger = logging.getLogger("synesis.web_search")

PROFILE_PARAMS: dict[str, dict[str, str]] = {
    "web": {"categories": "general"},
    "code": {"engines": "github,stackoverflow"},
}

try:
    from prometheus_client import Counter, Histogram

    _search_counter = Counter(
        "synesis_web_search_total",
        "Web searches by profile and outcome",
        ["profile", "outcome"],
    )
    _search_latency = Histogram(
        "synesis_web_search_duration_seconds",
        "Web search latency by profile",
        ["profile"],
        buckets=[0.1, 0.25, 0.5, 1, 2, 5, 10],
    )
except Exception:
    _search_counter = None
    _search_latency = None


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str
    engine: str = ""
    score: float = 0.0
    relevance: float = 0.0
    fetched_content: str = ""
    authority: str = "external"
    origin_type: str = "external"
    is_trusted: bool = False


# ---------------------------------------------------------------------------
# BM25 relevance scoring (inline, no external dependency for small doc sets)
# ---------------------------------------------------------------------------

_BM25_K1 = 1.2
_BM25_B = 0.75
_WORD_RE = re.compile(r"\w+")


def _tokenize(text: str) -> list[str]:
    return [w.lower() for w in _WORD_RE.findall(text)]


def _bm25_score(query_tokens: list[str], doc_tokens: list[str], avg_dl: float) -> float:
    """Score a single document against a query using Okapi BM25."""
    if not doc_tokens or not query_tokens:
        return 0.0
    dl = len(doc_tokens)
    tf_map: dict[str, int] = {}
    for t in doc_tokens:
        tf_map[t] = tf_map.get(t, 0) + 1
    score = 0.0
    for qt in set(query_tokens):
        tf = tf_map.get(qt, 0)
        if tf == 0:
            continue
        numerator = tf * (_BM25_K1 + 1)
        denominator = tf + _BM25_K1 * (1 - _BM25_B + _BM25_B * dl / max(avg_dl, 1))
        score += numerator / denominator
    return score


_ABSOLUTE_MIN_RELEVANCE = 0.3


def score_and_filter(
    query: str,
    results: list[SearchResult],
    min_relevance: float = 0.5,
) -> list[SearchResult]:
    """BM25-rank results against query, filter below threshold, deduplicate by URL.

    Follows the CRAG pattern: grade each retrieved document, keep only
    Correct/Ambiguous (above threshold), discard Incorrect.

    Applies both a relative threshold (min_relevance * max_score) and an
    absolute floor (_ABSOLUTE_MIN_RELEVANCE).  When query quality is poor
    and ALL results score below the absolute floor, returns empty rather
    than passing through the "best" garbage.
    """
    if not results:
        return []
    query_tokens = _tokenize(query)
    if not query_tokens:
        return results

    doc_token_lists = []
    for r in results:
        text = f"{r.title} {r.snippet} {r.fetched_content}" if r.fetched_content else f"{r.title} {r.snippet}"
        doc_token_lists.append(_tokenize(text))

    avg_dl = sum(len(d) for d in doc_token_lists) / max(len(doc_token_lists), 1)

    for r, doc_tokens in zip(results, doc_token_lists):
        bm25 = _bm25_score(query_tokens, doc_tokens, avg_dl)
        base_relevance = bm25 * 0.7 + r.score * 0.3

        # Domain authority boost: official docs score higher than blogs
        domain_mult, domain_auth = _domain_authority_tier(r.url)
        r.relevance = base_relevance * domain_mult
        if domain_auth != "external" and r.authority == "external":
            r.authority = domain_auth

    seen_urls: set[str] = set()
    unique: list[SearchResult] = []
    for r in results:
        normalized = r.url.rstrip("/").lower()
        if normalized not in seen_urls:
            seen_urls.add(normalized)
            unique.append(r)

    if not unique:
        return []

    max_rel = max(r.relevance for r in unique) or 1.0

    if max_rel < _ABSOLUTE_MIN_RELEVANCE:
        logger.debug(
            "relevance_all_below_floor",
            extra={"max_rel": round(max_rel, 3), "floor": _ABSOLUTE_MIN_RELEVANCE},
        )
        return []

    threshold = max_rel * min_relevance

    filtered = [r for r in unique if r.relevance >= threshold]
    filtered.sort(key=lambda r: r.relevance, reverse=True)

    logger.debug(
        "relevance_filter",
        extra={
            "total": len(results),
            "after_dedup": len(unique),
            "after_filter": len(filtered),
            "threshold": round(threshold, 3),
            "max_rel": round(max_rel, 3),
        },
    )
    return filtered


# ---------------------------------------------------------------------------
# Page content fetcher -- extract readable text from top URLs
# ---------------------------------------------------------------------------

_FETCH_TIMEOUT = 5.0
_FETCH_MAX_PAGES = 3
_FETCH_MAX_CHARS = 4000

_SKIP_DOMAINS = frozenset({"youtube.com", "youtu.be", "twitter.com", "x.com", "reddit.com", "facebook.com"})


# ---------------------------------------------------------------------------
# Domain-tier authority scoring
# ---------------------------------------------------------------------------

# Tier 1: Primary/official sources — academic, government, official docs
_TIER1_DOMAINS = frozenset({
    # Academic / Research
    "arxiv.org", "scholar.google.com", "pubmed.ncbi.nlm.nih.gov",
    "jstor.org", "ieee.org", "acm.org", "dl.acm.org",
    "nature.com", "science.org", "sciencedirect.com",
    "springer.com", "link.springer.com", "wiley.com",
    "pnas.org", "cell.com",
    # Government / Standards
    "who.int", "iso.org", "nist.gov", "w3.org", "w3c.org",
    "ietf.org", "rfc-editor.org",
    # Tech official docs
    "docs.python.org", "kubernetes.io", "terraform.io",
    "docs.docker.com", "docs.aws.amazon.com",
    "cloud.google.com", "learn.microsoft.com",
    "developer.apple.com", "docs.oracle.com", "docs.github.com",
    "openai.com", "platform.openai.com", "docs.anthropic.com",
    "go.dev", "doc.rust-lang.org", "ruby-doc.org",
    "docs.djangoproject.com", "flask.palletsprojects.com",
    "react.dev", "angular.io", "vuejs.org", "nodejs.org",
    # Finance / Legal
    "sec.gov", "federalreserve.gov", "imf.org", "worldbank.org",
    # Medical
    "nih.gov", "cdc.gov", "mayoclinic.org",
    "nejm.org", "thelancet.com", "bmj.com",
    # Reference
    "wikipedia.org", "britannica.com",
})

# Tier 2: Established community/industry sources
_TIER2_DOMAINS = frozenset({
    # Tech community
    "github.com", "stackoverflow.com", "stackexchange.com",
    "sourcegraph.com", "huggingface.co",
    "pytorch.org", "tensorflow.org",
    "nginx.org", "redis.io", "postgresql.org",
    "elastic.co", "grafana.com", "prometheus.io",
    "cncf.io", "openshift.com", "helm.sh",
    "hashicorp.com", "ansible.com", "pulumi.com",
    # Research orgs
    "research.google", "ai.meta.com", "deepmind.google", "distill.pub",
    "microsoft.com",
    # News / Journalism
    "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk",
    "npr.org", "nytimes.com", "wsj.com",
    "economist.com", "ft.com", "theguardian.com",
    "arstechnica.com", "wired.com", "theregister.com",
    # Industry bodies
    "linux.org", "linuxfoundation.org",
    "apache.org", "openssl.org", "owasp.org", "sans.org",
    # Business / Data
    "statista.com", "crunchbase.com", "gartner.com", "mckinsey.com",
    "hbr.org",
})

# Tier 4: Blog platforms, content farms, user-generated
_TIER4_DOMAINS = frozenset({
    # Blog platforms
    "medium.com", "dev.to", "towardsdatascience.com",
    "substack.com", "hashnode.dev",
    "wordpress.com", "blogger.com", "tumblr.com",
    "wix.com", "ghost.io",
    # Content farms / tutorial mills
    "w3schools.com", "geeksforgeeks.org",
    "tutorialspoint.com", "javatpoint.com", "baeldung.com",
    "programiz.com", "guru99.com",
    # Social / Forum (backup — most are in _SKIP_DOMAINS)
    "quora.com",
})

# Suffix-based tier 1 matches (.gov, .edu)
_TIER1_SUFFIXES = (".gov", ".edu", ".ac.uk", ".edu.au")


def _domain_authority_tier(url: str) -> tuple[float, str]:
    """Return (score_multiplier, authority_label) for a URL based on its domain.

    Tier 1 (1.4x, "vetted"): Official docs, academic, government
    Tier 2 (1.2x, "community"): Established community/industry
    Tier 3 (1.0x, "external"): Unknown domains (default)
    Tier 4 (0.6x, "external"): Blog platforms, content farms
    """
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return 1.0, "external"

    if not host:
        return 1.0, "external"

    # Suffix matching for .gov, .edu
    if any(host.endswith(suffix) for suffix in _TIER1_SUFFIXES):
        return 1.4, "vetted"

    # Blogspot subdomain heuristic
    if ".blogspot." in host:
        return 0.6, "external"

    # Exact and suffix matching against tier sets
    for domain in _TIER1_DOMAINS:
        if host == domain or host.endswith("." + domain):
            return 1.4, "vetted"

    for domain in _TIER2_DOMAINS:
        if host == domain or host.endswith("." + domain):
            return 1.2, "community"

    for domain in _TIER4_DOMAINS:
        if host == domain or host.endswith("." + domain):
            return 0.6, "external"

    return 1.0, "external"


def _extract_text_from_html(html: str) -> str:
    """Extract main content from HTML via trafilatura, returning Markdown."""
    from .extract import html_to_markdown

    md = html_to_markdown(html, fast=True)
    return md[:_FETCH_MAX_CHARS] if md else ""


def _should_fetch(url: str) -> bool:
    """Skip URLs from domains that won't return useful text."""
    try:
        from urllib.parse import urlparse

        host = urlparse(url).hostname or ""
        return not any(host.endswith(d) for d in _SKIP_DOMAINS)
    except Exception:
        return True


async def _fetch_one_page(client: httpx.AsyncClient, url: str) -> str:
    """Fetch a single page and return extracted text, or empty on failure."""
    try:
        resp = await client.get(url, follow_redirects=True)
        if resp.status_code != 200:
            return ""
        content_type = resp.headers.get("content-type", "")
        if "text/html" not in content_type and "text/plain" not in content_type:
            return ""
        return _extract_text_from_html(resp.text)
    except Exception:
        return ""


async def fetch_page_contents(results: list[SearchResult], max_pages: int = _FETCH_MAX_PAGES) -> list[SearchResult]:
    """Fetch full page content for top N results, enriching their fetched_content field."""
    fetchable = [(i, r) for i, r in enumerate(results) if _should_fetch(r.url)][:max_pages]
    if not fetchable:
        return results

    async with httpx.AsyncClient(
        timeout=_FETCH_TIMEOUT,
        headers={"User-Agent": "Synesis-Bot/1.0 (knowledge retrieval)"},
    ) as client:
        tasks = [_fetch_one_page(client, r.url) for _, r in fetchable]
        fetched = await asyncio.gather(*tasks, return_exceptions=True)

    for (idx, _), content in zip(fetchable, fetched):
        if isinstance(content, str) and content.strip():
            results[idx].fetched_content = content
            logger.debug("page_fetched", extra={"url": results[idx].url, "chars": len(content)})

    return results


class _CircuitBreaker:
    """Simple circuit breaker: opens after N failures, resets after timeout."""

    def __init__(self, threshold: int = 3, reset_seconds: float = 30.0):
        self._threshold = threshold
        self._reset_seconds = reset_seconds
        self._failures = 0
        self._open_since: float | None = None
        self._lock = threading.Lock()

    @property
    def is_open(self) -> bool:
        with self._lock:
            if self._open_since is None:
                return False
            if time.monotonic() - self._open_since >= self._reset_seconds:
                self._failures = 0
                self._open_since = None
                return False
            return True

    def record_success(self) -> None:
        with self._lock:
            self._failures = 0
            self._open_since = None

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._failures >= self._threshold:
                self._open_since = time.monotonic()


class WebSearchClient:
    """Async client for SearXNG with circuit breaker and observability."""

    def __init__(
        self,
        base_url: str = "",
        timeout: float = 5.0,
        max_results: int = 5,
    ):
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_results = max_results
        self._breaker = _CircuitBreaker(threshold=3, reset_seconds=30.0)

    async def search(
        self,
        query: str,
        profile: str = "web",
        max_results: int | None = None,
    ) -> list[SearchResult]:
        if not settings.web_search_enabled or not self._base_url:
            return []

        if self._breaker.is_open:
            logger.debug("Web search circuit breaker open, skipping")
            return []

        if not query.strip():
            return []

        limit = max_results or self._max_results
        params: dict[str, Any] = {
            "q": query,
            "format": "json",
            "pageno": 1,
        }
        params.update(PROFILE_PARAMS.get(profile, PROFILE_PARAMS["web"]))

        start = time.monotonic()
        try:
            _timeout = httpx.Timeout(
                connect=min(self._timeout, 3.0),
                read=self._timeout,
                write=self._timeout,
                pool=self._timeout,
            )
            async with httpx.AsyncClient(timeout=_timeout) as client:
                resp = await client.get(f"{self._base_url}/search", params=params)
                resp.raise_for_status()

            data = resp.json()
            raw_results = data.get("results", [])[:limit]

            results = [
                SearchResult(
                    title=r.get("title", ""),
                    url=r.get("url", ""),
                    snippet=r.get("content", ""),
                    engine=r.get("engine", ""),
                    score=r.get("score", 0.0),
                )
                for r in raw_results
                if r.get("url")
            ]

            self._breaker.record_success()

            elapsed = time.monotonic() - start
            if _search_counter:
                _search_counter.labels(profile=profile, outcome="success").inc()
            if _search_latency:
                _search_latency.labels(profile=profile).observe(elapsed)

            logger.info(
                "web_search_completed",
                extra={
                    "profile": profile,
                    "query": query[:120],
                    "results_count": len(results),
                    "latency_s": round(elapsed, 3),
                },
            )
            return results

        except Exception as e:
            self._breaker.record_failure()
            elapsed = time.monotonic() - start

            if _search_counter:
                _search_counter.labels(profile=profile, outcome="error").inc()
            if _search_latency:
                _search_latency.labels(profile=profile).observe(elapsed)

            logger.warning(
                "web_search_failed",
                extra={
                    "error": str(e)[:200],
                    "error_type": type(e).__name__,
                    "latency_s": round(elapsed, 2),
                    "query": query[:120],
                    "profile": profile,
                    "breaker_open": self._breaker.is_open,
                },
            )
            return []


def _sanitize_search_result(result: SearchResult) -> SearchResult:
    """Scan and redact injection payloads from a single search result.

    Uses the extended web scanner (Tier-1 + Tier-2 patterns) including
    homoglyph normalization and zero-width character stripping.
    """
    if result.fetched_content:
        scan = scan_web_content(result.fetched_content, source=f"web_page:{result.url[:80]}")
        if scan.detected:
            result.fetched_content = reduce_context_on_injection(result.fetched_content, "")
    if result.snippet:
        scan = scan_web_content(result.snippet, source=f"web_snippet:{result.url[:80]}")
        if scan.detected:
            result.snippet = reduce_context_on_injection(result.snippet, "")
    if result.title:
        scan = scan_web_content(result.title, source=f"web_title:{result.url[:80]}")
        if scan.detected:
            result.title = reduce_context_on_injection(result.title, "")
    return result


def classify_results_by_trust(results: list[SearchResult]) -> list[SearchResult]:
    """Tag each result with authority/origin_type/is_trusted based on engine_authority_map.

    Engines present in the map are treated as trusted internal sources.
    Unmapped engines default to external/untrusted.
    """
    engine_map = settings.engine_authority_map
    if not engine_map:
        return results
    for r in results:
        entry = engine_map.get(r.engine)
        if entry:
            r.authority = entry.get("authority", "canonical")
            r.origin_type = entry.get("origin_type", "internal")
            r.is_trusted = True
    return results


def format_search_results(results: list[SearchResult]) -> list[str]:
    """Format search results as readable strings with injection scanning.

    Sanitizes each result via the extended web scanner before formatting.
    Prefers fetched_content (full page text) over snippet when available.
    Trusted results get [R:authority] prefix; untrusted get [W] prefix
    per Spotlighting (arxiv 2403.14720).
    """
    formatted = []
    for r in results:
        r = _sanitize_search_result(r)
        body = r.fetched_content.strip() if r.fetched_content else ""
        if not body:
            body = r.snippet[:300].replace("\n", " ").strip()
        prefix = f"[R:{r.authority}]" if r.is_trusted else "[W]"
        if body:
            formatted.append(f"{prefix} [{r.title}]({r.url}): {body}")
        else:
            formatted.append(f"{prefix} [{r.title}]({r.url})")
    return formatted


async def search_and_process(
    query: str,
    profile: str = "web",
    fetch_pages: bool = True,
    min_relevance: float = 0.5,
) -> list[SearchResult]:
    """Full CRAG-inspired pipeline: search → fetch → rank → filter → classify trust.

    Returns relevance-ranked, deduplicated SearchResults with fetched content
    where available, tagged with authority/trust from engine_authority_map.
    This is the recommended entry point for nodes that want enriched web context.
    """
    raw = await search_client.search(query, profile=profile)
    if not raw:
        return []

    if fetch_pages and profile == "web":
        raw = await fetch_page_contents(raw)

    filtered = score_and_filter(query, raw, min_relevance=min_relevance)
    return classify_results_by_trust(filtered)


search_client = WebSearchClient(
    base_url=settings.web_search_url,
    timeout=settings.web_search_timeout_seconds,
    max_results=settings.web_search_max_results,
)
