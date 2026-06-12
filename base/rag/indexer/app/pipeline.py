"""Unified indexing pipeline: fetch -> parse -> chunk -> gate -> enrich -> embed -> upsert.

Orchestrates the full indexing flow for source configurations from Admin queue
items, explicit custom YAML files, or internal pack builders. Each source
configuration specifies a handler type, authority, origin_type, and
handler-specific config.

The chunk-level quality gate (Layer 2) runs for ALL handlers between
parse/chunk and enrich.  It catches marketing, thin, and boilerplate
content from any source type.  Sources can set ``quality_gate: skip``
to bypass, but a loud warning is logged.
"""

from __future__ import annotations

import hashlib
import re
import time
from collections import defaultdict
from typing import Any

from synesis_telemetry import get_logger

from .code_graph import derive_graph_edges
from .content_gate import GatePolicy, score_chunk
from .crawl_config import effective_crawl_config
from .embed_client import EmbedClient
from .enrichment import enrich_chunks_bulk
from .gatekeeper import entities_to_json, labels_for_document, section_outline_to_json
from .handlers import get_handler
from .handlers.base import Chunk, RawDocument
from .injection_scan import scan_chunk_text_detailed
from .nornic_writer import NornicGraphWriter, ProgressTracker, chunk_id_hash
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
    crawl_cfg = effective_crawl_config(cfg if isinstance(cfg, dict) else {})
    meta["planned_max_pages"] = int(crawl_cfg["max_pages"])
    meta["planned_max_depth"] = int(crawl_cfg["max_depth"])
    meta["discovery"] = str(crawl_cfg["discovery"])
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
_CODE_FENCE_RE = re.compile(r"```[\s\S]*?```|~~~[\s\S]*?~~~", re.MULTILINE)
_INLINE_CODE_RE = re.compile(r"`[^`]+`")
_CLI_FLAG_RE = re.compile(r"(?:^|\s)--?\w[\w-]*(?:=\S+)?")
_CODE_TOKEN_RE = re.compile(r"[{}();]|::|->|=>|\bfunc\b|\bclass\b|\binterface\b|\breturn\b|\bimport\b", re.IGNORECASE)


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


def _code_chunk_metrics(text: str) -> tuple[bool, int, float]:
    """Return (has_code, signal_count, density) for a chunk."""
    if not text:
        return False, 0, 0.0
    signals = 0
    if _CODE_FENCE_RE.search(text):
        signals += 2
    inline_count = len(_INLINE_CODE_RE.findall(text))
    if inline_count:
        signals += min(4, inline_count)
    if _CLI_FLAG_RE.search(text):
        signals += 1
    token_hits = len(_CODE_TOKEN_RE.findall(text))
    if token_hits:
        signals += 1
    word_count = max(1, len(text.split()))
    density = min(1.0, (token_hits + inline_count) / word_count)
    return signals > 0, signals, float(density)


def index_parsed_chunk_pairs(
    source_config: dict[str, Any],
    parsed_pairs: list[tuple[RawDocument, Chunk]],
    fetch_meta: dict[str, Any],
    writer: NornicGraphWriter,
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
    src_pack_id = str(source_config.get("pack_id", "global") or "global").strip()
    src_pack_version = str(source_config.get("pack_version", "") or "").strip()
    src_pack_source_version = str(source_config.get("pack_source_version", "") or "").strip()
    src_pack_artifact_hash = str(source_config.get("pack_artifact_hash", "") or "").strip()
    src_pack_partition = str(source_config.get("pack_partition", "") or "").strip() or src_pack_id
    src_visibility_scope = source_config.get("visibility_scope", "global")
    src_org_id = source_config.get("org_id", "")
    src_tenant_id = source_config.get("tenant_id", "")
    src_acl_mode = source_config.get("acl_mode", "open")
    src_acl_groups = source_config.get("acl_groups", "")
    src_owner_user_id = source_config.get("owner_user_id", "")
    src_conversation_id = source_config.get("conversation_id", "")
    src_upload_batch_id = source_config.get("upload_batch_id", "")
    src_upload_mode = source_config.get("upload_mode", "")
    src_is_ephemeral = bool(source_config.get("is_ephemeral", False))
    src_expires_at_epoch = int(source_config.get("expires_at_epoch", 0) or 0)
    src_language = str(source_config.get("language", "") or "").strip().lower()
    src_languages = source_config.get("languages", [])
    if not isinstance(src_languages, list):
        src_languages = []
    src_languages = [str(x).strip().lower() for x in src_languages if str(x).strip()]
    src_artifact_kind = str(source_config.get("artifact_kind", "") or "").strip().lower()
    src_corpus_class = str(source_config.get("corpus_class", "") or "").strip().lower()
    src_content_profile = str(source_config.get("content_profile", "") or "").strip().lower()
    src_constraint_kind = str(source_config.get("constraint_kind", "") or "").strip().lower()
    src_scope_tags: list[str] = []
    raw_scope_tags = source_config.get("scope_tags", [])
    if isinstance(raw_scope_tags, list):
        src_scope_tags = [str(x).strip().lower() for x in raw_scope_tags if str(x).strip()]
    src_constraint_source = str(source_config.get("constraint_source", "") or "").strip().lower()
    src_golden_path_id = str(source_config.get("golden_path_id", "") or "").strip()
    src_novel_pattern = bool(source_config.get("novel_pattern", False))
    src_novel_trace_level = str(source_config.get("novel_trace_level", "none") or "none").strip().lower()

    if src_corpus_class and src_corpus_class not in {"coder_enriched", "general", "hybrid"}:
        logger.warning(
            "indexer_invalid_corpus_class",
            extra={"source": name, "corpus_class": src_corpus_class},
        )
        src_corpus_class = ""

    if src_constraint_kind and src_constraint_kind not in {"hard", "guiding", "advisory"}:
        logger.warning(
            "indexer_invalid_constraint_kind",
            extra={"source": name, "constraint_kind": src_constraint_kind},
        )
        src_constraint_kind = ""

    if src_content_profile and src_content_profile not in {
        "code",
        "docs",
        "api_spec",
        "policy",
        "architecture",
        "mixed",
        "reference",
        "procedural",
        "tutorial",
        "pattern",
        "conceptual",
        "troubleshooting",
    }:
        logger.warning(
            "indexer_invalid_content_profile",
            extra={"source": name, "content_profile": src_content_profile},
        )
        src_content_profile = ""

    if not src_language:
        src_meta = source_config.get("config", {}).get("synesis_meta", {})
        if isinstance(src_meta, dict):
            src_language = str(src_meta.get("language", "") or "").strip().lower()
            if not src_languages:
                raw_langs = src_meta.get("languages", [])
                if isinstance(raw_langs, list):
                    src_languages = [str(x).strip().lower() for x in raw_langs if str(x).strip()]
            if not src_artifact_kind:
                src_artifact_kind = str(src_meta.get("artifact_kind", "") or "").strip().lower()
            if not src_corpus_class:
                src_corpus_class = str(src_meta.get("corpus_class", "") or "").strip().lower()
            if not src_content_profile:
                src_content_profile = str(src_meta.get("content_profile", "") or "").strip().lower()
            if not src_constraint_kind:
                src_constraint_kind = str(src_meta.get("constraint_kind", "") or "").strip().lower()
            if not src_scope_tags:
                raw_meta_scope = src_meta.get("scope_tags", [])
                if isinstance(raw_meta_scope, list):
                    src_scope_tags = [str(x).strip().lower() for x in raw_meta_scope if str(x).strip()]
            if not src_constraint_source:
                src_constraint_source = str(src_meta.get("constraint_source", "") or "").strip().lower()
            if not src_golden_path_id:
                src_golden_path_id = str(src_meta.get("golden_path_id", "") or "").strip()
            if not src_novel_pattern:
                src_novel_pattern = bool(src_meta.get("novel_pattern", False))
            if src_novel_trace_level == "none":
                src_novel_trace_level = str(src_meta.get("novel_trace_level", "none") or "none").strip().lower()

    if src_visibility_scope not in ("global", "org", "tenant", "user", "session"):
        logger.error(
            "indexer_invalid_visibility_scope",
            extra={"source": name, "visibility_scope": src_visibility_scope},
        )
        progress.log_error(name, f"invalid visibility_scope: {src_visibility_scope}")
        return 0, fetch_meta
    if src_visibility_scope in ("org", "tenant", "user", "session") and not src_org_id:
        logger.error(
            "indexer_scope_missing_org_id",
            extra={"source": name, "visibility_scope": src_visibility_scope},
        )
        progress.log_error(name, f"visibility_scope={src_visibility_scope} requires org_id")
        return 0, fetch_meta
    if src_visibility_scope == "tenant" and not src_tenant_id:
        logger.error(
            "indexer_scope_missing_tenant_id",
            extra={"source": name, "visibility_scope": src_visibility_scope},
        )
        progress.log_error(name, "visibility_scope=tenant requires tenant_id")
        return 0, fetch_meta
    if src_visibility_scope in ("user", "session") and not src_owner_user_id:
        logger.error(
            "indexer_scope_missing_owner_user_id",
            extra={"source": name, "visibility_scope": src_visibility_scope},
        )
        progress.log_error(name, f"visibility_scope={src_visibility_scope} requires owner_user_id")
        return 0, fetch_meta
    if src_visibility_scope == "session" and not src_conversation_id:
        logger.error(
            "indexer_scope_missing_conversation_id",
            extra={"source": name, "visibility_scope": src_visibility_scope},
        )
        progress.log_error(name, "visibility_scope=session requires conversation_id")
        return 0, fetch_meta

    if src_acl_mode not in ("open", "restricted", "private", ""):
        logger.error(
            "indexer_invalid_acl_mode",
            extra={"source": name, "acl_mode": src_acl_mode},
        )
        progress.log_error(name, f"invalid acl_mode: {src_acl_mode}")
        return 0, fetch_meta
    if src_acl_mode in ("restricted", "private") and not src_acl_groups:
        logger.error(
            "indexer_acl_missing_groups",
            extra={"source": name, "acl_mode": src_acl_mode},
        )
        progress.log_error(name, f"acl_mode={src_acl_mode} requires acl_groups")
        return 0, fetch_meta

    try:
        handler = get_handler(handler_type or "html_document")
    except ValueError:
        source_type = source_type_override or "docs"
    else:
        source_type = source_type_override or handler.source_type

    parsed_count = len(parsed_pairs)
    fetch_meta["semantic_contract"] = {
        "pass_a_version": "v10_gatekeeper",
        "pass_b_version": "pass_b_v1" if enrich_full else "deterministic_v1",
        "enrich_full": bool(enrich_full),
        "docs_total": 0,
        "docs_skipped": 0,
        "chunks_total": parsed_count,
        "chunks_enriched": 0,
        "parsed_total": parsed_count,
        "dedup_skipped": 0,
        "gate_rejected": 0,
        "gatekeeper_skipped_docs": 0,
        "written_total": 0,
    }
    fetch_meta["parsed_total"] = parsed_count
    fetch_meta["dedup_skipped"] = 0
    fetch_meta["gate_rejected"] = 0
    fetch_meta["gatekeeper_skipped_docs"] = 0
    fetch_meta["written_total"] = 0

    # 3. Deduplicate
    new_chunks: list[tuple[RawDocument, Chunk, str]] = []
    seen_cids: set[str] = set()
    for doc, chunk in parsed_pairs:
        cid = chunk_id_hash(chunk.text, f"{doc.doc_id}:{chunk.section}")
        if cid not in existing_ids and cid not in seen_cids:
            new_chunks.append((doc, chunk, cid))
            seen_cids.add(cid)

    if not new_chunks:
        fetch_meta["semantic_contract"]["dedup_skipped"] = parsed_count
        fetch_meta["dedup_skipped"] = parsed_count
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
        fetch_meta["semantic_contract"]["gate_rejected"] = rejected
        fetch_meta["gate_rejected"] = rejected
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
    fetch_meta["semantic_contract"]["gatekeeper_skipped_docs"] = skipped_docs
    fetch_meta["gatekeeper_skipped_docs"] = skipped_docs
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
    simhash_list = simhash_batch(chunk_texts_for_signals) if preprocess_base_url() else [""] * len(new_chunks)
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
    scan_signals_list: list[str] = []
    flagged_count = 0
    for doc, chunk, cid in new_chunks:
        status, signals = scan_chunk_text_detailed(chunk.text)
        scan_statuses.append(status)
        scan_signals_list.append(",".join(signals))
        if status == "flagged":
            flagged_count += 1
    if flagged_count:
        logger.info(
            "indexer_injection_scan",
            extra={"flagged": flagged_count, "total": len(new_chunks), "source": name},
        )

    entities = []
    for (doc, chunk, cid), enrichment, emb, chunk_scan, chunk_scan_signals, simh, spam_s in zip(
        new_chunks, enrichments, embeddings, scan_statuses, scan_signals_list, simhash_list, spam_list
    ):
        chunk_tags = chunk.metadata.get("tags") or doc.metadata.get("tags") or tags_str
        if isinstance(chunk_tags, list):
            chunk_tags = ",".join(str(x) for x in chunk_tags if str(x).strip())
        if not isinstance(chunk_tags, str):
            chunk_tags = str(chunk_tags)
        tag_parts = [t.strip() for t in chunk_tags.split(",") if t.strip()]
        if src_corpus_class and f"corpus_class:{src_corpus_class}" not in tag_parts:
            tag_parts.append(f"corpus_class:{src_corpus_class}")
        if src_content_profile and f"content_profile:{src_content_profile}" not in tag_parts:
            tag_parts.append(f"content_profile:{src_content_profile}")
        if src_constraint_kind and f"ck:{src_constraint_kind}" not in tag_parts:
            tag_parts.append(f"ck:{src_constraint_kind}")
        for _st in src_scope_tags:
            scope_entry = f"scope:{_st}"
            if scope_entry not in tag_parts:
                tag_parts.append(scope_entry)
        chunk_tags = ",".join(tag_parts)[:512]
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

        language = (
            chunk.metadata.get("language", "")
            or doc.metadata.get("language", "")
            or src_language
            or (src_languages[0] if src_languages else "")
        )
        repo_path = doc.metadata.get("repo", "") or doc.metadata.get("repo_path", "")
        module_path = chunk.metadata.get("file_path", "") or doc.metadata.get("module_path", "")
        symbol_name = chunk.metadata.get("symbol_name", "")
        import_refs = chunk.metadata.get("import_refs", "") or doc.metadata.get("import_refs", "")
        call_refs = chunk.metadata.get("call_refs", "") or doc.metadata.get("call_refs", "")
        if isinstance(import_refs, list):
            import_refs = ",".join(str(x) for x in import_refs if str(x).strip())
        if isinstance(call_refs, list):
            call_refs = ",".join(str(x) for x in call_refs if str(x).strip())
        pack_id = str(chunk.metadata.get("pack_id", "") or doc.metadata.get("pack_id", "") or src_pack_id or "global")
        pack_version = str(
            chunk.metadata.get("pack_version", "") or doc.metadata.get("pack_version", "") or src_pack_version
        )
        pack_source_version = str(
            chunk.metadata.get("pack_source_version", "")
            or doc.metadata.get("pack_source_version", "")
            or src_pack_source_version
        )
        pack_artifact_hash = str(
            chunk.metadata.get("pack_artifact_hash", "")
            or doc.metadata.get("pack_artifact_hash", "")
            or src_pack_artifact_hash
        )
        pack_partition = str(
            chunk.metadata.get("pack_partition", "")
            or doc.metadata.get("pack_partition", "")
            or src_pack_partition
            or pack_id
        )
        symbol_kind = str(chunk.metadata.get("symbol_kind", "") or chunk.metadata.get("symbol_type", "") or "")
        symbol_fqn = str(chunk.metadata.get("symbol_fqn", "") or "")
        package_name = str(chunk.metadata.get("package_name", "") or doc.metadata.get("package_name", "") or "")
        doc_relation_ids = chunk.metadata.get("doc_relation_ids", "") or doc.metadata.get("doc_relation_ids", "")
        if isinstance(doc_relation_ids, list):
            doc_relation_ids = ",".join(str(x) for x in doc_relation_ids if str(x).strip())
        doc_relation_ids = str(doc_relation_ids)
        artifact_kind = src_artifact_kind or _infer_artifact_kind(handler_type, content_format, language)
        has_code, code_signal_count, code_density = _code_chunk_metrics(chunk.text)
        code_language = str(language or content_format or "").strip().lower() if has_code else ""

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
                pack_id=pack_id,
                pack_version=pack_version,
                pack_source_version=pack_source_version,
                pack_artifact_hash=pack_artifact_hash,
                pack_partition=pack_partition,
                symbol_kind=symbol_kind,
                symbol_fqn=symbol_fqn,
                package_name=package_name,
                doc_relation_ids=doc_relation_ids,
                source_url=chunk_source_url,
                scan_status=chunk_scan,
                scan_signals=chunk_scan_signals,
                content_format=content_format,
                symbol_type=symbol_type,
                approval_status=approval,
                language=language,
                repo_path=repo_path,
                module_path=module_path,
                symbol_name=symbol_name,
                import_refs=str(import_refs),
                call_refs=str(call_refs),
                artifact_kind=artifact_kind,
                has_code=has_code,
                code_signal_count=code_signal_count,
                code_density=code_density,
                code_language=code_language,
                corpus_class=src_corpus_class,
                constraint_kind=src_constraint_kind,
                content_profile=src_content_profile,
                scope_tags=",".join(src_scope_tags),
                constraint_source=src_constraint_source,
                golden_path_id=src_golden_path_id,
                novel_pattern=src_novel_pattern,
                novel_trace_level=src_novel_trace_level,
                visibility_scope=src_visibility_scope,
                org_id=src_org_id,
                tenant_id=src_tenant_id,
                acl_mode=src_acl_mode,
                acl_groups=src_acl_groups,
                owner_user_id=src_owner_user_id,
                conversation_id=src_conversation_id,
                upload_batch_id=src_upload_batch_id,
                upload_mode=src_upload_mode,
                is_ephemeral=src_is_ephemeral,
                expires_at_epoch=src_expires_at_epoch,
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
    edge_count = writer.upsert_edges(derive_graph_edges(entities))
    if edge_count:
        fetch_meta["semantic_contract"]["edges_written"] = edge_count
        fetch_meta["edges_written"] = edge_count
    fetch_meta["semantic_contract"]["written_total"] = count
    fetch_meta["written_total"] = count
    for _, _, cid in new_chunks:
        existing_ids.add(cid)

    progress.log_source(name, count)
    return count, fetch_meta


def index_normalized_markdown_doc(
    source_config: dict[str, Any],
    raw_doc: RawDocument,
    writer: NornicGraphWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    existing_ids: set[str],
    *,
    enrich_full: bool = False,
    llm_url: str = "",
    dry_run: bool = False,
    gate_policy: GatePolicy | None = None,
) -> tuple[int, dict[str, Any]]:
    """Staged path: chunk normalized markdown and index into NornicDB."""
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
    writer: NornicGraphWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    existing_ids: set[str],
    *,
    enrich_full: bool = False,
    llm_url: str = "",
    dry_run: bool = False,
    gate_policy: GatePolicy | None = None,
) -> tuple[int, dict[str, Any]]:
    """Index one source configuration.

    Returns (chunks upserted, fetch telemetry dict). The second value is empty
    when fetch failed or produced no documents; otherwise it reflects the fetch
    even if later stages produced zero chunks.
    """
    name = source_config.get("name", "unknown")
    handler_type = source_config.get("handler", "")
    authority = source_config.get("authority", "community")

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
    if handler_type == "html_document" and preprocess_clean_html_enabled() and preprocess_base_url():
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
    nornic_uri: str = "",
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
        logger.info("indexer_dry_run_validation", extra={"detail": "No NornicDB/embedder connection"})

    writer_kwargs = {"uri": nornic_uri} if nornic_uri else {}
    embedder_kwargs = {"url": embedder_url} if embedder_url else {}

    if not dry_run:
        try:
            writer = NornicGraphWriter(**writer_kwargs)
        except Exception as e:
            logger.error("indexer_nornic_connect_failed", extra={"error": str(e)})
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
