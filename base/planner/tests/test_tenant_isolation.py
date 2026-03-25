"""Multi-tenant isolation tests — three-tier visibility scope enforcement.

Validates that the scope filter builder produces correct Milvus expressions
and that non-global content cannot leak across org/tenant boundaries.

Test categories:
  1. Scope filter expression generation (unit)
  2. build_metadata_filter always includes scope (unit)
  3. Fail-closed behavior: empty org → global only
  4. Indexer scope validation (reject malformed)
"""

from __future__ import annotations

import pytest

# ---------------------------------------------------------------------------
# 1. Scope filter expression tests
# ---------------------------------------------------------------------------


class TestBuildScopeFilter:
    """Verify build_scope_filter produces correct three-tier predicates."""

    @pytest.fixture(autouse=True)
    def _set_catalog_fields(self, monkeypatch):
        """Ensure _catalog_fields includes v10 scope fields."""
        import app.rag_client as rc

        monkeypatch.setattr(
            rc,
            "_catalog_fields",
            {"visibility_scope", "org_id", "tenant_id", "embedding", "text"},
        )

    def test_no_org_returns_global_only(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(caller_org_id="", caller_tenant_ids=None)
        assert 'visibility_scope == "global"' in expr
        assert "org_id" not in expr

    def test_org_allows_global_and_org(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(caller_org_id="acme-corp")
        assert 'visibility_scope == "global"' in expr
        assert 'visibility_scope == "org"' in expr
        assert 'org_id == "acme-corp"' in expr
        assert "tenant_id" not in expr

    def test_org_and_tenants(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(
            caller_org_id="acme-corp",
            caller_tenant_ids=["project-alpha", "project-beta"],
        )
        assert 'visibility_scope == "global"' in expr
        assert 'org_id == "acme-corp"' in expr
        assert 'tenant_id in ["project-alpha","project-beta"]' in expr

    def test_sanitizes_quotes(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(caller_org_id='malicious"org')
        assert '"' not in expr.replace('"global"', "").replace('"org"', "").replace('"maliciousorg"', "")

    def test_empty_tenant_list_no_tenant_clause(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(caller_org_id="acme", caller_tenant_ids=[])
        assert "tenant_id" not in expr

    def test_scope_unavailable_returns_empty(self, monkeypatch):
        import app.rag_client as rc

        monkeypatch.setattr(rc, "_catalog_fields", {"text", "embedding"})
        from app.rag_client import build_scope_filter

        assert build_scope_filter(caller_org_id="acme") == ""


class TestAclScopeFilter:
    """Verify ACL enforcement layer in build_scope_filter."""

    @pytest.fixture(autouse=True)
    def _set_catalog_fields(self, monkeypatch):
        import app.rag_client as rc

        monkeypatch.setattr(
            rc,
            "_catalog_fields",
            {"visibility_scope", "org_id", "tenant_id", "acl_mode", "acl_groups", "embedding", "text"},
        )

    def test_no_acl_groups_denies_restricted(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(caller_org_id="acme")
        assert 'acl_mode in ["open", ""]' in expr

    def test_acl_groups_allows_matching(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(
            caller_org_id="acme",
            caller_acl_groups=["eng-team", "data-team"],
        )
        assert 'acl_groups like "%eng-team%"' in expr
        assert 'acl_groups like "%data-team%"' in expr
        assert 'acl_mode in ["open", ""]' in expr

    def test_empty_acl_groups_list_denies_restricted(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(
            caller_org_id="acme",
            caller_acl_groups=[],
        )
        assert 'acl_mode in ["open", ""]' in expr
        assert "like" not in expr

    def test_acl_groups_sanitized(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(
            caller_org_id="acme",
            caller_acl_groups=['evil"group'],
        )
        assert 'evilgroup' in expr
        assert '""' not in expr.replace('["open", ""]', "")

    def test_no_acl_fields_skips_acl_clause(self, monkeypatch):
        import app.rag_client as rc

        monkeypatch.setattr(
            rc, "_catalog_fields",
            {"visibility_scope", "org_id", "tenant_id", "embedding", "text"},
        )
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(caller_org_id="acme", caller_acl_groups=["team-a"])
        assert "acl_mode" not in expr


# ---------------------------------------------------------------------------
# 2. build_metadata_filter includes scope
# ---------------------------------------------------------------------------


class TestMetadataFilterWithScope:
    @pytest.fixture(autouse=True)
    def _set_catalog_fields(self, monkeypatch):
        import app.rag_client as rc

        monkeypatch.setattr(
            rc,
            "_catalog_fields",
            {
                "visibility_scope", "org_id", "tenant_id",
                "language", "artifact_kind", "repo_path",
                "domain", "tags", "content_format", "content_type",
                "index_decision", "embedding", "text",
            },
        )

    def test_scope_always_prepended(self):
        from app.rag_client import build_metadata_filter

        expr = build_metadata_filter(
            language="python",
            caller_org_id="acme",
        )
        assert expr.startswith("(")
        assert 'visibility_scope == "global"' in expr
        assert 'language == "python"' in expr

    def test_no_org_global_only_plus_language(self):
        from app.rag_client import build_metadata_filter

        expr = build_metadata_filter(language="go", caller_org_id="")
        assert 'visibility_scope == "global"' in expr
        assert "org_id" not in expr
        assert 'language == "go"' in expr

    def test_scope_combined_with_domain_filter(self):
        from app.rag_client import build_metadata_filter

        expr = build_metadata_filter(
            domain_filter='domain in ["kubernetes"]',
            caller_org_id="acme",
            caller_tenant_ids=["team-x"],
        )
        parts = expr.split(" and ")
        assert len(parts) >= 2
        assert any("visibility_scope" in p for p in parts)
        assert any("kubernetes" in p for p in parts)


# ---------------------------------------------------------------------------
# 3. Fail-closed retrieval behavior
# ---------------------------------------------------------------------------


class TestFailClosedBehavior:
    """Verify that without org_id, only global content is accessible."""

    @pytest.fixture(autouse=True)
    def _set_catalog_fields(self, monkeypatch):
        import app.rag_client as rc

        monkeypatch.setattr(
            rc, "_catalog_fields",
            {"visibility_scope", "org_id", "tenant_id", "text", "embedding"},
        )

    def test_anonymous_request_global_only(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter()
        assert "org" not in expr or 'visibility_scope == "org"' not in expr
        assert 'visibility_scope == "global"' in expr

    def test_org_user_cannot_see_other_org(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(caller_org_id="org-a")
        assert 'org_id == "org-a"' in expr
        assert "org-b" not in expr

    def test_tenant_user_cannot_see_other_tenant(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(
            caller_org_id="org-a",
            caller_tenant_ids=["tenant-1"],
        )
        assert 'tenant_id in ["tenant-1"]' in expr
        assert "tenant-2" not in expr

    def test_tenant_user_sees_global_and_org_and_own_tenant(self):
        from app.rag_client import build_scope_filter

        expr = build_scope_filter(
            caller_org_id="org-a",
            caller_tenant_ids=["tenant-1"],
        )
        assert 'visibility_scope == "global"' in expr
        assert 'visibility_scope == "org" and org_id == "org-a"' in expr
        assert 'visibility_scope == "tenant"' in expr
        assert 'tenant_id in ["tenant-1"]' in expr


# ---------------------------------------------------------------------------
# 4. Indexer scope validation
# ---------------------------------------------------------------------------


class TestIndexerScopeValidation:
    """Verify catalog_entity properly handles scope fields and that the
    indexer pipeline rejects malformed scope metadata.

    These tests require the indexer codebase on sys.path. When running from
    the planner directory, skip gracefully.
    """

    @pytest.fixture(autouse=True)
    def _ensure_indexer_importable(self):
        pytest.importorskip("app.schema", reason="indexer app.schema not on PYTHONPATH")

    def test_catalog_entity_default_global(self):
        from app.schema import catalog_entity

        entity = catalog_entity(
            chunk_id="test-1",
            text="hello world",
            embedding=[0.1] * 384,
        )
        assert entity["visibility_scope"] == "global"
        assert entity["org_id"] == ""
        assert entity["tenant_id"] == ""
        assert entity["acl_mode"] == "open"
        assert entity["acl_groups"] == ""

    def test_catalog_entity_org_scope(self):
        from app.schema import catalog_entity

        entity = catalog_entity(
            chunk_id="test-2",
            text="org content",
            embedding=[0.1] * 384,
            visibility_scope="org",
            org_id="acme",
        )
        assert entity["visibility_scope"] == "org"
        assert entity["org_id"] == "acme"

    def test_catalog_entity_tenant_scope(self):
        from app.schema import catalog_entity

        entity = catalog_entity(
            chunk_id="test-3",
            text="tenant content",
            embedding=[0.1] * 384,
            visibility_scope="tenant",
            org_id="acme",
            tenant_id="project-x",
        )
        assert entity["visibility_scope"] == "tenant"
        assert entity["org_id"] == "acme"
        assert entity["tenant_id"] == "project-x"

    def test_schema_version_bumped(self):
        from app.schema import SCHEMA_VERSION

        assert SCHEMA_VERSION == 12

    def test_expected_fields_include_scope(self):
        from app.schema import EXPECTED_FIELDS

        assert "visibility_scope" in EXPECTED_FIELDS
        assert "org_id" in EXPECTED_FIELDS
        assert "tenant_id" in EXPECTED_FIELDS
        assert "acl_mode" in EXPECTED_FIELDS
        assert "acl_groups" in EXPECTED_FIELDS


# ---------------------------------------------------------------------------
# 5. Planner state includes org/tenant
# ---------------------------------------------------------------------------


class TestPlannerStateScope:
    """Verify _resolve_user_org returns three values including tenant_ids."""

    def test_resolve_user_org_returns_triple(self):
        from unittest.mock import MagicMock

        from app.main import _resolve_user_org

        mock_request = MagicMock()
        mock_request.headers = {
            "x-synesis-org-id": "org-123",
            "x-synesis-org-name": "Acme Corp",
            "x-synesis-tenant-ids": "t1,t2",
        }
        org_id, org_name, tenant_ids = _resolve_user_org(
            mock_request, trust_forwarded_identity=True
        )
        assert org_id == "org-123"
        assert org_name == "Acme Corp"
        assert tenant_ids == ["t1", "t2"]

    def test_resolve_user_org_no_tenants(self):
        from unittest.mock import MagicMock

        from app.main import _resolve_user_org

        _headers = {
            "x-synesis-org-id": "org-123",
            "x-synesis-org-name": "",
            "x-synesis-tenant-ids": "",
        }
        mock_request = MagicMock()
        mock_request.headers.get = lambda k, default="": _headers.get(k, default)
        org_id, org_name, tenant_ids = _resolve_user_org(
            mock_request, trust_forwarded_identity=True
        )
        assert org_id == "org-123"
        assert tenant_ids == []

    def test_resolve_user_org_pat_context(self):
        from unittest.mock import MagicMock

        from app.main import PatAuthContext, _resolve_user_org

        mock_request = MagicMock()
        pat = PatAuthContext(
            user_id="user-1",
            username="test",
            org_id="pat-org",
            tenant_ids=["tenant-a", "tenant-b"],
            role="user",
            scopes=["model:readonly"],
            token_row_id="tid-1",
        )
        org_id, org_name, tenant_ids = _resolve_user_org(
            mock_request, trust_forwarded_identity=True, pat_ctx=pat
        )
        assert org_id == "pat-org"
        assert tenant_ids == ["tenant-a", "tenant-b"]

    def test_resolve_user_org_pat_tenants_require_org(self):
        from unittest.mock import MagicMock

        from app.main import PatAuthContext, _resolve_user_org

        mock_request = MagicMock()
        pat = PatAuthContext(
            user_id="user-1",
            username="test",
            org_id="",
            tenant_ids=["tenant-a"],
            role="user",
            scopes=["model:readonly"],
            token_row_id="tid-2",
        )
        org_id, _, tenant_ids = _resolve_user_org(
            mock_request, trust_forwarded_identity=True, pat_ctx=pat
        )
        assert org_id == ""
        assert tenant_ids == []
