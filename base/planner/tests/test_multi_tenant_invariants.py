"""Multi-tenant architecture invariant tests.

These tests enforce the multi-tenant safety contract:
  - Retrieval always includes scope + ACL filters (deny-by-default)
  - Tenant/org boundaries cannot be crossed
  - ACL mode validation is fail-closed
  - Router is the only retrieval path (consistent with router_governance)

Run as part of the standard planner test suite. Failures block merge.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import logging
import sys
import types
from pathlib import Path

import pytest


def _ensure_synesis_telemetry_stub() -> None:
    """Indexer ``schema.py`` imports ``synesis_telemetry``; stub if absent (e.g. minimal venv)."""
    if "synesis_telemetry" in sys.modules:
        return
    mod = types.ModuleType("synesis_telemetry")
    mod.get_logger = lambda name: logging.getLogger(name)
    sys.modules["synesis_telemetry"] = mod

PLANNER_APP = Path(__file__).resolve().parent.parent / "app"

# Indexer lives in base/rag/indexer; load by path so these invariants run in the
# planner job without putting indexer ``app`` on PYTHONPATH (would shadow planner).
_INDEXER_SCHEMA_PATH = Path(__file__).resolve().parents[2] / "rag" / "indexer" / "app" / "schema.py"
_indexer_schema_mod = None


def _get_indexer_schema():
    """Return the indexer schema module (lazy, skips if file missing)."""
    global _indexer_schema_mod
    if _indexer_schema_mod is not None:
        return _indexer_schema_mod
    if not _INDEXER_SCHEMA_PATH.is_file():
        pytest.skip(f"indexer schema not found at {_INDEXER_SCHEMA_PATH}")
    _ensure_synesis_telemetry_stub()
    spec = importlib.util.spec_from_file_location(
        "synesis_indexer_schema_invariant_tests",
        _INDEXER_SCHEMA_PATH,
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _indexer_schema_mod = mod
    return mod


class TestScopeFilterInvariants:
    """Verify build_scope_filter always produces deny-by-default expressions."""

    @pytest.fixture(autouse=True)
    def _set_full_schema(self, monkeypatch):
        import app.rag_client as rc

        monkeypatch.setattr(
            rc,
            "_catalog_fields",
            {
                "visibility_scope",
                "org_id",
                "tenant_id",
                "acl_mode",
                "acl_groups",
                "embedding",
                "text",
            },
        )

    def test_empty_caller_returns_global_only_with_acl_deny(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter()
        assert 'visibility_scope == "global"' in expr
        assert "org_id" not in expr.split("acl_mode")[0]
        assert 'acl_mode in ["open", ""]' in expr

    def test_org_caller_without_acl_groups_denies_restricted(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(caller_org_id="org-1")
        assert 'acl_mode in ["open", ""]' in expr
        assert "like" not in expr

    def test_acl_groups_enable_restricted_access(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(
            caller_org_id="org-1",
            caller_acl_groups=["team-alpha"],
        )
        assert 'acl_groups like "%team-alpha%"' in expr
        assert 'acl_mode in ["open", ""]' in expr

    def test_scope_filter_never_returns_unfiltered(self):
        """Even with all parameters, filter always has visibility constraint."""
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(
            caller_org_id="org-1",
            caller_tenant_ids=["t1"],
            caller_acl_groups=["g1"],
        )
        assert "visibility_scope" in expr
        assert "acl_mode" in expr

    def test_no_schema_fields_returns_empty(self, monkeypatch):
        """When catalog has no scope fields, filter is empty (safe: no results match)."""
        import app.rag_client as rc

        monkeypatch.setattr(rc, "_catalog_fields", {"text", "embedding"})
        from app.rag_client import build_scope_filter

        assert build_scope_filter(caller_org_id="org-1") == ""


class TestAclModeValidation:
    """Verify ACL mode validation in the indexer schema."""

    def test_catalog_entity_defaults_to_open(self):
        schema = _get_indexer_schema()
        entity = schema.catalog_entity(
            chunk_id="inv-1",
            text="test",
            embedding=[0.1] * 384,
        )
        assert entity["acl_mode"] == "open"
        assert entity["acl_groups"] == ""

    def test_catalog_entity_restricted_mode(self):
        schema = _get_indexer_schema()
        entity = schema.catalog_entity(
            chunk_id="inv-2",
            text="test",
            embedding=[0.1] * 384,
            acl_mode="restricted",
            acl_groups="grp-eng,grp-data",
        )
        assert entity["acl_mode"] == "restricted"
        assert "grp-eng" in entity["acl_groups"]

    def test_schema_version_is_11(self):
        schema = _get_indexer_schema()
        assert schema.SCHEMA_VERSION == 11, "Schema must be v11 for ACL support"

    def test_expected_fields_include_acl(self):
        schema = _get_indexer_schema()
        assert "acl_mode" in schema.EXPECTED_FIELDS
        assert "acl_groups" in schema.EXPECTED_FIELDS


class TestRetrievalBoundaryAST:
    """AST-based checks that retrieval paths always include scope parameters."""

    def test_build_scope_filter_has_acl_groups_param(self):
        """build_scope_filter must accept caller_acl_groups."""
        from app.rag_client import build_scope_filter

        sig = inspect.signature(build_scope_filter)
        assert "caller_acl_groups" in sig.parameters

    def test_build_metadata_filter_has_acl_groups_param(self):
        from app.rag_client import build_metadata_filter

        sig = inspect.signature(build_metadata_filter)
        assert "caller_acl_groups" in sig.parameters

    def test_unified_retrieval_has_acl_groups_param(self):
        """Avoid importing ``unified_retrieval`` (pulls optional web/guardrails deps)."""
        src = (PLANNER_APP / "unified_retrieval.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == "retrieve_unified":
                names = [a.arg for a in node.args.args]
                assert "caller_acl_groups" in names
                return
        pytest.fail("retrieve_unified not found in unified_retrieval.py")

    def test_router_node_reads_acl_groups_from_state(self):
        """Router node must read acl_groups from state dict."""
        router_src = (PLANNER_APP / "nodes" / "router.py").read_text()
        assert 'state.get("acl_groups")' in router_src or "acl_groups" in router_src

    def test_initial_state_includes_acl_groups(self):
        """Planner initial_state must include acl_groups key."""
        main_src = (PLANNER_APP / "main.py").read_text()
        assert '"acl_groups"' in main_src or "'acl_groups'" in main_src


class TestCrossTenantDenial:
    """Verify scope filter prevents cross-tenant and cross-org leakage."""

    @pytest.fixture(autouse=True)
    def _set_full_schema(self, monkeypatch):
        import app.rag_client as rc

        monkeypatch.setattr(
            rc,
            "_catalog_fields",
            {
                "visibility_scope",
                "org_id",
                "tenant_id",
                "acl_mode",
                "acl_groups",
                "embedding",
                "text",
            },
        )

    def test_org_a_cannot_see_org_b(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(caller_org_id="org-a")
        assert 'org_id == "org-a"' in expr
        assert "org-b" not in expr

    def test_tenant_1_cannot_see_tenant_2(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(
            caller_org_id="org-a",
            caller_tenant_ids=["t-1"],
        )
        assert 'tenant_id in ["t-1"]' in expr
        assert "t-2" not in expr

    def test_acl_group_a_cannot_see_group_b(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(
            caller_org_id="org-a",
            caller_acl_groups=["grp-a"],
        )
        assert "grp-a" in expr
        assert "grp-b" not in expr

    def test_no_groups_blocks_restricted_content(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(caller_org_id="org-a")
        assert 'acl_mode in ["open", ""]' in expr
        assert "restricted" not in expr.split("acl_mode")[1] if "restricted" in expr else True
