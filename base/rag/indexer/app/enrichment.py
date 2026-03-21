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

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger("synesis.indexer.enrichment")


@dataclass
class EnrichmentResult:
    """Enrichment output for a single chunk."""

    context_prefix: str = ""
    keywords: str = ""
    chunk_summary: str = ""
    semantic_profile: dict[str, Any] | None = None


_PASS_B_SYSTEM_PROMPT = """You are a chunk-level semantic enricher for technical corpora.
Return ONLY valid JSON with keys:
- summary_one_line: concise neutral summary (<= 200 chars)
- context_prefix: one sentence that disambiguates chunk context within doc (<= 220 chars)
- keywords: array of up to 8 short keyword strings
- confidence: float 0..1
Do not include markdown or commentary."""


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
        sem = _generate_chunk_semantics(text, document_name, heading_path, llm_url)
        if sem:
            result.semantic_profile = sem
            result.chunk_summary = str(sem.get("summary_one_line") or "")[:200]
            cp = str(sem.get("context_prefix") or "")[:220]
            if cp:
                result.context_prefix = cp
            kws = sem.get("keywords")
            if isinstance(kws, list):
                clean = [str(k).strip() for k in kws if str(k).strip()]
                result.keywords = ",".join(clean[:8])[:512]

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
            sem = _generate_chunk_semantics(c["text"], document_name, c.get("heading_path", ""), llm_url)
            if not sem:
                continue
            results[i].semantic_profile = sem
            results[i].chunk_summary = str(sem.get("summary_one_line") or "")[:200]
            cp = str(sem.get("context_prefix") or "")[:220]
            if cp:
                results[i].context_prefix = cp
            kws = sem.get("keywords")
            if isinstance(kws, list):
                clean = [str(k).strip() for k in kws if str(k).strip()]
                results[i].keywords = ",".join(clean[:8])[:512]

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
            sem = _generate_chunk_semantics(text, doc_name, heading, llm_url)
            if not sem:
                continue
            results[i].semantic_profile = sem
            results[i].chunk_summary = str(sem.get("summary_one_line") or "")[:200]
            cp = str(sem.get("context_prefix") or "")[:220]
            if cp:
                results[i].context_prefix = cp
            kws = sem.get("keywords")
            if isinstance(kws, list):
                clean = [str(k).strip() for k in kws if str(k).strip()]
                results[i].keywords = ",".join(clean[:8])[:512]

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


def _generate_chunk_semantics(
    text: str,
    document_name: str,
    heading_path: str,
    llm_url: str,
) -> dict[str, Any] | None:
    prompt = (
        f"Document: {document_name}\n"
        f"Section path: {heading_path}\n\n"
        f"Chunk:\n{text[:2200]}"
    )
    obj = _llm_complete_json(
        prompt,
        llm_url,
        max_tokens=220,
        system_prompt=_PASS_B_SYSTEM_PROMPT,
    )
    if not isinstance(obj, dict):
        return None
    summary = str(obj.get("summary_one_line") or "").strip()[:200]
    context_prefix = str(obj.get("context_prefix") or "").strip()[:220]
    kw_raw = obj.get("keywords") or []
    keywords: list[str] = []
    if isinstance(kw_raw, list):
        for v in kw_raw[:8]:
            s = str(v).strip()[:64]
            if s:
                keywords.append(s)
    try:
        confidence = float(obj.get("confidence"))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))
    if not summary and not context_prefix:
        return None
    return {
        "summary_one_line": summary,
        "context_prefix": context_prefix,
        "keywords": keywords,
        "confidence": confidence,
        "contract_version": "pass_b_v1",
    }


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


def _llm_complete_json(
    prompt: str,
    llm_url: str,
    *,
    max_tokens: int = 220,
    system_prompt: str = "",
) -> dict[str, Any] | None:
    try:
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        resp = httpx.post(
            f"{llm_url}/chat/completions",
            json={
                "model": "synesis-general",
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": 0.1,
            },
            timeout=30,
        )
        resp.raise_for_status()
        content = str(resp.json()["choices"][0]["message"]["content"]).strip()
    except Exception as e:
        logger.warning("LLM enrichment JSON call failed: %s", e)
        return None

    if content.startswith("```"):
        content = content.removeprefix("```json").removeprefix("```").strip()
        if content.endswith("```"):
            content = content[:-3].strip()

    try:
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        # Lightweight salvage: parse first JSON object boundaries.
        s = content.find("{")
        e = content.rfind("}")
        if s >= 0 and e > s:
            try:
                parsed = json.loads(content[s : e + 1])
                return parsed if isinstance(parsed, dict) else None
            except Exception:
                return None
        return None
