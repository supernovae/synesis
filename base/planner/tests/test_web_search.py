"""Tests for web_search.py -- circuit breaker and result formatting."""

from __future__ import annotations

import time

from app.web_search import SearchResult, _CircuitBreaker, format_search_results


class TestCircuitBreaker:
    def test_starts_closed(self):
        cb = _CircuitBreaker(threshold=3, reset_seconds=30)
        assert not cb.is_open

    def test_opens_after_threshold_failures(self):
        cb = _CircuitBreaker(threshold=3, reset_seconds=30)
        cb.record_failure()
        cb.record_failure()
        assert not cb.is_open
        cb.record_failure()
        assert cb.is_open

    def test_success_resets_failures(self):
        cb = _CircuitBreaker(threshold=3, reset_seconds=30)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        cb.record_failure()
        assert not cb.is_open

    def test_auto_resets_after_timeout(self):
        cb = _CircuitBreaker(threshold=1, reset_seconds=0.01)
        cb.record_failure()
        assert cb.is_open
        time.sleep(0.02)
        assert not cb.is_open


class TestFormatSearchResults:
    def test_formats_with_snippet(self):
        results = [
            SearchResult(
                title="How to write bash",
                url="https://example.com",
                snippet="Use #!/bin/bash at the top",
            )
        ]
        formatted = format_search_results(results)
        assert len(formatted) == 1
        assert "[How to write bash]" in formatted[0]
        assert "https://example.com" in formatted[0]
        assert "#!/bin/bash" in formatted[0]

    def test_formats_without_snippet(self):
        results = [SearchResult(title="Link", url="https://x.com", snippet="")]
        formatted = format_search_results(results)
        assert "[Link](https://x.com)" in formatted[0]

    def test_empty_results(self):
        assert format_search_results([]) == []

    def test_snippet_truncation(self):
        results = [SearchResult(title="T", url="http://u", snippet="x" * 500)]
        formatted = format_search_results(results)
        assert len(formatted[0]) < 500
