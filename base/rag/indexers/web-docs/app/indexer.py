"""Web-Docs Crawler Indexer — Crawl4AI-based batch indexer for trusted URLs.

Reads a sources.yaml allowlist of trusted URLs, crawls them using Crawl4AI
(Apache-2.0), converts to Markdown, chunks by section, embeds, and upserts
into synesis_catalog with per-source authority and origin_type.

Crawl4AI provides: HTML-to-Markdown, proxy/auth/cache, robots.txt compliance,
async crawling. Research: information foraging (arxiv 2505.09316).

Usage:
    python -m app.indexer --sources /data/sources.yaml
"""

from __future__ import annotations

import asyncio
import logging
import re
import sys
from pathlib import Path

import yaml

from .catalog_schema import SYNESIS_CATALOG, catalog_entity, ensure_synesis_catalog
from .indexer_base import (
    EmbedClient,
    MilvusWriter,
    ProgressTracker,
    chunk_id_hash,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.indexer.web_docs")

_HEADING_RE = re.compile(r"^(#{1,3})\s+(.+)$", re.MULTILINE)


def _split_markdown_sections(content: str) -> list[dict[str, str]]:
    """Split markdown by headings (H1-H3), keeping each section as a chunk."""
    sections: list[dict[str, str]] = []
    parts = re.split(r"^(#{1,3}\s+.+)$", content, flags=re.MULTILINE)

    current_heading = ""
    for part in parts:
        stripped = part.strip()
        if not stripped:
            continue
        if re.match(r"^#{1,3}\s+", stripped):
            current_heading = re.sub(r"^#+\s*", "", stripped).strip()
        elif stripped:
            sections.append({"section": current_heading, "text": stripped})

    if not sections and content.strip():
        sections.append({"section": "", "text": content.strip()})
    return sections


def _chunk_section(text: str, max_words: int = 600, overlap_words: int = 80) -> list[str]:
    """Split a section into overlapping word-based chunks if it exceeds max_words."""
    words = text.split()
    if len(words) <= max_words:
        return [text]
    chunks = []
    start = 0
    while start < len(words):
        end_pos = min(start + max_words, len(words))
        chunks.append(" ".join(words[start:end_pos]))
        if end_pos >= len(words):
            break
        start = end_pos - overlap_words
    return chunks


async def _crawl_url(url: str, follow_links: bool = False) -> list[dict[str, str]]:
    """Crawl a URL using Crawl4AI. Returns list of {url, markdown} dicts."""
    try:
        from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
    except ImportError:
        logger.error("crawl4ai not installed. Run: pip install crawl4ai")
        return []

    pages: list[dict[str, str]] = []
    config = CrawlerRunConfig()

    async with AsyncWebCrawler() as crawler:
        result = await crawler.arun(url=url, config=config)
        if result and result.markdown:
            pages.append({"url": url, "markdown": result.markdown})

        if follow_links and result and result.links:
            from urllib.parse import urlparse
            seed_host = urlparse(url).hostname or ""
            child_urls = []
            internal_links = getattr(result.links, "internal", []) or []
            for link in internal_links[:20]:
                href = link if isinstance(link, str) else getattr(link, "href", "")
                if not href:
                    continue
                link_host = urlparse(href).hostname or ""
                if link_host == seed_host and href != url:
                    child_urls.append(href)

            for child_url in child_urls[:10]:
                try:
                    child_result = await crawler.arun(url=child_url, config=config)
                    if child_result and child_result.markdown:
                        pages.append({"url": child_url, "markdown": child_result.markdown})
                except Exception as e:
                    logger.warning(f"Failed to crawl child {child_url}: {e}")

    return pages


def index_site(
    site_cfg: dict,
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    existing_ids: set[str],
) -> int:
    """Crawl and index a single site from the sources config."""
    name = site_cfg["name"]
    url = site_cfg["url"]
    authority = site_cfg.get("authority", "community")
    origin_type = site_cfg.get("origin_type", "external")
    follow_links = site_cfg.get("follow_links", False)
    tags = site_cfg.get("tags", [])
    tags_str = ",".join(str(t) for t in tags)

    logger.info(f"Crawling: {name} ({url}) authority={authority} follow_links={follow_links}")

    pages = asyncio.get_event_loop().run_until_complete(_crawl_url(url, follow_links))
    if not pages:
        logger.warning(f"No content retrieved from {url}")
        progress.log_source(name, 0)
        return 0

    chunks_to_embed: list[tuple[str, str, str, str, str]] = []
    for page in pages:
        page_url = page["url"]
        sections = _split_markdown_sections(page["markdown"])
        for section in sections:
            for chunk_text in _chunk_section(section["text"]):
                cid = chunk_id_hash(chunk_text, f"web:{name}:{section['section']}")
                if cid in existing_ids:
                    continue
                chunks_to_embed.append((cid, chunk_text, section["section"], page_url, tags_str))

    if not chunks_to_embed:
        logger.info(f"All chunks already indexed for {name}")
        progress.log_source(name, 0)
        return 0

    logger.info(f"Embedding {len(chunks_to_embed)} chunks from {name} ({len(pages)} pages)")
    texts = [c[1] for c in chunks_to_embed]
    embeddings = embedder.embed_texts(texts)

    entities = []
    for (cid, text, section, page_url, t_str), emb in zip(chunks_to_embed, embeddings):
        entities.append(
            catalog_entity(
                chunk_id=cid,
                text=text[:8192],
                source=f"web:{name} section:{section}"[:512],
                language="web",
                embedding=emb,
                domain="web",
                indexer_source="web_docs",
                section=section[:256],
                document_name=name[:256],
                tags=t_str[:512],
                origin_type=origin_type,
                authority=authority,
                source_url=page_url,
            )
        )

    count = writer.upsert_batch(SYNESIS_CATALOG, entities)
    for cid, *_ in chunks_to_embed:
        existing_ids.add(cid)
    progress.log_source(name, count)
    return count


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Synesis Web-Docs Crawler Indexer (Crawl4AI)")
    parser.add_argument("--sources", required=True, help="Path to sources.yaml")
    parser.add_argument("--site", default=None, help="Index only this site by name")
    parser.add_argument("--force", action="store_true", help="Re-embed all chunks")
    parser.add_argument("--dry-run", action="store_true", help="Validate config only")
    args = parser.parse_args()

    sources_path = Path(args.sources)
    if not sources_path.exists():
        logger.error(f"Sources file not found: {sources_path}")
        sys.exit(1)

    with open(sources_path) as f:
        sources = yaml.safe_load(f)

    sites = sources.get("sites", [])
    if not sites:
        logger.info("No sites configured in sources.yaml")
        return

    if args.site:
        sites = [s for s in sites if s["name"].lower() == args.site.lower()]
        if not sites:
            logger.error(f"Site '{args.site}' not found in sources")
            sys.exit(1)

    logger.info(f"Loaded {len(sites)} sites from {sources_path}")
    for s in sites:
        logger.info(f"  - {s['name']} ({s['url']}) authority={s.get('authority', 'community')}")

    if args.dry_run:
        logger.info("Dry run complete -- config is valid")
        return

    try:
        writer = MilvusWriter()
    except Exception as e:
        logger.error(f"Failed to connect to Milvus: {e}")
        sys.exit(1)

    embedder = EmbedClient()
    progress = ProgressTracker(name="Web-Docs Crawler Indexer")

    ensure_synesis_catalog()
    existing_ids = writer.existing_chunk_ids(SYNESIS_CATALOG) if not args.force else set()

    for site_cfg in sites:
        try:
            index_site(site_cfg, writer, embedder, progress, existing_ids)
        except Exception as e:
            logger.error(f"Failed to index {site_cfg.get('name', '?')}: {e}")
            progress.log_error(site_cfg.get("name", "unknown"), str(e))

    progress.log_complete()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("Web-Docs Crawler Indexer crashed")
        sys.exit(1)
