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

from typing import Any

from synesis_telemetry import get_logger

from .content_gate import GatePolicy, score_chunk
from .embed_client import EmbedClient
from .enrichment import enrich_chunks_bulk
from .handlers import get_handler
from .handlers.base import Chunk, RawDocument
from .injection_scan import scan_chunk_text
from .milvus_writer import MilvusWriter, ProgressTracker, chunk_id_hash
from .schema import catalog_entity, ensure_synesis_catalog

logger = get_logger("synesis.indexer.pipeline")

_CODE_FORMATS = frozenset(
    {
        "python",
        "go",
        "rust",
        "javascript",
        "typescript",
        "java",
        "c",
        "cpp",
        "c_sharp",
        "ruby",
        "php",
        "bash",
        "lua",
        "kotlin",
        "scala",
        "swift",
        "sql",
        "r",
        "elixir",
        "haskell",
        "perl",
    }
)

_CONFIG_FORMATS = frozenset({"yaml", "json", "toml", "xml", "hcl", "dockerfile", "make", "protobuf"})


def _infer_artifact_kind(handler: str, content_format: str, language: str) -> str:
    """Infer high-level artifact kind from handler, format, and language."""
    fmt = (content_format or "").lower()
    h = (handler or "").lower()

    if h == "openapi_spec":
        return "api_spec"
    if h in ("arxiv_paper", "pdf_document"):
        return "docs"
    if h in ("html_document", "web_page", "markdown_file", "github_markdown"):
        return "docs"
    if h == "license_spdx":
        return "docs"
    if h == "structured_data":
        return "config"
    if h == "github_code":
        if fmt in _CODE_FORMATS or language in _CODE_FORMATS:
            return "code"
        if fmt in _CONFIG_FORMATS:
            return "config"
        return "code"
    if fmt in _CODE_FORMATS or language in _CODE_FORMATS:
        return "code"
    if fmt in _CONFIG_FORMATS:
        return "config"
    return "docs"


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
        logger.error("indexer_source_missing_handler", extra={"source": name})
        progress.log_error(name, "missing handler")
        return 0

    try:
        handler = get_handler(handler_type)
    except ValueError as e:
        logger.error("indexer_handler_lookup_failed", extra={"source": name, "error": str(e)})
        progress.log_error(name, str(e))
        return 0

    source_type = source_type_override or handler.source_type

    # 1. Fetch
    logger.info(
        "indexer_fetch_start",
        extra={"source": name, "handler": handler_type, "authority": authority},
    )
    try:
        documents = handler.fetch(source_config)
    except Exception as e:
        logger.error("indexer_fetch_failed", extra={"source": name, "error": str(e)})
        progress.log_error(name, f"fetch: {e}")
        return 0

    if not documents:
        logger.info("indexer_fetch_empty", extra={"source": name})
        progress.log_source(name, 0)
        return 0

    logger.info("indexer_fetched_documents", extra={"count": len(documents), "source": name})

    # 2. Parse + Chunk
    all_chunks: list[tuple[RawDocument, Chunk]] = []
    for doc in documents:
        try:
            chunks = handler.parse_and_chunk(doc)
            for chunk in chunks:
                all_chunks.append((doc, chunk))
        except Exception as e:
            logger.warning("indexer_parse_failed", extra={"doc": doc.name, "error": str(e)})

    if not all_chunks:
        logger.info("indexer_no_chunks", extra={"source": name})
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
        logger.info(
            "indexer_all_chunks_skipped",
            extra={"skipped": len(all_chunks), "source": name},
        )
        progress.log_source(name, 0)
        return 0

    # 3.5. Chunk quality gate (Layer 2 — universal)
    skip_gate = str(source_config.get("quality_gate", "")).lower() == "skip"
    if skip_gate:
        logger.warning(
            "indexer_quality_gate_skipped",
            extra={
                "source": name,
                "reason": "Chunk filtering disabled — risks diluting retrieval quality",
            },
        )

    if not skip_gate and gate_policy is not None:
        gated: list[tuple[RawDocument, Chunk, str]] = []
        reject_reasons: dict[str, int] = {}
        reject_samples: list[tuple[str, str]] = []
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
                if len(reject_samples) < 5:
                    reject_samples.append((chunk.text[:120].replace("\n", " "), verdict.rejection_reason))

        rejected = len(new_chunks) - len(gated)
        if rejected:
            reason_summary = ", ".join(f"{k}:{v}" for k, v in reject_reasons.items())
            logger.info(
                "indexer_quality_gate_applied",
                extra={
                    "accepted": len(gated),
                    "total": len(new_chunks),
                    "rejected": rejected,
                    "source": name,
                    "reject_reasons": reason_summary,
                },
            )
            for sample_text, sample_reason in reject_samples:
                logger.debug(
                    "indexer_rejected_chunk_sample",
                    extra={"source": name, "text_preview": sample_text, "reason": sample_reason},
                )
        new_chunks = gated

    if not new_chunks:
        logger.info("indexer_all_rejected_by_gate", extra={"source": name})
        progress.log_source(name, 0)
        return 0

    logger.info(
        "indexer_processing_chunks",
        extra={
            "new": len(new_chunks),
            "skipped": len(all_chunks) - len(new_chunks),
            "source": name,
        },
    )

    if dry_run:
        logger.info(
            "indexer_dry_run",
            extra={"chunks": len(new_chunks), "source": name},
        )
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

    logger.info(
        "indexer_embedding_chunks",
        extra={"count": len(embed_inputs), "source": name},
    )
    embeddings = embedder.embed_texts(embed_inputs)

    # 5.5. Injection scan (index-time; results stored for admin review queue)
    scan_statuses: list[str] = []
    flagged_count = 0
    for doc, chunk, cid in new_chunks:
        status = scan_chunk_text(chunk.text)
        scan_statuses.append(status)
        if status == "flagged":
            flagged_count += 1
    if flagged_count:
        logger.info(
            "indexer_injection_scan",
            extra={"flagged": flagged_count, "total": len(new_chunks), "source": name},
        )

    # 6. Build catalog entities (per-chunk metadata overrides source-level defaults)
    # approval_status: vetted/canonical sources are auto-approved; flagged chunks are pending
    entities = []
    for (doc, chunk, cid), enrichment, emb, chunk_scan in zip(new_chunks, enrichments, embeddings, scan_statuses):
        chunk_tags = chunk.metadata.get("tags") or doc.metadata.get("tags") or tags_str
        chunk_source_url = chunk.metadata.get("source_url") or doc.source_url
        chunk_domain = chunk.metadata.get("domain") or doc.metadata.get("domain") or domain
        chunk_authority = chunk.metadata.get("authority") or doc.metadata.get("authority") or authority
        chunk_keywords = enrichment.keywords
        content_format = chunk.metadata.get("content_format", "")
        symbol_type = chunk.metadata.get("symbol_type", "")

        # v8 metadata
        language = chunk.metadata.get("language", "") or doc.metadata.get("language", "")
        repo_path = doc.metadata.get("repo", "") or doc.metadata.get("repo_path", "")
        module_path = chunk.metadata.get("file_path", "") or doc.metadata.get("module_path", "")
        symbol_name = chunk.metadata.get("symbol_name", "")
        artifact_kind = _infer_artifact_kind(handler_type, content_format, language)

        if chunk_scan == "flagged":
            approval = "pending"
        elif chunk_authority in ("canonical", "vetted"):
            approval = "auto_approved"
        else:
            approval = "auto_approved"

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
                scan_status=chunk_scan,
                content_format=content_format,
                symbol_type=symbol_type,
                approval_status=approval,
                language=language,
                repo_path=repo_path,
                module_path=module_path,
                symbol_name=symbol_name,
                artifact_kind=artifact_kind,
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
            logger.error(
                "indexer_source_not_found",
                extra={"source_filter": source_filter},
            )
            return

    if handler_filter:
        sources = [s for s in sources if s.get("handler", "") == handler_filter]
        if not sources:
            logger.error(
                "indexer_handler_filter_empty",
                extra={"handler_filter": handler_filter},
            )
            return

    logger.info(
        "indexer_pipeline_start",
        extra={
            "source_count": len(sources),
            "sources": [
                {"name": s.get("name"), "handler": s.get("handler"), "authority": s.get("authority")} for s in sources
            ],
        },
    )

    if dry_run:
        logger.info("indexer_dry_run_validation", extra={"detail": "No Milvus/embedder connection"})

    writer_kwargs = {"uri": milvus_uri} if milvus_uri else {}
    embedder_kwargs = {"url": embedder_url} if embedder_url else {}

    if not dry_run:
        try:
            writer = MilvusWriter(**writer_kwargs)
        except Exception as e:
            logger.error("indexer_milvus_connect_failed", extra={"error": str(e)})
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
            logger.error(
                "indexer_source_failed",
                extra={"source": source_config.get("name", "?"), "error": str(e)},
            )
            progress.log_error(source_config.get("name", "unknown"), str(e))

    progress.log_complete()
