"""Fetch markdown files from GitHub repos via REST API."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

logger = logging.getLogger("synesis.indexer.domain.github")

GITHUB_API = "https://api.github.com"


@dataclass
class MarkdownFile:
    path: str
    content: str
    repo: str
    branch: str


def list_md_files_recursive(
    repo: str,
    path: str,
    branch: str = "master",
    token: str | None = None,
) -> list[str]:
    """List all .md file paths under a GitHub repo path. Uses recursive tree API."""
    owner, name = repo.split("/", 1)
    url = f"{GITHUB_API}/repos/{owner}/{name}/git/trees/{branch}?recursive=1"
    headers: dict[str, str] = {"Accept": "application/vnd.github.v3+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    with httpx.Client(timeout=30) as client:
        resp = client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        trees = data.get("tree", [])

    prefix = f"{path}/" if not path.endswith("/") else path
    if path and not prefix.endswith("/"):
        prefix += "/"
    # Match path exactly or as prefix
    if path == "":
        prefix = ""

    md_paths: list[str] = []
    for item in trees:
        p = item.get("path", "")
        tp = item.get("type", "")
        if tp == "blob" and p.endswith(".md"):
            if prefix == "" or p.startswith(prefix) or p == path:
                md_paths.append(p)

    return sorted(md_paths)


def fetch_file_content(
    repo: str,
    path: str,
    branch: str = "master",
    token: str | None = None,
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


def fetch_all_markdown(
    repo: str,
    path: str,
    branch: str = "master",
    token: str | None = None,
) -> list[MarkdownFile]:
    """List and fetch all markdown files under path. Returns list of (path, content)."""
    md_paths = list_md_files_recursive(repo, path, branch, token)
    results: list[MarkdownFile] = []

    for fp in md_paths:
        try:
            content = fetch_file_content(repo, fp, branch, token)
            results.append(MarkdownFile(path=fp, content=content, repo=repo, branch=branch))
        except Exception as e:
            logger.warning(f"Failed to fetch {repo}/{fp}: {e}")

    return results
