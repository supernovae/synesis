"""Handler: GitHub Markdown files (runbooks, docs, guides).

Fetches markdown files from a GitHub repo path via REST API,
then chunks them with heading-aware splitting.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..chunking import heading_aware_split
from . import register
from .base import BaseHandler, Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.github_markdown")

GITHUB_API = "https://api.github.com"


@register
class GitHubMarkdownHandler:
    handler_type = "github_markdown"
    source_type = "markdown"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        repo = config.get("repo", "")
        branch = config.get("branch", "main")
        path = config.get("path", "")
        token = config.get("token")
        name = source_config.get("name", repo)

        if not repo:
            logger.error("github_markdown handler requires config.repo")
            return []

        md_paths = _list_md_files(repo, path, branch, token)
        if not md_paths:
            logger.warning("No markdown files found in %s/%s", repo, path)
            return []

        docs: list[RawDocument] = []
        github_base = f"https://github.com/{repo}/blob/{branch}"

        for fp in md_paths:
            try:
                content = _fetch_raw(repo, fp, branch, token)
                docs.append(
                    RawDocument(
                        doc_id=f"github:{repo}:{fp}",
                        name=f"{name}: {fp}",
                        content=content,
                        source_url=f"{github_base}/{fp}",
                        metadata={"repo": repo, "branch": branch, "path": fp},
                    )
                )
            except Exception as e:
                logger.warning("Failed to fetch %s/%s: %s", repo, fp, e)

        logger.info("Fetched %d markdown files from %s/%s", len(docs), repo, path)
        return docs

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        if isinstance(doc.content, bytes):
            text = doc.content.decode("utf-8", errors="replace")
        else:
            text = doc.content

        text_chunks = heading_aware_split(text, document_name=doc.name)
        return [
            Chunk(
                text=tc.text,
                section=tc.section,
                heading_path=tc.heading_path,
                chunk_index=tc.chunk_index,
            )
            for tc in text_chunks
        ]


def _list_md_files(
    repo: str, path: str, branch: str, token: str | None,
) -> list[str]:
    """List all .md file paths under a GitHub repo path via the tree API."""
    owner, name = repo.split("/", 1)
    url = f"{GITHUB_API}/repos/{owner}/{name}/git/trees/{branch}?recursive=1"
    headers: dict[str, str] = {"Accept": "application/vnd.github.v3+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    with httpx.Client(timeout=30) as client:
        resp = client.get(url, headers=headers)
        resp.raise_for_status()
        trees = resp.json().get("tree", [])

    prefix = f"{path}/" if path and not path.endswith("/") else (path or "")
    return sorted(
        item["path"]
        for item in trees
        if item.get("type") == "blob"
        and item["path"].endswith(".md")
        and (not prefix or item["path"].startswith(prefix) or item["path"] == path)
    )


def _fetch_raw(
    repo: str, path: str, branch: str, token: str | None,
) -> str:
    """Fetch raw file content from GitHub."""
    owner, name = repo.split("/", 1)
    url = f"https://raw.githubusercontent.com/{owner}/{name}/{branch}/{path}"
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    with httpx.Client(timeout=30, follow_redirects=True) as client:
        resp = client.get(url, headers=headers)
        resp.raise_for_status()
        return resp.text
