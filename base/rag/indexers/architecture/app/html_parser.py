"""HTML/Markdown document parser for architecture documentation.

Parses HTML pages (using BeautifulSoup) and Markdown files,
splitting them by heading-level sections for RAG ingestion.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

logger = logging.getLogger("synesis.indexer.architecture.html")

MIN_SECTION_CHARS = 50
MAX_CHUNK_CHARS = 4000


@dataclass
class SectionChunk:
    text: str
    section: str
    document_name: str
    tags: list[str]


def parse_html(
    html_content: str,
    document_name: str,
    tags: list[str] | None = None,
) -> list[SectionChunk]:
    """Parse HTML content into section-based chunks."""
    try:
        from bs4 import BeautifulSoup
        from markdownify import markdownify
    except ImportError:
        logger.error("beautifulsoup4/markdownify not installed")
        return []

    tags = tags or []
    soup = BeautifulSoup(html_content, "html.parser")

    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()

    markdown_text = markdownify(str(soup), heading_style="ATX")
    return parse_markdown(markdown_text, document_name, tags)


def parse_markdown(
    md_content: str,
    document_name: str,
    tags: list[str] | None = None,
) -> list[SectionChunk]:
    """Parse Markdown content into section-based chunks."""
    tags = tags or []
    sections = _split_by_headings(md_content)
    chunks: list[SectionChunk] = []

    for title, body in sections:
        if len(body.strip()) < MIN_SECTION_CHARS:
            continue

        text_chunks = _chunk_text(body, MAX_CHUNK_CHARS)
        for i, tc in enumerate(text_chunks):
            chunk_title = title
            if len(text_chunks) > 1:
                chunk_title = f"{title} (part {i + 1})"

            chunks.append(
                SectionChunk(
                    text=tc,
                    section=chunk_title,
                    document_name=document_name,
                    tags=tags,
                )
            )

    logger.info(f"Extracted {len(chunks)} sections from: {document_name}")
    return chunks


def _split_by_headings(md_text: str) -> list[tuple[str, str]]:
    """Split markdown text by # headings."""
    heading_pattern = re.compile(r"^(#{1,4})\s+(.+)$", re.MULTILINE)
    matches = list(heading_pattern.finditer(md_text))

    if not matches:
        return [("Document", md_text)]

    sections: list[tuple[str, str]] = []

    if matches[0].start() > MIN_SECTION_CHARS:
        sections.append(("Introduction", md_text[: matches[0].start()].strip()))

    for i, match in enumerate(matches):
        title = match.group(2).strip()
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(md_text)
        body = md_text[start:end].strip()
        if body:
            sections.append((title, body))

    return sections


def _chunk_text(text: str, max_chars: int) -> list[str]:
    """Split text into chunks at paragraph boundaries."""
    if len(text) <= max_chars:
        return [text]

    paragraphs = text.split("\n\n")
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        if current_len + len(para) > max_chars and current:
            chunks.append("\n\n".join(current))
            current = []
            current_len = 0

        current.append(para)
        current_len += len(para) + 2

    if current:
        chunks.append("\n\n".join(current))

    return chunks
