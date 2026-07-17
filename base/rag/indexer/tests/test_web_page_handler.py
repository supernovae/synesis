from __future__ import annotations

import importlib.util
from types import SimpleNamespace

import pytest
from app import extract as extract_mod
from app.content_gate import GatePolicy
from app.handlers import web_page


@pytest.fixture(autouse=True)
def _public_https(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(web_page, "validate_public_https_url", lambda url: url)


@pytest.mark.asyncio
async def test_sitemap_first_expands_with_bfs_when_sitemap_is_thin(monkeypatch: pytest.MonkeyPatch):
    seed = "https://example.com/docs"
    monkeypatch.setattr(importlib.util, "find_spec", lambda _name: object())
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

    pages = await web_page._crawl_pages(
        seed,
        {
            "discovery": "sitemap_first",
            "follow_links": True,
            "max_depth": 4,
            "max_pages": 10,
        },
        GatePolicy(),
    )

    assert bfs_called["value"] is True
    assert len(pages) == 2
    assert any(p["url"].endswith("/child") for p in pages)


@pytest.mark.asyncio
async def test_sitemap_only_does_not_expand_with_bfs(monkeypatch: pytest.MonkeyPatch):
    seed = "https://example.com/docs"
    monkeypatch.setattr(importlib.util, "find_spec", lambda _name: object())
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

    pages = await web_page._crawl_pages(
        seed,
        {
            "discovery": "sitemap_only",
            "follow_links": True,
            "max_depth": 4,
            "max_pages": 10,
        },
        GatePolicy(),
    )

    assert len(pages) == 1
    assert pages[0]["url"] == seed


def test_extract_child_urls_falls_back_to_html_anchors():
    result = SimpleNamespace(
        url="https://gobyexample.com/",
        links=None,
        html=(
            "<html><body>"
            '<a href="/if-else">If Else</a>'
            '<a href="/for">For</a>'
            '<a href="https://external.example.com/x">External</a>'
            "</body></html>"
        ),
    )
    policy = GatePolicy(allowed_prefixes=["https://gobyexample.com/"])
    children = web_page._extract_child_urls(
        result,
        seed_host="gobyexample.com",
        policy=policy,
        visited=set(),
    )
    assert "https://gobyexample.com/if-else" in children
    assert "https://gobyexample.com/for" in children
    assert all("external.example.com" not in c for c in children)


def test_extract_child_urls_normalizes_relative_internal_links():
    result = SimpleNamespace(
        url="https://gobyexample.com/",
        links=SimpleNamespace(internal=["http-client", "/for", "mailto:test@example.com"]),
        html="",
    )
    policy = GatePolicy(allowed_prefixes=["https://gobyexample.com/"])
    children = web_page._extract_child_urls(
        result,
        seed_host="gobyexample.com",
        policy=policy,
        visited=set(),
    )
    assert "https://gobyexample.com/http-client" in children
    assert "https://gobyexample.com/for" in children
    assert all(not c.startswith("mailto:") for c in children)


def test_select_markdown_content_prefers_richer_crawler_markdown(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(extract_mod, "html_to_markdown", lambda _html: "short")
    monkeypatch.setattr(extract_mod, "normalize_doc_markdown", lambda md: md)

    result = SimpleNamespace(
        markdown='```\nfmt.Println("hi")\n```\n\nMore text',
        fit_markdown="",
        cleaned_markdown="",
    )
    chosen = web_page._select_markdown_content("<html/>", result)
    assert chosen.startswith("```")
