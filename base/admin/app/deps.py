"""Shared dependencies: NornicDB client, httpx pool, Postgres, config constants."""

from __future__ import annotations

import os
from functools import lru_cache

import httpx

NORNIC_URI = os.getenv("SYNESIS_NORNIC_URI", "bolt://synesis-nornicdb.synesis-rag.svc.cluster.local:7687")
NORNIC_USER = os.getenv("SYNESIS_NORNIC_USER", "neo4j")
NORNIC_PASSWORD = os.getenv("SYNESIS_NORNIC_PASSWORD", "synesis-nornicdb")
NORNIC_DATABASE = os.getenv("SYNESIS_NORNIC_DATABASE", "neo4j")
PLANNER_URL = os.getenv(
    "SYNESIS_PLANNER_URL",
    "http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080",
)
PLANNER_TS_URL = os.getenv(
    "SYNESIS_PLANNER_TS_URL",
    "http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080",
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
    "http://synesis-mcp-ts.synesis-yarn.svc.cluster.local:8100",
)
ADMIN_MCP_URL = os.getenv(
    "SYNESIS_ADMIN_MCP_URL",
    "http://synesis-admin-mcp-ts.synesis-admin.svc.cluster.local:8102",
)
DATABASE_URL = os.getenv(
    "SYNESIS_ADMIN_DATABASE_URL",
    "postgresql+asyncpg://app:changeme@synesis-admin-db-rw.synesis-admin.svc:5432/synesis_admin",
)
QUALITY_REPORT_PATH = os.getenv("SYNESIS_QUALITY_REPORT_PATH", "")
CURATOR_PROPOSALS_PATH = os.getenv("SYNESIS_CURATOR_PROPOSALS_PATH", "")
TAXONOMY_YAML_PATH = os.getenv(
    "SYNESIS_TAXONOMY_YAML_PATH",
    "/etc/synesis/taxonomy_prompt_config.yaml",
)

FAILURES_COLLECTION = "failures_v1"
CATALOG_COLLECTION = "content_graph"

_nornic_driver = None


def get_nornic_driver():
    global _nornic_driver
    if _nornic_driver is None:
        from neo4j import GraphDatabase

        _nornic_driver = GraphDatabase.driver(NORNIC_URI, auth=(NORNIC_USER, NORNIC_PASSWORD))
    return _nornic_driver


@lru_cache
def get_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=10.0)
