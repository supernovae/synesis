"""Section-aware document chunker for RAG ingestion.

Splits documents by structural boundaries (markdown headers, man page
sections) before applying token-level chunking with overlap. This
preserves semantic coherence within chunks.
"""

from __future__ import annotations

import re


def _split_by_sections(text: str, doc_type: str) -> list[dict]:
    """Split document into sections based on structure markers."""
    if doc_type == "man":
        pattern = r"^([A-Z][A-Z /]+)$"
        sections = re.split(pattern, text, flags=re.MULTILINE)
    else:
        pattern = r"^(#{1,4}\s+.+)$"
        sections = re.split(pattern, text, flags=re.MULTILINE)

    result = []
    current_section = ""

    for i, part in enumerate(sections):
        stripped = part.strip()
        if not stripped:
            continue

        is_header = False
        if doc_type == "man":
            is_header = bool(re.match(r"^[A-Z][A-Z /]+$", stripped))
        else:
            is_header = stripped.startswith("#")

        if is_header:
            current_section = stripped.lstrip("#").strip()
        else:
            result.append({"section": current_section, "text": stripped})

    if not result and text.strip():
        result.append({"section": "", "text": text.strip()})

    return result


def _chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    """Split text into overlapping chunks by approximate token count.

    Uses whitespace splitting as a ~75% accurate token approximation.
    Good enough for chunking; the embedding model handles the rest.
    """
    words = text.split()
    if len(words) <= chunk_size:
        return [text]

    chunks = []
    start = 0
    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        if end >= len(words):
            break
        start = end - overlap

    return chunks


def chunk_document(
    content: str,
    chunk_size: int = 512,
    overlap: int = 64,
    doc_type: str = "markdown",
) -> list[dict]:
    """Chunk a document with section awareness.

    Returns list of dicts with 'text' and 'section' keys.
    """
    sections = _split_by_sections(content, doc_type)

    chunks = []
    for section in sections:
        text_chunks = _chunk_text(section["text"], chunk_size, overlap)
        for tc in text_chunks:
            if tc.strip():
                chunks.append({
                    "text": tc.strip(),
                    "section": section["section"],
                })

    return chunks
