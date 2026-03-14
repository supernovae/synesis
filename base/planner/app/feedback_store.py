"""Feedback store for thumbs up/down -- tuning loop for EntryClassifier.

Stores vote + classification context so misclassified examples can be
exported for YAML tuning. Admin UI or webhook POSTs to /v1/feedback.

Run context is cached temporarily (TTL 24h) so feedback can be associated
with run_id when it arrives asynchronously.

Uses Redis when SYNESIS_REDIS_URL is set, falls back to in-memory.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

logger = logging.getLogger("synesis.feedback")

_REDIS_KEY_PREFIX = "synesis:feedback:"
_REDIS_LIST_KEY = "synesis:feedback:entries"
_REDIS_CONTEXT_PREFIX = "synesis:feedback:ctx:"


@dataclass
class FeedbackEntry:
    """Stored feedback with classification context for tuning."""

    message_id: str
    run_id: str
    vote: str  # "up" | "down"
    user_id: str = ""
    model: str = ""
    message_snippet: str = ""
    response_snippet: str = ""
    classification_reasons: list[str] = field(default_factory=list)
    score_breakdown: dict[str, Any] = field(default_factory=dict)
    task_size: str = ""
    timestamp: str = ""


class FeedbackStore(Protocol):
    """Pluggable backend for persisted feedback."""

    def store(self, entry: FeedbackEntry) -> None: ...

    def list_entries(
        self,
        vote: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[FeedbackEntry]: ...


class InMemoryFeedbackStore:
    """In-memory feedback store -- fallback when Redis is unavailable."""

    def __init__(self, max_entries: int = 10_000) -> None:
        self._entries: list[FeedbackEntry] = []
        self._max = max_entries
        self._lock = threading.Lock()

    def store(self, entry: FeedbackEntry) -> None:
        with self._lock:
            self._entries.append(entry)
            if len(self._entries) > self._max:
                self._entries = self._entries[-self._max :]

    def list_entries(
        self,
        vote: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[FeedbackEntry]:
        with self._lock:
            subset = self._entries
            if vote:
                subset = [e for e in subset if e.vote == vote]
            subset = subset[offset : offset + limit]
            return list(subset)


class RedisFeedbackStore:
    """Redis-backed feedback store. Shared between planner and admin service."""

    def __init__(self, redis_url: str, max_entries: int = 10_000) -> None:
        import redis

        self._r = redis.Redis.from_url(redis_url, decode_responses=True)
        self._max = max_entries

    def store(self, entry: FeedbackEntry) -> None:
        payload = json.dumps(asdict(entry))
        self._r.lpush(_REDIS_LIST_KEY, payload)
        self._r.ltrim(_REDIS_LIST_KEY, 0, self._max - 1)

    def list_entries(
        self,
        vote: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[FeedbackEntry]:
        raw_items = self._r.lrange(_REDIS_LIST_KEY, 0, self._max - 1)
        entries = []
        for raw in raw_items:
            try:
                d = json.loads(raw)
                entries.append(FeedbackEntry(**d))
            except Exception:
                continue
        if vote:
            entries = [e for e in entries if e.vote == vote]
        return entries[offset : offset + limit]


_RUN_CONTEXT_TTL_SEC = 86400


class RunContextCache:
    """Temporary cache of run_id -> classification context. Feedback arrives async."""

    def __init__(self, ttl_seconds: int = _RUN_CONTEXT_TTL_SEC) -> None:
        self._cache: dict[str, tuple[dict[str, Any], float]] = {}
        self._ttl = ttl_seconds
        self._lock = threading.Lock()

    def put(self, run_id: str, context: dict[str, Any]) -> None:
        with self._lock:
            self._cache[run_id] = (context, time.time())
            self._evict_expired()

    def get(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._evict_expired()
            entry = self._cache.get(run_id)
            if not entry:
                return None
            _, ts = entry
            if time.time() - ts > self._ttl:
                del self._cache[run_id]
                return None
            return entry[0]

    def _evict_expired(self) -> None:
        now = time.time()
        expired = [k for k, v in self._cache.items() if now - v[1] > self._ttl]
        for k in expired:
            del self._cache[k]


# Singletons
_feedback_store: InMemoryFeedbackStore | RedisFeedbackStore | None = None
_run_context_cache: RunContextCache | None = None


def get_feedback_store() -> InMemoryFeedbackStore | RedisFeedbackStore:
    """Lazy-init feedback store. Uses Redis if SYNESIS_REDIS_URL is set."""
    global _feedback_store
    if _feedback_store is None:
        redis_url = os.getenv("SYNESIS_REDIS_URL", "")
        if redis_url:
            try:
                _feedback_store = RedisFeedbackStore(redis_url)
                logger.info("feedback_store_redis url=%s", redis_url[:30])
            except Exception as exc:
                logger.warning("feedback_store_redis_failed error=%s", str(exc)[:60])
                _feedback_store = InMemoryFeedbackStore()
        else:
            _feedback_store = InMemoryFeedbackStore()
    return _feedback_store


def get_run_context_cache() -> RunContextCache:
    """Lazy-init run context cache."""
    global _run_context_cache
    if _run_context_cache is None:
        _run_context_cache = RunContextCache()
    return _run_context_cache


def store_run_context(
    run_id: str,
    user_id: str,
    message_snippet: str,
    response_snippet: str,
    classification_reasons: list[str],
    score_breakdown: dict[str, Any],
    task_size: str,
) -> None:
    """Store classification context for later feedback association."""
    cache = get_run_context_cache()
    cache.put(
        run_id,
        {
            "user_id": user_id,
            "message_snippet": message_snippet,
            "response_snippet": response_snippet,
            "classification_reasons": classification_reasons,
            "score_breakdown": score_breakdown,
            "task_size": task_size,
        },
    )
    logger.debug("run_context_stored run_id=%s task_size=%s", run_id[:8], task_size)
