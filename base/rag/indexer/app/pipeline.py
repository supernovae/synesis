"""Unified indexing pipeline: fetch -> parse -> chunk -> gate -> enrich -> embed -> upsert.

Orchestrates the full indexing flow for any source configuration using
the handler registry. Each source entry in sources.yaml specifies a
handler type, authority, origin_type, and handler-specific config.

The chunk-level quality gate (Layer 2) runs for ALL handlers between
parse/chunk and enrich.  It catches marketing, thin, and boilerplate
content from any source type.  Sources can set ``quality_gate: skip``
to bypass, but a loud warning is logged.
"""

from __future__ import annotations

import logging
from typing import Any

from .content_gate import GatePolicy, score_chunk
from .embed_client import EmbedClient
from .enrichment import enrich_chunks_bulk
from .handlers import get_handler
from .handlers.base import Chunk, RawDocument
from .milvus_writer import MilvusWriter, ProgressTracker, chunk_id_hash
from .schema import catalog_entity, ensure_synesis_catalog

logger = logging.getLogger("synesis.indexer.pipeline")


def index_source(
    source_config: dict[str, Any],
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    existing_ids: set[str],
    *,
    enrich_full: bool = False,
    llm_url: str = "",
    dry_run: bool = False,
    gate_policy: GatePolicy | None = None,
) -> int:
    """Index a single source from the unified sources.yaml.

    Returns the number of chunks upserted.
    """
    name = source_config.get("name", "unknown")
    handler_type = source_config.get("handler", "")
    authority = source_config.get("authority", "community")
    origin_type = source_config.get("origin_type", "external")
    source_type_override = source_config.get("source_type", "")
    domain = source_config.get("domain", "generalist")
    tags_list = source_config.get("config", {}).get("tags", [])
    tags_str = ",".join(str(t) for t in tags_list)

    if not handler_type:
        logger.error("Source '%s' missing 'handler' field", name)
        progress.log_error(name, "missing handler")
        return 0

    try:
        handler = get_handler(handler_type)
    except ValueError as e:
        logger.error("Source '%s': %s", name, e)
        progress.log_error(name, str(e))
        return 0

    source_type = source_type_override or handler.source_type

    # 1. Fetch
    logger.info("Fetching: %s (handler=%s, authority=%s)", name, handler_type, authority)
    try:
        documents = handler.fetch(source_config)
    except Exception as e:
        logger.error("Fetch failed for '%s': %s", name, e)
        progress.log_error(name, f"fetch: {e}")
        return 0

    if not documents:
        logger.info("No documents fetched for '%s'", name)
        progress.log_source(name, 0)
        return 0

    logger.info("Fetched %d documents from '%s'", len(documents), name)

    # 2. Parse + Chunk
    all_chunks: list[tuple[RawDocument, Chunk]] = []
    for doc in documents:
        try:
            chunks = handler.parse_and_chunk(doc)
            for chunk in chunks:
                all_chunks.append((doc, chunk))
        except Exception as e:
            logger.warning("Parse failed for doc '%s': %s", doc.name, e)

    if not all_chunks:
        logger.info("No chunks produced for '%s'", name)
        progress.log_source(name, 0)
        return 0

    # 3. Deduplicate (check both cross-source existing_ids and within-source seen)
    new_chunks: list[tuple[RawDocument, Chunk, str]] = []
    seen_cids: set[str] = set()
    for doc, chunk in all_chunks:
        cid = chunk_id_hash(chunk.text, f"{doc.doc_id}:{chunk.section}")
        if cid not in existing_ids and cid not in seen_cids:
            new_chunks.append((doc, chunk, cid))
            seen_cids.add(cid)

    if not new_chunks:
        logger.info("All %d chunks already indexed for '%s'", len(all_chunks), name)
        progress.log_source(name, 0)
        return 0

    # 3.5. Chunk quality gate (Layer 2 — universal)
    skip_gate = str(source_config.get("quality_gate", "")).lower() == "skip"
    if skip_gate:
        logger.warning(
            "quality_gate=skip for source '%s'. Chunk filtering disabled. "
            "This risks diluting retrieval quality with marketing or boilerplate content.",
            name,
        )

    if not skip_gate and gate_policy is not None:
        gated: list[tuple[RawDocument, Chunk, str]] = []
        reject_reasons: dict[str, int] = {}
        for doc, chunk, cid in new_chunks:
            verdict = score_chunk(
                chunk.text,
                section=chunk.section,
                heading_path=chunk.heading_path,
                policy=gate_policy,
            )
            if verdict.should_index:
                gated.append((doc, chunk, cid))
            else:
                tag = verdict.rejection_reason.split("|")[0].strip()
                reject_reasons[tag] = reject_reasons.get(tag, 0) + 1

        rejected = len(new_chunks) - len(gated)
        if rejected:
            reason_summary = ", ".join(f"{k}:{v}" for k, v in reject_reasons.items())
            logger.info(
                "Quality gate: %d/%d chunks accepted for '%s' (%d rejected: %s)",
                len(gated),
                len(new_chunks),
                name,
                rejected,
                reason_summary,
            )
        new_chunks = gated

    if not new_chunks:
        logger.info("All chunks rejected by quality gate for '%s'", name)
        progress.log_source(name, 0)
        return 0

    logger.info(
        "Processing %d new chunks (%d skipped) for '%s'",
        len(new_chunks),
        len(all_chunks) - len(new_chunks),
        name,
    )

    if dry_run:
        logger.info("[DRY RUN] Would embed and upsert %d chunks for '%s'", len(new_chunks), name)
        progress.log_source(name, len(new_chunks))
        return len(new_chunks)

    # 4. Enrich (batched keyword extraction for ~5-10x speedup on CPU)
    enrich_items = [(chunk.text, doc.name, chunk.heading_path, chunk.section) for doc, chunk, _cid in new_chunks]
    enrichments = enrich_chunks_bulk(enrich_items, enrich_full=enrich_full, llm_url=llm_url)

    # 5. Embed (context_prefix + text for Contextual Retrieval)
    embed_inputs = []
    for (doc, chunk, cid), enrichment in zip(new_chunks, enrichments):
        prefix = enrichment.context_prefix
        if prefix:
            embed_inputs.append(f"{prefix} {chunk.text}")
        else:
            embed_inputs.append(chunk.text)

    logger.info("Embedding %d chunks for '%s'", len(embed_inputs), name)
    embeddings = embedder.embed_texts(embed_inputs)

    # 6. Build catalog entities (per-chunk metadata overrides source-level defaults)
    entities = []
    for (doc, chunk, cid), enrichment, emb in zip(new_chunks, enrichments, embeddings):
        chunk_tags = chunk.metadata.get("tags") or doc.metadata.get("tags") or tags_str
        chunk_source_url = chunk.metadata.get("source_url") or doc.source_url
        chunk_domain = chunk.metadata.get("domain") or doc.metadata.get("domain") or domain
        chunk_authority = chunk.metadata.get("authority") or doc.metadata.get("authority") or authority
        chunk_keywords = enrichment.keywords

        entities.append(
            catalog_entity(
                chunk_id=cid,
                text=chunk.text,
                embedding=emb,
                doc_id=doc.doc_id,
                chunk_index=chunk.chunk_index,
                context_prefix=enrichment.context_prefix,
                chunk_summary=enrichment.chunk_summary,
                heading_path=chunk.heading_path,
                section=chunk.section,
                document_name=doc.name,
                source_type=source_type,
                handler=handler_type,
                domain=chunk_domain,
                tags=chunk_tags if isinstance(chunk_tags, str) else ",".join(chunk_tags),
                keywords=chunk_keywords,
                origin_type=origin_type,
                authority=chunk_authority,
                source_url=chunk_source_url,
            )
        )

    # 7. Upsert
    count = writer.upsert_batch(entities)
    for _, _, cid in new_chunks:
        existing_ids.add(cid)

    progress.log_source(name, count)
    return count


def run_pipeline(
    sources: list[dict[str, Any]],
    *,
    force: bool = False,
    enrich_full: bool = False,
    llm_url: str = "",
    dry_run: bool = False,
    handler_filter: str | None = None,
    source_filter: str | None = None,
    milvus_uri: str = "",
    embedder_url: str = "",
) -> None:
    """Run the full indexing pipeline across all sources."""
    if source_filter:
        sources = [s for s in sources if s.get("name", "").lower() == source_filter.lower()]
        if not sources:
            logger.error("Source '%s' not found in config", source_filter)
            return

    if handler_filter:
        sources = [s for s in sources if s.get("handler", "") == handler_filter]
        if not sources:
            logger.error("No sources with handler '%s'", handler_filter)
            return

    logger.info("=== Synesis Unified Indexer: %d sources ===", len(sources))
    for s in sources:
        logger.info("  - %s (handler=%s, authority=%s)", s.get("name"), s.get("handler"), s.get("authority"))

    if dry_run:
        logger.info("[DRY RUN] Validating sources only, no Milvus/embedder connection")

    writer_kwargs = {"uri": milvus_uri} if milvus_uri else {}
    embedder_kwargs = {"url": embedder_url} if embedder_url else {}

    if not dry_run:
        try:
            writer = MilvusWriter(**writer_kwargs)
        except Exception as e:
            logger.error("Failed to connect to Milvus: %s", e)
            return

        embedder = EmbedClient(**embedder_kwargs)
        ensure_synesis_catalog(writer.client)
        existing_ids = writer.existing_chunk_ids() if not force else set()
    else:
        writer = None  # type: ignore[assignment]
        embedder = None  # type: ignore[assignment]
        existing_ids = set()

    progress = ProgressTracker(name="Unified Indexer")
    gate_policy = GatePolicy()

    for source_config in sources:
        try:
            index_source(
                source_config,
                writer,
                embedder,
                progress,
                existing_ids,
                enrich_full=enrich_full,
                llm_url=llm_url,
                dry_run=dry_run,
                gate_policy=gate_policy,
            )
        except Exception as e:
            logger.error("Failed to index '%s': %s", source_config.get("name", "?"), e)
            progress.log_error(source_config.get("name", "unknown"), str(e))

    progress.log_complete()
