"""Unified HTML-to-Markdown extraction via trafilatura.

Used by the planner's real-time web fetch path (web_search.py) to convert
fetched HTML pages into structured Markdown before prompt injection.

Replaces the previous regex-based tag stripper that lost all document
structure. Trafilatura handles boilerplate removal and produces clean
Markdown with headings, code blocks, tables, and links preserved.

Kept as a separate copy from the indexer (not a shared package) since
planner and indexer are separate container images with independent
dependency trees.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("synesis.extract")


def html_to_markdown(
    html: str,
    *,
    include_tables: bool = True,
    include_links: bool = True,
    fast: bool = False,
) -> str:
    """Extract main content from HTML and return Markdown.

    Args:
        html: Raw HTML string.
        include_tables: Preserve table content in output.
        include_links: Preserve hyperlink targets in output.
        fast: Skip fallback extraction algorithms (faster but less recall).

    Returns:
        Markdown string, or empty string if extraction fails.
    """
    if not html or not html.strip():
        return ""
    try:
        from trafilatura import extract

        result = extract(
            html,
            output_format="markdown",
            include_tables=include_tables,
            include_links=include_links,
            fast=fast,
        )
        return result or ""
    except Exception as e:
        logger.warning("trafilatura extraction failed: %s", e)
        return ""
