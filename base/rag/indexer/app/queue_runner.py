"""DB-driven queue runner: claims items from the admin API, processes them, reports status.

Replaces the YAML-driven pipeline for production use.  The indexer image
stays DB-free — all queue state is managed via HTTP calls to the admin service.

Usage:
    python -m app.cli --mode queue --admin-url http://synesis-admin:8080
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
from .nornic_writer import NornicGraphWriter, ProgressTracker
from .pipeline import index_source
from .schema import SCHEMA_VERSION, ensure_synesis_catalog

logger = get_logger("synesis.indexer.queue")

_LOCAL_PATH_FIELDS: dict[str, tuple[str, ...]] = {
    "license_spdx": ("compat_path",),
    "markdown_file": ("path",),
    "seed_corpus": ("path",),
    "structured_data": ("path",),
}


class UnsafeQueueConfigError(ValueError):
    """Raised when an API queue item attempts local filesystem ingestion."""


_DEFAULT_ADMIN_URL = os.getenv(
    "SYNESIS_ADMIN_URL",
    "http://synesis-admin.synesis-admin.svc.cluster.local:8080",
)

# Optional claim filters (must match admin API query params on POST .../items/claim).
_QUEUE_DOMAIN = os.getenv("SYNESIS_INDEXER_QUEUE_DOMAIN", "").strip()
_QUEUE_TAG = os.getenv("SYNESIS_INDEXER_QUEUE_TAG", "").strip()
_QUEUE_MAX_ITEMS_RAW = os.getenv("SYNESIS_INDEXER_QUEUE_MAX_ITEMS", "").strip()
_QUEUE_MAX_ITEMS = int(_QUEUE_MAX_ITEMS_RAW) if _QUEUE_MAX_ITEMS_RAW.isdigit() else 0


class QueueClient:
    """HTTP client for the admin ingestion API."""

    def __init__(self, admin_url: str, timeout: float = 30.0):
        self._base = admin_url.rstrip("/")
        service_token = (
            os.getenv("SYNESIS_ADMIN_SERVICE_TOKEN", "").strip() or os.getenv("SYNESIS_API_TOKEN", "").strip()
        )
        headers: dict[str, str] = {}
        if service_token:
            headers["Authorization"] = f"Bearer {service_token}"
            headers["x-synesis-service-name"] = "indexer-queue"
        self._http = httpx.Client(base_url=self._base, timeout=timeout, headers=headers)

    def claim_item(self) -> dict[str, Any] | None:
        params: dict[str, str] = {}
        if _QUEUE_DOMAIN:
            params["domain"] = _QUEUE_DOMAIN
        if _QUEUE_TAG:
            params["tag"] = _QUEUE_TAG
        resp = self._http.post("/api/v1/ingestion/items/claim", params=params or None)
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
        graph_node_id: str = "",
        indexer_stats: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {"status": status}
        if chunk_count:
            payload["chunk_count"] = chunk_count
        if error_message:
            payload["error_message"] = error_message[:2000]
        if content_hash:
            payload["content_hash"] = content_hash
        if graph_node_id:
            payload["graph_node_id"] = graph_node_id
        if indexer_stats:
            payload["indexer_stats"] = indexer_stats
        resp = self._http.patch(f"/api/v1/ingestion/items/{item_id}/status", json=payload)
        resp.raise_for_status()

    def create_run(self, trigger: str = "cron") -> int:
        resp = self._http.post("/api/v1/ingestion/runs", json={"trigger": trigger})
        resp.raise_for_status()
        return resp.json()["id"]

    def update_run(self, run_id: int, **kwargs: Any) -> None:
        resp = self._http.patch(f"/api/v1/ingestion/runs/{run_id}", json=kwargs)
        resp.raise_for_status()

    def report_schema_version(self, version: int, collection: str = "content_graph") -> dict[str, Any]:
        """Report the current content graph schema version to the admin service.

        If the version changed, admin resets all 'indexed' items to 'pending'.
        """
        resp = self._http.post(
            "/api/v1/ingestion/schema-sync",
            json={"collection": collection, "schema_version": version, "reporter": "indexer"},
        )
        resp.raise_for_status()
        return resp.json()


def _build_source_config(item: dict[str, Any]) -> dict[str, Any]:
    """Build a source_config dict matching what handlers expect."""
    handler = item.get("effective_handler") or item.get("handler") or "html_document"
    config = dict(item.get("effective_config") or item.get("config") or {})
    for field in _LOCAL_PATH_FIELDS.get(str(handler), ()):
        if config.get(field):
            raise UnsafeQueueConfigError(f"config.{field} is not allowed for queued handler '{handler}'")
    domain = item.get("effective_domain") or item.get("domain") or "generalist"
    authority = item.get("effective_authority") or item.get("authority") or "vetted"
    tags = item.get("effective_tags") or item.get("tags") or []
    visibility_scope = item.get("effective_visibility_scope") or item.get("visibility_scope") or "global"
    org_id = item.get("effective_org_id") or item.get("org_id") or ""
    tenant_id = item.get("effective_tenant_id") or item.get("tenant_id") or ""
    acl_mode = item.get("effective_acl_mode") or item.get("acl_mode") or "open"
    acl_groups = item.get("effective_acl_groups") or item.get("acl_groups") or ""
    owner_user_id = item.get("effective_owner_user_id") or item.get("owner_user_id") or ""
    conversation_id = item.get("effective_conversation_id") or item.get("conversation_id") or ""
    upload_batch_id = item.get("effective_upload_batch_id") or item.get("upload_batch_id") or ""
    upload_mode = item.get("effective_upload_mode") or item.get("upload_mode") or ""
    is_ephemeral = bool(item.get("effective_is_ephemeral") or item.get("is_ephemeral") or False)
    expires_at_epoch = int(item.get("effective_expires_at_epoch") or item.get("expires_at_epoch") or 0)
    pack_id = item.get("effective_pack_id") or item.get("pack_id") or "global"
    pack_version = item.get("effective_pack_version") or item.get("pack_version") or ""
    pack_source_version = item.get("effective_pack_source_version") or item.get("pack_source_version") or ""
    pack_artifact_hash = item.get("effective_pack_artifact_hash") or item.get("pack_artifact_hash") or ""
    pack_partition = item.get("effective_pack_partition") or item.get("pack_partition") or pack_id

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

    synesis_meta = config.get("synesis_meta")
    if not isinstance(synesis_meta, dict):
        synesis_meta = {}
    meta_languages = synesis_meta.get("languages")
    languages = [
        str(x).strip().lower() for x in (meta_languages if isinstance(meta_languages, list) else []) if str(x).strip()
    ]
    preferred_language = str(synesis_meta.get("language") or "").strip().lower()
    if not preferred_language and languages:
        preferred_language = languages[0]
    artifact_kind = str(synesis_meta.get("artifact_kind") or "").strip().lower()
    corpus_class = str(synesis_meta.get("corpus_class") or "").strip().lower()
    content_profile = str(synesis_meta.get("content_profile") or "").strip().lower()
    if preferred_language and "language" not in config:
        config["language"] = preferred_language

    return {
        "name": item.get("title") or uri,
        "handler": handler,
        "authority": authority,
        "origin_type": item.get("origin_type", "curated"),
        "domain": domain,
        "config": config,
        "language": preferred_language,
        "languages": languages,
        "artifact_kind": artifact_kind,
        "corpus_class": corpus_class,
        "content_profile": content_profile,
        "pack_id": pack_id,
        "pack_version": pack_version,
        "pack_source_version": pack_source_version,
        "pack_artifact_hash": pack_artifact_hash,
        "pack_partition": pack_partition,
        "visibility_scope": visibility_scope,
        "org_id": org_id,
        "tenant_id": tenant_id,
        "acl_mode": acl_mode,
        "acl_groups": acl_groups,
        "owner_user_id": owner_user_id,
        "conversation_id": conversation_id,
        "upload_batch_id": upload_batch_id,
        "upload_mode": upload_mode,
        "is_ephemeral": is_ephemeral,
        "expires_at_epoch": expires_at_epoch,
    }


def run_queue(
    admin_url: str = "",
    *,
    force: bool = False,
    enrich_full: bool = False,
    llm_url: str = "",
    dry_run: bool = False,
    nornic_uri: str = "",
    embedder_url: str = "",
    trigger: str = "cron",
) -> None:
    """Main queue loop: claim items, process, report."""
    admin_url = admin_url or _DEFAULT_ADMIN_URL
    client = QueueClient(admin_url)

    logger.info(
        "queue_runner_start",
        extra={
            "admin_url": admin_url,
            "trigger": trigger,
            "claim_domain": _QUEUE_DOMAIN or None,
            "claim_tag": _QUEUE_TAG or None,
            "max_items": _QUEUE_MAX_ITEMS or None,
        },
    )

    run_id = client.create_run(trigger=trigger)
    logger.info("queue_run_created", extra={"run_id": run_id})

    writer_kwargs = {"uri": nornic_uri} if nornic_uri else {}
    embedder_kwargs = {"url": embedder_url} if embedder_url else {}

    if not dry_run:
        try:
            writer = NornicGraphWriter(**writer_kwargs)
        except Exception as e:
            logger.error("queue_nornic_connect_failed", extra={"error": str(e)})
            try:
                client.update_run(run_id, status="failed")
            except Exception:
                logger.debug("queue_run_failed_update_skipped", exc_info=True)
            raise SystemExit(1) from e
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
        if _QUEUE_MAX_ITEMS and items_total >= _QUEUE_MAX_ITEMS:
            logger.info("queue_max_items_reached", extra={"max_items": _QUEUE_MAX_ITEMS})
            break

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
            chunks, fetch_meta = index_source(
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
            client.report_status(
                item_id,
                "indexed",
                chunk_count=chunks,
                indexer_stats=fetch_meta or None,
            )
            items_indexed += 1
            logger.info(
                "queue_item_indexed",
                extra={"item_id": item_id, "uri": item_uri, "chunks": chunks},
            )
        except Exception as e:
            status = "dead_letter" if isinstance(e, UnsafeQueueConfigError) else "failed"
            client.report_status(item_id, status, error_message=str(e))
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
