"""PDF document parser for architecture whitepaper ingestion.

Uses PyMuPDF (fitz) to extract text from PDF documents and split
by headings/sections. Each section becomes a chunk with metadata
about the document, section title, and tags.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from io import BytesIO

logger = logging.getLogger("synesis.indexer.architecture.pdf")

MIN_SECTION_CHARS = 50
MAX_CHUNK_CHARS = 4000


@dataclass
class SectionChunk:
    text: str
    section: str
    document_name: str
    tags: list[str]


def parse_pdf(
    pdf_bytes: bytes,
    document_name: str,
    tags: list[str] | None = None,
) -> list[SectionChunk]:
    """Extract text from PDF and split into section-based chunks."""
    try:
        import fitz
    except ImportError:
        logger.error("PyMuPDF (fitz) not installed -- cannot parse PDFs")
        return []

    tags = tags or []
    chunks: list[SectionChunk] = []

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        logger.warning(f"Failed to open PDF {document_name}: {e}")
        return []

    full_text = ""
    for page in doc:
        full_text += page.get_text() + "\n"

    doc.close()

    if not full_text.strip():
        logger.warning(f"No text extracted from PDF: {document_name}")
        return []

    sections = _split_into_sections(full_text)

    for section_title, section_text in sections:
        if len(section_text.strip()) < MIN_SECTION_CHARS:
            continue

        text_chunks = _chunk_text(section_text, MAX_CHUNK_CHARS)
        for i, tc in enumerate(text_chunks):
            chunk_title = section_title
            if len(text_chunks) > 1:
                chunk_title = f"{section_title} (part {i + 1})"

            chunks.append(SectionChunk(
                text=tc,
                section=chunk_title,
                document_name=document_name,
                tags=tags,
            ))

    logger.info(f"Extracted {len(chunks)} sections from PDF: {document_name}")
    return chunks


def _split_into_sections(text: str) -> list[tuple[str, str]]:
    """Split text into sections based on heading-like patterns."""
    heading_pattern = re.compile(
        r"^(?:"
        r"(?:Chapter|Section|Pillar|Appendix)\s+\d+[.:]\s*.+"
        r"|[A-Z][A-Za-z\s]{5,60}$"
        r"|(?:\d+\.)+\d*\s+[A-Z].+"
        r")",
        re.MULTILINE,
    )

    matches = list(heading_pattern.finditer(text))
    if not matches:
        return [("Document", text)]

    sections: list[tuple[str, str]] = []

    if matches[0].start() > MIN_SECTION_CHARS:
        sections.append(("Introduction", text[: matches[0].start()].strip()))

    for i, match in enumerate(matches):
        title = match.group().strip()[:200]
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
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
