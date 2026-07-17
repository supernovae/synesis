"""Handler: curated JSON source manifest.

Reads a JSON manifest, fetches each source URL, and produces chunks with
per-source domain and tag metadata. HTML pages are converted to Markdown via
trafilatura; PDFs are extracted with PyMuPDF. Every entry carries its own
domain and tags, which propagate to NornicDB at index time through
chunk.metadata overrides.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from synesis_telemetry import get_logger

from ..chunking import chunk_text_simple, heading_aware_split
from ..content_gate import GatePolicy, evaluate_page
from ..extract import normalize_doc_markdown
from ..safe_http import get_public_https
from . import register
from .base import Chunk, RawDocument

logger = get_logger("synesis.indexer.handler.seed_corpus")

_FETCH_TIMEOUT = 45


@register
class SeedCorpusHandler:
    handler_type = "seed_corpus"
    source_type = "source_manifest"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        json_path = config.get("path", "")
        doc_id_prefix = config.get("doc_id_prefix", "curated")

        if not json_path:
            logger.error("indexer_handler_config_missing", extra={"handler": "seed_corpus", "field": "config.path"})
            return []

        path = Path(json_path)
        if not path.is_file():
            logger.error("indexer_seed_corpus_not_found", extra={"path": json_path})
            return []

        try:
            corpus = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError) as e:
            logger.error("Failed to read seed corpus %s: %s", json_path, e)
            return []

        sources = corpus.get("sources", [])
        if not sources:
            logger.warning("indexer_seed_corpus_empty", extra={"path": json_path})
            return []

        docs: list[RawDocument] = []
        for src in sources:
            doc = self._fetch_one(src, doc_id_prefix)
            if doc:
                docs.append(doc)

        logger.info(
            "indexer_seed_corpus_fetched",
            extra={"fetched": len(docs), "total": len(sources)},
        )
        return docs

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        if doc.metadata.get("_is_pdf"):
            return self._parse_pdf(doc)
        return self._parse_html(doc)

    # ------------------------------------------------------------------

    @staticmethod
    def _fetch_one(
        src: dict[str, Any],
        doc_id_prefix: str = "curated",
    ) -> RawDocument | None:
        url = src.get("url", "")
        title = src.get("title", url)
        if not url:
            return None

        try:
            resp = get_public_https(
                url,
                timeout=_FETCH_TIMEOUT,
                headers={"User-Agent": "synesis-indexer/1.0"},
            )
        except Exception as e:
            logger.warning("Failed to fetch %s (%s): %s", title, url, e)
            return None

        content_type = resp.headers.get("content-type", "")
        is_pdf = url.lower().endswith(".pdf") or "application/pdf" in content_type

        if is_pdf:
            content: str | bytes = resp.content
        else:
            from ..fetch import ensure_rendered

            content = ensure_rendered(resp.text, url)

        if not is_pdf:
            verdict = evaluate_page(url, resp.text, GatePolicy())
            if not verdict.should_index:
                logger.warning(
                    "Curated manifest source '%s' scored low (%.2f, type=%s): %s. "
                    "Indexing anyway, but review if content has changed.",
                    title,
                    verdict.quality_score,
                    verdict.doc_type,
                    verdict.rejection_reason,
                )
            else:
                logger.debug(
                    "Curated manifest source '%s' quality=%.2f type=%s",
                    title,
                    verdict.quality_score,
                    verdict.doc_type,
                )

        return RawDocument(
            doc_id=f"{doc_id_prefix}:{title}",
            name=title,
            content=content,
            source_url=url,
            metadata={
                "domain": src.get("domain", "generalist"),
                "tags": ",".join(src.get("tags", [])),
                "authority": "vetted",
                "_is_pdf": is_pdf,
            },
        )

    @staticmethod
    def _parse_html(doc: RawDocument) -> list[Chunk]:
        from ..extract import html_to_markdown

        html = doc.content if isinstance(doc.content, str) else doc.content.decode("utf-8", errors="replace")
        md = html_to_markdown(html)
        if not md:
            logger.warning("trafilatura returned empty for %s", doc.name)
            return []

        md = normalize_doc_markdown(md)
        text_chunks = heading_aware_split(md, document_name=doc.name)

        meta = {
            "domain": doc.metadata.get("domain", ""),
            "tags": doc.metadata.get("tags", ""),
            "authority": doc.metadata.get("authority", "vetted"),
            "source_url": doc.source_url,
        }
        return [
            Chunk(
                text=tc.text,
                section=tc.section,
                heading_path=tc.heading_path,
                chunk_index=tc.chunk_index,
                metadata=dict(meta),
            )
            for tc in text_chunks
        ]

    @staticmethod
    def _parse_pdf(doc: RawDocument) -> list[Chunk]:
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

        from .pdf_document import _page_text_with_tables

        full_text = ""
        for page in pdf_doc:
            full_text += _page_text_with_tables(page) + "\n"
        pdf_doc.close()

        if not full_text.strip():
            logger.warning("No text extracted from PDF: %s", doc.name)
            return []

        meta = {
            "domain": doc.metadata.get("domain", ""),
            "tags": doc.metadata.get("tags", ""),
            "authority": doc.metadata.get("authority", "vetted"),
            "source_url": doc.source_url,
        }

        text_chunks = chunk_text_simple(full_text, max_chars=4000)
        chunks: list[Chunk] = []
        for i, tc in enumerate(text_chunks):
            section_label = f"{doc.name} (part {i + 1})" if len(text_chunks) > 1 else doc.name
            chunks.append(
                Chunk(
                    text=tc,
                    section=section_label,
                    heading_path=doc.name,
                    chunk_index=i,
                    metadata=dict(meta),
                )
            )

        logger.info("Extracted %d chunks from PDF: %s", len(chunks), doc.name)
        return chunks
