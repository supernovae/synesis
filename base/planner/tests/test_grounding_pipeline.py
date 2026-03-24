"""Tests for grounding config knobs and schema version alignment."""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_settings(**overrides):
    env = {
        "SYNESIS_SUPERVISOR_MODEL_URL": "http://localhost:8081/v1",
        "SYNESIS_EXECUTOR_MODEL_URL": "http://localhost:8080/v1",
        "SYNESIS_RAG_RERANKER": "none",
        "SYNESIS_RAG_RETRIEVAL_STRATEGY": "hybrid",
        "SYNESIS_LSP_MODE": "on_failure",
        "SYNESIS_LOG_LEVEL": "info",
    }
    env.update(overrides)
    with patch.dict(os.environ, env, clear=False):
        from app.config import Settings

        return Settings()


# ---------------------------------------------------------------------------
# Config knobs
# ---------------------------------------------------------------------------


class TestGroundingConfig:
    """Verify grounding config settings exist and have expected defaults."""

    def test_critic_rag_defaults(self):
        s = _make_settings()
        assert s.critic_rag_context_enabled is True
        assert s.critic_rag_context_budget == 4000

    def test_planner_chunk_scaling_defaults(self):
        s = _make_settings()
        assert s.planner_rag_base_chunks == 5
        assert s.planner_rag_max_chunks == 10

    def test_env_override(self):
        s = _make_settings(SYNESIS_PLANNER_RAG_BASE_CHUNKS="3", SYNESIS_PLANNER_RAG_MAX_CHUNKS="15")
        assert s.planner_rag_base_chunks == 3
        assert s.planner_rag_max_chunks == 15


# ---------------------------------------------------------------------------
# Schema version (indexer module — tested via importlib with sys.path)
# ---------------------------------------------------------------------------


_pymilvus_available = False
try:
    import pymilvus  # noqa: F401

    _pymilvus_available = True
except ImportError:
    pass


@pytest.mark.skipif(not _pymilvus_available, reason="pymilvus not installed")
class TestSchemaVersion:
    """Verify schema version and field set match current architecture."""

    @pytest.fixture(autouse=True)
    def _import_schema(self):
        import importlib.util

        schema_path = os.path.abspath(
            os.path.join(
                os.path.dirname(__file__),
                "..",
                "..",
                "rag",
                "indexer",
                "app",
                "schema.py",
            )
        )
        spec = importlib.util.spec_from_file_location("indexer_schema", schema_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.schema_mod = mod
        yield

    def test_intended_roles_removed(self):
        assert "intended_roles" not in self.schema_mod.EXPECTED_FIELDS

    def test_catalog_entity_has_no_intended_roles(self):
        entity = self.schema_mod.catalog_entity(
            chunk_id="test-001",
            text="Sample text",
            embedding=[0.1] * 768,
        )
        assert "intended_roles" not in entity

    def test_schema_version_is_current(self):
        assert self.schema_mod.SCHEMA_VERSION == 11
