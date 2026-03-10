"""Unified HTML-to-Markdown extraction via trafilatura.

Single conversion pipeline for all indexer handlers. Trafilatura handles
boilerplate removal (nav, ads, sidebars, cookie banners) and produces
clean Markdown with headings, code blocks, tables, and links preserved.

This replaces the previous split between markdownify (seed_corpus,
html_document, arxiv_paper) and crawl4ai's built-in converter (web_page).
"""

from __future__ import annotations

import logging

logger = logging.getLogger("synesis.indexer.extract")


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
