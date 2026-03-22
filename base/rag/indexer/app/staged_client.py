"""HTTP client for /api/v1/ingestion/staged/* (admin service)."""

from __future__ import annotations

import os
from typing import Any

import httpx


class StagedIngestionClient:
    def __init__(self, admin_url: str, timeout: float = 120.0):
        self._base = admin_url.rstrip("/")
        service_token = (
            os.getenv("SYNESIS_ADMIN_SERVICE_TOKEN", "").strip() or os.getenv("SYNESIS_API_TOKEN", "").strip()
        )
        headers: dict[str, str] = {}
        if service_token:
            headers["Authorization"] = f"Bearer {service_token}"
            headers["x-synesis-service-name"] = "indexer-staged"
        self._http = httpx.Client(base_url=self._base, timeout=timeout, headers=headers)

    def claim_fetch(self) -> dict[str, Any] | None:
        r = self._http.post("/api/v1/ingestion/staged/items/claim-fetch")
        if r.status_code == 204:
            return None
        r.raise_for_status()
        return r.json()

    def patch_item(self, item_id: int, payload: dict[str, Any]) -> None:
        r = self._http.patch(f"/api/v1/ingestion/staged/items/{item_id}/status", json=payload)
        r.raise_for_status()

    def register_documents(self, documents: list[dict[str, Any]]) -> None:
        r = self._http.post("/api/v1/ingestion/staged/documents/register", json={"documents": documents})
        r.raise_for_status()

    def claim_normalize(self, limit: int = 8) -> list[dict[str, Any]] | None:
        r = self._http.post(
            "/api/v1/ingestion/staged/documents/claim-normalize",
            params={"limit": limit},
        )
        if r.status_code == 204:
            return None
        r.raise_for_status()
        data = r.json()
        return list(data.get("documents") or [])

    def patch_normalize_result(self, document_id: int, payload: dict[str, Any]) -> None:
        r = self._http.patch(f"/api/v1/ingestion/staged/documents/{document_id}/normalize-result", json=payload)
        r.raise_for_status()

    def claim_enrich(self, limit: int = 8, worker_id: str = "worker") -> list[dict[str, Any]] | None:
        r = self._http.post(
            "/api/v1/ingestion/staged/enrich/claim",
            json={"limit": limit, "worker_id": worker_id},
        )
        if r.status_code == 204:
            return None
        r.raise_for_status()
        data = r.json()
        return list(data.get("jobs") or [])

    def patch_enrich_job(self, job_id: int, payload: dict[str, Any]) -> None:
        r = self._http.patch(f"/api/v1/ingestion/staged/enrich/{job_id}/status", json=payload)
        r.raise_for_status()

    def report_schema_version(self, schema_version: int, collection: str = "synesis_catalog") -> dict[str, Any]:
        r = self._http.post(
            "/api/v1/ingestion/schema-sync",
            json={
                "collection": collection,
                "schema_version": schema_version,
                "reporter": "indexer-staged-enrich",
            },
        )
        r.raise_for_status()
        return r.json()
