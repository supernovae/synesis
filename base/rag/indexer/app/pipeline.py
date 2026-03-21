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

import hashlib
import time
from collections import defaultdict
from typing import Any

from synesis_telemetry import get_logger

from .content_gate import GatePolicy, score_chunk
from .embed_client import EmbedClient
from .enrichment import enrich_chunks_bulk
from .gatekeeper import entities_to_json, labels_for_document, section_outline_to_json
from .handlers import get_handler
from .handlers.base import Chunk, RawDocument
from .injection_scan import scan_chunk_text
from .milvus_writer import MilvusWriter, ProgressTracker, chunk_id_hash
from .preprocess_client import (
    clean_html_document,
    preprocess_base_url,
    preprocess_clean_html_enabled,
    simhash_batch,
)
from .schema import catalog_entity, ensure_synesis_catalog
from .spam_client import spam_base_url, spam_batch

logger = get_logger("synesis.indexer.pipeline")


def _indexer_stats_from_fetch(
    handler_type: str,
    source_config: dict[str, Any],
    documents: list[RawDocument],
) -> dict[str, Any]:
    """Telemetry sent to admin ingestion queue after a successful fetch."""
    meta: dict[str, Any] = {
        "handler": handler_type,
        "source_pages": len(documents),
    }
    if handler_type != "web_page":
        return meta
    cfg = source_config.get("config")
    if not isinstance(cfg, dict):
        cfg = {}
    meta["planned_max_pages"] = max(1, int(cfg.get("max_pages", 80)))
    meta["planned_max_depth"] = max(0, int(cfg.get("max_depth", 4)))
    meta["discovery"] = str(cfg.get("discovery") or "sitemap_first").lower()
    depths = [d.metadata["crawl_depth"] for d in documents if isinstance(d.metadata.get("crawl_depth"), int)]
    if depths:
        meta["max_depth_reached"] = max(depths)
    return meta


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


def index_parsed_chunk_pairs(
    source_config: dict[str, Any],
    parsed_pairs: list[tuple[RawDocument, Chunk]],
    fetch_meta: dict[str, Any],
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    existing_ids: set[str],
    *,
    enrich_full: bool = False,
    llm_url: str = "",
    dry_run: bool = False,
    gate_policy: GatePolicy | None = None,
) -> tuple[int, dict[str, Any]]:
    """Run dedup → gate → gatekeeper → enrich → embed → upsert for pre-parsed chunks."""
    name = source_config.get("name", "unknown")
    handler_type = source_config.get("handler", "")
    authority = source_config.get("authority", "community")
    origin_type = source_config.get("origin_type", "external")
    source_type_override = source_config.get("source_type", "")
    domain = source_config.get("domain", "generalist")
    tags_list = source_config.get("config", {}).get("tags", [])
    tags_str = ",".join(str(t) for t in tags_list)

    try:
        handler = get_handler(handler_type or "html_document")
    except ValueError:
        source_type = source_type_override or "docs"
    else:
        source_type = source_type_override or handler.source_type

    parsed_count = len(parsed_pairs)
    fetch_meta["semantic_contract"] = {
        "pass_a_version": "v9_gatekeeper",
        "pass_b_version": "pass_b_v1" if enrich_full else "deterministic_v1",
        "enrich_full": bool(enrich_full),
        "docs_total": 0,
        "docs_skipped": 0,
        "chunks_total": parsed_count,
        "chunks_enriched": 0,
    }

    # 3. Deduplicate
    new_chunks: list[tuple[RawDocument, Chunk, str]] = []
    seen_cids: set[str] = set()
    for doc, chunk in parsed_pairs:
        cid = chunk_id_hash(chunk.text, f"{doc.doc_id}:{chunk.section}")
        if cid not in existing_ids and cid not in seen_cids:
            new_chunks.append((doc, chunk, cid))
            seen_cids.add(cid)

    if not new_chunks:
        logger.info(
            "indexer_all_chunks_skipped",
            extra={"skipped": parsed_count, "source": name},
        )
        progress.log_source(name, 0)
        return 0, fetch_meta

    # 3.5. Chunk quality gate
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
        return 0, fetch_meta

    # 3.7. Gatekeeper
    by_doc: dict[str, list[tuple[RawDocument, Chunk, str]]] = defaultdict(list)
    for doc, chunk, cid in new_chunks:
        by_doc[doc.doc_id].append((doc, chunk, cid))

    doc_labels: dict[str, Any] = {}
    filtered: list[tuple[RawDocument, Chunk, str]] = []
    skipped_docs = 0
    for doc_id, group in by_doc.items():
        doc0 = group[0][0]
        texts = [c.text for _, c, _ in group]
        gk = labels_for_document(
            document_name=doc0.name,
            authority=authority,
            domain=domain,
            chunk_texts=texts,
        )
        doc_labels[doc_id] = gk
        if gk.index_decision == "skip":
            skipped_docs += 1
            logger.info(
                "indexer_gatekeeper_skip_doc",
                extra={"source": name, "doc": doc0.name[:80], "doc_id": doc_id[:32]},
            )
            continue
        filtered.extend(group)

    new_chunks = filtered
    fetch_meta["semantic_contract"]["docs_total"] = len(by_doc)
    fetch_meta["semantic_contract"]["docs_skipped"] = skipped_docs
    if skipped_docs:
        logger.info(
            "indexer_gatekeeper_docs_skipped",
            extra={"source": name, "skipped_docs": skipped_docs},
        )

    if not new_chunks:
        logger.info("indexer_all_skipped_by_gatekeeper", extra={"source": name})
        progress.log_source(name, 0)
        return 0, fetch_meta

    chunk_texts_for_signals = [c.text for _, c, _ in new_chunks]
    simhash_list = (
        simhash_batch(chunk_texts_for_signals) if preprocess_base_url() else [""] * len(new_chunks)
    )
    spam_list = spam_batch(chunk_texts_for_signals) if spam_base_url() else [-1.0] * len(new_chunks)

    logger.info(
        "indexer_processing_chunks",
        extra={
            "new": len(new_chunks),
            "skipped": parsed_count - len(new_chunks),
            "source": name,
        },
    )

    if dry_run:
        logger.info(
            "indexer_dry_run",
            extra={"chunks": len(new_chunks), "source": name},
        )
        progress.log_source(name, len(new_chunks))
        return len(new_chunks), fetch_meta

    enrich_items = [(chunk.text, doc.name, chunk.heading_path, chunk.section) for doc, chunk, _cid in new_chunks]
    enrichments = enrich_chunks_bulk(enrich_items, enrich_full=enrich_full, llm_url=llm_url)
    if enrich_full:
        fetch_meta["semantic_contract"]["chunks_enriched"] = sum(
            1 for e in enrichments if (e.semantic_profile or e.chunk_summary)
        )

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

    entities = []
    for (doc, chunk, cid), enrichment, emb, chunk_scan, simh, spam_s in zip(
        new_chunks, enrichments, embeddings, scan_statuses, simhash_list, spam_list
    ):
        chunk_tags = chunk.metadata.get("tags") or doc.metadata.get("tags") or tags_str
        chunk_source_url = chunk.metadata.get("source_url") or doc.source_url
        chunk_domain = chunk.metadata.get("domain") or doc.metadata.get("domain") or domain
        chunk_authority = chunk.metadata.get("authority") or doc.metadata.get("authority") or authority
        gk = doc_labels.get(doc.doc_id)
        gk_kw = list(gk.doc_keywords) if gk else []
        base_kw = enrichment.keywords or ""
        merged_kw = base_kw
        if gk_kw:
            existing = {x.strip().lower() for x in base_kw.split(",") if x.strip()}
            extra = [k for k in gk_kw if k.lower() not in existing]
            if extra:
                merged_kw = (base_kw + "," + ",".join(extra)) if base_kw else ",".join(extra)
                merged_kw = merged_kw[:512]

        chunk_keywords = merged_kw
        content_format = chunk.metadata.get("content_format", "")
        symbol_type = chunk.metadata.get("symbol_type", "")

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

        chunk_summary_out = enrichment.chunk_summary or (gk.doc_summary if gk else "")
        crawl_ts = 0
        if isinstance(doc.metadata.get("crawled_at"), (int, float)):
            crawl_ts = int(doc.metadata["crawled_at"])
        elif isinstance(doc.metadata.get("fetched_at"), (int, float)):
            crawl_ts = int(doc.metadata["fetched_at"])
        else:
            crawl_ts = int(time.time() * 1000)
        clean_h = hashlib.sha256(chunk.text.encode("utf-8", errors="ignore")).hexdigest()[:64]
        raw_h = hashlib.sha256(f"{doc.doc_id}:{chunk.chunk_index}".encode()).hexdigest()[:64]

        v9_content_type = (gk.content_type if gk else "")[:64]
        v9_q = gk.quality_score if gk else -1.0
        v9_td = gk.technical_depth if gk else -1.0
        v9_dr = gk.domain_relevance if gk else -1.0
        v9_idx = (gk.index_decision if gk else "index")[:16]
        if approval == "pending":
            v9_idx = "review"
        ent_json = entities_to_json(gk.entities) if gk else ""
        sec_json = section_outline_to_json(gk.section_outline) if gk else ""
        enrich_prof = gk.enrichment_profile if gk else "v9_default"

        entities.append(
            catalog_entity(
                chunk_id=cid,
                text=chunk.text,
                embedding=emb,
                doc_id=doc.doc_id,
                chunk_index=chunk.chunk_index,
                context_prefix=enrichment.context_prefix,
                chunk_summary=chunk_summary_out,
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
                content_type=v9_content_type,
                quality_score=v9_q,
                technical_depth=v9_td,
                domain_relevance=v9_dr,
                index_decision=v9_idx,
                spam_score=float(spam_s),
                simhash64=simh or "",
                crawl_timestamp=crawl_ts,
                entities_json=ent_json,
                section_boundaries_json=sec_json,
                raw_content_hash=raw_h,
                clean_content_hash=clean_h,
                enrichment_profile=enrich_prof,
            )
        )

    count = writer.upsert_batch(entities)
    for _, _, cid in new_chunks:
        existing_ids.add(cid)

    progress.log_source(name, count)
    return count, fetch_meta


def index_normalized_markdown_doc(
    source_config: dict[str, Any],
    raw_doc: RawDocument,
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    existing_ids: set[str],
    *,
    enrich_full: bool = False,
    llm_url: str = "",
    dry_run: bool = False,
    gate_policy: GatePolicy | None = None,
) -> tuple[int, dict[str, Any]]:
    """Staged path: chunk normalized markdown and index (Milvus + embed)."""
    from .chunking import heading_aware_split

    md = raw_doc.content if isinstance(raw_doc.content, str) else raw_doc.content.decode("utf-8", errors="replace")
    doc_label = raw_doc.name or raw_doc.doc_id
    text_chunks = heading_aware_split(md, doc_label)
    parsed: list[tuple[RawDocument, Chunk]] = []
    for tc in text_chunks:
        parsed.append(
            (
                raw_doc,
                Chunk(
                    text=tc.text,
                    section=tc.section,
                    heading_path=tc.heading_path,
                    chunk_index=tc.chunk_index,
                    metadata=dict(raw_doc.metadata),
                ),
            )
        )
    fetch_meta = {"staged_normalized": True, "handler": source_config.get("handler", "")}
    if not parsed:
        progress.log_source(source_config.get("name", "unknown"), 0)
        return 0, fetch_meta
    return index_parsed_chunk_pairs(
        source_config,
        parsed,
        fetch_meta,
        writer,
        embedder,
        progress,
        existing_ids,
        enrich_full=enrich_full,
        llm_url=llm_url,
        dry_run=dry_run,
        gate_policy=gate_policy,
    )


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
) -> tuple[int, dict[str, Any]]:
    """Index a single source from the unified sources.yaml.

    Returns (chunks upserted, fetch telemetry dict). The second value is empty
    when fetch failed or produced no documents; otherwise it reflects the fetch
    even if later stages produced zero chunks.
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
        return 0, {}

    try:
        handler = get_handler(handler_type)
    except ValueError as e:
        logger.error("indexer_handler_lookup_failed", extra={"source": name, "error": str(e)})
        progress.log_error(name, str(e))
        return 0, {}

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
        return 0, {}

    if not documents:
        logger.info("indexer_fetch_empty", extra={"source": name})
        progress.log_source(name, 0)
        return 0, {}

    logger.info("indexer_fetched_documents", extra={"count": len(documents), "source": name})
    fetch_meta = _indexer_stats_from_fetch(handler_type, source_config, documents)

    # Optional: jusText main-text extraction for HTML before chunking (html_document only)
    if (
        handler_type == "html_document"
        and preprocess_clean_html_enabled()
        and preprocess_base_url()
    ):
        for doc in documents:
            raw = doc.content if isinstance(doc.content, str) else doc.content.decode("utf-8", errors="replace")
            if "<" not in raw[:1200]:
                continue
            cleaned = clean_html_document(raw)
            if cleaned:
                doc.content = cleaned
                doc.metadata["preprocess_clean"] = "justext"

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
        return 0, fetch_meta

    return index_parsed_chunk_pairs(
        source_config,
        all_chunks,
        fetch_meta,
        writer,
        embedder,
        progress,
        existing_ids,
        enrich_full=enrich_full,
        llm_url=llm_url,
        dry_run=dry_run,
        gate_policy=gate_policy,
    )


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
            _chunks, _stats = index_source(
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
