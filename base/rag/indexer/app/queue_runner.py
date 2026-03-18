"""DB-driven queue runner: claims items from the admin API, processes them, reports status.

Replaces the YAML-driven pipeline for production use.  The indexer image
stays DB-free — all queue state is managed via HTTP calls to the admin service.

Usage:
    python -m app.cli --mode queue --admin-url http://synesis-admin:8000
"""

from __future__ import annotations

import os
import time
from typing import Any
from urllib.parse import urlparse

import httpx
from synesis_telemetry import get_logger

from .content_gate import GatePolicy
from .embed_client import EmbedClient
from .handlers import get_handler
from .milvus_writer import MilvusWriter, ProgressTracker
from .pipeline import index_source
from .schema import SCHEMA_VERSION, ensure_synesis_catalog

logger = get_logger("synesis.indexer.queue")

_DEFAULT_ADMIN_URL = os.getenv(
    "SYNESIS_ADMIN_URL",
    "http://synesis-admin.synesis-admin.svc.cluster.local:8000",
)


class QueueClient:
    """HTTP client for the admin ingestion API."""

    def __init__(self, admin_url: str, timeout: float = 30.0):
        self._base = admin_url.rstrip("/")
        self._http = httpx.Client(base_url=self._base, timeout=timeout)

    def claim_item(self) -> dict[str, Any] | None:
        resp = self._http.post("/api/v1/ingestion/items/claim")
        if resp.status_code == 204:
            return None
        resp.raise_for_status()
        return resp.json()

    def report_status(
        self,
        item_id: int,
        status: str,
        *,
        chunk_count: int = 0,
        error_message: str = "",
        content_hash: str = "",
        milvus_doc_id: str = "",
    ) -> None:
        payload: dict[str, Any] = {"status": status}
        if chunk_count:
            payload["chunk_count"] = chunk_count
        if error_message:
            payload["error_message"] = error_message[:2000]
        if content_hash:
            payload["content_hash"] = content_hash
        if milvus_doc_id:
            payload["milvus_doc_id"] = milvus_doc_id
        resp = self._http.patch(f"/api/v1/ingestion/items/{item_id}/status", json=payload)
        resp.raise_for_status()

    def create_run(self, trigger: str = "cron") -> int:
        resp = self._http.post("/api/v1/ingestion/runs", json={"trigger": trigger})
        resp.raise_for_status()
        return resp.json()["id"]

    def update_run(self, run_id: int, **kwargs: Any) -> None:
        resp = self._http.patch(f"/api/v1/ingestion/runs/{run_id}", json=kwargs)
        resp.raise_for_status()

    def report_schema_version(self, version: int, collection: str = "synesis_catalog") -> dict[str, Any]:
        """Report the current Milvus schema version to the admin service.

        If the version changed, admin resets all 'indexed' items to 'pending'.
        """
        resp = self._http.post(
            "/api/v1/ingestion/schema-sync",
            json={"collection": collection, "schema_version": version, "reporter": "indexer"},
        )
        resp.raise_for_status()
        return resp.json()


def _build_source_config(item: dict[str, Any]) -> dict[str, Any]:
    """Build a source_config dict matching what handlers expect from sources.yaml."""
    handler = item.get("effective_handler") or item.get("handler") or "html_document"
    config = dict(item.get("effective_config") or item.get("config") or {})
    domain = item.get("effective_domain") or item.get("domain") or "generalist"
    authority = item.get("effective_authority") or item.get("authority") or "vetted"
    tags = item.get("effective_tags") or item.get("tags") or []

    uri = item.get("uri", "")
    if "url" not in config and uri:
        config["url"] = uri
    if "repo" not in config and uri:
        parsed = urlparse(uri)
        host = (parsed.hostname or "").lower()
        if host == "github.com":
            repo_path = parsed.path.lstrip("/").rstrip("/")
            if repo_path:
                config.setdefault("repo", repo_path)

    if isinstance(tags, list) and "tags" not in config:
        config["tags"] = tags

    return {
        "name": item.get("title") or uri,
        "handler": handler,
        "authority": authority,
        "origin_type": item.get("origin_type", "curated"),
        "domain": domain,
        "config": config,
    }


def run_queue(
    admin_url: str = "",
    *,
    force: bool = False,
    enrich_full: bool = False,
    llm_url: str = "",
    dry_run: bool = False,
    milvus_uri: str = "",
    embedder_url: str = "",
    trigger: str = "cron",
) -> None:
    """Main queue loop: claim items, process, report."""
    admin_url = admin_url or _DEFAULT_ADMIN_URL
    client = QueueClient(admin_url)

    logger.info("queue_runner_start", extra={"admin_url": admin_url, "trigger": trigger})

    run_id = client.create_run(trigger=trigger)
    logger.info("queue_run_created", extra={"run_id": run_id})

    writer_kwargs = {"uri": milvus_uri} if milvus_uri else {}
    embedder_kwargs = {"url": embedder_url} if embedder_url else {}

    if not dry_run:
        try:
            writer = MilvusWriter(**writer_kwargs)
        except Exception as e:
            logger.error("queue_milvus_connect_failed", extra={"error": str(e)})
            client.update_run(run_id, status="failed")
            return
        embedder = EmbedClient(**embedder_kwargs)
        ensure_synesis_catalog(writer.client)

        try:
            sync_result = client.report_schema_version(SCHEMA_VERSION)
            action = sync_result.get("action", "unknown")
            if action == "reset":
                items_reset = sync_result.get("items_reset", 0)
                logger.info(
                    "schema_sync_reset_items",
                    extra={
                        "old_version": sync_result.get("old_version"),
                        "new_version": sync_result.get("new_version"),
                        "items_reset": items_reset,
                    },
                )
            elif action == "initialized":
                logger.info("schema_sync_first_report", extra={"version": SCHEMA_VERSION})
            else:
                logger.debug("schema_sync_no_change", extra={"version": SCHEMA_VERSION})
        except Exception as e:
            logger.warning("schema_sync_report_failed", extra={"error": str(e)})

        existing_ids = writer.existing_chunk_ids() if not force else set()
    else:
        writer = None  # type: ignore[assignment]
        embedder = None  # type: ignore[assignment]
        existing_ids = set()

    progress = ProgressTracker(name="Queue Runner")
    gate_policy = GatePolicy()

    items_total = 0
    items_indexed = 0
    items_failed = 0

    while True:
        try:
            item = client.claim_item()
        except httpx.HTTPError as e:
            logger.error("queue_claim_failed", extra={"error": str(e)})
            time.sleep(5)
            continue

        if item is None:
            logger.info("queue_empty")
            break

        item_id = item["id"]
        item_uri = item.get("uri", "?")
        items_total += 1

        logger.info(
            "queue_item_claimed",
            extra={"item_id": item_id, "uri": item_uri, "handler": item.get("effective_handler")},
        )

        try:
            source_config = _build_source_config(item)
            chunks = index_source(
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
            client.report_status(item_id, "indexed", chunk_count=chunks)
            items_indexed += 1
            logger.info(
                "queue_item_indexed",
                extra={"item_id": item_id, "uri": item_uri, "chunks": chunks},
            )
        except Exception as e:
            client.report_status(item_id, "failed", error_message=str(e))
            items_failed += 1
            logger.error(
                "queue_item_failed",
                extra={"item_id": item_id, "uri": item_uri, "error": str(e)},
            )

        client.update_run(
            run_id,
            items_total=items_total,
            items_indexed=items_indexed,
            items_failed=items_failed,
        )

    final_status = "complete" if items_failed == 0 else "complete_with_errors"
    client.update_run(
        run_id,
        status=final_status,
        items_total=items_total,
        items_indexed=items_indexed,
        items_failed=items_failed,
    )
    progress.log_complete()
    logger.info(
        "queue_runner_complete",
        extra={
            "run_id": run_id,
            "items_total": items_total,
            "items_indexed": items_indexed,
            "items_failed": items_failed,
        },
    )
