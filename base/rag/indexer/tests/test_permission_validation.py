"""RAG permission validation tests for the indexer pipeline.

Validates that:
  1. Scope field validation rejects invalid combinations at ingest time
  2. ACL mode validation enforces group requirements
  3. catalog_entity properly propagates ACL and scope fields
  4. Queue runner scope propagation respects effective_* overrides
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "base" / "images" / "base-api" / "synesis-telemetry"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Mock handler discovery to avoid importing all handler plugins (which need
# the full indexer dependency tree: yaml, defusedxml, pymupdf, etc.).
from unittest.mock import patch

from app.schema import EMBEDDING_DIM, catalog_entity

_mock_handler = MagicMock()
_mock_handler.source_type = "docs"

with patch.dict("sys.modules", {}):
    pass

import app.handlers as _handlers_mod

if not hasattr(_handlers_mod, "_REGISTRY") or not _handlers_mod._REGISTRY:
    _handlers_mod._REGISTRY = {"html_document": _mock_handler}
    _handlers_mod._discovered = True

from app.pipeline import index_parsed_chunk_pairs
from app.queue_runner import _build_source_config

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_source_config(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "name": "test-source",
        "handler": "html_document",
        "authority": "vetted",
        "origin_type": "curated",
        "domain": "generalist",
        "config": {},
        "visibility_scope": "global",
        "org_id": "",
        "tenant_id": "",
        "acl_mode": "open",
        "acl_groups": "",
        "owner_user_id": "",
        "conversation_id": "",
    }
    base.update(overrides)
    return base


def _dummy_embedding() -> list[float]:
    return [0.0] * EMBEDDING_DIM


def _call_pipeline(cfg: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    writer = MagicMock()
    embedder = MagicMock()
    progress = MagicMock()
    progress.log_error = MagicMock()
    count, meta = index_parsed_chunk_pairs(cfg, [], {}, writer, embedder, progress, set())
    return count, {"progress": progress, "meta": meta}


# ---------------------------------------------------------------------------
# Scope field validation matrix
# ---------------------------------------------------------------------------


class TestScopeFieldValidation:
    """Every (visibility_scope, missing_field) combination must be rejected."""

    def test_global_scope_requires_nothing(self):
        count, ctx = _call_pipeline(_make_source_config(visibility_scope="global"))
        ctx["progress"].log_error.assert_not_called()

    def test_org_scope_without_org_id_rejected(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="org",
                org_id="",
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()
        assert "org_id" in str(ctx["progress"].log_error.call_args)

    def test_org_scope_with_org_id_accepted(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="org",
                org_id="acme",
            )
        )
        ctx["progress"].log_error.assert_not_called()

    def test_tenant_scope_without_org_id_rejected(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="tenant",
                org_id="",
                tenant_id="t1",
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()
        assert "org_id" in str(ctx["progress"].log_error.call_args)

    def test_tenant_scope_without_tenant_id_rejected(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="tenant",
                org_id="acme",
                tenant_id="",
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()
        assert "tenant_id" in str(ctx["progress"].log_error.call_args)

    def test_tenant_scope_with_all_fields_accepted(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="tenant",
                org_id="acme",
                tenant_id="team-1",
            )
        )
        ctx["progress"].log_error.assert_not_called()

    def test_user_scope_without_org_id_rejected(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="user",
                org_id="",
                owner_user_id="alice",
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()
        assert "org_id" in str(ctx["progress"].log_error.call_args)

    def test_user_scope_without_owner_user_id_rejected(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="user",
                org_id="acme",
                owner_user_id="",
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()
        assert "owner_user_id" in str(ctx["progress"].log_error.call_args)

    def test_user_scope_with_all_fields_accepted(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="user",
                org_id="acme",
                owner_user_id="alice",
            )
        )
        ctx["progress"].log_error.assert_not_called()

    def test_session_scope_without_org_id_rejected(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="session",
                org_id="",
                owner_user_id="alice",
                conversation_id="conv-1",
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()

    def test_session_scope_without_owner_user_id_rejected(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="session",
                org_id="acme",
                owner_user_id="",
                conversation_id="conv-1",
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()
        assert "owner_user_id" in str(ctx["progress"].log_error.call_args)

    def test_session_scope_without_conversation_id_rejected(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="session",
                org_id="acme",
                owner_user_id="alice",
                conversation_id="",
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()
        assert "conversation_id" in str(ctx["progress"].log_error.call_args)

    def test_session_scope_with_all_fields_accepted(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope="session",
                org_id="acme",
                owner_user_id="alice",
                conversation_id="conv-1",
            )
        )
        ctx["progress"].log_error.assert_not_called()

    @pytest.mark.parametrize("invalid_scope", ["admin", "public", "superuser", "root", "system"])
    def test_invalid_scope_values_rejected(self, invalid_scope: str):
        count, ctx = _call_pipeline(
            _make_source_config(
                visibility_scope=invalid_scope,
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()


# ---------------------------------------------------------------------------
# ACL validation
# ---------------------------------------------------------------------------


class TestAclValidation:
    """ACL mode enforcement at ingest time."""

    def test_open_acl_without_groups_accepted(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                acl_mode="open",
                acl_groups="",
            )
        )
        ctx["progress"].log_error.assert_not_called()

    def test_empty_acl_without_groups_accepted(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                acl_mode="",
                acl_groups="",
            )
        )
        ctx["progress"].log_error.assert_not_called()

    def test_restricted_acl_without_groups_rejected(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                acl_mode="restricted",
                acl_groups="",
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()
        assert "acl_groups" in str(ctx["progress"].log_error.call_args)

    def test_private_acl_without_groups_rejected(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                acl_mode="private",
                acl_groups="",
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()
        assert "acl_groups" in str(ctx["progress"].log_error.call_args)

    def test_restricted_acl_with_groups_accepted(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                acl_mode="restricted",
                acl_groups="team-alpha",
            )
        )
        ctx["progress"].log_error.assert_not_called()

    def test_private_acl_with_groups_accepted(self):
        count, ctx = _call_pipeline(
            _make_source_config(
                acl_mode="private",
                acl_groups="team-alpha",
            )
        )
        ctx["progress"].log_error.assert_not_called()

    @pytest.mark.parametrize("invalid_acl", ["read-only", "admin", "public", "inherit"])
    def test_invalid_acl_mode_rejected(self, invalid_acl: str):
        count, ctx = _call_pipeline(
            _make_source_config(
                acl_mode=invalid_acl,
            )
        )
        assert count == 0
        ctx["progress"].log_error.assert_called_once()


# ---------------------------------------------------------------------------
# catalog_entity ACL field propagation
# ---------------------------------------------------------------------------


class TestCatalogEntityAclPropagation:
    """catalog_entity must correctly parse, deduplicate, and propagate ACL fields."""

    def test_acl_group_ids_parsed_from_csv(self):
        entity = catalog_entity(
            chunk_id="c1",
            text="test",
            embedding=_dummy_embedding(),
            acl_mode="restricted",
            acl_groups="team-alpha, team-beta, team-gamma",
        )
        assert entity["acl_group_ids"] == ["team-alpha", "team-beta", "team-gamma"]

    def test_acl_group_ids_deduplicates(self):
        entity = catalog_entity(
            chunk_id="c2",
            text="test",
            embedding=_dummy_embedding(),
            acl_mode="restricted",
            acl_groups="eng, eng, ops, eng",
        )
        assert entity["acl_group_ids"] == ["eng", "ops"]

    def test_acl_group_ids_trims_whitespace(self):
        entity = catalog_entity(
            chunk_id="c3",
            text="test",
            embedding=_dummy_embedding(),
            acl_mode="restricted",
            acl_groups="  team-a ,  team-b  , team-c  ",
        )
        assert entity["acl_group_ids"] == ["team-a", "team-b", "team-c"]

    def test_empty_acl_groups_yields_empty_ids(self):
        entity = catalog_entity(
            chunk_id="c4",
            text="test",
            embedding=_dummy_embedding(),
            acl_groups="",
        )
        assert entity["acl_group_ids"] == []

    def test_authz_object_id_defaults_to_rag_doc_doc_id(self):
        entity = catalog_entity(
            chunk_id="chunk-1",
            doc_id="doc-42",
            text="test",
            embedding=_dummy_embedding(),
        )
        assert entity["authz_object_id"] == "rag_doc:doc-42"

    def test_authz_object_id_defaults_to_rag_doc_chunk_id_when_no_doc_id(self):
        entity = catalog_entity(
            chunk_id="chunk-99",
            text="test",
            embedding=_dummy_embedding(),
        )
        assert entity["authz_object_id"] == "rag_doc:chunk-99"

    def test_authz_object_id_passes_through_when_explicit(self):
        entity = catalog_entity(
            chunk_id="c1",
            doc_id="doc-1",
            text="test",
            embedding=_dummy_embedding(),
            authz_object_id="custom_type:custom-id",
        )
        assert entity["authz_object_id"] == "custom_type:custom-id"

    def test_acl_mode_defaults_to_open(self):
        entity = catalog_entity(
            chunk_id="c5",
            text="test",
            embedding=_dummy_embedding(),
        )
        assert entity["acl_mode"] == "open"

    def test_visibility_scope_defaults_to_global(self):
        entity = catalog_entity(
            chunk_id="c6",
            text="test",
            embedding=_dummy_embedding(),
        )
        assert entity["visibility_scope"] == "global"

    def test_scope_fields_propagated_correctly(self):
        entity = catalog_entity(
            chunk_id="c7",
            text="test",
            embedding=_dummy_embedding(),
            visibility_scope="tenant",
            org_id="acme",
            tenant_id="team-eng",
            owner_user_id="alice",
            conversation_id="conv-1",
            is_ephemeral=True,
            expires_at_epoch=9999999999,
        )
        assert entity["visibility_scope"] == "tenant"
        assert entity["org_id"] == "acme"
        assert entity["tenant_id"] == "team-eng"
        assert entity["owner_user_id"] == "alice"
        assert entity["conversation_id"] == "conv-1"
        assert entity["is_ephemeral"] is True
        assert entity["expires_at_epoch"] == 9999999999

    def test_scope_field_truncation(self):
        entity = catalog_entity(
            chunk_id="c8",
            text="test",
            embedding=_dummy_embedding(),
            visibility_scope="x" * 100,
            org_id="o" * 200,
            tenant_id="t" * 200,
            owner_user_id="u" * 200,
        )
        assert len(entity["visibility_scope"]) <= 16
        assert len(entity["org_id"].encode("utf-8")) <= 64
        assert len(entity["tenant_id"].encode("utf-8")) <= 64
        assert len(entity["owner_user_id"].encode("utf-8")) <= 64


# ---------------------------------------------------------------------------
# Queue runner scope propagation
# ---------------------------------------------------------------------------


class TestQueueRunnerScopePropagation:
    """_build_source_config must propagate effective_* scope fields."""

    def test_effective_scope_overrides_default(self):
        item = {
            "uri": "https://example.com",
            "effective_visibility_scope": "org",
            "effective_org_id": "acme",
            "effective_tenant_id": "",
        }
        cfg = _build_source_config(item)
        assert cfg["visibility_scope"] == "org"
        assert cfg["org_id"] == "acme"
        assert cfg["tenant_id"] == ""

    def test_defaults_to_global_when_no_scope(self):
        item = {"uri": "https://example.com"}
        cfg = _build_source_config(item)
        assert cfg["visibility_scope"] == "global"
        assert cfg["org_id"] == ""
        assert cfg["tenant_id"] == ""
        assert cfg["acl_mode"] == "open"
        assert cfg["acl_groups"] == ""

    def test_fallback_from_item_direct_fields(self):
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

    def test_effective_fields_take_precedence(self):
        item = {
            "uri": "https://example.com",
            "visibility_scope": "global",
            "org_id": "old-org",
            "effective_visibility_scope": "org",
            "effective_org_id": "new-org",
        }
        cfg = _build_source_config(item)
        assert cfg["visibility_scope"] == "org"
        assert cfg["org_id"] == "new-org"

    def test_acl_mode_propagation(self):
        item = {
            "uri": "https://example.com",
            "effective_acl_mode": "restricted",
            "effective_acl_groups": "team-alpha,team-beta",
        }
        cfg = _build_source_config(item)
        assert cfg["acl_mode"] == "restricted"
        assert cfg["acl_groups"] == "team-alpha,team-beta"

    def test_user_scope_propagation(self):
        item = {
            "uri": "https://example.com",
            "effective_visibility_scope": "user",
            "effective_org_id": "acme",
            "effective_owner_user_id": "alice",
        }
        cfg = _build_source_config(item)
        assert cfg["visibility_scope"] == "user"
        assert cfg["org_id"] == "acme"
        assert cfg["owner_user_id"] == "alice"

    def test_session_scope_propagation(self):
        item = {
            "uri": "https://example.com",
            "effective_visibility_scope": "session",
            "effective_org_id": "acme",
            "effective_owner_user_id": "alice",
            "effective_conversation_id": "conv-42",
            "effective_is_ephemeral": True,
            "effective_expires_at_epoch": 1700000000,
        }
        cfg = _build_source_config(item)
        assert cfg["visibility_scope"] == "session"
        assert cfg["org_id"] == "acme"
        assert cfg["owner_user_id"] == "alice"
        assert cfg["conversation_id"] == "conv-42"
        assert cfg["is_ephemeral"] is True
        assert cfg["expires_at_epoch"] == 1700000000

    def test_pack_fields_propagation(self):
        item = {
            "uri": "https://example.com",
            "effective_pack_id": "my-pack",
            "effective_pack_version": "v2.1",
            "effective_pack_partition": "shard-1",
        }
        cfg = _build_source_config(item)
        assert cfg["pack_id"] == "my-pack"
        assert cfg["pack_version"] == "v2.1"
        assert cfg["pack_partition"] == "shard-1"


# ---------------------------------------------------------------------------
# Combined: ingest-time validation prevents bad scope from reaching storage
# ---------------------------------------------------------------------------


class TestIngestScopeGatekeeper:
    """End-to-end: invalid scope combos must be rejected before any write."""

    @pytest.mark.parametrize(
        "scope,overrides",
        [
            ("org", {"org_id": ""}),
            ("tenant", {"org_id": "acme", "tenant_id": ""}),
            ("tenant", {"org_id": "", "tenant_id": "t1"}),
            ("user", {"org_id": "", "owner_user_id": "alice"}),
            ("user", {"org_id": "acme", "owner_user_id": ""}),
            ("session", {"org_id": "acme", "owner_user_id": "alice", "conversation_id": ""}),
            ("session", {"org_id": "acme", "owner_user_id": "", "conversation_id": "c1"}),
            ("session", {"org_id": "", "owner_user_id": "alice", "conversation_id": "c1"}),
        ],
    )
    def test_scope_missing_required_field_rejected(self, scope: str, overrides: dict[str, str]):
        cfg = _make_source_config(visibility_scope=scope, **overrides)
        count, ctx = _call_pipeline(cfg)
        assert count == 0, f"Expected rejection for scope={scope} with {overrides}"
        ctx["progress"].log_error.assert_called_once()

    @pytest.mark.parametrize(
        "scope,overrides",
        [
            ("global", {}),
            ("org", {"org_id": "acme"}),
            ("tenant", {"org_id": "acme", "tenant_id": "t1"}),
            ("user", {"org_id": "acme", "owner_user_id": "alice"}),
            ("session", {"org_id": "acme", "owner_user_id": "alice", "conversation_id": "c1"}),
        ],
    )
    def test_scope_with_required_fields_accepted(self, scope: str, overrides: dict[str, str]):
        cfg = _make_source_config(visibility_scope=scope, **overrides)
        count, ctx = _call_pipeline(cfg)
        ctx["progress"].log_error.assert_not_called()

    @pytest.mark.parametrize(
        "acl_mode,acl_groups,should_reject",
        [
            ("open", "", False),
            ("", "", False),
            ("restricted", "team-a", False),
            ("private", "team-a", False),
            ("restricted", "", True),
            ("private", "", True),
            ("bogus", "", True),
        ],
    )
    def test_acl_mode_validation(self, acl_mode: str, acl_groups: str, should_reject: bool):
        cfg = _make_source_config(acl_mode=acl_mode, acl_groups=acl_groups)
        count, ctx = _call_pipeline(cfg)
        if should_reject:
            assert count == 0
            ctx["progress"].log_error.assert_called_once()
        else:
            ctx["progress"].log_error.assert_not_called()
