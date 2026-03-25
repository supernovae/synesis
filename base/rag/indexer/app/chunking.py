"""Shared chunking module: heading-aware split with structure preservation.

Consolidates 4+ duplicated splitting implementations into one.

Features:
- Heading-aware split by H1-H3, tracking full heading_path ancestry
- Table and code block preservation (regex fencing)
- Size guard with word-based overlap for oversized sections
- heading_path tracking: "Architecture > Retrieval > BM25"

Research: arxiv 2602.16974 — structure-based chunking outperforms LLM-guided
chunking; recursive/semantic chunkers with 10-20% overlap deliver 30-50%
higher retrieval precision vs fixed sizing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MIN_SECTION_CHARS = 20
DEFAULT_MAX_WORDS = 600
DEFAULT_OVERLAP_WORDS = 80
DEFAULT_MAX_CHARS = 4000

# Hard ceiling: Milvus text field is VARCHAR(8192) *bytes*.
# catalog_entity() truncates with _trunc_bytes(text, 8192), but silent
# truncation drops content.  Instead, re-split oversized chunks here so
# nothing is silently lost.
SCHEMA_MAX_BYTES = 8192

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
_CODE_BLOCK_RE = re.compile(r"```[\s\S]*?```", re.MULTILINE)
_TABLE_RE = re.compile(r"(?:^\|.+\|$\n?)+", re.MULTILINE)


@dataclass
class TextChunk:
    """A chunk of text with structural metadata from the source document."""

    text: str
    section: str = ""
    heading_path: str = ""
    chunk_index: int = 0
    document_name: str = ""


@dataclass
class _HeadingNode:
    """Internal: tracks a heading and its level for path computation."""

    level: int
    title: str
    start: int
    end: int = 0


def heading_aware_split(
    content: str,
    document_name: str = "",
    max_words: int = DEFAULT_MAX_WORDS,
    overlap_words: int = DEFAULT_OVERLAP_WORDS,
) -> list[TextChunk]:
    """Split markdown by headings (H1-H6), tracking heading_path ancestry.

    Sections exceeding max_words are sub-chunked with overlap. Tables and
    code blocks within a section are kept intact where possible.
    """
    if not content or not content.strip():
        return []

    matches = list(_HEADING_RE.finditer(content))
    if not matches:
        chunks = _word_chunk(content.strip(), max_words, overlap_words)
        return [
            TextChunk(
                text=c,
                section="Document",
                heading_path=document_name or "Document",
                chunk_index=i,
                document_name=document_name,
            )
            for i, c in enumerate(chunks)
        ]

    sections = _extract_sections(content, matches)
    heading_stack: list[tuple[int, str]] = []
    all_chunks: list[TextChunk] = []
    chunk_counter = 0

    for level, title, body in sections:
        if len(body.strip()) < MIN_SECTION_CHARS:
            continue

        heading_stack = _update_heading_stack(heading_stack, level, title)
        heading_path = " > ".join(t for _, t in heading_stack)

        sub_chunks = _word_chunk(body, max_words, overlap_words)
        for i, text in enumerate(sub_chunks):
            section_label = title
            if len(sub_chunks) > 1:
                section_label = f"{title} (part {i + 1})"

            all_chunks.append(
                TextChunk(
                    text=text,
                    section=section_label,
                    heading_path=heading_path,
                    chunk_index=chunk_counter,
                    document_name=document_name,
                )
            )
            chunk_counter += 1

    return all_chunks


def _extract_sections(
    content: str,
    matches: list[re.Match],
) -> list[tuple[int, str, str]]:
    """Extract (level, title, body) tuples from heading matches."""
    sections: list[tuple[int, str, str]] = []

    if matches[0].start() > MIN_SECTION_CHARS:
        preamble = content[: matches[0].start()].strip()
        sections.append((1, "Introduction", preamble))

    for i, match in enumerate(matches):
        level = len(match.group(1))
        title = match.group(2).strip()
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        body = content[start:end].strip()
        if body:
            sections.append((level, title, body))

    return sections


def _update_heading_stack(
    stack: list[tuple[int, str]],
    level: int,
    title: str,
) -> list[tuple[int, str]]:
    """Maintain heading ancestry: pop headings at same or deeper level, push new."""
    while stack and stack[-1][0] >= level:
        stack.pop()
    stack.append((level, title))
    return stack


def _word_chunk(
    text: str,
    max_words: int = DEFAULT_MAX_WORDS,
    overlap_words: int = DEFAULT_OVERLAP_WORDS,
) -> list[str]:
    """Split text into overlapping word-based chunks, preserving code blocks and tables.

    After block restoration, any chunk exceeding SCHEMA_MAX_BYTES is re-split
    by character boundary so nothing is silently truncated by catalog_entity().
    """
    protected, store = _protect_blocks(text)
    words = protected.split()

    if len(words) <= max_words:
        return _enforce_byte_limit(_restore_blocks(text, store))

    chunks: list[str] = []
    start = 0
    while start < len(words):
        end = min(start + max_words, len(words))
        chunk_text = " ".join(words[start:end])
        chunks.extend(_enforce_byte_limit(_restore_blocks(chunk_text, store)))
        if end >= len(words):
            break
        start = end - overlap_words

    return chunks


def _enforce_byte_limit(text: str) -> list[str]:
    """Re-split a single chunk if its UTF-8 encoding exceeds SCHEMA_MAX_BYTES."""
    if len(text.encode("utf-8")) <= SCHEMA_MAX_BYTES:
        return [text]

    safe_limit = SCHEMA_MAX_BYTES - 64  # small buffer for multi-byte edge
    encoded = text.encode("utf-8")
    parts: list[str] = []
    pos = 0
    while pos < len(encoded):
        end = min(pos + safe_limit, len(encoded))
        fragment = encoded[pos:end].decode("utf-8", errors="ignore")
        if fragment.strip():
            parts.append(fragment)
        pos = end
    return parts if parts else [text[:safe_limit]]


_PLACEHOLDER_PREFIX = "\x00PROTECTED_"


def _protect_blocks(text: str) -> tuple[str, dict[str, str]]:
    """Replace code blocks and tables with placeholders to prevent splitting mid-block.

    Returns (protected_text, store) where store maps placeholder keys to originals.
    Uses function-local state so concurrent calls never interfere.
    """
    store: dict[str, str] = {}
    counter = 0

    def _replace(m: re.Match) -> str:
        nonlocal counter
        counter += 1
        key = f"{_PLACEHOLDER_PREFIX}{counter}"
        store[key] = m.group(0)
        return key

    text = _CODE_BLOCK_RE.sub(_replace, text)
    text = _TABLE_RE.sub(_replace, text)
    return text, store


def _restore_blocks(text: str, store: dict[str, str]) -> str:
    """Restore protected code blocks and tables from placeholders."""
    for key, original in store.items():
        text = text.replace(key, original)
    return text


def chunk_text_simple(
    text: str,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> list[str]:
    """Simple paragraph-boundary chunking for non-markdown content (PDFs, etc.)."""
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
