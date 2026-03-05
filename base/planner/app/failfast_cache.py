"""Fail-fast cache -- in-memory LRU cache for recent success/failure patterns.

Keyed by hash(task_description + language), stores recent outcomes so the
system can shortcut repeated failures and boost successful patterns.
Persists to a JSON file for cross-restart recall.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

logger = logging.getLogger("synesis.failfast_cache")

_DEFAULT_CACHE_DIR = Path(os.environ.get("SYNESIS_CACHE_DIR", "/tmp/synesis-cache"))  # nosec B108


@dataclass
class CacheEntry:
    """A cached execution outcome."""

    task_hash: str
    task_description: str
    language: str
    outcome: Literal["success", "failure"]
    code: str
    explanation: str = ""
    error_summary: str = ""
    timestamp: float = field(default_factory=time.time)
    hit_count: int = 0


class FailFastCache:
    """Thread-safe LRU cache for execution patterns.

    On cache hit:
    - Success: inject the successful code as a hint ("this pattern worked before")
    - Failure: inject the failure context to avoid repeating it

    Backed by a JSON file for persistence across restarts.
    """

    def __init__(
        self,
        max_size: int = 1000,
        ttl_seconds: float = 86400.0,
        persist_path: Path | None = None,
    ):
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._lock = threading.Lock()
        self._persist_path = persist_path or (_DEFAULT_CACHE_DIR / "validated_results.json")
        self._load_from_disk()

    def _load_from_disk(self) -> None:
        """Load persisted cache entries on startup."""
        try:
            if not self._persist_path.exists():
                return
            raw = self._persist_path.read_text(encoding="utf-8")
            data: dict = json.loads(raw)
            now = time.time()
            for key, entry_dict in data.items():
                ts = entry_dict.get("timestamp", 0)
                if now - ts > self._ttl:
                    continue
                self._cache[key] = CacheEntry(
                    task_hash=entry_dict.get("task_hash", key),
                    task_description=entry_dict.get("task_description", ""),
                    language=entry_dict.get("language", ""),
                    outcome=entry_dict.get("outcome", "success"),
                    code=entry_dict.get("code", ""),
                    explanation=entry_dict.get("explanation", ""),
                    error_summary=entry_dict.get("error_summary", ""),
                    timestamp=ts,
                    hit_count=entry_dict.get("hit_count", 0),
                )
            logger.info("failfast_cache_loaded", extra={"entries": len(self._cache)})
        except Exception as e:
            logger.debug("failfast_cache_load_failed: %s", e)

    def _persist_to_disk(self) -> None:
        """Atomic write of cache to JSON file (temp + rename)."""
        try:
            self._persist_path.parent.mkdir(parents=True, exist_ok=True)
            data = {k: asdict(v) for k, v in self._cache.items()}
            fd, tmp = tempfile.mkstemp(dir=str(self._persist_path.parent), suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False)
                os.replace(tmp, str(self._persist_path))
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
                raise
        except Exception as e:
            logger.debug("failfast_cache_persist_failed: %s", e)

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
        explanation: str = "",
    ) -> None:
        """Store an execution outcome and persist to disk."""
        key = self._make_key(task_description, language)
        with self._lock:
            self._evict_expired()
            entry = CacheEntry(
                task_hash=key,
                task_description=task_description[:512],
                language=language,
                outcome=outcome,
                code=code[:4096],
                explanation=explanation[:2048],
                error_summary=error_summary[:2048],
            )
            self._cache[key] = entry
            self._cache.move_to_end(key)
            while len(self._cache) > self._max_size:
                self._cache.popitem(last=False)
            self._persist_to_disk()

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
