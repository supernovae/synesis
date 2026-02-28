"""Tests for failfast_cache.py -- the in-memory LRU execution pattern cache."""

from __future__ import annotations

import time

from app.failfast_cache import FailFastCache


class TestFailFastCache:
    def test_put_and_get(self):
        cache = FailFastCache(max_size=10, ttl_seconds=3600)
        cache.put("write hello world", "python", "success", "print('hello')")
        entry = cache.get("write hello world", "python")
        assert entry is not None
        assert entry.outcome == "success"
        assert entry.code == "print('hello')"

    def test_miss_returns_none(self):
        cache = FailFastCache(max_size=10, ttl_seconds=3600)
        assert cache.get("nonexistent", "python") is None

    def test_case_insensitive_key(self):
        cache = FailFastCache(max_size=10, ttl_seconds=3600)
        cache.put("Write Hello World", "Python", "success", "code")
        entry = cache.get("write hello world", "python")
        assert entry is not None

    def test_lru_eviction(self):
        cache = FailFastCache(max_size=2, ttl_seconds=3600)
        cache.put("task1", "py", "success", "code1")
        cache.put("task2", "py", "success", "code2")
        cache.put("task3", "py", "success", "code3")
        assert cache.get("task1", "py") is None
        assert cache.get("task2", "py") is not None
        assert cache.get("task3", "py") is not None

    def test_ttl_expiration(self):
        cache = FailFastCache(max_size=10, ttl_seconds=0.01)
        cache.put("task", "py", "success", "code")
        time.sleep(0.02)
        assert cache.get("task", "py") is None

    def test_hit_count_increments(self):
        cache = FailFastCache(max_size=10, ttl_seconds=3600)
        cache.put("task", "py", "success", "code")
        cache.get("task", "py")
        cache.get("task", "py")
        entry = cache.get("task", "py")
        assert entry is not None
        assert entry.hit_count == 3

    def test_get_hints_success(self):
        cache = FailFastCache(max_size=10, ttl_seconds=3600)
        cache.put("task", "py", "success", "good_code()")
        hints = cache.get_hints("task", "py")
        assert len(hints) == 1
        assert "succeeded" in hints[0]
        assert "good_code()" in hints[0]

    def test_get_hints_failure(self):
        cache = FailFastCache(max_size=10, ttl_seconds=3600)
        cache.put("task", "py", "failure", "bad_code()", error_summary="NameError")
        hints = cache.get_hints("task", "py")
        assert len(hints) == 2
        assert "failed" in hints[0]
        assert "NameError" in hints[0]

    def test_get_hints_miss(self):
        cache = FailFastCache(max_size=10, ttl_seconds=3600)
        assert cache.get_hints("nonexistent", "py") == []

    def test_size_property(self):
        cache = FailFastCache(max_size=10, ttl_seconds=3600)
        assert cache.size == 0
        cache.put("t1", "py", "success", "c")
        assert cache.size == 1
        cache.put("t2", "py", "failure", "c")
        assert cache.size == 2

    def test_stats(self):
        cache = FailFastCache(max_size=100, ttl_seconds=7200)
        cache.put("t1", "py", "success", "c")
        cache.put("t2", "go", "failure", "c", "error")
        cache.get("t1", "py")
        stats = cache.stats()
        assert stats["total_entries"] == 2
        assert stats["successes"] == 1
        assert stats["failures"] == 1
        assert stats["total_hits"] == 1
        assert stats["max_size"] == 100

    def test_overwrite_same_key(self):
        cache = FailFastCache(max_size=10, ttl_seconds=3600)
        cache.put("task", "py", "failure", "bad", "err")
        cache.put("task", "py", "success", "good")
        entry = cache.get("task", "py")
        assert entry is not None
        assert entry.outcome == "success"
        assert entry.code == "good"

    def test_content_truncation(self):
        cache = FailFastCache(max_size=10, ttl_seconds=3600)
        long_desc = "x" * 1000
        long_code = "y" * 10000
        long_err = "z" * 5000
        cache.put(long_desc, "py", "failure", long_code, long_err)
        entry = cache.get(long_desc, "py")
        assert entry is not None
        assert len(entry.task_description) <= 512
        assert len(entry.code) <= 4096
        assert len(entry.error_summary) <= 2048
