"""Worker loop for admin-managed Synesis content pack installs."""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from synesis_telemetry import get_logger

from .nornic_writer import NORNIC_URI
from .queue_runner import _DEFAULT_ADMIN_URL
from .synpack import load_synpack

logger = get_logger("synesis.indexer.content_packs")

_MAX_DOWNLOAD_BYTES_RAW = os.getenv("SYNESIS_CONTENT_PACK_MAX_BYTES", "").strip()
_MAX_DOWNLOAD_BYTES = int(_MAX_DOWNLOAD_BYTES_RAW) if _MAX_DOWNLOAD_BYTES_RAW.isdigit() else 2 * 1024 * 1024 * 1024
_MAX_JOBS_RAW = os.getenv("SYNESIS_CONTENT_PACK_MAX_JOBS", "").strip()
_MAX_JOBS = int(_MAX_JOBS_RAW) if _MAX_JOBS_RAW.isdigit() else 0


class ContentPackClient:
    def __init__(self, admin_url: str, timeout: float = 30.0):
        self._base = admin_url.rstrip("/")
        service_token = (
            os.getenv("SYNESIS_ADMIN_SERVICE_TOKEN", "").strip() or os.getenv("SYNESIS_API_TOKEN", "").strip()
        )
        headers: dict[str, str] = {}
        if service_token:
            headers["Authorization"] = f"Bearer {service_token}"
            headers["x-synesis-service-name"] = "indexer-content-packs"
        self._http = httpx.Client(base_url=self._base, timeout=timeout, headers=headers)

    def claim_job(self) -> dict[str, Any] | None:
        resp = self._http.post("/api/v1/rag/content-packs/install-jobs/claim")
        if resp.status_code == 204:
            return None
        resp.raise_for_status()
        return resp.json()

    def report_status(
        self,
        job_id: int,
        status: str,
        *,
        result: dict[str, Any] | None = None,
        error_message: str = "",
    ) -> None:
        payload: dict[str, Any] = {"status": status}
        if result is not None:
            payload["result"] = result
        if error_message:
            payload["error_message"] = error_message[:2000]
        resp = self._http.patch(f"/api/v1/rag/content-packs/install-jobs/{job_id}/status", json=payload)
        resp.raise_for_status()


def _require_https(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("content pack download_url must be an https URL")
    return url.strip()


def _download_pack(job: dict[str, Any]) -> Path:
    url = _require_https(str(job.get("download_url") or ""))
    expected_sha = str(job.get("sha256") or "").strip().lower()
    if len(expected_sha) != 64:
        raise ValueError("content pack job is missing a valid sha256")
    expected_size = int(job.get("size_bytes") or 0)
    max_bytes = expected_size if expected_size > 0 else _MAX_DOWNLOAD_BYTES
    max_bytes = min(max_bytes, _MAX_DOWNLOAD_BYTES)

    fd, tmp_name = tempfile.mkstemp(prefix="synpack-download-", suffix=".synpack")
    path = Path(tmp_name)
    digest = hashlib.sha256()
    total = 0
    try:
        with os.fdopen(fd, "wb") as f:
            with httpx.stream("GET", url, follow_redirects=True, timeout=300.0) as resp:
                resp.raise_for_status()
                if resp.url.scheme != "https":
                    raise ValueError("content pack download redirected to a non-https URL")
                for chunk in resp.iter_bytes(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError(f"content pack download exceeded {max_bytes} bytes")
                    digest.update(chunk)
                    f.write(chunk)
        actual_sha = digest.hexdigest()
        if actual_sha != expected_sha:
            raise ValueError(f"content pack sha256 mismatch: expected {expected_sha}, got {actual_sha}")
        return path
    except Exception:
        path.unlink(missing_ok=True)
        raise


def run_content_pack_installs(
    admin_url: str = "",
    *,
    nornic_uri: str = "",
    dry_run: bool = False,
) -> None:
    admin_url = admin_url or _DEFAULT_ADMIN_URL
    client = ContentPackClient(admin_url)
    processed = 0
    installed = 0
    failed = 0
    logger.info("content_pack_runner_start", extra={"admin_url": admin_url, "max_jobs": _MAX_JOBS or None})

    while True:
        if _MAX_JOBS and processed >= _MAX_JOBS:
            logger.info("content_pack_max_jobs_reached", extra={"max_jobs": _MAX_JOBS})
            break
        job = client.claim_job()
        if job is None:
            logger.info("content_pack_queue_empty")
            break

        processed += 1
        job_id = int(job["id"])
        pack_id = str(job.get("pack_id") or "")
        pack_version = str(job.get("pack_version") or "")
        logger.info("content_pack_job_claimed", extra={"job_id": job_id, "pack_id": pack_id, "version": pack_version})

        pack_path: Path | None = None
        try:
            pack_path = _download_pack(job)
            if dry_run:
                result = {"ok": True, "pack_id": pack_id, "dry_run": True}
            else:
                result = load_synpack(
                    pack_path,
                    nornic_uri=nornic_uri or NORNIC_URI,
                    replace=bool(job.get("replace_existing")),
                )
            client.report_status(job_id, "installed", result=result)
            installed += 1
            logger.info("content_pack_job_installed", extra={"job_id": job_id, "pack_id": pack_id})
        except Exception as exc:
            client.report_status(job_id, "failed", error_message=str(exc))
            failed += 1
            logger.error("content_pack_job_failed", extra={"job_id": job_id, "pack_id": pack_id, "error": str(exc)})
        finally:
            if pack_path is not None:
                pack_path.unlink(missing_ok=True)

    logger.info(
        "content_pack_runner_complete",
        extra={"processed": processed, "installed": installed, "failed": failed},
    )
