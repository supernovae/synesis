"""Enrichment pipeline: context_prefix and optional LLM chunk_summary.

Tier 1 (always, ~0 cost):
  - context_prefix: Template-based from document name + heading_path

Tier 2 (--enrich full, uses synesis-general LLM):
  - chunk_summary: 1-2 sentence neutral description via LLM
  - Enhanced context_prefix: LLM-generated contextual sentence

Keyword extraction removed: BM25 benchmark (benchmarks/bm25/) showed that
Milvus native BM25 on raw text outperforms enriched-text BM25, and keywords
were only consumed by the now-removed custom BM25 service.

Research: Anthropic Contextual Retrieval (2024), arxiv 2601.11863.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

logger = logging.getLogger("synesis.indexer.enrichment")


@dataclass
class EnrichmentResult:
    """Enrichment output for a single chunk."""

    context_prefix: str = ""
    keywords: str = ""
    chunk_summary: str = ""


def enrich_chunk(
    text: str,
    document_name: str = "",
    heading_path: str = "",
    section: str = "",
    full_mode: bool = False,
    llm_url: str = "",
) -> EnrichmentResult:
    """Enrich a single chunk with context_prefix and optional summary."""
    result = EnrichmentResult()
    result.context_prefix = _build_context_prefix(document_name, heading_path, section)

    if full_mode and llm_url:
        result.chunk_summary = _generate_chunk_summary(text, document_name, heading_path, llm_url)
        if result.chunk_summary:
            result.context_prefix = (
                _generate_llm_context_prefix(text, document_name, heading_path, llm_url) or result.context_prefix
            )

    return result


def enrich_batch(
    chunks: list[dict],
    document_name: str = "",
    full_mode: bool = False,
    llm_url: str = "",
) -> list[EnrichmentResult]:
    """Enrich a batch of chunks. Each dict must have 'text', and optionally
    'heading_path' and 'section'."""
    results = [
        EnrichmentResult(
            context_prefix=_build_context_prefix(
                document_name,
                c.get("heading_path", ""),
                c.get("section", ""),
            ),
        )
        for c in chunks
    ]

    if full_mode and llm_url:
        for i, c in enumerate(chunks):
            results[i].chunk_summary = _generate_chunk_summary(
                c["text"],
                document_name,
                c.get("heading_path", ""),
                llm_url,
            )
            if results[i].chunk_summary:
                results[i].context_prefix = (
                    _generate_llm_context_prefix(
                        c["text"],
                        document_name,
                        c.get("heading_path", ""),
                        llm_url,
                    )
                    or results[i].context_prefix
                )

    return results


def enrich_chunks_bulk(
    items: list[tuple],
    enrich_full: bool = False,
    llm_url: str = "",
) -> list[EnrichmentResult]:
    """Enrich an arbitrary list of (text, document_name, heading_path, section) tuples.

    Uses batched keyword extraction for all chunks at once, regardless of which
    document they belong to. This is the preferred entry-point from pipeline.py.
    """
    results = [
        EnrichmentResult(
            context_prefix=_build_context_prefix(doc_name, heading, section),
        )
        for (_text, doc_name, heading, section) in items
    ]

    if enrich_full and llm_url:
        for i, (text, doc_name, heading, _section) in enumerate(items):
            results[i].chunk_summary = _generate_chunk_summary(
                text,
                doc_name,
                heading,
                llm_url,
            )
            if results[i].chunk_summary:
                results[i].context_prefix = (
                    _generate_llm_context_prefix(
                        text,
                        doc_name,
                        heading,
                        llm_url,
                    )
                    or results[i].context_prefix
                )

    return results


def _build_context_prefix(
    document_name: str,
    heading_path: str,
    section: str = "",
) -> str:
    """Template-based context_prefix (Tier 1 Contextual Retrieval)."""
    parts = []
    if document_name:
        parts.append(f"From '{document_name}'")
    if heading_path:
        parts.append(f"section '{heading_path}'")
    elif section:
        parts.append(f"section '{section}'")

    if not parts:
        return ""

    return ", ".join(parts) + "."


def _generate_chunk_summary(
    text: str,
    document_name: str,
    heading_path: str,
    llm_url: str,
) -> str:
    """Generate a 1-2 sentence chunk summary via synesis-general LLM."""
    prompt = (
        "Write a 1-2 sentence neutral description of the following text chunk. "
        "Do not include opinions or recommendations. Just describe what the chunk covers.\n\n"
        f"Document: {document_name}\n"
        f"Section: {heading_path}\n\n"
        f"Text:\n{text[:2000]}\n\n"
        "Summary:"
    )
    return _llm_complete(prompt, llm_url, max_tokens=100)


def _generate_llm_context_prefix(
    text: str,
    document_name: str,
    heading_path: str,
    llm_url: str,
) -> str:
    """Generate an LLM-based context prefix (Tier 2 / full Anthropic pattern)."""
    prompt = (
        "Given the following chunk from a document, write a single sentence that "
        "describes how this chunk fits within the document. This sentence will be "
        "prepended to the chunk for embedding, so it should provide context that "
        "helps disambiguate the chunk's meaning.\n\n"
        f"Document: {document_name}\n"
        f"Section path: {heading_path}\n\n"
        f"Chunk:\n{text[:2000]}\n\n"
        "Context sentence:"
    )
    return _llm_complete(prompt, llm_url, max_tokens=80)


def _llm_complete(prompt: str, llm_url: str, max_tokens: int = 100) -> str:
    """Call an OpenAI-compatible completion endpoint."""
    try:
        resp = httpx.post(
            f"{llm_url}/chat/completions",
            json={
                "model": "synesis-general",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": 0.1,
            },
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        logger.warning("LLM enrichment call failed: %s", e)
        return ""
