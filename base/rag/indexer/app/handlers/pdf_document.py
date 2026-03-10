"""Handler: PDF documents (whitepapers, guides, frameworks).

Downloads PDFs from URLs, extracts text with PyMuPDF, and splits
by heading-like patterns (chapter/section markers, numbered headings).
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from ..chunking import chunk_text_simple
from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.pdf_document")

MIN_SECTION_CHARS = 50


@register
class PDFDocumentHandler:
    handler_type = "pdf_document"
    source_type = "pdf"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        url = config.get("url", "")
        name = source_config.get("name", url)

        if not url:
            logger.error("pdf_document handler requires config.url")
            return []

        try:
            with httpx.Client(timeout=60, follow_redirects=True) as client:
                resp = client.get(url)
                resp.raise_for_status()
                content = resp.content
        except Exception as e:
            logger.error("Failed to fetch PDF %s: %s", url, e)
            return []

        return [
            RawDocument(
                doc_id=f"pdf:{name}",
                name=name,
                content=content,
                source_url=url,
            )
        ]

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        try:
            import fitz
        except ImportError:
            logger.error("PyMuPDF (fitz) not installed — cannot parse PDFs")
            return []

        pdf_bytes = doc.content if isinstance(doc.content, bytes) else doc.content.encode("utf-8")

        try:
            pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        except Exception as e:
            logger.warning("Failed to open PDF %s: %s", doc.name, e)
            return []

        full_text = ""
        for page in pdf_doc:
            full_text += page.get_text() + "\n"
        pdf_doc.close()

        if not full_text.strip():
            logger.warning("No text extracted from PDF: %s", doc.name)
            return []

        sections = _split_pdf_sections(full_text)
        chunks: list[Chunk] = []
        idx = 0

        for title, body in sections:
            if len(body.strip()) < MIN_SECTION_CHARS:
                continue

            text_chunks = chunk_text_simple(body, max_chars=4000)
            for i, tc in enumerate(text_chunks):
                section_label = title if len(text_chunks) == 1 else f"{title} (part {i + 1})"
                chunks.append(
                    Chunk(
                        text=tc,
                        section=section_label,
                        heading_path=f"{doc.name} > {title}",
                        chunk_index=idx,
                    )
                )
                idx += 1

        logger.info("Extracted %d chunks from PDF: %s", len(chunks), doc.name)
        return chunks


_PDF_HEADING_RE = re.compile(
    r"^(?:"
    r"(?:Chapter|Section|Pillar|Appendix)\s+\d+[.:]\s*.+"
    r"|[A-Z][A-Za-z\s]{5,60}$"
    r"|(?:\d+\.)+\d*\s+[A-Z].+"
    r")",
    re.MULTILINE,
)


def _split_pdf_sections(text: str) -> list[tuple[str, str]]:
    """Split extracted PDF text into sections based on heading patterns."""
    matches = list(_PDF_HEADING_RE.finditer(text))
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
