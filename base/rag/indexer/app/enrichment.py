"""Enrichment pipeline: KeyBERT keywords, context_prefix, optional LLM chunk_summary.

Tier 1 (always, ~0 cost):
  - context_prefix: Template-based from document name + heading_path
  - keywords: KeyBERT extraction (5-10 terms per chunk, deterministic)

Tier 2 (--enrich full, uses synesis-general LLM):
  - chunk_summary: 1-2 sentence neutral description via LLM
  - Enhanced context_prefix: LLM-generated contextual sentence

Tier 1 alone captures most Contextual Retrieval benefit because the heading
path and document name are the primary context signals.

Research: Anthropic Contextual Retrieval (2024), arxiv 2601.11863.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

logger = logging.getLogger("synesis.indexer.enrichment")

_kw_model = None


def _get_keybert_model():
    """Lazy-load KeyBERT model (loaded once, reused)."""
    global _kw_model
    if _kw_model is None:
        try:
            from keybert import KeyBERT

            _kw_model = KeyBERT(model="all-MiniLM-L6-v2")
            logger.info("KeyBERT model loaded")
        except ImportError:
            logger.warning("keybert not installed — keyword extraction disabled")
    return _kw_model


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
    """Enrich a single chunk with context_prefix, keywords, and optional summary."""
    result = EnrichmentResult()

    # Tier 1: template-based context_prefix
    result.context_prefix = _build_context_prefix(document_name, heading_path, section)

    # Tier 1: KeyBERT keywords
    result.keywords = _extract_keywords(text)

    # Tier 2: LLM-based chunk_summary (only in full mode with LLM available)
    if full_mode and llm_url:
        result.chunk_summary = _generate_chunk_summary(text, document_name, heading_path, llm_url)
        if result.chunk_summary:
            result.context_prefix = _generate_llm_context_prefix(
                text, document_name, heading_path, llm_url
            ) or result.context_prefix

    return result


def enrich_batch(
    chunks: list[dict],
    document_name: str = "",
    full_mode: bool = False,
    llm_url: str = "",
) -> list[EnrichmentResult]:
    """Enrich a batch of chunks. Each dict must have 'text', and optionally
    'heading_path' and 'section'."""
    results = []
    for chunk in chunks:
        results.append(
            enrich_chunk(
                text=chunk["text"],
                document_name=document_name,
                heading_path=chunk.get("heading_path", ""),
                section=chunk.get("section", ""),
                full_mode=full_mode,
                llm_url=llm_url,
            )
        )
    return results


def _build_context_prefix(
    document_name: str,
    heading_path: str,
    section: str = "",
) -> str:
    """Build a template-based context_prefix from document metadata.

    This is the Tier 1 (free, deterministic) version of Anthropic's
    Contextual Retrieval pattern. The heading path and document name
    provide the primary context signals.
    """
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


def _extract_keywords(text: str, top_n: int = 8) -> str:
    """Extract keywords using KeyBERT. Returns comma-separated string."""
    model = _get_keybert_model()
    if model is None:
        return ""

    try:
        kw_results = model.extract_keywords(
            text,
            keyphrase_ngram_range=(1, 2),
            stop_words="english",
            top_n=top_n,
            use_mmr=True,
            diversity=0.5,
        )
        keywords = [kw for kw, _score in kw_results]
        return ", ".join(keywords)
    except Exception as e:
        logger.debug("KeyBERT extraction failed: %s", e)
        return ""


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
