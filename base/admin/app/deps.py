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
    "http://synesis-planner.synesis-planner.svc.cluster.local:8000",
)
LITELLM_URL = os.getenv(
    "SYNESIS_LITELLM_URL",
    "http://litellm-proxy.synesis-gateway.svc.cluster.local:4000",
)
MCP_URL = os.getenv(
    "SYNESIS_MCP_URL",
    "http://synesis-mcp.synesis-planner.svc.cluster.local:8080",
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
KNOWLEDGE_BACKLOG_COLLECTION = "synesis_knowledge_backlog"
CATALOG_COLLECTION = "synesis_catalog"

_milvus_client = None


def get_milvus():
    global _milvus_client
    if _milvus_client is None:
        from pymilvus import MilvusClient

        _milvus_client = MilvusClient(uri=f"http://{MILVUS_HOST}:{MILVUS_PORT}")
    return _milvus_client


@lru_cache
def get_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=10.0)
