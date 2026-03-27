"""Shared dependencies: Milvus client, httpx pool, Postgres, config constants."""

from __future__ import annotations

import os
from functools import lru_cache

import httpx

MILVUS_HOST = os.getenv(
    "SYNESIS_MILVUS_HOST",
    "synesis-milvus.synesis-rag.svc.cluster.local",
)
MILVUS_PORT = int(os.getenv("SYNESIS_MILVUS_PORT", "19530"))
PLANNER_URL = os.getenv(
    "SYNESIS_PLANNER_URL",
    "http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080",
)
PLANNER_TS_URL = os.getenv(
    "SYNESIS_PLANNER_TS_URL",
    "http://synesis-planner.synesis-planner.svc.cluster.local:8080",
)
YARN_TS_URL = os.getenv(
    "SYNESIS_YARN_TS_URL",
    "http://synesis-yarn.synesis-yarn.svc.cluster.local:8000",
)
INTERNAL_SERVICE_TOKEN = os.getenv("SYNESIS_INTERNAL_SERVICE_TOKEN", "")
# Optional: sync evaluation feedback from Open WebUI (admin export API).
OPENWEBUI_URL = os.getenv("SYNESIS_OPENWEBUI_URL", "").strip()
OPENWEBUI_ADMIN_TOKEN = os.getenv("SYNESIS_OPENWEBUI_ADMIN_TOKEN", "").strip()
LITELLM_URL = os.getenv(
    "SYNESIS_LITELLM_URL",
    "http://litellm-proxy.synesis-gateway.svc.cluster.local:4000",
)
LITELLM_MASTER_KEY = os.getenv("SYNESIS_LITELLM_MASTER_KEY", "")
ASSISTANT_MODEL = os.getenv("SYNESIS_ADMIN_ASSISTANT_MODEL", "synesis-general")
MCP_URL = os.getenv(
    "SYNESIS_MCP_URL",
    "http://synesis-mcp.synesis-planner.svc.cluster.local:8100",
)
DATABASE_URL = os.getenv(
    "SYNESIS_ADMIN_DATABASE_URL",
    "postgresql+asyncpg://app:changeme@synesis-admin-db-rw.synesis-admin.svc:5432/synesis_admin",
)
QUALITY_REPORT_PATH = os.getenv("SYNESIS_QUALITY_REPORT_PATH", "")
CURATOR_PROPOSALS_PATH = os.getenv("SYNESIS_CURATOR_PROPOSALS_PATH", "")
MODELS_YAML_PATH = os.getenv(
    "SYNESIS_MODELS_YAML_PATH",
    "/etc/synesis/models.yaml",
)
TAXONOMY_YAML_PATH = os.getenv(
    "SYNESIS_TAXONOMY_YAML_PATH",
    "/etc/synesis/taxonomy_prompt_config.yaml",
)

FAILURES_COLLECTION = "failures_v1"
CATALOG_COLLECTION = "synesis_catalog"

_resilient_milvus = None


def _get_resilient():
    global _resilient_milvus
    if _resilient_milvus is None:
        from .milvus_utils import ResilientMilvusClient

        _resilient_milvus = ResilientMilvusClient(
            uri=f"http://{MILVUS_HOST}:{MILVUS_PORT}",
        )
    return _resilient_milvus


def get_milvus():
    return _get_resilient().get()


def get_resilient_milvus():
    """Return the ResilientMilvusClient for callers that need retry semantics."""
    return _get_resilient()


@lru_cache
def get_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=10.0)
