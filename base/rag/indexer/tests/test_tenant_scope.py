"""Tenant scope enforcement tests for the indexer pipeline.

Validates that:
  1. catalog_entity includes visibility_scope, org_id, tenant_id
  2. Schema v10 has the right fields
  3. Pipeline rejects non-global chunks missing required scope fields
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "base" / "images" / "base-api" / "synesis-telemetry"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schema import EMBEDDING_DIM, EXPECTED_FIELDS, SCHEMA_VERSION, catalog_entity


class TestSchemaV19TenancyFields:
    def test_version_is_19(self):
        assert SCHEMA_VERSION == 19

    def test_expected_fields_include_scope(self):
        assert "visibility_scope" in EXPECTED_FIELDS
        assert "org_id" in EXPECTED_FIELDS
        assert "tenant_id" in EXPECTED_FIELDS
        assert "owner_user_id" in EXPECTED_FIELDS
        assert "conversation_id" in EXPECTED_FIELDS
        assert "is_ephemeral" in EXPECTED_FIELDS
        assert "expires_at_epoch" in EXPECTED_FIELDS
        assert "pack_id" in EXPECTED_FIELDS
        assert "pack_version" in EXPECTED_FIELDS
        assert "package_name" in EXPECTED_FIELDS
        assert "agent_hook" in EXPECTED_FIELDS
        assert "perf_tier" in EXPECTED_FIELDS
        assert "safety_contract" in EXPECTED_FIELDS
        assert "lifecycle_model" in EXPECTED_FIELDS
        assert "agent_enrichment_json" in EXPECTED_FIELDS
        assert "acl_group_ids" in EXPECTED_FIELDS
        assert "authz_object_id" in EXPECTED_FIELDS

    def test_catalog_entity_defaults_to_global(self):
        entity = catalog_entity(
            chunk_id="c1",
            text="test",
            embedding=[0.0] * EMBEDDING_DIM,
        )
        assert entity["pack_id"] == "global"
        assert entity["pack_partition"] == "global"
        assert entity["visibility_scope"] == "global"
        assert entity["org_id"] == ""
        assert entity["tenant_id"] == ""
        assert entity["owner_user_id"] == ""
        assert entity["conversation_id"] == ""
        assert entity["is_ephemeral"] is False
        assert entity["expires_at_epoch"] == 0
        assert entity["agent_hook"] == ""
        assert entity["perf_tier"] == ""
        assert entity["safety_contract"] == ""
        assert entity["lifecycle_model"] == ""
        assert entity["agent_enrichment_json"] == ""
        assert entity["acl_group_ids"] == []
        assert entity["authz_object_id"] == "rag_doc:c1"

    def test_catalog_entity_parses_acl_group_ids(self):
        entity = catalog_entity(
            chunk_id="c-acl",
            doc_id="doc-acl",
            text="restricted content",
            embedding=[0.0] * EMBEDDING_DIM,
            acl_mode="restricted",
            acl_groups="team-alpha, team-beta,team-alpha",
        )
        assert entity["acl_group_ids"] == ["team-alpha", "team-beta"]
        assert entity["authz_object_id"] == "rag_doc:doc-acl"

    def test_catalog_entity_org_scope(self):
        entity = catalog_entity(
            chunk_id="c2",
            text="org content",
            embedding=[0.0] * EMBEDDING_DIM,
            visibility_scope="org",
            org_id="acme",
        )
        assert entity["visibility_scope"] == "org"
        assert entity["org_id"] == "acme"

    def test_catalog_entity_tenant_scope(self):
        entity = catalog_entity(
            chunk_id="c3",
            text="tenant content",
            embedding=[0.0] * EMBEDDING_DIM,
            visibility_scope="tenant",
            org_id="acme",
            tenant_id="proj-1",
        )
        assert entity["visibility_scope"] == "tenant"
        assert entity["org_id"] == "acme"
        assert entity["tenant_id"] == "proj-1"

    def test_catalog_entity_truncates_scope_fields(self):
        entity = catalog_entity(
            chunk_id="c4",
            text="test",
            embedding=[0.0] * EMBEDDING_DIM,
            visibility_scope="x" * 100,
            org_id="o" * 200,
            tenant_id="t" * 200,
        )
        assert len(entity["visibility_scope"]) <= 16
        assert len(entity["org_id"].encode("utf-8")) <= 64
        assert len(entity["tenant_id"].encode("utf-8")) <= 64


class TestPipelineScopeValidation:
    """Test that index_parsed_chunk_pairs rejects bad scope metadata."""

    def _make_source_config(self, **overrides):
        base = {
            "name": "test-source",
            "handler": "html_document",
            "authority": "vetted",
            "origin_type": "curated",
            "domain": "generalist",
            "config": {},
            "visibility_scope": "global",
            "org_id": "",
            "tenant_id": "",
        }
        base.update(overrides)
        return base

    def test_global_scope_no_org_ok(self):
        cfg = self._make_source_config(visibility_scope="global")
        assert cfg["visibility_scope"] == "global"

    def test_org_scope_missing_org_id_rejected(self):
        from unittest.mock import MagicMock

        from app.pipeline import index_parsed_chunk_pairs

        cfg = self._make_source_config(visibility_scope="org", org_id="")
        writer = MagicMock()
        embedder = MagicMock()
        progress = MagicMock()
        progress.log_error = MagicMock()

        count, meta = index_parsed_chunk_pairs(cfg, [], {}, writer, embedder, progress, set())
        assert count == 0
        progress.log_error.assert_called_once()
        assert "org_id" in str(progress.log_error.call_args)

    def test_tenant_scope_missing_tenant_id_rejected(self):
        from unittest.mock import MagicMock

        from app.pipeline import index_parsed_chunk_pairs

        cfg = self._make_source_config(visibility_scope="tenant", org_id="acme", tenant_id="")
        writer = MagicMock()
        embedder = MagicMock()
        progress = MagicMock()
        progress.log_error = MagicMock()

        count, meta = index_parsed_chunk_pairs(cfg, [], {}, writer, embedder, progress, set())
        assert count == 0
        progress.log_error.assert_called_once()
        assert "tenant_id" in str(progress.log_error.call_args)

    def test_invalid_scope_value_rejected(self):
        from unittest.mock import MagicMock

        from app.pipeline import index_parsed_chunk_pairs

        cfg = self._make_source_config(visibility_scope="invalid")
        writer = MagicMock()
        embedder = MagicMock()
        progress = MagicMock()
        progress.log_error = MagicMock()

        count, meta = index_parsed_chunk_pairs(cfg, [], {}, writer, embedder, progress, set())
        assert count == 0
        progress.log_error.assert_called_once()


class TestQueueRunnerScopeConfig:
    """Test that _build_source_config propagates scope fields."""

    def test_scope_fields_in_source_config(self):
        from app.queue_runner import _build_source_config

        item = {
            "uri": "https://example.com",
            "handler": "html_document",
            "effective_visibility_scope": "org",
            "effective_org_id": "acme",
            "effective_tenant_id": "",
        }
        cfg = _build_source_config(item)
        assert cfg["visibility_scope"] == "org"
        assert cfg["org_id"] == "acme"
        assert cfg["tenant_id"] == ""

    def test_scope_defaults_to_global(self):
        from app.queue_runner import _build_source_config

        item = {"uri": "https://example.com"}
        cfg = _build_source_config(item)
        assert cfg["visibility_scope"] == "global"
        assert cfg["pack_id"] == "global"
        assert cfg["org_id"] == ""
        assert cfg["tenant_id"] == ""

    def test_scope_fallback_from_item(self):
        from app.queue_runner import _build_source_config

        item = {
            "uri": "https://example.com",
            "visibility_scope": "tenant",
            "org_id": "corp",
            "tenant_id": "team-a",
        }
        cfg = _build_source_config(item)
        assert cfg["visibility_scope"] == "tenant"
        assert cfg["org_id"] == "corp"
        assert cfg["tenant_id"] == "team-a"
