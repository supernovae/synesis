"""Unified HTML-to-Markdown extraction via trafilatura.

Single conversion pipeline for all indexer handlers. Trafilatura handles
boilerplate removal (nav, ads, sidebars, cookie banners) and produces
clean Markdown with headings, code blocks, tables, and links preserved.

This replaces the previous split between markdownify (seed_corpus,
html_document, arxiv_paper) and crawl4ai's built-in converter (web_page).

Post-extraction normalization (normalize_doc_markdown) strips residual
nav/footer lines that trafilatura sometimes leaves and collapses whitespace
so the chunk-level quality gate sees cleaner text.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger("synesis.indexer.extract")
_TRAFILATURA_EXTRACT: Callable[..., str | None] | None | bool = None
_TRAFILATURA_LOGGERS = ("trafilatura", "trafilatura.core", "trafilatura.utils")

# Lines that are *only* nav/footer/chrome residue left by trafilatura.
# Each pattern is matched against a stripped line (case-insensitive).
_NAV_LINE_PATTERNS = (
    r"^\s*skip to (?:main )?content\s*$",
    r"^\s*back to top\s*$",
    r"^\s*menu\s*$",
    r"^\s*search\s*$",
    r"^\s*subscribe\s*$",
    r"^\s*cookie (?:policy|preferences)\s*$",
    r"^\s*contact\s*us?\s*$",
    r"^\s*email\s*us?\s*$",
    r"^\s*newsletter\s*$",
    r"^\s*follow\s+us\s*$",
    r"^\s*sign\s*up\s*$",
    r"^\s*log\s*in\s*$",
    r"^\s*register\s*$",
    r"^\s*share\s+(?:this|on)\s*$",
    r"^\s*tweet\s+this\s*$",
    r"^\s*all\s+rights\s+reserved\.?\s*$",
    r"^\s*powered\s+by\s+.*$",
    r"^\s*toggle\s+(?:navigation|menu|sidebar)\s*$",
    r"^\s*close\s*$",
    r"^\s*home\s*$",
    r"^\s*©.*$",
)
_NAV_LINE_RE = re.compile("|".join(f"({p})" for p in _NAV_LINE_PATTERNS), re.IGNORECASE)


def normalize_doc_markdown(md: str) -> str:
    """Strip nav/footer residues and collapse excess whitespace.

    Call after html_to_markdown() and before heading_aware_split() so the
    chunk-level quality gate sees content without junk lines that would
    trigger boilerplate penalties or thin+boilerplate rejections.
    """
    if not md or not md.strip():
        return md
    lines = md.split("\n")
    cleaned: list[str] = []
    for line in lines:
        if _NAV_LINE_RE.match(line.strip()):
            continue
        cleaned.append(line)
    text = "\n".join(cleaned)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


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
    global _TRAFILATURA_EXTRACT
    if _TRAFILATURA_EXTRACT is None:
        try:
            from trafilatura import extract

            _TRAFILATURA_EXTRACT = extract
        except ModuleNotFoundError as e:
            _TRAFILATURA_EXTRACT = False
            logger.warning("trafilatura unavailable; using basic html fallback: %s", e)
    if _TRAFILATURA_EXTRACT is False:
        return normalize_doc_markdown(_basic_html_to_markdown(html))
    try:
        extract_fn = _TRAFILATURA_EXTRACT
        with _quiet_trafilatura_logs():
            result = extract_fn(
                html,
                output_format="markdown",
                include_tables=include_tables,
                include_links=include_links,
                fast=fast,
            )
        return result or normalize_doc_markdown(_basic_html_to_markdown(html))
    except Exception as e:
        logger.warning("trafilatura extraction failed: %s", e)
        return normalize_doc_markdown(_basic_html_to_markdown(html))


@contextmanager
def _quiet_trafilatura_logs():
    loggers = [logging.getLogger(name) for name in _TRAFILATURA_LOGGERS]
    previous = [(log.level, log.disabled) for log in loggers]
    try:
        for log in loggers:
            log.setLevel(logging.CRITICAL + 1)
        yield
    finally:
        for log, (level, disabled) in zip(loggers, previous, strict=True):
            log.setLevel(level)
            log.disabled = disabled


def _basic_html_to_markdown(html: str) -> str:
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", "", html)
    text = re.sub(r"(?is)<h([1-6])[^>]*>(.*?)</h\1>", _heading_repl, text)
    text = re.sub(r"(?is)<(?:p|div|section|article|main|li|tr|br)\b[^>]*>", "\n", text)
    text = re.sub(r"(?is)</(?:p|div|section|article|main|li|tr|table|ul|ol)>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", "", text)
    text = _html_unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _heading_repl(match: Any) -> str:
    level = int(match.group(1))
    inner = _html_unescape(re.sub(r"(?is)<[^>]+>", "", match.group(2))).strip()
    return f"\n{'#' * level} {inner}\n" if inner else "\n"


def _html_unescape(text: str) -> str:
    import html as html_lib

    return html_lib.unescape(text)
