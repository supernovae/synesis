"""Object storage archive writer for Admin cleanup flows."""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import uuid
from datetime import UTC, datetime
from typing import Any


class ArchiveConfigError(RuntimeError):
    """Raised when archive storage is not configured."""


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _archive_config() -> tuple[str, str, str | None]:
    bucket = (os.getenv("SYNESIS_ADMIN_ARCHIVE_S3_BUCKET") or "").strip()
    if not bucket:
        raise ArchiveConfigError("SYNESIS_ADMIN_ARCHIVE_S3_BUCKET is not configured")
    prefix = (os.getenv("SYNESIS_ADMIN_ARCHIVE_S3_PREFIX") or "admin-archives").strip().strip("/")
    endpoint_url = (os.getenv("SYNESIS_ADMIN_ARCHIVE_S3_ENDPOINT_URL") or "").strip() or None
    return bucket, prefix, endpoint_url


async def write_jsonl_archive(
    *,
    kind: str,
    records: list[dict[str, Any]],
    manifest: dict[str, Any],
) -> dict[str, Any]:
    """Write a gzip JSONL archive to S3-compatible object storage."""
    if not records:
        return {
            "archive_id": "",
            "bucket": "",
            "key": "",
            "record_count": 0,
            "bytes": 0,
        }

    bucket, prefix, endpoint_url = _archive_config()
    archive_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    safe_kind = kind.strip("/").replace("..", "").replace("//", "/")
    key = f"{prefix}/{safe_kind}/{now:%Y/%m/%d}/{archive_id}.jsonl.gz"

    payload_manifest = {
        "record_type": "manifest",
        "archive_id": archive_id,
        "kind": kind,
        "created_at": now.isoformat(),
        **manifest,
    }
    lines = [json.dumps(payload_manifest, default=_json_default, separators=(",", ":"))]
    lines.extend(json.dumps(row, default=_json_default, separators=(",", ":")) for row in records)
    body = gzip.compress(("\n".join(lines) + "\n").encode("utf-8"))

    def _put() -> None:
        import boto3

        client_kwargs: dict[str, Any] = {}
        if endpoint_url:
            client_kwargs["endpoint_url"] = endpoint_url
        client = boto3.client("s3", **client_kwargs)
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="application/jsonl",
            ContentEncoding="gzip",
            Metadata={
                "archive-id": archive_id,
                "archive-kind": kind.replace("/", "-")[:64],
            },
        )

    await asyncio.to_thread(_put)
    return {
        "archive_id": archive_id,
        "bucket": bucket,
        "key": key,
        "record_count": len(records),
        "bytes": len(body),
    }
