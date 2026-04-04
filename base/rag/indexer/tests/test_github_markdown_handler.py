from __future__ import annotations

from types import SimpleNamespace

import pytest
from app.handlers import github_markdown
from app.handlers.base import RawDocument


class _FakeResponse:
    def __init__(self, payload: dict):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    def __init__(self, payload: dict):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        return False

    def get(self, _url: str, headers: dict[str, str] | None = None):
        assert headers is not None
        return _FakeResponse(self._payload)


def test_list_md_files_accepts_explicit_html_file(monkeypatch: pytest.MonkeyPatch):
    payload = {"tree": [{"type": "blob", "path": "doc/go_spec.html"}]}

    def _fake_client(**_kwargs):
        return _FakeClient(payload)

    monkeypatch.setattr(github_markdown.httpx, "Client", _fake_client)

    files = github_markdown._list_md_files("golang/go", "doc/go_spec.html", "master", None)
    assert files == ["doc/go_spec.html"]


def test_list_md_files_keeps_directory_mode_markdown_only(monkeypatch: pytest.MonkeyPatch):
    payload = {
        "tree": [
            {"type": "blob", "path": "docs/intro.md"},
            {"type": "blob", "path": "docs/ref.html"},
            {"type": "blob", "path": "docs/guide.mdx"},
        ]
    }

    def _fake_client(**_kwargs):
        return _FakeClient(payload)

    monkeypatch.setattr(github_markdown.httpx, "Client", _fake_client)

    files = github_markdown._list_md_files("example/repo", "docs", "main", None)
    assert files == ["docs/guide.mdx", "docs/intro.md"]


def test_parse_and_chunk_converts_html_sources(monkeypatch: pytest.MonkeyPatch):
    def _splitter(_text, document_name):
        return [SimpleNamespace(text="chunk", section=document_name, heading_path="h1", chunk_index=0)]

    monkeypatch.setattr(github_markdown, "heading_aware_split", _splitter)

    from app import extract as extract_mod

    monkeypatch.setattr(extract_mod, "html_to_markdown", lambda _html: "# Parsed Title\n\nBody")
    monkeypatch.setattr(extract_mod, "normalize_doc_markdown", lambda md: md)

    handler = github_markdown.GitHubMarkdownHandler()
    doc = RawDocument(
        doc_id="github:golang/go:doc/go_spec.html",
        name="spec",
        content="<html><body><h1>Spec</h1></body></html>",
        source_url="https://github.com/golang/go/blob/master/doc/go_spec.html",
        metadata={"path": "doc/go_spec.html"},
    )

    chunks = handler.parse_and_chunk(doc)
    assert len(chunks) == 1
    assert chunks[0].text == "chunk"
