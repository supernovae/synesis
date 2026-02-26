"""Fail-fast cache -- in-memory LRU cache for recent success/failure patterns.

Keyed by hash(task_description + language), stores recent outcomes so the
system can shortcut repeated failures and boost successful patterns.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Literal

logger = logging.getLogger("synesis.failfast_cache")


@dataclass
class CacheEntry:
    """A cached execution outcome."""

    task_hash: str
    task_description: str
    language: str
    outcome: Literal["success", "failure"]
    code: str
    error_summary: str = ""
    timestamp: float = field(default_factory=time.time)
    hit_count: int = 0


class FailFastCache:
    """Thread-safe LRU cache for execution patterns.

    On cache hit:
    - Success: inject the successful code as a hint ("this pattern worked before")
    - Failure: inject the failure context to avoid repeating it
    """

    def __init__(self, max_size: int = 1000, ttl_seconds: float = 86400.0):
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._lock = threading.Lock()

    def _make_key(self, task_description: str, language: str) -> str:
        raw = f"{task_description.strip().lower()}:{language.strip().lower()}"
        return hashlib.sha256(raw.encode()).hexdigest()[:32]

    def _evict_expired(self) -> None:
        now = time.time()
        expired = [k for k, v in self._cache.items() if now - v.timestamp > self._ttl]
        for k in expired:
            del self._cache[k]

    def put(
        self,
        task_description: str,
        language: str,
        outcome: Literal["success", "failure"],
        code: str,
        error_summary: str = "",
    ) -> None:
        """Store an execution outcome."""
        key = self._make_key(task_description, language)
        with self._lock:
            self._evict_expired()
            entry = CacheEntry(
                task_hash=key,
                task_description=task_description[:512],
                language=language,
                outcome=outcome,
                code=code[:4096],
                error_summary=error_summary[:2048],
            )
            self._cache[key] = entry
            self._cache.move_to_end(key)
            while len(self._cache) > self._max_size:
                self._cache.popitem(last=False)

    def get(self, task_description: str, language: str) -> CacheEntry | None:
        """Look up a cached outcome. Returns None on miss."""
        key = self._make_key(task_description, language)
        with self._lock:
            entry = self._cache.get(key)
            if entry is None:
                return None
            if time.time() - entry.timestamp > self._ttl:
                del self._cache[key]
                return None
            entry.hit_count += 1
            self._cache.move_to_end(key)
            return entry

    def get_hints(self, task_description: str, language: str) -> list[str]:
        """Return human-readable hints from cache for the worker prompt."""
        entry = self.get(task_description, language)
        if entry is None:
            return []

        hints = []
        if entry.outcome == "success":
            hints.append(
                f"A similar task ({entry.language}) succeeded before. "
                f"The successful pattern used:\n```\n{entry.code[:1024]}\n```"
            )
        elif entry.outcome == "failure":
            hints.append(
                f"A similar task ({entry.language}) failed before. "
                f"Error: {entry.error_summary[:512]}. Avoid this approach."
            )
            if entry.code:
                hints.append(f"Failed code to avoid:\n```\n{entry.code[:512]}\n```")
        return hints

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._cache)

    def stats(self) -> dict:
        with self._lock:
            total = len(self._cache)
            successes = sum(1 for e in self._cache.values() if e.outcome == "success")
            failures = total - successes
            total_hits = sum(e.hit_count for e in self._cache.values())
            return {
                "total_entries": total,
                "successes": successes,
                "failures": failures,
                "total_hits": total_hits,
                "max_size": self._max_size,
                "ttl_seconds": self._ttl,
            }


# Module-level singleton
cache = FailFastCache(
    max_size=1000,
    ttl_seconds=86400.0,
)
