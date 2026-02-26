"""GitHub PR/commit pattern extractor.

When GITHUB_TOKEN is available, uses PyGithub to fetch merged PRs
with title, body, merge commit message, changed files, and labels.
Falls back to git-log-only when no token is present.

These patterns capture the "why" behind code changes, aligned with
Safety-II resilience thinking.
"""

from __future__ import annotations

import logging
import os
import subprocess
from dataclasses import dataclass

logger = logging.getLogger("synesis.indexer.github")

MAX_PRS = 500


@dataclass
class PatternChunk:
    text: str
    source: str
    pattern_type: str


def extract_pr_patterns(
    repo_full_name: str,
    clone_dir: str,
    language: str,
    max_prs: int = MAX_PRS,
) -> list[PatternChunk]:
    """Extract PR/commit patterns from a repository.

    Uses GitHub API if GITHUB_TOKEN is set, otherwise falls back
    to git log for merge commits only.
    """
    token = os.environ.get("GITHUB_TOKEN", "")

    if token:
        return _extract_via_github_api(repo_full_name, language, token, max_prs)

    return _extract_via_git_log(clone_dir, repo_full_name, language)


def _extract_via_github_api(
    repo_full_name: str,
    language: str,
    token: str,
    max_prs: int,
) -> list[PatternChunk]:
    """Fetch merged PRs via PyGithub."""
    try:
        from github import Github
    except ImportError:
        logger.warning("PyGithub not installed, falling back to git log")
        return []

    chunks: list[PatternChunk] = []

    try:
        gh = Github(token, per_page=100)
        repo = gh.get_repo(repo_full_name)

        pulls = repo.get_pulls(state="closed", sort="updated", direction="desc")
        count = 0

        for pr in pulls:
            if count >= max_prs:
                break
            if not pr.merged:
                continue

            labels = ", ".join(l.name for l in pr.labels) if pr.labels else ""

            files_changed: list[str] = []
            try:
                for f in pr.get_files()[:20]:
                    files_changed.append(f.filename)
            except Exception:
                pass

            body = (pr.body or "")[:2000]
            merge_msg = ""
            if pr.merge_commit_sha:
                try:
                    commit = repo.get_commit(pr.merge_commit_sha)
                    merge_msg = commit.commit.message[:500]
                except Exception:
                    pass

            text = (
                f"PR #{pr.number}: {pr.title}\n"
                f"Author: {pr.user.login if pr.user else 'unknown'}\n"
                f"Merged: {pr.merged_at}\n"
            )
            if labels:
                text += f"Labels: {labels}\n"
            if files_changed:
                text += f"Files changed: {', '.join(files_changed[:10])}\n"
            if merge_msg:
                text += f"Merge commit: {merge_msg}\n"
            text += f"\n{body}"

            chunks.append(PatternChunk(
                text=text[:8000],
                source=f"repo:{repo_full_name} pr:{pr.number}",
                pattern_type="pr_description",
            ))
            count += 1

        logger.info(f"Extracted {len(chunks)} PR patterns from {repo_full_name}")

    except Exception as e:
        logger.warning(f"GitHub API extraction failed for {repo_full_name}: {e}")

    return chunks


def _extract_via_git_log(
    clone_dir: str,
    repo_full_name: str,
    language: str,
) -> list[PatternChunk]:
    """Fall back to git log --merges for merge commit messages."""
    chunks: list[PatternChunk] = []

    try:
        result = subprocess.run(
            [
                "git", "log", "--merges", "--format=%H|%s|%b",
                "-n", "500",
            ],
            cwd=clone_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode != 0:
            logger.warning(f"git log failed for {clone_dir}: {result.stderr[:200]}")
            return chunks

        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue

            parts = line.split("|", 2)
            sha = parts[0][:12] if parts else ""
            subject = parts[1] if len(parts) > 1 else ""
            body = parts[2] if len(parts) > 2 else ""

            text = f"Merge commit {sha}: {subject}"
            if body.strip():
                text += f"\n{body[:2000]}"

            if len(text.strip()) < 20:
                continue

            chunks.append(PatternChunk(
                text=text[:8000],
                source=f"repo:{repo_full_name} commit:{sha}",
                pattern_type="commit_message",
            ))

        logger.info(f"Extracted {len(chunks)} merge commit patterns from {repo_full_name} (git log)")

    except Exception as e:
        logger.warning(f"Git log extraction failed for {clone_dir}: {e}")

    return chunks
