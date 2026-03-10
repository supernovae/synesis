"""Handler: arxiv research papers.

Fetches academic papers from arxiv.org. Tries the HTML version first for
structured content with headings, falls back to PDF extraction via PyMuPDF.

Metadata (title, authors, abstract, categories) is fetched via the arxiv
Atom API in batches. Each paper becomes a separate RawDocument with
doc_id=arxiv:{paper_id}.

Rate-limiting: 3-second delay between fetches (configurable) per arxiv policy.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

import defusedxml.ElementTree as ET
import httpx

from ..chunking import chunk_text_simple, heading_aware_split
from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.arxiv_paper")

_ARXIV_API = "https://export.arxiv.org/api/query"
_ARXIV_HTML_URL = "https://arxiv.org/html/{arxiv_id}"
_ARXIV_PDF_URL = "https://arxiv.org/pdf/{arxiv_id}"
_ARXIV_ABS_URL = "https://arxiv.org/abs/{arxiv_id}"

_DEFAULT_FETCH_DELAY = 3
_API_BATCH_SIZE = 20

_ARXIV_ID_RE = re.compile(r"(\d{4}\.\d{4,5})")
_ATOM_NS = "http://www.w3.org/2005/Atom"

_PAPER_SECTION_RE = re.compile(
    r"^(?:"
    r"\d+\.?\s+[A-Z][A-Za-z\s:,\-]{3,80}$"
    r"|(?:Abstract|Introduction|Related Work|Background|Methodology|Method|Methods"
    r"|Approach|Experiments?|Results?|Discussion|Conclusion|Conclusions"
    r"|Acknowledgements?|References|Appendix)\s*$"
    r")",
    re.MULTILINE,
)


@register
class ArxivPaperHandler:
    handler_type = "arxiv_paper"
    source_type = "paper"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        papers = config.get("papers", [])
        fetch_delay = config.get("fetch_delay_seconds", _DEFAULT_FETCH_DELAY)

        if not papers:
            logger.error("arxiv_paper handler requires config.papers list")
            return []

        paper_specs = []
        for p in papers:
            raw = p.get("id", "") or p.get("url", "")
            arxiv_id = _extract_arxiv_id(raw)
            if not arxiv_id:
                logger.warning("Skipping entry with no valid arxiv ID: %s", raw)
                continue
            paper_specs.append(
                {
                    "arxiv_id": arxiv_id,
                    "title": p.get("title", ""),
                    "category": p.get("category", ""),
                }
            )

        if not paper_specs:
            return []

        metadata = _fetch_metadata_batch(
            [s["arxiv_id"] for s in paper_specs],
        )

        docs: list[RawDocument] = []
        with httpx.Client(timeout=90, follow_redirects=True) as client:
            for i, spec in enumerate(paper_specs):
                arxiv_id = spec["arxiv_id"]
                meta = metadata.get(arxiv_id, {})
                title = meta.get("title") or spec["title"] or arxiv_id
                authors = meta.get("authors", "")
                abstract = meta.get("abstract", "")
                categories = meta.get("categories") or spec.get("category", "")

                content, content_type = _fetch_html_content(client, arxiv_id)
                if not content:
                    content, content_type = _fetch_pdf_content(client, arxiv_id)

                if not content:
                    logger.warning("Could not fetch content for arxiv:%s — skipping", arxiv_id)
                    continue

                docs.append(
                    RawDocument(
                        doc_id=f"arxiv:{arxiv_id}",
                        name=title,
                        content=content,
                        source_url=f"https://arxiv.org/abs/{arxiv_id}",
                        metadata={
                            "content_type": content_type,
                            "authors": authors,
                            "abstract": abstract,
                            "categories": categories,
                            "arxiv_id": arxiv_id,
                        },
                    )
                )
                logger.info(
                    "Fetched [%d/%d] arxiv:%s via %s",
                    i + 1,
                    len(paper_specs),
                    arxiv_id,
                    content_type,
                )

                if i < len(paper_specs) - 1:
                    time.sleep(fetch_delay)

        logger.info("Fetched %d/%d arxiv papers", len(docs), len(paper_specs))
        return docs

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        content_type = doc.metadata.get("content_type", "pdf")
        authors = doc.metadata.get("authors", "")
        abstract = doc.metadata.get("abstract", "")

        chunks: list[Chunk] = []
        idx = 0

        if abstract:
            author_line = f"\n\nAuthors: {authors}" if authors else ""
            abstract_text = f"# {doc.name}{author_line}\n\n## Abstract\n\n{abstract}"
            chunks.append(
                Chunk(
                    text=abstract_text,
                    section="Abstract",
                    heading_path=f"{doc.name} > Abstract",
                    chunk_index=idx,
                )
            )
            idx += 1

        if content_type == "html":
            body_chunks = _parse_html_body(doc)
        else:
            body_chunks = _parse_pdf_body(doc)

        for c in body_chunks:
            c.chunk_index = idx
            idx += 1
            chunks.append(c)

        logger.info(
            "Parsed %d chunks from arxiv:%s (%s)",
            len(chunks),
            doc.metadata.get("arxiv_id", "?"),
            content_type,
        )
        return chunks


# ---------------------------------------------------------------------------
# Arxiv ID extraction
# ---------------------------------------------------------------------------


def _extract_arxiv_id(raw: str) -> str:
    """Extract an arxiv ID like '2005.11401' from a URL or bare string."""
    m = _ARXIV_ID_RE.search(raw)
    return m.group(1) if m else ""


# ---------------------------------------------------------------------------
# Metadata via arxiv Atom API (batched)
# ---------------------------------------------------------------------------


def _fetch_metadata_batch(
    arxiv_ids: list[str],
) -> dict[str, dict[str, str]]:
    """Fetch title/authors/abstract/categories for a batch of papers."""
    results: dict[str, dict[str, str]] = {}

    for start in range(0, len(arxiv_ids), _API_BATCH_SIZE):
        batch = arxiv_ids[start : start + _API_BATCH_SIZE]
        id_list = ",".join(batch)
        try:
            resp = httpx.get(
                _ARXIV_API,
                params={
                    "id_list": id_list,
                    "max_results": str(len(batch)),
                },
                timeout=30,
            )
            resp.raise_for_status()
            results.update(_parse_atom_feed(resp.text))
        except Exception as e:
            logger.warning("Arxiv API batch failed (ids %s…): %s", batch[0], e)

        if start + _API_BATCH_SIZE < len(arxiv_ids):
            time.sleep(_DEFAULT_FETCH_DELAY)

    return results


def _parse_atom_feed(xml_text: str) -> dict[str, dict[str, str]]:
    """Parse arxiv Atom XML feed into a dict keyed by arxiv ID."""
    results: dict[str, dict[str, str]] = {}
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        logger.warning("Failed to parse arxiv API XML: %s", e)
        return results

    for entry in root.findall(f"{{{_ATOM_NS}}}entry"):
        entry_id_el = entry.find(f"{{{_ATOM_NS}}}id")
        if entry_id_el is None or entry_id_el.text is None:
            continue

        arxiv_id = _extract_arxiv_id(entry_id_el.text)
        if not arxiv_id:
            continue

        title_el = entry.find(f"{{{_ATOM_NS}}}title")
        summary_el = entry.find(f"{{{_ATOM_NS}}}summary")
        title = (title_el.text or "").strip() if title_el is not None else ""
        abstract = (summary_el.text or "").strip() if summary_el is not None else ""
        title = re.sub(r"\s+", " ", title)
        abstract = re.sub(r"\s+", " ", abstract)

        authors = []
        for author_el in entry.findall(f"{{{_ATOM_NS}}}author"):
            name_el = author_el.find(f"{{{_ATOM_NS}}}name")
            if name_el is not None and name_el.text:
                authors.append(name_el.text.strip())

        categories = []
        for cat_el in entry.findall(f"{{{_ATOM_NS}}}category"):
            term = cat_el.get("term", "")
            if term:
                categories.append(term)

        results[arxiv_id] = {
            "title": title,
            "authors": ", ".join(authors),
            "abstract": abstract,
            "categories": ", ".join(categories),
        }

    return results


# ---------------------------------------------------------------------------
# Content fetching (HTML preferred, PDF fallback)
# ---------------------------------------------------------------------------


def _fetch_html_content(
    client: httpx.Client,
    arxiv_id: str,
) -> tuple[str, str]:
    """Try the arxiv HTML rendering. Returns (content, 'html') or ('', '')."""
    url = _ARXIV_HTML_URL.format(arxiv_id=arxiv_id)
    try:
        resp = client.get(url)
        if resp.status_code == 200 and len(resp.text) > 2000:
            return resp.text, "html"
    except Exception as e:
        logger.debug("HTML fetch failed for %s: %s", arxiv_id, e)
    return "", ""


def _fetch_pdf_content(
    client: httpx.Client,
    arxiv_id: str,
) -> tuple[bytes, str] | tuple[str, str]:
    """Fetch PDF bytes. Returns (content_bytes, 'pdf') or ('', '')."""
    url = _ARXIV_PDF_URL.format(arxiv_id=arxiv_id)
    try:
        resp = client.get(url)
        resp.raise_for_status()
        if resp.headers.get("content-type", "").startswith("application/pdf"):
            return resp.content, "pdf"
        if len(resp.content) > 5000:
            return resp.content, "pdf"
    except Exception as e:
        logger.debug("PDF fetch failed for %s: %s", arxiv_id, e)
    return "", ""


# ---------------------------------------------------------------------------
# Content parsing
# ---------------------------------------------------------------------------


def _parse_html_body(doc: RawDocument) -> list[Chunk]:
    """Parse arxiv HTML into heading-aware chunks.

    Uses BeautifulSoup only for arxiv-specific DOM surgery (removing LaTeX
    headers, bibliography, appendix, etc.) before passing the cleaned HTML
    through trafilatura for Markdown conversion.
    """
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        logger.error("beautifulsoup4 not installed")
        return []

    from ..extract import html_to_markdown

    html = doc.content if isinstance(doc.content, str) else doc.content.decode("utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")

    for sel in soup.select(
        ".ltx_page_header, .ltx_page_footer, .ltx_dates, "
        ".ltx_role_affiliationtext, #header, .arxiv-header, "
        ".ltx_bibliography, .ltx_appendix"
    ):
        sel.decompose()

    article = soup.select_one("article, .ltx_document, .ltx_page_main")
    target_html = str(article) if article else str(soup)

    md = html_to_markdown(target_html)
    if not md:
        logger.warning("trafilatura returned empty for arxiv:%s", doc.metadata.get("arxiv_id", "?"))
        return []

    text_chunks = heading_aware_split(md, document_name=doc.name)

    return [
        Chunk(
            text=tc.text,
            section=tc.section,
            heading_path=tc.heading_path,
            chunk_index=tc.chunk_index,
        )
        for tc in text_chunks
    ]


def _parse_pdf_body(doc: RawDocument) -> list[Chunk]:
    """Parse arxiv PDF into section-aware chunks."""
    try:
        import fitz
    except ImportError:
        logger.error("PyMuPDF (fitz) not installed — cannot parse PDFs")
        return []

    pdf_bytes = doc.content if isinstance(doc.content, bytes) else doc.content.encode("utf-8")

    try:
        pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        logger.warning("Failed to open PDF for %s: %s", doc.name, e)
        return []

    full_text = ""
    for page in pdf_doc:
        full_text += page.get_text() + "\n"
    pdf_doc.close()

    if not full_text.strip():
        return []

    sections = _split_paper_sections(full_text)
    chunks: list[Chunk] = []

    for title, body in sections:
        if len(body.strip()) < 50:
            continue
        text_chunks = chunk_text_simple(body, max_chars=4000)
        for i, tc in enumerate(text_chunks):
            section_label = title if len(text_chunks) == 1 else f"{title} (part {i + 1})"
            chunks.append(
                Chunk(
                    text=tc,
                    section=section_label,
                    heading_path=f"{doc.name} > {title}",
                    chunk_index=0,
                )
            )

    return chunks


def _split_paper_sections(text: str) -> list[tuple[str, str]]:
    """Split extracted PDF text into sections using academic heading patterns."""
    matches = list(_PAPER_SECTION_RE.finditer(text))
    if not matches:
        return [("Full Text", text)]

    sections: list[tuple[str, str]] = []

    if matches[0].start() > 100:
        sections.append(("Preamble", text[: matches[0].start()].strip()))

    for i, match in enumerate(matches):
        title = match.group().strip()[:200]
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        if body:
            sections.append((title, body))

    return sections
