"""Staged pipeline workers: fetch→S3, normalize→S3, enrich→Milvus."""

from __future__ import annotations

import hashlib
import os
import time
from typing import Any

import httpx
from synesis_telemetry import get_logger

from .content_gate import GatePolicy
from .embed_client import EmbedClient
from .extract import html_to_markdown, normalize_doc_markdown
from .handlers import get_handler
from .handlers.base import RawDocument
from .milvus_writer import MilvusWriter, ProgressTracker
from .pipeline import _indexer_stats_from_fetch, index_normalized_markdown_doc
from .queue_runner import _build_source_config
from .schema import SCHEMA_VERSION, ensure_synesis_catalog
from .staged_client import StagedIngestionClient
from .staged_s3 import StagedS3Store, doc_key_for_uri

logger = get_logger("synesis.indexer.staged")

_DEFAULT_ADMIN = os.getenv(
    "SYNESIS_ADMIN_URL",
    "http://synesis-admin.synesis-admin.svc.cluster.local:8080",
)


def run_staged_fetch(
    admin_url: str = "",
    *,
    dry_run: bool = False,
) -> None:
    admin_url = admin_url or _DEFAULT_ADMIN
    client = StagedIngestionClient(admin_url)
    store = None if dry_run else StagedS3Store()

    while True:
        try:
            item = client.claim_fetch()
        except httpx.HTTPError as e:
            logger.error("staged_fetch_claim_failed", extra={"error": str(e)})
            time.sleep(5)
            continue
        if item is None:
            logger.info("staged_fetch_queue_empty")
            break

        item_id = item["id"]
        uri = item.get("uri", "")
        try:
            source_config = _build_source_config(item)
            handler_type = source_config.get("handler") or "html_document"
            handler = get_handler(handler_type)
            documents = handler.fetch(source_config)
            fetch_meta = _indexer_stats_from_fetch(handler_type, source_config, documents)

            reg: list[dict[str, Any]] = []
            dom = source_config.get("domain") or item.get("effective_domain") or item.get("domain") or "generalist"

            for doc in documents:
                dk = doc_key_for_uri(doc.source_url or uri)
                body = doc.content if isinstance(doc.content, bytes) else doc.content.encode("utf-8")
                lower = body[:4000].lower()
                if b"<html" in lower or b"<!doctype html" in lower:
                    ext, ctype = "html", "text/html; charset=utf-8"
                else:
                    ext, ctype = "txt", "text/plain; charset=utf-8"

                raw_keys: dict[str, str] = {}
                if not dry_run and store is not None:
                    k_html = store.put_raw(dom, dk, ext, body, content_type=ctype)
                    raw_keys["body"] = k_html
                    meta = {
                        "doc_key": dk,
                        "canonical_uri": doc.source_url or uri,
                        "title": doc.name,
                        "handler": handler_type,
                        "metadata": doc.metadata,
                    }
                    k_meta = store.put_raw_meta(dom, dk, meta)
                    raw_keys["meta"] = k_meta
                else:
                    raw_keys = {"body": f"(dry-run:{dk}.{ext})", "meta": f"(dry-run:{dk}.meta.json)"}

                raw_hash = hashlib.sha256(body).hexdigest()
                reg.append(
                    {
                        "ingestion_item_id": item_id,
                        "doc_key": dk,
                        "canonical_uri": doc.source_url or uri,
                        "title": doc.name or "",
                        "domain": dom,
                        "handler": handler_type,
                        "authority": source_config.get("authority") or item.get("effective_authority") or "vetted",
                        "origin_type": item.get("origin_type", "curated"),
                        "tags": item.get("effective_tags") or item.get("tags"),
                        "config_snapshot": source_config.get("config")
                        if isinstance(source_config.get("config"), dict)
                        else {},
                        "raw_s3_keys": raw_keys,
                        "raw_content_hash": raw_hash,
                        "raw_status": "done",
                    }
                )

            if not reg:
                client.patch_item(
                    item_id,
                    {
                        "status": "failed",
                        "error_message": "staged fetch produced no documents",
                        "indexer_stats": fetch_meta,
                    },
                )
                logger.warning(
                    "staged_fetch_empty",
                    extra={"item_id": item_id, "uri": uri},
                )
                continue

            client.register_documents(reg)

            client.patch_item(
                item_id,
                {
                    "status": "staged_raw",
                    "indexer_stats": fetch_meta,
                    "error_message": "",
                },
            )
            logger.info(
                "staged_fetch_item_done",
                extra={"item_id": item_id, "uri": uri, "documents": len(reg)},
            )
        except Exception as e:
            logger.error("staged_fetch_item_failed", extra={"item_id": item_id, "error": str(e)})
            client.patch_item(
                item_id,
                {"status": "failed", "error_message": str(e)[:2000]},
            )


def run_staged_normalize(
    admin_url: str = "",
    *,
    dry_run: bool = False,
    batch_limit: int = 8,
    norm_version: str = "v1",
    enrich_version: str = "v1",
) -> None:
    admin_url = admin_url or _DEFAULT_ADMIN
    client = StagedIngestionClient(admin_url)
    store = None if dry_run else StagedS3Store()

    while True:
        try:
            docs = client.claim_normalize(limit=batch_limit)
        except httpx.HTTPError as e:
            logger.error("staged_normalize_claim_failed", extra={"error": str(e)})
            time.sleep(5)
            continue
        if not docs:
            logger.info("staged_normalize_queue_empty")
            break

        for d in docs:
            doc_id = d["id"]
            doc_key = d["doc_key"]
            keys = d.get("raw_s3_keys") or {}
            body_key = keys.get("body") or keys.get("html")
            try:
                if not body_key:
                    raise ValueError("raw_s3_keys missing body/html key")
                raw = b"" if dry_run else (store.get_bytes(body_key) if store else b"")
                text = raw.decode("utf-8", errors="replace")
                lower = raw[:8000].lower()
                if b"<html" in lower or b"<!doctype" in lower:
                    md = normalize_doc_markdown(html_to_markdown(text))
                else:
                    md = normalize_doc_markdown(text)
                norm_hash = hashlib.sha256(md.encode("utf-8")).hexdigest()
                meta = {
                    "doc_key": doc_key,
                    "canonical_uri": d.get("canonical_uri", ""),
                    "norm_version": norm_version,
                    "content_hash": norm_hash,
                }
                md_key, js_key = ("", "")
                if not dry_run and store is not None:
                    md_key, js_key = store.put_normalized(norm_version, doc_key, md, meta)

                client.patch_normalize_result(
                    doc_id,
                    {
                        "norm_status": "done",
                        "norm_content_hash": norm_hash,
                        "norm_s3_md_key": md_key or f"(dry-run:{doc_key}.md)",
                        "norm_s3_meta_key": js_key or f"(dry-run:{doc_key}.json)",
                        "norm_version": norm_version,
                        "enrich_version": enrich_version,
                        "enqueue_enrich": True,
                    },
                )
                logger.info("staged_normalize_doc_done", extra={"document_id": doc_id, "doc_key": doc_key})
            except Exception as e:
                logger.error("staged_normalize_doc_failed", extra={"document_id": doc_id, "error": str(e)})
                client.patch_normalize_result(
                    doc_id,
                    {
                        "norm_status": "failed",
                        "error_message": str(e)[:2000],
                        "norm_version": norm_version,
                        "enqueue_enrich": False,
                    },
                )


def run_staged_enrich(
    admin_url: str = "",
    *,
    dry_run: bool = False,
    batch_limit: int = 4,
    worker_id: str = "",
    enrich_full: bool = False,
    llm_url: str = "",
    milvus_uri: str = "",
    embedder_url: str = "",
    force: bool = False,
) -> None:
    admin_url = admin_url or _DEFAULT_ADMIN
    wid = worker_id or os.getenv("HOSTNAME", "staged-enrich")
    client = StagedIngestionClient(admin_url)
    store = None if dry_run else StagedS3Store()

    writer_kwargs = {"uri": milvus_uri} if milvus_uri else {}
    embedder_kwargs = {"url": embedder_url} if embedder_url else {}

    if not dry_run:
        writer = MilvusWriter(**writer_kwargs)
        embedder = EmbedClient(**embedder_kwargs)
        ensure_synesis_catalog(writer.client)
        try:
            sync = client.report_schema_version(SCHEMA_VERSION)
            if sync.get("action") == "reset":
                logger.info(
                    "staged_enrich_schema_reset",
                    extra={"items_reset": sync.get("items_reset", 0)},
                )
        except Exception as e:
            logger.warning("staged_enrich_schema_sync_failed", extra={"error": str(e)})
        existing_ids = writer.existing_chunk_ids() if not force else set()
    else:
        writer = None  # type: ignore[assignment]
        embedder = None  # type: ignore[assignment]
        existing_ids = set()

    progress = ProgressTracker(name="Staged Enrich")
    gate_policy = GatePolicy()

    try:
        while True:
            try:
                jobs = client.claim_enrich(limit=batch_limit, worker_id=wid)
            except httpx.HTTPError as e:
                logger.error("staged_enrich_claim_failed", extra={"error": str(e)})
                time.sleep(5)
                continue
            if not jobs:
                logger.info("staged_enrich_queue_empty")
                break

            for job in jobs:
                job_id = job["job_id"]
                md_key = job.get("norm_s3_md_key") or ""
                doc_key = job.get("doc_key", "")
                try:
                    md = "" if dry_run else (store.get_text(md_key) if store else "")
                    if dry_run:
                        chunks = 0
                    else:
                        raw_doc = RawDocument(
                            doc_id=doc_key,
                            name=job.get("title") or doc_key,
                            content=md,
                            source_url=job.get("canonical_uri", ""),
                            metadata={
                                "tags": job.get("effective_tags"),
                                "domain": job.get("effective_domain"),
                                "authority": job.get("effective_authority"),
                            },
                        )
                        source_config = {
                            "name": job.get("title") or doc_key,
                            "handler": job.get("effective_handler") or "html_document",
                            "authority": job.get("effective_authority") or "vetted",
                            "origin_type": job.get("origin_type", "curated"),
                            "domain": job.get("effective_domain") or "generalist",
                            "config": job.get("effective_config") or {},
                        }
                        chunks, stats = index_normalized_markdown_doc(
                            source_config,
                            raw_doc,
                            writer,
                            embedder,
                            progress,
                            existing_ids,
                            enrich_full=enrich_full,
                            llm_url=llm_url or os.getenv("SYNESIS_INDEXER_LLM_URL", ""),
                            dry_run=False,
                            gate_policy=gate_policy,
                        )
                        if store is not None:
                            store.put_enriched_json(
                                job.get("enrich_version", "v1"),
                                doc_key,
                                {
                                    "doc_key": doc_key,
                                    "job_id": job_id,
                                    "canonical_uri": job.get("canonical_uri", ""),
                                    "chunk_count": chunks,
                                    "enrich_version": job.get("enrich_version", "v1"),
                                    "norm_version": job.get("norm_version", "v1"),
                                    "indexer_stats": stats if isinstance(stats, dict) else {},
                                },
                            )

                    client.patch_enrich_job(
                        job_id,
                        {
                            "status": "done",
                            "chunk_count": chunks,
                            "milvus_doc_id": doc_key[:128],
                        },
                    )
                    logger.info(
                        "staged_enrich_job_done",
                        extra={"job_id": job_id, "doc_key": doc_key, "chunks": chunks},
                    )
                except Exception as e:
                    logger.error("staged_enrich_job_failed", extra={"job_id": job_id, "error": str(e)})
                    client.patch_enrich_job(
                        job_id,
                        {"status": "failed", "error": str(e)[:2000]},
                    )

    finally:
        progress.log_complete()
