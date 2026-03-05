"""Shared test fixtures for Synesis planner tests.

Sets SYNESIS_ env vars to safe defaults BEFORE any app module is imported,
preventing Pydantic ValidationError during test collection.
"""

from __future__ import annotations

import os

# Minimal valid env vars so Settings() never blows up during import.
# Tests that need specific values should monkeypatch or set env themselves.
_TEST_ENV = {
    "SYNESIS_CODER_MODEL_URL": "http://localhost:9999/v1",
    "SYNESIS_SUPERVISOR_MODEL_URL": "http://localhost:9998/v1",
    "SYNESIS_MILVUS_HOST": "localhost",
    "SYNESIS_MILVUS_PORT": "19530",
    "SYNESIS_EMBEDDER_URL": "http://localhost:9997/v1",
    "SYNESIS_RAG_RERANKER": "none",
    "SYNESIS_RAG_RETRIEVAL_STRATEGY": "hybrid",
    "SYNESIS_SANDBOX_ENABLED": "false",
    "SYNESIS_FAILURE_STORE_ENABLED": "false",
    "SYNESIS_MEMORY_ENABLED": "false",
    "SYNESIS_WEB_SEARCH_ENABLED": "false",
    "SYNESIS_LSP_ENABLED": "false",
    "SYNESIS_LOG_LEVEL": "warning",
}

for k, v in _TEST_ENV.items():
    os.environ.setdefault(k, v)
