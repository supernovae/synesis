from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from app.content_gate import GatePolicy
from app.handlers import web_page


@pytest.fixture(autouse=True)
def _public_https(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(web_page, "validate_public_https_url", lambda url: url)


def test_sitemap_first_expands_with_bfs_when_sitemap_is_thin(monkeypatch: pytest.MonkeyPatch):
    seed = "https://example.com/docs"
    monkeypatch.setattr(web_page, "fetch_robots_info", lambda _seed_url: SimpleNamespace(sitemap_urls=[]))
    monkeypatch.setattr(web_page, "crawl_delay_seconds", lambda _ua, _rinfo: 0.0)
    monkeypatch.setattr(
        web_page,
        "collect_urls_from_sitemaps",
        lambda *_args, **_kwargs: [seed],
    )

    async def _fake_fetch_url_list(*_args, **_kwargs):
        return [{"url": seed, "markdown": "seed", "crawl_depth": 0}]

    bfs_called = {"value": False}

    async def _fake_bfs(*_args, **_kwargs):
        bfs_called["value"] = True
        return [
            {"url": seed, "markdown": "seed", "crawl_depth": 0},
            {"url": f"{seed}/child", "markdown": "child", "crawl_depth": 1},
        ]

    monkeypatch.setattr(web_page, "_fetch_url_list", _fake_fetch_url_list)
    monkeypatch.setattr(web_page, "_crawl_bfs", _fake_bfs)

    pages = asyncio.run(
        web_page._crawl_pages(
            seed,
            {
                "discovery": "sitemap_first",
                "follow_links": True,
                "max_depth": 4,
                "max_pages": 10,
            },
            GatePolicy(),
        )
    )

    assert bfs_called["value"] is True
    assert len(pages) == 2
    assert any(p["url"].endswith("/child") for p in pages)


def test_sitemap_only_does_not_expand_with_bfs(monkeypatch: pytest.MonkeyPatch):
    seed = "https://example.com/docs"
    monkeypatch.setattr(web_page, "fetch_robots_info", lambda _seed_url: SimpleNamespace(sitemap_urls=[]))
    monkeypatch.setattr(web_page, "crawl_delay_seconds", lambda _ua, _rinfo: 0.0)
    monkeypatch.setattr(
        web_page,
        "collect_urls_from_sitemaps",
        lambda *_args, **_kwargs: [seed],
    )

    async def _fake_fetch_url_list(*_args, **_kwargs):
        return [{"url": seed, "markdown": "seed", "crawl_depth": 0}]

    async def _fake_bfs(*_args, **_kwargs):
        raise AssertionError("BFS should not run in sitemap_only mode")

    monkeypatch.setattr(web_page, "_fetch_url_list", _fake_fetch_url_list)
    monkeypatch.setattr(web_page, "_crawl_bfs", _fake_bfs)

    pages = asyncio.run(
        web_page._crawl_pages(
            seed,
            {
                "discovery": "sitemap_only",
                "follow_links": True,
                "max_depth": 4,
                "max_pages": 10,
            },
            GatePolicy(),
        )
    )

    assert len(pages) == 1
    assert pages[0]["url"] == seed


def test_extract_child_urls_uses_same_host_https_and_deduplicates():
    html = '<a href="/if-else">If</a><a href="for#one">For</a><a href="for#two">Again</a>'
    html += '<a href="https://external.example/x">External</a><a href="http://gobyexample.com/x">HTTP</a>'
    html += '<a href="mailto:test@example.com">Mail</a><a href="/seen">Seen</a>'
    policy = GatePolicy(allowed_prefixes=["https://gobyexample.com/"])
    children = web_page._extract_child_urls(
        html, "https://gobyexample.com/", "gobyexample.com", policy, {"https://gobyexample.com/seen"}
    )
    assert children == ["https://gobyexample.com/if-else", "https://gobyexample.com/for"]


def test_static_crawl_applies_scope_robots_and_page_limits(monkeypatch):
    import httpx

    visited = []
    seed = "https://example.com/docs"
    html = "<article><h1>Guide</h1><p>" + ("Useful project documentation. " * 30) + "</p>"
    html += '<a href="/docs/child">Child</a><a href="/docs/denied">Denied</a><a href="https://other.example/x">Other</a></article>'

    def fetch(url, **kwargs):
        kwargs["check_url"](url)
        assert kwargs["max_bytes"] == 8 * 1024 * 1024
        visited.append(url)
        return httpx.Response(200, text=html, headers={"content-type": "text/html"}, request=httpx.Request("GET", url))

    monkeypatch.setattr(web_page, "get_public_https", fetch)
    monkeypatch.setattr(web_page, "can_fetch", lambda url, *_: not url.endswith("/denied"))
    monkeypatch.setattr(
        web_page,
        "evaluate_page",
        lambda *_args, **_kwargs: SimpleNamespace(should_index=True, should_follow_children=True),
    )
    pages = asyncio.run(web_page._crawl_bfs(seed, True, 2, GatePolicy(), "trial-agent", 0, True, object(), 10, 10))
    assert visited == [seed, seed + "/child"]
    assert [page["url"] for page in pages] == visited
    assert all("Useful project documentation" in page["markdown"] for page in pages)


def test_crawl_checks_redirect_scope_and_reports_final_source_url(monkeypatch):
    import httpx

    seed = "https://example.com/docs"

    def fetch(url, **kwargs):
        with pytest.raises(ValueError, match="outside crawl policy"):
            kwargs["check_url"]("https://other.example/docs")
        final = url + "/canonical"
        kwargs["check_url"](final)
        return httpx.Response(
            200,
            text="<html><body><article><h1>Guide</h1><p>"
            + ("Retained evidence. " * 30)
            + "</p></article></body></html>",
            headers={"content-type": "text/html"},
            request=httpx.Request("GET", final),
        )

    monkeypatch.setattr(web_page, "get_public_https", fetch)
    monkeypatch.setattr(
        web_page,
        "evaluate_page",
        lambda *_args, **_kwargs: SimpleNamespace(should_index=True, should_follow_children=False),
    )
    pages = asyncio.run(web_page._crawl_bfs(seed, False, 0, GatePolicy(), "trial", 0, False, object(), 1, 1))
    assert pages[0]["url"] == seed + "/canonical"


def test_crawl_limits_failures_as_well_as_successes(monkeypatch):
    from collections import deque

    fetched = []

    def fail(url, **kwargs):
        fetched.append(url)
        raise OSError("Unavailable source")

    monkeypatch.setattr(web_page, "get_public_https", fail)
    queue = deque((f"https://example.com/docs/{i}", 0) for i in range(30))
    pages = asyncio.run(
        web_page._visit_pages(
            queue, "https://example.com/docs", False, 0, GatePolicy(), "trial", 0, False, object(), 1, 1
        )
    )
    assert pages == []
    assert len(fetched) == 5
