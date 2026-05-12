"""Backstage / Red Hat Developer Hub Catalog REST API client.

Wraps the standard Backstage Catalog backend API:
  https://backstage.io/docs/features/software-catalog/software-catalog-api

Compatible with upstream Backstage *and* Red Hat Developer Hub (RHDH).
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from .outbound_security import validate_public_https_url

logger = logging.getLogger("synesis.admin.catalog_client")

DEFAULT_TIMEOUT_S = 10
DEFAULT_RETRIES = 2
_ENV_REF_RE = re.compile(r"^[A-Z_][A-Z0-9_]{0,255}$")


class CatalogClientError(Exception):
    """Raised when the Backstage Catalog API returns an error."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class EntityMetadata:
    name: str = ""
    namespace: str = "default"
    title: str | None = None
    description: str | None = None
    annotations: dict[str, str] = field(default_factory=dict)
    labels: dict[str, str] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    uid: str | None = None


@dataclass
class CatalogEntity:
    kind: str = ""
    metadata: EntityMetadata = field(default_factory=EntityMetadata)
    spec: dict[str, Any] = field(default_factory=dict)
    relations: list[dict[str, Any]] = field(default_factory=list)
    api_version: str = "backstage.io/v1alpha1"

    @property
    def entity_ref(self) -> str:
        ns = self.metadata.namespace or "default"
        return f"{self.kind.lower()}:{ns}/{self.metadata.name}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "apiVersion": self.api_version,
            "metadata": {
                "name": self.metadata.name,
                "namespace": self.metadata.namespace,
                "title": self.metadata.title,
                "description": self.metadata.description,
                "annotations": self.metadata.annotations,
                "labels": self.metadata.labels,
                "tags": self.metadata.tags,
                "uid": self.metadata.uid,
            },
            "spec": self.spec,
            "relations": self.relations,
        }


def _parse_entity(raw: dict[str, Any]) -> CatalogEntity:
    meta_raw = raw.get("metadata") or {}
    meta = EntityMetadata(
        name=meta_raw.get("name", ""),
        namespace=meta_raw.get("namespace", "default"),
        title=meta_raw.get("title"),
        description=meta_raw.get("description"),
        annotations=meta_raw.get("annotations") or {},
        labels=meta_raw.get("labels") or {},
        tags=meta_raw.get("tags") or [],
        uid=meta_raw.get("uid"),
    )
    return CatalogEntity(
        kind=raw.get("kind", ""),
        metadata=meta,
        spec=raw.get("spec") or {},
        relations=raw.get("relations") or [],
        api_version=raw.get("apiVersion", "backstage.io/v1alpha1"),
    )


def _resolve_token(auth_type: str, auth_token_ref: str) -> str | None:
    """Resolve an auth token from environment or reference."""
    if auth_type == "none" or not auth_token_ref:
        return None
    if auth_type == "bearer":
        if not _ENV_REF_RE.fullmatch(auth_token_ref):
            raise CatalogClientError("Bearer auth_token_ref must be an environment variable name")
        token = os.environ.get(auth_token_ref, "")
        if not token:
            raise CatalogClientError("Bearer auth token environment variable is not configured")
        return token
    return None


class CatalogClient:
    """Async HTTP client for the Backstage Catalog REST API."""

    def __init__(
        self,
        base_url: str,
        auth_type: str = "none",
        auth_token_ref: str = "",
        timeout_s: float = DEFAULT_TIMEOUT_S,
        retries: int = DEFAULT_RETRIES,
    ):
        self._base_url = validate_public_https_url(base_url, field_name="base_url")
        self._timeout_s = timeout_s
        self._retries = retries

        headers: dict[str, str] = {"Accept": "application/json"}
        token = _resolve_token(auth_type, auth_token_ref)
        if token and auth_type == "bearer":
            headers["Authorization"] = f"Bearer {token}"

        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers=headers,
            timeout=httpx.Timeout(timeout_s),
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        last_err: Exception | None = None
        for attempt in range(self._retries + 1):
            try:
                resp = await self._client.request(method, path, **kwargs)
                if resp.status_code >= 400:
                    logger.warning(
                        "catalog_http_error method=%s path=%s status=%s response_snippet=%s",
                        method,
                        path,
                        resp.status_code,
                        resp.text[:500],
                    )
                    raise CatalogClientError(
                        f"Catalog API returned {resp.status_code}",
                        status_code=resp.status_code,
                    )
                return resp.json()
            except CatalogClientError:
                raise
            except httpx.TimeoutException as exc:
                last_err = exc
                logger.warning("catalog_request_timeout attempt=%d path=%s", attempt + 1, path)
            except httpx.HTTPError as exc:
                last_err = exc
                logger.warning("catalog_request_error attempt=%d path=%s error=%s", attempt + 1, path, exc)

        logger.warning("catalog_request_failed attempts=%d error=%s", self._retries + 1, last_err)
        raise CatalogClientError("Catalog API request failed after retries", status_code=None)

    async def list_entities(
        self,
        kinds: list[str] | None = None,
        namespace: str | None = None,
    ) -> list[CatalogEntity]:
        """Fetch entities from the catalog, optionally filtered by kind and namespace."""
        params: list[tuple[str, str]] = []
        if kinds:
            for k in kinds:
                params.append(("filter", f"kind={k}"))
        if namespace:
            params.append(("filter", f"metadata.namespace={namespace}"))

        data = await self._request("GET", "/api/catalog/entities", params=params)
        if not isinstance(data, list):
            data = data.get("items", data) if isinstance(data, dict) else []
        return [_parse_entity(item) for item in data]

    async def get_entity_by_ref(
        self,
        kind: str,
        namespace: str,
        name: str,
    ) -> CatalogEntity:
        """Fetch a single entity by its kind/namespace/name reference."""
        path = f"/api/catalog/entities/by-name/{kind}/{namespace}/{name}"
        data = await self._request("GET", path)
        return _parse_entity(data)

    async def health_check(self) -> dict[str, Any]:
        """Quick connectivity check — fetch one entity to verify access."""
        try:
            params = [("filter", "kind=Component"), ("limit", "1")]
            data = await self._request("GET", "/api/catalog/entities", params=params)
            count = len(data) if isinstance(data, list) else 0
            return {"reachable": True, "sample_count": count, "base_url": self._base_url}
        except CatalogClientError as exc:
            return {
                "reachable": False,
                "error": str(exc),
                "status_code": exc.status_code,
                "base_url": self._base_url,
            }
