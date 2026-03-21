"""S3 object layout for staged ingestion (raw / normalized / enriched)."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger("synesis.indexer.staged_s3")


def doc_key_for_uri(uri: str) -> str:
    return hashlib.sha256(uri.strip().encode("utf-8")).hexdigest()


def domain_slug(domain: str) -> str:
    s = (domain or "unknown").strip().lower()
    s = re.sub(r"[^a-z0-9._-]+", "_", s)
    return (s or "unknown")[:128]


class StagedS3Store:
    """Minimal S3 helper; uses default AWS credential chain (IRSA, env, etc.)."""

    def __init__(self) -> None:
        bucket = (os.environ.get("SYNESIS_INGESTION_S3_BUCKET") or "").strip()
        if not bucket:
            raise RuntimeError("SYNESIS_INGESTION_S3_BUCKET is required for staged ingestion")
        self.bucket = bucket
        raw_prefix = (os.environ.get("SYNESIS_INGESTION_S3_PREFIX") or "").strip().strip("/")
        self.prefix = f"{raw_prefix}/" if raw_prefix else ""

        import boto3

        self._client = boto3.client("s3")

    def _key(self, *parts: str) -> str:
        rest = "/".join(p.strip("/") for p in parts if p)
        return f"{self.prefix}{rest}" if self.prefix else rest

    def put_bytes(self, key: str, body: bytes, content_type: str) -> str:
        self._client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)
        return key

    def put_raw(
        self,
        domain: str,
        doc_key: str,
        ext: str,
        body: bytes,
        *,
        content_type: str = "application/octet-stream",
    ) -> str:
        ext = ext.lstrip(".")
        return self.put_bytes(self._key("raw", domain_slug(domain), f"{doc_key}.{ext}"), body, content_type)

    def put_raw_meta(self, domain: str, doc_key: str, meta: dict[str, Any]) -> str:
        key = self._key("raw", domain_slug(domain), f"{doc_key}.meta.json")
        body = json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8")
        return self.put_bytes(key, body, "application/json")

    def put_normalized(
        self,
        norm_version: str,
        doc_key: str,
        markdown: str,
        meta: dict[str, Any],
    ) -> tuple[str, str]:
        v = norm_version.strip() or "v1"
        md_key = self._key("normalized", v, f"{doc_key}.md")
        js_key = self._key("normalized", v, f"{doc_key}.json")
        self.put_bytes(md_key, markdown.encode("utf-8"), "text/markdown; charset=utf-8")
        self.put_bytes(js_key, json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8"), "application/json")
        return md_key, js_key

    def put_enriched_json(
        self,
        enrich_version: str,
        doc_key: str,
        payload: dict[str, Any],
    ) -> str:
        v = enrich_version.strip() or "v1"
        key = self._key("enriched", v, doc_key, "result.json")
        self.put_bytes(
            key,
            json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"),
            "application/json",
        )
        return key

    def get_text(self, key: str) -> str:
        resp = self._client.get_object(Bucket=self.bucket, Key=key)
        return resp["Body"].read().decode("utf-8", errors="replace")

    def get_bytes(self, key: str) -> bytes:
        resp = self._client.get_object(Bucket=self.bucket, Key=key)
        return resp["Body"].read()
