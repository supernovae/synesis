"""Web search client -- async wrapper around SearXNG for live web context.

Provides two search profiles:
  - "web": General knowledge via Google/Bing/DuckDuckGo
  - "code": Code-specific via GitHub/StackOverflow

Includes a per-profile circuit breaker so SearXNG downtime never blocks
the LangGraph pipeline. All failures return empty results gracefully.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .config import settings

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
            async with httpx.AsyncClient(timeout=self._timeout) as client:
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

            logger.warning("web_search_failed: %s (%.2fs)", e, elapsed)
            return []


def format_search_results(results: list[SearchResult]) -> list[str]:
    """Format search results as readable strings for prompt injection."""
    formatted = []
    for r in results:
        snippet = r.snippet[:300].replace("\n", " ").strip()
        if snippet:
            formatted.append(f"[{r.title}]({r.url}): {snippet}")
        else:
            formatted.append(f"[{r.title}]({r.url})")
    return formatted


search_client = WebSearchClient(
    base_url=settings.web_search_url,
    timeout=settings.web_search_timeout_seconds,
    max_results=settings.web_search_max_results,
)
