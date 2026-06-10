"""Ingestion ACL invariant tests.

Verify that the ingestion pipeline enforces ACL validation
and deny-by-default behavior.
"""

from __future__ import annotations

import pytest


class TestIngestionAclValidation:
    """Verify _normalize_and_authorize_scope enforces ACL rules."""

    @pytest.fixture(autouse=True)
    def _setup_user(self):
        from app.auth import UserInfo

        self.platform_admin = UserInfo(
            user_id="admin-1",
            username="admin",
            role="admin",
            org_id="test-org",
        )
        self.org_admin = UserInfo(
            user_id="orgadm-1",
            username="orgadmin",
            role="user",
            org_id="test-org",
            org_roles=["admin"],
        )

    def test_open_mode_no_groups_required(self):
        from app.routers.ingestion import _normalize_and_authorize_scope

        _scope, _org, _tenant, acl_m, acl_g = _normalize_and_authorize_scope(
            self.platform_admin,
            visibility_scope="global",
            org_id="",
            tenant_id="",
            acl_mode="open",
            acl_groups="",
        )
        assert acl_m == "open"
        assert acl_g == ""

    def test_restricted_requires_groups(self):
        from app.routers.ingestion import _normalize_and_authorize_scope
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            _normalize_and_authorize_scope(
                self.platform_admin,
                visibility_scope="global",
                org_id="",
                tenant_id="",
                acl_mode="restricted",
                acl_groups="",
            )
        assert "acl_groups" in str(exc_info.value.detail)

    def test_private_requires_groups(self):
        from app.routers.ingestion import _normalize_and_authorize_scope
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            _normalize_and_authorize_scope(
                self.platform_admin,
                visibility_scope="global",
                org_id="",
                tenant_id="",
                acl_mode="private",
                acl_groups="",
            )
        assert "acl_groups" in str(exc_info.value.detail)

    def test_restricted_with_groups_passes(self):
        from app.routers.ingestion import _normalize_and_authorize_scope

        _scope, _org, _tenant, acl_m, acl_g = _normalize_and_authorize_scope(
            self.platform_admin,
            visibility_scope="global",
            org_id="",
            tenant_id="",
            acl_mode="restricted",
            acl_groups="grp-eng",
        )
        assert acl_m == "restricted"
        assert acl_g == "grp-eng"

    def test_invalid_acl_mode_rejected(self):
        from app.routers.ingestion import _normalize_and_authorize_scope
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            _normalize_and_authorize_scope(
                self.platform_admin,
                visibility_scope="global",
                org_id="",
                tenant_id="",
                acl_mode="invalid",
                acl_groups="",
            )
        assert "acl_mode" in str(exc_info.value.detail)

    def test_malformed_org_id_rejected_before_authorization(self):
        from app.routers.ingestion import _normalize_and_authorize_scope
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            _normalize_and_authorize_scope(
                self.platform_admin,
                visibility_scope="org",
                org_id="test-org\nrole=admin",
                tenant_id="",
            )
        assert exc_info.value.status_code == 422
        assert "org_id" in str(exc_info.value.detail)

    def test_malformed_tenant_id_rejected_before_authorization(self):
        from app.routers.ingestion import _normalize_and_authorize_scope
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            _normalize_and_authorize_scope(
                self.platform_admin,
                visibility_scope="tenant",
                org_id="test-org",
                tenant_id="tenant-1\nrole=admin",
            )
        assert exc_info.value.status_code == 422
        assert "tenant_id" in str(exc_info.value.detail)

    def test_tenant_scope_requires_tenant_id(self):
        from app.routers.ingestion import _normalize_and_authorize_scope
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            _normalize_and_authorize_scope(
                self.platform_admin,
                visibility_scope="tenant",
                org_id="test-org",
                tenant_id="",
            )
        assert exc_info.value.status_code == 400
        assert "tenant_id is required" in str(exc_info.value.detail)

    def test_default_acl_mode_is_open(self):
        from app.routers.ingestion import _normalize_and_authorize_scope

        _scope, _org, _tenant, acl_m, acl_g = _normalize_and_authorize_scope(
            self.platform_admin,
            visibility_scope="global",
            org_id="",
            tenant_id="",
        )
        assert acl_m == "open"


class TestPydanticSchemaDefaults:
    """Verify ingestion Pydantic models default to safe ACL values."""

    def test_source_create_defaults(self):
        from app.routers.ingestion import SourceCreate

        s = SourceCreate(name="test")
        assert s.acl_mode == "open"
        assert s.acl_groups == ""
        assert s.visibility_scope == "global"

    def test_item_create_defaults(self):
        from app.routers.ingestion import ItemCreate

        i = ItemCreate(uri="https://example.com")
        assert i.acl_mode == "open"
        assert i.acl_groups == ""
        assert i.visibility_scope == "global"


class TestGraphResetConfirm:
    def test_accepts_catalog_and_schema_phrases(self):
        from app.routers.ingestion import _graph_reset_confirm_ok

        assert _graph_reset_confirm_ok("DELETE_SYNESIS_CATALOG")
        assert _graph_reset_confirm_ok("DELETE_CONTENT_GRAPH")
        assert _graph_reset_confirm_ok("  DELETE_CONTENT_GRAPH  ")
        assert not _graph_reset_confirm_ok("wrong")
        assert not _graph_reset_confirm_ok("")
